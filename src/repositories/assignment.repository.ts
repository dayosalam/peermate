import type { Assignment, AssignmentState } from '../models/index.js'
import { BaseRepository } from './base.repository.js'

export class AssignmentRepository extends BaseRepository<Assignment> {
  protected readonly collectionName = 'assignments'

  async findById(assignmentId: string): Promise<Assignment | null> {
    return this.collection.findOne({ assignmentId } as never) as Promise<Assignment | null>
  }

  /**
   * Creates the work or folds a fresh telling into it.
   *
   * `$setOnInsert` on the identity and `firstSeenAt` means a correction arriving
   * later updates the deadline without resetting when the class first heard of it.
   */
  async record(assignment: Assignment): Promise<void> {
    await this.collection.updateOne(
      { assignmentId: assignment.assignmentId } as never,
      {
        $set: {
          course: assignment.course,
          title: assignment.title,
          dueDate: assignment.dueDate,
          dueTime: assignment.dueTime,
          updatedAt: assignment.updatedAt,
        } as never,
        $setOnInsert: {
          assignmentId: assignment.assignmentId,
          chatJid: assignment.chatJid,
          courseKey: assignment.courseKey,
          cancelled: false,
          firstSeenAt: assignment.firstSeenAt,
        } as never,
        $addToSet: { eventIds: { $each: assignment.eventIds } } as never,
      },
      { upsert: true },
    )
  }

  async cancel(assignmentId: string): Promise<void> {
    await this.collection.updateOne({ assignmentId } as never, {
      $set: { cancelled: true, updatedAt: new Date() } as never,
    })
  }

  /** Everything still outstanding for a student, within the groups they belong to. */
  async open(courseKeys: string[], groupJids: string[]): Promise<Assignment[]> {
    if (groupJids.length === 0) return []
    return this.collection
      .find({
        chatJid: { $in: groupJids },
        courseKey: { $in: courseKeys },
        cancelled: false,
      } as never)
      .sort({ dueDate: 1 })
      .toArray() as Promise<Assignment[]>
  }
}

export class AssignmentStateRepository extends BaseRepository<AssignmentState> {
  protected readonly collectionName = 'assignment_states'

  async find(phone: string, assignmentId: string): Promise<AssignmentState | null> {
    return this.collection.findOne({
      phone,
      assignmentId,
    } as never) as Promise<AssignmentState | null>
  }

  async forStudent(phone: string, assignmentIds: string[]): Promise<AssignmentState[]> {
    if (assignmentIds.length === 0) return []
    return this.collection
      .find({ phone, assignmentId: { $in: assignmentIds } } as never)
      .toArray() as Promise<AssignmentState[]>
  }

  async set(state: AssignmentState): Promise<void> {
    await this.collection.updateOne(
      { phone: state.phone, assignmentId: state.assignmentId } as never,
      {
        $set: { status: state.status, updatedAt: state.updatedAt } as never,
        $push: { history: { $each: state.history } } as never,
        $setOnInsert: { phone: state.phone, assignmentId: state.assignmentId } as never,
      },
      { upsert: true },
    )
  }
}

export const assignmentRepository = new AssignmentRepository()
export const assignmentStateRepository = new AssignmentStateRepository()
