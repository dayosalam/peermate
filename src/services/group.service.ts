import { config } from '../config.js'
import { logger } from '../core/logger.js'
import type { Authority, Group, User } from '../models/index.js'
import { groupRepository, pendingRepository, userRepository } from '../repositories/index.js'
import { courseKey } from '../utils/courses.js'
import { jidToIdentity, jidToPhone, samePhone } from '../whatsapp/jid.js'
import { notifierService } from './notifier.service.js'

export interface GroupContext {
  subject: string | null
  addedBy?: string | null
  addedByName?: string | null
  participantCount?: number | null
}

/**
 * A group is a source, not a registration gate. Joining activates learning from that
 * point onward and Peermate confirms privately with a known user. Access to what it learns
 * is still membership-scoped: being able to name a group never grants its archive.
 */
export class GroupService {
  /** Records and activates a group, then privately confirms the connection when possible. */
  async register(chatJid: string, context: GroupContext): Promise<Group> {
    const existing = await groupRepository.findByJid(chatJid)
    if (existing) {
      const patch: Partial<Group> = {}
      // A rename can reveal the course after the fact; the decision still stands.
      if (context.subject && context.subject !== existing.name) patch.name = context.subject
      // groups.upsert and group-participants.update both fire on a join and the order
      // is not guaranteed, so the adder usually arrives after the group is already on
      // record. Filled in once and never overwritten — whoever added Peermate is who
      // vouches for the students that subscribe later.
      if (context.addedBy && !existing.addedBy) {
        patch.addedBy = context.addedBy
        patch.addedByName = context.addedByName ?? null
      }
      // The socket that can see the group is the authority on which number is in it.
      // A group whose recorded shard has gone stale is ingested by this process and
      // served by nobody, because its students are looked up on the other shard.
      if (existing.shardId !== config.whatsapp.shardId) {
        patch.shardId = config.whatsapp.shardId
      }

      if (existing.status === 'pending') {
        patch.status = 'approved'
        patch.approvedAt = new Date()
      }
      if (Object.keys(patch).length === 0) return existing
      const updated = { ...existing, ...patch }
      await groupRepository.upsert(updated)
      if (existing.status === 'pending') await this.notifyConnected(updated)
      return updated
    }

    const group: Group = {
      chatJid,
      name: context.subject,
      // A room name is identity, not reliable course metadata. Content extraction and
      // the user's conversation with the agent can classify it later.
      defaultCourse: null,
      defaultCourseKey: null,
      purpose: null,
      status: 'approved',
      // The socket that saw this group is the only one that can read it.
      shardId: config.whatsapp.shardId,
      addedBy: context.addedBy ?? null,
      addedByName: context.addedByName ?? null,
      participantCount: context.participantCount ?? null,
      trustedSenders: [],
      proposedCourse: null,
      proposedBy: null,
      approvedBy: null,
      joinedAt: new Date(),
      approvedAt: new Date(),
    }
    await groupRepository.upsert(group)
    logger.info({ chatJid, subject: context.subject }, 'group connected')
    await this.notifyConnected(group)
    return group
  }

  async approve(chatJid: string, course: string | null): Promise<Group | null> {
    const group = await groupRepository.findByJid(chatJid)
    if (!group) return null
    const updated: Group = {
      ...group,
      status: 'approved',
      defaultCourse: course,
      defaultCourseKey: courseKey(course),
      approvedAt: new Date(),
    }
    await groupRepository.upsert(updated)
    logger.info({ chatJid, course }, 'group approved')
    return updated
  }

  /**
   * Peermate is no longer in this group.
   *
   * Everything stored stays stored — a citation already sent has to keep resolving to
   * the message it named — but the group stops being a source for anybody. Ingest
   * stops because `approved` is what lets a message through, and every read is scoped
   * to the groups on a student's record, which this clears.
   */
  async revoke(chatJid: string): Promise<number> {
    const group = await groupRepository.findByJid(chatJid)
    if (group && group.status !== 'revoked') {
      await groupRepository.upsert({ ...group, status: 'revoked' })
    }

    const dropped = await userRepository.archiveGroupForAll(chatJid)
    logger.info({ chatJid, students: dropped }, 'group revoked')
    return dropped
  }

  /**
   * Some of the people in a group are not in it any more.
   *
   * Applies on their next request rather than on a timer: `groupJids` is read from
   * the user document every time, never cached, so a student removed from a group
   * mid-conversation stops seeing it in the same exchange.
   */
  async removeMembers(chatJid: string, participantJids: string[]): Promise<number> {
    const phones = participantJids
      .map(jidToPhone)
      .filter((phone): phone is string => Boolean(phone))

    const dropped = await userRepository.archiveGroupFor(phones, participantJids, chatJid)
    if (dropped > 0) logger.info({ chatJid, students: dropped }, 'students left a group')
    return dropped
  }

  async ignore(chatJid: string): Promise<Group | null> {
    const group = await groupRepository.findByJid(chatJid)
    if (!group) return null
    const updated: Group = { ...group, status: 'ignored' }
    await groupRepository.upsert(updated)

    // Nothing from it was stored, so there is nothing to clean up but the questions.
    for (const decision of await pendingRepository.openForGroup(chatJid)) {
      await pendingRepository.resolve(decision.eventId, null)
    }
    logger.info({ chatJid }, 'group ignored — staying silent')
    return updated
  }

  /**
   * Records whose word settles a question in this group.
   *
   * Without it every sender is equal, so a lecturer's correction and a classmate's
   * half-remembered version arrive as two separate alerts of the same weight.
   */
  async trust(chatJid: string, name: string, role: Authority): Promise<Group | null> {
    const group = await groupRepository.findByJid(chatJid)
    if (!group) return null

    const others = group.trustedSenders.filter(
      (sender) => sender.name.toLowerCase() !== name.toLowerCase(),
    )
    const updated: Group = {
      ...group,
      trustedSenders: [...others, { name, jid: null, role }],
    }
    await groupRepository.upsert(updated)
    logger.info({ chatJid, name, role }, 'trusted sender recorded')
    return updated
  }

  /**
   * Files the course a student says a group is for.
   *
   * The adder's word settles it; anybody else's is a proposal for the operator. The
   * check is on the stored `addedBy` rather than on anything the caller passed, so a
   * student who names someone else's group cannot switch it on by saying they added
   * it — the same reason every tool resolves its student from the session.
   */
  /**
   * Records a student as the one who added Peermate, when nobody is on record.
   *
   * Their word, not proof — used only where proof is impossible: WhatsApp gave no
   * comparable identity, or Peermate was added while it was offline. The safeguard is
   * upstream, in what it took to get here: they named the group closely enough to be
   * recognised, and Peermate named it back before they confirmed.
   *
   * Never overwrites an existing adder. A group with somebody on record is already
   * answerable, and letting a claim replace them is how one student takes another's
   * group.
   */
  async claim(chatJid: string, byIdentity: string, byName: string): Promise<boolean> {
    const group = await groupRepository.findByJid(chatJid)
    if (!group || group.addedBy) return false

    await groupRepository.upsert({ ...group, addedBy: byIdentity, addedByName: byName })
    logger.warn(
      { chatJid, byIdentity },
      'group claimed without proof — membership could not be verified',
    )
    return true
  }

  async propose(
    chatJid: string,
    course: string | null,
    by: string,
    byIdentity?: string | null,
  ): Promise<{ group: Group; approved: boolean } | null> {
    const group = await groupRepository.findByJid(chatJid)
    if (!group) return null

    if (group.addedBy && byIdentity && samePhone(byIdentity, group.addedBy)) {
      // Recorded because nobody is messaged about it, so this is the only account of
      // what happened — and because the address is who Peermate asks when it hears
      // something in here it cannot file.
      await groupRepository.upsert({
        ...group,
        proposedCourse: course,
        proposedBy: by,
        approvedBy: byIdentity,
      })
      const approved = await this.approve(chatJid, course)
      if (approved) {
        logger.info({ chatJid, course, by }, 'group approved by the person who added it')
        return { group: approved, approved: true }
      }
    }

    // Recorded, not relayed. Whoever added the group is the one who can switch it on,
    // and paging a third party about somebody else's cohort is a notice they can
    // neither judge nor act on. The operator can still see it with *pending*.
    await groupRepository.upsert({ ...group, proposedCourse: course, proposedBy: by })
    logger.info({ chatJid, course, by }, 'course proposed for group')
    return { group, approved: false }
  }

  async setCourse(chatJid: string, course: string | null): Promise<Group | null> {
    const group = await groupRepository.findByJid(chatJid)
    if (!group) return null
    const updated: Group = { ...group, defaultCourse: course, defaultCourseKey: courseKey(course) }
    await groupRepository.upsert(updated)
    logger.info({ chatJid, course }, 'group course set')
    return updated
  }

  async setPurpose(chatJid: string, purpose: string): Promise<Group | null> {
    const group = await groupRepository.findByJid(chatJid)
    if (!group) return null
    const updated: Group = { ...group, purpose }
    await groupRepository.upsert(updated)
    logger.info({ chatJid }, 'group purpose set')
    return updated
  }

  /**
   * Peermate never messages a student who has not written first. The operator is the
   * one exception: they configured the bot, and this is the only way to ask.
   */

  /** Records connection once and privately confirms only with a known Peermate user. */
  private async notifyConnected(group: Group): Promise<void> {
    // This marker now means the connection was recorded. Peermate never posts in the
    // room; every explanation and confirmation belongs in a user's private chat.
    await groupRepository.claimGroupDisclosure(group.chatJid)

    if (group.addedBy && (await groupRepository.claimAdderNotice(group.chatJid))) {
      try {
        const where = group.name ?? 'this group'
        const identity = jidToIdentity(group.addedBy)
        const adder = identity ? await userRepository.findByPhone(identity) : null
        if (!adder) {
          await groupRepository.releaseAdderNotice(group.chatJid)
          return
        }
        await userRepository.addGroup(adder.phone, group.chatJid)
        await notifierService.sendText(
          adder.jid,
          `📎 I'm connected to *${where}* and learning from new messages now. You can ask me privately about anything shared there; a course label is optional.`,
        )
        logger.info({ chatJid: group.chatJid, phone: adder.phone }, 'confirmed group connection')
      } catch (error) {
        await groupRepository.releaseAdderNotice(group.chatJid)
        throw error
      }
    }
  }

  async retryDisclosures(): Promise<number> {
    const groups = await groupRepository.undisclosed(config.whatsapp.shardId)
    let sent = 0
    for (const group of groups) {
      try {
        await this.notifyConnected(group)
        sent += 1
      } catch (error) {
        logger.warn({ err: error, chatJid: group.chatJid }, 'group disclosure retry failed')
      }
    }
    return sent
  }
}

export const groupService = new GroupService()
