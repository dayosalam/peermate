import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeletionJob, User } from '../src/models/index.js'

let stored: DeletionJob | null = null
let failVectors = false
const calls: string[] = []

vi.mock('../src/db/minio.js', () => ({
  deleteMedia: vi.fn(async (key: string) => calls.push(`media:${key}`)),
}))

vi.mock('../src/repositories/index.js', () => {
  const clear = (name: string) => vi.fn(async (phone: string) => calls.push(`${name}:${phone}`))
  return {
    deletionJobRepository: {
      begin: vi.fn(async (phone: string, mediaKeys: string[]) => {
        stored ??= {
          phone,
          mediaKeys,
          completedSteps: [],
          status: 'pending',
          attempts: 0,
          lastError: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          completedAt: null,
        }
        return structuredClone(stored)
      }),
      unfinished: vi.fn(async () =>
        stored?.status === 'done' ? [] : stored ? [structuredClone(stored)] : [],
      ),
      started: vi.fn(async () => {
        if (stored) stored.status = 'running'
      }),
      completeStep: vi.fn(async (_phone: string, step: DeletionJob['completedSteps'][number]) => {
        stored?.completedSteps.push(step)
      }),
      fail: vi.fn(async (_phone: string, error: unknown) => {
        if (stored) {
          stored.status = 'pending'
          stored.lastError = String(error)
        }
      }),
      finish: vi.fn(async () => {
        if (stored) stored.status = 'done'
      }),
    },
    messageRepository: {
      privateFor: vi.fn(async () => [{ mediaKey: 'private/voice.ogg' }]),
      deletePrivate: clear('messages'),
    },
    memoryCollectionRepository: { clear: clear('collections') },
    scheduleRepository: { clear: clear('schedules') },
    attemptRepository: { clear: clear('attempts') },
    assignmentStateRepository: { clear: clear('assignments') },
    notificationRepository: { clear: clear('notifications') },
    outboxRepository: { clear: clear('outbox') },
    renderJobRepository: { clear: clear('renders') },
    userRepository: { delete: clear('user') },
  }
})

vi.mock('../src/services/conversation.service.js', () => ({
  conversationService: {
    forget: vi.fn(async (phone: string) => calls.push(`conversation:${phone}`)),
  },
}))

vi.mock('../src/services/indexing.service.js', () => ({
  indexingService: {
    deletePrivate: vi.fn(async (phone: string) => {
      calls.push(`vectors:${phone}`)
      if (failVectors) throw new Error('vector store unavailable')
    }),
  },
}))

const { deletionService } = await import('../src/services/deletion.service.js')

const user = { phone: '234', jid: '234@s.whatsapp.net' } as User

beforeEach(() => {
  stored = null
  failVectors = false
  calls.length = 0
})

describe('resumable private deletion', () => {
  it('deletes the account last and records completion', async () => {
    await deletionService.request(user)
    expect(stored?.status).toBe('done')
    expect(calls.at(-1)).toBe('user:234')
    expect(calls).toContain('media:private/voice.ogg')
  })

  it('resumes after the failed step without repeating completed cleanup', async () => {
    failVectors = true
    expect(await deletionService.request(user)).toBe(false)
    expect(stored?.status).toBe('pending')
    expect(calls).not.toContain('user:234')

    const before = [...calls]
    failVectors = false
    expect(await deletionService.recover()).toBe(1)
    expect(calls.filter((call) => call === 'outbox:234')).toHaveLength(1)
    expect(calls.filter((call) => call === 'media:private/voice.ogg')).toHaveLength(1)
    expect(calls.slice(0, before.length)).toEqual(before)
    expect(calls.at(-1)).toBe('user:234')
  })
})
