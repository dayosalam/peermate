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

describe('student-first onboarding', () => {
  it('starts by asking for the student name', async () => {
    const reply = await onboardingService.handle(said('hi'))
    expect(reply).toMatch(/what should I call you/i)
    expect(stored!.onboardingState).toBe('awaiting_name')
    expect(stored!.displayName).toBeNull()
    expect(stored!.automaticReminders).toBe(true)
  })

  it('asks for a timetable after learning the name', async () => {
    await onboardingService.handle(said('hi'))
    const reply = await onboardingService.handle(said('Amina'))
    expect(reply).toMatch(/send me your current timetable/i)
    expect(stored!.displayName).toBe('Amina')
    expect(stored!.onboardingState).toBe('awaiting_timetable')
  })

  it('lets the timetable confirmation handler receive yes or no', async () => {
    await onboardingService.handle(said('hi'))
    stored = {
      ...stored!,
      displayName: 'Amina',
      onboardingState: 'awaiting_timetable_confirmation',
    }

    expect(await onboardingService.handle(said('yes'))).toBeNull()
    expect(stored!.onboardingState).toBe('awaiting_timetable_confirmation')
  })

  it('does not treat a question as the student name', async () => {
    await onboardingService.handle(said('hi'))
    const reply = await onboardingService.handle(said('when is the CSC 301 test?'))
    expect(reply).toMatch(/what should I call you/i)
    expect(stored!.displayName).toBeNull()
  })

  it('accepts a class reminder preference and completes registration', async () => {
    await onboardingService.handle(said('hi'))
    stored = { ...stored!, displayName: 'Amina', onboardingState: 'awaiting_reminder' }
    const reply = await onboardingService.handle(said('30 minutes before'))
    expect(stored!.onboardingState).toBe('registered')
    expect(stored!.classReminderMinutes).toBe(30)
    expect(reply).toMatch(/add Peermate/i)
    expect(reply).toMatch(/which groups are we in together/i)
  })

  it('accepts a fifteen-minute class reminder preference', async () => {
    await onboardingService.handle(said('hi'))
    stored = { ...stored!, displayName: 'Amina', onboardingState: 'awaiting_reminder' }

    await onboardingService.handle(said('15mins'))
    expect(stored!.onboardingState).toBe('registered')
    expect(stored!.classReminderMinutes).toBe(15)
  })

  it('leaves a registered user out of onboarding', async () => {
    await onboardingService.handle(said('hi'))
    stored = { ...stored!, onboardingState: 'registered', registeredAt: new Date() }
    const before = { ...stored }
    expect(await onboardingService.handle(said('restart'))).toBeNull()
    expect(stored).toEqual(before)
  })
})

describe('optional profile helpers', () => {
  it('still reads names and digest preferences for settings tools', () => {
    expect(onboardingService.readName("i'm chidi")).toBe('Chidi')
    expect(onboardingService.parseDigestPreference('6am voice')).toEqual({
      hour: 6,
      format: 'voice',
    })
  })
})
