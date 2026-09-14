import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * What the decoder is told to expect.
 *
 * The prompt used to be one hardcoded sentence naming CSC 301, STA 202 and MAT 111 —
 * course codes that exist in no real group here — so every recording was biased
 * toward vocabulary nobody was saying, while the codes people *were* saying came back
 * as ordinary words. These tests are about where the right vocabulary comes from.
 */

let sentPrompt = ''
let sentOptions: Record<string, unknown> = {}
let logprobs: Array<{ logprob: number }> | undefined
let coursesInGroup: string[] = []
let venuesInGroup: string[] = []
let known: Array<{
  courseKey: string
  code: string
  title: string | null
  lecturer: string | null
}> = []

vi.mock('../src/services/openai.client.js', () => ({
  getOpenAI: () => ({
    audio: {
      transcriptions: {
        create: async (options: Record<string, unknown>) => {
          sentOptions = options
          sentPrompt = String(options['prompt'] ?? '')
          return { text: 'the CVE 575 test is on Friday', logprobs }
        },
      },
    },
  }),
}))

vi.mock('../src/repositories/index.js', () => ({
  extractionRepository: {
    coursesSeenIn: vi.fn(async () => coursesInGroup),
    venuesSeenIn: vi.fn(async () => venuesInGroup),
  },
  courseRepository: {
    forKeys: vi.fn(async (keys: string[]) => known.filter((c) => keys.includes(c.courseKey))),
  },
}))

const { TranscriptionService } = await import('../src/services/transcription.service.js')

beforeEach(() => {
  sentPrompt = ''
  sentOptions = {}
  logprobs = undefined
  coursesInGroup = []
  venuesInGroup = []
  known = []
})

/** A fresh instance each time: the glossary is cached for an hour by design. */
const service = () => new TranscriptionService()

describe('the decoder is told what this group talks about', () => {
  it('names the courses, titles, lecturers and venues it has actually heard', async () => {
    coursesInGroup = ['CVE575']
    venuesInGroup = ['LG7']
    known = [
      {
        courseKey: 'CVE575',
        code: 'CVE 575',
        title: 'Transportation Engineering',
        lecturer: 'Dr Bello',
      },
    ]

    await service().transcribe(Buffer.from('x'), 'audio/ogg', { chatJid: '111@g.us' })

    expect(sentPrompt).toContain('CVE 575')
    expect(sentPrompt).toContain('Transportation Engineering')
    expect(sentPrompt).toContain('Dr Bello')
    expect(sentPrompt).toContain('LG7')
  })

  /**
   * A DM carries the student's own JID as its chat, so the group lookup finds
   * nothing — which left exactly the recordings that most need help, a student
   * saying their own course code aloud, with no biasing at all.
   */
  it('falls back to the speaker’s own courses for a direct message', async () => {
    known = [
      { courseKey: 'CVE575', code: 'CVE 575', title: 'Transportation Engineering', lecturer: null },
    ]

    await service().transcribe(Buffer.from('x'), 'audio/ogg', { courseKeys: ['CVE575'] })

    expect(sentPrompt).toContain('CVE 575')
  })

  /** A brand new group has produced no extractions yet. */
  it('still biases toward a code nobody has recorded a title for', async () => {
    await service().transcribe(Buffer.from('x'), 'audio/ogg', { courseKeys: ['ABE501'] })
    expect(sentPrompt).toContain('ABE 501')
  })

  it('says something sensible when it knows nothing at all', async () => {
    await service().transcribe(Buffer.from('x'), 'audio/ogg', {})
    expect(sentPrompt).toMatch(/Nigerian university/i)
    expect(sentPrompt).not.toMatch(/CSC 301|STA 202|MAT 111/)
  })

  it('pins the language, because auto-detect hears Pidgin as another language', async () => {
    await service().transcribe(Buffer.from('x'), 'audio/ogg', {})
    expect(sentOptions['language']).toBe('en')
  })
})

describe('how sure it was', () => {
  /** verbose_json is whisper-1 only; these models report token log probabilities. */
  it('asks for logprobs rather than verbose_json', async () => {
    await service().transcribe(Buffer.from('x'), 'audio/ogg', {})
    expect(sentOptions['response_format']).toBe('json')
    expect(sentOptions['include']).toEqual(['logprobs'])
  })

  it('turns token log probabilities into a 0..1 confidence', async () => {
    logprobs = [{ logprob: -0.1 }, { logprob: -0.1 }]
    const heard = await service().transcribe(Buffer.from('x'), 'audio/ogg', {})

    expect(heard.confidence).toBeGreaterThan(0.8)
    expect(heard.confidence).toBeLessThanOrEqual(1)
  })

  it('reports low confidence on a badly heard recording', async () => {
    logprobs = [{ logprob: -3 }, { logprob: -3 }]
    const heard = await service().transcribe(Buffer.from('x'), 'audio/ogg', {})
    expect(heard.confidence).toBeLessThan(0.1)
  })

  /**
   * Absent evidence must not read as low confidence — that would send every
   * transcript to operator triage the day the field is renamed.
   */
  it('reports null rather than zero when the API says nothing', async () => {
    const heard = await service().transcribe(Buffer.from('x'), 'audio/ogg', {})
    expect(heard.confidence).toBeNull()
  })
})

describe('a recording too big to send', () => {
  it('says what is wrong instead of failing generically', async () => {
    const huge = Buffer.alloc(26 * 1024 * 1024)
    await expect(service().transcribe(huge, 'audio/ogg', {})).rejects.toThrow(/25MB/)
  })
})
