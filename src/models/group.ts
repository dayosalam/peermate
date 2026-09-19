import { z } from 'zod'

/**
 * Joining activates a group after a one-time disclosure. Retrieval is separately
 * membership-scoped, so active ingestion is not public access.
 *
 * `revoked` is the end of the relationship: Peermate was removed, or the group was
 * deleted. Ingest stops and everything already stored becomes unreachable to every
 * student, but nothing is deleted — a citation that has already been sent must still
 * resolve to the message it named.
 */
export const GroupStatus = z.enum(['pending', 'approved', 'ignored', 'revoked'])
export type GroupStatus = z.infer<typeof GroupStatus>

/**
 * How much weight a sender's word carries.
 *
 * A lecturer stating a date settles it. A class rep relaying one is close behind.
 * A classmate is corroboration — worth recording, not worth a second alert saying
 * the same thing.
 */
export const Authority = z.enum(['lecturer', 'rep', 'student'])
export type Authority = z.infer<typeof Authority>

export const TrustedSenderSchema = z.object({
  /** Matched on pushName, since group participants now arrive as opaque LIDs. */
  name: z.string(),
  jid: z.string().nullable().default(null),
  role: Authority,
})
export type TrustedSender = z.infer<typeof TrustedSenderSchema>

export const GroupSchema = z.object({
  chatJid: z.string(),
  name: z.string().nullable(),
  defaultCourse: z.string().nullable(),
  defaultCourseKey: z.string().nullable(),
  status: GroupStatus.default('pending'),
  /**
   * The bot number that is in this group. Only that shard holds a socket which can
   * see it, so only that shard ingests it.
   */
  shardId: z.string().default('default'),
  /**
   * Who added Peermate, so the operator knows whose request they are answering —
   * and, once approved, who vouches for the classmates that subscribe after them.
   *
   * Populated from the `group-participants.update` that added the bot. Baileys only
   * reports that event while the socket is connected, so a group Peermate was
   * already in when the process started has no adder to record; `group.owner` is
   * the group's *creator*, which is a different person, and is deliberately not
   * used as a substitute.
   */
  addedBy: z.string().nullable().default(null),
  addedByName: z.string().nullable().default(null),
  participantCount: z.number().nullable().default(null),
  trustedSenders: z.array(TrustedSenderSchema).default([]),
  /**
   * What a student said this group is for.
   *
   * The person who adds Peermate knows the group; the operator decides. Recording
   * the proposal means that knowledge is not lost between the two.
   */
  proposedCourse: z.string().nullable().default(null),
  proposedBy: z.string().nullable().default(null),
  /**
   * The student who switched this group on, as an address rather than a name.
   *
   * `proposedBy` is what to call them; this is how to reach them. Peermate asks them
   * when it hears something in here it cannot file, and nobody else is asked — nobody
   * else was in the room. Null for a group approved before this existed.
   */
  approvedBy: z.string().nullable().default(null),
  joinedAt: z.date(),
  approvedAt: z.date().nullable().default(null),
  /** Legacy combined marker; retained so deployed rows do not receive a second notice. */
  disclosedAt: z.date().nullable().optional(),
  /** Claimed independently so a failed private confirmation never repeats the room notice. */
  groupDisclosedAt: z.date().nullable().optional(),
  adderNotifiedAt: z.date().nullable().optional(),
})
export type Group = z.infer<typeof GroupSchema>
