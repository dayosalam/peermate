import { z } from 'zod'
import type { Group, User } from '../../models/index.js'
import { AssignmentStatus } from '../../models/index.js'
import { assignmentService } from '../assignment.service.js'
import { courseService } from '../course.service.js'
import { digestService } from '../digest.service.js'
import { guidanceService } from '../guidance.service.js'
import { groupService } from '../group.service.js'
import { membershipService } from '../membership.service.js'
import { announcementService } from '../announcement.service.js'
import { explainerService } from '../explainer.service.js'
import { storyboardService } from '../storyboard.service.js'
import { dmService } from '../dm.service.js'
import {
  extractionRepository,
  groupRepository,
  pendingRepository,
  memoryCollectionRepository,
  userRepository,
} from '../../repositories/index.js'
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
import { courseDisplay, courseKey, parseCourseList } from '../../utils/courses.js'
import { closestNamed } from '../../utils/similarity.js'
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

/**
 * Resolves a group the student named, within the groups they are actually in.
 *
 * The counterpart of `resolveCourse`, and for the same reason: the model can be
 * persuaded to pass any string, and this is what makes that harmless. Naming somebody
 * else's group resolves to nothing rather than to their cohort.
 */
async function resolveGroup(named: string | undefined, user: User): Promise<Group | null> {
  const mine = groupRepository.byJids
    ? await groupRepository.byJids(accessibleGroups(user))
    : await groupRepository.forStudent(accessibleGroups(user))
  if (mine.length === 0) return null
  if (mine.length === 1 && !named) return mine[0]!
  if (!named) return null

  const wanted = named.trim().toLowerCase()
  const key = courseKey(named)

  return (
    mine.find((group) => group.name?.toLowerCase() === wanted) ??
    mine.find((group) => key && group.defaultCourseKey === key) ??
    mine.find((group) => group.name?.toLowerCase().includes(wanted)) ??
    null
  )
}

function accessibleGroups(user: User): string[] {
  return [...new Set([...(user.groupJids ?? []), ...(user.historicalGroupJids ?? [])])]
}

/** Authority over a room is being in it, checked afresh rather than taken on trust. */
async function mayChange(user: User, group: Group | null): Promise<Group | null> {
  if (!group) return null
  return (await membershipService.mayAdminister(user, group)) ? group : null
}

function parseInstant(value: unknown): Date | null {
  if (!value) return null
  const parsed = new Date(String(value))
  return Number.isNaN(parsed.getTime()) ? null : parsed
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
      const named = args['course'] as string | null | undefined
      const scoped = await resolveCourse(named ?? undefined, user)
      const candidates = await retrievalService.search(
        question,
        scoped ? [scoped] : [],
        accessibleGroups(user),
        // Their own uploads count as something they can ask about. Anything they sent
        // in a DM — a photographed timetable, a past paper a friend forwarded them —
        // is theirs and nobody else's, and is reached by owner rather than by group.
        user.phone,
      )

      if (candidates.length === 0) {
        return 'Nothing in the archive matches that. Say so plainly — do not guess, and do not answer from your own knowledge of the subject.'
      }
      await conversationService.rememberSource?.(user.phone, candidates[0]!.waMessageId)
      return asEvidence('group messages and shared files', format(candidates))
    },
  },

  {
    name: 'list_memory',
    description:
      'Recover messages and media Peermate has seen using exact filters such as sender, group, words, media type, or date. Use for "show me everything from Tobi", "what files came last week", "find that voice note", or when semantic search is too broad.',
    tier: 'read',
    parameters: z.object({
      words: z.string().nullable().describe('Exact words to contain, or null.'),
      sender: z.string().nullable().describe('Sender name, or null.'),
      group: z.string().nullable().describe('Group name, or null for every accessible source.'),
      type: z
        .enum(['text', 'image', 'audio', 'document', 'video', 'sticker', 'other'])
        .nullable()
        .describe('Source type, or null.'),
      since: z.string().nullable().describe('ISO date/time lower bound, or null.'),
      until: z.string().nullable().describe('ISO date/time upper bound, or null.'),
      limit: z.number().min(1).max(50).nullable().describe('Maximum results; null means 20.'),
    }),
    async run(args, { user }) {
      const namedGroup = args['group'] ? String(args['group']) : null
      const group = namedGroup ? await resolveGroup(namedGroup, user) : null
      if (namedGroup && !group) return 'That is not one of their verified groups.'

      const rows = await messageRepository.accessible(user.phone, accessibleGroups(user), {
        words: args['words'] ? String(args['words']) : null,
        sender: args['sender'] ? String(args['sender']) : null,
        chatJid: group?.chatJid ?? null,
        type: (args['type'] as never) ?? null,
        since: parseInstant(args['since']),
        until: parseInstant(args['until']),
        limit: args['limit'] ? Number(args['limit']) : 20,
      })
      if (rows.length === 0) return 'No accessible source matches those filters.'

      await conversationService.rememberSource?.(user.phone, rows[0]!.waMessageId)
      return asEvidence(
        'recoverable source records',
        rows
          .map((row) => {
            const content =
              row.text ?? row.caption ?? row.transcript ?? `[${row.type} with no extracted text]`
            const stamp = formatStamp(row.timestamp, config.digest.timezone)
            return `[source ${row.waMessageId} | ${row.senderName ?? 'unknown'} | ${row.type} | ${stamp}]\n${content.slice(0, 700)}`
          })
          .join('\n\n'),
      )
    },
  },

  {
    name: 'get_source',
    description:
      'Retrieve one exact source record by the source ID returned by list_memory. Use to inspect it, establish provenance, or make it the target of a following "send the original" request.',
    tier: 'read',
    parameters: z.object({ source_id: z.string() }),
    async run(args, { user }) {
      const id = String(args['source_id'] ?? '')
      const source = await messageRepository.findById(id)
      const allowed =
        source &&
        ((source.fromGroup && accessibleGroups(user).includes(source.chatJid)) ||
          (!source.fromGroup && source.senderPhone === user.phone))
      if (!source || !allowed) return 'That source is not available to this user.'

      await conversationService.rememberSource?.(user.phone, source.waMessageId)
      const words = source.text ?? source.caption ?? source.transcript ?? '[no extracted text]'
      return asEvidence(
        'one recoverable source record',
        `[source ${source.waMessageId} | ${source.senderName ?? 'unknown'} | ${source.type} | ${formatStamp(source.timestamp, config.digest.timezone)} | original media ${source.mediaKey ? 'available' : 'not attached'}]\n${words}`,
      )
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
      return guidanceService.answer(user, String(args['question'] ?? ''))
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
    name: 'render_explainer',
    description:
      "Build a narrated video walkthrough of a topic from the lecturer's own slides, and send it when it is ready. Use when a student asks to be *shown* something, asks for a video, or says reading is not working for them. Takes minutes, not seconds — they are told it is coming and kept updated. For a plain spoken explanation, use explain_topic instead.",
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
      const explainer = await explainerService.explain(user, key, topic, 'video')
      if (!explainer || explainer.scenes.length === 0) {
        return 'There are no readable files for that course, so there is nothing to build from. Say so, and offer to do it if they send the slides.'
      }

      // The written explanation goes now rather than with the video. A render can
      // fail, and a student who asked a question should not be left with nothing
      // while it does.
      await notifierService.sendText(jid, explainerService.written(explainer, key))

      const { fresh } = await storyboardService.enqueue(user, key, topic, explainer, jid)
      return fresh
        ? 'Queued the video and sent the written explanation. Tell them it is being built and they will get progress updates — do not repeat the explanation.'
        : 'That video is already being built or already exists. Say it is on the way; do not queue it again.'
    },
  },

  {
    name: 'set_group_course',
    description:
      "Correct which course a group's messages are filed under. Use when the student says a group is for a different course than Peermate has it down as. Only works for a group they are in.",
    tier: 'reversible',
    parameters: z.object({
      group: z.string().nullable().describe('The group by name, or null if they are in only one.'),
      course: z.string().describe('The course code it should be filed under.'),
    }),
    async run(args, { user }) {
      const group = await mayChange(user, await resolveGroup(args['group'] as string, user))
      if (!group) return 'They are not in a group by that name, so there is nothing to change.'

      // parseCourseList, not courseKey: the latter only normalises, so "hello" comes
      // back as "HELLO" and a group gets filed under it.
      const [key] = parseCourseList(String(args['course'] ?? ''))
      if (!key) return 'That is not a course code. Ask them for one like CVE 575.'

      const display = courseDisplay(key) ?? key
      await groupService.setCourse(group.chatJid, display)
      return `Filed ${group.name ?? 'that group'} under ${display} from now on. Say it can be changed again the same way.`
    },
  },

  {
    name: 'claim_group',
    description:
      'Find a group the student says they added Peermate to, when Peermate cannot work out which one it is. Use when they say they added it and Peermate has not asked them about it — they can give the name roughly. Do not use to change a group Peermate is already reading.',
    tier: 'reversible',
    parameters: z.object({
      name: z.string().describe('The group name, as near as they remember it.'),
    }),
    async run(args, { user }) {
      const typed = String(args['name'] ?? '').trim()
      if (!typed) return 'Ask them what the group is called.'

      const stuck = await membershipService.unplaced(user)
      if (stuck.length === 0) {
        return 'There is no group waiting that I could not place. If they just added me, ask them to try again in a moment — I may not have seen it yet.'
      }

      const match = closestNamed(typed, stuck)
      if (!match) {
        return `Nothing waiting matches that name. Do not guess or list what is waiting — ask them to check the exact name in WhatsApp.`
      }

      // The question is recorded before it is asked, and the course answer doubles as
      // the confirmation: naming the course only makes sense if the group is theirs.
      await conversationService.proposeGroup(user.phone, {
        chatJid: match.chatJid,
        groupName: match.name,
        course: null,
      })
      return `Found *${match.name}*. Ask them to confirm that is the one and say which course it is for — or *general* if it carries the whole department.`
    },
  },

  {
    name: 'trust_sender',
    description:
      'Record who in a group is the lecturer or the class rep, so their word settles a disagreement. Use when the student says something like "Dr Bello is our lecturer". Only works for a group they are in.',
    tier: 'reversible',
    parameters: z.object({
      group: z.string().nullable().describe('The group by name, or null if they are in only one.'),
      name: z.string().describe('The person, spelled as they appear in the group.'),
      role: z.enum(['lecturer', 'rep']),
    }),
    async run(args, { user }) {
      const group = await mayChange(user, await resolveGroup(args['group'] as string, user))
      if (!group) return 'They are not in a group by that name, so there is nothing to record.'

      const named = String(args['name'] ?? '').trim()
      if (!named) return 'No name was given. Ask who they mean.'

      await groupService.trust(group.chatJid, named, args['role'] as 'lecturer' | 'rep')
      return `Recorded ${named} as the ${args['role'] === 'rep' ? 'class rep' : 'lecturer'} in ${group.name ?? 'that group'}. Their word now outweighs a classmate's on the same thing.`
    },
  },

  {
    name: 'stop_reading_group',
    description:
      'Stop reading a group entirely. Use when the student says a group should not be read — it is not a course group, or it should never have been connected. Irreversible from their side: reconnecting means removing Peermate and adding it again.',
    tier: 'destructive',
    parameters: z.object({
      group: z.string().nullable().describe('The group by name, or null if they are in only one.'),
    }),
    async run(args, { user }) {
      const group = await mayChange(user, await resolveGroup(args['group'] as string, user))
      if (!group) return 'They are not in a group by that name, so there is nothing to stop.'

      await groupService.ignore(group.chatJid)
      return `Stopped. Nothing more from ${group.name ?? 'that group'} is read or passed on to anyone. Nothing already stored was deleted.`
    },
  },

  {
    name: 'file_announcement',
    description:
      'Answer which course an announcement belongs to, when Peermate heard something in a group and could not tell. Use only when replying to a question Peermate asked about an unfiled announcement.',
    tier: 'reversible',
    parameters: z.object({
      course: z
        .string()
        .nullable()
        .describe('The course code, or null when they say to leave it alone.'),
      whole_group: z
        .boolean()
        .describe('True when they say everything from that group belongs to this course.'),
    }),
    async run(args, { user }) {
      // Only a question about a group they are in. An open decision is a queue shared
      // by every group on the shard, so without this a student would answer — and
      // deliver — an announcement from a cohort they have never been near.
      const open = await pendingRepository.unresolved(20)
      let decision = null
      for (const candidate of open) {
        const group = await groupRepository.findByJid(candidate.chatJid)
        if (group && (await membershipService.mayAdminister(user, group))) {
          decision = candidate
          break
        }
      }
      if (!decision) return 'Nothing is waiting on them about an announcement. Do not invent one.'

      if (args['course'] === null) {
        await pendingRepository.resolve(decision.eventId, null)
        return 'Left that one alone. It reaches nobody.'
      }

      const [key] = parseCourseList(String(args['course'] ?? ''))
      if (!key) return 'That is not a course code. Ask them for one like CVE 575.'
      const display = courseDisplay(key) ?? key

      await pendingRepository.resolve(decision.eventId, display)
      const told = await announcementService.deliverResolved(decision.eventId, display)

      if (!args['whole_group']) {
        return `Filed under ${display} and sent to ${told} student${told === 1 ? '' : 's'}. Offer to file everything from ${decision.groupName ?? 'that group'} there too.`
      }

      await groupService.setCourse(decision.chatJid, display)
      const rest = await pendingRepository.openForGroup(decision.chatJid)
      for (const other of rest) {
        await pendingRepository.resolve(other.eventId, display)
        await announcementService.deliverResolved(other.eventId, display)
      }
      return `Filed under ${display}, sent to ${told} student${told === 1 ? '' : 's'}, and everything from ${decision.groupName ?? 'that group'} goes there now${rest.length > 0 ? ` — including ${rest.length} that was already waiting` : ''}.`
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
      if (source.fromGroup && !accessibleGroups(user).includes(source.chatJid)) {
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
    name: 'configure_group',
    description:
      "Control one of the student's groups: all activity, deadlines only, pause proactive updates, or forget access to its history.",
    tier: 'reversible',
    parameters: z.object({
      group: z.string(),
      mode: z.enum(['all', 'deadlines', 'paused', 'forget']),
    }),
    async run(args, { user }) {
      const group = await resolveGroup(String(args['group'] ?? ''), user)
      if (!group) return 'That is not one of their accessible groups.'
      const mode = args['mode'] as 'all' | 'deadlines' | 'paused' | 'forget'
      if (mode === 'forget') {
        await userRepository.forgetGroup(user.phone, group.chatJid)
        return `Forgot *${group.name ?? 'that group'}*. Its history is no longer available to this user.`
      }
      await userRepository.setGroupPreference(user.phone, group.chatJid, mode)
      return mode === 'paused'
        ? `Paused proactive updates from *${group.name ?? 'that group'}*. Its existing history is still searchable.`
        : mode === 'deadlines'
          ? `Only deadlines, tests and assignments from *${group.name ?? 'that group'}* will trigger proactive updates.`
          : `All proactive updates from *${group.name ?? 'that group'}* are enabled.`
    },
  },

  {
    name: 'organize_memory',
    description:
      'Create, update or delete a named personal collection of recoverable source messages.',
    tier: 'reversible',
    parameters: z.object({
      action: z.enum(['create', 'add', 'remove', 'delete']),
      name: z.string(),
      source_id: z.string().nullable(),
    }),
    async run(args, { user }) {
      const action = args['action'] as 'create' | 'add' | 'remove' | 'delete'
      const name = String(args['name'] ?? '').trim()
      const sourceId = args['source_id'] ? String(args['source_id']) : null
      if (!name) return 'A collection needs a name.'
      if (action === 'delete') {
        await memoryCollectionRepository.delete(user.phone, name)
        return `Deleted the collection *${name}*. The original sources were not deleted.`
      }
      if ((action === 'add' || action === 'remove') && !sourceId) return 'Choose a source first.'
      if (sourceId) {
        const source = await messageRepository.findById(sourceId)
        const allowed =
          source &&
          ((!source.fromGroup && source.senderPhone === user.phone) ||
            (source.fromGroup && accessibleGroups(user).includes(source.chatJid)))
        if (!allowed) return 'That source is not available to this user.'
      }
      if (action === 'remove') await memoryCollectionRepository.remove(user.phone, name, sourceId!)
      else await memoryCollectionRepository.add(user.phone, name, sourceId ?? undefined)
      return `${action === 'remove' ? 'Removed the source from' : action === 'create' ? 'Created' : 'Saved the source to'} *${name}*.`
    },
  },

  {
    name: 'list_collections',
    description: 'List personal collections, or list the recoverable source IDs inside one.',
    tier: 'read',
    parameters: z.object({ name: z.string().nullable() }),
    async run(args, { user }) {
      const name = args['name'] ? String(args['name']) : null
      if (!name) {
        const rows = await memoryCollectionRepository.list(user.phone)
        return rows.length
          ? rows.map((row) => `- ${row.name} (${row.sourceMessageIds.length})`).join('\n')
          : 'No collections yet.'
      }
      const row = await memoryCollectionRepository.find(user.phone, name)
      if (!row) return 'No collection with that name.'
      return row.sourceMessageIds.length
        ? row.sourceMessageIds.map((id) => `- source ${id}`).join('\n')
        : `*${row.name}* is empty.`
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

/**
 * Video is built and tested but deliberately not wired to the agent yet: the tool
 * promises a render, and nothing renders unless a worker is running. Kept in the list
 * and filtered out here so turning it on is one env var, not a code change.
 */
const retired = new Set(['claim_group', 'propose_group_course'])
const available = tools.filter(
  (tool) => !retired.has(tool.name) && (config.render.enabled || tool.name !== 'render_explainer'),
)

export const toolsByName = new Map(available.map((tool) => [tool.name, tool]))
export const allTools = available

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
    default:
      return name.replace(/_/g, ' ')
  }
}
