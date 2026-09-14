/**
 * Freezes the real group into an anonymised corpus.
 *
 * Evals need material that behaves like the real thing — accented transcripts, code
 * switching, half-remembered course codes, three people saying slightly different
 * dates. Synthetic data has none of that, and a corpus that drifts with the live
 * database cannot show whether a change made retrieval better or the week quieter.
 *
 * Names and numbers are replaced consistently, so "Dr Bello said it and Chidi
 * repeated it" stays two people with the same relationship. Everything that makes a
 * question answerable — timestamps, course codes, which message quoted which — is
 * kept exactly.
 *
 *   npm run export-fixtures
 *
 * The output contains real coursework and real timetables. It is gitignored.
 */
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { closeMongo, connectMongo, getDb } from '../db/mongo.js'
import { logger } from '../core/logger.js'
import type { Extraction, Message, Resource } from '../models/index.js'

const OUT = 'evals/fixtures'

const FIRST_NAMES = [
  'Amina',
  'Chidi',
  'Tunde',
  'Ngozi',
  'Bola',
  'Emeka',
  'Fatima',
  'Segun',
  'Zainab',
  'Ifeanyi',
  'Halima',
  'Obi',
  'Yemi',
  'Kemi',
  'Musa',
  'Adaeze',
]

/** Same input, same alias, every run — so a re-export diffs cleanly. */
function aliasFor(real: string | null, kind: 'person' | 'phone' | 'jid'): string | null {
  if (!real) return null
  const digest = createHash('sha256').update(real).digest('hex')
  const index = parseInt(digest.slice(0, 8), 16)

  if (kind === 'person') {
    // Titles carry authority, and authority decides whether a repeat is news.
    const title = /^(dr|prof|mr|mrs|ms|engr)\b/i.exec(real)
    const name = FIRST_NAMES[index % FIRST_NAMES.length]!
    return title
      ? `${title[1]![0]!.toUpperCase()}${title[1]!.slice(1).toLowerCase()} ${name}`
      : name
  }

  const number = `234${String(index).padStart(10, '0').slice(0, 10)}`
  return kind === 'phone' ? number : `${number}@s.whatsapp.net`
}

async function main(): Promise<void> {
  await connectMongo()
  const db = getDb()
  await mkdir(OUT, { recursive: true })

  const messages = (await db.collection<Message>('messages').find({}).toArray()) as Message[]
  const extractions = (await db
    .collection<Extraction>('extractions')
    .find({})
    .toArray()) as Extraction[]
  const resources = (await db.collection<Resource>('resources').find({}).toArray()) as Resource[]

  const anonymised = messages.map((message) => ({
    ...message,
    _id: undefined,
    senderName: aliasFor(message.senderName, 'person'),
    senderPhone: aliasFor(message.senderPhone, 'phone'),
    senderJid: aliasFor(message.senderJid, 'jid'),
    // Media itself is not exported: the bytes are somebody's coursework and the
    // transcript is what an eval actually reads.
    mediaKey: message.mediaKey ? 'redacted' : null,
  }))

  await writeFile(`${OUT}/messages.json`, JSON.stringify(anonymised, null, 2))
  await writeFile(
    `${OUT}/extractions.json`,
    JSON.stringify(
      extractions.map((row) => ({ ...row, _id: undefined })),
      null,
      2,
    ),
  )
  await writeFile(
    `${OUT}/resources.json`,
    JSON.stringify(
      resources.map((row) => ({
        ...row,
        _id: undefined,
        postedBy: aliasFor(row.postedBy, 'person'),
      })),
      null,
      2,
    ),
  )

  await closeMongo()

  console.log(`\nfrozen into ${OUT}/`)
  console.log(`  messages     ${anonymised.length}`)
  console.log(`  extractions  ${extractions.length}`)
  console.log(`  resources    ${resources.length}`)
  console.log(
    '\nCheck it before sharing: anonymisation renames people, it does not read what they said.\n',
  )
}

main().catch((error) => {
  logger.error({ err: error }, 'export failed')
  process.exit(1)
})
