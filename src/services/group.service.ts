import { config } from '../config.js'
import { logger } from '../core/logger.js'
import type { Authority, Group, User } from '../models/index.js'
import { groupRepository, pendingRepository, userRepository } from '../repositories/index.js'
import { courseDisplay, courseKey, parseCourseList } from '../utils/courses.js'
import { jidToIdentity, jidToPhone, samePhone } from '../whatsapp/jid.js'
import { conversationService } from './conversation.service.js'
import { notifierService } from './notifier.service.js'

export interface GroupContext {
  subject: string | null
  addedBy?: string | null
  addedByName?: string | null
  participantCount?: number | null
}

/**
 * Being added to a group is not permission to read it.
 *
 * Anybody can add this number to any group — a private chat, a hostel group, a
 * family thread — and until tonight Peermate would transcribe, embed and store
 * everything said there. A group now ingests nothing until the operator approves
 * it, which is what PRD §7 always claimed was true.
 */
export class GroupService {
  /** Records the group as pending and asks the operator about it. Never ingests. */
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

      if (Object.keys(patch).length === 0) return existing
      const updated = { ...existing, ...patch }
      await groupRepository.upsert(updated)
      return updated
    }

    const guess = this.courseFromSubject(context.subject)
    const group: Group = {
      chatJid,
      name: context.subject,
      defaultCourse: guess,
      defaultCourseKey: courseKey(guess),
      status: 'pending',
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
      approvedAt: null,
    }
    await groupRepository.upsert(group)
    logger.info({ chatJid, subject: context.subject, guess }, 'group pending approval')

    // Whoever added Peermate decides, and nobody else is told. Peermate has a
    // relationship with each student, not a moderator sitting above all of them: one
    // student's group is their own business, and a notice about a stranger's cohort is
    // something the reader can neither judge nor act on.
    //
    // They can only be asked if they have written to Peermate before, since it never
    // opens a conversation with someone who has not. Otherwise the group simply waits:
    // `membershipService.claimable` offers it to anyone in it who does.
    if (!(await this.askAdder(group))) {
      logger.info({ chatJid, addedBy: group.addedBy }, 'nobody to ask yet — group waits')
    }
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

    const dropped = await userRepository.dropGroupForAll(chatJid)
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

    const dropped = await userRepository.dropGroupFor(phones, participantJids, chatJid)
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
  async propose(
    chatJid: string,
    course: string,
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

  /** "CSC 301 — 2025/26 Class" -> "CSC 301". Null when the name carries no code. */
  private courseFromSubject(subject: string | null): string | null {
    if (!subject) return null
    const [first] = parseCourseList(subject)
    return first ? (courseDisplay(first) ?? null) : null
  }

  /**
   * Peermate never messages a student who has not written first. The operator is the
   * one exception: they configured the bot, and this is the only way to ask.
   */

  /**
   * Asks whoever added Peermate what the group is for.
   *
   * Returns false when there is nobody to ask: no adder was recorded, or the adder has
   * never written to Peermate. It does not open a conversation with a stranger — the
   * operator is the only person it may message unprompted — so that case falls back.
   *
   * When the name suggests a course the question is a yes/no with the guess in it, and
   * the answer is held as a pending proposal. When it does not, the question is open
   * and the agent reads the reply like any other message.
   */
  private async askAdder(group: Group): Promise<boolean> {
    if (!group.addedBy) return false

    const identity = jidToIdentity(group.addedBy)
    const adder = identity ? await userRepository.findByPhone(identity) : null
    if (!adder || adder.onboardingState !== 'registered' || !adder.jid) return false

    const where = group.name ?? 'that group'

    if (group.defaultCourse) {
      await conversationService.proposeGroup(adder.phone, {
        chatJid: group.chatJid,
        groupName: group.name,
        course: group.defaultCourse,
      })
      await notifierService.sendText(
        adder.jid,
        `📎 You added me to *${where}*.

Looks like *${group.defaultCourse}* from the name. Send *yes* and I'll start listening, or send the right code.

I'm reading *nothing* in there until you say.`,
      )
    } else {
      await notifierService.sendText(
        adder.jid,
        `📎 You added me to *${where}*.

Which course is it for? Send the code, like *CVE 575*.

I'm reading *nothing* in there until you tell me.`,
      )
    }

    logger.info({ chatJid: group.chatJid, phone: adder.phone }, 'asked the adder about a group')
    return true
  }
}

export const groupService = new GroupService()
