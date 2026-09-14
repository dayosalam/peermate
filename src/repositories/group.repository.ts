import type { Group } from '../models/index.js'
import { BaseRepository } from './base.repository.js'

export class GroupRepository extends BaseRepository<Group> {
  protected readonly collectionName = 'groups'

  async findByJid(chatJid: string): Promise<Group | null> {
    return this.collection.findOne({ chatJid } as never) as Promise<Group | null>
  }

  async upsert(group: Group): Promise<void> {
    await this.collection.updateOne(
      { chatJid: group.chatJid } as never,
      { $set: group as never },
      {
        upsert: true,
      },
    )
  }

  /** Only approved groups count as coverage — see PRD §7. */
  async approved(): Promise<Group[]> {
    return this.collection.find({ status: 'approved' } as never).toArray() as Promise<Group[]>
  }

  /**
   * The approved groups one student is actually in.
   *
   * `approved()` is the operator's view — every group on the deployment. Answering a
   * student's "what are you listening to?" or "is CSC 301 connected?" from that told
   * them about another university's cohort, and reported a course as covered because
   * somebody else's group carried the code. Coverage is per student, like every other
   * read: empty groups means nothing is covered, never everything.
   */
  async forStudent(groupJids: string[]): Promise<Group[]> {
    if (groupJids.length === 0) return []

    return this.collection
      .find({ status: 'approved', chatJid: { $in: groupJids } } as never)
      .toArray() as Promise<Group[]>
  }

  async pending(): Promise<Group[]> {
    return this.collection.find({ status: 'pending' } as never).toArray() as Promise<Group[]>
  }

  async all(): Promise<Group[]> {
    return this.collection.find({}).toArray() as Promise<Group[]>
  }
}

export const groupRepository = new GroupRepository()
