import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { concat, segment } from './assemble.js'
import { cues } from './captions.js'
import { durationOf, narrate } from './narrate.js'
import { frame, prepare } from './slides.js'
import { StoryboardSchema, type Rendered, type Storyboard } from './storyboard.js'

/**
 * What WhatsApp will carry as a video in the chat.
 *
 * Matches the bot's own `research.maxFileBytes`. Exceeding it is not a failure and is
 * not thrown on: a long explainer is uploaded and sent as a playback link instead. It
 * is reported rather than decided here because this package cannot reach WhatsApp and
 * has no business guessing what the caller will do about it.
 */
export const WHATSAPP_MAX_BYTES = 15_000_000

export async function render(input: unknown, out: string): Promise<Rendered> {
  const storyboard: Storyboard = StoryboardSchema.parse(input)
  const work = await mkdtemp(join(tmpdir(), 'peermate-render-'))

  try {
    const segments: string[] = []

    for (const [index, scene] of storyboard.scenes.entries()) {
      const stem = join(work, String(index).padStart(3, '0'))

      // Narrated before the frames are drawn: the captions are timed against the
      // audio's real length, so there is nothing to draw until it exists.
      const audio = `${stem}.mp3`
      const spoken = await narrate(scene.narration, audio)

      const visual = await prepare(scene.visual)
      const lines = cues(scene.narration, spoken)

      // A caption changes while the narration continues, so a scene becomes one
      // segment per caption — all sharing the same audio, each taking its slice of it.
      let offset = 0
      for (const [part, cue] of lines.entries()) {
        const piece = `${stem}-${String(part).padStart(2, '0')}`
        await writeFile(`${piece}.png`, frame(visual, scene.source, cue))
        await segment(`${piece}.png`, audio, offset, cue.seconds, `${piece}.mp4`)
        segments.push(`${piece}.mp4`)
        offset += cue.seconds
      }
    }

    await mkdir(dirname(out), { recursive: true })
    await concat(segments, work, out)

    const { size } = await stat(out)

    return {
      path: out,
      bytes: size,
      durationSec: Math.round(await durationOf(out)),
      fitsInChat: size <= WHATSAPP_MAX_BYTES,
    }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

export { StoryboardSchema, type Storyboard, type Rendered } from './storyboard.js'
