import type { Message, ProcessingStatus } from '../models/index.js'
import { BaseRepository } from './base.repository.js'

const DUPLICATE_KEY = 11000

export class MessageRepository extends BaseRepository<Message> {
  protected readonly collectionName = 'messages'

  /**
   * Returns false when this message has already been ingested.
   *
   * The caller uses that to stop the pipeline dead: reprocessing a re-delivered
   * message would re-extract it and re-send every notification it produced.
   */
  async insertIfNew(message: Message): Promise<boolean> {
    try {
      await this.collection.insertOne(message as never)
      return true
    } catch (error) {
      if ((error as { code?: number }).code === DUPLICATE_KEY) return false
      throw error
    }
  }

  async findById(waMessageId: string): Promise<Message | null> {
    return this.collection.findOne({ waMessageId } as never) as Promise<Message | null>
  }

  async privateFor(ownerPhone: string): Promise<Message[]> {
    return this.collection
      .find({ fromGroup: false, senderPhone: ownerPhone } as never)
      .toArray() as Promise<Message[]>
  }

  async privateMessages(limit = 500): Promise<Message[]> {
    return this.collection
      .find({
        fromGroup: false,
        processingStatus: { $in: ['done', 'skipped'] },
        $or: [{ privateIndexedAt: { $exists: false } }, { privateIndexedAt: null }],
      } as never)
      .sort({ timestamp: 1 })
      .limit(limit)
      .toArray() as Promise<Message[]>
  }

  async markPrivateIndexed(waMessageId: string): Promise<void> {
    await this.collection.updateOne({ waMessageId } as never, {
      $set: { privateIndexedAt: new Date() } as never,
    })
  }

  async deletePrivate(ownerPhone: string): Promise<number> {
    return (
      await this.collection.deleteMany({ fromGroup: false, senderPhone: ownerPhone } as never)
    ).deletedCount
  }

  /**
   * Exact, chronological recovery alongside semantic retrieval.
   *
   * The namespace is built here rather than trusted to the model: shared messages
   * must come from a verified group, while private messages must belong to this user.
   */
  async accessible(
    ownerPhone: string,
    groupJids: string[],
    filters: {
      words?: string | null
      sender?: string | null
      chatJid?: string | null
      type?: Message['type'] | null
      since?: Date | null
      until?: Date | null
      limit?: number
    } = {},
  ): Promise<Message[]> {
    const namespaces: Record<string, unknown>[] = [{ fromGroup: false, senderPhone: ownerPhone }]
    const allowedGroups = filters.chatJid
      ? groupJids.includes(filters.chatJid)
        ? [filters.chatJid]
        : []
      : groupJids
    if (allowedGroups.length > 0)
      namespaces.push({ fromGroup: true, chatJid: { $in: allowedGroups } })

    const query: Record<string, unknown> = { $or: namespaces }
    if (filters.type) query['type'] = filters.type
    if (filters.sender) query['senderName'] = { $regex: escapeRegex(filters.sender), $options: 'i' }
    if (filters.words) {
      const contains = { $regex: escapeRegex(filters.words), $options: 'i' }
      query['$and'] = [
        { $or: [{ text: contains }, { caption: contains }, { transcript: contains }] },
      ]
    }
    if (filters.since || filters.until) {
      query['timestamp'] = {
        ...(filters.since ? { $gte: filters.since } : {}),
        ...(filters.until ? { $lte: filters.until } : {}),
      }
    }

    return this.collection
      .find(query as never)
      .sort({ timestamp: -1 })
      .limit(Math.min(Math.max(filters.limit ?? 20, 1), 50))
      .toArray() as Promise<Message[]>
  }

  async setStatus(
    waMessageId: string,
    processingStatus: ProcessingStatus,
    processingError: string | null = null,
  ): Promise<void> {
    await this.collection.updateOne({ waMessageId } as never, {
      $set: { processingStatus, processingError } as never,
      // Counted only on failure, so a message that keeps throwing stops being
      // retried automatically instead of being reprocessed on every restart.
      ...(processingStatus === 'failed' ? { $inc: { processingAttempts: 1 } as never } : {}),
    })
  }

  async setMediaKey(waMessageId: string, mediaKey: string): Promise<void> {
    await this.collection.updateOne({ waMessageId } as never, { $set: { mediaKey } as never })
  }

  async setTranscript(
    waMessageId: string,
    transcript: string,
    transcriptConfidence: number | null = null,
  ): Promise<void> {
    await this.collection.updateOne({ waMessageId } as never, {
      $set: { transcript, transcriptConfidence } as never,
    })
  }

  /**
   * Messages the pipeline started but never finished — the process was restarted or
   * killed mid-flight. WhatsApp will not re-deliver these, because they were already
   * inserted, so without a sweep they are lost silently and permanently.
   */
  async unfinished(limit = 50): Promise<Message[]> {
    return this.collection
      .find({
        processingStatus: { $in: ['pending', 'processing'] },
        fromGroup: true,
      } as never)
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray() as Promise<Message[]>
  }

  /**
   * Messages whose pipeline threw — a Whisper timeout, a MinIO blip, a rate limit.
   *
   * They cannot recover on their own: the record already exists, so WhatsApp's
   * re-delivery is rejected as a duplicate and the announcement is lost for good.
   * Retrying is the only route back.
   */
  async failed(limit = 50, maxAttempts?: number): Promise<Message[]> {
    const query: Record<string, unknown> = { processingStatus: 'failed', fromGroup: true }
    // Bounded for the automatic sweep; unbounded when an operator asks explicitly,
    // because they may have just fixed whatever was breaking it.
    if (maxAttempts !== undefined) {
      query['processingAttempts'] = { $lt: maxAttempts }
    }
    return this.collection
      .find(query as never)
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray() as Promise<Message[]>
  }

  /** The bounded context window used to tag a document that has no useful filename. */
  async precedingText(chatJid: string, before: Date, limit = 3): Promise<Message[]> {
    return this.collection
      .find({ chatJid, timestamp: { $lt: before }, text: { $ne: null } } as never)
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray() as Promise<Message[]>
  }
}

export const messageRepository = new MessageRepository()

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
