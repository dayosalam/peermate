import { z } from 'zod'

/**
 * One answered question.
 *
 * The quiz itself lives on the conversation and expires with it, which made revision
 * amnesiac: the topics a practice set was built around were rendered into a message
 * and thrown away, so "how am I doing in CVE 575?" had nothing to read. One row per
 * answer is the smallest thing that makes weak topics, score history and progress
 * all answerable, and none of it can be reconstructed later — so it is recorded as
 * it happens or not at all.
 */
export const AttemptSchema = z.object({
  phone: z.string(),
  courseKey: z.string(),
  /** The topic the question was built from, not the question text. */
  topic: z.string(),
  question: z.string(),
  verdict: z.enum(['right', 'close', 'wrong', 'skipped']),
  at: z.date(),
})
export type Attempt = z.infer<typeof AttemptSchema>
