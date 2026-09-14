import type { OutboxEntry } from '../models/index.js'
import { BaseRepository } from './base.repository.js'

export class OutboxRepository extends BaseRepository<OutboxEntry> {
  protected readonly collectionName = 'outbox'

  /**
   * Claims the slot for one message.
   *
   * Returns false when it is already there, which is what makes the whole thing safe
   * to run twice: a restart mid-send must not produce a second copy of a test alert.
   */
  async claim(entry: OutboxEntry): Promise<boolean> {
    try {
      await this.collection.insertOne(entry as never)
      return true
    } catch (error) {
      if ((error as { code?: number }).code === 11000) return false
      throw error
    }
  }

  async succeeded(key: string): Promise<void> {
    await this.collection.updateOne({ key } as never, {
      $set: { status: 'sent', updatedAt: new Date() } as never,
    })
  }

  async failed(key: string, message: string): Promise<void> {
    await this.collection.updateOne({ key } as never, {
      $set: { lastError: message, updatedAt: new Date() } as never,
      $inc: { attempts: 1 } as never,
    })
  }

  async abandon(key: string): Promise<void> {
    await this.collection.updateOne({ key } as never, {
      $set: { status: 'abandoned', updatedAt: new Date() } as never,
    })
  }

  /** What this shard still owes and may send now, oldest first. */
  async pending(shardId: string, limit = 50): Promise<OutboxEntry[]> {
    return this.collection
      .find({ shardId, status: 'pending', notBefore: { $lte: new Date() } } as never)
      .sort({ createdAt: 1 })
      .limit(limit)
      .toArray() as Promise<OutboxEntry[]>
  }
}

export const outboxRepository = new OutboxRepository()
