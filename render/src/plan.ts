import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import OpenAI from 'openai'
import { extractText, getDocumentProxy } from 'unpdf'
import { ZodError } from 'zod'
import { StoryboardSchema, type Storyboard } from './storyboard.js'

const MAX_MATERIAL_CHARS = 45_000

const SYSTEM = `You create concise animated whiteboard lessons from supplied study material.

Return JSON only, matching this shape:
{"title":"...","course":"...","scenes":[{"narration":"...","visual":{"kind":"whiteboard","carry":false,"actions":[...]},"source":"filename, p.N"}]}

Every scene must use visual.kind "whiteboard". Actions are timed against that scene's narration with "at" and "duration" as fractions from 0 to 1.

Allowed actions:
- {"type":"write","text":"short text","x":0..1,"y":0..1,"size":18..72,"color":"#hex","at":0..1,"duration":0.02..1}
- {"type":"box","x":0..1,"y":0..1,"width":0..1,"height":0..1,"label":"short label or null","color":"#hex","at":...,"duration":...}
- {"type":"circle","x":0..1,"y":0..1,"radius":0..1,"label":"short label or null","color":"#hex","at":...,"duration":...}
- {"type":"line" or "arrow","fromX":0..1,"fromY":0..1,"toX":0..1,"toY":0..1,"label":"short label or null for arrow","color":"#hex","at":...,"duration":...}
- {"type":"highlight" or "erase","x":0..1,"y":0..1,"width":0..1,"height":0..1,"color":"#hex only for highlight","at":...,"duration":...}

Rules:
- Teach one causal step at a time, like a skilled whiteboard explainer.
- Use 4 to 8 scenes and 4 to 14 actions per scene.
- Make the visuals explain the idea: evolving diagrams, flows, comparisons, worked steps and highlights. Do not merely write the narration on screen.
- Keep all elements inside the board. Avoid overlaps. Text must be short enough to read on a phone.
- Introduce an object before connecting or highlighting it. Space action timings across the narration.
- Set carry=true only when this scene continues the exact diagram from the immediately preceding scene. Otherwise use carry=false and make the scene self-contained. Never refer to an object that is absent from the current board.
- An arrow starts at its tail and ends at its arrowhead. Upward forces end above their beam; downward loads start above the beam and end on it.
- Use only facts supported by the material. Never invent a formula, label, value or relationship.
- Never create a worked example with values unless those exact values appear in the cited material.
- Cite the supporting filename and page in every scene. If the page cannot be established, cite the filename without inventing one.
- Narration should sound natural, direct and descriptive, with roughly 25 to 55 words per scene.`

const REVIEW = `Audit and correct this proposed whiteboard lesson against the supplied material. Return the complete corrected storyboard as JSON only.

Reject or repair:
- unsupported facts, formulas, values, examples or page citations;
- arrows whose geometry contradicts their meaning or narration;
- labels attached to the wrong object;
- fewer than four meaningful visual actions in any scene;
- diagrams that merely transcribe narration instead of demonstrating the idea;
- overlapping or off-board elements;
- carry=true when the scene is not continuing the same diagram, or carry=false while referring to an earlier object;
- actions that complete too early instead of developing across the narration.

Preserve useful parts, but factual and diagrammatic correctness comes first.`

export async function planFromPdf(file: string, topic: string): Promise<Storyboard> {
  return planFromPdfs([{ path: file, fileName: basename(file) }], topic)
}

export interface PlanningMaterial {
  path: string
  fileName: string
  pages?: number[]
}

/** Plans across the exact course files selected by retrieval, preserving page provenance. */
export async function planFromPdfs(files: PlanningMaterial[], topic: string): Promise<Storyboard> {
  if (files.length === 0) throw new Error('the whiteboard planner needs at least one PDF')

  const sections: string[] = []
  for (const file of files) {
    const bytes = await readFile(file.path)
    const pdf = await getDocumentProxy(new Uint8Array(bytes))
    const extracted = await extractText(pdf, { mergePages: false })
    const pages = Array.isArray(extracted.text) ? extracted.text : [extracted.text]
    const wanted = contextualPages(file.pages, pages.length)
    sections.push(
      `=== file: ${file.fileName} ===\n${pages
        .map((page, index) => ({ page, number: index + 1 }))
        .filter(({ number }) => wanted === null || wanted.has(number))
        .map(({ page, number }) => `--- page ${number} ---\n${page}`)
        .join('\n\n')}`,
    )
  }
  const material = sections.join('\n\n').slice(0, MAX_MATERIAL_CHARS)
  const sourceNames = files.map((file) => file.fileName).join(', ')

  const client = new OpenAI({ apiKey: process.env['OPENAI_API_KEY'] })
  const draft = await complete(
    client,
    SYSTEM,
    `Create a whiteboard lesson about: ${topic}\n\nSource files: ${sourceNames}\n\nMaterial:\n${material}`,
  )
  const reviewed = await complete(
    client,
    `${SYSTEM}\n\n${REVIEW}`,
    `Topic: ${topic}\n\nSource files: ${sourceNames}\n\nMaterial:\n${material}\n\nProposed storyboard:\n${JSON.stringify(draft)}`,
  )
  try {
    return correctKnownGeometry(StoryboardSchema.parse(reviewed))
  } catch (error) {
    if (!(error instanceof ZodError)) throw error
    const repaired = await complete(
      client,
      `${SYSTEM}\n\nReturn a corrected complete storyboard. It must satisfy every validation error exactly.`,
      `Validation errors:\n${JSON.stringify(error.issues)}\n\nInvalid storyboard:\n${JSON.stringify(reviewed)}\n\nSource material:\n${material}`,
    )
    return correctKnownGeometry(StoryboardSchema.parse(repaired))
  }
}

/** Selected pages plus one page either side, so a formula does not lose its setup. */
function contextualPages(selected: number[] | undefined, pageCount: number): Set<number> | null {
  if (!selected || selected.length === 0) return null
  const pages = new Set<number>()
  for (const page of selected) {
    for (const candidate of [page - 1, page, page + 1]) {
      if (candidate >= 1 && candidate <= pageCount) pages.add(candidate)
    }
  }
  return pages
}

/** Repairs a narrow, mechanically provable error instead of trusting visual prose. */
export function correctKnownGeometry(storyboard: Storyboard): Storyboard {
  for (const scene of storyboard.scenes) {
    if (scene.visual.kind !== 'whiteboard') continue
    for (const action of scene.visual.actions) {
      if (
        action.type === 'arrow' &&
        action.label &&
        /^R(?:_|\s|[A-Z])/i.test(action.label) &&
        Math.abs(action.toX - action.fromX) < 0.08 &&
        action.toY > action.fromY
      ) {
        ;[action.fromY, action.toY] = [action.toY, action.fromY]
      }
      if (
        action.type === 'arrow' &&
        action.label &&
        /(?:\bload\b|^\s*\d+(?:\.\d+)?\s*kN\b)/i.test(action.label) &&
        Math.abs(action.toX - action.fromX) < 0.08 &&
        action.toY < action.fromY
      ) {
        ;[action.fromY, action.toY] = [action.toY, action.fromY]
      }
    }
  }
  return storyboard
}

async function complete(client: OpenAI, system: string, content: string): Promise<unknown> {
  const completion = await client.chat.completions.create({
    model: process.env['OPENAI_VIDEO_MODEL'] ?? 'gpt-4o',
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content },
    ],
  })

  const raw = completion.choices[0]?.message.content
  if (!raw) throw new Error('the planner returned no storyboard')
  return JSON.parse(raw)
}
