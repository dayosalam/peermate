import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { config } from '../config.js'
import { logger } from '../core/logger.js'
import { getMedia, putMedia } from '../db/minio.js'
import type { JobMaterial, JobScene, RenderJob } from '../models/index.js'
import { outboxRepository, renderJobRepository } from '../repositories/index.js'

/** Long enough for a five-minute explainer plus the network being slow, short enough to give up. */
const RENDER_TIMEOUT_MS = 15 * 60 * 1000

const IDLE_POLL_MS = 5000

interface Progress {
  done: number
  total: number
  stage: string
}

interface RenderResult {
  path: string
  bytes: number
  playbackUrl: string
  durationSec: number
  fitsInChat: boolean
}

/**
 * Renders the videos students asked for, in a process that holds no socket.
 *
 * It runs outside the bot because a three-minute render must not share a process with
 * WhatsApp ingestion, and because a second process holding `auth_state` desynchronises
 * the session irrecoverably. So this one renders and writes the result down; the bot
 * reads the row and sends it. MinIO carries the bytes between them, since neither can
 * see the other's disk.
 */
export class RenderWorker {
  private running = false

  async start(): Promise<void> {
    this.running = true
    const recovered = await renderJobRepository.recoverUnfinished(config.whatsapp.shardId)
    if (recovered > 0) logger.info({ recovered }, 'render jobs put back after a restart')

    while (this.running) {
      const job = await renderJobRepository.take(config.whatsapp.shardId)
      if (!job) {
        await new Promise((resolve) => setTimeout(resolve, IDLE_POLL_MS))
        continue
      }
      await this.run(job)
    }
  }

  stop(): void {
    this.running = false
  }

  /**
   * One job, start to finish.
   *
   * Nothing thrown escapes: a job that fails is a student who gets the written
   * explanation instead, not a worker that dies holding the queue.
   */
  private async run(job: RenderJob): Promise<void> {
    const work = await mkdtemp(join(tmpdir(), 'peermate-job-'))
    const started = Date.now()

    try {
      await renderJobRepository.finish(job.key, { startedAt: new Date(), progress: 0 })

      const paths = await this.materialise(job, work)
      const storyboard = toRenderInput(job, paths)
      const boardPath = join(work, 'storyboard.json')
      const videoPath = join(work, 'explainer.mp4')
      await writeFile(boardPath, JSON.stringify(storyboard))

      const rendered = await this.spawnRender(boardPath, videoPath, (progress) =>
        renderJobRepository
          .finish(job.key, { progress: progress.done / progress.total, stage: progress.stage })
          .catch((error) => logger.warn({ err: error }, 'could not record progress')),
      )

      const bytes = await readFile(videoPath)
      const mediaKey = `render/${job.key.replace(/[^\w-]/g, '_')}.mp4`
      await putMedia(mediaKey, bytes, 'video/mp4')

      await this.handOff(job, mediaKey, rendered)
      await renderJobRepository.finish(job.key, {
        status: 'done',
        progress: 1,
        stage: 'sent',
        bytes: bytes.byteLength,
        videoPath: mediaKey,
        playbackUrl: rendered.playbackUrl,
        durationSec: rendered.durationSec,
      })
      logger.info(
        {
          key: job.key,
          seconds: Math.round((Date.now() - started) / 1000),
          bytes: bytes.byteLength,
        },
        'render delivered',
      )
    } catch (error) {
      await renderJobRepository.finish(job.key, {
        status: 'failed',
        lastError: String(error).slice(0, 400),
      })
      logger.error({ err: error, key: job.key }, 'render failed')
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  }

  /**
   * Brings down the PDFs the storyboard cites, keyed by the MinIO key that named them.
   *
   * A file that will not come back is left out rather than throwing: the scene loses
   * its picture and keeps its narration, which is the explanation.
   */
  private async materialise(job: RenderJob, work: string): Promise<Map<string, string>> {
    const paths = new Map<string, string>()
    const sceneMaterials: JobMaterial[] = job.scenes.flatMap((scene) =>
      scene.visual.kind === 'slide'
        ? [
            {
              mediaKey: scene.visual.mediaKey,
              fileName: scene.visual.fileName,
              pages: scene.visual.page ? [scene.visual.page] : [],
            },
          ]
        : [],
    )
    const materials = [...(job.materials ?? []), ...sceneMaterials]
    for (const [index, material] of materials.entries()) {
      if (paths.has(material.mediaKey)) continue
      try {
        const pdfPath = join(work, `${index}.pdf`)
        await writeFile(pdfPath, await getMedia(material.mediaKey))
        paths.set(material.mediaKey, pdfPath)
      } catch (error) {
        logger.warn({ err: error, mediaKey: material.mediaKey }, 'material could not be fetched')
      }
    }
    return paths
  }

  /**
   * Runs `render/` as a subprocess, reading progress off its stdout as it arrives.
   *
   * A subprocess rather than an import: its dependencies — a PDF rasteriser, a native
   * canvas, ffmpeg — have no business in the image the socket runs in, and the wall is
   * only real if nothing here imports across it.
   *
   * stdout is read line by line. Buffering it to exit would deliver every progress
   * update at once, after the render they were describing has already finished.
   */
  private spawnRender(
    board: string,
    out: string,
    onProgress: (progress: Progress) => void,
  ): Promise<RenderResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(config.render.command, [...config.render.args, board, out], {
        cwd: config.render.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`render exceeded ${RENDER_TIMEOUT_MS}ms`))
      }, RENDER_TIMEOUT_MS)

      let result: RenderResult | null = null
      createInterface({ input: child.stdout }).on('line', (line) => {
        try {
          const parsed = JSON.parse(line) as { progress?: Progress; result?: RenderResult }
          if (parsed.progress) onProgress(parsed.progress)
          if (parsed.result) result = parsed.result
        } catch {
          // The renderer also prints human lines. Not every line is a progress record.
        }
      })

      let stderr = ''
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })

      child.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0 && result) resolve(result)
        else if (code === 0) reject(new Error('render exited without reporting its result'))
        else reject(new Error(`render exited ${code}: ${stderr.slice(-400)}`))
      })
    })
  }

  /**
   * Hands the finished video to the process that can send it.
   *
   * `solicited`, so it goes out when it is ready rather than waiting for quiet hours —
   * the student asked for this and watched it being built.
   */
  private async handOff(job: RenderJob, mediaKey: string, rendered: RenderResult): Promise<void> {
    await outboxRepository.claim({
      key: `render:${job.key}`,
      shardId: job.shardId,
      phone: job.phone,
      jid: job.jid,
      body: job.title,
      status: 'pending',
      attempts: 0,
      lastError: null,
      video: {
        mediaKey,
        playbackUrl: rendered.playbackUrl,
        bytes: rendered.bytes,
        durationSec: rendered.durationSec,
      },
      solicited: true,
      notBefore: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    })
  }
}

/**
 * The job as `render/` needs it: MinIO keys resolved to files on disk.
 *
 * A slide whose file did not come back becomes a title card. Pure, so a test can check
 * that rule without a renderer, a database or a network.
 */
export function toStoryboard(job: RenderJob, paths: Map<string, string>): unknown {
  const scenes = job.scenes.map((scene: JobScene) => ({
    narration: scene.narration,
    visual: visualFor(scene, paths, job.title),
    source: scene.source,
  }))
  return { title: job.title, course: job.courseKey, scenes }
}

/** New jobs plan an animated lesson from the exact PDFs retrieval selected. */
export function toRenderInput(job: RenderJob, paths: Map<string, string>): unknown {
  const materials = (job.materials ?? []).flatMap((material) => {
    const path = paths.get(material.mediaKey)
    return path ? [{ path, fileName: material.fileName, pages: material.pages }] : []
  })
  if (materials.length === 0) return toStoryboard(job, paths)
  return {
    kind: 'whiteboard-request',
    course: job.courseKey,
    topic: job.topic,
    mode: job.renderMode ?? 'structured',
    materials,
  }
}

function visualFor(scene: JobScene, paths: Map<string, string>, title: string): unknown {
  if (scene.visual.kind === 'title') return { kind: 'title', text: scene.visual.text }
  if (scene.visual.kind === 'generated') return { kind: 'generated', prompt: scene.visual.prompt }

  const pdfPath = paths.get(scene.visual.mediaKey)
  return pdfPath
    ? { kind: 'slide', pdfPath, page: scene.visual.page ?? 1 }
    : { kind: 'title', text: title }
}

export const renderWorker = new RenderWorker()
