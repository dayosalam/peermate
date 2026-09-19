import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { concat, segment } from './assemble.js'
import { download, encodeForDelivery, stitch } from './network.js'
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

/** `done` moves only when a stage really finished — never a timer imitating progress. */
export interface Progress {
  done: number
  total: number
  stage: string
}

export async function render(
  input: unknown,
  out: string,
  onProgress?: (progress: Progress) => void,
): Promise<Rendered> {
  const storyboard: Storyboard = StoryboardSchema.parse(input)
  const work = await mkdtemp(join(tmpdir(), 'peermate-render-'))

  // Three units per scene, two for the whole video. Counted up front so the fraction
  // cannot move backwards when one scene has more captions than another.
  const total = storyboard.scenes.length * 3 + 2
  let done = 0
  const step = (stage: string): void => {
    done += 1
    onProgress?.({ done, total, stage })
  }

  try {
    const clips: string[] = []

    for (const [index, scene] of storyboard.scenes.entries()) {
      const stem = join(work, String(index).padStart(3, '0'))
      const segments: string[] = []

      // Narrated before the frames are drawn: the captions are timed against the
      // audio's real length, so there is nothing to draw until it exists.
      const audio = `${stem}.mp3`
      const spoken = await narrate(scene.narration, audio)
      step(`narrated scene ${index + 1} of ${storyboard.scenes.length}`)

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

      // Stream copy, so it costs nothing, and it is the difference between uploading a
      // handful of files and one per caption.
      const clip = `${stem}-scene.mp4`
      await concat(segments, work, clip)
      clips.push(clip)
      step(`drew scene ${index + 1} of ${storyboard.scenes.length}`)
    }

    await mkdir(dirname(out), { recursive: true })

    const stitched = await stitch(clips, (uploaded) =>
      step(`sent scene ${uploaded} of ${clips.length} to Livepeer`),
    )
    step('stitched on Livepeer')

    const encoded = await encodeForDelivery(stitched)
    await download(encoded, out)
    step('encoded for delivery')

    const { size } = await stat(out)

    return {
      path: out,
      bytes: size,
      playbackUrl: encoded,
      durationSec: Math.round(await durationOf(out)),
      fitsInChat: size <= WHATSAPP_MAX_BYTES,
    }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

export { StoryboardSchema, type Storyboard, type Rendered } from './storyboard.js'
