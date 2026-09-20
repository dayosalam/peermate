import { describe, expect, it, vi } from 'vitest'
import type { JobScene, RenderJob } from '../src/models/index.js'

vi.mock('../src/repositories/index.js', () => ({
  renderJobRepository: { take: vi.fn(), finish: vi.fn(), recoverUnfinished: vi.fn() },
  outboxRepository: { claim: vi.fn() },
}))
vi.mock('../src/db/minio.js', () => ({ getMedia: vi.fn(), putMedia: vi.fn() }))

const { toRenderInput, toStoryboard } = await import('../src/workers/render.worker.js')

function scene(visual: JobScene['visual'], narration = 'A beat.'): JobScene {
  return { narration, visual, source: 'CVE575_wk4.pdf, p.8' }
}

function job(scenes: JobScene[]): RenderJob {
  return { title: 'Shear force', courseKey: 'CVE575', scenes } as RenderJob
}

interface Board {
  scenes: Array<{ narration: string; visual: { kind: string; [field: string]: unknown } }>
}

describe('turning a stored job into a storyboard', () => {
  it('asks the isolated renderer to plan a whiteboard lesson from fetched PDFs', () => {
    const request = toRenderInput(
      {
        ...job([scene({ kind: 'title', text: 'Shear' })]),
        topic: 'shear force',
        materials: [{ mediaKey: 'doc/wk4', fileName: 'CVE575_wk4.pdf', pages: [8] }],
      },
      new Map([['doc/wk4', '/tmp/work/0.pdf']]),
    )

    expect(request).toEqual({
      kind: 'whiteboard-request',
      course: 'CVE575',
      topic: 'shear force',
      materials: [{ path: '/tmp/work/0.pdf', fileName: 'CVE575_wk4.pdf', pages: [8] }],
    })
  })

  it('falls back to the legacy storyboard if no selected PDF can be fetched', () => {
    const source = job([scene({ kind: 'title', text: 'Shear' })])
    expect(toRenderInput(source, new Map())).toEqual(toStoryboard(source, new Map()))
  })

  it('points a cited page at the file that was fetched for it', () => {
    const board = toStoryboard(
      job([scene({ kind: 'slide', mediaKey: 'doc/wk4', fileName: 'CVE575_wk4.pdf', page: 8 })]),
      new Map([['doc/wk4', '/tmp/work/0.pdf']]),
    ) as Board

    expect(board.scenes[0]?.visual).toEqual({
      kind: 'slide',
      pdfPath: '/tmp/work/0.pdf',
      page: 8,
    })
  })

  /**
   * The words are the explanation. A file that will not come back out of MinIO costs
   * the scene its picture, never its narration.
   */
  it('keeps the narration when the slide could not be fetched', () => {
    const board = toStoryboard(
      job([
        scene(
          { kind: 'slide', mediaKey: 'doc/gone', fileName: 'CVE575_wk4.pdf', page: 8 },
          'Shear force is the sum of the vertical forces.',
        ),
      ]),
      new Map(),
    ) as Board

    expect(board.scenes[0]?.narration).toBe('Shear force is the sum of the vertical forces.')
    expect(board.scenes[0]?.visual.kind).toBe('title')
  })

  it('carries a generated backdrop through as a prompt', () => {
    const board = toStoryboard(
      job([scene({ kind: 'generated', prompt: 'An empty chalkboard' })]),
      new Map(),
    ) as Board

    expect(board.scenes[0]?.visual).toEqual({ kind: 'generated', prompt: 'An empty chalkboard' })
  })

  /**
   * The rule the union exists to make checkable: a generated image may never stand in
   * for material a student could revise from.
   */
  it('never turns a cited page into a generated image', () => {
    const board = toStoryboard(
      job([
        scene({ kind: 'slide', mediaKey: 'doc/gone', fileName: 'CVE575_wk4.pdf', page: 8 }),
        scene({ kind: 'slide', mediaKey: 'doc/wk4', fileName: 'CVE575_wk4.pdf', page: 2 }),
      ]),
      new Map([['doc/wk4', '/tmp/work/1.pdf']]),
    ) as Board

    expect(board.scenes.map((s) => s.visual.kind)).toEqual(['title', 'slide'])
  })

  it('defaults to the first page when the citation named no page', () => {
    const board = toStoryboard(
      job([scene({ kind: 'slide', mediaKey: 'doc/wk4', fileName: 'CVE575_wk4.pdf', page: null })]),
      new Map([['doc/wk4', '/tmp/work/0.pdf']]),
    ) as Board

    expect(board.scenes[0]?.visual['page']).toBe(1)
  })
})
