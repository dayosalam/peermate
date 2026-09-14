import { z } from 'zod'
import type { User } from '../../models/index.js'
import { AssignmentStatus } from '../../models/index.js'
import { assignmentService } from '../assignment.service.js'
import { courseService } from '../course.service.js'
import { digestService } from '../digest.service.js'
import { guidanceService } from '../guidance.service.js'
import { explainerService } from '../explainer.service.js'
import { dmService } from '../dm.service.js'
import { extractionRepository } from '../../repositories/index.js'
import { prepService } from '../prep.service.js'
import { researchService } from '../research.service.js'
import { resourceService } from '../resource.service.js'
import { retrievalService } from '../retrieval.service.js'
import { scheduleService } from '../schedule.service.js'
import { studentCommandsService } from '../student-commands.service.js'
import { config } from '../../config.js'
import { getMedia } from '../../db/minio.js'
import { messageRepository } from '../../repositories/index.js'
import { conversationService } from '../conversation.service.js'
import { notifierService } from '../notifier.service.js'
import { ttsService, EXPLAINER_CHARS } from '../tts.service.js'
import { isOperatorIdentity } from '../operator.js'
import { courseDisplay, courseKey } from '../../utils/courses.js'
import { formatStamp } from '../../utils/dates.js'
import { asEvidence, format } from './evidence.js'

/**
 * How much damage a tool can do, which decides what has to be asked first.
 *
 * `read` answers a question. `reversible` changes something the student can put back
 * — so it runs, and the reply says how to undo it, because a confirmation prompt on
 * every mute is its own kind of rude. `destructive` either cannot be undone or costs
 * them money on metered data, and is confirmed before it runs.
 */
export type Tier = 'read' | 'reversible' | 'destructive'

export interface ToolContext {
  user: User
  jid: string
}

export interface Tool {
  name: string
  description: string
  tier: Tier
  parameters: z.ZodTypeAny
  run(args: Record<string, unknown>, context: ToolContext): Promise<string>
}

/**
 * Resolves a course the student named, within the courses they actually take.
 *
 * Every tool that accepts a course goes through this rather than trusting the
 * argument. The model can be persuaded to pass any string; this is what makes that
 * harmless — an unknown code resolves to nothing rather than to somebody else's
 * cohort.
 */
async function resolveCourse(named: string | undefined, user: User): Promise<string | null> {
  if (!named) return null

  const key = courseKey(named)
  if (key && user.courseKeys.includes(key)) return key

  const resolved = await courseService.resolve(named, user)
  return resolved?.courseKey ?? null
}

const tools: Tool[] = [
  {
    name: 'search_archive',
    description:
      "Search everything said in the student's groups and every file shared there — messages, voice note transcripts, PDF contents. Use for any question about what was said, what a document contains, or what happened. Returns quoted evidence with provenance; cite it.",
    tier: 'read',
    parameters: z.object({
      question: z.string().describe('What to look for, rewritten as a standalone question.'),
      course: z
        .string()
        .nullable()
        .describe('Course code if the question is about one, otherwise null.'),
    }),
    async run(args, { user }) {
      const question = String(args['question'] ?? '')
      const scoped = await resolveCourse(args['course'] as string | undefined, user)
      const candidates = await retrievalService.search(
        question,
        scoped ? [scoped] : user.courseKeys,
        user.groupJids,
        // Their own uploads count as something they can ask about. Anything they sent
        // in a DM — a photographed timetable, a past paper a friend forwarded them —
        // is theirs and nobody else's, and is reached by owner rather than by group.
        user.phone,
      )

      if (candidates.length === 0) {
        return 'Nothing in the archive matches that. Say so plainly — do not guess, and do not answer from your own knowledge of the subject.'
      }
      return asEvidence('group messages and shared files', format(candidates))
    },
  },

  {
    name: 'get_announcements',
    description:
      'Structured announcements — tests, deadlines, lectures, venue changes, cancellations — with their real dates. Always use this for "what is coming up", "what is due", "when is the test", rather than searching text.',
    tier: 'read',
    parameters: z.object({
      course: z.string().nullable().describe('Course code, or null for all of theirs.'),
      since_days: z.number().nullable().describe('How far back to look. Null means 30 days.'),
    }),
    async run(args, { user }) {
      const scoped = await resolveCourse(args['course'] as string | undefined, user)
      const days = Number(args['since_days'] ?? 30)
      const since = new Date(Date.now() - days * 86_400_000)

      const rows = await extractionRepository.forCourses(
        scoped ? [scoped] : user.courseKeys,
        since,
        user.groupJids,
      )
      if (rows.length === 0) return 'No announcements on record for that.'

      const lines = rows.map((row) => {
        const course = courseDisplay(row.courseKey ?? '') ?? 'department-wide'
        const when = [row.date, row.time].filter(Boolean).join(' ')
        const parts = [row.eventType, row.title, when, row.venue].filter(Boolean).join(' · ')
        return `- ${course}: ${parts} (said by ${row.authority}, confidence ${row.confidence.toFixed(2)})`
      })
      return asEvidence('announcements extracted from the groups', lines.join('\n'))
    },
  },

  {
    name: 'get_timetable',
    description:
      "The student's own timetable, from the photograph they sent, combined with what their groups announced. Use for 'what do I have today', 'when is my next class', 'how many classes on Tuesday'.",
    tier: 'read',
    parameters: z.object({
      horizon: z
        .enum([
          'today',
          'tomorrow',
          'week',
          'next',
          'monday',
          'tuesday',
          'wednesday',
          'thursday',
          'friday',
          'saturday',
          'sunday',
        ])
        .describe('Which part of their schedule they asked about.'),
      course: z.string().nullable().describe('Course code, or null for their whole week.'),
    }),
    async run(args, { user }) {
      const scoped = await resolveCourse(args['course'] as string | undefined, user)
      const answer = await scheduleService.answer(user, args['horizon'] as never, scoped)
      // null here means Peermate has never been shown a timetable, which is a real
      // answer rather than a failure — the student should be asked for one.
      return (
        answer ??
        'They have never sent a timetable, so there is nothing scheduled to read. Ask them to photograph it.'
      )
    },
  },

  {
    name: 'get_resources',
    description:
      'List the files shared for a course. Lists only — sending them costs the student data, so use send_files for that and only after they say yes.',
    tier: 'read',
    parameters: z.object({
      course: z.string().nullable().describe('Course code, or null for all of theirs.'),
    }),
    async run(args, { user }) {
      const named = (args['course'] as string | undefined) ?? ''
      const { summary } = await resourceService.shelf(user, named, await resolveCourse(named, user))
      return summary
    },
  },

  {
    name: 'send_files',
    description:
      'Actually send files for a course as WhatsApp attachments. Costs the student mobile data, so Peermate asks them to confirm before it runs. Pass positions to send only some of a list you already showed them.',
    tier: 'destructive',
    parameters: z.object({
      course: z.string(),
      positions: z
        .array(z.number())
        .nullable()
        .describe('1-based positions from the list already shown, or null for all of them.'),
    }),
    async run(args, { user }) {
      const named = String(args['course'] ?? '')
      const { files } = await resourceService.shelf(user, named, await resolveCourse(named, user))
      if (files.length === 0) return 'There are no files to send for that course.'

      // "Send the second one" is most of what people actually say — sending the whole
      // shelf when they asked for one item spends their data on six files they did
      // not want.
      const wanted = args['positions'] as number[] | null
      const chosen = wanted?.length
        ? wanted.flatMap((position) => {
            const file = files[position - 1]
            return file ? [file] : []
          })
        : files

      if (chosen.length === 0) return 'None of those positions exist in that list.'
      const sent = await resourceService.sendFiles(user, chosen)
      return `Sent ${sent} file${sent === 1 ? '' : 's'}. Tell them that is done.`
    },
  },

  {
    name: 'get_course_info',
    description:
      'What Peermate knows about one course: whether it is reading a group for it, the weekly pattern, what is coming up, how many files it holds.',
    tier: 'read',
    parameters: z.object({ course: z.string() }),
    async run(args, { user }) {
      const key = await resolveCourse(args['course'] as string, user)
      if (!key) return 'That is not one of their courses, and no group covers it.'
      return courseService.rundown(user, key)
    },
  },

  {
    name: 'explain_peermate',
    description:
      'How Peermate itself works, or what it is currently set up to do: approving a group, adding or dropping courses, the morning digest, pausing, quiet hours, which groups it is reading. Use this instead of answering from your own knowledge — the answer depends on their account and on how this deployment is configured.',
    tier: 'read',
    parameters: z.object({
      question: z.string().describe('Their question about Peermate, as they asked it.'),
    }),
    async run(args, { user }) {
      return guidanceService.answer(
        user,
        String(args['question'] ?? ''),
        isOperatorIdentity(user.phone),
      )
    },
  },

  {
    name: 'explain_topic',
    description:
      'Explain a topic aloud, from the lecturer\'s own files, and send it as a voice note they can play on the way in. Use for "explain X to me", "I don\'t understand Y", "break down chapter 4". Not for dates, deadlines or what was announced \u2014 this teaches the subject, it does not report news.',
    tier: 'read',
    parameters: z.object({
      course: z.string().describe('Course code the topic belongs to.'),
      topic: z
        .string()
        .nullable()
        .describe('What to explain, in their words. Null for the material as a whole.'),
    }),
    async run(args, { user, jid }) {
      const key = await resolveCourse(args['course'] as string, user)
      if (!key) return 'That is not one of their courses, and no group covers it.'

      const topic = args['topic'] ? String(args['topic']) : null
      const explainer = await explainerService.explain(user, key, topic)
      if (!explainer || explainer.scenes.length === 0) {
        return 'There are no readable files for that course, so there is nothing to explain from. Say so, and offer to explain it if they send the slides.'
      }

      const written = explainerService.written(explainer, key)
      await notifierService.sendText(jid, written)

      // Audio after the text, never instead of it: a formula in a voice note cannot be
      // scrolled back to, and the page references are the point of keeping the script.
      const audio = await ttsService.speak(explainerService.narration(explainer), EXPLAINER_CHARS)
      if (audio) await notifierService.sendVoiceNote(jid, audio)

      const gaps = explainer.notCovered.length
        ? ` The material does not cover ${explainer.notCovered.join(', ')}, which was left out.`
        : ''
      return `Sent the explanation${audio ? ' and the voice note' : ' (the voice note failed, so it is text only)'}. Do not repeat it \u2014 just say it is there.${gaps}`
    },
  },

  {
    name: 'get_assignments',
    description:
      "What work the student still has outstanding, with what they have marked. Use for 'what assignments are left', 'what do I still owe'.",
    tier: 'read',
    parameters: z.object({}),
    async run(_args, { user }) {
      const open = await assignmentService.outstanding(user)
      if (open.length === 0) return 'Nothing outstanding on record.'
      return open.map((item) => assignmentService.describe(item)).join('\n')
    },
  },

  {
    name: 'set_assignment_status',
    description:
      "Record that the student has started, submitted or completed a piece of work, so reminders about it stop. Use when they say 'I've submitted the report' or 'done with that'.",
    tier: 'reversible',
    parameters: z.object({
      course: z.string(),
      title: z
        .string()
        .nullable()
        .describe('What the work is called, or null if they did not say.'),
      status: AssignmentStatus,
    }),
    async run(args, { user }) {
      const key = await resolveCourse(args['course'] as string, user)
      if (!key) return 'That is not one of their courses.'

      // Everything for the course, not only what is outstanding. Reopening something
      // means finding work that has already been marked done, which `outstanding`
      // exists to hide.
      const candidates = await assignmentService.forCourse(user, key)
      const named = String(args['title'] ?? '').toLowerCase()
      const match =
        candidates.find((item) => named && (item.title ?? '').toLowerCase().includes(named)) ??
        (candidates.length === 1 ? candidates[0] : undefined)

      if (!match) {
        if (candidates.length === 0) return 'No work at all on record for that course.'
        return `More than one piece of work is open for that course — ask which: ${candidates
          .map((item) => item.title ?? item.dueDate)
          .join(', ')}`
      }

      await assignmentService.setStatus(user.phone, match.assignmentId, args['status'] as never)
      const state = String(args['status']).replace('_', ' ')
      return `Marked as ${state}. Tell them, and that saying it is not done after all will put it back.`
    },
  },

  {
    name: 'catch_up',
    description: "Everything that happened across the student's courses over a period.",
    tier: 'read',
    parameters: z.object({
      since_days: z.number().describe('How many days back.'),
      label: z.string().describe('How they described the period, e.g. "this week".'),
    }),
    async run(args, { user }) {
      return digestService.catchUp(
        user,
        Number(args['since_days'] ?? 7),
        String(args['label'] ?? 'recently'),
      )
    },
  },

  {
    name: 'start_quiz',
    description:
      'Build a practice set from the files shared for a course and start asking. Use for "prep me", "quiz me", "test me on".',
    tier: 'reversible',
    parameters: z.object({ course: z.string() }),
    async run(args, { user }) {
      const key = await resolveCourse(args['course'] as string, user)
      if (!key) return 'That is not one of their courses.'

      // Reuse what is already built. The same material asked twice produces different
      // questions, so rebuilding would make the running score meaningless — and a
      // finished set is restarted rather than replayed from its own last page.
      const held = await conversationService.quiz(user.phone)
      if (held && held.courseKey === key) {
        const finished = held.index >= held.questions.length
        const resumed = finished ? { ...held, index: 0, right: 0 } : held
        await conversationService.setQuiz(user.phone, resumed, true)
        return `A practice set is ready. Ask them this, exactly as written:\n\n${prepService.ask(resumed)}`
      }

      const built = await prepService.brief(user, key)
      if (!built) {
        return 'There are no readable files for that course, so there is nothing to build a practice set from. Say so and ask them to share the material.'
      }

      // Stored *and* armed: their next message is an answer to question one, and
      // without this it is read as a fresh question and the quiz never starts.
      await conversationService.setQuiz(user.phone, built.quiz, true)
      return `${built.text}\n\n———\n\nNow ask them this, exactly as written:\n\n${prepService.ask(built.quiz)}`
    },
  },

  {
    name: 'get_progress',
    description:
      "How the student is doing in a course, from their quiz history, and which topics are weakest. Use for 'how am I doing', 'what should I revise'.",
    tier: 'read',
    parameters: z.object({ course: z.string() }),
    async run(args, { user }) {
      const key = await resolveCourse(args['course'] as string, user)
      if (!key) return 'That is not one of their courses.'
      const progress = await prepService.progress(user.phone, key)
      return progress ?? 'They have not answered any practice questions for that course yet.'
    },
  },

  {
    name: 'find_papers',
    description:
      'Search published research papers on a topic the student named — for a project or further reading. Only on an explicit request. Results are from the web, never from their lecturer, and must be labelled as such.',
    tier: 'read',
    parameters: z.object({
      topic: z.string().describe("The subject in the student's own words."),
      since: z.string().nullable().describe('ISO date to limit to recent work, or null.'),
    }),
    async run(args) {
      const papers = await researchService.papersFor(
        String(args['topic'] ?? ''),
        (args['since'] as string | null) ?? undefined,
      )
      if (papers.length === 0) return 'Nothing came back. Say so rather than inventing references.'

      const lines = papers.map((paper, index) => {
        const meta = [paper.author, paper.publishedDate?.slice(0, 4)].filter(Boolean).join(', ')
        return `${index + 1}. ${paper.title}${meta ? ` (${meta})` : ''}\n   ${paper.url}${paper.extract ? `\n   ${paper.extract}` : ''}`
      })

      return asEvidence(
        'the web, not their lecturer',
        `${lines.join('\n')}\n\nThese are indexed publications; peer review and open access are not guaranteed. Present them under a heading that says they came from the web, keep the year and author, and never state their contents as fact about the course.`,
      )
    },
  },

  {
    name: 'send_original',
    description:
      'Send the student the actual voice note, photo or file an answer came from, so they can hear or see it themselves. Use for "send the original", "let me hear it", "who said that exactly".',
    tier: 'read',
    parameters: z.object({}),
    async run(_args, { user, jid }) {
      const remembered = await conversationService.get(user.phone)
      if (!remembered?.sourceMessageId) {
        return 'There is nothing in the conversation to send the original of. Ask them what they mean.'
      }

      const source = await messageRepository.findById(remembered.sourceMessageId)
      if (!source) return 'That message is no longer on record.'

      // Scoped like everything else: a referent is only ever theirs to ask about if
      // it came from a group they are in.
      if (source.fromGroup && !user.groupJids.includes(source.chatJid)) {
        return 'That message is not from one of their groups.'
      }

      const stamp = formatStamp(source.timestamp, config.digest.timezone)
      const who = source.senderName ?? 'someone'

      if (!source.mediaKey) {
        const words = source.text ?? source.caption
        return words
          ? `It was typed, not recorded. Quote it back word for word and attribute it: "${words}" — ${who}, ${stamp}.`
          : 'That one was a plain message with nothing to play.'
      }

      const bytes = await getMedia(source.mediaKey)
      if (source.type === 'audio') await notifierService.sendVoiceNote(jid, bytes)
      else if (source.type === 'image') await notifierService.sendImage(jid, bytes)
      else {
        await notifierService.sendFile(
          jid,
          source.mediaKey,
          source.fileName ?? 'attachment',
          source.mimeType ?? undefined,
        )
      }

      return `Sent. Tell them it is the original, from ${who}, ${stamp}.`
    },
  },

  {
    name: 'search_outside_group',
    description:
      'Look for lecture notes or past questions on the wider web when the group has none. Only ever after the student has explicitly agreed to look outside — ask first. Returns a numbered list; it does not send anything.',
    tier: 'read',
    parameters: z.object({
      course: z.string(),
      words: z.string().describe('What they said they wanted, in their own words.'),
    }),
    async run(args, { user }) {
      const key = await resolveCourse(args['course'] as string, user)
      const code = key ? (courseDisplay(key) ?? key) : String(args['course'])
      const known = key ? await courseService.find(key) : null

      // The code is dropped once a title is known. "CVE 575" means nothing outside
      // the university that issued it, and a web search on it matches MATH 575 just
      // as happily — which is what a student asking for transportation engineering
      // material actually got.
      const found = await researchService.documentsFor({
        code,
        title: known?.title ?? null,
        words: String(args['words'] ?? ''),
      })
      if (found.length === 0) return 'Nothing usable came back. Say so rather than inventing links.'

      await conversationService.rememberFindings(
        user.phone,
        found.map((item, index) => ({ position: index + 1, title: item.title, url: item.url })),
      )

      const lines = found.map((item, index) => `${index + 1}. ${item.title}\n   ${item.url}`)
      return asEvidence(
        'the web, not their group',
        `${lines.join('\n')}\n\nOffer these as a numbered list they can pick from, under a line making clear it is from the web and not from their lecturer. Do not describe what is inside them.`,
      )
    },
  },

  {
    name: 'amend_timetable',
    description:
      "Change or remove an entry on the student's own saved timetable — a lecture moved, a venue changed, a class dropped. Their record of their own week, so it is edited in place; Peermate asks them to confirm first.",
    tier: 'destructive',
    parameters: z.object({
      course: z.string(),
      kind: z
        .enum(['exam', 'test', 'lecture', 'tutorial', 'practical', 'any'])
        .describe('Which kind of entry, or "any" when they did not say.'),
      time: z.string().nullable().describe('24-hour HH:MM, or null.'),
      venue: z.string().nullable(),
      weekday: z.string().nullable().describe('A weekday name for a weekly class, or null.'),
      date: z.string().nullable().describe('YYYY-MM-DD for a one-off, or null.'),
      remove: z.boolean().describe('True when they want the entry gone entirely.'),
    }),
    async run(args, { user }) {
      const key = await resolveCourse(args['course'] as string, user)
      if (!key) return 'That is not one of their courses.'

      return scheduleService.amend(user, key, {
        kind: args['kind'] as never,
        time: (args['time'] as string | null) ?? null,
        venue: (args['venue'] as string | null) ?? null,
        weekday: (args['weekday'] as string | null) ?? null,
        date: (args['date'] as string | null) ?? null,
        remove: Boolean(args['remove']),
      })
    },
  },

  {
    name: 'propose_group_course',
    description:
      'Record which course a group Peermate was just added to is for. Use when the student says something like "the group you were added to is for CVE 575". Peermate reads the code back and asks them to confirm before relaying it to the operator.',
    tier: 'reversible',
    parameters: z.object({
      said: z.string().describe('What they said, verbatim, including the course code.'),
    }),
    async run(args, { user }) {
      // Handed back for Peermate to send as its own question, because what follows is
      // a confirmation it owns: the student's next "yes" is an answer to this, not a
      // new request to be interpreted afresh.
      return dmService.proposeGroupCourse(user, String(args['said'] ?? ''))
    },
  },

  {
    name: 'update_settings',
    description:
      'Change how Peermate messages them: pause, resume, mute a course, urgent only, quiet hours, digest time, add or drop a course, change their name. Pass their instruction as they said it.',
    tier: 'reversible',
    parameters: z.object({
      instruction: z
        .string()
        .describe('The command, e.g. "pause until monday", "mute CVE 575", "add CVE 581".'),
    }),
    async run(args, { user }) {
      const reply = await studentCommandsService.apply(user, String(args['instruction'] ?? ''))
      return reply ?? 'That is not a setting Peermate can change. Say what is possible instead.'
    },
  },
]

export const toolsByName = new Map(tools.map((tool) => [tool.name, tool]))
export const allTools = tools

/**
 * Runs a tool directly, bypassing the confirmation gate.
 *
 * Only for a call the student has already agreed to. Arguments are re-validated
 * rather than trusted: they were stored between two messages and the schema may have
 * changed under them in a deploy.
 */
export async function runTool(
  name: string,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<string> {
  const tool = toolsByName.get(name)
  if (!tool) return 'That is no longer something I can do.'

  const checked = tool.parameters.safeParse(args)
  if (!checked.success) return 'I could not make sense of that any more — ask me again.'

  return tool.run(checked.data as Record<string, unknown>, context)
}

/** How to describe a held action back to the student, in their terms. */
export function describeCall(name: string, args: Record<string, unknown>): string {
  const course = args['course'] ? String(args['course']) : null
  switch (name) {
    case 'send_files':
      return course ? `send you the ${course} files` : 'send you the files'
    case 'replace_timetable':
      return 'replace your saved timetable'
    case 'amend_timetable':
      return 'change your timetable'
    case 'wipe_me':
      return 'delete everything I hold about you'
    default:
      return name.replace(/_/g, ' ')
  }
}
