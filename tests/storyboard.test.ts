import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Resource, User } from '../src/models/index.js'

let shelf: Resource[] = []
let claimed: Array<Record<string, unknown>> = []
let forCourseCalls: Array<{ courseKey: string; groupJids: string[] }> = []
let claimReturns = true

vi.mock('../src/repositories/index.js', () => ({
  resourceRepository: {
    forCourse: vi.fn(async (courseKey: string, groupJids: string[]) => {
      forCourseCalls.push({ courseKey, groupJids })
      return shelf
    }),
  },
  renderJobRepository: {
    claim: vi.fn(async (job: Record<string, unknown>) => {
      claimed.push(job)
      return claimReturns
    }),
    find: vi.fn(async () => claimed.at(-1) ?? null),
  },
}))

const { storyboardService } = await import('../src/services/storyboard.service.js')

const student: User = {
  phone: '2348100000000',
  courseKeys: ['CVE575'],
  groupJids: ['g1@g.us'],
} as User

function file(over: Partial<Resource> = {}): Resource {
  return {
    fileName: 'CVE575_wk4.pdf',
    mediaKey: 'doc/cve575-wk4',
    mimeType: 'application/pdf',
    courseKey: 'CVE575',
    chatJid: 'g1@g.us',
    docType: 'slides',
    postedBy: 'Dr Bello',
    postedAt: new Date(),
    sourceMessageId: 'm-1',
    course: 'CVE 575',
    ...over,
  } as Resource
}

const script = {
  title: 'Shear force',
  scenes: [
    { narration: 'Acts parallel to the section.', fileName: 'CVE575_wk4.pdf', page: 8 },
    { narration: 'That is the whole idea.', fileName: null, page: null },
  ],
  notCovered: [],
}

beforeEach(() => {
  shelf = [file()]
  claimed = []
  forCourseCalls = []
  claimReturns = true
})

describe('turning a script into a render job', () => {
  it('resolves a cited file to the key it is stored under', async () => {
    const { job } = await storyboardService.enqueue(student, 'CVE575', 'shear', script, 'j@s')
    expect(job.scenes[0]!.visual).toEqual({
      kind: 'slide',
      mediaKey: 'doc/cve575-wk4',
      fileName: 'CVE575_wk4.pdf',
      page: 8,
    })
    expect(job.scenes[0]!.source).toBe('CVE575_wk4.pdf, p.8')
    expect(job.materials).toEqual([
      { mediaKey: 'doc/cve575-wk4', fileName: 'CVE575_wk4.pdf', pages: [8] },
    ])
  })

  /** The file lives in a group. Fetching bytes is the last place to get that wrong. */
  it('only looks at files from the student own groups', async () => {
    await storyboardService.enqueue(student, 'CVE575', 'shear', script, 'j@s')
    expect(forCourseCalls.at(-1)?.groupJids).toEqual(['g1@g.us'])
  })

  it('leaves a scene with no citation without a visual', async () => {
    const { job } = await storyboardService.enqueue(student, 'CVE575', 'shear', script, 'j@s')
    expect(job.scenes[1]!.visual.kind).toBe('title')
    expect(job.scenes[1]!.source).toBeNull()
  })

  /**
   * A scene citing a photographed notice keeps its narration and loses its picture.
   * The words are the explanation; the slide only makes it easier to follow.
   */
  it('keeps the narration when the cited file cannot be rasterised', async () => {
    shelf = [file({ mimeType: 'image/jpeg', fileName: 'notice.jpg' })]
    const named = { ...script, scenes: [{ ...script.scenes[0]!, fileName: 'notice.jpg' }] }
    const { job } = await storyboardService.enqueue(student, 'CVE575', 'shear', named, 'j@s')
    expect(job.scenes[0]!.narration).toBe('Acts parallel to the section.')
    expect(job.scenes[0]!.visual.kind).toBe('title')
  })

  it('drops a visual for a file that is not on their shelf at all', async () => {
    shelf = []
    const { job } = await storyboardService.enqueue(student, 'CVE575', 'shear', script, 'j@s')
    expect(job.scenes[0]!.visual.kind).toBe('title')
  })

  /** Rendering costs narration, so asking twice must not pay twice. */
  it('keys on the request, so the same question claims once', async () => {
    const first = await storyboardService.enqueue(student, 'CVE575', 'shear', script, 'j@s')
    claimReturns = false
    const again = await storyboardService.enqueue(student, 'CVE575', 'shear', script, 'j@s')

    expect(first.fresh).toBe(true)
    expect(again.fresh).toBe(false)
    expect(again.job.key).toBe(first.job.key)
  })

  it('treats a different topic as a different job', async () => {
    const shear = await storyboardService.enqueue(student, 'CVE575', 'shear', script, 'j@s')
    const bending = await storyboardService.enqueue(student, 'CVE575', 'bending', script, 'j@s')
    expect(bending.job.key).not.toBe(shear.job.key)
  })
})
