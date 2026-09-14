import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Group, User } from '../src/models/index.js'

let groups: Group[] = []
let added: Array<{ phone: string; chatJid: string }> = []
let participants: Record<string, string[]> = {}
let metadataFails = false

vi.mock('../src/repositories/index.js', () => ({
  groupRepository: {
    approved: vi.fn(async () => groups.filter((g) => g.status === 'approved')),
    pending: vi.fn(async () => groups.filter((g) => g.status === 'pending')),
  },
  userRepository: {
    addGroup: vi.fn(async (phone: string, chatJid: string) => {
      added.push({ phone, chatJid })
    }),
  },
}))

vi.mock('../src/whatsapp/socket.js', () => ({
  getSocket: () => ({
    groupMetadata: async (chatJid: string) => {
      if (metadataFails) throw new Error('socket is down')
      return { participants: (participants[chatJid] ?? []).map((id) => ({ id })) }
    },
  }),
}))

const { membershipService } = await import('../src/services/membership.service.js')

function group(over: Partial<Group>): Group {
  return {
    chatJid: '111@g.us',
    name: 'CVE 575',
    defaultCourse: 'CVE 575',
    defaultCourseKey: 'CVE575',
    status: 'approved',
    shardId: 'alpha',
    addedBy: null,
    addedByName: null,
    participantCount: 40,
    trustedSenders: [],
    proposedCourse: null,
    proposedBy: null,
    joinedAt: new Date(),
    approvedAt: new Date(),
    ...over,
  } as Group
}

const amina = {
  phone: '2348012345678',
  jid: '2348012345678@s.whatsapp.net',
  courseKeys: ['CVE575'],
  groupJids: [],
  shardId: 'alpha',
} as unknown as User

beforeEach(() => {
  groups = []
  added = []
  participants = {}
  metadataFails = false
})

describe('a course code is a claim, not an entitlement', () => {
  it('refuses a cohort to somebody who is not in the room', async () => {
    groups = [group({})]
    participants['111@g.us'] = ['2340000000000@s.whatsapp.net']

    const membership = await membershipService.subscribe(amina)

    expect(membership.joined).toEqual([])
    expect(membership.uncovered).toEqual(['CVE575'])
    expect(added).toEqual([])
  })

  it('admits a student who is in the participant list', async () => {
    groups = [group({})]
    participants['111@g.us'] = ['2348012345678@s.whatsapp.net']

    const membership = await membershipService.subscribe(amina)

    expect(membership.joined).toEqual(['111@g.us'])
    expect(membership.uncovered).toEqual([])
    expect(added).toEqual([{ phone: '2348012345678', chatJid: '111@g.us' }])
  })

  /** Adding the number requires already being in the group, so the act is the proof. */
  it('admits whoever added Peermate without consulting the list', async () => {
    groups = [group({ addedBy: '2348012345678@s.whatsapp.net' })]
    participants['111@g.us'] = []

    expect((await membershipService.subscribe(amina)).joined).toEqual(['111@g.us'])
  })

  it('matches a participant listed by LID rather than by phone', async () => {
    const byLid = { ...amina, jid: '84729384@lid' } as User
    groups = [group({})]
    participants['111@g.us'] = ['84729384@lid']

    expect((await membershipService.subscribe(byLid)).joined).toEqual(['111@g.us'])
  })

  /** A dropped socket must not be what decides who reads a cohort's announcements. */
  it('leaves a group unverified rather than granting it when the check fails', async () => {
    groups = [group({})]
    metadataFails = true

    const membership = await membershipService.subscribe(amina)

    expect(membership.joined).toEqual([])
    expect(membership.unverified).toEqual(['111@g.us'])
    expect(added).toEqual([])
  })

  /**
   * A DM belongs to a number. Subscribing them to a group only another number can
   * see would promise alerts that can never be delivered.
   */
  it('never offers a group served by a different bot number', async () => {
    groups = [group({ shardId: 'beta' })]
    participants['111@g.us'] = ['2348012345678@s.whatsapp.net']

    const membership = await membershipService.subscribe(amina)

    expect(membership.joined).toEqual([])
    expect(membership.uncovered).toEqual(['CVE575'])
  })

  it('never offers a group for a course they do not take', async () => {
    groups = [group({ chatJid: '999@g.us', defaultCourseKey: 'BIO101' })]
    participants['999@g.us'] = ['2348012345678@s.whatsapp.net']

    expect((await membershipService.subscribe(amina)).joined).toEqual([])
  })

  /**
   * A departmental group carries no course, so nothing in their timetable points at
   * it. Being in the room is the whole of the claim.
   */
  it('admits a departmental group on membership alone', async () => {
    groups = [group({ chatJid: '333@g.us', defaultCourse: null, defaultCourseKey: null })]
    participants['333@g.us'] = ['2348012345678@s.whatsapp.net']

    expect((await membershipService.subscribe(amina)).joined).toEqual(['333@g.us'])
  })
})

/**
 * Authority over a group is being in it. There is no operator above everyone, so a
 * group added by somebody who never writes to Peermate has to be claimable by anyone
 * else in the room — otherwise one absent person strands a whole class.
 */
describe('claiming a group nobody has switched on', () => {
  it('offers a pending group to somebody proved to be in it', async () => {
    groups = [group({ chatJid: 'g9@g.us', status: 'pending', defaultCourseKey: null })]
    participants = { 'g9@g.us': ['2348012345678@s.whatsapp.net'] }

    const mine = await membershipService.claimable(amina)
    expect(mine.map((g) => g.chatJid)).toEqual(['g9@g.us'])
  })

  it('offers nothing to somebody who is not in it', async () => {
    groups = [group({ chatJid: 'g9@g.us', status: 'pending', defaultCourseKey: null })]
    participants = { 'g9@g.us': ['2349999999999@s.whatsapp.net'] }

    expect(await membershipService.claimable(amina)).toEqual([])
  })

  it('never offers a group that is already being read', async () => {
    groups = [group({ chatJid: 'g9@g.us', status: 'approved', defaultCourseKey: null })]
    participants = { 'g9@g.us': ['2348012345678@s.whatsapp.net'] }

    expect(await membershipService.claimable(amina)).toEqual([])
  })

  /** A dropped socket must not be what hands somebody a cohort. */
  it('offers nothing when membership cannot be checked', async () => {
    groups = [group({ chatJid: 'g9@g.us', status: 'pending', defaultCourseKey: null })]
    metadataFails = true

    expect(await membershipService.claimable(amina)).toEqual([])
  })
})

describe('who may change a group', () => {
  it('allows somebody proved to be in it', async () => {
    const it0 = group({ chatJid: 'g9@g.us', status: 'approved' })
    participants = { 'g9@g.us': ['2348012345678@s.whatsapp.net'] }
    expect(await membershipService.mayAdminister(amina, it0)).toBe(true)
  })

  it('refuses somebody who is not', async () => {
    const it0 = group({ chatJid: 'g9@g.us', status: 'approved' })
    participants = { 'g9@g.us': ['2349999999999@s.whatsapp.net'] }
    expect(await membershipService.mayAdminister(amina, it0)).toBe(false)
  })

  it('refuses when the check cannot complete', async () => {
    const it0 = group({ chatJid: 'g9@g.us', status: 'approved' })
    metadataFails = true
    expect(await membershipService.mayAdminister(amina, it0)).toBe(false)
  })
})
