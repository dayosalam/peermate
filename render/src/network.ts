import { writeFile } from 'node:fs/promises'
import { runCapability, uploadFile } from './livepeer.js'

/**
 * The half of assembly that runs on Livepeer.
 *
 * A scene is one clip per caption, so an explainer is a dozen pieces; uploading each
 * would be a dozen round trips to do what local ffmpeg does by stream copy. The pieces
 * are built locally and the network does what is one operation on the whole video —
 * stitch, delivery encode, host.
 *
 * No fallback to local assembly: running on Livepeer is the point, so a network that
 * refuses is a failure to report, and the student gets the text and voice note instead.
 */

/** `ffmpeg-concat` takes 2 to 30 clips. Probed: the parameter is `clips`, not `urls`. */
const MAX_CLIPS = 30

/** Every clip must be somewhere the orchestrator can fetch, so each is uploaded first. */
export async function stitch(
  clips: string[],
  onUploaded?: (done: number) => void,
): Promise<string> {
  if (clips.length === 0) throw new Error('nothing to stitch')
  if (clips.length > MAX_CLIPS) {
    throw new Error(`ffmpeg-concat takes at most ${MAX_CLIPS} clips, got ${clips.length}`)
  }

  const urls: string[] = []
  for (const clip of clips) {
    urls.push(await uploadFile(clip, 'video/mp4'))
    onUploaded?.(urls.length)
  }

  // One clip is already the finished video; concat would be a round trip to copy it.
  if (urls.length === 1) return urls[0]!

  const result = await runCapability('ffmpeg-concat', { inputs: { clips: urls } })
  if (!result.url) {
    throw new Error(`ffmpeg-concat returned nothing: ${JSON.stringify(result).slice(0, 200)}`)
  }
  return result.url
}

/** Separate from the stitch: this decides the size, and size decides file or link. */
export async function encodeForDelivery(url: string, preset = '720p'): Promise<string> {
  const result = await runCapability('ffmpeg-export', { source_url: url, inputs: { preset } })
  if (!result.url) {
    throw new Error(`ffmpeg-export returned nothing: ${JSON.stringify(result).slice(0, 200)}`)
  }
  return result.url
}

/** The URL 302s to storage; `fetch` follows it, which is why a `curl` check without `-L` looks empty. */
export async function download(url: string, path: string): Promise<number> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`could not fetch the rendered video: ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  await writeFile(path, bytes)
  return bytes.byteLength
}
