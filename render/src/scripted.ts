import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

const coordinate = z.number().min(0).max(1)
const timing = { at: z.number().min(0).max(1), duration: z.number().positive().max(1) }
const base = { x: coordinate, y: coordinate, color: z.string().optional(), ...timing }
export const ScriptActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.enum(['write', 'title']),
    text: z.string().min(1).max(100),
    size: z.number().min(20).max(72).optional(),
    ...base,
  }),
  z.object({
    type: z.literal('bullets'),
    items: z.array(z.string().min(1).max(70)).min(1).max(6),
    size: z.number().min(20).max(54).optional(),
    spacing: z.number().min(0.05).max(0.15).optional(),
    ...base,
  }),
  z.object({
    type: z.enum(['line', 'arrow']),
    fromX: coordinate,
    fromY: coordinate,
    toX: coordinate,
    toY: coordinate,
    color: z.string().optional(),
    ...timing,
  }),
  z.object({ type: z.enum(['box', 'highlight']), width: coordinate, height: coordinate, ...base }),
  z.object({ type: z.literal('circle'), radius: z.number().min(0.01).max(0.3), ...base }),
  z.object({ type: z.literal('road'), width: coordinate, height: coordinate, ...base }),
  z.object({
    type: z.literal('layers'),
    items: z.array(z.string().min(1).max(30)).min(2).max(7),
    width: coordinate,
    rowHeight: z.number().min(0.04).max(0.15).optional(),
    ...base,
  }),
])

export const ScriptSceneSchema = z.object({
  actions: z.array(ScriptActionSchema).min(2).max(30),
  source: z.string().nullable(),
})
export type ScriptScene = z.infer<typeof ScriptSceneSchema>
export const SCRIPTED_FPS = 12
export const MAX_INACTIVE_SECONDS = 0.5

/** Repairs timing so visual work continues throughout spoken audio. */
export function paceScriptedScene(input: ScriptScene, seconds: number): ScriptScene {
  const scene = ScriptSceneSchema.parse(structuredClone(input))
  const maxGap = MAX_INACTIVE_SECONDS / Math.max(seconds, 0.1)
  const usable = Math.max(0.1, 1 - maxGap)
  const weight = scene.actions.map((action) =>
    action.type === 'bullets'
      ? action.items.length
      : action.type === 'layers'
        ? action.items.length
        : 1,
  )
  const total = weight.reduce((sum, value) => sum + value, 0)
  let cursor = 0
  scene.actions.forEach((action, index) => {
    const duration = (usable * weight[index]!) / total
    action.at = cursor
    action.duration = Math.max(0.02, duration)
    cursor += duration
  })
  return scene
}

export function validateScriptedScene(scene: ScriptScene, seconds: number): string[] {
  const errors: string[] = []
  const actions = [...scene.actions].sort((a, b) => a.at - b.at)
  let activeUntil = 0
  for (const action of actions) {
    const gap = Math.max(0, action.at - activeUntil) * seconds
    if (gap > MAX_INACTIVE_SECONDS + 0.01)
      errors.push(`visual inactivity lasts ${gap.toFixed(2)}s before ${action.type}`)
    activeUntil = Math.max(activeUntil, action.at + action.duration)
    if ('width' in action && action.x + action.width > 1)
      errors.push(`${action.type} exceeds right edge`)
    if (action.type === 'bullets' && action.y + action.items.length * (action.spacing ?? 0.09) > 1)
      errors.push('bullets exceed bottom edge')
    if (action.type === 'layers' && action.y + action.items.length * (action.rowHeight ?? 0.08) > 1)
      errors.push('layers exceed bottom edge')
  }
  const boxes = actions.flatMap((action, index) => {
    const box = occupied(action)
    return box && action.type !== 'highlight' && action.type !== 'line' && action.type !== 'arrow'
      ? [{ ...box, index, type: action.type }]
      : []
  })
  for (let left = 0; left < boxes.length; left += 1) {
    for (let right = left + 1; right < boxes.length; right += 1) {
      const a = boxes[left]!,
        b = boxes[right]!
      const overlapWidth = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
      const overlapHeight = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))
      const overlap = overlapWidth * overlapHeight
      const smaller = Math.min(
        (a.right - a.left) * (a.bottom - a.top),
        (b.right - b.left) * (b.bottom - b.top),
      )
      if (smaller > 0 && overlap / smaller > 0.25)
        errors.push(`${a.type} ${a.index + 1} overlaps ${b.type} ${b.index + 1}`)
    }
  }
  const tail = Math.max(0, 1 - activeUntil) * seconds
  if (tail > MAX_INACTIVE_SECONDS + 0.01)
    errors.push(`visual inactivity lasts ${tail.toFixed(2)}s at scene end`)
  return errors
}

function occupied(
  action: ScriptScene['actions'][number],
): { left: number; top: number; right: number; bottom: number } | null {
  if (action.type === 'write' || action.type === 'title') {
    const width = Math.min(0.9, (action.text.length * (action.size ?? 42)) / 2100)
    return {
      left: action.x,
      top: action.y,
      right: action.x + width,
      bottom: action.y + (action.size ?? 42) / 500,
    }
  }
  if (action.type === 'bullets') {
    const width = Math.min(
      0.9,
      (Math.max(...action.items.map((item) => item.length)) * (action.size ?? 36)) / 2100,
    )
    return {
      left: action.x,
      top: action.y,
      right: action.x + width,
      bottom: action.y + action.items.length * (action.spacing ?? 0.09),
    }
  }
  if (action.type === 'box' || action.type === 'highlight' || action.type === 'road')
    return {
      left: action.x,
      top: action.y,
      right: action.x + action.width,
      bottom: action.y + action.height,
    }
  if (action.type === 'circle')
    return {
      left: action.x - action.radius,
      top: action.y - action.radius,
      right: action.x + action.radius,
      bottom: action.y + action.radius,
    }
  if (action.type === 'layers')
    return {
      left: action.x,
      top: action.y,
      right: action.x + action.width + 0.2,
      bottom: action.y + (action.items.length - 1) * (action.rowHeight ?? 0.08),
    }
  return null
}

export async function renderScriptedFrames(
  scene: ScriptScene,
  seconds: number,
  output: string,
): Promise<void> {
  const paced = paceScriptedScene(scene, seconds)
  const errors = validateScriptedScene(paced, seconds)
  if (errors.length) throw new Error(`invalid scripted scene: ${errors.join('; ')}`)
  const spec = `${output}.json`
  await writeFile(spec, JSON.stringify(paced))
  const engine = fileURLToPath(new URL('../python/whiteboard_engine.py', import.meta.url))
  const hand = fileURLToPath(new URL('../assets/hand-marker.png', import.meta.url))
  const python = process.env['PEERMATE_PYTHON'] ?? 'python3'
  await command(python, [
    engine,
    '--spec',
    spec,
    '--output',
    output,
    '--seconds',
    seconds.toFixed(3),
    '--fps',
    String(SCRIPTED_FPS),
    '--hand',
    hand,
  ])
  await readFile(`${output}/000000.png`)
}

function command(binary: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env['PATH'] ?? '', LANG: 'C.UTF-8' },
    })
    let error = ''
    child.stderr.on('data', (chunk) => {
      error += String(chunk)
    })
    child.once('error', reject)
    child.once('exit', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`scripted renderer exited ${code}: ${error.slice(-1000)}`)),
    )
  })
}
