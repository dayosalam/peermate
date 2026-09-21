import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Group, User } from '../src/models/index.js'

let mine: Group[] = []
let allowed = true
const changed: Array<{ chatJid: string; course: string | null }> = []
const purposes: Array<{ chatJid: string; purpose: string }> = []
const trusted: Array<{ chatJid: string; name: string; role: string }> = []
const ignored: string[] = []
const preferences: Array<{ phone: string; chatJid: string; mode: string }> = []
const forgotten: Array<{ phone: string; chatJid: string }> = []
const collections = new Map<string, string[]>()

vi.mock('../src/repositories/index.js', () => ({
  groupRepository: {
    forStudent: vi.fn(async () => mine),
    byJids: vi.fn(async (jids: string[]) => mine.filter((group) => jids.includes(group.chatJid))),
    findByJid: vi.fn(async (jid: string) => mine.find((g) => g.chatJid === jid) ?? null),
  },
  userRepository: {
    setGroupPreference: vi.fn(async (phone: string, chatJid: string, mode: string) => {
      preferences.push({ phone, chatJid, mode })
    }),
    forgetGroup: vi.fn(async (phone: string, chatJid: string) => {
      forgotten.push({ phone, chatJid })
    }),
  },
  memoryCollectionRepository: {
    add: vi.fn(async (_phone: string, name: string, source?: string) => {
      const values = collections.get(name) ?? []
      if (source && !values.includes(source)) values.push(source)
      collections.set(name, values)
    }),
    remove: vi.fn(async (_phone: string, name: string, source: string) => {
      collections.set(
        name,
        (collections.get(name) ?? []).filter((id) => id !== source),
      )
    }),
    delete: vi.fn(async (_phone: string, name: string) => collections.delete(name)),
    list: vi.fn(async () =>
      [...collections].map(([name, sourceMessageIds]) => ({ name, sourceMessageIds })),
    ),
    find: vi.fn(async (_phone: string, name: string) => {
      const sourceMessageIds = collections.get(name)
      return sourceMessageIds ? { name, sourceMessageIds } : null
    }),
  },
  pendingRepository: { unresolved: vi.fn(async () => []), resolve: vi.fn(), openForGroup: vi.fn() },
  extractionRepository: {},
  messageRepository: {
    findById: vi.fn(async (id: string) => ({
      waMessageId: id,
      fromGroup: true,
      chatJid: 'g1@g.us',
    })),
  },
}))

vi.mock('../src/services/membership.service.js', () => ({
  membershipService: { mayAdminister: vi.fn(async () => allowed) },
}))

vi.mock('../src/services/group.service.js', () => ({
  groupService: {
    setCourse: vi.fn(async (chatJid: string, course: string | null) => {
      changed.push({ chatJid, course })
    }),
    setPurpose: vi.fn(async (chatJid: string, purpose: string) => {
      purposes.push({ chatJid, purpose })
    }),
    trust: vi.fn(async (chatJid: string, name: string, role: string) => {
      trusted.push({ chatJid, name, role })
    }),
    ignore: vi.fn(async (chatJid: string) => {
      ignored.push(chatJid)
    }),
  },
}))

const { toolsByName } = await import('../src/services/agent/tools.js')

const user = { phone: '234', jid: '234@s.whatsapp.net', groupJids: ['g1@g.us'] } as User
const context = { user, jid: '234@s.whatsapp.net' }

function group(over: Partial<Group> = {}): Group {
  return {
    chatJid: 'g1@g.us',
    name: 'CVE 575 — 2025/26',
    defaultCourse: 'CVE 575',
    defaultCourseKey: 'CVE575',
    status: 'approved',
    ...over,
  } as Group
}

const run = (name: string, args: Record<string, unknown>): Promise<string> =>
  toolsByName.get(name)!.run(args, context)

beforeEach(() => {
  user.groupJids = ['g1@g.us']
  user.historicalGroupJids = []
  mine = [group()]
  allowed = true
  changed.length = 0
  purposes.length = 0
  trusted.length = 0
  ignored.length = 0
  preferences.length = 0
  forgotten.length = 0
  collections.clear()
})

/**
 * Authority over a group is being in it. There is no operator, so these tools are the
 * whole of it — and the check is made inside each one, not by whoever called it.
 */
describe('changing a group', () => {
  it('lists only verified shared groups with their exact names', async () => {
    mine = [
      group({ name: 'Engineeering 400Leve', defaultCourse: null, defaultCourseKey: null }),
      group({ chatJid: 'g2@g.us', name: 'Project Team', purpose: 'final-year design project' }),
    ]
    const reply = await run('list_shared_groups', {})
    expect(reply).toMatch(/Engineeering 400Leve/)
    expect(reply).toMatch(/Project Team/)
    expect(reply).toMatch(/final-year design project/)
  })

  it('stores a natural-language group purpose without parsing course codes', async () => {
    const reply = await run('set_group_purpose', {
      group: null,
      purpose: 'all 400-level engineering courses and department notices',
    })
    expect(purposes).toEqual([
      {
        chatJid: 'g1@g.us',
        purpose: 'all 400-level engineering courses and department notices',
      },
    ])
    expect(reply).toMatch(/retains all new content/i)
  })

  it('corrects the course of the one group they are in', async () => {
    await run('set_group_course', { group: null, course: 'CVE 581' })
    expect(changed).toEqual([{ chatJid: 'g1@g.us', course: 'CVE 581' }])
  })

  it('refuses when membership cannot be proved', async () => {
    allowed = false
    await run('set_group_course', { group: null, course: 'CVE 581' })
    expect(changed).toEqual([])
  })

  /** The model can pass any string; this is what makes that harmless. */
  it('resolves nothing for a group they are not in', async () => {
    const reply = await run('set_group_course', { group: 'Some Other Class', course: 'CVE 581' })
    expect(changed).toEqual([])
    expect(reply).toMatch(/not in a group by that name/i)
  })

  it('will not guess which group when they are in several', async () => {
    mine = [group(), group({ chatJid: 'g2@g.us', name: 'ABE 501 class' })]
    user.groupJids = ['g1@g.us', 'g2@g.us']
    await run('set_group_course', { group: null, course: 'CVE 581' })
    expect(changed).toEqual([])
  })

  it('picks the named one when they are in several', async () => {
    mine = [group(), group({ chatJid: 'g2@g.us', name: 'ABE 501 class' })]
    user.groupJids = ['g1@g.us', 'g2@g.us']
    await run('set_group_course', { group: 'ABE 501 class', course: 'ABE 501' })
    expect(changed).toEqual([{ chatJid: 'g2@g.us', course: 'ABE 501' }])
  })

  it('rejects something that is not a course code', async () => {
    const reply = await run('set_group_course', { group: null, course: 'the one on Tuesday' })
    expect(changed).toEqual([])
    expect(reply).toMatch(/not a course code/i)
  })
})

describe('recording who to trust', () => {
  it('records the lecturer for a group they are in', async () => {
    await run('trust_sender', { group: null, name: 'Dr Bello', role: 'lecturer' })
    expect(trusted).toEqual([{ chatJid: 'g1@g.us', name: 'Dr Bello', role: 'lecturer' }])
  })

  it('refuses for a group they cannot be proved to be in', async () => {
    allowed = false
    await run('trust_sender', { group: null, name: 'Dr Bello', role: 'lecturer' })
    expect(trusted).toEqual([])
  })
})

describe('stopping a group', () => {
  it('stops one they are in', async () => {
    await run('stop_reading_group', { group: null })
    expect(ignored).toEqual(['g1@g.us'])
  })

  it('refuses one they are not', async () => {
    allowed = false
    await run('stop_reading_group', { group: null })
    expect(ignored).toEqual([])
  })

  /** Costly and hard to undo, so the agent holds it for a yes before running it. */
  it('is held for confirmation rather than run outright', () => {
    expect(toolsByName.get('stop_reading_group')!.tier).toBe('destructive')
  })
})

describe('personal group controls', () => {
  it('can limit a group to deadline notifications without losing retrieval', async () => {
    const reply = await run('configure_group', { group: 'CVE 575', mode: 'deadlines' })
    expect(preferences).toEqual([{ phone: '234', chatJid: 'g1@g.us', mode: 'deadlines' }])
    expect(reply).toMatch(/deadlines, tests and assignments/i)
  })

  it('can explicitly forget a historically authorized group', async () => {
    user.groupJids = []
    user.historicalGroupJids = ['g1@g.us']
    const reply = await run('configure_group', { group: 'CVE 575', mode: 'forget' })
    expect(forgotten).toEqual([{ phone: '234', chatJid: 'g1@g.us' }])
    expect(reply).toMatch(/no longer available/i)
  })
})

describe('personal memory collections', () => {
  it('saves only an accessible source and lists the collection', async () => {
    await run('organize_memory', { action: 'add', name: 'Exam prep', source_id: 'm1' })
    expect(await run('list_collections', { name: null })).toMatch(/Exam prep \(1\)/)
    expect(await run('list_collections', { name: 'Exam prep' })).toMatch(/source m1/)
  })
})
