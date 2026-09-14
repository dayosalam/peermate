import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Extraction, User } from '../src/models/index.js'

/**
 * Two bot numbers, one database.
 *
 * Baileys holds one socket per number and two processes against one auth state
 * corrupt the session, so a deployment grows by adding numbers. Everything that
 * iterates students therefore has to ask "mine?" first — otherwise every student
 * gets one digest per number running, and an alert leaves through a number the
 * student has never written to.
 */

const ALPHA = 'alpha'
const BETA = 'beta'
const GROUP = '111@g.us'

let people: User[] = []

function matches(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, condition]) => {
    const value = doc[key]
    const held = Array.isArray(value) ? value : [value]
    if (condition !== null && typeof condition === 'object') {
      const [op, operand] = Object.entries(condition as Record<string, unknown>)[0]!
      if (op === '$in') return held.some((item) => (operand as unknown[]).includes(item))
      throw new Error(`unhandled operator ${op}`)
    }
    return held.some((item) => item === condition)
  })
}

vi.mock('../src/db/mongo.js', () => ({
  getDb: () => ({
    collection: () => ({
      find: (filter: Record<string, unknown>) => ({
        sort: () => ({ toArray: async () => people.filter((p) => matches(p, filter)) }),
        toArray: async () => people.filter((p) => matches(p, filter)),
      }),
      findOne: async (filter: Record<string, unknown>) =>
        people.find((p) => matches(p, filter)) ?? null,
    }),
  }),
}))

const { userRepository } = await import('../src/repositories/index.js')

function student(over: Partial<User>): User {
  return {
    phone: '234',
    jid: '234@s.whatsapp.net',
    courseKeys: ['CVE575'],
    groupJids: [GROUP],
    shardId: ALPHA,
    onboardingState: 'registered',
    digestHour: 7,
    ...over,
  } as User
}

beforeEach(() => {
  people = []
})

describe('work is divided by bot number', () => {
  it('gives each scheduled run only its own students', async () => {
    people = [
      student({ phone: '1', shardId: ALPHA }),
      student({ phone: '2', shardId: BETA }),
      student({ phone: '3', shardId: ALPHA }),
    ]

    const mine = await userRepository.onShard(ALPHA)
    expect(mine.map((user) => user.phone)).toEqual(['1', '3'])
  })

  /** Otherwise one student gets one digest per number running. */
  it('never hands the same student to two shards', async () => {
    people = [student({ phone: '1', shardId: ALPHA })]

    expect(await userRepository.onShard(ALPHA)).toHaveLength(1)
    expect(await userRepository.onShard(BETA)).toHaveLength(0)
  })

  it('splits the digest hour by shard too', async () => {
    people = [
      student({ phone: '1', shardId: ALPHA, digestHour: 7 }),
      student({ phone: '2', shardId: BETA, digestHour: 7 }),
    ]

    const due = await userRepository.dueForDigest(7, ALPHA)
    expect(due.map((user) => user.phone)).toEqual(['1'])
  })

  /**
   * A student who wrote to alpha has no conversation with beta. Alerting them from
   * beta would be Peermate writing first, which PRD §7 forbids outright.
   */
  it('never alerts a student through a number they have not written to', async () => {
    people = [
      student({ phone: '1', shardId: ALPHA, groupJids: [GROUP] }),
      student({ phone: '2', shardId: BETA, groupJids: [GROUP] }),
    ]

    const audience = await userRepository.subscribedTo('CVE575', GROUP, ALPHA)
    expect(audience.map((user) => user.phone)).toEqual(['1'])
  })

  it('scopes a department notice to the shard as well as the group', async () => {
    people = [
      student({ phone: '1', shardId: ALPHA, courseKeys: [] }),
      student({ phone: '2', shardId: BETA, courseKeys: [] }),
    ]

    const audience = await userRepository.inGroup(GROUP, BETA)
    expect(audience.map((user) => user.phone)).toEqual(['2'])
  })

  /** A record written before sharding existed belongs to the original number. */
  it('treats a student with no recorded shard as the default one', async () => {
    const legacy = { ...student({ phone: '9' }) } as Record<string, unknown>
    delete legacy['shardId']
    people = [legacy as unknown as User]

    const found = await userRepository.findByPhone('9')
    expect(found!.shardId).toBe('default')
  })
})
