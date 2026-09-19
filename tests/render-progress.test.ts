import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RenderJob } from '../src/models/index.js'

let active: RenderJob[] = []
let edits: Array<{ jid: string; id: string; text: string }> = []
let sends: Array<{ jid: string; text: string }> = []
let patches: Array<Record<string, unknown>> = []
let editSucceeds = true

vi.mock('../src/repositories/index.js', () => ({
  renderJobRepository: {
    active: vi.fn(async () => active),
    finish: vi.fn(async (_key: string, patch: Record<string, unknown>) => {
      patches.push(patch)
    }),
  },
}))

vi.mock('../src/services/notifier.service.js', () => ({
  notifierService: {
    edit: vi.fn(async (jid: string, key: { id: string }, text: string) => {
      edits.push({ jid, id: key.id, text })
      return editSucceeds
    }),
    sendEditable: vi.fn(async (jid: string, text: string) => {
      sends.push({ jid, text })
      return { id: `m${sends.length}`, remoteJid: jid, fromMe: true }
    }),
  },
}))

const { renderProgressService } = await import('../src/services/render-progress.service.js')

function job(over: Partial<RenderJob> = {}): RenderJob {
  return {
    key: 'k1',
    shardId: 'shard-a',
    phone: '2348100000000',
    jid: '2348100000000@s.whatsapp.net',
    courseKey: 'CVE575',
    topic: 'shear force',
    title: 'Shear force',
    scenes: [],
    status: 'rendering',
    attempts: 1,
    lastError: null,
    progress: 0.4,
    stage: 'narrated scene 2 of 5',
    startedAt: new Date(Date.now() - 80_000),
    progressMessage: null,
    videoPath: null,
    playbackUrl: null,
    bytes: null,
    durationSec: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as RenderJob
}

beforeEach(() => {
  active = []
  edits = []
  sends = []
  patches = []
  editSucceeds = true
})

describe('telling a student how their video is going', () => {
  it('sends one message the first time and remembers how to rewrite it', async () => {
    active = [job()]
    await renderProgressService.tick()

    expect(sends).toHaveLength(1)
    expect(patches.at(-1)?.['progressMessage']).toMatchObject({ id: 'm1', fromMe: true })
  })

  /** A dozen updates must not be a dozen notifications. */
  it('rewrites the same message rather than sending another', async () => {
    active = [
      job({
        progressMessage: {
          id: 'm1',
          remoteJid: '2348100000000@s.whatsapp.net',
          fromMe: true,
          sentAt: new Date(),
        },
      }),
    ]
    await renderProgressService.tick()

    expect(edits).toHaveLength(1)
    expect(sends).toHaveLength(0)
  })

  /**
   * WhatsApp refuses an edit about fifteen minutes on, and refuses quietly — so a
   * long render would otherwise write into a void for the rest of its life.
   */
  it('starts a fresh message once the edit window has closed', async () => {
    active = [
      job({
        progressMessage: {
          id: 'm1',
          remoteJid: '2348100000000@s.whatsapp.net',
          fromMe: true,
          sentAt: new Date(Date.now() - 15 * 60 * 1000),
        },
      }),
    ]
    await renderProgressService.tick()

    expect(edits).toHaveLength(0)
    expect(sends).toHaveLength(1)
  })

  /** Refused for any other reason, the update still has to land somewhere. */
  it('falls back to a new message when the edit is refused', async () => {
    editSucceeds = false
    active = [
      job({
        progressMessage: {
          id: 'm1',
          remoteJid: '2348100000000@s.whatsapp.net',
          fromMe: true,
          sentAt: new Date(),
        },
      }),
    ]
    await renderProgressService.tick()

    expect(edits).toHaveLength(1)
    expect(sends).toHaveLength(1)
  })

  /** The number is the renderer's count of finished stages; nothing here estimates. */
  it('reports the progress it was given and the time actually elapsed', async () => {
    active = [job()]
    await renderProgressService.tick()

    expect(sends[0]?.text).toContain('40%')
    expect(sends[0]?.text).toMatch(/1m 2\ds/)
    expect(sends[0]?.text).toContain('narrated scene 2 of 5')
  })

  /** One student's failure must not stop the others being told anything. */
  it('keeps going when one student cannot be reached', async () => {
    active = [job({ key: 'k1', jid: 'bad' }), job({ key: 'k2' })]
    const { notifierService } = await import('../src/services/notifier.service.js')
    vi.mocked(notifierService.sendEditable).mockRejectedValueOnce(new Error('socket down'))

    await renderProgressService.tick()
    expect(sends).toHaveLength(1)
  })
})
