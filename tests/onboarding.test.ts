import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message, User } from '../src/models/index.js'

let stored: User | null = null

vi.mock('../src/repositories/index.js', () => ({
  userRepository: {
    findByPhone: vi.fn(async () => stored),
    upsert: vi.fn(async (user: User) => {
      stored = user
    }),
  },
  groupRepository: { approved: vi.fn(async () => []), forStudent: vi.fn(async () => []) },
}))

const { onboardingService } = await import('../src/services/onboarding.service.js')
const PHONE = '2348100000000'

function said(text: string): Message {
  return {
    waMessageId: `m-${Math.random()}`,
    chatJid: `${PHONE}@s.whatsapp.net`,
    senderJid: `${PHONE}@s.whatsapp.net`,
    senderPhone: PHONE,
    senderName: 'Amina Bello',
    fromGroup: false,
    timestamp: new Date(),
    type: 'text',
    text,
    caption: null,
    quotedMessageId: null,
    mediaKey: null,
    mimeType: null,
    fileName: null,
    transcript: null,
    transcriptConfidence: null,
    processingStatus: 'done',
    processingError: null,
    processingAttempts: 0,
    ingestedAt: new Date(),
  }
}

beforeEach(() => {
  stored = null
})

describe('registration without a setup gate', () => {
  it('registers on first contact and explains immediate capabilities', async () => {
    const reply = await onboardingService.handle(said('hi'))
    expect(reply).toMatch(/remember messages, files and voice notes/i)
    expect(reply).toMatch(/courses and groups are optional/i)
    expect(stored!.onboardingState).toBe('registered')
    expect(stored!.displayName).toBe('Amina Bello')
    expect(stored!.automaticReminders).toBe(true)
  })

  it('accepts an optional course list without requiring another step', async () => {
    await onboardingService.handle(said('CSC 301 and MTH 101'))
    expect(stored!.courseKeys).toEqual(['CSC301', 'MTH101'])
    expect(stored!.onboardingState).toBe('registered')
  })

  it('does not treat a course mentioned in a question as enrolment', async () => {
    await onboardingService.handle(said('when is the CSC 301 test?'))
    expect(stored!.courseKeys).toEqual([])
  })

  it('leaves a registered user out of onboarding', async () => {
    await onboardingService.handle(said('hi'))
    const before = { ...stored! }
    expect(await onboardingService.handle(said('restart'))).toBeNull()
    expect(stored).toEqual(before)
  })

  it('migrates an account stranded in the old onboarding flow', async () => {
    await onboardingService.handle(said('hi'))
    stored = { ...stored!, onboardingState: 'awaiting_courses', registeredAt: null }
    expect(await onboardingService.handle(said('what did I miss?'))).toMatch(/start right here/i)
    expect(stored!.onboardingState).toBe('registered')
    expect(stored!.registeredAt).toBeInstanceOf(Date)
  })
})

describe('optional profile helpers', () => {
  it('still reads names and digest preferences for settings tools', () => {
    expect(onboardingService.readName("i'm chidi")).toBe('Chidi')
    expect(onboardingService.parseDigestPreference('6am voice')).toEqual({ hour: 6, format: 'voice' })
  })
})
