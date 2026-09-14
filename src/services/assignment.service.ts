import { logger } from '../core/logger.js'
import type { Assignment, AssignmentStatus, Extraction, User } from '../models/index.js'
import { assignmentRepository, assignmentStateRepository } from '../repositories/index.js'
import { courseDisplay } from '../utils/courses.js'

/** The event types that are a piece of work somebody has to hand in. */
const WORK = new Set(['assignment', 'deadline'])

/** Stops reminding. Both mean "not my problem any more", for different reasons. */
const DONE = new Set<AssignmentStatus>(['submitted', 'completed'])

/**
 * Two tellings of the same work have to land on the same row, and a title is written
 * by a human in a hurry: "Bridge Design Report", "bridge design report!!", "the
 * bridge-design report". Strip it to the words.
 */
function slug(title: string | null): string | null {
  if (!title) return null
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  return words.length > 0 ? words.join('-') : null
}

export class AssignmentService {
  /**
   * Records what an announcement said about a piece of work.
   *
   * Called for every extraction; returns null for anything that is not work, so the
   * caller does not have to know which event types count.
   */
  async recordFrom(extraction: Extraction): Promise<Assignment | null> {
    if (!WORK.has(extraction.eventType) || !extraction.courseKey) return null

    // Title first, because a title survives the deadline moving — which is the whole
    // point of this entity: a student who marked something submitted must not lose
    // that when the lecturer pushes the date back. Only when nothing is named does
    // the date stand in, and a move then does create a second row. That is the honest
    // failure: with no name and a different day, nothing says it is the same work.
    const assignmentId = this.identify(extraction)
    if (!assignmentId) return null

    const now = new Date()
    const assignment: Assignment = {
      assignmentId,
      chatJid: extraction.chatJid,
      course: extraction.course,
      courseKey: extraction.courseKey,
      title: extraction.title,
      dueDate: extraction.date,
      dueTime: extraction.time,
      cancelled: false,
      eventIds: [extraction.eventId],
      firstSeenAt: now,
      updatedAt: now,
    }

    await assignmentRepository.record(assignment)
    logger.debug({ assignmentId, dueDate: extraction.date }, 'assignment recorded')
    return assignment
  }

  /** A cancellation stops the reminders without erasing that it existed. */
  async cancelFrom(extraction: Extraction): Promise<void> {
    const assignmentId = this.identify(extraction)
    if (assignmentId) await assignmentRepository.cancel(assignmentId)
  }

  async setStatus(
    phone: string,
    assignmentId: string,
    status: AssignmentStatus,
    by: 'student' | 'peermate' = 'student',
  ): Promise<void> {
    const at = new Date()
    await assignmentStateRepository.set({
      phone,
      assignmentId,
      status,
      history: [{ status, at, by }],
      updatedAt: at,
    })
    logger.info({ phone, assignmentId, status }, 'assignment status set')
  }

  /** Puts a completed piece of work back in play. */
  async reopen(phone: string, assignmentId: string): Promise<void> {
    await this.setStatus(phone, assignmentId, 'in_progress')
  }

  /** Has this student finished with it? Used to stop reminding them about it. */
  async isDone(phone: string, assignmentId: string): Promise<boolean> {
    const state = await assignmentStateRepository.find(phone, assignmentId)
    return state ? DONE.has(state.status) : false
  }

  /** The same question asked from an announcement, so callers never build an id. */
  async isDoneFrom(phone: string, extraction: Extraction): Promise<boolean> {
    const assignmentId = this.identify(extraction)
    return assignmentId ? this.isDone(phone, assignmentId) : false
  }

  /** null when the work cannot be identified — unnamed and undated. */
  identify(extraction: Extraction): string | null {
    if (!extraction.courseKey) return null
    const naming = slug(extraction.title) ?? extraction.date
    return naming ? `${extraction.chatJid}|${extraction.courseKey}|${naming}` : null
  }

  /**
   * What is left, for this student, in the groups they belong to.
   *
   * Anything they have submitted or completed is filtered out here rather than by
   * the caller, so "what's left?" and the deadline sweep agree on what "left" means.
   */
  async outstanding(user: User): Promise<Array<Assignment & { status: AssignmentStatus }>> {
    const open = await assignmentRepository.open(user.courseKeys, user.groupJids)
    if (open.length === 0) return []

    const states = await assignmentStateRepository.forStudent(
      user.phone,
      open.map((item) => item.assignmentId),
    )
    const byId = new Map(states.map((state) => [state.assignmentId, state.status]))

    return open
      .map((item) => ({ ...item, status: byId.get(item.assignmentId) ?? 'pending' }))
      .filter((item) => !DONE.has(item.status))
  }

  /**
   * Everything for a course, finished or not.
   *
   * `outstanding` deliberately hides completed work, which makes it the wrong lookup
   * for putting something back: the reply that says "tell me if it isn't done after
   * all" was pointing at a list the item had just dropped off.
   */
  async forCourse(
    user: User,
    courseKey: string,
  ): Promise<Array<Assignment & { status: AssignmentStatus }>> {
    const all = await assignmentRepository.open(user.courseKeys, user.groupJids)
    const mine = all.filter((item) => item.courseKey === courseKey)
    if (mine.length === 0) return []

    const states = await assignmentStateRepository.forStudent(
      user.phone,
      mine.map((item) => item.assignmentId),
    )
    const byId = new Map(states.map((state) => [state.assignmentId, state.status]))
    return mine.map((item) => ({ ...item, status: byId.get(item.assignmentId) ?? 'pending' }))
  }

  /** A line a student can read: what it is, when it is due, where it stands. */
  describe(item: Assignment & { status: AssignmentStatus }): string {
    const course = courseDisplay(item.courseKey) ?? item.courseKey
    const name = item.title ? ` — ${item.title}` : ''
    const when = item.dueDate ? ` · due ${item.dueDate}` : ''
    const state = item.status === 'in_progress' ? ' · _started_' : ''
    return `• *${course}*${name}${when}${state}`
  }
}

export const assignmentService = new AssignmentService()
