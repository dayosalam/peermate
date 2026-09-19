import { config } from '../config.js'
import { logger } from '../core/logger.js'
import { getMedia } from '../db/minio.js'
import type { EventType, OutboxEntry, User } from '../models/index.js'
import {
  conversationRepository,
  notificationRepository,
  outboxRepository,
} from '../repositories/index.js'
import { todayIso } from '../utils/dates.js'
import { isQuietHour } from '../utils/quiet.js'
import { conversationService } from './conversation.service.js'
import { notifierService } from './notifier.service.js'

/** Things worth interrupting someone for. Everything else can wait for the digest. */
// A cancellation is the most useful thing Peermate ever sends: it is the one that
// saves a journey, and it is worthless the morning after.
/** After this many failures the message is stale enough that delivering it is noise. */
const MAX_OUTBOX_ATTEMPTS = 5

const URGENT: EventType[] = ['test', 'deadline', 'venue_change', 'assignment', 'cancelled']

export interface Unsolicited {
  kind: 'announcement' | 'resource' | 'digest' | 'deadline'
  courseKey?: string | null
  eventType?: EventType | null
  /** The event this alert is about, so a quoted reply to it can be resolved. */
  eventId?: string | null
}

interface Batch {
  jid: string
  bodies: string[]
  /** The outbox rows these came from, cleared together once the batch lands. */
  keys: string[]
  /** Carried through the wait so a deferred alert is still replyable when it lands. */
  eventIds: string[]
  /** When the first held item arrived, so a long conversation cannot defer forever. */
  since: number
  timer: NodeJS.Timeout
}

/**
 * Everything Peermate sends that the student did not just ask for goes through here.
 *
 * Two separate problems, one gate. The first is consent: a student who said "pause
 * until Monday" or "only urgent" has to be obeyed everywhere, and a rule enforced in
 * three services is a rule that will be missed in the fourth. The second is timing —
 * an alert landing in the middle of a conversation reads as an answer to the question
 * they just asked, which is how a bot ends up appearing to say something it did not.
 *
 * Nothing is dropped here. Held announcements are still stored, and the digest covers
 * everything since it last ran, so a pause defers rather than deletes.
 */
export class DeliveryService {
  private readonly deferred = new Map<string, Batch>()

  /** Returns false when the message was held rather than sent. */
  async send(student: User, body: string, about: Unsolicited): Promise<boolean> {
    const held = this.heldReason(student, about)
    if (held) {
      logger.info({ phone: student.phone, kind: about.kind, held }, 'not sending')
      // Recorded, not just logged. "Did she get the deadline warning?" has to be
      // answerable from the database months later, and a pino line on a container
      // that has since been replaced is not an answer.
      await notificationRepository
        .log({
          userPhone: student.phone,
          extractionId: about.eventId ?? null,
          notificationType: typeFor(about.kind),
          status: 'suppressed',
          error: held,
          sentAt: new Date(),
        })
        .catch((error) => logger.warn({ err: error }, 'could not record a suppression'))
      return false
    }

    if (
      config.delivery.enabled &&
      about.kind !== 'digest' &&
      (await this.midConversation(student.phone))
    ) {
      // Written down before it is held. The in-memory batch is a *timer*, not the
      // record: a crash during the deferral window used to take the held alert with
      // it, which is the one case where "held, never dropped" was untrue.
      await outboxRepository.claim({
        key: outboxKey(student.phone, about, body),
        shardId: config.whatsapp.shardId,
        phone: student.phone,
        jid: student.jid,
        body,
        status: 'pending',
        attempts: 0,
        lastError: null,
        video: null,
        solicited: false,
        // Left to the in-memory batch until the deferral window is over. Past that
        // the wait has failed — a crash, or a conversation that never went quiet —
        // and the sweep sends it rather than nobody sending it.
        notBefore: new Date(Date.now() + config.delivery.maxDeferMs),
        createdAt: new Date(),
        updatedAt: new Date(),
      })

      this.defer(
        student.phone,
        student.jid,
        body,
        about.eventId ?? null,
        outboxKey(student.phone, about, body),
      )
      return false
    }

    return this.deliver(student, body, about, outboxKey(student.phone, about, body))
  }

  /**
   * Sends, with a row on disk for as long as it is owed.
   *
   * The row is written *before* the attempt so a crash mid-send leaves evidence, and
   * cleared after so only the unfinished remain. `claim` returning false means this
   * exact message to this exact person is already accounted for, which stops the
   * ordinary duplicate: two code paths deciding to send the same alert.
   *
   * Delivery is **at-least-once, not exactly-once**, and it cannot be otherwise here.
   * A crash in the window between WhatsApp accepting the message and `succeeded`
   * being written leaves a pending row that the sweep will send again. Baileys
   * offers no way to ask afterwards whether a message landed, so the choice is a
   * rare duplicate or a rare silent loss — and a student who gets told about their
   * test twice is better served than one who is never told. Same trade as
   * NotifierService's retry.
   */
  private async deliver(
    student: User,
    body: string,
    about: Unsolicited,
    key: string,
    resuming = false,
  ): Promise<boolean> {
    if (!resuming) {
      const fresh = await outboxRepository.claim({
        key,
        shardId: config.whatsapp.shardId,
        phone: student.phone,
        jid: student.jid,
        body,
        status: 'pending',
        attempts: 0,
        lastError: null,
        video: null,
        solicited: false,
        notBefore: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      if (!fresh) {
        logger.debug({ phone: student.phone, key }, 'already queued, not sending twice')
        return false
      }
    }

    try {
      const waMessageId = await notifierService.sendText(student.jid, body)
      await outboxRepository.succeeded(key)

      // An alert is part of the thread too: "you told me it moved" refers to one of
      // these, not to anything the student asked for.
      await conversationService.rememberTurn(student.phone, 'peermate', body)
      if (waMessageId && about.eventId) {
        await conversationService.rememberAlert(student.phone, waMessageId, about.eventId)
      }
      return true
    } catch (error) {
      // notifierService has already retried three times across a reconnect. This is
      // the socket still being down after that, which a later sweep can fix and an
      // immediate fourth attempt cannot.
      await outboxRepository.failed(key, String(error))
      logger.error({ err: error, phone: student.phone, key }, 'send failed, left in the outbox')
      return false
    }
  }

  /**
   * Sends what a crash or a long outage left owed.
   *
   * Run at boot and on the scheduler tick. Anything that has been retried enough is
   * abandoned rather than retried for ever — at some point a message about a test
   * last Tuesday is not worth delivering, and a queue that never drains hides the
   * ones that are.
   */
  async drainOutbox(): Promise<number> {
    const owed = await outboxRepository.pending(config.whatsapp.shardId)
    let sent = 0

    for (const entry of owed) {
      if (entry.attempts >= MAX_OUTBOX_ATTEMPTS) {
        await outboxRepository.abandon(entry.key)
        logger.warn({ key: entry.key, phone: entry.phone }, 'outbox entry abandoned')
        continue
      }

      // A student who asked for this and watched it being built is not being interrupted.
      if (entry.solicited) {
        if (await this.handOver(entry)) sent += 1
        continue
      }

      const student = { phone: entry.phone, jid: entry.jid } as User
      const delivered = await this.deliver(
        student,
        entry.body,
        { kind: 'announcement' },
        entry.key,
        true,
      )
      if (delivered) sent += 1
    }

    if (sent > 0) logger.info({ sent }, 'outbox drained')
    return sent
  }

  /**
   * Sends what a student asked for, and clears the row.
   *
   * A failure leaves the row alone so the next sweep retries it — the reason it was
   * written down before being attempted.
   */
  private async handOver(entry: OutboxEntry): Promise<boolean> {
    try {
      if (!entry.video) {
        await notifierService.sendText(entry.jid, entry.body)
      } else if (entry.video.playbackUrl && entry.video.bytes > config.research.maxFileBytes) {
        await notifierService.sendText(entry.jid, `${entry.body}\n\n${entry.video.playbackUrl}`)
      } else {
        const bytes = await getMedia(entry.video.mediaKey)
        await notifierService.sendVideo(entry.jid, bytes, entry.body)
      }
      await outboxRepository.succeeded(entry.key)
      return true
    } catch (error) {
      await outboxRepository.failed(entry.key, String(error).slice(0, 300))
      logger.error({ err: error, key: entry.key }, 'could not hand over a finished render')
      return false
    }
  }

  /** Why this student is not being messaged right now, or null when they can be. */
  private heldReason(student: User, about: Unsolicited): string | null {
    if (student.paused) return 'paused indefinitely'
    if (student.pausedUntil && student.pausedUntil.getTime() > Date.now()) return 'paused'

    if (about.kind === 'digest') return student.digestPaused ? 'digest turned off' : null

    if (about.courseKey && student.mutedCourseKeys.includes(about.courseKey)) return 'course muted'
    if (isQuietHour(student)) return 'quiet hours'

    if (student.alertLevel === 'urgent') {
      // A new file is never urgent — the shelf is one message away whenever they want it.
      if (about.kind === 'resource') return 'urgent alerts only'

      // An announcement with no type cannot be judged, so the morning digest carries
      // it. A reminder arrives as an announcement too, typed by what it is about.
      if (
        about.kind === 'announcement' &&
        (!about.eventType || !URGENT.includes(about.eventType))
      ) {
        return 'urgent alerts only'
      }

      // A deadline warning is never held here. It is sent on the day something is
      // due, about something already established as urgent, and it carries the brief
      // — withholding it from the students who asked to hear *only* urgent things is
      // exactly backwards. `deadline` is in URGENT; the old kind check meant that
      // list was never reached.
    }

    return null
  }

  private async midConversation(phone: string): Promise<boolean> {
    const conversation = await conversationRepository.find(phone)
    if (!conversation) return false
    return Date.now() - conversation.updatedAt.getTime() < config.delivery.conversationActiveMs
  }

  /**
   * Waits for the exchange to finish, then sends what arrived while they were typing.
   *
   * Batched, because a lecturer posting a timetable produces several announcements at
   * once and four separate "by the way" messages is worse than the interruption it
   * was avoiding.
   */
  private defer(
    phone: string,
    jid: string,
    body: string,
    eventId: string | null,
    key: string,
  ): void {
    const existing = this.deferred.get(phone)
    if (existing) {
      clearTimeout(existing.timer)
      existing.bodies.push(body)
      existing.keys.push(key)
      if (eventId) existing.eventIds.push(eventId)
      existing.timer = this.schedule(phone)
      return
    }

    this.deferred.set(phone, {
      jid,
      bodies: [body],
      keys: [key],
      eventIds: eventId ? [eventId] : [],
      since: Date.now(),
      timer: this.schedule(phone),
    })
    logger.info({ phone }, 'mid-conversation, holding alert')
  }

  private schedule(phone: string): NodeJS.Timeout {
    const timer = setTimeout(() => {
      void this.flush(phone).catch((error) =>
        logger.error({ err: error, phone }, 'deferred alert failed'),
      )
    }, config.delivery.deferMs)
    // A pending courtesy must never be the reason the process will not exit.
    timer.unref?.()
    return timer
  }

  private async flush(phone: string): Promise<void> {
    const batch = this.deferred.get(phone)
    if (!batch || batch.bodies.length === 0) {
      this.deferred.delete(phone)
      return
    }
    clearTimeout(batch.timer)

    // Still talking. Waiting for the gap is the whole point, but a conversation that
    // runs for ten minutes must not bury a test alert — past the cap it goes out.
    if (
      Date.now() - batch.since < config.delivery.maxDeferMs &&
      (await this.midConversation(phone))
    ) {
      batch.timer = this.schedule(phone)
      return
    }

    this.deferred.delete(phone)

    // Said once, ahead of the batch: without it the alert still reads as a late
    // answer to whatever they were asking a minute ago.
    const lead =
      batch.bodies.length === 1
        ? 'One thing came in while we were talking 👇'
        : `${batch.bodies.length} things came in while we were talking 👇`

    const held = `${lead}\n\n${batch.bodies.join('\n\n———\n\n')}`

    let waMessageId: string | null = null
    try {
      waMessageId = await notifierService.sendText(batch.jid, held)
    } catch (error) {
      // Left in the outbox rather than lost. The batch is gone from memory, but each
      // held alert still has its row, and the sweep will send them individually —
      // separate messages beat no message.
      logger.error({ err: error, phone }, 'could not flush held alerts, left in the outbox')
      return
    }

    for (const key of batch.keys) await outboxRepository.succeeded(key)
    await conversationService.rememberTurn(phone, 'peermate', held)

    // One message carrying several alerts can only point at one event, so a reply to
    // it resolves to the most recent — which is the one at the bottom of what they
    // just read, and the one they are most likely replying about.
    const [latest] = batch.eventIds.slice(-1)
    if (waMessageId && latest) await conversationService.rememberAlert(phone, waMessageId, latest)
  }

  /** Sends everything pending immediately, so a shutdown loses nothing. */
  async flushAll(): Promise<void> {
    for (const [phone, batch] of [...this.deferred]) {
      // Force it out: on the way down there is no later.
      batch.since = 0
      await this.flush(phone).catch((error) =>
        logger.error({ err: error, phone }, 'could not flush deferred alerts'),
      )
    }
  }

  /**
   * Lifts a pause whose end has passed.
   *
   * Checked on read rather than swept on a timer: a pause that expires while the
   * process is down must still be over when it comes back up.
   */
  static expired(student: User): boolean {
    return (
      !student.paused && student.pausedUntil !== null && student.pausedUntil.getTime() <= Date.now()
    )
  }

  /** What a student is currently being spared, for `settings` to read back. */
  static describeHolds(student: User): string[] {
    const holds: string[] = []
    if (student.paused) holds.push('Everything is paused — send *resume* to start again.')
    else if (student.pausedUntil && student.pausedUntil.getTime() > Date.now()) {
      holds.push(
        `Paused until ${student.pausedUntil.toLocaleString('en-GB', {
          timeZone: config.digest.timezone,
          weekday: 'long',
          day: 'numeric',
          month: 'short',
        })}.`,
      )
    }
    if (student.digestPaused)
      holds.push('Morning digest is off — send *digest on* to bring it back.')
    if (student.alertLevel === 'urgent')
      holds.push('Only urgent alerts — tests, deadlines and venue changes.')
    return holds
  }
}

export const deliveryService = new DeliveryService()

/**
 * A stable name for one message to one person, on one day.
 *
 * All three parts are load-bearing, and the first version of this had only two:
 *
 * - **The body**, because one event produces several different messages. A reminder
 *   the day before and one two hours before share an event id; keyed on that alone
 *   the second was silently dropped for ever.
 * - **The day**, because one message recurs. "Nothing new across your courses today"
 *   is byte-identical every quiet morning, so keyed without a date the empty digest
 *   sent once in the product's lifetime and never again. The smoke test caught it:
 *   stage ten passed on a clean database and failed on the second run.
 * - **The event id** where there is one, so two alerts about different events on the
 *   same day are never folded together.
 *
 * What this still catches is the case it exists for: a crash between sending and
 * recording, where the sweep would otherwise deliver the same message twice within
 * the same day.
 */
function outboxKey(phone: string, about: Unsolicited, body: string): string {
  const day = todayIso(config.digest.timezone)
  return `${phone}|${about.kind}|${about.eventId ?? 'none'}|${hash(body)}|${day}`
}

function hash(text: string): string {
  let value = 0
  for (let index = 0; index < text.length; index += 1) {
    value = (value * 31 + text.charCodeAt(index)) | 0
  }
  return String(value >>> 0)
}

/** The outbound kinds do not line up one-to-one with how notifications are typed. */
function typeFor(kind: Unsolicited['kind']): 'instant' | 'digest' | 'deadline_warning' {
  if (kind === 'digest') return 'digest'
  if (kind === 'deadline') return 'deadline_warning'
  return 'instant'
}
