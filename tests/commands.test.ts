import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { User } from '../src/models/index.js'

const saved: User[] = []
let pendingAction: 'confirm_wipe' | 'awaiting_name' | null = null

const cleared: string[] = []
const deleted: string[] = []

vi.mock('../src/repositories/index.js', () => ({
  userRepository: {
    upsert: vi.fn(async (user: User) => {
      saved.push(user)
    }),
    findByPhone: vi.fn(async () => saved.at(-1) ?? null),
    delete: vi.fn(async (phone: string) => deleted.push(`user:${phone}`)),
  },
  groupRepository: { approved: vi.fn(async () => []), forStudent: vi.fn(async () => []) },
  scheduleRepository: { clear: vi.fn(async (phone: string) => cleared.push(`schedules:${phone}`)) },
  attemptRepository: { clear: vi.fn(async (phone: string) => cleared.push(`attempts:${phone}`)) },
  assignmentStateRepository: {
    clear: vi.fn(async (phone: string) => cleared.push(`assignment_states:${phone}`)),
  },
  notificationRepository: {
    clear: vi.fn(async (phone: string) => cleared.push(`notifications:${phone}`)),
  },
  outboxRepository: { clear: vi.fn(async (phone: string) => cleared.push(`outbox:${phone}`)) },
  renderJobRepository: {
    clear: vi.fn(async (phone: string) => cleared.push(`render_jobs:${phone}`)),
  },
  messageRepository: {
    privateFor: vi.fn(async () => []),
    deletePrivate: vi.fn(async (phone: string) => deleted.push(`messages:${phone}`)),
  },
  memoryCollectionRepository: {
    clear: vi.fn(async (phone: string) => deleted.push(`collections:${phone}`)),
  },
}))

vi.mock('../src/services/conversation.service.js', () => ({
  conversationService: {
    get: vi.fn(async () => (pendingAction ? { pendingAction } : null)),
    expect: vi.fn(async (_phone: string, action: typeof pendingAction) => {
      pendingAction = action
    }),
    forget: vi.fn(async () => {
      pendingAction = null
    }),
  },
}))

/** Breaks the import chain into Baileys; nothing here sends anything. */
vi.mock('../src/services/notifier.service.js', () => ({
  notifierService: { sendText: vi.fn() },
}))

vi.mock('../src/services/indexing.service.js', () => ({
  indexingService: {
    deletePrivate: vi.fn(async (phone: string) => deleted.push(`knowledge:${phone}`)),
  },
}))

vi.mock('../src/services/deletion.service.js', () => ({
  deletionService: {
    request: vi.fn(async (user: User) => {
      const phone = user.phone
      deleted.push(
        `user:${phone}`,
        `messages:${phone}`,
        `knowledge:${phone}`,
        `collections:${phone}`,
      )
      cleared.push(
        `schedules:${phone}`,
        `attempts:${phone}`,
        `assignment_states:${phone}`,
        `notifications:${phone}`,
        `outbox:${phone}`,
        `render_jobs:${phone}`,
      )
      pendingAction = null
      return true
    }),
  },
}))

const { studentCommandsService } = await import('../src/services/student-commands.service.js')

function student(over: Partial<User> = {}): User {
  return {
    phone: '2348100000000',
    jid: '2348100000000@s.whatsapp.net',
    name: 'Amina B',
    displayName: 'Amina',
    courseKeys: ['CSC301', 'STA202'],
    groupJids: ['g1@g.us'],
    shardId: 'default',
    onboardingState: 'registered',
    registeredAt: new Date(),
    lastDigestAt: null,
    digestFormat: 'text',
    digestHour: 7,
    quietFrom: 22,
    quietTo: 6,
    pausedUntil: null,
    paused: false,
    digestPaused: false,
    alertLevel: 'all',
    mutedCourseKeys: [],
    ...over,
  }
}

/**
 * What DmService does now: a pending answer is literal, everything else is a
 * settings instruction the agent decided to apply.
 */
const command = async (user: User, text: string): Promise<string | null> =>
  (await studentCommandsService.resolvePending(user, text.trim())) ??
  studentCommandsService.apply(user, text)

const last = (): User => saved.at(-1)!

beforeEach(() => {
  saved.length = 0
  pendingAction = null
  deleted.length = 0
})

describe('being asked to be quiet', () => {
  it('turns automatic reminders off and back on without deleting dates', async () => {
    expect(await command(student(), 'turn automatic reminders off')).toMatch(
      /still remember dates/i,
    )
    expect(last().automaticReminders).toBe(false)

    expect(await command(last(), 'turn reminders on')).toMatch(/reminders are on/i)
    expect(last().automaticReminders).toBe(true)
  })

  it('changes how early class reminders arrive', async () => {
    expect(await command(student(), 'make the reminder 30mins before class')).toMatch(
      /30 minutes before each class/i,
    )
    expect(last().classReminderMinutes).toBe(30)
    expect(last().automaticReminders).toBe(true)
  })

  it('pauses with no end when they name none', async () => {
    await command(student(), 'stop messaging me')
    expect(last().paused).toBe(true)
    expect(last().pausedUntil).toBeNull()
  })

  it('pauses until a day they name', async () => {
    await command(student(), 'pause until Monday')
    expect(last().paused).toBe(false)
    expect(last().pausedUntil).toBeInstanceOf(Date)
  })

  /**
   * "Stop sending morning messages" is not "stop sending messages". Reading it as a
   * full pause silences the test alerts they never asked to lose.
   */
  it('takes the digest alone when the digest is what they named', async () => {
    await command(student(), 'stop sending me morning messages')
    expect(last().digestPaused).toBe(true)
    expect(last().paused).toBe(false)
  })

  it('mutes one course when they name one', async () => {
    await command(student(), 'mute STA 202')
    expect(last().mutedCourseKeys).toEqual(['STA202'])
    expect(last().paused).toBe(false)
  })

  it('lifts everything on resume', async () => {
    const quiet = student({ paused: true, digestPaused: true, pausedUntil: new Date() })
    await command(quiet, 'resume')
    expect(last().paused).toBe(false)
    expect(last().pausedUntil).toBeNull()
    expect(last().digestPaused).toBe(false)
  })

  it('narrows to urgent without silencing the digest', async () => {
    await command(student(), 'only urgent')
    expect(last().alertLevel).toBe('urgent')
    expect(last().digestPaused).toBe(false)
  })

  it('understands an opt-in request for important group alerts', async () => {
    expect(await command(student(), 'notify me whenever something important is posted')).toMatch(
      /tests, deadlines and venue changes/i,
    )
    expect(last().alertLevel).toBe('urgent')
  })
})

describe('destructive commands', () => {
  it('never wipes on the first ask', async () => {
    const reply = await command(student(), 'remove everything')
    expect(saved).toHaveLength(0)
    expect(reply).toMatch(/yes/i)
    expect(pendingAction).toBe('confirm_wipe')
  })

  it('wipes only after an explicit yes', async () => {
    await command(student(), 'delete my data')
    await command(student(), 'yes')
    expect(deleted).toContain('user:2348100000000')
  })

  /**
   * Starting afresh has to mean afresh. Their timetable, quiz history and settings all
   * survived a wipe, so re-registering met a Peermate that still knew their classes.
   */
  it('leaves nothing of theirs in any collection', async () => {
    cleared.length = 0
    await command(student(), 'delete my data')
    await command(student(), 'yes')

    expect(cleared.sort()).toEqual(
      [
        'assignment_states:2348100000000',
        'attempts:2348100000000',
        'notifications:2348100000000',
        'outbox:2348100000000',
        'render_jobs:2348100000000',
        'schedules:2348100000000',
      ].sort(),
    )
  })

  /** A wipe promises Peermate stops messaging them; a queued row would do it anyway. */
  it('drops what was already queued to send them', async () => {
    cleared.length = 0
    await command(student(), 'delete my data')
    await command(student(), 'yes')
    expect(cleared).toContain('outbox:2348100000000')
  })

  /** The tenancy boundary travels with the number, so it cannot outlive the account. */
  it('deletes the account that carried their retrieval scope', async () => {
    await command(student(), 'delete my data')
    await command(student(), 'yes')
    expect(deleted).toContain('user:2348100000000')
    expect(deleted).toContain('messages:2348100000000')
    expect(deleted).toContain('knowledge:2348100000000')
  })

  it('leaves everything alone on anything else', async () => {
    await command(student(), 'forget me')
    await command(student(), 'no')
    expect(saved).toHaveLength(0)
  })

  /** An abandoned confirmation must not swallow the next real question. */
  it('drops the question rather than answering it for them', async () => {
    await command(student(), 'remove everything')
    const reply = await command(student(), 'when is the CSC 301 test?')
    expect(reply).toBeNull()
    expect(saved).toHaveLength(0)
  })

  it('does not read "remove CSC 301" as removing everything', async () => {
    await command(student(), 'remove CSC 301')
    expect(last().courseKeys).toEqual(['STA202'])
    expect(last().onboardingState).toBe('registered')
  })
})

describe('how people actually type', () => {
  it('ignores politeness in front of a command', async () => {
    expect(await command(student(), 'abeg help')).toMatch(/what I can do/i)
  })

  it('repairs a one-word typo', async () => {
    expect(await command(student(), 'helpp')).toMatch(/what I can do/i)
    expect(await command(student(), 'setings')).toMatch(/digest/i)
  })

  it('leaves a real question alone', async () => {
    expect(await command(student(), 'who can help me with CSC 301?')).toBeNull()
    expect(await command(student(), 'when did the lecturer stop?')).toBeNull()
  })

  it('reads Pidgin forms of the commands it knows', async () => {
    await command(student(), 'comot STA 202')
    expect(last().courseKeys).toEqual(['CSC301'])
  })

  it('runs both halves of "add X and remove Y"', async () => {
    const reply = await command(student(), 'add MTH 101 and remove STA 202')
    expect(reply).toMatch(/MTH 101/)
    expect(reply).toMatch(/STA 202/)
    expect(last().courseKeys).toEqual(['CSC301', 'MTH101'])
  })

  it('takes a new name straight from the message', async () => {
    await command(student(), 'call me Ada')
    expect(last().displayName).toBe('Ada')
  })

  it('asks which name when they only said they want to change it', async () => {
    const reply = await command(student(), 'change my name')
    expect(reply).toMatch(/what should I call you/i)
    await command(student(), 'Chidi')
    expect(last().displayName).toBe('Chidi')
  })
})
