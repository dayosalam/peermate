import { z } from 'zod'

export const MessageType = z.enum([
  'text',
  'image',
  'audio',
  'document',
  'video',
  'sticker',
  'other',
])
export type MessageType = z.infer<typeof MessageType>

export const ProcessingStatus = z.enum(['pending', 'processing', 'done', 'failed', 'skipped'])
export type ProcessingStatus = z.infer<typeof ProcessingStatus>

/**
 * The contract. Every downstream stage reads this shape, and every citation is
 * assembled from the provenance fields, never from the model's own words.
 */
export const MessageSchema = z.object({
  waMessageId: z.string(),
  chatJid: z.string(),
  senderJid: z.string().nullable(),
  senderPhone: z.string().nullable(),
  senderName: z.string().nullable(),
  fromGroup: z.boolean(),
  timestamp: z.date(),
  type: MessageType,
  text: z.string().nullable(),
  caption: z.string().nullable(),
  quotedMessageId: z.string().nullable(),
  mediaKey: z.string().nullable(),
  mimeType: z.string().nullable(),
  fileName: z.string().nullable(),
  transcript: z.string().nullable(),
  /**
   * How sure the decoder was, 0..1, or null when it did not say.
   *
   * A misheard date reaches the whole class looking exactly as certain as a correct
   * one, so this rides with the transcript and narrows what extraction is allowed to
   * assert from it.
   */
  transcriptConfidence: z.number().nullable().default(null),
  processingStatus: ProcessingStatus,
  processingError: z.string().nullable().default(null),
  /** How many times the pipeline has thrown on this message. Caps automatic retries. */
  processingAttempts: z.number().default(0),
  /** Set after the private searchable copy exists; doubles as the backfill checkpoint. */
  privateIndexedAt: z.date().nullable().optional(),
  ingestedAt: z.date(),
})
export type Message = z.infer<typeof MessageSchema>
