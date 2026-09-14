import { z } from 'zod'

/**
 * A message Peermate owes somebody.
 *
 * Inbound work has always been durable — `messages` is written before anything is
 * attempted and `recoverUnfinished()` picks up whatever a restart interrupted.
 * Outbound had none of that: `withRetry` tried three times in memory and then threw,
 * and the reminder was gone with no row anywhere to find it by. A student never
 * learns that the thing they needed failed to send.
 *
 * Written before the attempt, cleared on success. Anything still here is owed.
 *
 * At-least-once, not exactly-once: a crash between WhatsApp accepting a message and
 * this row being cleared means it is sent again. There is no way to ask Baileys
 * afterwards whether it landed, and a duplicate alert is a smaller failure than a
 * test nobody was told about.
 */
export const OutboxSchema = z.object({
  /** Derived from what is being sent, so the same thing is never queued twice. */
  key: z.string(),
  shardId: z.string(),
  phone: z.string(),
  jid: z.string(),
  body: z.string(),
  status: z.enum(['pending', 'sent', 'abandoned']).default('pending'),
  attempts: z.number().default(0),
  lastError: z.string().nullable().default(null),
  /**
   * Not before this instant.
   *
   * A held alert is already written down while it waits for the conversation to go
   * quiet, so the sweep has to know to leave it alone — otherwise the batch and the
   * sweep both send it. Past this time the wait has failed and the sweep takes over.
   */
  notBefore: z.date(),
  /** Nothing is retried for ever; after this it is an operator's problem, not a loop. */
  createdAt: z.date(),
  updatedAt: z.date(),
})
export type OutboxEntry = z.infer<typeof OutboxSchema>
