/**
 * Moves the searchable archive from Chroma into Atlas.
 *
 * Deliberately not a switch. The order is: create the indexes, backfill, run both and
 * compare, then flip reads. Each step is reversible until the last, and the last is
 * one environment variable.
 *
 *   1. npm run migrate-to-atlas -- --indexes    create the Atlas search indexes
 *   2. npm run migrate-to-atlas -- --backfill   copy every chunk across
 *   3. SEARCH_BACKEND=dual                      write both, still read Chroma
 *   4. npm run migrate-to-atlas -- --compare    same queries, both stores, diff
 *   5. SEARCH_BACKEND=atlas                     read Atlas; Chroma can be removed
 *
 * Source text lives in Chroma's own documents, so nothing is re-read from the PDFs
 * and no OCR is paid for twice. Embeddings are recomputed because the dimension
 * changed — a 1536-wide vector and a 512-wide one cannot be compared.
 */
import { config } from '../config.js'
import { logger } from '../core/logger.js'
import { connectChroma, getCollection } from '../db/chroma.js'
import { closeMongo, connectMongo, getDb } from '../db/mongo.js'
import type { Knowledge } from '../models/index.js'
import { knowledgeRepository, TEXT_INDEX, VECTOR_INDEX } from '../repositories/index.js'
import { embeddingService } from '../services/embedding.service.js'
import { retrievalService } from '../services/retrieval.service.js'

const BATCH = 100

async function createIndexes(): Promise<void> {
  const collection = getDb().collection('knowledge')

  // Only the fields actually filtered on are declared. An Atlas vector index rejects
  // a filter on a path it does not know about, so this list and the query filter in
  // knowledge.repository.ts have to stay in step.
  await collection.createSearchIndex({
    name: VECTOR_INDEX,
    type: 'vectorSearch',
    definition: {
      fields: [
        {
          type: 'vector',
          path: 'embedding',
          numDimensions: config.embeddings.dimension,
          similarity: 'cosine',
        },
        { type: 'filter', path: 'chatJid' },
        { type: 'filter', path: 'courseKey' },
        { type: 'filter', path: 'ownerPhone' },
        { type: 'filter', path: 'sourceKind' },
        { type: 'filter', path: 'timestamp' },
      ],
    },
  } as never)

  await collection.createSearchIndex({
    name: TEXT_INDEX,
    definition: { mappings: { dynamic: false, fields: { text: { type: 'string' } } } },
  } as never)

  console.log(`created ${VECTOR_INDEX} and ${TEXT_INDEX} — Atlas builds them in the background`)
}

async function backfill(): Promise<void> {
  await connectChroma()
  const chroma = getCollection()

  let offset = 0
  let copied = 0

  for (;;) {
    const page = await chroma.get({ limit: BATCH, offset, include: ['documents', 'metadatas'] })
    const documents = page.documents ?? []
    if (documents.length === 0) break

    const metadatas = page.metadatas ?? []
    const ids = page.ids ?? []

    const usable = documents.flatMap((text, index) => {
      const meta = metadatas[index]
      const id = ids[index]
      return text && meta && id ? [{ id, text, meta }] : []
    })

    if (usable.length > 0) {
      const embeddings = await embeddingService.embedAll(usable.map((item) => item.text))
      const rows: Knowledge[] = usable.map((item, index) => {
        const meta = item.meta as Record<string, unknown>
        const courseKey = String(meta['courseKey'] ?? 'NONE')
        return {
          chunkId: item.id,
          waMessageId: String(meta['waMessageId'] ?? ''),
          chatJid: String(meta['chatJid'] ?? ''),
          courseKey: courseKey === 'NONE' ? null : courseKey,
          ownerPhone: null,
          sourceKind: meta['sourceKind'] === 'document' ? 'document' : 'message',
          text: item.text,
          embedding: embeddings[index] ?? [],
          senderName: String(meta['senderName'] ?? 'unknown'),
          type: String(meta['type'] ?? 'text'),
          transcriptConfidence:
            Number(meta['transcriptConfidence'] ?? -1) >= 0
              ? Number(meta['transcriptConfidence'])
              : null,
          fileName: meta['fileName'] ? String(meta['fileName']) : null,
          page: meta['page'] === undefined ? null : Number(meta['page']),
          readVia: String(meta['readVia'] ?? 'text'),
          timestamp: new Date(Number(meta['timestampMs'] ?? 0)),
        }
      })

      // A chunk with no group cannot be scoped to anybody, and serving an
      // unattributable one is exactly the leak the boundary exists to stop. Left
      // behind and counted rather than copied in.
      const scoped = rows.filter((row) => row.chatJid)
      const stranded = rows.length - scoped.length
      if (stranded > 0) console.log(`  ${stranded} chunk(s) with no group left behind`)

      await knowledgeRepository.upsertMany(scoped)
      copied += scoped.length
    }

    offset += documents.length
    console.log(`  copied ${copied}…`)
  }

  console.log(
    `\nbackfilled ${copied} chunk(s); atlas now holds ${await knowledgeRepository.count()}`,
  )
}

/**
 * Same questions, both stores, side by side.
 *
 * Overlap is the number worth reading. Identical results are not expected — the
 * embedding dimension changed and the fusion is new — but a question whose top
 * results share nothing is one worth looking at before Atlas answers it for real.
 */
async function compare(
  questions: string[],
  courseKeys: string[],
  groupJids: string[],
): Promise<void> {
  for (const question of questions) {
    const chroma = await withBackend('chroma', () =>
      retrievalService.search(question, courseKeys, groupJids),
    )
    const atlas = await withBackend('atlas', () =>
      retrievalService.search(question, courseKeys, groupJids),
    )

    const theirs = new Set(atlas.map((item) => item.waMessageId))
    const shared = chroma.filter((item) => theirs.has(item.waMessageId)).length
    const of = Math.max(chroma.length, 1)

    console.log(
      `${String(Math.round((shared / of) * 100)).padStart(3)}%  ${question.slice(0, 60)}  (chroma ${chroma.length}, atlas ${atlas.length})`,
    )
  }
}

async function withBackend<T>(backend: 'chroma' | 'atlas', run: () => Promise<T>): Promise<T> {
  const previous = config.searchBackend
  ;(config as { searchBackend: string }).searchBackend = backend
  try {
    return await run()
  } finally {
    ;(config as { searchBackend: string }).searchBackend = previous
  }
}

async function main(): Promise<void> {
  await connectMongo()

  if (process.argv.includes('--indexes')) await createIndexes()
  if (process.argv.includes('--backfill')) await backfill()
  if (process.argv.includes('--compare')) {
    const [, , , ...rest] = process.argv
    const groupJids = rest.filter((arg) => arg.endsWith('@g.us'))
    const courseKeys = rest.filter((arg) => /^[A-Z]{2,4}\d{3,4}$/.test(arg))
    if (groupJids.length === 0) {
      console.log('pass at least one group jid to compare against, e.g. 1203…@g.us CVE575')
    } else {
      await compare(
        [
          'when is the test',
          'where is the lecture holding',
          'what did the lecturer say about the assignment',
          'has anyone shared past questions',
        ],
        courseKeys,
        groupJids,
      )
    }
  }

  await closeMongo()
}

main().catch((error) => {
  logger.error({ err: error }, 'migration failed')
  process.exit(1)
})
