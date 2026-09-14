import { z } from 'zod'

/**
 * A scene as it is stored, before anything has been fetched.
 *
 * `mediaKey` rather than a path: MinIO is the only place the file lives, and a
 * temporary path written into a queued job is meaningless by the time the job runs.
 * Whoever renders it materialises the files first.
 */
export const JobSceneSchema = z.object({
  narration: z.string(),
  mediaKey: z.string().nullable(),
  fileName: z.string().nullable(),
  page: z.number().int().positive().nullable(),
  /** The line burned into the frame, so a screenshot still says where it came from. */
  source: z.string().nullable(),
})
export type JobScene = z.infer<typeof JobSceneSchema>

/**
 * A video a student asked for, and the state of making it.
 *
 * Durable, unlike the ingest queue. A dropped transcription costs one re-read because
 * WhatsApp re-delivers the message; a dropped render costs the narration already paid
 * for and a student who was told a video was coming and never hears again.
 */
export const RenderJobSchema = z.object({
  /** One per (student, course, topic) request, so a double-tap does not render twice. */
  key: z.string(),
  shardId: z.string(),
  phone: z.string(),
  jid: z.string(),
  courseKey: z.string(),
  topic: z.string().nullable(),
  title: z.string(),
  scenes: z.array(JobSceneSchema),
  status: z.enum(['pending', 'rendering', 'done', 'failed']).default('pending'),
  attempts: z.number().default(0),
  lastError: z.string().nullable().default(null),
  /** Where the finished file landed, or the playback link if it was too big to send. */
  videoPath: z.string().nullable().default(null),
  playbackUrl: z.string().nullable().default(null),
  bytes: z.number().nullable().default(null),
  durationSec: z.number().nullable().default(null),
  createdAt: z.date(),
  updatedAt: z.date(),
})
export type RenderJob = z.infer<typeof RenderJobSchema>
