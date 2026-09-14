/** Two lines at a readable size on a phone. Longer and it is a paragraph, not a caption. */
const PER_LINE = 42
const MAX_LINES = 2

export interface Cue {
  lines: string[]
  seconds: number
}

/**
 * The narration, split into what can be read at once, timed across the scene.
 *
 * Durations are apportioned by character count rather than measured. TTS gives no
 * word-level timestamps, and asking for them would mean a second transcription pass
 * over audio we just generated. Synthetic speech holds a near-constant rate, so
 * proportion-by-length lands within a fraction of a second over a scene — and a
 * caption that changes slightly early is a far smaller fault than one that is absent.
 */
export function cues(narration: string, seconds: number): Cue[] {
  // Wrapped first, then grouped. Truncating a chunk to two lines instead dropped the
  // overflow silently — a twenty-three word sentence was captioned as twenty-two,
  // with the missing word still spoken aloud.
  const groups = split(narration).flatMap((chunk) => group(wrap(chunk, evenly(chunk))))
  const total = groups.reduce((sum, lines) => sum + length(lines), 0)
  if (total === 0) return []

  return groups.map((lines) => ({
    lines,
    seconds: (length(lines) / total) * seconds,
  }))
}

const length = (lines: string[]): number => lines.join(' ').length

/**
 * How wide to wrap this chunk so its lines come out evenly.
 *
 * Wrapping at the full width and letting the remainder fall into a cue of its own left
 * a single word on screen for half a second — correct, and a flicker. Deciding how
 * many cues the chunk needs first, then dividing the text between them, fills every
 * line of every cue instead.
 */
function evenly(chunk: string): number {
  const atFullWidth = Math.max(1, Math.ceil(chunk.length / PER_LINE))
  // A chunk that fits on one line gets one line. Dividing it by MAX_LINES anyway
  // wrapped a twenty-six character sentence at thirteen and split it across two cues.
  if (atFullWidth === 1) return PER_LINE

  const needed = Math.ceil(atFullWidth / MAX_LINES)
  return Math.ceil(chunk.length / (needed * MAX_LINES))
}

/** Consecutive lines of one sentence, at most a screenful at a time. */
function group(lines: string[]): string[][] {
  const groups: string[][] = []
  for (let index = 0; index < lines.length; index += MAX_LINES) {
    groups.push(lines.slice(index, index + MAX_LINES))
  }
  return groups
}

/**
 * Sentences, and long sentences broken at a clause.
 *
 * A sentence is the unit someone reads in one glance. One that will not fit two lines
 * is broken where it already pauses — after a comma, a colon or a dash — rather than
 * mid-phrase, which is what makes a caption hard to follow rather than merely long.
 */
function split(narration: string): string[] {
  const sentences = narration
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean)

  return sentences.flatMap((sentence) => {
    if (sentence.length <= PER_LINE * MAX_LINES) return [sentence]

    const parts: string[] = []
    let current = ''
    for (const piece of sentence.split(/(?<=[,;:—-])\s+/)) {
      if (current && (current + piece).length > PER_LINE * MAX_LINES) {
        parts.push(current.trim())
        current = ''
      }
      current += `${piece} `
    }
    if (current.trim()) parts.push(current.trim())
    return parts
  })
}

function wrap(text: string, perLine: number): string[] {
  const lines: string[] = []
  let current = ''
  for (const word of text.split(/\s+/)) {
    if (current && (current + word).length > perLine) {
      lines.push(current.trim())
      current = ''
    }
    current += `${word} `
  }
  if (current.trim()) lines.push(current.trim())
  return lines
}
