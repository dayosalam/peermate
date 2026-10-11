import { z } from 'zod'

export const DocType = z.enum(['slides', 'past_questions', 'assignment', 'textbook', 'other'])
export type DocType = z.infer<typeof DocType>

export const ResourceSchema = z.object({
  course: z.string().nullable(),
  courseKey: z.string().nullable(),
  /**
   * The group the file was shared in — the tenancy boundary for the shelf.
   *
   * Nullable only because rows filed before tenancy existed have none; those are
   * quarantined rather than served. See `npm run backfill-tenancy`.
   */
  chatJid: z.string().nullable().default(null),
  docType: DocType,
  fileName: z.string(),
  mediaKey: z.string(),
  mimeType: z.string().nullable(),
  postedBy: z.string().nullable(),
  postedAt: z.date(),
  sourceMessageId: z.string(),
  /** Null until a student explicitly asks Peermate to inspect this file. */
  processedAt: z.date().nullable().optional(),
  processingError: z.string().nullable().optional(),
})
export type Resource = z.infer<typeof ResourceSchema>
