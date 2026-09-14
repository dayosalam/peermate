import { z } from 'zod'

/**
 * What a student has done about a piece of work.
 *
 * `submitted` means handed in. `completed` means they consider it done — a take-home
 * with no submission step, or reading that was set rather than collected. Both stop
 * reminders; keeping them apart is what lets "what have I actually turned in?" be
 * answerable.
 */
export const AssignmentStatus = z.enum(['pending', 'in_progress', 'submitted', 'completed'])
export type AssignmentStatus = z.infer<typeof AssignmentStatus>

/**
 * A piece of work, as the class knows it.
 *
 * Deliberately not an extraction. `extractions` is an append-only ledger of things
 * people *said*, and a correction there creates a new row with a new `eventId` — so
 * a student's "submitted" hung off an event id would be orphaned the moment the
 * lecturer moved the deadline. This is the thing itself, and corrections update it.
 */
export const AssignmentSchema = z.object({
  /** Derived from the group, course and title, so a correction resolves to the same row. */
  assignmentId: z.string(),
  chatJid: z.string(),
  course: z.string().nullable(),
  courseKey: z.string(),
  title: z.string().nullable(),
  dueDate: z.string().nullable(),
  dueTime: z.string().nullable(),
  /** Cancelled work stops reminding, but its history is kept. */
  cancelled: z.boolean().default(false),
  /** Every extraction that has spoken about this, oldest first. */
  eventIds: z.array(z.string()).default([]),
  firstSeenAt: z.date(),
  updatedAt: z.date(),
})
export type Assignment = z.infer<typeof AssignmentSchema>

export const StatusChangeSchema = z.object({
  status: AssignmentStatus,
  at: z.date(),
  /** 'student' when they said so, 'peermate' when a reminder asked and they answered. */
  by: z.enum(['student', 'peermate']).default('student'),
})
export type StatusChange = z.infer<typeof StatusChangeSchema>

/**
 * One student's relationship to one assignment.
 *
 * Per-student because a group assignment is one piece of work and several separate
 * obligations: one member submitting does not mean the rest are done.
 */
export const AssignmentStateSchema = z.object({
  phone: z.string(),
  assignmentId: z.string(),
  status: AssignmentStatus.default('pending'),
  /** Every change, so "undo" and "when did I mark this?" both have an answer. */
  history: z.array(StatusChangeSchema).default([]),
  updatedAt: z.date(),
})
export type AssignmentState = z.infer<typeof AssignmentStateSchema>
