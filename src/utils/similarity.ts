/**
 * How alike two names are, from 0 to 1.
 *
 * Dice coefficient over character bigrams rather than edit distance: a student types
 * "Engineering 400" for "Engineeering 400Level" — a doubled letter, a missing word, a
 * space that is not there. Bigram overlap forgives all three, where edit distance
 * punishes the missing word in proportion to its length.
 */
export function similarity(a: string, b: string): number {
  const left = bigrams(a)
  const right = bigrams(b)
  if (left.length === 0 || right.length === 0) return 0

  const pool = [...right]
  let shared = 0
  for (const gram of left) {
    const at = pool.indexOf(gram)
    if (at >= 0) {
      shared += 1
      pool.splice(at, 1)
    }
  }
  return (2 * shared) / (left.length + right.length)
}

/**
 * Close enough to put a name to somebody.
 *
 * Deliberately not lower. The name is spoken back to the student, so a threshold that
 * matches loosely would let a vague guess surface a group they are not in — which is
 * the boundary this whole flow exists inside.
 */
export const CLOSE_ENOUGH = 0.6

/** The best match, or null when nothing is close enough to be worth naming. */
export function closestNamed<T extends { name: string | null }>(
  typed: string,
  candidates: T[],
): T | null {
  let best: T | null = null
  let bestScore = 0
  for (const candidate of candidates) {
    if (!candidate.name) continue
    const score = similarity(typed, candidate.name)
    if (score > bestScore) {
      best = candidate
      bestScore = score
    }
  }
  return bestScore >= CLOSE_ENOUGH ? best : null
}

function bigrams(value: string): string[] {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, '')
  const grams: string[] = []
  for (let at = 0; at < normalized.length - 1; at += 1) {
    grams.push(normalized.slice(at, at + 2))
  }
  return grams
}
