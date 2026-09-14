import type { Candidate } from './retrieval.service.js'

/** Past questions are what a test actually looks like, so they lead the material. */
const PAST_QUESTION_HINT = /past|pq|exam|question|paper|test/i

/**
 * Enough of the material to cover a course without burying the model. Chunks are
 * sampled across files rather than taken in order — the first forty chunks of a
 * hundred-page slide deck are the introduction, which is not what a test is about.
 */
const CHUNKS_USED = 40

/**
 * Spreads the sample across the files, past papers first.
 *
 * Taking the first N chunks gives the model one file's opening pages, which is how a
 * whole revision set ends up being about the course outline.
 */
export function sample(material: Candidate[], limit = CHUNKS_USED): Candidate[] {
  const byFile = new Map<string, Candidate[]>()
  for (const chunk of material) {
    const key = chunk.fileName ?? 'unknown'
    byFile.set(key, [...(byFile.get(key) ?? []), chunk])
  }

  const files = [...byFile.entries()].sort(
    (a, b) => Number(PAST_QUESTION_HINT.test(b[0])) - Number(PAST_QUESTION_HINT.test(a[0])),
  )

  const picked: Candidate[] = []
  let round = 0
  while (picked.length < limit) {
    const taken = picked.length
    for (const [, chunks] of files) {
      const chunk = chunks[round]
      if (chunk) picked.push(chunk)
      if (picked.length >= limit) break
    }
    if (picked.length === taken) break
    round += 1
  }
  return picked
}

/**
 * Excerpts headed by the file and page they came from.
 *
 * The header is not decoration: it is what the model copies into a citation, so a
 * claim can be traced back to the page a lecturer actually wrote it on.
 */
export function format(material: Candidate[]): string {
  return material
    .map(
      (chunk) =>
        `[${chunk.fileName ?? 'shared file'}${chunk.page ? `, p.${chunk.page}` : ''}]\n${chunk.content}`,
    )
    .join('\n\n')
}
