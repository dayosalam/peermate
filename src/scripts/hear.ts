/**
 * Benches transcription against a real recording.
 *
 * The plan said to choose a transcription model on measured accuracy for Nigerian
 * English and Pidgin rather than on documentation claims. This is how. Each variant
 * runs several times because these models are not deterministic, and a single run
 * that happens to get a venue right proves nothing.
 *
 * Score the *entities* — course code, date, time, venue — not whole-transcript
 * wording. "4 p.m." and "4pm" are the same answer; "NLT 1" and "SLT1" are not.
 *
 *   npm run hear -- "/path/to/voice note.mp3"
 *   npm run hear -- "/path/to/note.ogg" --runs 5
 */
import { readFile } from 'node:fs/promises'
import { toFile } from 'openai'
import { closeMongo, connectMongo } from '../db/mongo.js'
import { logger } from '../core/logger.js'
import { getOpenAI } from '../services/openai.client.js'
import { transcriptionService } from '../services/transcription.service.js'

/** What shipped before the glossary: codes that exist in no real group here. */
const OLD_PROMPT =
  'A Nigerian university lecturer speaking to a class group chat about course codes such as CSC 301, STA 202, MAT 111, tests, assignments, deadlines, venues such as LG7 and LT2, and submission times.'

const TYPES: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  webm: 'audio/webm',
}

async function once(
  bytes: Buffer,
  mimeType: string,
  model: string,
  prompt?: string,
): Promise<string> {
  const extension = Object.entries(TYPES).find(([, type]) => type === mimeType)?.[0] ?? 'ogg'
  const file = await toFile(bytes, `voice-note.${extension}`, { type: mimeType })
  const result = await getOpenAI().audio.transcriptions.create({
    file,
    model,
    language: 'en',
    ...(prompt ? { prompt } : {}),
  })
  return result.text.trim()
}

async function main(): Promise<void> {
  const path = process.argv[2]
  if (!path) {
    console.log('usage: npm run hear -- "/path/to/recording.mp3" [--runs 3]')
    return
  }

  const flag = process.argv.indexOf('--runs')
  const runs = flag === -1 ? 3 : Number(process.argv[flag + 1] ?? 3)

  const bytes = await readFile(path)
  const extension = path.split('.').pop()?.toLowerCase() ?? 'ogg'
  const mimeType = TYPES[extension] ?? 'audio/ogg'

  await connectMongo()

  console.log(`\n${path}`)
  console.log(`${Math.round(bytes.length / 1024)}KB · ${mimeType} · ${runs} runs each\n`)

  const variants: Array<[string, string, string | undefined]> = [
    ['whisper-1, old hardcoded prompt', 'whisper-1', OLD_PROMPT],
    ['whisper-1, no prompt', 'whisper-1', undefined],
    ['gpt-4o-transcribe, no prompt', 'gpt-4o-transcribe', undefined],
  ]

  for (const [label, model, prompt] of variants) {
    console.log(`── ${label}`)
    for (let run = 0; run < runs; run += 1) {
      console.log(`   ${await once(bytes, mimeType, model, prompt)}`)
    }
    console.log('')
  }

  // The shipping path, glossary and all. Course keys stand in for a real speaker.
  console.log('── what Peermate actually does today')
  for (let run = 0; run < runs; run += 1) {
    const heard = await transcriptionService.transcribe(bytes, mimeType, {
      courseKeys: ['CVE575', 'CVE581', 'ABE501'],
    })
    const sure = heard.confidence === null ? 'no confidence reported' : heard.confidence.toFixed(3)
    console.log(`   ${heard.text.trim()}   [${sure}]`)
  }

  console.log('\nScore the entities — code, date, time, venue — not the wording.\n')
  await closeMongo()
}

main().catch((error) => {
  logger.error({ err: error }, 'bench failed')
  process.exit(1)
})
