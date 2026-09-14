import { config } from '../config.js'
import { logger } from '../core/logger.js'
import type { Authority, Group } from '../models/index.js'
import { groupRepository, pendingRepository, userRepository } from '../repositories/index.js'
import { courseDisplay, courseKey, parseCourseList } from '../utils/courses.js'
import { jidToPhone } from '../whatsapp/jid.js'
import { notifierService } from './notifier.service.js'
import { operatorJid } from './operator.js'

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
      joinedAt: new Date(),
      approvedAt: null,
    }
    await groupRepository.upsert(group)
    logger.info({ chatJid, subject: context.subject, guess }, 'group pending approval')

    await this.askOperator(group)
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
   * A student telling Peermate what a group is for.
   *
   * They cannot approve it — anybody can add the bot anywhere, so approval stays
   * with the operator. But they are the one who knows, and throwing that away means
   * the operator is guessing about a group they have never seen.
   */
  async propose(chatJid: string, course: string, by: string): Promise<Group | null> {
    const group = await groupRepository.findByJid(chatJid)
    if (!group) return null

    await groupRepository.upsert({ ...group, proposedCourse: course, proposedBy: by })
    logger.info({ chatJid, course, by }, 'course proposed for group')

    const operator = await operatorJid()
    if (operator) {
      await notifierService
        .sendText(
          operator,
          `💡 *${by}* says *${group.name ?? chatJid}* is the group for *${course}*.

It's still waiting on you. Reply *here* with *approve ${course}* to start reading it, or *ignore group*.

⚠️ Replying inside the group won't work — I don't read a group until it's approved.`,
        )
        .catch((error) => logger.error({ err: error }, 'could not relay proposal'))
    }
    return group
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
  private async askOperator(group: Group): Promise<void> {
    const operator = await operatorJid()
    if (!operator) {
      logger.warn(
        { chatJid: group.chatJid },
        'no ADMIN_PHONE set — this group can never be approved and will stay silent',
      )
      return
    }

    const who = group.addedByName ?? (group.addedBy ? jidToPhone(group.addedBy) : null)
    const facts = [
      `*Group:* ${group.name ?? 'unnamed'}`,
      who ? `*Added by:* ${who}` : null,
      group.participantCount ? `*Members:* ${group.participantCount}` : null,
      group.defaultCourse
        ? `*Looks like:* ${group.defaultCourse} (from the name)`
        : `*Course:* I can't tell from the name`,
    ]
      .filter(Boolean)
      .join('\n')

    const suggestion = group.defaultCourse
      ? `*approve ${group.defaultCourse}*`
      : '*approve CSC 301*'

    await notifierService.sendText(
      operator,
      `📎 I've been added to a group.

${facts}

I'm *not reading anything* from it yet. Reply *here, in this chat*:
• ${suggestion} — start listening, file it under that course
• *approve* — start listening, but I'll work out the course per message
• *ignore group* — stay silent in it

⚠️ Sending that inside the group won't work — I don't read a group until it's approved, and I never post in one.`,
    )
  }
}

export const groupService = new GroupService()
