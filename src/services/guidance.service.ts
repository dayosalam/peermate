import type { User } from '../models/index.js'
import { groupRepository } from '../repositories/index.js'
import { courseDisplay } from '../utils/courses.js'
import { formatTime12 } from '../utils/dates.js'

/** "how do I", "how can I", "how i go" — asking the way, not asking the answer. */
const HOW =
  /\b(how (do|can|would|should) (i|you|we)|how to|how i go|how does (this|it|you)|what does .+ (do|mean)|where do i)\b/i

/**
 * Words that make a "how do I…" about Peermate rather than about the world.
 *
 * Without this gate "how do I know if the test moved?" is a question about a course,
 * and answering it with instructions would be worse than searching for it.
 */
const ABOUT_PEERMATE =
  /\b(approve|approval|group|course|register|sign ?up|add|remove|drop|digest|summary|resource|file|slide|document|pause|mute|quiet|stop|snooze|settings?|name|use you|work|command|notification|alert)\b/i

/**
 * Asking what Peermate is set up to do, rather than how to set it up.
 *
 * "What group have you been approved for?" was being routed as unsupported — told it
 * was outside what Peermate does, when Peermate is the only thing that knows the
 * answer. The lookahead keeps it off content questions: "what group did he post that
 * in?" is about a classmate, not about Peermate, and belongs to retrieval.
 */
const SELF_STATE =
  /\b(?:what|which|how many)\s+groups?\b(?=.*\b(?:you|your|approved|reading|listening|connected|set ?up)\b)|\b(?:have|has)\s+you\s+been\s+(?:approved|added)\b|\bare\s+you\s+(?:reading|listening|in|connected|approved)\b|\bwhat\s+(?:are|do)\s+you\s+(?:reading|watching|connected)\b/i

interface Topic {
  match: RegExp
  answer: (context: Context) => Promise<string> | string
}

interface Context {
  user: User
}

/**
 * Answers questions about Peermate itself.
 *
 * "How do I approve it?" was going to the question router, which searched the group
 * archive for an announcement about approving things, found none, and replied that it
 * had not heard anything — which reads as broken to somebody who was asking for
 * instructions. Peermate knows its own commands; that should never need retrieval,
 * and it should never cost a model call.
 *
 * Answers are written against live state where there is any: naming the group that is
 * actually waiting, and the course somebody actually proposed for it, beats a generic
 * example the reader then has to translate.
 */
export class GuidanceService {
  /** Whether this is a question about Peermate rather than about a course. */
  looksLikeAboutPeermate(text: string): boolean {
    return SELF_STATE.test(text) || (HOW.test(text) && ABOUT_PEERMATE.test(text))
  }

  async answer(user: User, text: string): Promise<string> {
    const topic = TOPICS.find((candidate) => candidate.match.test(text))
    return topic ? topic.answer({ user }) : general({ user })
  }
}

const TOPICS: Topic[] = [
  // Before the how-to topics: "which groups are you reading?" is asking what is set
  // up, not how to set it up, and the two want opposite answers.
  { match: SELF_STATE, answer: listening },
  {
    match: /\b(approve|approval|listen|read (the |a )?group|set ?up (the |a )?group)\b/i,
    answer: approving,
  },
  { match: /\b(group)\b/i, answer: approving },
  {
    match: /\b(add|remove|drop|change|another)\b.*\bcourse|course.*\b(add|remove|drop)\b/i,
    answer: courses,
  },
  // Before the resources topic, which shares most of its words: "send me the past
  // questions" and "quiz me on the past questions" want different things.
  { match: /\b(prep|revis\w*|study|quiz|practice|exam prep|read for)\b/i, answer: prep },
  { match: /\b(resource|file|slide|document|pdf|past ?question|note)s?\b/i, answer: resources },
  { match: /\b(digest|summary|rundown|morning|voice ?note|settings?)\b/i, answer: digest },
  { match: /\b(pause|mute|quiet|stop|snooze|silence|notification|alert)s?\b/i, answer: quiet },
  {
    match: /\b(name|call me)\b/i,
    answer: () => "Send *call me Ada* — or just *change my name* and I'll ask.",
  },
  { match: /\bcourse/i, answer: courses },
]

/** Revision, and the one thing it depends on. */
function prep(): string {
  return `Send *prep me for CSC 301* and I'll build a practice set out of the slides, notes and past questions people shared in that group — what the material covers, then questions in the style your lecturer sets.

Then *quiz me* and I'll ask them one at a time and mark your answers.

I can only do this for a course whose files I actually have. If nobody has posted any, send them to me yourself.`
}

/**
 * What is actually connected right now.
 *
 * The only source for this is Peermate itself, so answering it with "that's outside
 * what I do" is the least useful thing it could say. A student wondering why they
 * hear nothing from a group usually has one they have not switched on yet.
 */
async function listening({ user }: Context): Promise<string> {
  // Their own rooms and nothing else. `approved()` is every group on the deployment,
  // so answering from it named another university's cohort to them.
  const live = await groupRepository.forStudent(user.groupJids)

  if (live.length === 0) {
    return `I'm not connected to any group you can access yet. You can still send or forward messages, files and voice notes here — groups are optional.`
  }

  const reading = live.length
    ? `*Reading ${live.length} group${live.length === 1 ? '' : 's'}:*\n${live
        .map(
          (group) => `• ${group.name ?? group.chatJid} → ${group.defaultCourse ?? 'no course set'}`,
        )
        .join('\n')}`
    : `I'm not reading any group yet.`

  return `${reading}\n\nYou can ask about anything shared after I joined. A course label helps organize it but is not required.`
}

/**
 * How a group starts being read.
 *
 * The answer is the same for everybody now, because authority over a room is being in
 * it. There is no operator to wait for and no queue belonging to somebody else.
 */
async function approving({ user }: Context): Promise<string> {
  void user
  return `Add me to a group and I begin learning new messages immediately. I post one disclosure in the room and confirm privately with whoever added me.

No approval or course code is required. Current members can ask me privately about what was shared after I joined.`
}

function courses({ user }: Context): string {
  const watching = user.courseKeys.length
    ? `\n\nRight now: ${user.courseKeys.map(courseDisplay).join(', ')}.`
    : ''
  return `*add MTH 101* — start watching a course
*remove STA 202* — stop watching one
*my courses* — see the list

You can do both at once: *add MTH 101 and remove STA 202*.${watching}`
}

function resources({ user }: Context): string {
  const example = courseDisplay(user.courseKeys[0] ?? '') ?? 'CSC 301'
  return `Ask for them by course: *${example} resources* — I'll send the actual files, not links.

You can narrow it: *${example} slides*, or *past questions*. If there are a lot I'll list them first, and you can say *send 2* or *send all*.

I only have what people shared in the group after I joined.`
}

function digest({ user }: Context): string {
  const when = formatTime12(`${String(user.digestHour).padStart(2, '0')}:00`) ?? '7am'
  return `One message each morning with everything across your courses. Yours arrives at *${when}*.

*settings* — see it
*settings 6am voice* — change the time, or get it as a voice note too
*stop the morning digest* — turn it off, keeping the instant alerts`
}

function quiet(): string {
  return `*pause* — go quiet until you say otherwise
*pause until Monday* · *pause for 2 days* — go quiet for a while
*mute STA 202* — stop the pings for one course
*only urgent* — tests, deadlines and venue changes only
*quiet off* — stop holding alerts overnight
*resume* — back to normal

Nothing is lost while I'm quiet: it all turns up in your next digest.`
}

function general(_context: Context): string {
  return `I'm your personal memory and action assistant. Send or forward messages, files and voice notes; I'll keep them searchable, help organize them and remind you about dates.

Groups are optional connected sources. Ask things like *"what did Tobi say about the venue?"*, *"find last week's voice note"* or *"what deadlines do I have?"*.`
}

export const guidanceService = new GuidanceService()
