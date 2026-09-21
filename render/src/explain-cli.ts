import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, resolve } from 'node:path'
import { render } from './index.js'
import { provider } from './narrate.js'
import { planFromPdf } from './plan.js'
import { loadWhiteboardAssets, whiteboardFrame } from './whiteboard.js'
import { gifPreview } from './assemble.js'
import { renderScriptedFrames, SCRIPTED_FPS } from './scripted.js'

const args = process.argv.slice(2)
const value = (name: string): string | null => {
  const at = args.indexOf(name)
  return at >= 0 ? (args[at + 1] ?? null) : null
}

const root = process.env['INIT_CWD'] ?? process.cwd()
const zfiles = resolve(root, 'zfiles')
const absolute = (path: string): string => (isAbsolute(path) ? path : resolve(root, path))
const namedFile = value('--file')
const topic = value('--topic')
const input = namedFile
  ? isAbsolute(namedFile)
    ? namedFile
    : dirname(namedFile) === '.'
      ? resolve(zfiles, namedFile)
      : resolve(root, namedFile)
  : null
const output = value('--out')
  ? absolute(value('--out')!)
  : input
    ? resolve(dirname(input), `${basename(input, extname(input))}.mp4`)
    : resolve(zfiles, 'whiteboard-explainer.mp4')
const planPath = absolute(value('--plan') ?? output.replace(/\.mp4$/i, '.plan.json'))
const planOnly = args.includes('--plan-only')
const pages = parsePages(value('--pages'))
const mode = value('--mode') ?? 'structured'
if (mode !== 'structured' && mode !== 'scripted')
  throw new Error('--mode must be structured or scripted')

if (!namedFile || !topic) {
  console.error(
    'usage: npm run explain -- --file <file-in-zfiles.pdf> --topic "..." [--mode structured|scripted] [--pages 13-15] [--out video.mp4] [--plan out.json] [--plan-only]',
  )
  process.exit(1)
}

await mkdir(dirname(planPath), { recursive: true })
const storyboard = await planFromPdf(input!, topic, pages, mode)
await writeFile(planPath, JSON.stringify(storyboard, null, 2))
console.log(`plan: ${planPath} (${storyboard.scenes.length} scenes)`)

const previewDir = resolve(dirname(planPath), `${basename(planPath, '.plan.json')}.preview`)
await mkdir(previewDir, { recursive: true })
await loadWhiteboardAssets()
const completedActions: import('./storyboard.js').WhiteboardAction[] = []
for (const [index, scene] of storyboard.scenes.entries()) {
  if (scene.visual.kind === 'scripted') {
    const frames = resolve(previewDir, `scene-${index + 1}-frames`)
    await mkdir(frames, { recursive: true })
    await renderScriptedFrames({ actions: scene.visual.actions, source: scene.source }, 8, frames)
    await gifPreview(
      resolve(frames, '%06d.png'),
      SCRIPTED_FPS,
      resolve(previewDir, `scene-${index + 1}.gif`),
    )
    continue
  }
  if (scene.visual.kind !== 'whiteboard') continue
  for (const [name, progress] of [
    ['early', 0.3],
    ['middle', 0.65],
    ['final', 1],
  ] as const) {
    await writeFile(
      resolve(previewDir, `scene-${index + 1}-${name}.png`),
      whiteboardFrame(
        scene.visual.actions,
        progress,
        storyboard.title,
        scene.source,
        [],
        scene.visual.carry ? completedActions : [],
      ),
    )
  }
  if (scene.visual.carry) completedActions.push(...scene.visual.actions)
  else completedActions.splice(0, completedActions.length, ...scene.visual.actions)
}

function parsePages(raw: string | null): number[] | undefined {
  if (!raw) return undefined
  const pages = new Set<number>()
  for (const part of raw.split(',')) {
    const match = part.trim().match(/^(\d+)(?:-(\d+))?$/)
    if (!match) throw new Error(`invalid --pages value: ${raw}`)
    const start = Number(match[1])
    const end = Number(match[2] ?? match[1])
    if (start < 1 || end < start) throw new Error(`invalid --pages value: ${raw}`)
    for (let page = start; page <= end; page += 1) pages.add(page)
  }
  return [...pages].sort((a, b) => a - b)
}
console.log(`preview: ${previewDir}`)

if (!planOnly) {
  console.log(`narration: ${provider()}`)
  const result = await render(storyboard, output, (progress) =>
    console.log(JSON.stringify({ progress })),
  )
  console.log(`video: ${result.path}  ${(result.bytes / 1e6).toFixed(1)}MB  ${result.durationSec}s`)
  console.log(`hosted: ${result.playbackUrl}`)
}
