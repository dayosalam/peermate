import type { Shard } from '../models/index.js'
import { BaseRepository } from './base.repository.js'

export class ShardRepository extends BaseRepository<Shard> {
  protected readonly collectionName = 'shards'

  async findById(shardId: string): Promise<Shard | null> {
    return this.collection.findOne({ shardId } as never) as Promise<Shard | null>
  }

  /**
   * Records this process as the live holder of its number.
   *
   * `startedAt` is only written on first registration so a restart does not look
   * like a new shard, while `lastSeenAt` moves — together they are how an operator
   * tells a shard that is running from one that died holding a session.
   */
  async announce(shard: Shard): Promise<void> {
    await this.collection.updateOne({ shardId: shard.shardId } as never, {
      $set: {
        phoneNumber: shard.phoneNumber,
        status: shard.status,
        authDir: shard.authDir,
        lastSeenAt: shard.lastSeenAt,
      } as never,
      $setOnInsert: { shardId: shard.shardId, startedAt: shard.startedAt } as never,
    })
  }

  async touch(shardId: string): Promise<void> {
    await this.collection.updateOne({ shardId } as never, {
      $set: { lastSeenAt: new Date() } as never,
    })
  }

  async all(): Promise<Shard[]> {
    return this.collection.find({}).toArray() as Promise<Shard[]>
  }
}

export const shardRepository = new ShardRepository()
