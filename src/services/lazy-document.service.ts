import type { Resource, User } from '../models/index.js'
import { getMedia } from '../db/minio.js'
import { messageRepository, resourceRepository } from '../repositories/index.js'
import { documentReader } from './document-reader.service.js'
import { indexingService } from './indexing.service.js'

export class LazyDocumentService {
  async process(
    user: User,
    wanted: string,
    courseKey: string | null = null,
  ): Promise<Resource | null> {
    const files = await resourceRepository.accessibleFiles(
      [...new Set([...(user.groupJids ?? []), ...(user.historicalGroupJids ?? [])])],
      user.jid,
    )
    const needle = wanted.trim().toLowerCase()
    const loose = needle.replace(/[^a-z0-9]+/g, '')
    const resource =
      files.find((file) => file.fileName.toLowerCase() === needle) ??
      files.find((file) => file.fileName.toLowerCase().includes(needle)) ??
      files.find((file) =>
        file.fileName
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '')
          .includes(loose),
      ) ??
      null
    if (!resource) return null
    if (courseKey && resource.courseKey !== courseKey) {
      await resourceRepository.setCourse(resource.sourceMessageId, courseKey)
      resource.courseKey = courseKey
      resource.course = courseKey
    }
    if (resource.processedAt) return resource

    const message = await messageRepository.findById(resource.sourceMessageId)
    if (!message?.mediaKey) return null
    const bytes = await getMedia(message.mediaKey)
    const read = await documentReader.read(bytes, message.mimeType, resource.fileName)
    if (!read) {
      await indexingService.indexUnreadable(
        message,
        resource.courseKey,
        resource.fileName,
        'the file has no readable text',
      )
      await resourceRepository.markProcessed(resource.sourceMessageId, 'no readable text')
      return { ...resource, processedAt: new Date(), processingError: 'no readable text' }
    }

    await indexingService.indexDocument(
      message,
      documentReader.chunk(read.text, read.pages),
      resource.courseKey,
      resource.fileName,
      read.readVia,
    )
    await resourceRepository.markProcessed(resource.sourceMessageId)
    return { ...resource, processedAt: new Date(), processingError: null }
  }
}

export const lazyDocumentService = new LazyDocumentService()
