import { readFile } from 'node:fs/promises'
import { render } from './index.js'
import { provider } from './narrate.js'

/**
 * Storyboard in, MP4 out. No Mongo, no WhatsApp, no Peermate.
 *
 * The whole point of this package: the pipeline can be run and judged on its own,
 * against a real PDF, before anything in the bot depends on it.
 */
const [, , input, output = 'out/explainer.mp4'] = process.argv

if (!input) {
  console.error('usage: npm run render -- <storyboard.json> [out.mp4]')
  process.exit(1)
}

console.log(`narration: ${provider()}`)

const started = Date.now()
const result = await render(JSON.parse(await readFile(input, 'utf8')), output)

console.log(
  `${result.path}  ${(result.bytes / 1e6).toFixed(1)}MB  ${result.durationSec}s  (rendered in ${Math.round((Date.now() - started) / 1000)}s)`,
)
console.log(
  result.fitsInChat
    ? 'Fits in a WhatsApp chat — send the file.'
    : 'Over the WhatsApp ceiling — this one has to be uploaded and sent as a link.',
)
