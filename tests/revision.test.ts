import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Attempt } from '../src/models/index.js'

/**
 * Revision has to remember, or it is not revision.
 *
 * The quiz lives on the conversation and expires with it, and the topics a practice
 * set was built around were rendered into a message and thrown away — so "how am I
 * doing in CVE 575?" had nothing to read and no amount of later analysis could
 * recover it. One row per answered question is the smallest thing that fixes that.
 */

let attempts: Attempt[] = []

vi.mock('../src/repositories/index.js', () => ({
  attemptRepository: {
    record: vi.fn(async (rows: Attempt[]) => {
      attempts.push(...rows)
    }),
    forCourse: vi.fn(async (phone: string, courseKey: string) =>
      attempts.filter((item) => item.phone === phone && item.courseKey === courseKey),
    ),
  },
}))

vi.mock('../src/services/openai.client.js', () => ({ getOpenAI: vi.fn() }))
vi.mock('../src/services/research.service.js', () => ({ researchService: {} }))
vi.mock('../src/services/retrieval.service.js', () => ({ retrievalService: {} }))

const { prepService } = await import('../src/services/prep.service.js')

function answered(topic: string, verdict: Attempt['verdict']): Attempt {
  return {
    phone: '234',
    courseKey: 'CVE575',
    topic,
    question: `something about ${topic}`,
    verdict,
    at: new Date(),
  }
}

beforeEach(() => {
  attempts = []
})

describe('weak topics', () => {
  it('puts the worst subject first', async () => {
    attempts = [
      answered('shear force', 'wrong'),
      answered('shear force', 'wrong'),
      answered('traffic flow', 'right'),
      answered('traffic flow', 'right'),
    ]

    const weak = await prepService.weakTopics('234', 'CVE575')
    expect(weak[0]!.topic).toBe('shear force')
  })

  /** Half a mark, because "close" is most of the way there. */
  it('counts a close answer as half right', async () => {
    attempts = [answered('bending moment', 'close'), answered('bending moment', 'close')]

    const weak = await prepService.weakTopics('234', 'CVE575')
    expect(weak[0]!.right).toBe(1)
    expect(weak[0]!.asked).toBe(2)
  })

  /**
   * Decay rather than a finish line. A topic answered right three times running stops
   * being shown first, without ever being declared learned.
   */
  it('drops a topic down the list as it improves', async () => {
    attempts = [
      answered('shear force', 'wrong'),
      answered('shear force', 'right'),
      answered('shear force', 'right'),
      answered('traffic flow', 'wrong'),
    ]

    const weak = await prepService.weakTopics('234', 'CVE575')
    expect(weak[0]!.topic).toBe('traffic flow')
  })

  it('says nothing when they have never been quizzed', async () => {
    expect(await prepService.weakTopics('234', 'CVE575')).toEqual([])
    expect(await prepService.progress('234', 'CVE575')).toBeNull()
  })

  it('never reads another course, or another student', async () => {
    attempts = [
      answered('shear force', 'wrong'),
      { ...answered('statistics', 'wrong'), courseKey: 'STA202' },
      { ...answered('someone else', 'wrong'), phone: '999' },
    ]

    const weak = await prepService.weakTopics('234', 'CVE575')
    expect(weak.map((item) => item.topic)).toEqual(['shear force'])
  })
})

describe('progress', () => {
  it('reports the score and what to go back over', async () => {
    attempts = [
      answered('shear force', 'wrong'),
      answered('shear force', 'wrong'),
      answered('traffic flow', 'right'),
    ]

    const progress = await prepService.progress('234', 'CVE575')
    expect(progress).toMatch(/1 of 3 right/)
    expect(progress).toMatch(/shear force/)
  })

  it('does not tell somebody who got everything right to revise', async () => {
    attempts = [answered('shear force', 'right'), answered('traffic flow', 'right')]

    const progress = await prepService.progress('234', 'CVE575')
    expect(progress).not.toMatch(/going back over/i)
  })
})
