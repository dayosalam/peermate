import type { OnboardingState, User } from '../models/index.js'
import { BaseRepository } from './base.repository.js'

/**
 * Fields added after a student registered are absent from their stored document,
 * and `undefined.includes` throws inside the delivery gate — which would take the
 * whole announcement loop down for everyone who registered before the change.
 */
function withDefaults(user: User | null): User | null {
  if (!user) return null
  return {
    ...user,
    pausedUntil: user.pausedUntil ?? null,
    paused: user.paused ?? false,
    digestPaused: user.digestPaused ?? false,
    alertLevel: user.alertLevel ?? 'all',
    shardId: user.shardId ?? 'default',
    mutedCourseKeys: user.mutedCourseKeys ?? [],
    automaticReminders: user.automaticReminders ?? true,
    classReminderMinutes: user.classReminderMinutes ?? 45,
    // Absent means unscoped, and unscoped must mean nothing rather than everything:
    // a student registered before tenancy existed would otherwise match every group.
    // `npm run backfill-tenancy` fills these in from the groups that carry their
    // courses.
    groupJids: user.groupJids ?? [],
    historicalGroupJids: user.historicalGroupJids ?? [],
    groupPreferences: user.groupPreferences ?? [],
  }
}

export class UserRepository extends BaseRepository<User> {
  protected readonly collectionName = 'users'

  async findByPhone(phone: string): Promise<User | null> {
    const found = (await this.collection.findOne({ phone } as never)) as User | null
    return withDefaults(found)
  }

  async upsert(user: User): Promise<void> {
    await this.collection.updateOne(
      { phone: user.phone } as never,
      { $set: user as never },
      {
        upsert: true,
      },
    )
  }

  /**
   * Moves the digest high-water mark and nothing else.
   *
   * The digest loop reads every student up front and can take minutes to work
   * through them. Writing the whole snapshot back at the end reverted anything they
   * changed in between — a *pause* typed while their own digest was being composed
   * was accepted, answered, and then quietly undone.
   */
  async markDigested(phone: string, at: Date): Promise<void> {
    await this.collection.updateOne({ phone } as never, {
      $set: { lastDigestAt: at } as never,
    })
  }

  async setState(phone: string, onboardingState: OnboardingState): Promise<void> {
    await this.collection.updateOne({ phone } as never, { $set: { onboardingState } as never })
  }

  /**
   * The audience for an instant announcement DM: everyone taking that course *in the
   * group it was announced in*.
   *
   * The group is required. Matching on the course alone sends one university's test
   * date to another university's students, because `courseKey('CSC 301')` is the same
   * string everywhere it is computed.
   */
  async subscribedTo(courseKey: string, chatJid: string, shardId: string): Promise<User[]> {
    const found = (await this.collection
      .find({
        courseKeys: courseKey,
        groupJids: chatJid,
        shardId,
        onboardingState: 'registered',
      } as never)
      .toArray()) as User[]
    return found.map((user) => withDefaults(user)!)
  }

  /**
   * Everyone subscribed to a group, whatever they take.
   *
   * The audience for a department notice, which has no course to narrow by.
   */
  async inGroup(chatJid: string, shardId: string): Promise<User[]> {
    const found = (await this.collection
      .find({ groupJids: chatJid, shardId, onboardingState: 'registered' } as never)
      .toArray()) as User[]
    return found.map((user) => withDefaults(user)!)
  }

  /** Students whose chosen digest hour is now, on one shard. */
  async dueForDigest(hour: number, shardId: string): Promise<User[]> {
    const found = (await this.collection
      .find({ onboardingState: 'registered', digestHour: hour, shardId } as never)
      .toArray()) as User[]
    return found.map((user) => withDefaults(user)!)
  }

  /**
   * Everyone this bot number is responsible for.
   *
   * Every scheduled job iterates students, so without this each shard would send
   * every student a digest and a deadline warning — one copy per number running.
   */
  async onShard(shardId: string): Promise<User[]> {
    const found = (await this.collection
      .find({ onboardingState: 'registered', shardId } as never)
      .toArray()) as User[]
    return found.map((user) => withDefaults(user)!)
  }

  /**
   * Takes a group off every student's record.
   *
   * Used when Peermate is removed from a group or the group is deleted. Their
   * subscriptions to other groups are untouched — losing one room is not losing the
   * product.
   */
  async archiveGroupForAll(chatJid: string): Promise<number> {
    const result = await this.collection.updateMany({ groupJids: chatJid } as never, {
      $pull: { groupJids: chatJid } as never,
      $addToSet: { historicalGroupJids: chatJid } as never,
    })
    return result.modifiedCount
  }

  /**
   * Takes a group off specific students' records.
   *
   * Matches on phone *or* stored JID: group participants now arrive as opaque LIDs,
   * which carry no phone number at all, so a phone-only match would quietly drop
   * nobody and leave a removed student still reading the group.
   */
  async archiveGroupFor(phones: string[], jids: string[], chatJid: string): Promise<number> {
    if (phones.length === 0 && jids.length === 0) return 0
    const result = await this.collection.updateMany(
      {
        $or: [{ phone: { $in: phones } }, { jid: { $in: jids } }],
        groupJids: chatJid,
      } as never,
      {
        $pull: { groupJids: chatJid } as never,
        $addToSet: { historicalGroupJids: chatJid } as never,
      },
    )
    return result.modifiedCount
  }

  /** Records a student as belonging to a group. Idempotent. */
  async addGroup(phone: string, chatJid: string): Promise<void> {
    await this.collection.updateOne({ phone } as never, {
      $addToSet: { groupJids: chatJid } as never,
      $pull: { historicalGroupJids: chatJid } as never,
    })
  }

  async setGroupPreference(
    phone: string,
    chatJid: string,
    mode: 'all' | 'deadlines' | 'paused',
  ): Promise<void> {
    await this.collection.updateOne({ phone } as never, {
      $pull: { groupPreferences: { chatJid } } as never,
    })
    await this.collection.updateOne({ phone } as never, {
      $push: { groupPreferences: { chatJid, mode } } as never,
    })
  }

  async forgetGroup(phone: string, chatJid: string): Promise<void> {
    await this.collection.updateOne({ phone } as never, {
      $pull: {
        groupJids: chatJid,
        historicalGroupJids: chatJid,
        groupPreferences: { chatJid },
      } as never,
    })
  }

  async delete(phone: string): Promise<void> {
    await this.collection.deleteOne({ phone } as never)
  }

  async allRegistered(): Promise<User[]> {
    const found = (await this.collection
      .find({ onboardingState: 'registered' } as never)
      .toArray()) as User[]
    return found.map((user) => withDefaults(user)!)
  }
}

export const userRepository = new UserRepository()
