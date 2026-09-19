import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '../src/models/index.js'

let pending: Message[] = []
const indexed: string[] = []
const marked: string[] = []

vi.mock('@whiskeysockets/baileys', () => ({ downloadMediaMessage: vi.fn() }))
vi.mock('../src/repositories/index.js', () => ({
  messageRepository: {
    privateMessages: vi.fn(async () => pending),
    markPrivateIndexed: vi.fn(async (id: string) => marked.push(id)),
  },
  groupRepository: {},
  extractionRepository: {},
  userRepository: {},
}))
vi.mock('../src/services/indexing.service.js', () => ({
  indexingService: {
    index: vi.fn(async (message: Message) => indexed.push(message.waMessageId)),
  },
}))
vi.mock('../src/services/announcement.service.js', () => ({ announcementService: {} }))
vi.mock('../src/services/document.service.js', () => ({ documentService: {} }))
vi.mock('../src/services/resource-alert.service.js', () => ({ resourceAlertService: {} }))
vi.mock('../src/services/document-reader.service.js', () => ({ documentReader: {} }))
vi.mock('../src/services/group.service.js', () => ({ groupService: {} }))
vi.mock('../src/services/dm.service.js', () => ({ dmService: {} }))
vi.mock('../src/services/extraction.service.js', () => ({ extractionService: {} }))
vi.mock('../src/services/transcription.service.js', () => ({ transcriptionService: {} }))
vi.mock('../src/services/vision.service.js', () => ({ visionService: {} }))
vi.mock('../src/whatsapp/socket.js', () => ({ getSocket: vi.fn() }))

const { backfillPrivateMemory } = await import('../src/workers/ingest.worker.js')

function message(over: Partial<Message> = {}): Message {
  return {
    waMessageId: 'dm-1',
    chatJid: '234@s.whatsapp.net',
    senderJid: '234@s.whatsapp.net',
    senderPhone: '234',
    senderName: 'Amina',
    fromGroup: false,
    timestamp: new Date(),
    type: 'text',
    text: 'remember my project idea',
    caption: null,
    quotedMessageId: null,
    mediaKey: null,
    mimeType: null,
    fileName: null,
    transcript: null,
    transcriptConfidence: null,
    processingStatus: 'done',
    processingError: null,
    processingAttempts: 0,
    privateIndexedAt: null,
    ingestedAt: new Date(),
    ...over,
  } as Message
}

beforeEach(() => {
  pending = []
  indexed.length = 0
  marked.length = 0
})

describe('private-memory backfill', () => {
  it('indexes old private messages and checkpoints only after success', async () => {
    pending = [message()]
    expect(await backfillPrivateMemory()).toBe(1)
    expect(indexed).toEqual(['dm-1'])
    expect(marked).toEqual(['dm-1'])
  })

  it('skips an ownerless row instead of making it globally searchable', async () => {
    pending = [message({ senderPhone: null })]
    expect(await backfillPrivateMemory()).toBe(0)
    expect(indexed).toEqual([])
    expect(marked).toEqual([])
  })
})
