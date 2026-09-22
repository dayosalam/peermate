import { z } from 'zod'

export const SignupProvider = z.enum(['email'])
export type SignupProvider = z.infer<typeof SignupProvider>

/** A landing-page lead. Authentication tokens are verified and then discarded. */
export const LandingSignupSchema = z.object({
  email: z.string().email(),
  name: z.string().nullable().default(null),
  providers: z.array(SignupProvider),
  emailVerified: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
})

export type LandingSignup = z.infer<typeof LandingSignupSchema>
