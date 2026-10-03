import type { WAMessageKey } from '@whiskeysockets/baileys'
import { GroupSendForbidden } from '../core/errors.js'
import { devPreview, logger } from '../core/logger.js'
import { getMedia } from '../db/minio.js'
import { isBroadcastJid, isGroupJid, isUserJid } from '../whatsapp/jid.js'
import { getSocket, whenOpen } from '../whatsapp/socket.js'
import { VOICE_MIME } from './tts.service.js'
import { config } from '../config.js'

const RETRY_DELAY_MS = 2000

/** Three tries, because the common failure is a reconnect and not a bad message. */
const SEND_ATTEMPTS = 3

/** Longer than a reconnect takes, shorter than a student will wait for an answer. */
const RECONNECT_WAIT_MS = 25_000

/** WhatsApp drops a composing presence after ~10s, so refresh inside that window. */
const TYPING_REFRESH_MS = 6000

/**
 * The only module that sends. Everything outbound funnels through here, which is
 * what keeps the never-post-in-a-group invariant checkable in one place — and what
 * makes the split-the-directions move in PRD §8 a one-class change.
 */
export class NotifierService {
  private decorate(text: string | undefined): string | undefined {
    if (config.env !== 'development') return text
    if (!text) return '*DEV TESTING*'
    if (text.startsWith('*DEV TESTING*')) return text
    return `*DEV TESTING*\n\n${text}`
  }
  /**
   * "I am working on it", for the seconds transcription or retrieval takes.
   * Best-effort: never let a presence update break the reply it precedes.
   */
  async showTyping(jid: string): Promise<void> {
    if (!isUserJid(jid)) return
    try {
      await getSocket().sendPresenceUpdate('composing', jid)
    } catch (error) {
      logger.debug({ err: error, jid }, 'could not send typing indicator')
    }
  }

  /**
   * Keeps "typing…" visible for as long as the work takes.
   *
   * WhatsApp expires a composing presence after roughly ten seconds, so a single
   * update goes stale long before a transcription or a retrieval finishes — the
   * student sees the indicator vanish and assumes nothing is happening. Refreshing
   * it on a timer is the difference between "thinking" and "broken".
   */
  async withTyping<T>(jid: string, work: () => Promise<T>): Promise<T> {
    await this.showTyping(jid)
    const timer = setInterval(() => void this.showTyping(jid), TYPING_REFRESH_MS)
    try {
      return await work()
    } finally {
      clearInterval(timer)
      if (isUserJid(jid)) {
        try {
          await getSocket().sendPresenceUpdate('paused', jid)
        } catch {
          // The reply itself clears the indicator, so this is cosmetic.
        }
      }
    }
  }

  /** Returns the id WhatsApp gave the message, which is what a reply quotes. */
  async sendText(jid: string, text: string): Promise<string | null> {
    this.assertNotGroup(jid)
    if (!config.isProduction) {
      logger.info({ direction: 'outbound', jid, text: devPreview(text) }, 'DEV sending reply')
    }
    const sent = await this.withRetry(
      () => getSocket().sendMessage(jid, { text: this.decorate(text)! }),
      jid,
    )
    logger.info({ jid, messageId: sent?.key?.id ?? null }, 'dm sent')
    return sent?.key?.id ?? null
  }

  /**
   * Baileys has no send-by-URL: it uploads to WhatsApp's CDN itself, so the bytes
   * must come back out of MinIO and through this process.
   */
  async sendFile(
    jid: string,
    mediaKey: string,
    fileName: string,
    mimeType = 'application/octet-stream',
    caption?: string,
  ): Promise<void> {
    this.assertNotGroup(jid)
    const document = await getMedia(mediaKey)
    await this.withRetry(
      () =>
        getSocket().sendMessage(jid, {
          document,
          fileName,
          mimetype: mimeType,
          caption: this.decorate(caption),
        }),
      jid,
    )
    logger.info({ jid, fileName }, 'file sent')
  }

  /**
   * One retry, per the PRD failure table. The caller logs a single notification
   * either way, so a retry never doubles the delivery record.
   *
   * The risk this accepts: if the first send arrived but its acknowledgement did
   * not, the retry delivers the message twice. A duplicate DM is a smaller failure
   * than a student never hearing about their test, which is the trade the PRD makes.
   */
  /**
   * Retries a send across a reconnect.
   *
   * WhatsApp drops the socket often enough that a reply lands mid-outage, and a retry
   * on a fixed two-second timer fails again while Baileys is still dialling back in —
   * the answer is lost and the student is left with silence they cannot distinguish
   * from Peermate having nothing to say. So each attempt waits for the socket to come
   * back rather than for the clock.
   */
  private async withRetry<T>(send: () => Promise<T>, jid: string): Promise<T> {
    let last: unknown

    for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt += 1) {
      try {
        return await send()
      } catch (error) {
        last = error
        if (attempt === SEND_ATTEMPTS) break

        logger.warn({ err: error, jid, attempt }, 'send failed, waiting for the socket')
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
        if (!(await whenOpen(RECONNECT_WAIT_MS))) {
          logger.error({ jid }, 'socket did not come back — giving up on this message')
          break
        }
      }
    }

    throw last
  }

  /** Inline, so it plays in the chat. The caller checks the size; over the ceiling, a link is the only option. */
  async sendVideo(jid: string, video: Buffer, caption?: string): Promise<void> {
    this.assertNotGroup(jid)
    await this.withRetry(
      () =>
        getSocket().sendMessage(jid, {
          video,
          caption: this.decorate(caption),
          mimetype: 'video/mp4',
        }),
      jid,
    )
    logger.info({ jid, bytes: video.byteLength }, 'video sent')
  }

  /** `sendText` returns an id; an edit needs the whole key. Separate because almost nothing should be editable. */
  async sendEditable(jid: string, text: string): Promise<WAMessageKey | null> {
    this.assertNotGroup(jid)
    const sent = await this.withRetry(
      () => getSocket().sendMessage(jid, { text: this.decorate(text)! }),
      jid,
    )
    return sent?.key ?? null
  }

  /**
   * Rewrites a message in place; false when WhatsApp refuses.
   *
   * It refuses about fifteen minutes after the original, and refuses quietly — so a
   * caller that assumes success writes into a void. An edit does not re-notify, which
   * is the point: twelve updates to one message leave the phone silent.
   */
  async edit(jid: string, key: WAMessageKey, text: string): Promise<boolean> {
    this.assertNotGroup(jid)
    try {
      await getSocket().sendMessage(jid, { text: this.decorate(text)!, edit: key })
      return true
    } catch (error) {
      logger.warn({ err: error, jid }, 'could not edit — the window has probably closed')
      return false
    }
  }

  /** Inline, not as a file to download — an image sent as a document is unreadable. */
  async sendImage(jid: string, image: Buffer, caption?: string): Promise<void> {
    this.assertNotGroup(jid)
    await this.withRetry(
      () => getSocket().sendMessage(jid, { image, caption: this.decorate(caption) }),
      jid,
    )
    logger.info({ jid, bytes: image.length }, 'image sent')
  }

  /**
   * A real voice note, not an audio attachment. `ptt: true` is what gives it the
   * waveform and inline play button; without it WhatsApp shows a file to download.
   */
  /**
   * Sends bytes Peermate is holding rather than a file out of MinIO.
   *
   * Used for material fetched from the web, which is never stored: it belongs to
   * whoever published it, and keeping a copy would quietly turn Peermate into a
   * library of other people's documents.
   */
  async sendDocument(
    jid: string,
    bytes: Buffer,
    fileName: string,
    mimeType: string,
    caption?: string,
  ): Promise<void> {
    this.assertNotGroup(jid)
    await this.withRetry(
      () =>
        getSocket().sendMessage(jid, {
          document: bytes,
          fileName,
          mimetype: mimeType,
          caption: this.decorate(caption),
        }),
      jid,
    )
    logger.info({ jid, fileName, bytes: bytes.length }, 'document sent')
  }

  async sendVoiceNote(jid: string, audio: Buffer): Promise<void> {
    this.assertNotGroup(jid)
    await this.withRetry(
      () => getSocket().sendMessage(jid, { audio, mimetype: VOICE_MIME, ptt: true }),
      jid,
    )
    logger.info({ jid, bytes: audio.length }, 'voice note sent')
  }

  /**
   * Outbound uses an allow-list, not a block-list. WhatsApp can introduce more
   * non-person address types; only a phone JID or LID is ever a valid recipient.
   */
  private assertNotGroup(jid: string): void {
    if (isGroupJid(jid)) {
      throw new GroupSendForbidden(`refused to send into group ${jid} — Peermate never posts`)
    }
    // Sending here would publish a Status update to the account's contacts.
    if (isBroadcastJid(jid)) {
      throw new GroupSendForbidden(`refused to send to broadcast ${jid} — Peermate never posts`)
    }
    if (!isUserJid(jid)) {
      throw new GroupSendForbidden(`refused to send to non-user ${jid} — Peermate only sends DMs`)
    }
  }
}

export const notifierService = new NotifierService()
