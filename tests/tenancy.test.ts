import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Extraction, Resource, User } from '../src/models/index.js'

/**
 * Two universities, each running a course called CVE 575.
 *
 * `courseKey('CVE 575')` is `CVE575` everywhere it is computed — the code is a local
 * invention with no global meaning — so a course code can never be the whole of a
 * scope. Every read is bounded by the groups the student actually belongs to.
 *
 * These tests run the real repository and retrieval code against filter evaluators
 * rather than asserting that a particular key appears in a query object: a filter
 * that is built and then ignored would pass the second kind of test and leak anyway.
 */

const UNILORIN = '111@g.us'
const OAU = '222@g.us'

/** The Mongo operators these queries actually use. Anything else is a test bug. */
function matches(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, condition]) => {
    if (key === '$and')
      return (condition as Record<string, unknown>[]).every((c) => matches(doc, c))
    if (key === '$or') return (condition as Record<string, unknown>[]).some((c) => matches(doc, c))

    const value = doc[key]
    // Mongo treats equality against an array field as "contains".
    const held = Array.isArray(value) ? value : [value]

    if (condition === null || typeof condition !== 'object') {
      return held.some((item) => item === condition)
    }

    return Object.entries(condition as Record<string, unknown>).every(([op, operand]) => {
      switch (op) {
        case '$in':
          return held.some((item) => (operand as unknown[]).includes(item))
        case '$nin':
          return !held.some((item) => (operand as unknown[]).includes(item))
        case '$ne':
          return !held.some((item) => item === operand)
        case '$gte':
          return Number(value) >= Number(operand)
        case '$exists':
          return (value !== undefined) === operand
        default:
          throw new Error(`unhandled mongo operator ${op}`)
      }
    })
  })
}

let collections: Record<string, Record<string, unknown>[]> = {}

function fakeCollection(name: string) {
  const rows = () => collections[name] ?? []
  const cursor = (found: Record<string, unknown>[]) => ({
    sort: () => cursor(found),
    toArray: async () => found,
  })
  return {
    find: (filter: Record<string, unknown>) => cursor(rows().filter((row) => matches(row, filter))),
    findOne: async (filter: Record<string, unknown>) =>
      rows().find((row) => matches(row, filter)) ?? null,
    distinct: async () => [],
  }
}

vi.mock('../src/db/mongo.js', () => ({
  getDb: () => ({ collection: (name: string) => fakeCollection(name) }),
}))

/** Chroma's where syntax, evaluated over the same fixtures. */
function chromaMatches(meta: Record<string, unknown>, where: Record<string, unknown>): boolean {
  if ('$and' in where) {
    return (where['$and'] as Record<string, unknown>[]).every((c) => chromaMatches(meta, c))
  }
  return Object.entries(where).every(([field, condition]) => {
    const [op, operand] = Object.entries(condition as Record<string, unknown>)[0]!
    if (op === '$eq') return meta[field] === operand
    if (op === '$in') return (operand as unknown[]).includes(meta[field])
    if (op === '$gte') return Number(meta[field]) >= Number(operand)
    throw new Error(`unhandled chroma operator ${op}`)
  })
}

let chunks: Array<{ text: string; meta: Record<string, unknown> }> = []

vi.mock('../src/db/chroma.js', () => ({
  getCollection: () => ({
    query: async ({ where }: { where: Record<string, unknown> }) => {
      const hits = chunks.filter((chunk) => chromaMatches(chunk.meta, where))
      return { documents: [hits.map((h) => h.text)], metadatas: [hits.map((h) => h.meta)] }
    },
    get: async ({ where }: { where: Record<string, unknown> }) => {
      const hits = chunks.filter((chunk) => chromaMatches(chunk.meta, where))
      return { documents: hits.map((h) => h.text), metadatas: hits.map((h) => h.meta) }
    },
  }),
}))

vi.mock('../src/services/embedding.service.js', () => ({
  embeddingService: { embed: vi.fn(async () => [0.1, 0.2, 0.3]) },
}))

const { extractionRepository, resourceRepository, userRepository } =
  await import('../src/repositories/index.js')
const { retrievalService } = await import('../src/services/retrieval.service.js')

function extraction(over: Partial<Extraction>): Extraction {
  return {
    eventId: `e-${Math.random()}`,
    sourceMessageId: 'src',
    chatJid: UNILORIN,
    course: 'CVE 575',
    courseKey: 'CVE575',
    scope: 'course',
    eventType: 'test',
    title: null,
    originalDateText: 'Friday',
    date: '2026-09-18',
    time: '10:00',
    venue: 'LG7',
    confidence: 0.9,
    authority: 'lecturer',
    corroboratedBy: [],
    supersededBy: null,
    extractedAt: new Date(),
    ...over,
  } as Extraction
}

function resource(over: Partial<Resource>): Resource {
  return {
    course: 'CVE 575',
    courseKey: 'CVE575',
    chatJid: UNILORIN,
    docType: 'past_questions',
    fileName: 'past.pdf',
    mediaKey: 'k',
    mimeType: 'application/pdf',
    postedBy: 'Chidi',
    postedAt: new Date(),
    sourceMessageId: 'src',
    ...over,
  } as Resource
}

function chunk(chatJid: string, text: string, sourceKind = 'message') {
  return {
    text,
    meta: {
      waMessageId: `m-${Math.random()}`,
      chatJid,
      courseKey: 'CVE575',
      senderName: 'Dr Bello',
      type: 'text',
      sourceKind,
      fileName: 'notes.pdf',
      page: 4,
      readVia: 'text',
      timestampMs: Date.now(),
    },
  }
}

/** Registered at Unilorin. Takes CVE 575 there, and nowhere else. */
const amina = {
  phone: '234',
  courseKeys: ['CVE575'],
  groupJids: [UNILORIN],
  shardId: 'default',
} as User

beforeEach(() => {
  collections = {}
  chunks = []
})

describe('a course code is not a tenancy boundary', () => {
  it('keeps another university’s announcement out of the digest', async () => {
    collections['extractions'] = [
      extraction({ chatJid: UNILORIN, venue: 'LG7' }),
      extraction({ chatJid: OAU, venue: 'ODUDUWA HALL' }),
    ]

    const found = await extractionRepository.forCourses(
      amina.courseKeys,
      new Date(0),
      amina.groupJids,
    )

    expect(found).toHaveLength(1)
    expect(found[0]!.venue).toBe('LG7')
  })

  it('keeps another university’s deadline out of "what is due today"', async () => {
    collections['extractions'] = [
      extraction({ chatJid: UNILORIN, date: '2026-09-18' }),
      extraction({ chatJid: OAU, date: '2026-09-18' }),
    ]

    const due = await extractionRepository.dueOn(amina.courseKeys, '2026-09-18', amina.groupJids)
    expect(due).toHaveLength(1)
    expect(due[0]!.chatJid).toBe(UNILORIN)
  })

  it('keeps another university’s files off the shelf', async () => {
    collections['resources'] = [
      resource({ chatJid: UNILORIN, fileName: 'unilorin-past-questions.pdf' }),
      resource({ chatJid: OAU, fileName: 'oau-past-questions.pdf' }),
    ]

    const shelf = await resourceRepository.forCourse('CVE575', amina.groupJids)
    expect(shelf.map((item) => item.fileName)).toEqual(['unilorin-past-questions.pdf'])
  })

  it('keeps another university’s messages out of retrieval', async () => {
    chunks = [
      chunk(UNILORIN, 'the CVE 575 test is in LG7'),
      chunk(OAU, 'the CVE 575 test is in Oduduwa Hall'),
    ]

    const candidates = await retrievalService.search(
      'where is the test?',
      amina.courseKeys,
      amina.groupJids,
    )

    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.content).toContain('LG7')
  })

  it('keeps another university’s slides out of a practice set', async () => {
    chunks = [
      chunk(UNILORIN, 'transportation engineering, page 4', 'document'),
      chunk(OAU, 'a different syllabus entirely', 'document'),
    ]

    const material = await retrievalService.material('CVE575', amina.groupJids)
    expect(material).toHaveLength(1)
    expect(material[0]!.content).toContain('transportation')
  })

  it('never alerts a student in another university’s group', async () => {
    collections['users'] = [
      { ...amina, onboardingState: 'registered', shardId: 'default' },
      {
        phone: '235',
        courseKeys: ['CVE575'],
        groupJids: [OAU],
        shardId: 'default',
        onboardingState: 'registered',
      },
    ] as unknown as Record<string, unknown>[]

    const audience = await userRepository.subscribedTo('CVE575', UNILORIN, 'default')
    expect(audience.map((user) => user.phone)).toEqual(['234'])
  })
})

describe('an unscoped student reaches nothing', () => {
  /**
   * Fail closed. A student registered before tenancy existed has no groups on their
   * record, and an empty boundary has to mean "nothing" rather than "no filter" —
   * the alternative is that every pre-existing account silently sees everything.
   */
  const stranded = { phone: '999', courseKeys: ['CVE575'], groupJids: [] } as unknown as User

  it('returns no announcements, files, or search results', async () => {
    collections['extractions'] = [extraction({})]
    collections['resources'] = [resource({})]
    chunks = [chunk(UNILORIN, 'the CVE 575 test is in LG7')]

    expect(
      await extractionRepository.forCourses(stranded.courseKeys, new Date(0), stranded.groupJids),
    ).toEqual([])
    expect(
      await extractionRepository.dueOn(stranded.courseKeys, '2026-09-18', stranded.groupJids),
    ).toEqual([])
    expect(await resourceRepository.forCourse('CVE575', stranded.groupJids)).toEqual([])
    expect(
      await retrievalService.search('where is the test?', stranded.courseKeys, stranded.groupJids),
    ).toEqual([])
    expect(await retrievalService.material('CVE575', stranded.groupJids)).toEqual([])
  })
})
