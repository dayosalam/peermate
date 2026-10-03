import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Extraction, Message, User } from '../src/models/index.js'

let stored: Extraction[] = []
const superseded: Array<{ eventId: string; by: string }> = []
const sent: string[] = []

vi.mock('../src/repositories/index.js', () => ({
  extractionRepository: {
    findSimilar: vi.fn(async () => null),
    findChanged: vi.fn(async (candidate: Extraction) => {
      if (!candidate.date || (!candidate.time && !candidate.venue)) return null
      return (
        stored.find(
          (row) =>
            row.courseKey === candidate.courseKey &&
            row.eventType === candidate.eventType &&
            row.date === candidate.date &&
            row.eventId !== candidate.eventId &&
            row.supersededBy === null &&
            ((candidate.time && row.time && row.time !== candidate.time) ||
              (candidate.venue && row.venue && row.venue !== candidate.venue)),
        ) ?? null
      )
    }),
    supersede: vi.fn(async (eventId: string, by: string) => {
      superseded.push({ eventId, by })
    }),
    coursesSeenIn: vi.fn(async () => seenCourses),
    enrich: vi.fn(),
    addCorroboration: vi.fn(),
  },
  userRepository: {
    subscribedTo: vi.fn(async (key: string, chatJid: string) =>
      everyone.filter((user) => user.courseKeys.includes(key) && user.groupJids.includes(chatJid)),
    ),
    inGroup: vi.fn(async (chatJid: string) =>
      everyone.filter((user) => user.groupJids.includes(chatJid)),
    ),
    allRegistered: vi.fn(async () => everyone),
  },
  notificationRepository: { log: vi.fn() },
  groupRepository: { findByJid: vi.fn(async () => null) },
  messageRepository: { findById: vi.fn(async () => null) },
  pendingRepository: { open: vi.fn() },
}))

vi.mock('../src/services/delivery.service.js', () => ({
  deliveryService: {
    send: vi.fn(async (_s: User, body: string) => {
      sent.push(body)
      return true
    }),
  },
}))
vi.mock('../src/services/conversation.service.js', () => ({
  conversationService: { rememberEvent: vi.fn() },
}))
vi.mock('../src/services/notifier.service.js', () => ({ notifierService: { sendText: vi.fn() } }))
vi.mock('../src/services/operator.js', () => ({ operatorJid: vi.fn(async () => null) }))

const { announcementService } = await import('../src/services/announcement.service.js')

let seenCourses: string[] = []

const student = {
  phone: '234',
  jid: '234@s.whatsapp.net',
  courseKeys: ['CVE575'],
  groupJids: ['1@g.us'],
  shardId: 'default',
} as User

/** Another university's student, taking a course this group never carries. */
const other = {
  phone: '235',
  jid: '235@s.whatsapp.net',
  courseKeys: ['ABE501'],
  groupJids: ['2@g.us'],
  shardId: 'default',
} as User

const everyone = [student, other]

function row(over: Partial<Extraction>): Extraction {
  return {
    eventId: `e-${Math.random()}`,
    sourceMessageId: 'src',
    chatJid: '1@g.us',
    course: 'CVE 575',
    courseKey: 'CVE575',
    scope: 'course',
    eventType: 'test',
    title: null,
    originalDateText: 'Friday',
    date: '2026-09-18',
    time: '10:00',
    venue: 'LG7',
    confidence: 0.9,
    authority: 'student',
    corroboratedBy: [],
    supersededBy: null,
    extractedAt: new Date(),
    ...over,
  }
}

const source = {
  waMessageId: 'm',
  senderName: 'Dr Bello',
  type: 'text',
  timestamp: new Date(),
} as Message

beforeEach(() => {
  stored = []
  seenCourses = []
  superseded.length = 0
  sent.length = 0
})

/**
 * The gap this closes: findSimilar deliberately refuses to merge two different
 * venues, because two venues are not one event. Nothing then marked the old row
 * dead, so both survived into digests and reminders and the student was told a venue
 * that had moved two days earlier.
 */
describe('an announcement that changes an earlier one', () => {
  it('reports a conflict instead of choosing between equal-authority sources', async () => {
    stored = [row({ eventId: 'old', venue: 'LG7', authority: 'rep' })]

    await announcementService.notify(
      [row({ eventId: 'new', venue: 'LG8', authority: 'rep' })],
      source,
    )

    expect(superseded).toEqual([])
    expect(sent[0]).toMatch(/conflicting/i)
    expect(sent[0]).toMatch(/cannot safely choose/i)
  })

  /** A higher-authority correction says what changed rather than looking new. */
  it('says what it was when a trusted source corrects it', async () => {
    stored = [row({ eventId: 'old', time: '10:00', venue: 'LG7', authority: 'student' })]

    await announcementService.notify(
      [row({ eventId: 'new', time: '14:00', venue: 'LG8', authority: 'rep' })],
      source,
    )

    expect(sent[0]).toMatch(/changed/i)
    expect(sent[0]).toMatch(/Now:.*2pm, LG8/)
    expect(sent[0]).toMatch(/Was: 10am, LG7/)
  })

  it('lets a lecturer correct a classmate', async () => {
    stored = [row({ eventId: 'old', venue: 'LG7', authority: 'student' })]

    await announcementService.notify(
      [row({ eventId: 'new', venue: 'LG8', authority: 'lecturer' })],
      source,
    )
    expect(superseded).toHaveLength(1)
  })

  /**
   * A classmate does not get to overrule the lecturer. The lower-authority row is
   * retained for audit but points back to the lecturer's current version.
   */
  it('refuses to let a classmate overrule a lecturer', async () => {
    stored = [row({ eventId: 'old', venue: 'LG7', authority: 'lecturer' })]

    await announcementService.notify(
      [row({ eventId: 'new', venue: 'LG8', authority: 'student' })],
      source,
    )
    expect(superseded).toEqual([{ eventId: 'new', by: 'old' }])
    expect(sent[0]).toMatch(/conflicting/i)
    expect(sent[0]).toMatch(/higher authority/i)
  })

  it('leaves an unrelated event alone', async () => {
    stored = [row({ eventId: 'old', date: '2026-09-18', venue: 'LG7' })]

    await announcementService.notify(
      [row({ eventId: 'new', date: '2026-09-25', venue: 'LG8' })],
      source,
    )
    expect(superseded).toHaveLength(0)
  })

  /** A silence is not a correction — it is a shorter telling of the same thing. */
  it('does not treat a missing venue as a change', async () => {
    stored = [row({ eventId: 'old', venue: 'LG7' })]

    await announcementService.notify([row({ eventId: 'new', venue: null, time: '10:00' })], source)
    expect(superseded).toHaveLength(0)
  })
})

describe('announcement wording', () => {
  it('does not repeat a time already present in the written date', async () => {
    await announcementService.notify(
      [row({ originalDateText: 'Wednesday 4pm', time: '16:00', venue: 'ELT' })],
      source,
    )
    expect(sent[0]).toContain('Wednesday 4pm, ELT')
    expect(sent[0]).not.toContain('4pm 4pm')
  })

  it('warns when an audio transcript itself has low confidence', async () => {
    await announcementService.notify([row({ confidence: 0.95 })], {
      ...source,
      type: 'audio',
      transcriptConfidence: 0.62,
    })
    expect(sent[0]).toMatch(/Possible CVE 575 test/i)
    expect(sent[0]).toMatch(/not fully certain/i)
  })
})

/**
 * A departmental group carries both kinds. "CVE 575 test moved" belongs to one course;
 * "no lectures on Friday" belongs to everybody and has no course to file it under —
 * which is indistinguishable from a course that could not be worked out unless the
 * extractor says which it meant.
 */
describe('a department-wide notice', () => {
  const notice = () =>
    row({ scope: 'department', course: null, courseKey: null, eventType: 'meeting', venue: null })

  it('is sent rather than held for the operator to triage', async () => {
    seenCourses = ['CVE575']
    await announcementService.notify([notice()], source)

    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatch(/Department notice/i)
    expect(sent[0]).toMatch(/for everybody/i)
  })

  /** Otherwise a civil engineering notice reaches the biology cohort. */
  it('goes to everyone subscribed to that group and nobody else', async () => {
    seenCourses = ['CVE575']
    await announcementService.notify([notice()], source)
    expect(sent).toHaveLength(1)
  })

  /**
   * The audience used to be inferred from the courses the group had carried, which
   * fell back to *every registered student* before it had carried any. Subscription
   * is recorded now, so there is nothing to infer and nothing to fall back to.
   */
  it('reaches nobody before anyone has subscribed to the group', async () => {
    seenCourses = []
    student.groupJids = []
    await announcementService.notify([notice()], source)
    expect(sent).toHaveLength(0)
    student.groupJids = ['1@g.us']
  })

  /** Two unrelated notices are not one event told twice. */
  it('is never deduped or superseded against a course announcement', async () => {
    stored = [row({ eventId: 'old', venue: 'LG7' })]
    seenCourses = ['CVE575']

    await announcementService.notify([notice()], source)
    expect(superseded).toHaveLength(0)
  })
})
