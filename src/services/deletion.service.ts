import { deleteMedia } from '../db/minio.js'
import { logger } from '../core/logger.js'
import type { DeletionJob, DeletionStep, User } from '../models/index.js'
import {
  assignmentStateRepository,
  attemptRepository,
  deletionJobRepository,
  memoryCollectionRepository,
  messageRepository,
  notificationRepository,
  outboxRepository,
  renderJobRepository,
  scheduleRepository,
  userRepository,
} from '../repositories/index.js'
import { conversationService } from './conversation.service.js'
import { indexingService } from './indexing.service.js'

/**
 * Deletes private data as a durable, restart-safe workflow.
 *
 * Each operation is idempotent and its completion is recorded before moving on. The
 * account itself is removed last, so a failed cleanup never strands an invisible job.
 */
export class DeletionService {
  async request(user: User): Promise<boolean> {
    const privateMessages = await messageRepository.privateFor(user.phone)
    const mediaKeys = privateMessages
      .map((message) => message.mediaKey)
      .filter((key): key is string => Boolean(key))
    const job = await deletionJobRepository.begin(user.phone, mediaKeys)
    try {
      await this.run(job)
      return true
    } catch (error) {
      logger.error({ err: error, phone: user.phone }, 'private deletion queued for recovery')
      return false
    }
  }

  async recover(): Promise<number> {
    const jobs = await deletionJobRepository.unfinished()
    let completed = 0
    for (const job of jobs) {
      try {
        await this.run(job)
        completed += 1
      } catch (error) {
        logger.error({ err: error, phone: job.phone }, 'private deletion recovery failed')
      }
    }
    return completed
  }

  private async run(job: DeletionJob): Promise<void> {
    await deletionJobRepository.started(job.phone)
    const completed = new Set(job.completedSteps)

    try {
      await this.step(job.phone, completed, 'outbox', () => outboxRepository.clear(job.phone))
      await this.step(job.phone, completed, 'renders', () => renderJobRepository.clear(job.phone))
      await this.step(job.phone, completed, 'media', async () => {
        for (const key of job.mediaKeys) await deleteMedia(key)
      })
      await this.step(job.phone, completed, 'vectors', () =>
        indexingService.deletePrivate(job.phone),
      )
      await this.step(job.phone, completed, 'messages', () =>
        messageRepository.deletePrivate(job.phone),
      )
      await this.step(job.phone, completed, 'collections', () =>
        memoryCollectionRepository.clear(job.phone),
      )
      await this.step(job.phone, completed, 'conversation', () =>
        conversationService.forget(job.phone),
      )
      await this.step(job.phone, completed, 'schedules', () => scheduleRepository.clear(job.phone))
      await this.step(job.phone, completed, 'attempts', () => attemptRepository.clear(job.phone))
      await this.step(job.phone, completed, 'assignments', () =>
        assignmentStateRepository.clear(job.phone),
      )
      await this.step(job.phone, completed, 'notifications', () =>
        notificationRepository.clear(job.phone),
      )
      await this.step(job.phone, completed, 'user', () => userRepository.delete(job.phone))
      await deletionJobRepository.finish(job.phone)
      logger.info({ phone: job.phone }, 'student removed themselves')
    } catch (error) {
      await deletionJobRepository.fail(job.phone, error)
      throw error
    }
  }

  private async step(
    phone: string,
    completed: Set<DeletionStep>,
    step: DeletionStep,
    action: () => Promise<unknown>,
  ): Promise<void> {
    if (completed.has(step)) return
    await action()
    await deletionJobRepository.completeStep(phone, step)
    completed.add(step)
  }
}

export const deletionService = new DeletionService()
