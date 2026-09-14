import { z } from 'zod'

/**
 * One bot number, one socket, one process.
 *
 * Baileys links a real WhatsApp account as a companion device, and two processes
 * against one auth state desynchronise the Signal ratchet with no way back — so a
 * deployment grows by adding numbers, not replicas. Each shard reads its own groups
 * and speaks to its own students.
 *
 * The blast radius is the point: a banned number costs one shard's ingestion rather
 * than every student's conversation.
 */
export const ShardStatus = z.enum(['active', 'draining', 'dead'])
export type ShardStatus = z.infer<typeof ShardStatus>

export const ShardSchema = z.object({
  shardId: z.string(),
  /** The bot number, once the socket reports who it logged in as. */
  phoneNumber: z.string().nullable().default(null),
  status: ShardStatus.default('active'),
  /**
   * Where this shard's auth state lives, recorded for operators rather than read by
   * the app — losing it means re-pairing that number by hand from its handset.
   */
  authDir: z.string(),
  lastSeenAt: z.date(),
  startedAt: z.date(),
})
export type Shard = z.infer<typeof ShardSchema>
