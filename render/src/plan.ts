import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import OpenAI from 'openai'
import { extractText, getDocumentProxy } from 'unpdf'
import { ZodError } from 'zod'
import { StoryboardSchema, type Storyboard } from './storyboard.js'

const MAX_MATERIAL_CHARS = 45_000

const STRUCTURED_SYSTEM = `You create concise animated whiteboard lessons from supplied study material.

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
- Use 4 to 8 scenes and 1 to 14 meaningful actions per scene. Sparse title or transition scenes may need only one or two actions.
- Make the visuals explain the idea: evolving diagrams, flows, comparisons, worked steps and highlights. Do not merely write the narration on screen.
- Keep all elements inside the board. Avoid overlaps. Text must be short enough to read on a phone.
- Introduce an object before connecting or highlighting it. Space action timings across the narration.
- Set carry=true only when this scene continues the exact diagram from the immediately preceding scene. Otherwise use carry=false and make the scene self-contained. Never refer to an object that is absent from the current board.
- An arrow starts at its tail and ends at its arrowhead. Upward forces end above their beam; downward loads start above the beam and end on it.
- Use only facts supported by the material. Never invent a formula, label, value or relationship.
- Never create a worked example with values unless those exact values appear in the cited material.
- Cite the supporting filename and page in every scene. If the page cannot be established, cite the filename without inventing one.
- Narration should sound natural, direct and descriptive, with roughly 25 to 55 words per scene.`

const SCRIPTED_SYSTEM = `You create dense, hand-drawn whiteboard lessons from supplied study material.

Return JSON only in this shape:
{"title":"...","course":"...","scenes":[{"narration":"...","visual":{"kind":"scripted","actions":[...]} ,"source":"filename, p.N"}]}

Allowed actions use normalized board coordinates and timing fractions:
- title/write: {"type":"title" or "write","text":"...","x":0..1,"y":0..1,"size":20..72,"color":"#hex","at":0..1,"duration":0..1}
- bullets: {"type":"bullets","items":["..."],"x":0..1,"y":0..1,"size":20..54,"spacing":0.05..0.15,"at":...,"duration":...}
- line/arrow: {"type":"line" or "arrow","fromX":0..1,"fromY":0..1,"toX":0..1,"toY":0..1,"color":"#hex","at":...,"duration":...}
- box/highlight: {"type":"box" or "highlight","x":0..1,"y":0..1,"width":0..1,"height":0..1,"color":"#hex","at":...,"duration":...}
- circle: {"type":"circle","x":0..1,"y":0..1,"radius":0.01..0.3,"color":"#hex","at":...,"duration":...}
- road: {"type":"road","x":0..1,"y":0..1,"width":0..1,"height":0..1,"at":...,"duration":...}
- layers: {"type":"layers","items":["surface","base"],"x":0..1,"y":0..1,"width":0..1,"rowHeight":0.04..0.15,"at":...,"duration":...}

Rules:
- Use 3 to 8 scenes and 5 to 16 useful actions per scene. Create content-rich boards, not sparse title cards.
- Explain visually with diagrams, comparisons, labels and concise bullets. Do not transcribe the narration.
- Keep every object within the board and reserve space so labels, highlights and diagrams never collide.
- Start drawing immediately and distribute actions across the whole narration. No blank transition scenes.
- Use title for a short heading only. Use write for labels. Use bullets for multi-line explanations.
- Use only facts supported by the supplied material and cite the exact filename and page in every scene.
- Narration should be natural and descriptive, roughly 35 to 65 words per scene.`

const REVIEW = `Audit and correct this proposed whiteboard lesson against the supplied material. Return the complete corrected storyboard as JSON only.

Reject or repair:
- unsupported facts, formulas, values, examples or page citations;
- arrows whose geometry contradicts their meaning or narration;
- labels attached to the wrong object;
- visual actions that do not help explain or introduce the scene;
- diagrams that merely transcribe narration instead of demonstrating the idea;
- overlapping or off-board elements;
- carry=true when the scene is not continuing the same diagram, or carry=false while referring to an earlier object;
- actions that complete too early instead of developing across the narration.

Preserve useful parts, but factual and diagrammatic correctness comes first.`

export async function planFromPdf(
  file: string,
  topic: string,
  pages?: number[],
  mode: 'structured' | 'scripted' = 'structured',
): Promise<Storyboard> {
  return planFromPdfs(
    [{ path: file, fileName: basename(file), pages, strictPages: pages !== undefined }],
    topic,
    pages ? { requiredPages: pages, minWordsPerPage: 50 } : undefined,
    mode,
  )
}

export interface PlanningMaterial {
  path: string
  fileName: string
  pages?: number[]
  strictPages?: boolean
}

interface PlanningRequirements {
  requiredPages: number[]
  minWordsPerPage: number
}

/** Plans across the exact course files selected by retrieval, preserving page provenance. */
export async function planFromPdfs(
  files: PlanningMaterial[],
  topic: string,
  requirements?: PlanningRequirements,
  mode: 'structured' | 'scripted' = 'structured',
): Promise<Storyboard> {
  if (files.length === 0) throw new Error('the whiteboard planner needs at least one PDF')

  const sections: string[] = []
  for (const file of files) {
    const bytes = await readFile(file.path)
    const pdf = await getDocumentProxy(new Uint8Array(bytes))
    const extracted = await extractText(pdf, { mergePages: false })
    const pages = Array.isArray(extracted.text) ? extracted.text : [extracted.text]
    const wanted = selectedPages(file.pages, pages.length, file.strictPages ?? false)
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
  const coverage = requirements
    ? `\n\nCoverage requirements:\n- Cover every one of these pages: ${requirements.requiredPages.join(', ')}.\n- Target at least ${requirements.requiredPages.length * requirements.minWordsPerPage} spoken words across the selected pages, approximately 20 seconds per page on average. Allocate more narration and scenes to dense pages and less to sparse title or divider pages.\n- Do not cite or create scenes for pages outside this list.\n- Use as many scenes as needed for complete coverage.`
    : ''

  const client = new OpenAI({ apiKey: process.env['OPENAI_API_KEY'] })
  const system = mode === 'scripted' ? SCRIPTED_SYSTEM : STRUCTURED_SYSTEM
  const draft = await complete(
    client,
    system,
    `Create a whiteboard lesson about: ${topic}${coverage}\n\nSource files: ${sourceNames}\n\nMaterial:\n${material}`,
  )
  const reviewed = await complete(
    client,
    `${system}\n\n${REVIEW}`,
    `Topic: ${topic}${coverage}\n\nSource files: ${sourceNames}\n\nMaterial:\n${material}\n\nProposed storyboard:\n${JSON.stringify(draft)}`,
  )
  try {
    const parsed = StoryboardSchema.parse(reviewed)
    const coverageErrors = coverageIssues(parsed, requirements)
    if (coverageErrors.length > 0) throw new Error(coverageErrors.join('; '))
    return correctKnownGeometry(parsed)
  } catch (error) {
    const issues = error instanceof ZodError ? error.issues : [String(error)]
    const repaired = await complete(
      client,
      `${system}\n\nReturn a corrected complete storyboard. It must satisfy every validation error exactly.`,
      `Validation errors:\n${JSON.stringify(issues)}\n${coverage}\n\nInvalid storyboard:\n${JSON.stringify(reviewed)}\n\nSource material:\n${material}`,
    )
    const parsed = StoryboardSchema.parse(repaired)
    const coverageErrors = coverageIssues(parsed, requirements)
    if (coverageErrors.length > 0) throw new Error(coverageErrors.join('; '))
    return correctKnownGeometry(parsed)
  }
}

/** Selected pages plus one page either side, so a formula does not lose its setup. */
function selectedPages(
  selected: number[] | undefined,
  pageCount: number,
  strict: boolean,
): Set<number> | null {
  if (!selected || selected.length === 0) return null
  const pages = new Set<number>()
  for (const page of selected) {
    for (const candidate of strict ? [page] : [page - 1, page, page + 1]) {
      if (candidate >= 1 && candidate <= pageCount) pages.add(candidate)
    }
  }
  return pages
}

function coverageIssues(
  storyboard: Storyboard,
  requirements: PlanningRequirements | undefined,
): string[] {
  if (!requirements) return []
  const errors: string[] = []
  for (const page of requirements.requiredPages) {
    const scenes = storyboard.scenes.filter(
      (scene) => scene.source?.match(/p\.(\d+)/)?.[1] === String(page),
    )
    if (scenes.length === 0) errors.push(`page ${page} has no scene`)
  }
  const totalWords = storyboard.scenes.reduce(
    (total, scene) => total + scene.narration.trim().split(/\s+/).filter(Boolean).length,
    0,
  )
  const requiredWords = requirements.requiredPages.length * requirements.minWordsPerPage
  if (totalWords < requiredWords)
    errors.push(`lesson has ${totalWords} words, needs ${requiredWords} across selected pages`)
  const allowed = new Set(requirements.requiredPages)
  for (const scene of storyboard.scenes) {
    const page = Number(scene.source?.match(/p\.(\d+)/)?.[1])
    if (Number.isFinite(page) && !allowed.has(page))
      errors.push(`page ${page} is outside the request`)
  }
  return errors
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
