import { config } from '../config.js'
import { logger } from '../core/logger.js'
import type { Resource, User } from '../models/index.js'
import { notificationRepository, userRepository } from '../repositories/index.js'
import { courseDisplay } from '../utils/courses.js'
import { deliveryService } from './delivery.service.js'

interface Batch {
  courseKey: string
  chatJid: string
  resources: Resource[]
  senders: Set<string>
  timer: NodeJS.Timeout
}

/**
 * One batch per course *per group*. Two universities both sharing CVE 575 notes in
 * the same minute are two uploads to two cohorts, not one — keying on the course
 * alone would merge them and tell each group about the other's files.
 */
function batchKey(courseKey: string, chatJid: string): string {
  return `${courseKey}|${chatJid}`
}

/**
 * Tells students when files land in their course.
 *
 * Batched on purpose. Somebody dropping a semester's notes posts five PDFs in
 * twenty seconds, and five separate alerts is worse than none — the student mutes
 * the chat. The window restarts on every new file, so an upload in progress
 * produces exactly one message once it stops.
 *
 * The files themselves are not attached. A heads-up costs a kilobyte; sending 1.8MB
 * of PDFs nobody asked for, on metered data, is a different thing entirely. They can
 * ask, and the shelf is one message away.
 */
export class ResourceAlertService {
  private readonly batches = new Map<string, Batch>()

  /** Called once per filed document. Sends nothing until the group falls quiet. */
  queue(resource: Resource, senderName: string | null): void {
    if (!resource.courseKey || !resource.chatJid) return

    const key = batchKey(resource.courseKey, resource.chatJid)
    const existing = this.batches.get(key)

    if (existing) {
      clearTimeout(existing.timer)
      existing.resources.push(resource)
      if (senderName) existing.senders.add(senderName)
      existing.timer = this.schedule(key)
      return
    }

    this.batches.set(key, {
      courseKey: resource.courseKey,
      chatJid: resource.chatJid,
      resources: [resource],
      senders: new Set(senderName ? [senderName] : []),
      timer: this.schedule(key),
    })
  }

  private schedule(key: string): NodeJS.Timeout {
    const timer = setTimeout(() => {
      void this.flush(key).catch((error) =>
        logger.error({ err: error, key }, 'resource alert failed'),
      )
    }, config.resourceAlertDelayMs)
    // Never hold the process open for a pending heads-up.
    timer.unref?.()
    return timer
  }

  private async flush(key: string): Promise<void> {
    const batch = this.batches.get(key)
    this.batches.delete(key)
    if (!batch || batch.resources.length === 0) return

    const { courseKey, chatJid } = batch
    const students = await userRepository.subscribedTo(courseKey, chatJid, config.whatsapp.shardId)
    if (students.length === 0) {
      logger.info({ courseKey, files: batch.resources.length }, 'files filed, nobody to tell')
      return
    }

    const body = this.format(courseKey, batch)
    for (const student of students) {
      try {
        // A file landing at 2am is the least urgent thing Peermate sends, so this
        // is the first thing a pause or an urgent-only setting silences.
        const sent = await deliveryService.send(student, body, {
          kind: 'resource',
          courseKey,
        })
        if (!sent) continue

        await notificationRepository.log({
          userPhone: student.phone,
          extractionId: null,
          notificationType: 'instant',
          status: 'sent',
          error: null,
          sentAt: new Date(),
        })
      } catch (error) {
        logger.error({ err: error, phone: student.phone }, 'could not announce new files')
      }
    }
    logger.info(
      { courseKey, files: batch.resources.length, students: students.length },
      'new files announced',
    )
  }

  private format(courseKey: string, batch: Batch): string {
    const course = courseDisplay(courseKey) ?? courseKey
    const count = batch.resources.length
    const list = batch.resources.map((resource) => `• ${resource.fileName}`).join('\n')

    const who = [...batch.senders]
    const by = who.length === 1 ? `\n_shared by ${who[0]}_` : ''

    // Name the kinds only when they differ — "3 slides" is worth knowing, a mixed
    // bag is not worth a second line.
    const types = new Set(batch.resources.map((resource) => resource.docType))
    const kind =
      types.size === 1 && !types.has('other') ? ` (${[...types][0]!.replace('_', ' ')})` : ''

    return `📎 *${count} new file${count === 1 ? '' : 's'} in ${course}*${kind}

${list}${by}

Say *${course} resources* and I'll send them.`
  }

  /** Flushes everything immediately. Used on shutdown so nothing pending is lost. */
  async flushAll(): Promise<void> {
    for (const [key, batch] of [...this.batches]) {
      clearTimeout(batch.timer)
      await this.flush(key)
    }
  }
}

export const resourceAlertService = new ResourceAlertService()
