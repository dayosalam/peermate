import type { RenderJob } from '../models/index.js'
import { BaseRepository } from './base.repository.js'

/** Past this a render has failed for a reason retrying will not fix. */
const MAX_ATTEMPTS = 3

export class RenderJobRepository extends BaseRepository<RenderJob> {
  protected readonly collectionName = 'render_jobs'

  /**
   * Claims the request, or returns false because it is already claimed.
   *
   * The key is what makes a second "explain shear force to me" thirty seconds later
   * free rather than a second render. Rendering costs narration, so a duplicate is
   * money as well as noise.
   */
  async claim(job: RenderJob): Promise<boolean> {
    const result = await this.collection.updateOne(
      { key: job.key } as never,
      { $setOnInsert: job as never },
      { upsert: true },
    )
    return result.upsertedCount === 1
  }

  async find(key: string): Promise<RenderJob | null> {
    return this.collection.findOne({ key } as never) as Promise<RenderJob | null>
  }

  /**
   * The next job to work on, marked as taken in the same operation.
   *
   * findOneAndUpdate rather than a read then a write: two runners polling the same
   * collection would otherwise both see the same pending row and render it twice.
   */
  async take(shardId: string): Promise<RenderJob | null> {
    const result = await this.collection.findOneAndUpdate(
      { shardId, status: 'pending', attempts: { $lt: MAX_ATTEMPTS } } as never,
      { $set: { status: 'rendering', updatedAt: new Date() }, $inc: { attempts: 1 } } as never,
      { sort: { createdAt: 1 }, returnDocument: 'after' },
    )
    return (result as RenderJob | null) ?? null
  }

  async finish(key: string, patch: Partial<RenderJob>): Promise<void> {
    await this.collection.updateOne({ key } as never, {
      $set: { ...patch, updatedAt: new Date() } as never,
    })
  }

  /**
   * Jobs a restart interrupted, put back.
   *
   * A row left at `rendering` means the process died holding it. `attempts` was
   * already incremented when it was taken, so a job that reliably kills the renderer
   * stops after MAX_ATTEMPTS rather than looping.
   */
  async recoverUnfinished(shardId: string): Promise<number> {
    const result = await this.collection.updateMany({ shardId, status: 'rendering' } as never, {
      $set: { status: 'pending', updatedAt: new Date() } as never,
    })
    return result.modifiedCount
  }
}

export const renderJobRepository = new RenderJobRepository()
