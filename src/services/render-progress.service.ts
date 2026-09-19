import type { WAMessageKey } from '@whiskeysockets/baileys'
import { config } from '../config.js'
import { logger } from '../core/logger.js'
import type { RenderJob } from '../models/index.js'
import { renderJobRepository } from '../repositories/index.js'
import { notifierService } from './notifier.service.js'

/** Often enough that it is visibly moving, rarely enough that it is not a chat of its own. */
export const PROGRESS_TICK_MS = 15_000

/**
 * WhatsApp stops accepting edits about fifteen minutes after a message was sent, and
 * says nothing when it refuses. A minute of margin, then start a fresh message.
 */
const EDIT_WINDOW_MS = 14 * 60 * 1000

/**
 * Tells a student how their video is going, in one message that rewrites itself.
 *
 * The renderer runs in another process and cannot send anything, so it writes progress
 * to the job row and this reads it. An edit does not re-notify, so a dozen updates
 * leave the phone silent where a dozen messages would not.
 */
export class RenderProgressService {
  async tick(): Promise<void> {
    const active = await renderJobRepository.active(config.whatsapp.shardId)
    for (const job of active) {
      try {
        await this.show(job)
      } catch (error) {
        logger.warn({ err: error, key: job.key }, 'could not update render progress')
      }
    }
  }

  private async show(job: RenderJob): Promise<void> {
    const text = describe(job)
    const existing = job.progressMessage

    if (existing && Date.now() - existing.sentAt.getTime() < EDIT_WINDOW_MS) {
      const key: WAMessageKey = {
        id: existing.id,
        remoteJid: existing.remoteJid,
        fromMe: existing.fromMe,
      }
      if (await notifierService.edit(job.jid, key, text)) return
    }

    const sent = await notifierService.sendEditable(job.jid, text)
    if (!sent?.id) return
    await renderJobRepository.finish(job.key, {
      progressMessage: {
        id: sent.id,
        remoteJid: sent.remoteJid ?? job.jid,
        fromMe: sent.fromMe ?? true,
        sentAt: new Date(),
      },
    })
  }
}

/**
 * The percentage is the renderer's own count of finished stages. Nothing here
 * estimates: a student reads this to decide whether to keep waiting.
 */
function describe(job: RenderJob): string {
  const percent = Math.round(job.progress * 100)
  const elapsed = job.startedAt ? Date.now() - job.startedAt.getTime() : 0
  const minutes = Math.floor(elapsed / 60_000)
  const seconds = Math.floor((elapsed % 60_000) / 1000)
  const clock = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
  const stage = job.stage ? `\n${job.stage}` : ''
  return `Building your explainer — ${percent}% · ${clock}${stage}`
}

export const renderProgressService = new RenderProgressService()
