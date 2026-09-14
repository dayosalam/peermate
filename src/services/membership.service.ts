import { logger } from '../core/logger.js'
import type { Group, User } from '../models/index.js'
import { groupRepository, userRepository } from '../repositories/index.js'
import { getSocket } from '../whatsapp/socket.js'
import { jidToPhone } from '../whatsapp/jid.js'

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

  /** true: proved. false: proved not to. null: could not be checked. */
  private async belongs(user: User, group: Group): Promise<boolean | null> {
    if (this.isSamePerson(user, group.addedBy)) return true

    try {
      const metadata = await getSocket().groupMetadata(group.chatJid)
      return metadata.participants.some((participant) => this.isSamePerson(user, participant.id))
    } catch (error) {
      logger.warn(
        { err: error, chatJid: group.chatJid, phone: user.phone },
        'could not read group membership',
      )
      return null
    }
  }

  /**
   * One person reaches WhatsApp two ways — by phone number and by LID — and a
   * participant list may use either. Comparing only one spelling fails silently,
   * which here means refusing a student their own cohort.
   */
  private isSamePerson(user: User, jid: string | null | undefined): boolean {
    if (!jid) return false
    if (jid === user.jid) return true

    const theirs = jidToPhone(jid)
    return Boolean(theirs && theirs === user.phone)
  }
}

export const membershipService = new MembershipService()
