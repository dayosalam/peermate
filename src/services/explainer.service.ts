import { z } from 'zod'
import { zodResponseFormat } from 'openai/helpers/zod'
import { config } from '../config.js'
import { logger } from '../core/logger.js'
import type { User } from '../models/index.js'
import { courseDisplay } from '../utils/courses.js'
import { similarity } from '../utils/similarity.js'
import { getOpenAI } from './openai.client.js'
import { type Candidate, retrievalService } from './retrieval.service.js'
import { format, sample } from './material.js'

/**
 * One beat of the explanation: what is said, and where it came from.
 *
 * Called a scene rather than a paragraph because this is the unit a visual explainer
 * would render — the storyboard for that is this schema plus a `visual` field, not a
 * different shape. Getting the name right now is free; migrating a stored script
 * later is not.
 */
const SceneSchema = z.object({
  narration: z.string(),
  /**
   * The file and page this beat came from, copied from the excerpt header.
   *
   * Structured rather than a sentence the model composes. A storyboard has to resolve
   * this back to an actual file, and parsing "CVE575_wk4.pdf, p.8" means trusting a
   * string the model wrote — the same mistake `resolveCourse` exists to prevent. Both
   * are checked against the material that was actually retrieved before being used.
   */
  fileName: z.string().nullable(),
  page: z.number().int().positive().nullable(),
})

const ExplainerSchema = z.object({
  title: z.string(),
  scenes: z.array(SceneSchema),
  /**
   * What the student asked about that the material does not answer.
   *
   * The alternative is the model quietly filling the gap from its own knowledge,
   * which is indistinguishable from the lecturer having taught it — and a student
   * revising from that has no way to find out otherwise.
   */
  notCovered: z.array(z.string()),
})

export type Explainer = z.infer<typeof ExplainerSchema>

/**
 * How long the explanation should run.
 *
 * A voice note is listened to once, on the way in, and can afford to cover a topic.
 * A video is answered-shaped: it takes minutes to build and a student who asked one
 * question will not watch five minutes of what they did not ask about.
 */
export type Shape = 'spoken' | 'video'

const LENGTH: Record<Shape, string> = {
  spoken: 'Eight to fourteen scenes. Aim for three to five minutes spoken.',
  video:
    'Two to five scenes, ninety seconds spoken at most. Answer what was asked and stop; leave the rest for when they ask again.',
}
export type Scene = z.infer<typeof SceneSchema>

const SYSTEM = `You explain one topic to a Nigerian university student, out loud, using ONLY the course material provided.

This is written to be heard, not read:
- Say it the way a good classmate explains it at a desk — plain, direct, one idea at a time.
- No headings, no bullets, no markup, no "as shown in the figure". The student is listening and cannot see anything.
- Read equations as words: "V equals d M by d x", not "V = dM/dx".
- Expand an abbreviation the first time it is spoken.

Rules:
- Every claim must come from the provided material. Never add an example, a formula or a definition that is not in it.
- Each scene is two to four sentences and one idea. Set fileName and page to the file and page of the excerpt it came from, spelled exactly as the header gives them. Leave both null when the beat draws on several, and for an opening or closing scene that states no fact.
- LENGTH
- Open by saying what will be covered. Close with the one thing worth remembering.
- If the material does not cover part of what was asked, put it in notCovered and say nothing about it. Returning a shorter explanation is correct; inventing the rest is not.`

/**
 * A spoken explanation of a topic, built from what the lecturer actually shared.
 *
 * The narration and the text are the same script rendered twice: the student hears it
 * on the way in and keeps the written version with its page references, which is the
 * same trade the morning digest makes. A voice note alone cannot be skimmed, searched
 * or screenshotted, and a test formula they cannot scroll back to is worse than none.
 */
export class ExplainerService {
  async explain(
    user: User,
    courseKey: string,
    topic: string | null,
    shape: Shape = 'spoken',
    sourceHint: string | null = null,
  ): Promise<Explainer | null> {
    // A named topic is searched for; "explain this course" takes the material as it
    // stands. Searching on an empty topic returns whatever the embedding of nothing
    // happens to be near, which is not the same as everything.
    const found = sourceHint
      ? await this.fromNamedSource(courseKey, user, sourceHint)
      : topic
        ? await retrievalService.search(topic, [courseKey], user.groupJids, user.phone)
        : await retrievalService.material(courseKey, user.groupJids)

    const readable = found.filter((chunk) => chunk.readVia !== 'none')
    if (readable.length === 0) return null

    const script = await this.script(readable, courseKey, topic, shape)
    return script
      ? { ...script, scenes: script.scenes.map((scene) => cite(scene, readable)) }
      : null
  }

  /** A named note is a boundary: never fill its gaps from a different PDF. */
  private async fromNamedSource(
    courseKey: string,
    user: User,
    sourceHint: string,
  ): Promise<Candidate[]> {
    const material = await retrievalService.material(courseKey, user.groupJids)
    const names = [...new Set(material.map((chunk) => chunk.fileName).filter(Boolean))] as string[]
    let best: string | null = null
    let score = 0
    for (const name of names) {
      const next = similarity(sourceHint, name)
      if (next > score) {
        best = name
        score = next
      }
    }
    if (!best || score < 0.35) return []
    return material.filter((chunk) => chunk.fileName === best)
  }

  private async script(
    material: Candidate[],
    courseKey: string,
    topic: string | null,
    shape: Shape,
  ): Promise<Explainer | null> {
    const course = courseDisplay(courseKey) ?? courseKey

    try {
      const completion = await getOpenAI().beta.chat.completions.parse({
        model: config.openai.answerModel,
        messages: [
          { role: 'system', content: SYSTEM.replace('- LENGTH', `- ${LENGTH[shape]}`) },
          {
            role: 'user',
            content: `Course: ${course}
${topic ? `They asked about: ${topic}` : 'They asked for an explanation of the course material as a whole.'}

Material:
${format(sample(material))}`,
          },
        ],
        response_format: zodResponseFormat(ExplainerSchema, 'explainer'),
      })
      return completion.choices[0]?.message.parsed ?? null
    } catch (error) {
      logger.error({ err: error, courseKey, topic }, 'could not build explainer')
      return null
    }
  }

  /** The script as one continuous piece of speech, with the citations left out. */
  narration(explainer: Explainer): string {
    return explainer.scenes.map((scene) => scene.narration).join(' ')
  }

  /** The same script to read and keep, where the page references belong. */
  written(explainer: Explainer, courseKey: string): string {
    const course = courseDisplay(courseKey) ?? courseKey
    const lines = [
      `🎧 *${explainer.title}*`,
      `_${course}, from the files shared in your group._`,
      '',
    ]

    for (const scene of explainer.scenes) {
      const cited = describe(scene)
      lines.push(cited ? `${scene.narration}\n_${cited}_` : scene.narration, '')
    }

    if (explainer.notCovered.length > 0) {
      lines.push(`_Not in the material, so I left it out: ${explainer.notCovered.join(', ')}._`)
    }

    return lines.join('\n').trim()
  }
}

/** The citation as a student reads it, built from the stored fields and not by the model. */
export function describe(scene: Scene): string | null {
  if (!scene.fileName) return null
  return scene.page ? `${scene.fileName}, p.${scene.page}` : scene.fileName
}

/**
 * Keeps a citation only when it names material that was actually retrieved.
 *
 * A model asked for a filename will supply a plausible one, and a plausible filename
 * is what a storyboard would later go looking for on disk. An unrecognised name is
 * dropped to null rather than corrected: a scene with no citation is honest, a scene
 * citing a file nobody shared is not.
 */
function cite(scene: Scene, material: Candidate[]): Scene {
  if (!scene.fileName) return { ...scene, page: null }

  const named = material.filter((chunk) => chunk.fileName === scene.fileName)
  if (named.length === 0) return { ...scene, fileName: null, page: null }

  const pages = new Set(named.map((chunk) => chunk.page))
  return scene.page !== null && pages.has(scene.page) ? scene : { ...scene, page: null }
}

export const explainerService = new ExplainerService()
