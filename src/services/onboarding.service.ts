import { config } from '../config.js'
import { logger } from '../core/logger.js'
import type { DigestFormat, Message, User } from '../models/index.js'
import { groupRepository, userRepository } from '../repositories/index.js'
import { courseDisplay, parseCourseList } from '../utils/courses.js'
import { formatTime12 } from '../utils/dates.js'
import { jidToIdentity } from '../whatsapp/jid.js'
import { membershipService } from './membership.service.js'

const GREETING = `Hi! I'm Peermate 👋

I can remember messages, files and voice notes, organize what matters, answer from what you've shared, and remind you about it later.

Send or forward me anything. Courses and groups are optional — you can start right here.`

const ASK_COURSES = (name: string): string => `Nice to meet you, ${name} 🙌

Which courses are you taking? Send the codes, like:
*CSC 301, STA 202, MTH 101*`

const NO_COURSES_FOUND = `I couldn't spot any course codes in that.

Send them like *CSC 301, STA 202* — letters then numbers, separated by commas.`

const ASK_DIGEST = `Last thing. Every morning I'll send you one message with everything across your courses.

When would you like it, and how?
*7am text* · *6am voice* · *8am both*

Or just send *ok* for 7am, text.`

/** Names people actually send, versus a sentence that is not a name at all. */
const LOOKS_LIKE_NAME = /^[\p{L}\p{M}'’. -]{2,40}$/u

/**
 * "hi", "hello", "good evening" — a greeting, not an answer.
 *
 * It passes every other test a name has to pass, so without this the most likely
 * reply to "what should I call you?" becomes the student's name, and they are
 * addressed as Hello in every digest and reminder for the rest of the semester.
 */
const SALUTATION =
  /^(hi+|hey+|hell[o0]+|yo|sup|greetings|good\s*(morning|afternoon|evening|day)|how\s*far|wetin\s*dey|abeg)[\s!.,]*$/i

/** "skip", "doesn't matter", "anonymous" — a refusal, not a name. */
const SKIP =
  /^(skip|pass|next|n\/?a|nothing|anonymous|doesn'?t matter|no matter|whatever|nevermind)$/i
/** "restart", "start over", "cancel" — begin again from nothing. */
const RESTART = /^(restart|start over|start again|reset|cancel|begin again)$/i
/** "back" — undo the last step. */
const BACK = /^(back|go back|previous|undo)$/i

/**
 * A question, not an answer to the step they are on.
 *
 * People arrive already wanting something — the first thing many send is "when is
 * the CSC 301 test?". Registration still has to happen first, but taking that as
 * their name, or silently asking for it instead, reads as not having listened.
 */
const QUESTION =
  /\?\s*$|^\s*(when|where|what|who|why|how|which|is|are|was|were|does|do|did|can|could|will|would|any|abeg (tell|show))\b/i

function looksLikeQuestion(text: string): boolean {
  const trimmed = text.trim()
  // One word is never a question. Somebody called Will answering "what should I
  // call you?" would otherwise be told their name was a question.
  if (!/\s/.test(trimmed)) return trimmed.endsWith('?')
  return QUESTION.test(trimmed)
}

/**
 * Registration is always initiated by the student. Peermate never DMs someone who
 * has not messaged it first, and never harvests group participant lists — PRD §7.
 *
 * Three exchanges, not four: name, courses, then when and how they want the digest
 * in one question. Every extra step loses people, and this is a WhatsApp DM, not a
 * signup form.
 */
export class OnboardingService {
  /** Returns the reply to send, or null when the message is not onboarding traffic. */
  async handle(message: Message): Promise<string | null> {
    const phone = jidToIdentity(message.chatJid)
    if (!phone) return null

    const user = await userRepository.findByPhone(phone)
    // A student answering "which courses?" with a photo of their timetable has
    // answered it — the codes are in the OCR even when there is no caption.
    const text = [message.text, message.caption, message.transcript]
      .filter(Boolean)
      .join('\n')
      .trim()

    if (!user) return this.start(message, phone, text)

    // Older accounts may still be parked in the prototype's mandatory onboarding.
    // Registration is no longer a gate: migrate them on their next message and let
    // DmService handle what they actually came to ask.
    if (user.onboardingState !== 'registered') {
      await userRepository.upsert({
        ...user,
        displayName: user.displayName ?? this.readName(user.name ?? ''),
        onboardingState: 'registered',
        registeredAt: user.registeredAt ?? new Date(),
        automaticReminders: user.automaticReminders ?? true,
      })
      return GREETING
    }

    // Only while onboarding. A registered student typing "cancel" means cancel
    // whatever we were just doing — reading it as "start over" would wipe their
    // name, their courses and their settings without ever asking.
    if (user.onboardingState === 'registered') return null

    // Escape hatches work at every step. Someone stuck partway through with no way
    // out simply stops replying, and a half-registered student hears nothing ever.
    if (RESTART.test(text)) {
      await userRepository.upsert({
        ...user,
        displayName: null,
        courseKeys: [],
        onboardingState: 'awaiting_name',
      })
      return `Starting over 🔄\n\n${GREETING}`
    }
    if (BACK.test(text)) return this.goBack(user)

    switch (user.onboardingState) {
      case 'awaiting_name':
        return this.takeName(user, text)
      case 'awaiting_courses':
        return this.takeCourses(user, text)
      case 'awaiting_digest':
        return this.takeDigest(user, text)
      default:
        return null
    }
  }

  private async start(message: Message, phone: string, text: string): Promise<string> {
    const fresh: User = {
      phone,
      jid: message.chatJid,
      lid: null,
      name: message.senderName,
      displayName: this.readName(message.senderName ?? ''),
      courseKeys: looksLikeQuestion(text) ? [] : parseCourseList(text),
      groupJids: [],
      // They wrote to this number, so this is the number that answers them.
      shardId: config.whatsapp.shardId,
      onboardingState: 'registered',
      registeredAt: new Date(),
      lastDigestAt: null,
      digestFormat: 'text',
      digestHour: 7,
      quietFrom: 22,
      quietTo: 6,
      pausedUntil: null,
      paused: false,
      digestPaused: false,
      alertLevel: 'all',
      mutedCourseKeys: [],
      automaticReminders: true,
    }

    await userRepository.upsert(fresh)
    logger.info({ phone }, 'new user registered without a setup gate')
    return GREETING
  }

  /**
   * Acknowledges what they actually asked before asking for what is needed.
   *
   * The question itself is not stored: they are not registered, so there is nothing
   * to search on their behalf yet. Saying so is the honest version of "one moment".
   */
  private heard(text: string, ready = false): string {
    const asked = text.trim().replace(/\s+/g, ' ').slice(0, 80)
    return ready
      ? `Noted — _"${asked}"_. Ask me again once we're done here and I'll go and look.`
      : `I can look that up — _"${asked}"_ — but only once I know which courses you take.`
  }

  /** One step back, so a mistyped answer is not a dead end. */
  private async goBack(user: User): Promise<string> {
    switch (user.onboardingState) {
      case 'awaiting_courses':
        await userRepository.upsert({ ...user, onboardingState: 'awaiting_name' })
        return GREETING
      case 'awaiting_digest':
        await userRepository.upsert({ ...user, onboardingState: 'awaiting_courses' })
        return ASK_COURSES(user.displayName ?? 'there')
      default:
        return "We're at the start — nothing to go back to."
    }
  }

  private async takeName(user: User, text: string): Promise<string> {
    if (looksLikeQuestion(text)) {
      return `${this.heard(text)}\n\nFirst though — what should I call you?`
    }

    // If they skipped the name and sent courses, take those instead of insisting.
    const courseKeys = parseCourseList(text)
    if (courseKeys.length > 0) {
      await userRepository.upsert({ ...user, courseKeys, onboardingState: 'awaiting_digest' })
      return `${this.confirmCourses(courseKeys)}\n\n${ASK_DIGEST}`
    }

    // The greeting offers "skip", and without this it would name them Skip.
    if (SKIP.test(text.trim())) {
      const fallback = this.readName(user.name ?? '')
      await userRepository.upsert({
        ...user,
        displayName: fallback,
        onboardingState: 'awaiting_courses',
      })
      return ASK_COURSES(fallback ?? 'there')
    }

    if (SALUTATION.test(text.trim())) {
      return 'Hey 👋 — and what should I call you?'
    }

    const displayName = this.readName(text)
    if (!displayName) {
      return 'Sorry, what should I call you? Just a name is fine — like *Amina* or *Chidi*.'
    }

    await userRepository.upsert({ ...user, displayName, onboardingState: 'awaiting_courses' })
    logger.info({ phone: user.phone, displayName }, 'name taken')
    return ASK_COURSES(displayName)
  }

  private async takeCourses(user: User, text: string): Promise<string> {
    const courseKeys = parseCourseList(text)
    if (courseKeys.length === 0) {
      return looksLikeQuestion(text)
        ? `${this.heard(text)}\n\n${ASK_COURSES(user.displayName ?? 'there')}`
        : NO_COURSES_FOUND
    }

    await userRepository.upsert({ ...user, courseKeys, onboardingState: 'awaiting_digest' })
    logger.info({ phone: user.phone, courseKeys }, 'courses taken')
    return `${this.confirmCourses(courseKeys)}\n\n${ASK_DIGEST}`
  }

  /**
   * Reads back what was understood before moving on.
   *
   * Especially after a photographed timetable: the student cannot see what the OCR
   * made of their handwriting, and silently continuing means a misread course code
   * is only discovered weeks later when the alerts never come.
   */
  private confirmCourses(courseKeys: string[]): string {
    const list = courseKeys.map((key) => `• *${courseDisplay(key)}*`).join('\n')
    return `Got it — ${courseKeys.length} course${courseKeys.length === 1 ? '' : 's'}:\n\n${list}\n\nIf any of those are wrong, tell me later with *remove <code>*.`
  }

  private async takeDigest(user: User, text: string): Promise<string> {
    // "after breakfast" and "25pm" are not times. Take the default rather than
    // inventing one, but say which default was taken so it can be corrected.
    // A question here is not a digest preference, and taking the default silently
    // would answer a question they never got an answer to.
    if (looksLikeQuestion(text) && !/\b\d{1,2}\s*(am|pm)\b/i.test(text)) {
      return `${this.heard(text, true)}\n\n${ASK_DIGEST}`
    }

    const understood = /\b(\d{1,2}\s*(am|pm)?|ok|okay|yes|default|any|sure)\b/i.test(text)
    const { hour, format } = this.parseDigestPreference(text)
    const guessed = !understood

    const registered: User = {
      ...user,
      digestHour: hour,
      digestFormat: format,
      onboardingState: 'registered',
      registeredAt: new Date(),
    }
    await userRepository.upsert(registered)
    logger.info({ phone: user.phone, hour, format, guessed }, 'student registered')

    // The courses they typed are a claim about their timetable. This is what turns it
    // into access: a group they are proved to be in. Until it runs they are
    // registered and reach nothing, which is the right way round — so a failure here
    // costs them their first digest, never their registration.
    // The groups come from here rather than from the record: `registered` was built
    // before subscribe ran, so its groupJids are empty however the subscription went.
    const membership = await membershipService.subscribe(registered).catch((error) => {
      logger.error({ err: error, phone: user.phone }, 'could not resolve membership')
      return null
    })
    const welcome = await this.welcome(
      user.courseKeys,
      user.displayName,
      hour,
      format,
      membership?.joined ?? [],
    )
    return guessed
      ? `I couldn't read a time in that, so I've set *7am, text* for now — change it any time with *settings 6am voice*.\n\n${welcome}`
      : welcome
  }

  /**
   * Takes a name out of whatever they sent.
   *
   * People answer "what should I call you?" with "Amina", "I'm Amina", "call me
   * Amina" or a whole sentence. Anything that is not plausibly a name is rejected
   * rather than stored, because it ends up at the top of every message.
   */
  readName(text: string): string | null {
    const stripped = text
      .replace(/^(i'?m|my name is|call me|it'?s|this is|na)\s+/i, '')
      .replace(/[.!,]+$/, '')
      .trim()

    if (!stripped || !LOOKS_LIKE_NAME.test(stripped)) return null
    // Title-case what people type in lower case, leave deliberate capitals alone.
    return stripped
      .split(/\s+/)
      .slice(0, 3)
      .map((word) => (word === word.toLowerCase() ? word[0]!.toUpperCase() + word.slice(1) : word))
      .join(' ')
  }

  /** "6am voice", "7", "ok", "both at 8" — read loosely, default quietly. */
  parseDigestPreference(text: string): { hour: number; format: DigestFormat } {
    const lower = text.toLowerCase()

    let hour = 7
    const match = /\b(\d{1,2})\s*(am|pm)?\b/.exec(lower)
    if (match) {
      const parsed = Number(match[1])
      if (parsed >= 0 && parsed <= 23) {
        hour = match[2] === 'pm' && parsed < 12 ? parsed + 12 : parsed
        if (match[2] === 'am' && parsed === 12) hour = 0
      }
    }

    const format: DigestFormat = /\b(voice|vn|audio|both)\b/.test(lower) ? 'voice' : 'text'
    return { hour, format }
  }

  /**
   * Says which courses are actually covered.
   *
   * Listing every code the student typed implies coverage Peermate may not have: if
   * it is in no approved group for STA 202, it will never hear a word about it.
   * Saying "I'm watching" would be a promise it cannot keep.
   */
  async welcome(
    courseKeys: string[],
    displayName: string | null,
    hour: number,
    format: DigestFormat,
    groupJids: string[],
  ): Promise<string> {
    const groups = await groupRepository.forStudent(groupJids)
    const covered = new Set(groups.map((group) => group.defaultCourseKey).filter(Boolean))

    const connected = courseKeys.filter((key) => covered.has(key))
    const missing = courseKeys.filter((key) => !covered.has(key))

    // Repeating the same warning eight times buries the one line that matters.
    const lines = [
      ...connected.map((key) => `✅ *${courseDisplay(key)}* — connected`),
      missing.length > 0
        ? `⚠️ Not in a group yet for: ${missing.map(courseDisplay).join(', ')}`
        : null,
    ].filter(Boolean)

    const caveat =
      missing.length > 0
        ? `\n\nAdd me to those groups and I'll start listening. Tell me which course a group is for and I'll pass it on.`
        : ''

    const when = formatTime12(`${String(hour).padStart(2, '0')}:00`)
    const how = format === 'voice' ? 'as a voice note and text' : 'as text'

    return `You're all set${displayName ? `, ${displayName}` : ''} ✅

${lines.join('\n')}${caveat}

Your digest arrives at *${when}*, ${how}.

Ask me things like:
*"when is the CSC 301 test?"*
*"CSC 301 resources"*

Send *help* any time, or *settings* to change the digest.

One thing to know: I only know what was said after I joined each group.`
  }
}

export const onboardingService = new OnboardingService()
