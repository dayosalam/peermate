import { config } from '../config.js'

/**
 * Below this the hearing itself is in doubt, not just the interpretation. Distinct
 * from the 0.6 hedge, which still sends — this one does not.
 */
const TRIAGE_BELOW = 0.35
import { assignmentService } from './assignment.service.js'
import { logger } from '../core/logger.js'
import type { Extraction, Message, User } from '../models/index.js'
import {
  extractionRepository,
  groupRepository,
  messageRepository,
  notificationRepository,
  pendingRepository,
  userRepository,
} from '../repositories/index.js'
import { courseDisplay, courseKey } from '../utils/courses.js'
import { describeAuthority, outranks } from '../utils/authority.js'
import { formatStamp, formatTime12 } from '../utils/dates.js'
import { conversationService } from './conversation.service.js'
import { deliveryService } from './delivery.service.js'
import { notifierService } from './notifier.service.js'

/**
 * The instant DM. Every new announcement goes to every student subscribed to that
 * course, within the minute.
 *
 * PRD §8 ruled out dedupe and per-user toggles for the prototype; both are reversed
 * here. Repeats turned out to be the normal case rather than the exception — three
 * classmates mentioning one test produced three identical DMs, which read as a bug —
 * so a repeat now backs the first telling instead of becoming a second one, and
 * whether a student hears it at all is DeliveryService's decision.
 */
export class AnnouncementService {
  async notify(extractions: Extraction[], source: Message): Promise<void> {
    for (const extraction of extractions) {
      // An announcement with no course cannot be routed to anybody. Dropping it in
      // silence is the worst outcome: Peermate heard the thing, stored it, and told
      // nobody — and nobody knows to fix it. Ask the operator instead.
      // A department-wide notice has no course on purpose. Only a missing course on
      // something that *should* have one is an unanswered question for the operator.
      if (!extraction.courseKey && extraction.scope !== 'department') {
        await this.reportUnroutable(extraction, source)
        continue
      }

      // Heard too badly to repeat as fact.
      //
      // Below this the words themselves are in doubt, and an extraction is only ever
      // as good as its hearing: a wrong date asserted to forty students costs more
      // than one operator glancing at a transcript. Kept out of the alert path and
      // put in front of somebody who can play the recording.
      if (extraction.confidence < TRIAGE_BELOW && extraction.date) {
        await this.reportUnheard(extraction, source)
        continue
      }

      // A piece of work is tracked as a thing in its own right, not only as a row in
      // the say-what-was-said ledger, so a student's "submitted" survives the
      // deadline being corrected underneath it.
      if (extraction.eventType === 'cancelled') {
        await assignmentService.cancelFrom(extraction)
      } else {
        await assignmentService.recordFrom(extraction)
      }

      // Three classmates mentioning one test is one test. Whether that is worth a
      // second DM depends on who is speaking — see decide().
      const existing =
        extraction.scope === 'department'
          ? null
          : await extractionRepository.findSimilar(extraction)
      if (existing) {
        const verdict = this.decide(extraction, existing)
        await extractionRepository.addCorroboration(existing.eventId, extraction.sourceMessageId)
        // A fuller telling completes the first one: "test Friday" then "test Friday
        // 10am in LG7" is one test, now with a time and a venue.
        await extractionRepository.enrich(existing.eventId, extraction)

        if (verdict === 'backing') {
          logger.info(
            { courseKey: extraction.courseKey, by: extraction.authority },
            'same event already announced, recorded as corroboration',
          )
          continue
        }
        // 'confirmation': someone more authoritative has now said it, which is worth
        // knowing — the student heard it from a classmate and can now rely on it.
        await this.send(extraction, source, this.formatConfirmation(extraction, source))
        continue
      }

      // Not the same event told twice, but the same event *changed*: "the test moved
      // to LG8". findSimilar refuses to merge those — two venues are not one event —
      // so nothing marked the old one dead and both survived into digests and
      // reminders. Whose word it is decides whether this is a correction or a clash.
      const changed =
        extraction.scope === 'department'
          ? null
          : await extractionRepository.findChanged(extraction)
      if (changed && !outranks(changed.authority, extraction.authority)) {
        await extractionRepository.supersede(changed.eventId, extraction.eventId)
        logger.info(
          { courseKey: extraction.courseKey, replaced: changed.eventId },
          'announcement superseded by a correction',
        )
        await this.send(extraction, source, this.formatChange(extraction, changed, source))
        continue
      }

      await this.send(extraction, source, this.format(extraction, source))
    }
  }

  /**
   * Is a repeat worth a second message?
   *
   * Only when it raises the standing of what the student already knows. A lecturer
   * confirming what a classmate said changes whether they can act on it. A second
   * classmate saying the same thing changes nothing, and two identical DMs make
   * Peermate feel broken.
   */
  private decide(incoming: Extraction, existing: Extraction): 'backing' | 'confirmation' {
    return outranks(incoming.authority, existing.authority) ? 'confirmation' : 'backing'
  }

  private async send(extraction: Extraction, source: Message, body: string): Promise<void> {
    const students =
      extraction.scope === 'department'
        ? await userRepository.inGroup(extraction.chatJid, config.whatsapp.shardId)
        : await userRepository.subscribedTo(
            extraction.courseKey!,
            extraction.chatJid,
            config.whatsapp.shardId,
          )

    for (const student of students) {
      try {
        // Held, not dropped: the digest covers everything since it last ran, so an
        // announcement a student is not taking right now still reaches them.
        const sent = await deliveryService.send(student, body, {
          kind: 'announcement',
          courseKey: extraction.courseKey,
          eventType: extraction.eventType,
          eventId: extraction.eventId,
        })
        if (!sent) continue

        // So "where is it?" or "who said that?" a minute later has something to
        // refer to. Without this the student's obvious next question has no subject
        // and gets answered against the whole course instead.
        await conversationService.rememberEvent(student.phone, extraction)

        await notificationRepository.log({
          userPhone: student.phone,
          extractionId: extraction.eventId,
          notificationType: 'instant',
          status: 'sent',
          error: null,
          sentAt: new Date(),
        })
      } catch (error) {
        logger.error({ err: error, phone: student.phone }, 'instant alert failed')
        await notificationRepository.log({
          userPhone: student.phone,
          extractionId: extraction.eventId,
          notificationType: 'instant',
          status: 'failed',
          error: String(error),
          sentAt: new Date(),
        })
      }
    }

    if (students.length === 0) {
      // Extracted correctly and delivered to nobody. Without this it logs as a
      // success and the operator hunts a pipeline bug that does not exist.
      logger.warn(
        { courseKey: extraction.courseKey },
        'announcement extracted but no student is registered for this course',
      )
    } else {
      logger.info(
        { courseKey: extraction.courseKey, students: students.length, by: extraction.authority },
        'alerted',
      )
    }
  }

  /**
   * Says what changed, not just what is now true.
   *
   * "CVE 575 test — 2pm, LG8" is indistinguishable from a fresh announcement, and a
   * student who already wrote 10am in their notes has no reason to look twice. The
   * old value is what makes it read as a correction.
   */
  private formatChange(next: Extraction, previous: Extraction, source: Message): string {
    const course = courseDisplay(next.course ?? next.courseKey) ?? 'Your course'
    const event = next.eventType.replace('_', ' ')
    const role = describeAuthority(next.authority)
    const stamp = formatStamp(source.timestamp, config.digest.timezone)

    const was = [formatTime12(previous.time), previous.venue].filter(Boolean).join(', ')
    const now = [formatTime12(next.time), next.venue].filter(Boolean).join(', ')
    const when = next.originalDateText ?? next.date

    return `🔄 *${course} ${event} changed*${when ? ` — ${when}` : ''}

*Now:* ${now || 'see below'}
_Was: ${was || 'not stated'}_

_${source.senderName ?? 'unknown'}${role ? ` (${role})` : ''}, ${stamp}_`
  }

  /** Someone whose word carries more weight has now said the same thing. */
  private formatConfirmation(extraction: Extraction, source: Message): string {
    const course = courseDisplay(extraction.course ?? extraction.courseKey) ?? 'Your course'
    const event = extraction.eventType.replace('_', ' ')
    const role = describeAuthority(extraction.authority)
    const stamp = formatStamp(source.timestamp, config.digest.timezone)

    const when = [extraction.originalDateText ?? extraction.date, formatTime12(extraction.time)]
      .filter(Boolean)
      .join(' ')
    const where = extraction.venue ? `, ${extraction.venue}` : ''

    return `✅ *Confirmed — ${course} ${event}*${when ? ` — ${when}` : ''}${where}

${source.senderName ?? 'Someone'}${role ? ` (${role})` : ''} has now said the same thing.
_${source.senderName ?? 'unknown'}, ${stamp}_`
  }

  /**
   * A notice with no course, because it is for everybody.
   *
   * Labelled as department-wide so it does not read as a course announcement whose
   * course went missing — which is exactly what it would look like otherwise, and
   * exactly the thing students would then ask about.
   */
  private formatDepartment(extraction: Extraction, source: Message): string {
    const event = extraction.eventType.replace('_', ' ')
    const role = describeAuthority(extraction.authority)
    const stamp = formatStamp(source.timestamp, config.digest.timezone)

    const when = [extraction.originalDateText ?? extraction.date, formatTime12(extraction.time)]
      .filter(Boolean)
      .join(' ')
    const where = extraction.venue ? `, ${extraction.venue}` : ''

    return `🏛️ *Department notice — ${event}*${when ? ` — ${when}` : ''}${where}

_This one is for everybody, not just one course._
_${source.senderName ?? 'unknown'}${role ? ` (${role})` : ''}, ${stamp}_`
  }

  /**
   * Asks the operator which course an announcement belongs to.
   *
   * Happens when a group has no default course and the message does not name one —
   * a group called "Peermate" or "Dept Notices" rather than "CSC 301". The question
   * is stored, not just sent, so it can still be answered after the notification has
   * scrolled away; otherwise the announcement is lost the moment attention moves on.
   */
  /**
   * Something was said, but not clearly enough to repeat.
   *
   * Reuses the operator queue rather than inventing a second one: from the operator's
   * side "I could not tell which course" and "I could not make out the words" are the
   * same job — read it, and say what it actually was.
   */
  private async reportUnheard(extraction: Extraction, source: Message): Promise<void> {
    const group = await groupRepository.findByJid(source.chatJid)
    const heard = [
      extraction.course ?? 'unknown course',
      extraction.eventType.replace('_', ' '),
      extraction.originalDateText ?? extraction.date,
      formatTime12(extraction.time),
      extraction.venue,
    ]
      .filter(Boolean)
      .join(' · ')

    await pendingRepository.open({
      eventId: extraction.eventId,
      sourceMessageId: extraction.sourceMessageId,
      chatJid: source.chatJid,
      groupName: group?.name ?? null,
      summary: heard,
      status: 'open',
      askedAt: new Date(),
      resolvedAt: null,
      resolvedCourse: null,
    })

    logger.warn(
      { source: source.waMessageId, confidence: extraction.confidence },
      'heard too poorly to announce',
    )

    // The person who switched this group on, not anybody running Peermate. They were
    // in the room; they are the only one who can say what was actually said.
    const ask = group?.approvedBy ?? null
    if (!ask) return

    const stamp = formatStamp(source.timestamp, config.digest.timezone)
    await notifierService.sendText(
      ask,
      `🔉 I think I heard something in *${group?.name ?? source.chatJid}* but the recording was unclear, so I haven't told anyone.

_"${heard}"_
_${source.senderName ?? 'unknown'}, ${source.type === 'audio' ? 'voice note' : 'message'}, ${stamp}_

Transcript: _"${(source.transcript ?? '').slice(0, 300)}"_

If that's right, tell me which course it's for and I'll pass it on. If not, just say so.`,
    )
  }

  private async reportUnroutable(extraction: Extraction, source: Message): Promise<void> {
    const group = await groupRepository.findByJid(source.chatJid)
    const form =
      source.type === 'audio' ? 'voice note' : source.type === 'image' ? 'image' : 'message'
    const heard = [
      extraction.eventType.replace('_', ' '),
      extraction.originalDateText ?? extraction.date,
      formatTime12(extraction.time),
      extraction.venue,
    ]
      .filter(Boolean)
      .join(' · ')

    await pendingRepository.open({
      eventId: extraction.eventId,
      sourceMessageId: extraction.sourceMessageId,
      chatJid: source.chatJid,
      groupName: group?.name ?? null,
      summary: heard,
      status: 'open',
      askedAt: new Date(),
      resolvedAt: null,
      resolvedCourse: null,
    })

    // Asked of whoever switched this group on, not of anybody running Peermate. They
    // were in the room when it was said; nobody else was, and nobody else could answer.
    // If they cannot be reached the row simply stays open — a member of that group can
    // still answer it later, and an unanswered question is better than a guess.
    const ask = group?.approvedBy ?? null

    logger.warn(
      { source: source.waMessageId, group: group?.name, asked: ask },
      'announcement had no course',
    )
    if (!ask) return

    const stamp = formatStamp(source.timestamp, config.digest.timezone)
    const body = `❓ I heard something in *${group?.name ?? source.chatJid}* but I don't know which course it's for, so I haven't told anyone yet.

_"${heard}"_
_${source.senderName ?? 'unknown'}, ${form}, ${stamp}_

Which course is this? Reply:
• *MAT 111* — file just this one
• *always MAT 111* — and use that for everything from this group
• *ignore* — skip it`

    try {
      await notifierService.sendText(ask, body)
    } catch (error) {
      logger.error({ err: error }, 'could not ask about unroutable announcement')
    }
  }

  /**
   * Delivers an announcement that was stuck waiting for a course.
   *
   * Called once the operator answers. The extraction row is updated in place rather
   * than appended, because it was never a claim about the world — it was incomplete.
   */
  async deliverResolved(eventId: string, course: string): Promise<number> {
    const extraction = await extractionRepository.findByEventId(eventId)
    if (!extraction) return 0

    const key = courseKey(course)
    await extractionRepository.setCourse(eventId, course, key)

    const source = await messageRepository.findById(extraction.sourceMessageId)
    if (!source) return 0

    const students = await userRepository.subscribedTo(
      key ?? '',
      extraction.chatJid,
      config.whatsapp.shardId,
    )
    await this.notify([{ ...extraction, course, courseKey: key }], source)
    return students.length
  }

  /**
   * The citation is the point. The student never saw the original, so the answer has
   * to carry who said it, in what form, and when — all from the stored row.
   */
  private format(extraction: Extraction, source: Message): string {
    if (extraction.scope === 'department') return this.formatDepartment(extraction, source)

    const course = courseDisplay(extraction.course ?? extraction.courseKey) ?? 'Your course'
    const when = [extraction.originalDateText ?? extraction.date, formatTime12(extraction.time)]
      .filter(Boolean)
      .join(' ')
    const where = extraction.venue ? `, ${extraction.venue}` : ''

    const event = extraction.eventType.replace('_', ' ')
    const form =
      source.type === 'audio' ? 'voice note' : source.type === 'image' ? 'image' : 'message'
    const stamp = formatStamp(source.timestamp, config.digest.timezone)
    const role = describeAuthority(extraction.authority)
    const citation = `_${source.senderName ?? 'unknown'}${role ? ` (${role})` : ''}, ${form}, ${stamp}_`

    // Uncertainty has to come first. A confident headline with a hedge bolted on the
    // end still reads as fact — the student has acted on it before reaching the caveat.
    if (extraction.confidence < 0.6) {
      const heard = [when, extraction.venue].filter(Boolean).join(', ')
      return `⚠️ *Possible ${course} ${event}*\n\nI heard ${heard ? `"${heard}"` : 'something about this'}, but I'm not fully certain — worth checking.\n${citation}`
    }

    return `*${course} ${event}*${when ? ` — ${when}` : ''}${where}\n${citation}`
  }
}

export const announcementService = new AnnouncementService()
