import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OutboxEntry } from '../src/models/index.js'

let owed: OutboxEntry[] = []
let videos: Array<{ jid: string; bytes: number; caption?: string }> = []
let texts: Array<{ jid: string; text: string }> = []
let cleared: string[] = []
let failed: string[] = []

vi.mock('../src/services/notifier.service.js', () => ({
  notifierService: {
    sendVideo: vi.fn(async (jid: string, video: Buffer, caption?: string) => {
      videos.push({ jid, bytes: video.byteLength, caption })
    }),
    sendText: vi.fn(async (jid: string, text: string) => {
      texts.push({ jid, text })
      return 'wa-1'
    }),
  },
}))

vi.mock('../src/db/minio.js', () => ({
  getMedia: vi.fn(async (key: string) => {
    if (key === 'render/gone.mp4') throw new Error('no such object')
    return Buffer.alloc(900_000)
  }),
}))

vi.mock('../src/repositories/index.js', () => ({
  conversationRepository: { find: vi.fn(async () => null) },
  notificationRepository: { log: vi.fn(async () => undefined) },
  outboxRepository: {
    pending: vi.fn(async () => owed),
    succeeded: vi.fn(async (key: string) => {
      cleared.push(key)
    }),
    failed: vi.fn(async (key: string) => {
      failed.push(key)
    }),
    abandon: vi.fn(async () => undefined),
    claim: vi.fn(async () => true),
  },
}))

const { DeliveryService } = await import('../src/services/delivery.service.js')
const service = new DeliveryService()

function entry(over: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    key: 'render:k1',
    shardId: 'default',
    phone: '2348100000000',
    jid: '2348100000000@s.whatsapp.net',
    body: 'Shear force',
    status: 'pending',
    attempts: 0,
    lastError: null,
    video: {
      mediaKey: 'render/k1.mp4',
      playbackUrl: null,
      bytes: 900_000,
      durationSec: 78,
    },
    solicited: true,
    notBefore: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as OutboxEntry
}

beforeEach(() => {
  owed = []
  videos = []
  texts = []
  cleared = []
  failed = []
})

describe('handing a finished video to the student who asked for it', () => {
  it('sends it in the chat, with the title as the caption', async () => {
    owed = [entry()]
    await service.drainOutbox()

    expect(videos).toHaveLength(1)
    expect(videos[0]?.caption).toBe('Shear force')
    expect(cleared).toEqual(['render:k1'])
  })

  /** Over what WhatsApp carries, the link is the only form that fits. */
  it('sends the link instead when the file is too big for a chat', async () => {
    owed = [
      entry({
        video: {
          mediaKey: 'render/k1.mp4',
          playbackUrl: 'https://example.test/v/k1.mp4',
          bytes: 40_000_000,
          durationSec: 300,
        },
      }),
    ]
    await service.drainOutbox()

    expect(videos).toHaveLength(0)
    expect(texts[0]?.text).toContain('https://example.test/v/k1.mp4')
  })

  /**
   * The row is why this is durable. A send that fails must leave it behind for the
   * next sweep rather than clearing it and losing the render.
   */
  it('leaves the row in place when the send fails', async () => {
    owed = [
      entry({
        video: { mediaKey: 'render/gone.mp4', playbackUrl: null, bytes: 900_000, durationSec: 78 },
      }),
    ]
    await service.drainOutbox()

    expect(cleared).toEqual([])
    expect(failed).toEqual(['render:k1'])
  })

  /** Quiet hours exist for things nobody asked for. This is not one of them. */
  it('does not consult the delivery rules for something they asked for', async () => {
    owed = [entry()]
    const spy = vi.spyOn(service as unknown as { heldReason: () => string | null }, 'heldReason')
    await service.drainOutbox()

    expect(spy).not.toHaveBeenCalled()
    expect(videos).toHaveLength(1)
  })
})
