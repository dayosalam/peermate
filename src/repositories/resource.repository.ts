import type { Resource } from '../models/index.js'
import { BaseRepository } from './base.repository.js'

export class ResourceRepository extends BaseRepository<Resource> {
  protected readonly collectionName = 'resources'

  async insert(resource: Resource): Promise<void> {
    await this.collection.insertOne(resource as never)
  }

  /**
   * The shelf for one course, within the groups the student belongs to.
   *
   * A file is only ever offered from a group they are in. Cohorts overlap and a
   * classmate's past questions are worth sharing (PRD §8), but "classmate" has to
   * mean somebody in the same room — not somebody at another university whose
   * course happens to carry the same code.
   */
  async forCourse(courseKey: string, groupJids: string[]): Promise<Resource[]> {
    if (groupJids.length === 0) return []

    return this.collection
      .find({ courseKey, chatJid: { $in: groupJids } } as never)
      .sort({ postedAt: -1 })
      .toArray() as Promise<Resource[]>
  }
}

export const resourceRepository = new ResourceRepository()
