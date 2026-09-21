import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { User } from '../src/models/index.js'

let parsed: unknown = null
let searched: Array<{ question: string; courseKeys: string[]; groupJids: string[] }> = []
let materialCalls: Array<{ courseKey: string; groupJids: string[] }> = []
let chunks: Array<Record<string, unknown>> = []
let sentPrompt = ''

vi.mock('../src/services/openai.client.js', () => ({
  getOpenAI: () => ({
    beta: {
      chat: {
        completions: {
          parse: vi.fn(async (request: { messages: Array<{ content: string }> }) => {
            sentPrompt = request.messages.map((message) => message.content).join('\n')
            return { choices: [{ message: { parsed } }] }
          }),
        },
      },
    },
  }),
}))

vi.mock('../src/services/retrieval.service.js', () => ({
  retrievalService: {
    search: vi.fn(async (question: string, courseKeys: string[], groupJids: string[]) => {
      searched.push({ question, courseKeys, groupJids })
      return chunks
    }),
    material: vi.fn(async (courseKey: string, groupJids: string[]) => {
      materialCalls.push({ courseKey, groupJids })
      return chunks
    }),
  },
}))

const { explainerService } = await import('../src/services/explainer.service.js')

const student: User = {
  phone: '2348100000000',
  courseKeys: ['CVE575'],
  groupJids: ['g1@g.us'],
} as User

function chunk(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    content: 'Shear force is the internal force parallel to the section.',
    fileName: 'CVE575_wk4.pdf',
    page: 8,
    readVia: 'text',
    senderName: 'Dr Bello',
    type: 'document',
    timestamp: new Date('2026-09-12T08:00:00Z'),
    courseKey: 'CVE575',
    ...over,
  }
}

const script = {
  title: 'Shear force, from the ground up',
  scenes: [
    { narration: 'Shear force acts parallel to the section.', fileName: 'CVE575_wk4.pdf', page: 8 },
    { narration: 'It is the derivative of bending moment.', fileName: null, page: null },
  ],
  notCovered: ['torsion'],
}

beforeEach(() => {
  parsed = script
  searched = []
  materialCalls = []
  chunks = [chunk()]
  sentPrompt = ''
})

describe('building a spoken explanation', () => {
  it('searches for a named topic rather than taking the whole course', async () => {
    await explainerService.explain(student, 'CVE575', 'shear force')
    expect(searched.at(-1)?.question).toBe('shear force')
    expect(materialCalls).toHaveLength(0)
  })

  /**
   * Searching on an empty topic returns whatever the embedding of nothing happens to
   * sit near, which is not the same as returning everything.
   */
  it('takes the material as it stands when no topic is named', async () => {
    await explainerService.explain(student, 'CVE575', null)
    expect(materialCalls.at(-1)?.courseKey).toBe('CVE575')
    expect(searched).toHaveLength(0)
  })

  it('uses only the note the student named', async () => {
    chunks = [
      chunk({ fileName: 'CVE575_ClassNotes_1.pdf', content: 'The requested first note.' }),
      chunk({ fileName: 'CVE575_Coursework_4-6.pdf', content: 'UNRELATED COURSEWORK' }),
    ]

    await explainerService.explain(
      student,
      'CVE575',
      'highway engineering',
      'video',
      'class note 1',
    )

    expect(sentPrompt).toContain('The requested first note.')
    expect(sentPrompt).not.toContain('UNRELATED COURSEWORK')
  })

  it('is scoped to the groups the student is in', async () => {
    await explainerService.explain(student, 'CVE575', 'shear force')
    expect(searched.at(-1)?.groupJids).toEqual(['g1@g.us'])
  })

  /**
   * A file that could not be read is still indexed, so that students are told the
   * truth about what exists. It carries no text, so it cannot ground a sentence.
   */
  it('refuses rather than explaining from files it could not read', async () => {
    chunks = [chunk({ readVia: 'none', content: '' })]
    expect(await explainerService.explain(student, 'CVE575', 'shear force')).toBeNull()
  })

  it('refuses when the course has no material at all', async () => {
    chunks = []
    expect(await explainerService.explain(student, 'CVE575', 'shear force')).toBeNull()
  })

  it('gives the model the file and page, which is what a citation is copied from', async () => {
    await explainerService.explain(student, 'CVE575', 'shear force')
    expect(sentPrompt).toContain('[CVE575_wk4.pdf, p.8]')
  })

  it('returns null rather than a half-script when the model fails', async () => {
    parsed = null
    expect(await explainerService.explain(student, 'CVE575', 'shear force')).toBeNull()
  })
})

describe('the two renderings of one script', () => {
  /** A spoken citation helps nobody, and "p.8" read aloud interrupts the sentence. */
  it('leaves citations out of the narration', () => {
    const spoken = explainerService.narration(script)
    expect(spoken).not.toContain('p.8')
    expect(spoken).toContain('Shear force acts parallel')
    expect(spoken).toContain('derivative of bending moment')
  })

  it('keeps the page references in the written version', () => {
    const written = explainerService.written(script, 'CVE575')
    expect(written).toContain('CVE575_wk4.pdf, p.8')
    expect(written).toContain('CVE 575')
  })

  /**
   * The gap is stated, not silently filled. A student revising from an explanation
   * that quietly invented the missing half has no way to find that out.
   */
  it('says what the material did not cover', () => {
    expect(explainerService.written(script, 'CVE575')).toMatch(/Not in the material.*torsion/)
  })

  it('says nothing about gaps when there are none', () => {
    const written = explainerService.written({ ...script, notCovered: [] }, 'CVE575')
    expect(written).not.toMatch(/Not in the material/)
  })
})

/**
 * A filename is what a storyboard later goes looking for on disk, so it is checked
 * against the material that came back from retrieval rather than taken on trust.
 */
describe('citations the model supplied', () => {
  it('keeps one that names a file the student actually has', async () => {
    const built = await explainerService.explain(student, 'CVE575', 'shear force')
    expect(built!.scenes[0]!.fileName).toBe('CVE575_wk4.pdf')
    expect(built!.scenes[0]!.page).toBe(8)
  })

  it('drops a filename that was in no retrieved excerpt', async () => {
    parsed = {
      ...script,
      scenes: [{ narration: 'A claim.', fileName: 'CVE575_lecture9.pdf', page: 3 }],
    }
    const built = await explainerService.explain(student, 'CVE575', 'shear force')
    expect(built!.scenes[0]!.fileName).toBeNull()
    expect(built!.scenes[0]!.page).toBeNull()
  })

  /** The file is real but the page is not: keep the attribution, lose the page. */
  it('drops a page the file never had', async () => {
    parsed = {
      ...script,
      scenes: [{ narration: 'A claim.', fileName: 'CVE575_wk4.pdf', page: 99 }],
    }
    const built = await explainerService.explain(student, 'CVE575', 'shear force')
    expect(built!.scenes[0]!.fileName).toBe('CVE575_wk4.pdf')
    expect(built!.scenes[0]!.page).toBeNull()
  })

  it('never carries a page without a file to attach it to', async () => {
    parsed = { ...script, scenes: [{ narration: 'A claim.', fileName: null, page: 4 }] }
    const built = await explainerService.explain(student, 'CVE575', 'shear force')
    expect(built!.scenes[0]!.page).toBeNull()
  })
})
