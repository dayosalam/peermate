import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Group, User } from '../src/models/index.js'

let stored: Group[] = []
let users: User[] = []
const sent: Array<{ jid: string; text: string }> = []
let proposals: Array<{ phone: string; proposal: unknown }> = []
let failJid: string | null = null

vi.mock('../src/repositories/index.js', () => ({
  groupRepository: {
    findByJid: vi.fn(async (jid: string) => stored.find((g) => g.chatJid === jid) ?? null),
    pending: vi.fn(async () => stored.filter((g) => g.status === 'pending')),
    upsert: vi.fn(async (group: Group) => {
      stored = [...stored.filter((g) => g.chatJid !== group.chatJid), group]
    }),
    claimGroupDisclosure: vi.fn(async (jid: string) => {
      const group = stored.find((one) => one.chatJid === jid)
      if (!group || group.groupDisclosedAt || group.disclosedAt) return false
      group.groupDisclosedAt = new Date()
      return true
    }),
    releaseGroupDisclosure: vi.fn(async (jid: string) => {
      const group = stored.find((one) => one.chatJid === jid)
      if (group) group.groupDisclosedAt = null
    }),
    claimAdderNotice: vi.fn(async (jid: string) => {
      const group = stored.find((one) => one.chatJid === jid)
      if (!group?.addedBy || group.adderNotifiedAt) return false
      group.adderNotifiedAt = new Date()
      return true
    }),
    releaseAdderNotice: vi.fn(async (jid: string) => {
      const group = stored.find((one) => one.chatJid === jid)
      if (group) group.adderNotifiedAt = null
    }),
    undisclosed: vi.fn(async () =>
      stored.filter(
        (one) => !one.groupDisclosedAt || (Boolean(one.addedBy) && !one.adderNotifiedAt),
      ),
    ),
  },
  userRepository: {
    findByPhone: vi.fn(async (phone: string) => users.find((u) => u.phone === phone) ?? null),
    addGroup: vi.fn(async (phone: string, chatJid: string) => {
      users = users.map((user) =>
        user.phone === phone
          ? { ...user, groupJids: [...new Set([...user.groupJids, chatJid])] }
          : user,
      )
    }),
    dropGroupForAll: vi.fn(async () => 0),
    dropGroupFor: vi.fn(async () => 0),
  },
  pendingRepository: { openForGroup: vi.fn(async () => []), resolve: vi.fn() },
}))

vi.mock('../src/services/notifier.service.js', () => ({
  notifierService: {
    sendText: vi.fn(async (jid: string, text: string) => {
      if (jid === failJid) throw new Error('send failed')
      sent.push({ jid, text })
      return 'id'
    }),
  },
}))

vi.mock('../src/services/conversation.service.js', () => ({
  conversationService: {
    proposeGroup: vi.fn(async (phone: string, proposal: unknown) => {
      proposals.push({ phone, proposal })
    }),
  },
}))

vi.mock('../src/services/operator.js', () => ({
  operatorJid: vi.fn(async () => '2349021527907@s.whatsapp.net'),
}))

const { groupService } = await import('../src/services/group.service.js')

const ADDER = '2348100000000'
const ADDER_JID = `${ADDER}@s.whatsapp.net`
const OTHER = '2348100000999'

function student(phone: string): User {
  return {
    phone,
    jid: `${phone}@s.whatsapp.net`,
    displayName: 'Chidi',
    courseKeys: ['CVE575'],
    groupJids: [],
    onboardingState: 'registered',
  } as unknown as User
}

function group(over: Partial<Group> = {}): Group {
  return {
    chatJid: 'g1@g.us',
    name: 'CVE 575 — 2025/26',
    defaultCourse: null,
    defaultCourseKey: null,
    status: 'pending',
    shardId: 'default',
    addedBy: ADDER_JID,
    addedByName: 'Chidi',
    participantCount: 40,
    trustedSenders: [],
    proposedCourse: null,
    proposedBy: null,
    approvedBy: null,
    joinedAt: new Date(),
    approvedAt: null,
    ...over,
  }
}

beforeEach(() => {
  stored = []
  users = [student(ADDER), student(OTHER)]
  sent.length = 0
  proposals = []
  failJid = null
})

describe('who can switch a group on', () => {
  it('lets the person who added Peermate approve it', async () => {
    stored = [group()]
    const outcome = await groupService.propose('g1@g.us', 'CVE 575', 'Chidi', ADDER_JID)

    expect(outcome?.approved).toBe(true)
    expect(stored[0]!.status).toBe('approved')
    expect(stored[0]!.defaultCourseKey).toBe('CVE575')
  })

  /**
   * Anybody can name any group. The check is against the stored adder, so saying you
   * added a group is not the same as having added it.
   */
  it('does not let anyone else switch it on', async () => {
    stored = [group()]
    const outcome = await groupService.propose(
      'g1@g.us',
      'CVE 575',
      'Someone',
      `${OTHER}@s.whatsapp.net`,
    )

    expect(outcome?.approved).toBe(false)
    expect(stored[0]!.status).toBe('pending')
    expect(stored[0]!.proposedCourse).toBe('CVE 575')
  })

  /** A group Peermate was already in when it started has no adder on record. */
  it('never auto-approves a group with no recorded adder', async () => {
    stored = [group({ addedBy: null })]
    const outcome = await groupService.propose('g1@g.us', 'CVE 575', 'Chidi', ADDER_JID)

    expect(outcome?.approved).toBe(false)
    expect(stored[0]!.status).toBe('pending')
  })

  /**
   * Peermate deals with each student separately. A notice about somebody else's
   * cohort is one the reader can neither judge nor act on, and at fifty groups it is
   * fifty messages about strangers.
   */
  it('tells nobody else when a group goes live', async () => {
    stored = [group()]
    await groupService.propose('g1@g.us', 'CVE 575', 'Chidi', ADDER_JID)
    expect(sent).toHaveLength(0)
  })

  it('records who switched it on, since nothing is announced', async () => {
    stored = [group()]
    await groupService.propose('g1@g.us', 'CVE 575', 'Chidi', ADDER_JID)
    expect(stored[0]!.proposedBy).toBe('Chidi')
  })

  it('does not page anyone when someone else names a group either', async () => {
    stored = [group()]
    await groupService.propose('g1@g.us', 'CVE 575', 'Someone', `${OTHER}@s.whatsapp.net`)
    expect(sent).toHaveLength(0)
  })
})

describe('who gets notified when Peermate is added', () => {
  it('confirms privately with a known adder without posting in the group', async () => {
    await groupService.register('g1@g.us', {
      subject: 'CVE 575 — 2025/26',
      addedBy: ADDER_JID,
      addedByName: 'Chidi',
    })

    expect(sent).toHaveLength(1)
    expect(sent[0]!.jid).toBe(ADDER_JID)
    expect(sent[0]!.text).toMatch(/connected/i)
    expect(users[0]!.groupJids).toContain('g1@g.us')
  })

  it('does not infer a course from the group name', async () => {
    await groupService.register('g1@g.us', { subject: 'CVE 575 class', addedBy: ADDER_JID })
    expect(stored[0]!.defaultCourse).toBeNull()
    expect(stored[0]!.defaultCourseKey).toBeNull()
    expect(proposals).toHaveLength(0)
  })

  it('does not invent a course from words ending near a number', async () => {
    await groupService.register('g1@g.us', {
      subject: 'Engineeering 400Leve',
      addedBy: ADDER_JID,
    })
    expect(stored[0]!.name).toBe('Engineeering 400Leve')
    expect(stored[0]!.defaultCourse).toBeNull()
  })

  /**
   * Peermate never opens a conversation with someone who has not written to it, and it
   * no longer hands the question to anybody else. The group simply waits.
   */
  it('does not open a private chat with an unknown adder', async () => {
    users = []
    await groupService.register('g1@g.us', { subject: 'CVE 575 class', addedBy: ADDER_JID })
    expect(sent).toHaveLength(0)
    expect(stored[0]!.status).toBe('approved')
  })

  // Who gets offered it afterwards is membership's decision, not this service's —
  // see tests/membership.test.ts.

  it('stays silent when nobody was recorded as the adder', async () => {
    await groupService.register('g1@g.us', { subject: 'CVE 575 class' })
    expect(sent).toHaveLength(0)
  })

  it('starts learning immediately', async () => {
    await groupService.register('g1@g.us', { subject: 'CVE 575 class', addedBy: ADDER_JID })
    expect(stored[0]!.status).toBe('approved')
  })

  it('retries a failed private confirmation without ever posting in the room', async () => {
    failJid = ADDER_JID
    await expect(
      groupService.register('g1@g.us', { subject: 'CVE 575 class', addedBy: ADDER_JID }),
    ).rejects.toThrow('send failed')
    expect(sent.filter((message) => message.jid === 'g1@g.us')).toHaveLength(0)

    failJid = null
    await groupService.retryDisclosures()
    expect(sent.filter((message) => message.jid === 'g1@g.us')).toHaveLength(0)
    expect(sent.filter((message) => message.jid === ADDER_JID)).toHaveLength(1)
  })
})
