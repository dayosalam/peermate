import { z } from 'zod'

const Coordinate = z.number().min(0).max(1)
const Timed = { at: z.number().min(0).max(1), duration: z.number().min(0.02).max(1).default(0.12) }

/** A small, deterministic visual language the planner can compose safely. */
export const WhiteboardActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('write'),
    text: z.string(),
    x: Coordinate,
    y: Coordinate,
    size: z.number().min(18).max(72).default(38),
    color: z.string().default('#172033'),
    ...Timed,
  }),
  z.object({
    type: z.literal('box'),
    x: Coordinate,
    y: Coordinate,
    width: Coordinate,
    height: Coordinate,
    label: z.string().nullable().default(null),
    color: z.string().default('#2563eb'),
    ...Timed,
  }),
  z.object({
    type: z.literal('circle'),
    x: Coordinate,
    y: Coordinate,
    radius: Coordinate,
    label: z.string().nullable().default(null),
    color: z.string().default('#7c3aed'),
    ...Timed,
  }),
  z.object({
    type: z.literal('line'),
    fromX: Coordinate,
    fromY: Coordinate,
    toX: Coordinate,
    toY: Coordinate,
    color: z.string().default('#172033'),
    ...Timed,
  }),
  z.object({
    type: z.literal('arrow'),
    fromX: Coordinate,
    fromY: Coordinate,
    toX: Coordinate,
    toY: Coordinate,
    label: z.string().nullable().default(null),
    color: z.string().default('#dc2626'),
    ...Timed,
  }),
  z.object({
    type: z.literal('highlight'),
    x: Coordinate,
    y: Coordinate,
    width: Coordinate,
    height: Coordinate,
    color: z.string().default('#fde047'),
    ...Timed,
  }),
  z.object({
    type: z.literal('erase'),
    x: Coordinate,
    y: Coordinate,
    width: Coordinate,
    height: Coordinate,
    ...Timed,
  }),
])
export type WhiteboardAction = z.infer<typeof WhiteboardActionSchema>

/**
 * What the student sees while a scene is spoken.
 *
 * `slide` is a page of a file their lecturer actually shared — the only visual that
 * cannot be wrong about the subject. A generated diagram can put the arrows on a
 * shear force diagram the wrong way round, and a student revising from it has no way
 * to find that out; the real page is never wrong about what was taught.
 *
 * `title` is for the opening and closing beats, where there is nothing to show yet.
 */
export const VisualSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('slide'),
    /** Local path to the PDF. The caller fetches it; this package never touches MinIO. */
    pdfPath: z.string(),
    /** 1-based, as a reader counts pages. */
    page: z.number().int().positive(),
  }),
  z.object({ kind: z.literal('title'), text: z.string() }),
  z.object({
    kind: z.literal('whiteboard'),
    /** Continue the immediately preceding board only when the diagram truly continues. */
    carry: z.boolean().default(false),
    actions: z.array(WhiteboardActionSchema).min(4).max(24),
  }),
  /**
   * An image made for this beat rather than taken from the material. Only where it
   * cannot carry content — an opener, a break, a closing card. Never a diagram or a
   * formula: that is what a generated image gets confidently wrong, and a student
   * revising from it is the last person able to notice.
   *
   * Its own variant so the choice is recorded rather than implied, which is what lets a
   * test assert the rule held.
   */
  z.object({ kind: z.literal('generated'), prompt: z.string().min(1) }),
])
export type Visual = z.infer<typeof VisualSchema>

export const SceneSchema = z.object({
  narration: z.string().min(1),
  visual: VisualSchema,
  /** "CVE575_wk4.pdf, p.8" — burned into the frame, so a screenshot keeps its source. */
  source: z.string().nullable().default(null),
})
export type Scene = z.infer<typeof SceneSchema>

export const StoryboardSchema = z.object({
  title: z.string(),
  course: z.string(),
  scenes: z.array(SceneSchema).min(1),
})
export type Storyboard = z.infer<typeof StoryboardSchema>

export interface Rendered {
  path: string
  bytes: number
  durationSec: number
  /** Where the network is already hosting it — the only form that fits when the file does not. */
  playbackUrl: string
  /**
   * Whether WhatsApp will carry this as a video in the chat.
   *
   * Not an error either way. Under the ceiling it is sent as a file, which plays
   * inline and is kept; over it, it is uploaded and sent as a playback link. The
   * caller decides, because only the caller knows what it can reach.
   */
  fitsInChat: boolean
}
