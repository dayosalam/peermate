import { z } from 'zod'
import { config } from '../config.js'
import { TranscriptionFailed } from '../core/errors.js'
import { logger } from '../core/logger.js'

/** The N-ATLaS endpoint rejects files above 20 MB. */
const MAX_BYTES = 20 * 1024 * 1024

/** Kept as an input contract because callers know whether audio came from a group or DM. */
export interface Spoken {
  chatJid?: string | null
  courseKeys?: string[]
}

export interface Transcript {
  text: string
  /** The endpoint does not currently return transcription/token confidence. */
  confidence: number | null
  language: string
  /** Confidence that automatic language detection selected the right language. */
  languageConfidence: number | null
}

const ModalTranscriptSchema = z.object({
  language: z.string().min(1),
  language_confidence: z.number().min(0).max(1).nullable(),
  language_predictions: z
    .array(
      z.object({
        code: z.string(),
        confidence: z.number().min(0).max(1),
      }),
    )
    .default([]),
  text: z.string(),
})

/**
 * Sends WhatsApp audio to the authenticated N-ATLaS ASR service on Modal.
 *
 * The service converts audio to mono 16 kHz, detects Yoruba, Hausa, Igbo, or English,
 * and routes it to the matching N-ATLaS checkpoint. Audio remains stored in MinIO if
 * this call fails, so the ingestion pipeline can record the failure and retry later.
 */
export class TranscriptionService {
  async transcribe(
    audio: Buffer,
    mimeType: string | null,
    _about: Spoken = {},
  ): Promise<Transcript> {
    if (audio.length > MAX_BYTES) {
      throw new TranscriptionFailed(
        `recording is ${Math.round(audio.length / 1024 / 1024)}MB, over the 20MB limit`,
      )
    }

    if (!config.asr.modalTokenId || !config.asr.modalTokenSecret) {
      throw new TranscriptionFailed(
        'N-ATLaS ASR credentials are not configured — set MODAL_PROXY_TOKEN_ID and MODAL_PROXY_TOKEN_SECRET',
      )
    }

    try {
      const form = new FormData()
      form.append(
        'file',
        new Blob([new Uint8Array(audio)], { type: mimeType ?? 'application/octet-stream' }),
        `voice-note.${extensionFor(mimeType)}`,
      )
      form.append('language', config.asr.language)
      form.append('min_confidence', String(config.asr.minConfidence))
      form.append('detect_only', 'false')

      const response = await fetch(config.asr.url, {
        method: 'POST',
        headers: {
          'Modal-Key': config.asr.modalTokenId,
          'Modal-Secret': config.asr.modalTokenSecret,
        },
        body: form,
        signal: AbortSignal.timeout(config.asr.timeoutMs),
      })

      if (!response.ok) {
        throw new TranscriptionFailed(
          `N-ATLaS ASR returned HTTP ${response.status}: ${await responseError(response)}`,
        )
      }

      const result = ModalTranscriptSchema.safeParse(await response.json())
      if (!result.success) {
        throw new TranscriptionFailed('N-ATLaS ASR returned an invalid response')
      }

      const text = result.data.text.trim()
      if (!text) throw new TranscriptionFailed('N-ATLaS ASR returned an empty transcript')

      logger.debug(
        {
          chars: text.length,
          language: result.data.language,
          languageConfidence: result.data.language_confidence,
        },
        'transcribed with N-ATLaS ASR',
      )

      return {
        text,
        // `language_confidence` answers "which language?", not "were these words
        // transcribed correctly?". Keeping them separate prevents false certainty.
        confidence: null,
        language: result.data.language,
        languageConfidence: result.data.language_confidence,
      }
    } catch (error) {
      if (error instanceof TranscriptionFailed) throw error
      throw new TranscriptionFailed('N-ATLaS voice-note transcription failed', error)
    }
  }
}

async function responseError(response: Response): Promise<string> {
  const body = (await response.text()).trim()
  if (!body) return response.statusText || 'request failed'

  try {
    const parsed = JSON.parse(body) as { detail?: unknown }
    if (typeof parsed.detail === 'string') return parsed.detail.slice(0, 400)
  } catch {
    // A proxy may return plain text or HTML. Keep only a bounded diagnostic.
  }
  return body.replace(/\s+/g, ' ').slice(0, 400)
}

const EXTENSIONS: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'video/mp4': 'mp4',
}

function extensionFor(mimeType: string | null): string {
  if (!mimeType) return 'bin'
  const base = (mimeType.split(';')[0] ?? '').trim().toLowerCase()
  return EXTENSIONS[base] ?? base.split('/')[1] ?? 'bin'
}

export const transcriptionService = new TranscriptionService()
