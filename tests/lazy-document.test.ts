import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message, Resource, User } from '../src/models/index.js'

let resources: Resource[] = []
let indexed = 0
let reads = 0

const message = {
  waMessageId: 'pdf-1',
  mediaKey: 'media/pdf-1',
  mimeType: 'application/pdf',
  chatJid: 'group@g.us',
  fromGroup: true,
  timestamp: new Date(),
  senderName: 'Rep',
} as Message

vi.mock('../src/db/minio.js', () => ({ getMedia: vi.fn(async () => Buffer.from('%PDF')) }))
vi.mock('../src/repositories/index.js', () => ({
  messageRepository: { findById: vi.fn(async () => message) },
  resourceRepository: {
    accessibleFiles: vi.fn(async () => resources),
    setCourse: vi.fn(async (source: string, courseKey: string) => {
      resources = resources.map((resource) =>
        resource.sourceMessageId === source ? { ...resource, courseKey } : resource,
      )
    }),
    markProcessed: vi.fn(async (source: string, error: string | null = null) => {
      resources = resources.map((resource) =>
        resource.sourceMessageId === source
          ? { ...resource, processedAt: new Date(), processingError: error }
          : resource,
      )
    }),
  },
}))
vi.mock('../src/services/document-reader.service.js', () => ({
  documentReader: {
    read: vi.fn(async () => {
      reads += 1
      return { text: 'Highway engineering notes', pages: 1, readVia: 'text' }
    }),
    chunk: vi.fn(() => [{ text: 'Highway engineering notes', page: 1, index: 0 }]),
  },
}))
vi.mock('../src/services/indexing.service.js', () => ({
  indexingService: {
    indexDocument: vi.fn(async () => {
      indexed += 1
    }),
    indexUnreadable: vi.fn(),
  },
}))

const { lazyDocumentService } = await import('../src/services/lazy-document.service.js')

const user = {
  phone: '234',
  jid: '234@s.whatsapp.net',
  groupJids: ['group@g.us'],
  historicalGroupJids: [],
} as unknown as User

beforeEach(() => {
  reads = 0
  indexed = 0
  resources = [
    {
      course: null,
      courseKey: null,
      chatJid: 'group@g.us',
      docType: 'other',
      fileName: 'class-note-1.pdf',
      mediaKey: 'media/pdf-1',
      mimeType: 'application/pdf',
      postedBy: 'Rep',
      postedAt: new Date(),
      sourceMessageId: 'pdf-1',
      processedAt: null,
      processingError: null,
    },
  ]
})

describe('lazy PDF processing', () => {
  it('opens and indexes a stored PDF only when explicitly requested', async () => {
    const result = await lazyDocumentService.process(user, 'class note 1', 'CVE575')
    expect(result?.courseKey).toBe('CVE575')
    expect(reads).toBe(1)
    expect(indexed).toBe(1)
  })

  it('does not pay to process the same PDF twice', async () => {
    await lazyDocumentService.process(user, 'class-note-1.pdf', 'CVE575')
    await lazyDocumentService.process(user, 'class-note-1.pdf', 'CVE575')
    expect(reads).toBe(1)
    expect(indexed).toBe(1)
  })
})
