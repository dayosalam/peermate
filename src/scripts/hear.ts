/**
 * Runs a real recording through the production N-ATLaS ASR path several times.
 *
 * Score the entities — course code, date, time, venue — rather than exact wording.
 * Automatic language confidence is reported separately because it does not measure
 * whether every transcribed word is correct.
 *
 *   npm run hear -- "/path/to/voice note.mp3"
 *   npm run hear -- "/path/to/note.ogg" --runs 5
 */
import { readFile } from 'node:fs/promises'
import { logger } from '../core/logger.js'
import { transcriptionService } from '../services/transcription.service.js'

const TYPES: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  webm: 'audio/webm',
}

async function main(): Promise<void> {
  const path = process.argv[2]
  if (!path) {
    console.log('usage: npm run hear -- "/path/to/recording.mp3" [--runs 3]')
    return
  }

  const flag = process.argv.indexOf('--runs')
  const runs = flag === -1 ? 3 : Number(process.argv[flag + 1] ?? 3)
  if (!Number.isInteger(runs) || runs < 1) throw new Error('--runs must be a positive integer')

  const bytes = await readFile(path)
  const extension = path.split('.').pop()?.toLowerCase() ?? 'ogg'
  const mimeType = TYPES[extension] ?? 'application/octet-stream'

  console.log(`\n${path}`)
  console.log(`${Math.round(bytes.length / 1024)}KB · ${mimeType} · ${runs} N-ATLaS runs\n`)

  for (let run = 0; run < runs; run += 1) {
    const heard = await transcriptionService.transcribe(bytes, mimeType)
    const language =
      heard.languageConfidence === null
        ? heard.language
        : `${heard.language} ${(heard.languageConfidence * 100).toFixed(1)}%`
    console.log(`   ${heard.text.trim()}   [${language}]`)
  }

  console.log('\nScore the entities — code, date, time, venue — not the wording.\n')
}

main().catch((error) => {
  logger.error({ err: error }, 'N-ATLaS ASR bench failed')
  process.exit(1)
})
