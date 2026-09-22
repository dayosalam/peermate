import type { LandingSignup, SignupProvider } from '../models/index.js'
import { BaseRepository } from './base.repository.js'

export interface LandingSignupInput {
  email: string
  name: string | null
  provider: SignupProvider
  emailVerified: boolean
}

export class LandingSignupRepository extends BaseRepository<LandingSignup> {
  protected readonly collectionName = 'landing_signups'

  async upsert(input: LandingSignupInput): Promise<LandingSignup> {
    const now = new Date()
    const email = input.email

    // The first write wins the creation time; the second enriches repeat signups
    // while keeping repeat submissions idempotent.
    await this.collection.updateOne(
      { email } as never,
      {
        $setOnInsert: {
          email,
          name: null,
          providers: [],
          emailVerified: false,
          createdAt: now,
          updatedAt: now,
        } as never,
      },
      { upsert: true },
    )

    await this.collection.updateOne({ email } as never, {
      $set: {
        updatedAt: now,
        ...(input.name ? { name: input.name } : {}),
        ...(input.emailVerified ? { emailVerified: true } : {}),
      } as never,
      $addToSet: { providers: input.provider } as never,
    })

    return (await this.collection.findOne({ email } as never)) as LandingSignup
  }

  async recent(limit = 100): Promise<LandingSignup[]> {
    return this.collection
      .find({})
      .sort({ createdAt: -1 })
      .limit(Math.min(Math.max(limit, 1), 500))
      .toArray() as Promise<LandingSignup[]>
  }
}

export const landingSignupRepository = new LandingSignupRepository()
