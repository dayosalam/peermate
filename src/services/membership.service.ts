import { logger } from '../core/logger.js'
import type { Group, User } from '../models/index.js'
import { groupRepository, userRepository } from '../repositories/index.js'
import { getSocket } from '../whatsapp/socket.js'
import { jidToPhone, LID_SUFFIX } from '../whatsapp/jid.js'
import type { GroupParticipant } from '@whiskeysockets/baileys'

export interface Membership {
  /** Groups the student was proved to belong to. */
  joined: string[]
  /** Courses they named that no group they belong to carries. */
  uncovered: string[]
  /** Groups that carry one of their courses but could not be verified right now. */
  unverified: string[]
}

/**
 * Which groups a student is actually in.
 *
 * Course codes are self-reported, and a self-reported code is a claim about a
 * timetable, not about a room. The group is the tenancy boundary, so joining one has
 * to be proved rather than asserted: otherwise anybody who guesses "CVE 575" reads a
 * cohort they have never met.
 *
 * Two things count as proof, in order:
 *
 *  - **They added Peermate.** Adding the number to a group requires already being in
 *    it, so the act is the evidence. This is also who vouches for everyone after them.
 *  - **They are in the participant list.** Checked against the group Peermate is
 *    already reading, for somebody who has already messaged it. This is not the
 *    harvesting PRD §7 forbids — nobody is discovered this way and nobody is messaged
 *    because of it; a person who came to Peermate is being matched to a room.
 *
 * A group that cannot be checked is left unverified rather than granted. A socket
 * hiccup must not be the thing that decides who reads a cohort's announcements.
 */
export class MembershipService {
  async resolve(user: User): Promise<Membership> {
    // Only groups this student's own number is in.
    //
    // A DM belongs to a number. Somebody who wrote to shard A has no conversation
    // with shard B, so B could never deliver an alert about a group only B can see —
    // and writing to them anyway is precisely what PRD §7 forbids. Rather than let a
    // student subscribe to something that can never reach them, the boundary is drawn
    // here, and `uncovered` tells them which courses are not served by this number.
    const groups = (await groupRepository.approved()).filter(
      (group) => group.shardId === user.shardId,
    )

    const joined = new Set<string>()
    const unverified = new Set<string>()
    const covered = new Set<string>()

    for (const group of groups) {
      const carries = group.defaultCourseKey
      // A departmental group carries no course of its own, so no course points at it.
      // Membership is the whole of its claim, which is exactly what is checked here.
      const relevant = carries ? user.courseKeys.includes(carries) : true
      if (!relevant) continue

      const belongs = await this.belongs(user, group)
      if (belongs === true) {
        joined.add(group.chatJid)
        if (carries) covered.add(carries)
      } else if (belongs === null) {
        unverified.add(group.chatJid)
      }
    }

    return {
      joined: [...joined],
      uncovered: user.courseKeys.filter((key) => !covered.has(key)),
      unverified: [...unverified],
    }
  }

  /** Applies the resolution, so the student's record matches what was proved. */
  async subscribe(user: User): Promise<Membership> {
    const membership = await this.resolve(user)
    for (const chatJid of membership.joined) {
      await userRepository.addGroup(user.phone, chatJid)
    }

    logger.info(
      {
        phone: user.phone,
        joined: membership.joined.length,
        uncovered: membership.uncovered,
        unverified: membership.unverified.length,
      },
      'membership resolved',
    )
    return membership
  }

  /**
   * Groups waiting to be switched on that this student is provably in.
   *
   * A group can be added by somebody who never writes to Peermate, and it will not
   * message a stranger to ask what the room is. So the question waits for anybody who
   * turns out to be in it — which keeps a whole class from being stranded because one
   * person added the bot and never came back.
   */
  async claimable(user: User): Promise<Group[]> {
    const waiting = (await groupRepository.pending()).filter(
      (group) => group.shardId === user.shardId,
    )

    const mine: Group[] = []
    for (const group of waiting) {
      if ((await this.belongs(user, group)) === true) mine.push(group)
    }
    return mine
  }

  /**
   * Pending groups on this student's shard that they could *not* be proved into.
   *
   * The pool a half-remembered name is matched against. Nothing here is disclosed:
   * a group is only ever named back to a student who named it closely first, which
   * is what keeps this from becoming a directory of other people's cohorts.
   */
  async unplaced(user: User): Promise<Group[]> {
    const waiting = (await groupRepository.pending()).filter(
      (group) => group.shardId === user.shardId,
    )

    const stuck: Group[] = []
    for (const group of waiting) {
      if ((await this.belongs(user, group)) !== true) stuck.push(group)
    }
    return stuck
  }

  /**
   * Whether this student may act on a group: correct its course, say who the lecturer
   * is, stop it being read.
   *
   * Authority over a room is being in it, and nothing else — there is no operator
   * standing above everyone any more. Proof is the same proof retrieval uses, so a
   * student can change exactly the groups they can already read from.
   *
   * A check that cannot complete refuses. A dropped socket must not be the thing that
   * grants somebody power over a cohort's announcements.
   */
  async mayAdminister(user: User, group: Group): Promise<boolean> {
    return (await this.belongs(user, group)) === true
  }

  /** true: proved. false: proved not to. null: could not be checked. */
  private async belongs(user: User, group: Group): Promise<boolean | null> {
    if (this.isSamePerson(user, group.addedBy)) return true

    let metadata
    try {
      metadata = await getSocket().groupMetadata(group.chatJid)
    } catch (error) {
      logger.warn(
        { err: error, chatJid: group.chatJid, phone: user.phone },
        'could not read group membership',
      )
      return null
    }

    let comparable = false
    for (const participant of metadata.participants) {
      // Every spelling WhatsApp offers. It hands us the phone number in its own field
      // and we used to read only `id`, which in a LID-addressed group is a LID — so a
      // real member matched nothing.
      const spellings = [participant.id, participant.lid, participant.phoneNumber]
      if (spellings.some((spelling) => this.isSamePerson(user, spelling))) {
        await this.learnLid(user, participant)
        return true
      }
      if (spellings.some((spelling) => this.knowsNamespace(user, spelling))) comparable = true
    }

    // Absent from a list we could actually read against, or a list written entirely in
    // a namespace we hold no address in? The first is proof; the second is ignorance,
    // and returning `false` for it refuses a student their own group forever with
    // nothing logged. Only the first is an answer.
    // Shapes, not values: enough to tell a LID-addressed group from a missing phone
    // number without writing anybody's number into the logs. This is the one place
    // that can answer why a student was refused their own group, and guessing at it
    // from a screenshot is what cost the last round.
    const shape = {
      chatJid: group.chatJid,
      addressing: metadata.addressingMode ?? 'unset',
      participants: metadata.participants.length,
      idsAreLids: metadata.participants.filter((one) => one.id.endsWith(LID_SUFFIX)).length,
      withPhoneNumber: metadata.participants.filter((one) => one.phoneNumber).length,
      withLid: metadata.participants.filter((one) => one.lid).length,
      studentJidIsLid: user.jid.endsWith(LID_SUFFIX),
      studentLidKnown: Boolean(user.lid),
      addedByIsLid: group.addedBy?.endsWith(LID_SUFFIX) ?? null,
    }

    if (comparable) {
      logger.info(shape, 'student is not in this group')
      return false
    }
    logger.warn(shape, 'no comparable identity in the participant list — left unverified')
    return null
  }

  /**
   * Records the LID for a student once a participant list gives both spellings.
   *
   * The list is the only place the two namespaces appear side by side, so this is
   * where the mapping can be learned. Best-effort: failing to store it costs another
   * lookup, never an answer.
   */
  private async learnLid(user: User, participant: GroupParticipant): Promise<void> {
    const lid = participant.lid ?? (participant.id.endsWith(LID_SUFFIX) ? participant.id : null)
    if (!lid || user.lid === lid) return
    try {
      await userRepository.upsert({ ...user, lid })
    } catch (error) {
      logger.warn({ err: error, phone: user.phone }, 'could not store lid')
    }
  }

  /** Whether this spelling is in a namespace we hold an address for at all. */
  private knowsNamespace(user: User, jid: string | null | undefined): boolean {
    if (!jid) return false
    return jid.endsWith(LID_SUFFIX) ? Boolean(user.lid) || user.jid.endsWith(LID_SUFFIX) : true
  }

  /**
   * One person reaches WhatsApp two ways — by phone number and by LID — and a
   * participant list may use either. Comparing only one spelling fails silently,
   * which here means refusing a student their own cohort.
   */
  private isSamePerson(user: User, jid: string | null | undefined): boolean {
    if (!jid) return false
    if (jid === user.jid || (user.lid && jid === user.lid)) return true

    const theirs = jidToPhone(jid)
    return Boolean(theirs && theirs === user.phone)
  }
}

export const membershipService = new MembershipService()
