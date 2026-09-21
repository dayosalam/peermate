import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { run } from './ffmpeg.js'

/**
 * One still and one narration track become one segment.
 *
 * Built per scene and concatenated afterwards rather than as a single filtergraph:
 * a twelve-input filtergraph is unreadable, and when one scene's audio is missing it
 * fails with an error that names nothing.
 *
 * The length is set explicitly rather than left to `-shortest`. A looped still has no
 * end of its own, and `-shortest` overshot it by around seven seconds a scene — a
 * four-scene test came out half a minute longer than its audio, ending on a silent
 * slide. It is also what lets one narration track be cut across several captions:
 * each takes its slice by offset and length from the same file.
 */
export async function segment(
  imagePath: string,
  audioPath: string,
  fromSec: number,
  seconds: number,
  out: string,
): Promise<void> {
  await run('ffmpeg', [
    '-y',
    '-loop',
    '1',
    '-i',
    imagePath,
    // Seeking the audio input, not the output: this is the slice of the narration
    // that belongs to this caption.
    '-ss',
    fromSec.toFixed(3),
    '-i',
    audioPath,
    '-c:v',
    'libx264',
    // Still frames: this raises quality at a fraction of the bitrate motion would need.
    '-tune',
    'stillimage',
    '-crf',
    '28',
    '-preset',
    'medium',
    // 2fps, not 25. Nothing moves, and the keyframe interval is what actually decides
    // the file size for static content.
    '-r',
    '2',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '48k',
    '-ac',
    '1',
    '-t',
    seconds.toFixed(3),
    out,
  ])
}

/**
 * Joins the segments without re-encoding.
 *
 * The concat demuxer, not the concat filter: every segment was encoded by the same
 * command with the same settings, so they can be stitched by stream copy. Re-encoding
 * here would cost minutes and a generation of quality for nothing.
 */
export async function concat(segments: string[], dir: string, out: string): Promise<void> {
  const list = join(dir, 'segments.txt')
  await writeFile(list, segments.map((path) => `file '${path}'`).join('\n'))
  await run('ffmpeg', [
    '-y',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    list,
    '-c',
    'copy',
    '-movflags',
    '+faststart',
    out,
  ])
}

/** Encodes a numbered PNG sequence with one narration track. */
export async function animate(
  pattern: string,
  fps: number,
  audioPath: string,
  seconds: number,
  out: string,
): Promise<void> {
  await run('ffmpeg', [
    '-y',
    '-framerate',
    String(fps),
    '-i',
    pattern,
    '-i',
    audioPath,
    '-c:v',
    'libx264',
    '-crf',
    '25',
    '-preset',
    'medium',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '64k',
    '-ac',
    '1',
    '-t',
    seconds.toFixed(3),
    '-movflags',
    '+faststart',
    out,
  ])
}

/** Creates a silent, compact review artifact before narration/stitching is accepted. */
export async function gifPreview(pattern: string, fps: number, out: string): Promise<void> {
  await run('ffmpeg', [
    '-y',
    '-framerate',
    String(fps),
    '-i',
    pattern,
    '-vf',
    'fps=10,scale=640:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=192[p];[s1][p]paletteuse=dither=sierra2_4a',
    '-loop',
    '0',
    out,
  ])
}
