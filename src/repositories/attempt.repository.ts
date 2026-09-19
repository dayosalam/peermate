import type { Attempt } from '../models/index.js'
import { BaseRepository } from './base.repository.js'

export interface TopicScore {
  topic: string
  asked: number
  right: number
}

export class AttemptRepository extends BaseRepository<Attempt> {
  protected readonly collectionName = 'quiz_attempts'

  async record(attempts: Attempt[]): Promise<void> {
    if (attempts.length === 0) return
    await this.collection.insertMany(attempts as never[])
  }

  async forCourse(phone: string, courseKey: string, limit = 500): Promise<Attempt[]> {
    return this.collection
      .find({ phone, courseKey } as never)
      .sort({ at: -1 })
      .limit(limit)
      .toArray() as Promise<Attempt[]>
  }

  async recent(phone: string, limit = 500): Promise<Attempt[]> {
    return this.collection
      .find({ phone } as never)
      .sort({ at: -1 })
      .limit(limit)
      .toArray() as Promise<Attempt[]>
  }

  /** Everything this student ever answered. Removed when they ask to be forgotten. */
  async clear(phone: string): Promise<void> {
    await this.collection.deleteMany({ phone } as never)
  }
}

export const attemptRepository = new AttemptRepository()
