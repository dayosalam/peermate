import { config } from '../config.js'
import { getCollection } from '../db/chroma.js'
import type { Knowledge } from '../models/index.js'
import { knowledgeRepository } from '../repositories/index.js'
import { embeddingService } from './embedding.service.js'

export interface Candidate {
  waMessageId: string
  /**
   * The group it came from.
   *
   * Carried so a leak is measurable rather than merely believed to be impossible:
   * the eval asserts every candidate's group is one the student belongs to.
   */
  chatJid: string
  content: string
  senderName: string
  type: string
  transcriptConfidence?: number | null
  timestamp: Date
  courseKey: string
  /** 'document' for a chunk of a shared PDF, 'message' for something someone typed or said. */
  sourceKind: string
  fileName: string | null
  page: number | null
  /** 'text' from a text layer, 'ocr' from a scan, 'none' when it could not be read. */
  readVia: string
}

/**
 * Retrieval favours recall. Read-time conflict resolution can only compare records
 * that retrieval actually returned, so filter by the student's courses and a recent
 * window, then take a generous k and hand the LLM the whole candidate set.
 */
export class RetrievalService {
  /**
   * Everything readable that was ever shared as a file for one course.
   *
   * Fetched by metadata rather than by similarity: preparing for a test means
   * covering the material, and a search for "what is on the test" returns the corner
   * of it that happens to phrase itself that way. Unreadable placeholders are
   * returned too — a file Peermate cannot open is still worth admitting to.
   */
  async material(courseKey: string, groupJids: string[], limit = 150): Promise<Candidate[]> {
    if (groupJids.length === 0) return []

    if (config.searchBackend === 'atlas') {
      const rows = await knowledgeRepository.material({ groupJids, courseKeys: [courseKey] }, limit)
      return rows.map(fromKnowledge)
    }

    const result = await getCollection().get({
      where: {
        $and: [
          { courseKey: { $eq: courseKey } },
          { chatJid: { $in: groupJids } },
          { sourceKind: { $eq: 'document' } },
        ],
      },
      limit,
    })

    const documents = result.documents ?? []
    const metadatas = result.metadatas ?? []

    return documents.flatMap((content, index) => {
      const meta = metadatas[index]
      if (!content || !meta) return []
      return [
        {
          waMessageId: String(meta['waMessageId'] ?? ''),
          chatJid: String(meta['chatJid'] ?? ''),
          content,
          senderName: String(meta['senderName'] ?? 'unknown'),
          type: String(meta['type'] ?? 'document'),
          transcriptConfidence:
            Number(meta['transcriptConfidence'] ?? -1) >= 0
              ? Number(meta['transcriptConfidence'])
              : null,
          timestamp: new Date(Number(meta['timestampMs'] ?? 0)),
          courseKey: String(meta['courseKey'] ?? ''),
          sourceKind: 'document',
          fileName: meta['fileName'] ? String(meta['fileName']) : null,
          page: meta['page'] ? Number(meta['page']) : null,
          readVia: String(meta['readVia'] ?? 'text'),
        },
      ]
    })
  }

  /**
   * `groupJids` is the tenancy boundary, not an optimisation. `chatJid` has been on
   * every chunk since indexing began but was never filtered on, so a course code was
   * the whole of the scope — and a code is a local invention. Two universities each
   * running a CSC 301 shared one namespace, and each cited the other's lecturer.
   */
  async search(
    question: string,
    courseKeys: string[],
    groupJids: string[],
    ownerPhone: string | null = null,
    k = config.retrieval.candidateK,
  ): Promise<Candidate[]> {
    // Either namespace alone is enough to search. A student with no groups yet still
    // has their own uploads, and returning nothing to them because the shared half is
    // empty is the same silent failure the group scoping exists to prevent.
    if (groupJids.length === 0 && !ownerPhone) return []
    if (courseKeys.length === 0 && !ownerPhone) return []

    const since = Date.now() - config.retrieval.windowDays * 24 * 60 * 60 * 1000
    const embedding = await embeddingService.embed(question)

    if (config.searchBackend === 'atlas') {
      const rows = await knowledgeRepository.search(
        embedding,
        question,
        { groupJids, courseKeys, ownerPhone, since: new Date(since) },
        k,
      )
      return rows.map(fromKnowledge)
    }

    const namespaces: Record<string, unknown>[] = []
    if (groupJids.length > 0) {
      const sharedFilters: Record<string, unknown>[] = [
        { chatJid: { $in: groupJids } },
        { timestampMs: { $gte: since } },
      ]
      if (courseKeys.length > 0) sharedFilters.push({ courseKey: { $in: courseKeys } })
      namespaces.push({ $and: sharedFilters })
    }
    if (ownerPhone) {
      namespaces.push({
        $and: [{ ownerPhone: { $eq: ownerPhone } }, { timestampMs: { $gte: since } }],
      })
    }

    const where =
      namespaces.length === 1 ? namespaces[0]! : ({ $or: namespaces } as Record<string, unknown>)

    const result = await getCollection().query({
      queryEmbeddings: [embedding],
      nResults: k,
      where: where as never,
    })

    const documents = result.documents[0] ?? []
    const metadatas = result.metadatas[0] ?? []

    return documents.flatMap((content, index) => {
      const meta = metadatas[index]
      if (!content || !meta) return []
      return [
        {
          waMessageId: String(meta['waMessageId'] ?? ''),
          chatJid: String(meta['chatJid'] ?? ''),
          content,
          senderName: String(meta['senderName'] ?? 'unknown'),
          type: String(meta['type'] ?? 'text'),
          transcriptConfidence:
            Number(meta['transcriptConfidence'] ?? -1) >= 0
              ? Number(meta['transcriptConfidence'])
              : null,
          timestamp: new Date(Number(meta['timestampMs'] ?? 0)),
          courseKey: String(meta['courseKey'] ?? ''),
          sourceKind: String(meta['sourceKind'] ?? 'message'),
          fileName: meta['fileName'] ? String(meta['fileName']) : null,
          page: meta['page'] ? Number(meta['page']) : null,
          readVia: String(meta['readVia'] ?? 'text'),
        },
      ]
    })
  }
}

export const retrievalService = new RetrievalService()

/** Atlas stores the fields as themselves, so this is a rename rather than a parse. */
function fromKnowledge(row: Knowledge): Candidate {
  return {
    waMessageId: row.waMessageId,
    chatJid: row.chatJid,
    content: row.text,
    senderName: row.senderName,
    type: row.type,
    transcriptConfidence: row.transcriptConfidence,
    timestamp: row.timestamp,
    courseKey: row.courseKey ?? '',
    sourceKind: row.sourceKind,
    fileName: row.fileName,
    page: row.page,
    readVia: row.readVia,
  }
}
