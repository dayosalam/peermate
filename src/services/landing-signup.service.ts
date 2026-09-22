import { z } from 'zod'
import type { LandingSignup } from '../models/index.js'
import {
  landingSignupRepository,
  type LandingSignupInput,
} from '../repositories/landing-signup.repository.js'

const EmailSignupInput = z.object({
  email: z
    .string()
    .trim()
    .email()
    .max(254)
    .transform((value) => value.toLowerCase()),
  name: z
    .string()
    .trim()
    .max(100)
    .optional()
    .transform((value) => value || null),
})

export class SignupInputError extends Error {}

export interface LandingSignupStore {
  upsert(input: LandingSignupInput): Promise<LandingSignup>
  recent(limit?: number): Promise<LandingSignup[]>
}

export class LandingSignupService {
  constructor(private readonly store: LandingSignupStore = landingSignupRepository) {}

  async email(input: unknown): Promise<LandingSignup> {
    const parsed = EmailSignupInput.safeParse(input)
    if (!parsed.success) throw new SignupInputError('Enter a valid email address')

    return this.store.upsert({
      email: parsed.data.email,
      name: parsed.data.name,
      provider: 'email',
      emailVerified: false,
    })
  }

  recent(limit?: number): Promise<LandingSignup[]> {
    return this.store.recent(limit)
  }
}

export const landingSignupService = new LandingSignupService()
