import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Assignment, AssignmentState, Extraction, User } from '../src/models/index.js'

/**
 * Work is a thing, not a row in the say-what-was-said ledger.
 *
 * `extractions` is append-only, so a corrected deadline is a *new* row with a new
 * event id. A student's "submitted" hung off that id would be orphaned the moment the
 * lecturer moved the date — which is exactly when they most need it remembered.
 */

let assignments: Assignment[] = []
let states: AssignmentState[] = []

vi.mock('../src/repositories/index.js', () => ({
  assignmentRepository: {
    record: vi.fn(async (assignment: Assignment) => {
      const existing = assignments.find((item) => item.assignmentId === assignment.assignmentId)
      if (existing) {
        existing.dueDate = assignment.dueDate
        existing.dueTime = assignment.dueTime
        existing.title = assignment.title
        existing.eventIds = [...new Set([...existing.eventIds, ...assignment.eventIds])]
        return
      }
      assignments.push({ ...assignment })
    }),
    cancel: vi.fn(async (assignmentId: string) => {
      const found = assignments.find((item) => item.assignmentId === assignmentId)
      if (found) found.cancelled = true
    }),
    open: vi.fn(async (courseKeys: string[], groupJids: string[]) =>
      assignments.filter(
        (item) =>
          !item.cancelled &&
          groupJids.includes(item.chatJid) &&
          courseKeys.includes(item.courseKey),
      ),
    ),
  },
  assignmentStateRepository: {
    find: vi.fn(
      async (phone: string, assignmentId: string) =>
        states.find((item) => item.phone === phone && item.assignmentId === assignmentId) ?? null,
    ),
    forStudent: vi.fn(async (phone: string, ids: string[]) =>
      states.filter((item) => item.phone === phone && ids.includes(item.assignmentId)),
    ),
    set: vi.fn(async (state: AssignmentState) => {
      const existing = states.find(
        (item) => item.phone === state.phone && item.assignmentId === state.assignmentId,
      )
      if (existing) {
        existing.status = state.status
        existing.history.push(...state.history)
        return
      }
      states.push({ ...state, history: [...state.history] })
    }),
  },
}))

const { assignmentService } = await import('../src/services/assignment.service.js')

function announced(over: Partial<Extraction> = {}): Extraction {
  return {
    eventId: `e-${Math.random()}`,
    sourceMessageId: 'src',
    chatJid: '111@g.us',
    course: 'CVE 575',
    courseKey: 'CVE575',
    scope: 'course',
    eventType: 'assignment',
    title: 'Bridge Design Report',
    originalDateText: 'Friday',
    date: '2026-09-18',
    time: '23:59',
    venue: null,
    confidence: 0.9,
    authority: 'lecturer',
    corroboratedBy: [],
    supersededBy: null,
    extractedAt: new Date(),
    ...over,
  } as Extraction
}

const amina = {
  phone: '234',
  courseKeys: ['CVE575'],
  groupJids: ['111@g.us'],
} as User

beforeEach(() => {
  assignments = []
  states = []
})

describe('a piece of work keeps its identity', () => {
  it('survives the deadline being moved', async () => {
    const first = await assignmentService.recordFrom(announced())
    await assignmentService.setStatus(amina.phone, first!.assignmentId, 'submitted')

    // Same work, new date, new event id — a correction, not a second assignment.
    const moved = await assignmentService.recordFrom(
      announced({ date: '2026-09-25', eventId: 'later' }),
    )

    expect(moved!.assignmentId).toBe(first!.assignmentId)
    expect(assignments).toHaveLength(1)
    expect(assignments[0]!.dueDate).toBe('2026-09-25')
    expect(await assignmentService.isDone(amina.phone, first!.assignmentId)).toBe(true)
  })

  it('reads two spellings of one title as one thing', async () => {
    await assignmentService.recordFrom(announced({ title: 'Bridge Design Report' }))
    await assignmentService.recordFrom(announced({ title: 'bridge-design report!!', eventId: 'b' }))

    expect(assignments).toHaveLength(1)
  })

  it('keeps two different pieces of work apart', async () => {
    await assignmentService.recordFrom(announced({ title: 'Bridge Design Report' }))
    await assignmentService.recordFrom(announced({ title: 'Site Visit Write-up', eventId: 'b' }))

    expect(assignments).toHaveLength(2)
  })

  /**
   * The honest failure. With no name and a different day there is nothing to say it
   * is the same work, so it becomes a second row rather than a wrong merge.
   */
  it('falls back to the date when nothing is named', async () => {
    await assignmentService.recordFrom(announced({ title: null }))
    await assignmentService.recordFrom(announced({ title: null, date: '2026-09-25', eventId: 'b' }))

    expect(assignments).toHaveLength(2)
  })

  it('records nothing for work that is neither named nor dated', async () => {
    expect(await assignmentService.recordFrom(announced({ title: null, date: null }))).toBeNull()
  })

  it('ignores anything that is not work', async () => {
    expect(await assignmentService.recordFrom(announced({ eventType: 'lecture' }))).toBeNull()
  })
})

describe('what the student has done with it', () => {
  it('stops reminding once they say it is in', async () => {
    const work = await assignmentService.recordFrom(announced())
    expect(await assignmentService.isDoneFrom(amina.phone, announced())).toBe(false)

    await assignmentService.setStatus(amina.phone, work!.assignmentId, 'submitted')
    expect(await assignmentService.isDoneFrom(amina.phone, announced())).toBe(true)
  })

  it('treats completed the same as submitted for reminders', async () => {
    const work = await assignmentService.recordFrom(announced())
    await assignmentService.setStatus(amina.phone, work!.assignmentId, 'completed')
    expect(await assignmentService.isDone(amina.phone, work!.assignmentId)).toBe(true)
  })

  it('leaves work in play while it is only started', async () => {
    const work = await assignmentService.recordFrom(announced())
    await assignmentService.setStatus(amina.phone, work!.assignmentId, 'in_progress')
    expect(await assignmentService.isDone(amina.phone, work!.assignmentId)).toBe(false)
  })

  it('can be put back after being marked done', async () => {
    const work = await assignmentService.recordFrom(announced())
    await assignmentService.setStatus(amina.phone, work!.assignmentId, 'completed')
    await assignmentService.reopen(amina.phone, work!.assignmentId)

    expect(await assignmentService.isDone(amina.phone, work!.assignmentId)).toBe(false)
  })

  it('keeps every change, so undo has something to read', async () => {
    const work = await assignmentService.recordFrom(announced())
    await assignmentService.setStatus(amina.phone, work!.assignmentId, 'in_progress')
    await assignmentService.setStatus(amina.phone, work!.assignmentId, 'submitted')

    expect(states[0]!.history.map((change) => change.status)).toEqual(['in_progress', 'submitted'])
  })

  /** One piece of work, several obligations: a classmate submitting is not them. */
  it('is per student, not per assignment', async () => {
    const work = await assignmentService.recordFrom(announced())
    await assignmentService.setStatus('999', work!.assignmentId, 'submitted')

    expect(await assignmentService.isDone(amina.phone, work!.assignmentId)).toBe(false)
  })

  it('leaves out what they have finished when listing what is left', async () => {
    const one = await assignmentService.recordFrom(announced({ title: 'Report' }))
    await assignmentService.recordFrom(announced({ title: 'Site Visit', eventId: 'b' }))
    await assignmentService.setStatus(amina.phone, one!.assignmentId, 'submitted')

    const left = await assignmentService.outstanding(amina)
    expect(left.map((item) => item.title)).toEqual(['Site Visit'])
  })

  it('never lists work from a group they are not in', async () => {
    await assignmentService.recordFrom(announced({ chatJid: '999@g.us' }))
    expect(await assignmentService.outstanding(amina)).toEqual([])
  })

  /**
   * `outstanding` hides finished work, which made it the wrong lookup for putting
   * something back — the reply offering "tell me if it isn't done after all" pointed
   * at a list the item had just dropped off.
   */
  it('can still be found once it is marked done', async () => {
    const work = await assignmentService.recordFrom(announced())
    await assignmentService.setStatus(amina.phone, work!.assignmentId, 'submitted')

    expect(await assignmentService.outstanding(amina)).toEqual([])

    const all = await assignmentService.forCourse(amina, 'CVE575')
    expect(all).toHaveLength(1)
    expect(all[0]!.status).toBe('submitted')
  })

  it('drops cancelled work from what is outstanding', async () => {
    await assignmentService.recordFrom(announced())
    await assignmentService.cancelFrom(announced())

    expect(await assignmentService.outstanding(amina)).toEqual([])
  })
})
