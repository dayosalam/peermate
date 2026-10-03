import { z } from 'zod'

export const OnboardingState = z.enum([
  'awaiting_name',
  'awaiting_timetable',
  'awaiting_timetable_confirmation',
  'awaiting_reminder',
  'awaiting_courses',
  'awaiting_digest',
  'registered',
])
export type OnboardingState = z.infer<typeof OnboardingState>

export const DigestFormat = z.enum(['text', 'voice'])
export type DigestFormat = z.infer<typeof DigestFormat>

export const GroupPreferenceSchema = z.object({
  chatJid: z.string(),
  mode: z.enum(['all', 'deadlines', 'paused']),
})

export const UserSchema = z.object({
  phone: z.string(),
  jid: z.string(),
  /**
   * Their LID, once it is known.
   *
   * WhatsApp addresses the same person two ways, and a group's participant list often
   * uses only the LID. Holding one spelling and comparing it against the other is how
   * a student is refused their own group: the mismatch is mechanical, and reads
   * exactly like proof they are not a member. Learned from a participant list that
   * gives both, so the mapping is recorded once rather than re-derived and failed at
   * every call site.
   */
  lid: z.string().nullable().optional(),
  /** WhatsApp's pushName — whatever their profile says. */
  name: z.string().nullable(),
  /** What they asked to be called. Used in every message Peermate sends them. */
  displayName: z.string().nullable(),
  courseKeys: z.array(z.string()).default([]),
  /**
   * The groups this student is subscribed to, and the tenancy boundary for
   * everything they can reach. `courseKeys` narrows *within* these; it can never
   * widen past them. Course codes are a local invention — two universities both
   * run a CSC 301 — so matching on the code alone puts one school's announcements
   * in another school's DMs.
   */
  groupJids: z.array(z.string()).default([]),
  /** Groups the student was once verified in. Existing history remains recoverable. */
  historicalGroupJids: z.array(z.string()).optional(),
  /** Per-group proactive behaviour; retrieval remains available until explicitly forgotten. */
  groupPreferences: z.array(GroupPreferenceSchema).optional(),
  /** Shared-group connection notices already delivered privately to this student. */
  notifiedGroupJids: z.array(z.string()).optional(),
  /**
   * The bot number this student talks to.
   *
   * A DM belongs to a number, not to Peermate in the abstract: a student who wrote
   * to shard A has no conversation with shard B, and B messaging them anyway would
   * break the rule that Peermate never writes to somebody who has not written first.
   * So every outbound message for this student leaves through this shard, and they
   * can only join groups this shard is in.
   */
  shardId: z.string().default('default'),
  onboardingState: OnboardingState,
  registeredAt: z.date().nullable(),
  lastDigestAt: z.date().nullable(),

  /** Voice notes carry the digest well; everything else stays text — see PRD §8. */
  digestFormat: DigestFormat.default('text'),
  /** Hour of the day, in the digest timezone. */
  digestHour: z.number().min(0).max(23).default(7),
  /**
   * Instant alerts are suppressed inside this window. Nothing is lost: the digest
   * covers everything since it last ran, so a held announcement simply arrives in
   * the morning instead of at 2am.
   */
  quietFrom: z.number().min(0).max(23).nullable().default(22),
  quietTo: z.number().min(0).max(23).nullable().default(6),

  /**
   * A pause a student asked for. Nothing is discarded while it holds — the digest
   * covers the window, so a pause defers rather than deletes.
   */
  pausedUntil: z.date().nullable().default(null),
  /** Paused with no end named. Only "resume" lifts this one. */
  paused: z.boolean().default(false),
  /** "Stop the morning messages" — the digest alone, instant alerts untouched. */
  digestPaused: z.boolean().default(false),
  /** "Only tell me about urgent things": tests, deadlines and venue changes. */
  alertLevel: z.enum(['all', 'urgent']).default('all'),
  /** Courses they still want in the digest but no longer want pinged about. */
  mutedCourseKeys: z.array(z.string()).default([]),
  /**
   * Whether dates Peermate learns should become personal reminders automatically.
   * The information is always retained; this controls only proactive delivery.
   */
  automaticReminders: z.boolean().optional(),
  /** Personal warning time for timetable classes; exams keep their longer warnings. */
  classReminderMinutes: z
    .number()
    .int()
    .min(5)
    .max(24 * 60)
    .optional(),
})
export type User = z.infer<typeof UserSchema>
