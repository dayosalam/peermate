import { z } from 'zod'

/**
 * What the student looks at while a beat is spoken.
 *
 * A union rather than nullable fields, for the reason the extraction `kind` is one: a
 * shape that lets both be half-filled cannot say which was chosen, and a test has to
 * be able to assert that `generated` never landed on a beat carrying a formula.
 *
 * `mediaKey` rather than a path — a temporary path written into a queued job is
 * meaningless by the time the job runs.
 */
export const JobVisualSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('slide'),
    mediaKey: z.string(),
    fileName: z.string(),
    page: z.number().int().positive().nullable(),
  }),
  z.object({ kind: z.literal('title'), text: z.string() }),
  /** Allowed only where it cannot be wrong about the subject: openers, breaks, closers. */
  z.object({ kind: z.literal('generated'), prompt: z.string().min(1) }),
])
export type JobVisual = z.infer<typeof JobVisualSchema>

export const JobSceneSchema = z.object({
  narration: z.string(),
  visual: JobVisualSchema,
  /** The line burned into the frame, so a screenshot still says where it came from. */
  source: z.string().nullable(),
})
export type JobScene = z.infer<typeof JobSceneSchema>

export const JobMaterialSchema = z.object({
  mediaKey: z.string(),
  fileName: z.string(),
  pages: z.array(z.number().int().positive()).default([]),
})
export type JobMaterial = z.infer<typeof JobMaterialSchema>

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
  /** Explicit user-selected renderer; Peermate does not auto-rank the two styles yet. */
  renderMode: z.enum(['structured', 'scripted']).default('structured'),
  scenes: z.array(JobSceneSchema),
  /** PDFs selected by grounded retrieval for the whiteboard planner. */
  materials: z.array(JobMaterialSchema).default([]),
  status: z.enum(['pending', 'rendering', 'done', 'failed']).default('pending'),
  attempts: z.number().default(0),
  lastError: z.string().nullable().default(null),
  /** From stages that actually finished, never a timer imitating one — a student decides whether to keep waiting on it. */
  progress: z.number().min(0).max(1).default(0),
  stage: z.string().nullable().default(null),
  startedAt: z.date().nullable().default(null),
  /**
   * The one message being rewritten in place.
   *
   * WhatsApp stops accepting edits about fifteen minutes in, and says nothing, so
   * `sentAt` is what tells the runner to start a fresh message.
   */
  progressMessage: z
    .object({
      id: z.string(),
      remoteJid: z.string(),
      fromMe: z.boolean(),
      sentAt: z.date(),
    })
    .nullable()
    .default(null),
  /** Where the finished file landed, or the playback link if it was too big to send. */
  videoPath: z.string().nullable().default(null),
  playbackUrl: z.string().nullable().default(null),
  bytes: z.number().nullable().default(null),
  durationSec: z.number().nullable().default(null),
  createdAt: z.date(),
  updatedAt: z.date(),
})
export type RenderJob = z.infer<typeof RenderJobSchema>
