import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Group, User } from '../src/models/index.js'

let pending: Group[] = []
let approved: Group[] = []

vi.mock('../src/repositories/index.js', () => ({
  groupRepository: {
    pending: vi.fn(async () => pending),
    approved: vi.fn(async () => approved),
    forStudent: vi.fn(async (jids: string[]) =>
      approved.filter((group) => jids.includes(group.chatJid)),
    ),
  },
}))

vi.mock('../src/services/membership.service.js', () => ({
  membershipService: { claimable: vi.fn(async () => pending) },
}))

const { guidanceService } = await import('../src/services/guidance.service.js')

function group(over: Partial<Group>): Group {
  return {
    chatJid: '120363430457309406@g.us',
    name: 'Peermate',
    defaultCourse: null,
    defaultCourseKey: null,
    status: 'pending',
    shardId: 'default',
    addedBy: null,
    addedByName: null,
    participantCount: 2,
    proposedCourse: null,
    proposedBy: null,
    approvedBy: null,
    trustedSenders: [],
    joinedAt: new Date(),
    approvedAt: null,
    ...over,
  }
}

const student: User = {
  phone: '2348100000000',
  jid: '2348100000000@s.whatsapp.net',
  name: null,
  displayName: 'Amina',
  courseKeys: ['CVE575', 'STA202'],
  groupJids: ['g1@g.us'],
  shardId: 'default',
  onboardingState: 'registered',
  registeredAt: new Date(),
  lastDigestAt: null,
  digestFormat: 'text',
  digestHour: 6,
  quietFrom: 22,
  quietTo: 6,
  pausedUntil: null,
  paused: false,
  digestPaused: false,
  alertLevel: 'all',
  mutedCourseKeys: [],
}

beforeEach(() => {
  pending = []
  approved = []
})

/**
 * The gate matters as much as the answers. "How do I approve it?" is about Peermate;
 * "how do I get to LG7?" is about the world, and answering it with instructions would
 * be worse than searching the archive for it.
 */
describe('telling a question about Peermate from a question about a course', () => {
  it('recognises a how-to about Peermate', () => {
    for (const text of [
      'how do I approve it?',
      'How do I approve the group',
      'how can I add a course',
      'how do I stop the morning messages',
      'what does approve mean?',
      'how i go take remove a course',
      'how does this work',
    ]) {
      expect(guidanceService.looksLikeAboutPeermate(text), text).toBe(true)
    }
  })

  it('leaves a question about the world to retrieval', () => {
    for (const text of [
      'how do I get to LG7?',
      'when is the CVE 575 test?',
      'how many questions are in the test',
      'who said that?',
      'how did he say it would be graded',
    ]) {
      expect(guidanceService.looksLikeAboutPeermate(text), text).toBe(false)
    }
  })
})

/**
 * The regression: asking this got "I haven't heard anything about that yet", because
 * the question went to the archive instead of to Peermate's own knowledge of itself.
 */
describe('"how do I switch a group on?"', () => {
  it('names a group they are in that is waiting on them', async () => {
    pending = [group({ chatJid: 'g1@g.us', proposedCourse: 'CVE 575' })]

    const answer = await guidanceService.answer(student, 'how do I approve it?')
    expect(answer).toMatch(/CVE 575/)
    // The mistake this stops: replying inside the group, which is never read.
    expect(answer).toMatch(/in this chat/i)
  })

  it('asks for the code when nothing suggests one', async () => {
    pending = [group({ chatJid: 'g1@g.us', name: 'Dept Notices', defaultCourse: null })]

    const answer = await guidanceService.answer(student, 'how do I approve it?')
    expect(answer).toMatch(/Dept Notices/)
    expect(answer).toMatch(/course code/i)
  })

  it('tells them how to start one when none is waiting', async () => {
    const answer = await guidanceService.answer(student, 'how do I approve it?')
    expect(answer).toMatch(/add me to your course group/i)
  })

  /**
   * There is no operator to wait for any longer. Saying somebody else has to approve
   * it would be false, and would leave them waiting on a person who does not exist.
   */
  it('never sends them to somebody else for permission', async () => {
    pending = [group({ chatJid: 'g1@g.us', proposedCourse: 'CVE 575' })]

    const answer = await guidanceService.answer(student, 'how do I approve it?')
    expect(answer).not.toMatch(/operator/i)
    expect(answer).not.toMatch(/waiting for approval/i)
  })
})

describe('the other things people ask how to do', () => {
  it('answers about courses with what they are already watching', async () => {
    const answer = await guidanceService.answer(student, 'how do I add a course?')
    expect(answer).toMatch(/add MTH 101/)
    expect(answer).toMatch(/CVE 575/)
  })

  it('answers about files using a course they actually take', async () => {
    const answer = await guidanceService.answer(student, 'how do I get the slides?')
    expect(answer).toMatch(/CVE 575 resources/)
  })

  it('answers about the digest with their own delivery time', async () => {
    const answer = await guidanceService.answer(student, 'how do I change the digest?')
    expect(answer).toMatch(/6am/)
  })

  it('answers about going quiet without mentioning anything being lost', async () => {
    const answer = await guidanceService.answer(student, 'how do I stop the alerts?')
    expect(answer).toMatch(/pause until Monday/)
    expect(answer).toMatch(/Nothing is lost/i)
  })

  /** Everyone gets the same answer: there is no second, privileged set of commands. */
  it('mentions no admin powers, because nobody has any', async () => {
    const answer = await guidanceService.answer(student, 'how does this work?')
    expect(answer).not.toMatch(/admin/i)
    expect(answer).not.toMatch(/operator/i)
  })
})

/**
 * The regression: "What group have you been approved for?" was answered with "that's
 * outside what I do" — when Peermate is the only thing in the world that knows.
 */
describe('asking what it is actually set up to read', () => {
  it('recognises a question about its own state', () => {
    for (const text of [
      'What group have you been approved for?',
      'which groups are you reading',
      'what groups have you been approved for',
      'are you reading the group?',
      'how many groups are you connected to',
    ]) {
      expect(guidanceService.looksLikeAboutPeermate(text), text).toBe(true)
    }
  })

  it('leaves a question about a classmate to retrieval', () => {
    for (const text of ['what group did he post that in?', 'which group had the test']) {
      expect(guidanceService.looksLikeAboutPeermate(text), text).toBe(false)
    }
  })

  it('names the groups it reads and the course each is filed under', async () => {
    approved = [
      group({
        chatJid: 'g1@g.us',
        status: 'approved',
        shardId: 'default',
        name: 'Peermate',
        defaultCourse: 'CVE 575',
        defaultCourseKey: 'CVE575',
      }),
    ]

    const answer = await guidanceService.answer(student, 'what group have you been approved for?')
    expect(answer).toMatch(/Peermate/)
    expect(answer).toMatch(/CVE 575/)
  })

  /** A course with no group behind it is a course they will never hear about. */
  // The leak this exists for: coverage was read from every approved group on the
  // deployment, so a student was shown another university's cohort by name and told a
  // course was connected because somebody else's group carried the code.
  it('never names a group the student is not in', async () => {
    approved = [
      group({
        chatJid: 'someone-else@g.us',
        name: 'UNILAG CVE 575 — 2025/26',
        status: 'approved',
        defaultCourse: 'CVE 575',
        defaultCourseKey: 'CVE575',
      }),
    ]

    const answer = await guidanceService.answer(student, 'which groups are you reading?')
    expect(answer).not.toMatch(/UNILAG/)
    expect(answer).not.toMatch(/CVE 575/)
    expect(answer).toMatch(/not reading any group/i)
  })

  it('warns about their courses that no group covers', async () => {
    approved = [
      group({
        chatJid: 'g1@g.us',
        status: 'approved',
        defaultCourse: 'CVE 575',
        defaultCourseKey: 'CVE575',
      }),
    ]

    const answer = await guidanceService.answer(student, 'which groups are you reading?')
    expect(answer).toMatch(/Nothing connected yet for STA 202/)
  })

  // The approval queue is every group on the deployment, other cohorts' included, so
  // a student is told one exists without being shown what is in it.
  /** A group they are in, waiting on them — nobody else is involved or mentioned. */
  it('names what is waiting on them, and nobody to wait for', async () => {
    pending = [group({ chatJid: 'g1@g.us', name: 'CVE 575 — Class', proposedCourse: 'CVE 575' })]

    const answer = await guidanceService.answer(student, 'are you reading the group?')
    expect(answer).toMatch(/CVE 575 — Class/)
    expect(answer).toMatch(/Waiting on you/i)
    expect(answer).not.toMatch(/operator/i)
  })

  it('says plainly when it is reading nothing at all', async () => {
    const answer = await guidanceService.answer(student, 'which groups are you reading?')
    expect(answer).toMatch(/not reading any group yet/i)
  })
})
