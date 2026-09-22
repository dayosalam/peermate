import { closeMongo, connectMongo } from '../db/mongo.js'
import { landingSignupRepository } from '../repositories/landing-signup.repository.js'

await connectMongo()

try {
  const signups = await landingSignupRepository.recent(500)

  console.table(
    signups.map(({ email, name, providers, emailVerified, createdAt }) => ({
      email,
      name: name ?? '',
      method: providers.join(', '),
      verified: emailVerified,
      signedUpAt: createdAt.toISOString(),
    })),
  )
  console.log(`${signups.length} signup${signups.length === 1 ? '' : 's'}`)
} finally {
  await closeMongo()
}
