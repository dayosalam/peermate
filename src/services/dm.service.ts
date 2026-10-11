import { explain } from '../core/failures.js'
import { logger } from '../core/logger.js'
import type { Conversation, Group, Message, Quiz, User, WebFind } from '../models/index.js'
import {
  extractionRepository,
  groupRepository,
  messageRepository,
  userRepository,
} from '../repositories/index.js'
import { config } from '../config.js'
import { courseDisplay, courseKey, parseCourseList } from '../utils/courses.js'
import { jidToIdentity } from '../whatsapp/jid.js'
import { agentService, runConfirmed } from './agent/agent.service.js'
import { conversationService } from './conversation.service.js'
import { PDF_MIME } from './document-reader.service.js'
import { DeliveryService } from './delivery.service.js'
import { courseService } from './course.service.js'
import { groupService } from './group.service.js'
import { membershipService } from './membership.service.js'
import { notifierService } from './notifier.service.js'
import { onboardingService } from './onboarding.service.js'
import { reminderService } from './reminder.service.js'
import { prepService } from './prep.service.js'
import { researchService } from './research.service.js'
import { resourceService } from './resource.service.js'
import { scheduleService } from './schedule.service.js'
import { timetableService, type ReadTimetable } from './timetable.service.js'
import { studentCommandsService } from './student-commands.service.js'
import { studentContextService } from './student-context.service.js'

/** "Quiz me", as opposed to "what should I revise?" — one asks, the other explains. */
const ASKS_TO_BE_QUIZZED = /\b(quiz|ask me|test me|start|practice questions|go ahead)\b/i

/**
 * A yes with nothing attached to it.
 *
 * Excludes "ok" and "okay", which are acknowledgements: replying to those is what
 * makes a bot exhausting to talk to. A "yes" is different — they expected something
 * to happen, and silence looks like it did.
 */
const STRAY_YES = /^(yes|yeah|yep|yup|sure|go ahead|send (it|them)|do it|please do)\b[\s.!]*$/i

/**
 * Picking from a list of web finds: "2", "send 1 and 3", "all".
 *
 * Deliberately strict. The list stays pickable for as long as the context lives, and a
 * loose pattern would swallow "when is the CVE 575 test?" as a request for file 575.
 */
const PICKS_FOUND = /^(send\s+)?(all|both|everything|\d+(\s*(,|and|&)?\s*\d+)*)\s*$/i

/** Mid-quiz, these are not answers. */
const ENDS_QUIZ = /^(stop|end|quit|cancel|enough|abeg stop|i'?m done|done)\b/i

const AGREED =
  /^(yes|yeah|yep|yh|correct|right|exactly|that'?s (it|right)|sure|ok(ay)?|na so|👍)\b/i
const DECLINED = /^(no|nope|nah|wrong|not (that|it)|different|another)\b/i

/**
 * A group that carries a whole department rather than one course.
 *
 * Accepted as an answer rather than argued with: a tester said this twice, was asked
 * the same question a third time, and gave up. The extractor already reads the course
 * out of each message and only falls back to the group's, so a group with no course
 * files each announcement under whatever it names.
 */
const GENERAL =
  /\b(general|generic|all (of )?(my |our )?courses|every course|whole (department|class|set)|department(al)? group|not (for )?(a|one) (particular |specific )?course|no (particular |specific )?course)\b/i

/** One pictograph or several, with nothing else in the message. */
const EMOJI_ONLY = /^(?:[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}]|\s)+$/u
const PUZZLED = /[\u{2753}\u{2754}\u{1F914}\u{1F615}\u{1F644}\u{1F928}]/u
const SALUTATION =
  /^(hi+|hey+|hell[o0]+|yo|sup|greetings|good\s*(morning|afternoon|evening|day)|how\s*far|wetin\s*dey|abeg)[\s!.,]*$/i

/**
 * Says which part could not be trusted, rather than "I couldn't read that".
 *
 * A student who photographed a real, sharp timetable and is told it was unreadable
 * will just send it again. The useful thing is that the *dates* did not land — which
 * they can act on, usually by noticing it is last session's sheet.
 */
function staleTimetable(read: ReadTimetable): string {
  const [clash] = read.mismatches
  const courses = [...new Set(read.undated.filter(Boolean))].slice(0, 3).join(', ')

  const evidence = clash
    ? `it has *${clash.written}* against a date that falls on a *${clash.resolved.split(' ')[0]}*`
    : `I couldn't place ${courses ? `the dates for *${courses}*` : 'any of the dates'} on this year's calendar`

  return `I read that, but ${evidence}.

That usually means it's from a previous session. I haven't saved anything — reminders off a stale timetable are worse than none.

If it is current, tell me the year and I'll take another look.`
}

/**
 * What they actually want, with the asking stripped out.
 *
 * "Can you get me more external material for CVE 575 transportation engineering"
 * becomes "transportation engineering". The course code goes too: it is the one term
 * guaranteed to match the wrong university's course of the same number.
 */
function subjectWords(text: string): string {
  return text
    .replace(/\b[A-Za-z]{2,4}\s?\d{3,4}\b/g, ' ')
    .replace(ASKING, ' ')
    .replace(/[^\w\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The pickable list, identical whether it is new or being shown again. */
function listFindings(findings: WebFind[]): string {
  const lines = findings.map((item) => `${item.position}. *${item.title}*\n   ${item.url}`)
  return `${lines.join('\n\n')}

_From the web, not from your group._

Send *1*, *send 1 and 3*, or *all* and I'll send them over.`
}

/**
 * A course title, only when it is written where a title goes: straight after the code.
 *
 * "CVE 575 transportation engineering" names the subject. "How many PDFs do we have on
 * CVE 565" does not — and taking the leftovers of that sentence filed the course under
 * the title "How many", which then became the query every later search ran on.
 */
function titleAfterCode(text: string, key: string): string {
  const pattern = /([A-Za-z]{2,4})\s?(\d{3,4})\s*[:,-]?\s*([A-Za-z][A-Za-z\s]{3,60})/g

  for (const match of text.matchAll(pattern)) {
    if (courseKey(`${match[1]}${match[2]}`) !== key) continue
    const words = subjectWords(match[3] ?? '')
      .split(/\s+/)
      .filter((word) => /^[a-z]{4,}$/i.test(word))
    if (words.length >= 2) return words.join(' ')
  }
  return ''
}

/** The words of the request rather than of the subject. */
const ASKING =
  /\b(can|could|would|will|you|u|please|abeg|pls|plz|get|send|share|find|look|search|give|me|my|more|some|any|another|other|one|extra|external|outside|online|internet|web|material|materials|resource|resources|note|notes|file|files|document|documents|pdf|pdfs|book|for|about|on|of|the|a|an|i|we|want|need|it|them|too|also|again|thanks|thank|how|what|which|when|where|who|why|many|much|do|does|did|have|has|had|is|are|there|past|question|questions|paper|papers|slide|slides|lecture|lectures|tutorial|exam|exams|test|tests|assignment|assignments|textbook)\b/gi

function reactionTo(text: string): 'puzzled' | 'acknowledgement' | 'not-emoji' {
  if (!EMOJI_ONLY.test(text) || !/\p{Extended_Pictographic}/u.test(text)) return 'not-emoji'
  return PUZZLED.test(text) ? 'puzzled' : 'acknowledgement'
}

/**
 * One in-flight message per student.
 *
 * People send three messages in five seconds — "CSC 301", "resources", "past
 * questions" — and handled concurrently they answer out of order, or worse, each
 * overwrites the conversation context the next one depends on. Serialising per
 * student costs nothing and makes the thread read like a conversation.
 */
const inFlight = new Map<string, Promise<void>>()
const membershipRefreshedAt = new Map<string, number>()
const MEMBERSHIP_REFRESH_MS = 60_000

/**
 * Everything a student sends in a 1:1 DM lands here.
 *
 * Order matters, and only two things come before the agent. Onboarding, because an
 * unregistered sender has no courses and nothing to retrieve against; and an answer to
 * a question Peermate itself just asked, because a "no" to a wipe must mean no.
 * Everything else — including "pause alerts", "my courses" and a bare course code, all
 * of which used to be matched literally here — is language, and language is the
 * agent's to read.
 *
 * There is no operator console any longer. Peermate has a relationship with each
 * student and nobody stands above them: authority over a group is being in it.
 */
export class DmService {
  async handle(message: Message): Promise<void> {
    const phone = jidToIdentity(message.chatJid)
    if (!phone) return

    const previous = inFlight.get(phone) ?? Promise.resolve()
    const next = previous
      .catch(() => undefined)
      .then(() => this.process(phone, message))
      .finally(() => {
        if (inFlight.get(phone) === next) inFlight.delete(phone)
      })

    inFlight.set(phone, next)
    return next
  }

  private async process(phone: string, message: Message): Promise<void> {
    // A photographed timetable or a recorded question carries its content in the
    // transcript, not in the caption — often there is no caption at all.
    const text = [message.text, message.caption, message.transcript]
      .filter(Boolean)
      .join('\n')
      .trim()

    const onboardingReply = await onboardingService.handle(message)
    if (onboardingReply) {
      // A timetable photo sent while registering is two things at once: the codes on
      // it are the courses they take, and the grid is their schedule. Onboarding reads
      // the codes and stops, so the schedule was thrown away at the one moment a
      // student is most likely to send one. Held rather than offered straight away —
      // onboarding has its own questions left to ask, and two open questions collide.
      if (timetableService.looksLikeTimetable(message)) await this.holdTimetable(phone, message)

      await notifierService.sendText(message.chatJid, onboardingReply)

      const registered = await userRepository.findByPhone(phone)
      if (registered?.onboardingState === 'registered') {
        await this.offerHeldTimetable(registered, message.chatJid)
        // The introduction accompanies a real first request; it does not replace it.
        // Greetings alone need no second greeting from the agent.
        if (text && !SALUTATION.test(text.trim())) {
          await this.processRegistered(registered, message, text)
        }
      }
      return
    }

    const stored = await userRepository.findByPhone(phone)
    if (!stored) return
    if (stored.onboardingState === 'awaiting_timetable') {
      const handled = timetableService.looksLikeTimetable(message)
        ? await this.readTimetable(stored, message, true)
        : false
      if (!handled)
        await notifierService.sendText(
          message.chatJid,
          "I couldn't read a timetable from that. Send a photo, PDF, document, pasted text, or type the course, day and time for each class.",
        )
      return
    }
    if (stored.onboardingState === 'awaiting_timetable_confirmation') {
      await this.finishOnboardingTimetable(stored, text, message.chatJid)
      return
    }
    if (stored.onboardingState !== 'registered') return

    await this.processRegistered(stored, message, text)
  }

  private async processRegistered(stored: User, message: Message, text: string): Promise<void> {
    const phone = stored.phone
    // Membership, not a course list, grants access to group memory. Refresh on a DM
    // so an existing user gains a newly connected group without another setup flow.
    const lastMembershipRefresh = membershipRefreshedAt.get(phone) ?? 0
    if (Date.now() - lastMembershipRefresh >= MEMBERSHIP_REFRESH_MS) {
      await membershipService
        .subscribe(stored)
        .then(() => membershipRefreshedAt.set(phone, Date.now()))
        .catch((error) => {
          logger.warn({ err: error, phone }, 'could not refresh group membership')
        })
    }
    const refreshed = (await userRepository.findByPhone(phone)) ?? stored
    // Checked here rather than swept on a timer, so a pause that ran out while the
    // process was down is still over when it comes back up.
    const user = DeliveryService.expired(refreshed) ? await this.liftPause(refreshed) : refreshed
    await conversationService.touch(phone)

    if (!text) {
      await this.say(
        phone,
        message.chatJid,
        message.type === 'image' || message.type === 'audio'
          ? "I couldn't make anything out of that. Could you send it again, or type it out?"
          : message.type === 'document'
            ? `I saved *${message.fileName ?? 'that file'}*. Tell me what you want from it — a summary, questions, an explanation, or a video walkthrough.`
            : 'Ask me something like *"when is the CSC 301 test?"*',
      )
      return
    }

    await conversationService.rememberTurn(phone, 'student', text)

    // A quoted reply points at one specific alert, which is the whole reason somebody
    // uses Reply instead of just typing. The 45-minute context cannot do this: they
    // are replying to an older message precisely because it is not the current one.
    const quoted = message.quotedMessageId
      ? await this.focusQuoted(user, message.quotedMessageId)
      : false

    // An answer to a question Peermate asked, before anything reinterprets it.
    if (await this.answerPending(user, text, message.chatJid)) return

    // Somebody can add Peermate to a group before they have ever written to it, and it
    // will not message a stranger to ask what the group is. The question waits here
    // until they make contact, which is this moment.
    //
    // Asked *as well as* answering, never instead. Returning here threw the student's
    // message away and replied with this question — so "wipe everything about me" and
    // "restart" were both answered with "which course is that group?", and the word
    // "Before that" promised an answer that never came.
    // Group connection is automatic and never becomes a pending question in this DM.

    // A photographed timetable is not a question. Routed as one it becomes a search
    // for whatever the OCR happened to say, which is never what they meant.
    const explicitlyUpdatingTimetable =
      message.type === 'image' ||
      message.type === 'document' ||
      /\b(my timetable|my schedule|class timetable|update (?:my )?(?:timetable|schedule)|new timetable|class times?)\b/i.test(
        text,
      )
    if (explicitlyUpdatingTimetable && timetableService.looksLikeTimetable(message)) {
      if (await this.readTimetable(user, message)) return
    }

    // A demo hook. Nothing is said back: the reminder arriving on its own is the
    // whole point, and an acknowledgement would both precede it and give the delay
    // away. Only a failure to schedule one is worth a reply.
    if (text.trim() === 'REMINDER_TEST') {
      const problem = await reminderService.previewIn(user, 10_000)
      if (problem) await this.say(phone, message.chatJid, problem)
      return
    }

    // The answer to a question Peermate itself asked — a confirmed wipe, a new name.
    // Not an intent to be inferred: a yes means yes to what was just asked, and a
    // model free to read it otherwise is how an irreversible wipe happens on a "no".
    const answered = await studentCommandsService.resolvePending(user, text.trim())
    if (answered) {
      await this.say(phone, message.chatJid, answered)
      return
    }

    // Nothing was pending — answerPending already had its chance. A yes with nothing
    // to agree to usually means Peermate asked something and the context expired.
    if (STRAY_YES.test(text.trim())) {
      await this.say(
        phone,
        message.chatJid,
        "Yes to what? I'm not waiting on an answer to anything right now — if I asked you something a while back, it's expired. Ask me again and I'll pick it up.",
      )
      return
    }

    const emoji = reactionTo(text)
    if (emoji !== 'not-emoji') {
      // A thumbs-up is an acknowledgement, and replying to one is what makes a bot
      // exhausting to talk to. Only a puzzled face is actually asking something.
      if (emoji === 'puzzled') {
        await this.say(
          phone,
          message.chatJid,
          'Not sure what you need — ask me something like *"when is the CSC 301 test?"*, or send *help*.',
        )
      }
      return
    }

    try {
      // Typing stays visible for the whole call, not just the first ten seconds.
      const reply = await notifierService.withTyping(message.chatJid, () =>
        this.respond(user, text, message.chatJid, message.type === 'audio', quoted),
      )
      if (reply) {
        await this.say(phone, message.chatJid, reply)
        await conversationService.rememberQuestion(phone, text, reply)
      }
    } catch (error) {
      // Say what actually failed. "Something went wrong" makes an outage
      // indistinguishable from a question that simply has no answer.
      logger.error({ err: error, phone }, 'dm handling failed')
      await this.say(phone, message.chatJid, explain(error))
    }
  }

  /**
   * Sends a reply and keeps it in the thread.
   *
   * Every reply, not only the ones a model wrote. "What did you tell me about the
   * venue?" means whatever Peermate actually sent, which is as often a file listing
   * or a command reply as it is an answer.
   */
  private async say(phone: string, jid: string, body: string): Promise<void> {
    await notifierService.sendText(jid, body)
    await conversationService.rememberTurn(phone, 'peermate', body)
  }

  /**
   * Asks about a group this student added while Peermate had no way to reach them.
   *
   * Only when nothing else is pending: a student who added a group last week and has
   * just asked when their test is wants an answer, not a question. It keeps until the
   * next message, and the group reads nothing meanwhile.
   */
  private async claimAddedGroup(user: User, jid: string): Promise<boolean> {
    const conversation = await conversationService.get(user.phone)
    if (conversation?.pendingAction) return false

    const [waiting] = await membershipService.claimable(user)
    if (!waiting) return false

    const where = describeGroup(waiting)
    if (waiting.defaultCourse) {
      await conversationService.proposeGroup(user.phone, {
        chatJid: waiting.chatJid,
        groupName: waiting.name,
        course: waiting.defaultCourse,
      })
      await this.say(
        user.phone,
        jid,
        `Before that — you added me to *${where}*.

Looks like *${waiting.defaultCourse}* from the name. Send *yes* and I'll start listening, or send the right code.`,
      )
    } else {
      // Recorded before it is asked. Without this the next message finds nothing
      // pending, re-enters here, and asks again — the student answers into a loop.
      await conversationService.proposeGroup(user.phone, {
        chatJid: waiting.chatJid,
        groupName: waiting.name,
        course: null,
      })
      await this.say(
        user.phone,
        jid,
        `Before that — you added me to *${where}*.

Which course is it for? Send the code, like *CVE 575*. If it carries every course, say *general*. I'm reading nothing in there until you tell me.`,
      )
    }
    return true
  }

  /** Returns the text to send, or null when the branch already replied itself. */
  /**
   * Everything a registered student says, answered by the agent.
   *
   * There used to be an intent router here and thirteen gates above it, each one a
   * rule that had to be remembered in every other branch. The router also had to
   * classify correctly *before* retrieval ran, so an unusual phrasing failed even
   * when the answer was sitting in the archive — which is exactly backwards for a
   * product whose whole claim is that it heard something you missed.
   *
   * What stays literal is what is genuinely not a conversation: onboarding is a form,
   * the operator commands are a console, and a pending question Peermate itself asked
   * is answered by whoever asked it.
   */
  private async respond(
    user: User,
    text: string,
    jid: string,
    spoken: boolean,
    quoted = false,
  ): Promise<string | null> {
    void quoted

    try {
      return await agentService.answer(text, {
        user,
        jid,
        profile: await studentContextService.describe(user),
        // Longer than the old router's ten: answering "you told me it moved — what
        // was the old date?" means reading the earlier reply, not just recognising it.
        history: await conversationService.transcript(user.phone, 20, 400),
      })
    } catch (error) {
      logger.error({ err: error, phone: user.phone }, 'agent could not answer')
      // Say it plainly rather than guessing. A wrong answer about a test is worse
      // than an admitted outage, and a student who is told can ask again in a minute.
      return `${this.heard(text, spoken)}Something went wrong at my end just then — I couldn't check properly. Try me again in a moment.`
    }
  }

  /**
   * A photograph of their own timetable or course list.
   *
   * Nothing is stored here. The student cannot see what the OCR made of their
   * handwriting, so the reading is shown back and only written once they agree —
   * a silently accepted misreading turns up weeks later as a reminder for the wrong
   * day, by which time the photograph is far up the chat and nobody suspects it.
   *
   * Returns false when the picture is not a timetable, so an ordinary photo with a
   * question in the caption still reaches the router.
   */
  private async readTimetable(user: User, message: Message, onboarding = false): Promise<boolean> {
    const read = await notifierService.withTyping(message.chatJid, () =>
      timetableService.read(message),
    )
    if (!read || read.kind === 'other') return false

    if (read.unreadable) {
      await this.say(
        user.phone,
        message.chatJid,
        "I can see that's a timetable but I can't read it clearly enough to trust it. Could you send a sharper photo, or type the rows out?",
      )
      return true
    }

    // Titles and lecturers are worth keeping whatever they decide about the
    // schedule: they are what makes "Dr Bello's course" resolvable later.
    await courseService.learn(read.courses)

    // Every row's day contradicting its date means the picture is from another year,
    // not that one cell was misread. Storing it would schedule reminders for days the
    // student was never told — and they would only find out by missing an exam.
    // Nothing placeable and plenty attempted means the picture is from another
    // session — the offered calendar only looks forward, so last year's dates match
    // nothing. Storing the weekdays instead would remind them every Tuesday for ever.
    if (read.entries.length === 0 && (read.mismatches.length > 0 || read.undated.length > 0)) {
      await this.say(user.phone, message.chatJid, staleTimetable(read))
      return true
    }

    // Entries are the evidence, not the label. A week's grid is mostly course codes,
    // so "course list" is the easy misread — and taking it discarded a fully read
    // timetable, leaving the student enrolled in the right courses with no schedule
    // and no sign that anything had been lost.
    if (read.entries.length === 0) {
      const reply = await this.takeCourseList(user, read.courseKeys)
      await this.say(user.phone, message.chatJid, reply)
      return true
    }

    // Their own timetable is the most authoritative statement of what they take, and
    // apply() keeps only rows for courses they watch — so without this a first
    // timetable is read correctly, previewed in full, and then stores nothing.
    const added = await this.watchCoursesIn(user, read.entries)

    await conversationService.proposeTimetable(user.phone, read)
    if (onboarding) {
      await onboardingService.timetableReady(
        user,
        read.entries.map((entry) => entry.courseKey).filter((key): key is string => Boolean(key)),
      )
    }
    const note = added.length
      ? `\n\n_I've added ${added.map(courseDisplay).join(', ')} to your courses — they were on it and you weren't watching them._`
      : ''
    await this.say(user.phone, message.chatJid, `${scheduleService.preview(read, user)}${note}`)
    return true
  }

  private async finishOnboardingTimetable(user: User, text: string, jid: string): Promise<void> {
    const conversation = await conversationService.get(user.phone)
    if (!conversation?.timetable) {
      await this.say(user.phone, jid, await onboardingService.timetableRejected(user))
      return
    }
    if (DECLINED.test(text)) {
      await conversationService.proposeTimetable(user.phone, null)
      await this.say(user.phone, jid, await onboardingService.timetableRejected(user))
      return
    }
    if (!AGREED.test(text)) {
      await this.say(user.phone, jid, 'Is the timetable I read correct? Reply *yes* or *no*.')
      return
    }

    await conversationService.proposeTimetable(user.phone, null)
    const refreshed = (await userRepository.findByPhone(user.phone)) ?? user
    const stored = await scheduleService.apply(refreshed, conversation.timetable as ReadTimetable)
    const next = await onboardingService.timetableAccepted(refreshed)
    await this.say(
      user.phone,
      jid,
      `Saved ${stored} timetable item${stored === 1 ? '' : 's'} 👍\n\n${next}`,
    )
  }

  /** A photographed course list, which is a request to watch those courses. */
  /** Reads a timetable sent mid-registration and keeps it until there is a student. */
  private async holdTimetable(phone: string, message: Message): Promise<void> {
    const read = await timetableService.read(message)
    if (!read || read.kind === 'other' || read.unreadable || read.entries.length === 0) return

    await courseService.learn(read.courses)
    await conversationService.proposeTimetable(phone, read)
    logger.info({ phone, entries: read.entries.length }, 'timetable held through onboarding')
  }

  /** Offers it once registration is done, in the same words a later photo would get. */
  private async offerHeldTimetable(user: User, jid: string): Promise<void> {
    const held = (await conversationService.get(user.phone))?.timetable as ReadTimetable | null
    if (!held) return

    await this.watchCoursesIn(user, held.entries)
    await this.say(user.phone, jid, scheduleService.preview(held, user))
  }

  /** Adds the courses a photographed timetable names but the student is not watching. */
  private async watchCoursesIn(user: User, entries: ReadTimetable['entries']): Promise<string[]> {
    const named = [
      ...new Set(
        entries.map((entry) => entry.courseKey).filter((key): key is string => Boolean(key)),
      ),
    ]
    const fresh = named.filter((key) => !user.courseKeys.includes(key))
    if (fresh.length === 0) return []

    user.courseKeys = [...user.courseKeys, ...fresh]
    await userRepository.upsert(user)
    logger.info({ phone: user.phone, fresh }, 'courses added from a timetable')
    return fresh
  }

  private async takeCourseList(user: User, courseKeys: string[]): Promise<string> {
    const fresh = courseKeys.filter((key) => !user.courseKeys.includes(key))
    if (courseKeys.length === 0) {
      return "I couldn't pick any course codes out of that. Send them as text — like *CVE 575, ABE 501* — and I'll take it from there."
    }
    if (fresh.length === 0) {
      return `I read ${courseKeys.map(courseDisplay).join(', ')} — you're already watching all of those.`
    }

    await userRepository.upsert({ ...user, courseKeys: [...user.courseKeys, ...fresh] })
    logger.info({ phone: user.phone, fresh }, 'courses added from a photograph')
    return `Read that as a course list. Added *${fresh.map(courseDisplay).join(', ')}*.

You're now watching ${[...user.courseKeys, ...fresh].map(courseDisplay).join(', ')}.

If I got a code wrong, send *remove <code>*.`
  }

  /**
   * The answer to something Peermate itself just asked.
   *
   * Deterministic by design. These follow an instruction Peermate gave a second
   * earlier, so leaving them to the router makes the step right most of the time —
   * which is not good enough when the question was "which course is this group for?"
   * and the answer decides where a semester of announcements gets filed.
   *
   * Returns true when the message was consumed. Anything that is not an answer falls
   * through to ordinary handling, so changing the subject is always allowed.
   */
  private async answerPending(user: User, text: string, jid: string): Promise<boolean> {
    const conversation = await conversationService.get(user.phone)

    // A destructive action the agent asked about. Theirs to allow, and answered here
    // rather than by the agent: "yes" is an answer to a question Peermate asked, and
    // re-interpreting it from scratch makes it a coin flip.
    if (conversation?.pendingAction === 'confirm_tool' && conversation.pendingTool) {
      const held = conversation.pendingTool
      await conversationService.clearPendingTool(user.phone)

      if (!AGREED.test(text.trim())) {
        if (DECLINED.test(text.trim())) {
          await this.say(user.phone, jid, "Alright, I've left it.")
          return true
        }
        // Changing the subject abandons it, exactly like every other pending question.
        return false
      }

      const reply = await notifierService.withTyping(jid, () =>
        runConfirmed(held.name, held.args as Record<string, unknown>, { user, jid }),
      )
      await this.say(user.phone, jid, reply)
      return true
    }

    if (conversation?.pendingAction === 'answering_quiz' && conversation.quiz) {
      await this.markQuizAnswer(user, conversation.quiz, text, jid)
      return true
    }

    if (conversation?.pendingAction === 'confirm_timetable' && conversation.timetable) {
      if (DECLINED.test(text)) {
        await conversationService.proposeTimetable(user.phone, null)
        await this.say(
          user.phone,
          jid,
          'Dropped it — nothing stored. Send a clearer photo when you can, or type the rows out.',
        )
        return true
      }
      if (!AGREED.test(text)) return false

      await conversationService.proposeTimetable(user.phone, null)
      const stored = await scheduleService.apply(user, conversation.timetable as ReadTimetable)
      await this.say(
        user.phone,
        jid,
        stored === 0
          ? "None of those were for courses you're watching, so I haven't stored anything. Add the course first with *add <code>*."
          : `Saved ${stored} item${stored === 1 ? '' : 's'} 👍\n\nI'll remind you before each one — a day ahead for exams, about an hour ahead for classes. Send *pause* any time if that's too much.`,
      )
      return true
    }

    if (
      (conversation?.pendingAction === 'confirm_group_course' ||
        conversation?.pendingAction === 'awaiting_group_course') &&
      conversation.proposal
    ) {
      const reply = await this.resolveGroupProposal(user, conversation.proposal, text)
      if (!reply) return false
      await this.say(user.phone, jid, reply)
      await conversationService.rememberQuestion(user.phone, text, reply)
      return true
    }

    if (conversation?.pendingAction === 'choose_web_file' && conversation.findings.length > 0) {
      if (DECLINED.test(text)) {
        await conversationService.expect(user.phone, null)
        await this.say(
          user.phone,
          jid,
          'No problem — the links are up there if you change your mind.',
        )
        return true
      }
      if (!PICKS_FOUND.test(text.trim())) return false

      const picked = [...text.matchAll(/\d+/g)].map((match) => Number(match[0]))
      await this.sendFound(user, conversation.findings, picked, jid)
      return true
    }

    return false
  }

  /**
   * Makes the quoted alert the thing being discussed.
   *
   * Nothing is said about it — the student's own words are still the question. This
   * only replaces the referent, so "where is this holding?" resolves against the
   * message they pointed at rather than the last one they happened to receive.
   */
  private async focusQuoted(user: User, quotedMessageId: string): Promise<boolean> {
    const eventId = await conversationService.alertFor(user.phone, quotedMessageId)
    if (!eventId) return false

    // The whole reason to use Reply is to point at an older message, which is exactly
    // the one most likely to have been corrected since. Resolve to the current event.
    const extraction = await extractionRepository.currentFor(eventId)
    if (!extraction) return false

    await conversationService.rememberEvent(user.phone, extraction)
    logger.debug({ phone: user.phone, eventId }, 'quoted an alert')
    return true
  }

  /** Downloads and forwards what they picked. Nothing is stored. */
  private async sendFound(
    user: User,
    findings: WebFind[],
    positions: number[],
    jid: string,
  ): Promise<void> {
    const picked =
      positions.length > 0 ? findings.filter((item) => positions.includes(item.position)) : findings

    if (picked.length === 0) {
      await this.say(user.phone, jid, `There's no ${positions.join(' or ')} in that list.`)
      return
    }

    const failed: string[] = []
    let sent = 0

    await notifierService.withTyping(jid, async () => {
      for (const item of picked) {
        const file = await researchService.download(item.url)
        if (!file) {
          failed.push(item.title)
          continue
        }
        await notifierService.sendDocument(
          jid,
          file.bytes,
          file.fileName,
          PDF_MIME,
          `${item.title}\n\n_From the web, not from your group._`,
        )
        sent += 1
      }
    })

    // Named, not counted: "1 failed" leaves them wondering which one, and the link is
    // still in the list above for them to open themselves.
    if (failed.length > 0) {
      await this.say(
        user.phone,
        jid,
        `${sent > 0 ? `Sent ${sent}. ` : ''}I couldn't download ${failed.map((title) => `*${title}*`).join(', ')} — the link didn't give back a PDF. You can still open it from the list above.`,
      )
    }
  }

  /** One answer, marked, and the next question — or the score when they are done. */
  private async markQuizAnswer(user: User, quiz: Quiz, text: string, jid: string): Promise<void> {
    if (ENDS_QUIZ.test(text.trim())) {
      await conversationService.setQuiz(user.phone, null)
      await this.say(user.phone, jid, prepService.score(quiz))
      return
    }

    const { reply, next } = await notifierService.withTyping(jid, () =>
      prepService.mark(quiz, text, user.phone),
    )
    const finished = next.index >= next.questions.length
    // Kept rather than cleared when it finishes: "ask me those again" should not have
    // to pay for a fresh set, and the questions are still the right ones.
    await conversationService.setQuiz(user.phone, next, !finished)
    await this.say(user.phone, jid, reply)
  }

  /**
   * Shows the transcript when a spoken message could not be understood.
   *
   * A voice note the student cannot see transcribed is a black box: "I'm not sure
   * what you're after" leaves them unable to tell whether Peermate misunderstood the
   * request or simply misheard the words. Reading it back turns a dead end into an
   * obvious correction.
   */
  private heard(text: string, spoken: boolean): string {
    if (!spoken) return ''
    const words = text.replace(/\s+/g, ' ').trim()
    if (!words) return ''
    return `I heard: _"${words}"_\n\n`
  }

  /**
   * "The group you were added to is for CVE 575."
   *
   * Public, because the agent reaches it as a tool — but still here rather than in
   * the tool file, because what it starts is a pending confirmation, and a pending
   * question is answered by whoever asked it rather than interpreted afresh.
   */
  async proposeGroupCourse(user: User, text: string): Promise<string> {
    const waiting = await groupRepository.pending()
    if (waiting.length === 0) {
      const live = await groupRepository.approved()
      return live.length > 0
        ? `I'm already reading ${live.length} group${live.length === 1 ? '' : 's'}. Nothing new is waiting to be set up.`
        : "I haven't been added to any group yet. Add me to one and I'll pick it up."
    }

    const named = waiting.find((group) =>
      group.name ? text.toLowerCase().includes(group.name.toLowerCase()) : false,
    )
    const group = named ?? waiting[0]!

    const [key] = parseCourseList(text)
    if (!key) {
      return `I've been added to *${group.name ?? 'a group'}* and it's waiting to be set up. Which course is it for? Send the code, like *CVE 575*.`
    }

    // What gets confirmed here decides where a semester of announcements is filed,
    // and the student cannot see what "Cve 575" became — a misread shows up weeks
    // later as alerts that never arrive.
    return this.confirmGroupCourse(user, group, courseDisplay(key) ?? key)
  }

  private async confirmGroupCourse(user: User, group: Group, course: string): Promise<string> {
    await conversationService.proposeGroup(user.phone, {
      chatJid: group.chatJid,
      groupName: group.name,
      course,
    })

    const others = (await groupRepository.pending()).filter(
      (other) => other.chatJid !== group.chatJid,
    )
    const ambiguity =
      others.length > 0
        ? `\n\n_I picked *${group.name ?? 'that group'}* out of ${others.length + 1} waiting. If you meant another one, say its name._`
        : ''

    return `Just so I get this right — *${group.name ?? 'that group'}* is the group for *${course}*?

Send *yes* and I'll pass it on. If the code is wrong, just send the right one.${ambiguity}`
  }

  /** The yes, the correction, or the no. */
  private async resolveGroupProposal(
    user: User,
    proposal: NonNullable<Conversation['proposal']>,
    text: string,
  ): Promise<string | null> {
    // Said before any code is looked for: "not for a particular course" contains no
    // code, and a student who has to spell that out twice stops answering.
    if (GENERAL.test(text)) {
      await conversationService.proposeGroup(user.phone, null)
      return this.acceptGroup(user, proposal, null)
    }

    // A different code is a correction, not a refusal — take it and ask again rather
    // than making them say no first.
    const [corrected] = parseCourseList(text)
    if (corrected && (courseDisplay(corrected) ?? corrected) !== proposal.course) {
      const group = await groupRepository.findByJid(proposal.chatJid)
      if (!group) return null
      return this.confirmGroupCourse(user, group, courseDisplay(corrected) ?? corrected)
    }

    if (DECLINED.test(text)) {
      await conversationService.proposeGroup(user.phone, { ...proposal, course: null })
      return `No problem — which course is *${proposal.groupName ?? 'that group'}* for? Send the code, like *CVE 575*. If it carries every course, say *general*.`
    }

    if (!AGREED.test(text) && !corrected) return null

    await conversationService.proposeGroup(user.phone, null)
    return this.acceptGroup(user, proposal, proposal.course)
  }

  /**
   * Switches a group on, under one course or under none.
   *
   * A null course is a group carrying a whole department. Nothing downstream needs
   * changing for it: the extractor reads the course out of each message and only falls
   * back to the group's, and an announcement naming no course is already either
   * department-wide or dropped.
   */
  private async acceptGroup(
    user: User,
    proposal: NonNullable<Conversation['proposal']>,
    course: string | null,
  ): Promise<string> {
    // Nobody on record as having added it: this student named it and confirmed it, and
    // no proof was available. Recorded before proposing, or approval stalls on an
    // adder that does not exist and the group stays silent for everyone.
    await groupService.claim(
      proposal.chatJid,
      user.jid ?? user.phone,
      user.displayName ?? user.phone,
    )

    // The identity, not the display name: whether this switches the group on is decided
    // against the stored adder, and a name is not who somebody is.
    const outcome = await groupService.propose(
      proposal.chatJid,
      course,
      user.displayName ?? user.phone,
      user.jid ?? user.phone,
    )

    const where = proposal.groupName ?? 'that group'
    const key = courseKey(course)
    const mine = key ? user.courseKeys.includes(key) : false

    const filed = course
      ? `filing it under *${course}*`
      : 'filing each post under whatever course it names'
    const tail = course
      ? mine
        ? `You're taking ${course}, so everything said there reaches you from now on.`
        : `You're not registered for ${course} — send *add ${course}* if you want its announcements.`
      : `Anything that names none of your courses I'll treat as department-wide.`

    if (outcome?.approved) {
      return `Done — I'm listening to *${where}* and ${filed} ✅

I only know what's said from now on, not what came before.

${tail}`
    }

    const pending = course
      ? `Noted — *${where}* is for *${course}*.`
      : `Noted — *${where}* carries the whole department.`

    return `${pending}

I'm not reading it yet: somebody who is in it has to switch it on, and you didn't add me to it. I've passed this on.

${tail}`
  }

  private async liftPause(user: User): Promise<User> {
    const resumed = { ...user, pausedUntil: null }
    await userRepository.upsert(resumed)
    logger.info({ phone: user.phone }, 'pause expired')
    return resumed
  }
}

export const dmService = new DmService()

/**
 * The most identifying thing known about a group.
 *
 * WhatsApp does not always give a subject on join, and "a group" tells a student
 * nothing about which of theirs is meant — they cannot answer a question that does not
 * say what it is about. When there is no name, when they added it is what is left.
 */
function describeGroup(group: Group): string {
  if (group.name) return group.name
  const added = group.joinedAt
  if (!added) return 'a group'
  const sameDay = new Date().toDateString() === added.toDateString()
  return sameDay
    ? 'a group you added today'
    : `a group you added on ${added.toLocaleDateString('en-NG', { weekday: 'long', day: 'numeric', month: 'long' })}`
}
