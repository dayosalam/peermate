import { describe, expect, it, vi } from 'vitest'
import type { LandingSignup } from '../src/models/index.js'
import type { LandingSignupInput } from '../src/repositories/landing-signup.repository.js'
import {
  LandingSignupService,
  SignupInputError,
  type LandingSignupStore,
} from '../src/services/landing-signup.service.js'

function signup(input: LandingSignupInput): LandingSignup {
  return {
    email: input.email,
    name: input.name,
    providers: [input.provider],
    emailVerified: input.emailVerified,
    createdAt: new Date('2026-09-22T10:00:00Z'),
    updatedAt: new Date('2026-09-22T10:00:00Z'),
  }
}

function harness() {
  const stored: LandingSignupInput[] = []
  const store: LandingSignupStore = {
    upsert: vi.fn(async (input: LandingSignupInput) => {
      stored.push(input)
      return signup(input)
    }),
    recent: vi.fn(async () => []),
  }
  return {
    stored,
    service: new LandingSignupService(store),
  }
}

describe('landing signup', () => {
  it('normalises an email signup before storing it', async () => {
    const { service, stored } = harness()

    await service.email({ email: '  STUDENT@Example.COM ', name: '  Ada Student  ' })

    expect(stored).toEqual([
      {
        email: 'student@example.com',
        name: 'Ada Student',
        provider: 'email',
        emailVerified: false,
      },
    ])
  })

  it('rejects invalid email input without writing it', async () => {
    const { service, stored } = harness()

    await expect(service.email({ email: 'not-an-email' })).rejects.toBeInstanceOf(SignupInputError)
    expect(stored).toHaveLength(0)
  })
})
