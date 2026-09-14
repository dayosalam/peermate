import { z } from 'zod'

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
  /**
   * Whether WhatsApp will carry this as a video in the chat.
   *
   * Not an error either way. Under the ceiling it is sent as a file, which plays
   * inline and is kept; over it, it is uploaded and sent as a playback link. The
   * caller decides, because only the caller knows what it can reach.
   */
  fitsInChat: boolean
}
