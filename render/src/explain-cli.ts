import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, resolve } from 'node:path'
import { render } from './index.js'
import { provider } from './narrate.js'
import { planFromPdf } from './plan.js'
import { whiteboardFrame } from './whiteboard.js'

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

if (!namedFile || !topic) {
  console.error(
    'usage: npm run explain -- --file <file-in-zfiles.pdf> --topic "..." [--out video.mp4] [--plan plan.json] [--plan-only]',
  )
  process.exit(1)
}

await mkdir(dirname(planPath), { recursive: true })
const storyboard = await planFromPdf(input!, topic)
await writeFile(planPath, JSON.stringify(storyboard, null, 2))
console.log(`plan: ${planPath} (${storyboard.scenes.length} scenes)`)

const previewDir = resolve(dirname(planPath), `${basename(planPath, '.plan.json')}.preview`)
await mkdir(previewDir, { recursive: true })
const completedActions: import('./storyboard.js').WhiteboardAction[] = []
for (const [index, scene] of storyboard.scenes.entries()) {
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
console.log(`preview: ${previewDir}`)

if (!planOnly) {
  console.log(`narration: ${provider()}`)
  const result = await render(storyboard, output, (progress) =>
    console.log(JSON.stringify({ progress })),
  )
  console.log(`video: ${result.path}  ${(result.bytes / 1e6).toFixed(1)}MB  ${result.durationSec}s`)
  console.log(`hosted: ${result.playbackUrl}`)
}
