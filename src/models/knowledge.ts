import { z } from 'zod'

/**
 * One searchable piece of the archive, in Mongo rather than in a second database.
 *
 * Chroma was a separate service holding the only copy of the vectors, which meant two
 * stores to deploy, back up and keep in step — and a filter language that had to be
 * written twice. Atlas does vector and keyword search over the same documents that
 * already hold everything else, so a chunk and the row it came from can be queried
 * together and can never drift apart.
 *
 * `sourceKind` keeps the two things it holds distinct: a `message` is one thing
 * somebody said, whole and never split, so a citation points at a real message. A
 * `document` is one chunk of one file — chunked *within* a file only, so no embedding
 * ever blends two senders.
 */
export const KnowledgeSchema = z.object({
  /** `<waMessageId>:<courseKey>` or `<waMessageId>#<chunk>`, so re-indexing replaces. */
  chunkId: z.string(),
  waMessageId: z.string(),
  /** The tenancy boundary. Every query filters on it before anything else. */
  chatJid: z.string(),
  /** Null for a private upload, which is reached by owner instead. */
  courseKey: z.string().nullable(),
  /** Set only on a student's own material, which nobody else may ever retrieve. */
  ownerPhone: z.string().nullable().default(null),
  sourceKind: z.enum(['message', 'document']),
  text: z.string(),
  embedding: z.array(z.number()),
  senderName: z.string(),
  type: z.string(),
  fileName: z.string().nullable().default(null),
  page: z.number().nullable().default(null),
  /** 'text' from a text layer, 'ocr' from a scan, 'none' when it could not be read. */
  readVia: z.string().default('text'),
  timestamp: z.date(),
})
export type Knowledge = z.infer<typeof KnowledgeSchema>
