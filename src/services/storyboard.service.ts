import { createHash } from 'node:crypto'
import { logger } from '../core/logger.js'
import type { RenderJob, Resource, User } from '../models/index.js'
import { renderJobRepository, resourceRepository } from '../repositories/index.js'
import { config } from '../config.js'
import { PDF_MIME } from './document-reader.service.js'
import { describe, type Explainer } from './explainer.service.js'

/**
 * Turns a script into a job to render it.
 *
 * The bridge between the two halves: `ExplainerService` knows what to say and which
 * page it came from, `render/` knows how to draw it, and neither knows the other
 * exists. This resolves a scene's filename to the file itself and writes the job down.
 *
 * Nothing is fetched here. A render runs minutes later, and a path to a temporary copy
 * is worthless by then — the job carries the MinIO key and the runner materialises it.
 */
export class StoryboardService {
  async enqueue(
    user: User,
    courseKey: string,
    topic: string | null,
    explainer: Explainer,
    jid: string,
  ): Promise<{ job: RenderJob; fresh: boolean }> {
    // Only files from a group this student is in. The filename came back from their own
    // retrieval so it should already be theirs, but a second read is a second chance to
    // get the boundary wrong, and this one goes and fetches bytes.
    const shelf = await resourceRepository.forCourse(courseKey, user.groupJids)
    const byName = new Map(shelf.map((file) => [file.fileName, file]))

    const scenes = explainer.scenes.map((scene) => {
      const file = scene.fileName ? byName.get(scene.fileName) : undefined
      return {
        narration: scene.narration,
        mediaKey: renderable(file) ? file.mediaKey : null,
        fileName: renderable(file) ? file.fileName : null,
        page: renderable(file) ? scene.page : null,
        source: describe(scene),
      }
    })

    const job: RenderJob = {
      key: keyFor(user.phone, courseKey, topic),
      shardId: config.whatsapp.shardId,
      phone: user.phone,
      jid,
      courseKey,
      topic,
      title: explainer.title,
      scenes,
      status: 'pending',
      attempts: 0,
      lastError: null,
      videoPath: null,
      playbackUrl: null,
      bytes: null,
      durationSec: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }

    const fresh = await renderJobRepository.claim(job)
    const stored = fresh ? job : ((await renderJobRepository.find(job.key)) ?? job)

    logger.info(
      {
        phone: user.phone,
        courseKey,
        scenes: scenes.length,
        withSlides: scenes.filter((scene) => scene.mediaKey).length,
        fresh,
      },
      'storyboard queued',
    )
    return { job: stored, fresh }
  }
}

/**
 * Whether this file can become a slide.
 *
 * Only PDFs are rasterisable. A scene citing a photographed notice or a Word document
 * keeps its narration and loses its visual rather than failing the render — the words
 * are the explanation, and the picture is what makes it easier to follow.
 */
function renderable(file: Resource | undefined): file is Resource {
  return file !== undefined && file.mimeType === PDF_MIME
}

/**
 * One key per request, so asking twice does not render twice.
 *
 * Deliberately not time-boxed. A student who asks the same question again a week later
 * wants the same explanation, and rendering it a second time costs narration for a file
 * that already exists.
 */
function keyFor(phone: string, courseKey: string, topic: string | null): string {
  const hash = createHash('sha1')
    .update(topic ?? 'whole-course')
    .digest('hex')
    .slice(0, 12)
  return `${phone}|${courseKey}|${hash}`
}

export const storyboardService = new StoryboardService()
