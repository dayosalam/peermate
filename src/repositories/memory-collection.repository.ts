import { randomUUID } from 'node:crypto'
import type { MemoryCollection } from '../models/index.js'
import { BaseRepository } from './base.repository.js'

export class MemoryCollectionRepository extends BaseRepository<MemoryCollection> {
  protected readonly collectionName = 'memory_collections'

  async list(userPhone: string): Promise<MemoryCollection[]> {
    return this.collection
      .find({ userPhone } as never)
      .sort({ updatedAt: -1 })
      .toArray() as Promise<MemoryCollection[]>
  }

  async find(userPhone: string, name: string): Promise<MemoryCollection | null> {
    return this.collection.findOne({
      userPhone,
      name: { $regex: `^${escapeRegex(name)}$`, $options: 'i' },
    } as never) as Promise<MemoryCollection | null>
  }

  async add(userPhone: string, name: string, sourceMessageId?: string): Promise<void> {
    const now = new Date()
    await this.collection.updateOne(
      { userPhone, name } as never,
      {
        $setOnInsert: { collectionId: randomUUID(), userPhone, name, createdAt: now } as never,
        $set: { updatedAt: now } as never,
        ...(sourceMessageId ? { $addToSet: { sourceMessageIds: sourceMessageId } as never } : {}),
      },
      { upsert: true },
    )
  }

  async remove(userPhone: string, name: string, sourceMessageId: string): Promise<void> {
    await this.collection.updateOne(
      { userPhone, name } as never,
      { $pull: { sourceMessageIds: sourceMessageId }, $set: { updatedAt: new Date() } } as never,
    )
  }

  async delete(userPhone: string, name: string): Promise<void> {
    await this.collection.deleteOne({ userPhone, name } as never)
  }
  async clear(userPhone: string): Promise<void> {
    await this.collection.deleteMany({ userPhone } as never)
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
export const memoryCollectionRepository = new MemoryCollectionRepository()
