import { describe, expect, it, vi } from 'vitest'
import type { Extraction, User } from '../src/models/index.js'

/**
 * Bugs found by reading the code rather than by anyone reporting them.
 *
 * Every one of these failed silently: a wrong answer, a missing message, or a
 * setting quietly reverted. None would have shown up in a log.
 */

describe('a corrected event is what a referent resolves to', () => {
  it('walks the supersession chain to the current row', async () => {
    const rows: Record<string, Extraction> = {
      first: { eventId: 'first', supersededBy: 'second', venue: 'LG7' } as Extraction,
      second: { eventId: 'second', supersededBy: 'third', venue: 'LG8' } as Extraction,
      third: { eventId: 'third', supersededBy: null, venue: 'LT2' } as Extraction,
    }

    vi.doMock('../src/db/mongo.js', () => ({
      getDb: () => ({
        collection: () => ({
          findOne: async (filter: { eventId: string }) => rows[filter.eventId] ?? null,
        }),
      }),
    }))

    const { extractionRepository } = await import('../src/repositories/extraction.repository.js')
    const current = await extractionRepository.currentFor('first')

    expect(current?.eventId).toBe('third')
    expect(current?.venue).toBe('LT2')
  })

  /** A cycle in the data must not spin the process. */
  it('stops rather than looping when corrections point at each other', async () => {
    const rows: Record<string, Extraction> = {
      a: { eventId: 'a', supersededBy: 'b' } as Extraction,
      b: { eventId: 'b', supersededBy: 'a' } as Extraction,
    }

    vi.doMock('../src/db/mongo.js', () => ({
      getDb: () => ({
        collection: () => ({
          findOne: async (filter: { eventId: string }) => rows[filter.eventId] ?? null,
        }),
      }),
    }))

    vi.resetModules()
    const { extractionRepository } = await import('../src/repositories/extraction.repository.js')
    expect(['a', 'b']).toContain((await extractionRepository.currentFor('a'))?.eventId)
  })
})

describe('a timetable entry moved to a date stops recurring', () => {
  it('clears the weekday explicitly, because $set undefined is dropped', async () => {
    let written: Record<string, unknown> | null = null

    vi.resetModules()
    vi.doMock('../src/db/mongo.js', () => ({
      getDb: () => ({
        collection: () => ({
          updateMany: async (_filter: unknown, update: { $set: Record<string, unknown> }) => {
            written = update.$set
            return { modifiedCount: 1 }
          },
        }),
      }),
    }))

    const { scheduleRepository } = await import('../src/repositories/schedule.repository.js')
    await scheduleRepository.amend('234', 'CVE575', null, { date: '2026-09-18' })

    expect(written).toEqual({ date: '2026-09-18', weekday: null })
  })

  it('clears the date when a dated entry becomes weekly', async () => {
    let written: Record<string, unknown> | null = null

    vi.resetModules()
    vi.doMock('../src/db/mongo.js', () => ({
      getDb: () => ({
        collection: () => ({
          updateMany: async (_filter: unknown, update: { $set: Record<string, unknown> }) => {
            written = update.$set
            return { modifiedCount: 1 }
          },
        }),
      }),
    }))

    const { scheduleRepository } = await import('../src/repositories/schedule.repository.js')
    await scheduleRepository.amend('234', 'CVE575', null, { weekday: 2 })

    expect(written).toEqual({ weekday: 2, date: null })
  })
})

describe('urgent-only still means the urgent things', () => {
  const student = (over: Partial<User>) =>
    ({
      phone: '234',
      alertLevel: 'urgent',
      mutedCourseKeys: [],
      quietFrom: null,
      quietTo: null,
      paused: false,
      pausedUntil: null,
      digestPaused: false,
      ...over,
    }) as User

  it('sends a deadline warning, which used to be suppressed entirely', async () => {
    vi.resetModules()
    const sent: string[] = []
    vi.doMock('../src/services/notifier.service.js', () => ({
      notifierService: {
        sendText: vi.fn(async (_jid: string, body: string) => {
          sent.push(body)
          return 'id'
        }),
      },
    }))
    vi.doMock('../src/repositories/index.js', () => ({
      conversationRepository: { find: vi.fn(async () => null), save: vi.fn() },
      notificationRepository: { log: vi.fn(async () => {}) },
      outboxRepository: {
        claim: vi.fn(async () => true),
        succeeded: vi.fn(async () => {}),
        failed: vi.fn(async () => {}),
      },
    }))
    vi.doMock('../src/services/conversation.service.js', () => ({
      conversationService: { rememberTurn: vi.fn(async () => {}), rememberAlert: vi.fn() },
    }))

    const { deliveryService } = await import('../src/services/delivery.service.js')
    const delivered = await deliveryService.send(student({}), 'assignment due tonight', {
      kind: 'deadline',
      courseKey: 'CVE575',
      eventType: 'deadline',
      eventId: 'e1',
    })

    expect(delivered).toBe(true)
    expect(sent).toHaveLength(1)
  })

  it('still holds a new file, which is never urgent', async () => {
    vi.resetModules()
    vi.doMock('../src/services/notifier.service.js', () => ({
      notifierService: { sendText: vi.fn() },
    }))
    vi.doMock('../src/repositories/index.js', () => ({
      conversationRepository: { find: vi.fn(async () => null), save: vi.fn() },
      notificationRepository: { log: vi.fn(async () => {}) },
    }))

    const { deliveryService } = await import('../src/services/delivery.service.js')
    const delivered = await deliveryService.send(student({}), 'new slides', {
      kind: 'resource',
      courseKey: 'CVE575',
      eventType: null,
      eventId: null,
    })

    expect(delivered).toBe(false)
  })
})
