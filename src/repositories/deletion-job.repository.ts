import type { DeletionJob, DeletionStep } from '../models/index.js'
import { BaseRepository } from './base.repository.js'

export class DeletionJobRepository extends BaseRepository<DeletionJob> {
  protected readonly collectionName = 'deletion_jobs'

  async begin(phone: string, mediaKeys: string[]): Promise<DeletionJob> {
    const now = new Date()
    const existing = (await this.collection.findOne({ phone } as never)) as DeletionJob | null
    if (existing && existing.status !== 'done') return existing

    const fresh: DeletionJob = {
      phone,
      mediaKeys: [...new Set(mediaKeys)],
      completedSteps: [],
      status: 'pending',
      attempts: 0,
      lastError: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    }
    await this.collection.updateOne({ phone } as never, { $set: fresh as never }, { upsert: true })
    return fresh
  }

  async unfinished(): Promise<DeletionJob[]> {
    return this.collection.find({ status: { $ne: 'done' } } as never).toArray() as Promise<
      DeletionJob[]
    >
  }

  async started(phone: string): Promise<void> {
    await this.collection.updateOne({ phone } as never, {
      $set: { status: 'running', updatedAt: new Date(), lastError: null } as never,
      $inc: { attempts: 1 } as never,
    })
  }

  async completeStep(phone: string, step: DeletionStep): Promise<void> {
    await this.collection.updateOne({ phone } as never, {
      $addToSet: { completedSteps: step } as never,
      $set: { updatedAt: new Date() } as never,
    })
  }

  async fail(phone: string, error: unknown): Promise<void> {
    await this.collection.updateOne({ phone } as never, {
      $set: {
        status: 'pending',
        lastError: String(error).slice(0, 500),
        updatedAt: new Date(),
      } as never,
    })
  }

  async finish(phone: string): Promise<void> {
    const now = new Date()
    await this.collection.updateOne({ phone } as never, {
      $set: { status: 'done', lastError: null, updatedAt: now, completedAt: now } as never,
    })
  }
}

export const deletionJobRepository = new DeletionJobRepository()
