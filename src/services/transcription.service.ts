import { toFile } from 'openai'
import { config } from '../config.js'
import { TranscriptionFailed } from '../core/errors.js'
import { logger } from '../core/logger.js'
import { courseRepository, extractionRepository } from '../repositories/index.js'
import { courseDisplay } from '../utils/courses.js'
import { getOpenAI } from './openai.client.js'

/** OpenAI rejects anything larger, and the rejection is not worth a retry. */
const MAX_BYTES = 25 * 1024 * 1024

/** Keeps the decoder hint inside what the API will accept as a prompt. */
const MAX_GLOSSARY_TERMS = 40

/** What is known about a recording before it is heard. Both parts are optional. */
export interface Spoken {
  /** The group it was posted in, if it was a group. */
  chatJid?: string | null
  /** What the speaker is enrolled in — the only hint a DM has. */
  courseKeys?: string[]
}

export interface Transcript {
  text: string
  /**
   * 0..1, derived from token log probabilities.
   *
   * Not a probability that the transcript is correct — a model can be fluently and
   * confidently wrong — but low values do reliably mark the recordings worth doubting,
   * which is what the uncertainty gate needs.
   */
  confidence: number | null
}

/**
 * The differentiator. A 90-second lecturer voice note nobody played is the single
 * highest-value thing Peermate reads, so this path is protected: a failure here keeps
 * the audio and marks the message, it never drops the message.
 */
export class TranscriptionService {
  /** Cached per group: the courses and venues change far more slowly than messages arrive. */
  private readonly glossaries = new Map<string, { terms: string[]; at: number }>()

  async transcribe(
    audio: Buffer,
    mimeType: string | null,
    about: Spoken = {},
  ): Promise<Transcript> {
    // A lecture recording rather than a voice note. Saying so beats a generic
    // failure, because the fix — send the part that matters — is the student's.
    if (audio.length > MAX_BYTES) {
      throw new TranscriptionFailed(
        `recording is ${Math.round(audio.length / 1024 / 1024)}MB, over the 25MB limit`,
      )
    }

    try {
      const file = await toFile(audio, `voice-note.${extensionFor(mimeType)}`, {
        type: mimeType ?? 'audio/ogg',
      })

      const result = await getOpenAI().audio.transcriptions.create({
        file,
        model: config.openai.transcriptionModel,
        // Left to auto-detect, the decoder hears accented Nigerian English or Pidgin
        // as another language entirely and returns fluent-looking nonsense. Pinning
        // the language is the difference between a usable transcript and gibberish.
        language: 'en',
        prompt: await this.glossaryFor(about),
        // verbose_json is whisper-1 only; the gpt-4o transcribe models take json and
        // return token log probabilities through `include` instead.
        response_format: 'json',
        include: ['logprobs'],
      })

      const text = result.text
      const confidence = confidenceOf(result)
      logger.debug({ chars: text.length, confidence }, 'transcribed')
      return { text, confidence }
    } catch (error) {
      if (error instanceof TranscriptionFailed) throw error
      throw new TranscriptionFailed('voice note transcription failed', error)
    }
  }

  /**
   * What this group actually talks about.
   *
   * The hint used to be one hardcoded sentence naming CSC 301, STA 202 and MAT 111 —
   * codes that exist in no real group here — so every recording was biased toward
   * vocabulary nobody was saying, while the codes people *were* saying came back as
   * ordinary words. Built from the courses and venues this group has produced, it
   * biases toward the right ones.
   */
  private async glossaryFor(about: Spoken): Promise<string> {
    const base =
      'A Nigerian university lecturer speaking to a class group chat about tests, assignments, deadlines, venues and submission times.'

    // A DM carries the student's own JID as its chat, so the group lookup finds
    // nothing — which left exactly the recordings that most need help, a student
    // saying their own course code out loud, with no biasing at all. Their enrolled
    // courses are the right vocabulary for their own voice notes.
    const key =
      about.chatJid ?? (about.courseKeys?.length ? `student:${about.courseKeys.join()}` : null)
    if (!key) return base

    const terms = await this.terms(key, about)
    if (terms.length === 0) return base
    return `${base} Expect these names: ${terms.join(', ')}.`
  }

  private async terms(key: string, about: Spoken): Promise<string[]> {
    const cached = this.glossaries.get(key)
    // An hour. Long enough that a busy group is not re-querying per voice note, short
    // enough that a course added this morning is heard correctly this afternoon.
    if (cached && Date.now() - cached.at < 60 * 60 * 1000) return cached.terms

    const terms = new Set<string>()
    try {
      // A group's own history, when there is one.
      const seen = about.chatJid ? await extractionRepository.coursesSeenIn(about.chatJid) : []
      // Plus whatever the speaker is enrolled in. A brand new group has produced no
      // extractions yet, so without this the glossary is empty for exactly as long as
      // it takes the group to say the things it needed help hearing.
      const keys = [...new Set([...seen, ...(about.courseKeys ?? [])])]

      for (const course of await courseRepository.forKeys(keys)) {
        if (course.code) terms.add(course.code)
        if (course.title) terms.add(course.title)
        if (course.lecturer) terms.add(course.lecturer)
      }
      // A code nobody has recorded a title for is still worth biasing toward.
      for (const key of keys) {
        const display = courseDisplay(key)
        if (display) terms.add(display)
      }
      if (about.chatJid) {
        for (const venue of await extractionRepository.venuesSeenIn(about.chatJid)) terms.add(venue)
      }
    } catch (error) {
      logger.warn({ err: error, key }, 'could not build a transcription glossary')
    }

    const list = [...terms].filter(Boolean).slice(0, MAX_GLOSSARY_TERMS)
    this.glossaries.set(key, { terms: list, at: Date.now() })
    return list
  }
}

/**
 * Average token log probability, squashed to 0..1.
 *
 * `exp(avg logprob)` is the geometric mean of the per-token probabilities, which is
 * the standard reading of "how sure was the decoder". Returns null when the API did
 * not send logprobs, because absent evidence must not read as low confidence — that
 * would send every transcript to triage the day the field is renamed.
 */
function confidenceOf(result: unknown): number | null {
  const logprobs = (result as { logprobs?: Array<{ logprob?: number }> }).logprobs
  if (!Array.isArray(logprobs) || logprobs.length === 0) return null

  const values = logprobs
    .map((token) => token.logprob)
    .filter((value): value is number => typeof value === 'number')
  if (values.length === 0) return null

  const mean = values.reduce((total, value) => total + value, 0) / values.length
  return Math.min(1, Math.max(0, Math.exp(mean)))
}

/**
 * The extension the API expects, which is not the second half of the media type.
 *
 * `audio/mpeg` is an MP3 and has to be sent as `.mp3`; named `.mpeg` it comes back
 * as "Audio file might be corrupted or unsupported", which reads like a bad recording
 * and is not. WhatsApp's own voice notes are `audio/ogg` and were unaffected, so this
 * only bit on forwarded files — the case nobody tests until somebody forwards one.
 */
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
  if (!mimeType) return 'ogg'
  // codecs= suffixes are part of the type and confuse the lookup.
  const base = (mimeType.split(';')[0] ?? '').trim().toLowerCase()
  return EXTENSIONS[base] ?? base.split('/')[1] ?? 'ogg'
}

export const transcriptionService = new TranscriptionService()
