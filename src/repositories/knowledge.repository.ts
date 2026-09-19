import type { Knowledge } from '../models/index.js'
import { BaseRepository } from './base.repository.js'

export const VECTOR_INDEX = 'knowledge_vector'
export const TEXT_INDEX = 'knowledge_text'

export interface Scope {
  groupJids: string[]
  courseKeys: string[]
  /** Their own uploads, which no other student may ever reach. */
  ownerPhone?: string | null
  sourceKind?: 'message' | 'document'
  since?: Date | null
}

/**
 * Reciprocal rank fusion.
 *
 * Vector scores and keyword scores are not on the same scale and normalising them
 * against each other means inventing a conversion. Ranks are comparable without one:
 * a document both searches put near the top beats a document either alone loved, and
 * the constant keeps a single first place from dominating the whole list.
 */
const RRF_K = 60

function fuse(...lists: Knowledge[][]): Knowledge[] {
  const scores = new Map<string, { score: number; row: Knowledge }>()

  for (const list of lists) {
    list.forEach((row, index) => {
      const seen = scores.get(row.chunkId)
      const score = 1 / (RRF_K + index + 1)
      if (seen) seen.score += score
      else scores.set(row.chunkId, { score, row })
    })
  }

  return [...scores.values()].sort((a, b) => b.score - a.score).map((entry) => entry.row)
}

export class KnowledgeRepository extends BaseRepository<Knowledge> {
  protected readonly collectionName = 'knowledge'

  async upsertMany(rows: Knowledge[]): Promise<void> {
    if (rows.length === 0) return
    await this.collection.bulkWrite(
      rows.map((row) => ({
        replaceOne: {
          filter: { chunkId: row.chunkId } as never,
          replacement: row as never,
          upsert: true,
        },
      })),
    )
  }

  /**
   * The two namespaces, fanned out and merged.
   *
   * Shared material is reached through the groups a student belongs to; their own
   * uploads are reached through their phone. Neither can substitute for the other: a
   * group filter would hide their private timetable, and an owner filter would hide
   * everything the class shared.
   */
  private filter(scope: Scope): Record<string, unknown> {
    const namespaces: Record<string, unknown>[] = []

    if (scope.groupJids.length > 0) {
      const shared: Record<string, unknown> = {
        chatJid: { $in: scope.groupJids },
        ownerPhone: null,
      }
      if (scope.courseKeys.length > 0) shared['courseKey'] = { $in: scope.courseKeys }
      namespaces.push(shared)
    }

    // Their own uploads, reached by owner rather than by group. Not a substitute for
    // the shared namespace and not substitutable by it: a group filter hides their
    // private timetable, an owner filter hides everything the class shared.
    if (scope.ownerPhone) namespaces.push({ ownerPhone: scope.ownerPhone })

    // No namespace at all means no boundary, and no boundary has to mean nothing.
    if (namespaces.length === 0) return { chunkId: { $in: [] } }

    const filter: Record<string, unknown> = { $or: namespaces }
    if (scope.sourceKind) filter['sourceKind'] = scope.sourceKind
    if (scope.since) filter['timestamp'] = { $gte: scope.since }
    return filter
  }

  /** Semantic and keyword search over the same rows, merged by rank. */
  async search(
    embedding: number[],
    question: string,
    scope: Scope,
    k: number,
  ): Promise<Knowledge[]> {
    const filter = this.filter(scope)

    const [semantic, literal] = await Promise.all([
      this.collection
        .aggregate([
          {
            $vectorSearch: {
              index: VECTOR_INDEX,
              path: 'embedding',
              queryVector: embedding,
              // Atlas needs a wide candidate pool to filter within; asking for k
              // candidates and then filtering returns almost nothing.
              numCandidates: Math.max(k * 20, 200),
              limit: k,
              filter,
            },
          },
          { $project: { embedding: 0 } },
        ])
        .toArray() as Promise<Knowledge[]>,
      this.collection
        .aggregate([
          {
            $search: {
              index: TEXT_INDEX,
              compound: {
                must: [{ text: { query: question, path: 'text' } }],
              },
            },
          },
          { $match: filter },
          { $limit: k },
          { $project: { embedding: 0 } },
        ])
        .toArray() as Promise<Knowledge[]>,
    ])

    return fuse(semantic, literal).slice(0, k)
  }

  /**
   * Everything shared as a file for one course — by metadata, not by similarity.
   *
   * Revising means covering the material; a similarity search for "what is on the
   * test" returns only the corner of it that phrases itself that way.
   */
  async material(scope: Scope, limit: number): Promise<Knowledge[]> {
    return this.collection
      .find(this.filter({ ...scope, sourceKind: 'document' }) as never, {
        projection: { embedding: 0 },
      })
      .limit(limit)
      .toArray() as Promise<Knowledge[]>
  }

  async count(): Promise<number> {
    return this.collection.countDocuments()
  }

  async deleteOwned(ownerPhone: string): Promise<number> {
    return (await this.collection.deleteMany({ ownerPhone } as never)).deletedCount
  }

  async hasOwnedSource(ownerPhone: string, waMessageId: string): Promise<boolean> {
    return (
      (await this.collection.countDocuments({ ownerPhone, waMessageId } as never, { limit: 1 })) > 0
    )
  }
}

export const knowledgeRepository = new KnowledgeRepository()
