import { createCanvas, loadImage, type Image } from '@napi-rs/canvas'
import { fileURLToPath } from 'node:url'
import type { Cue } from './captions.js'
import type { WhiteboardAction } from './storyboard.js'

export const WHITEBOARD_FPS = 15
export const WHITEBOARD_WIDTH = 1280
export const WHITEBOARD_HEIGHT = 720

const BOARD_BOTTOM = 570
const PAD = 54
let hand: Image | null = null

/** Loads the optional hand once; frames remain deterministic if the asset is unavailable. */
export async function loadWhiteboardAssets(): Promise<void> {
  if (hand) return
  hand = await loadImage(fileURLToPath(new URL('../assets/hand-marker.png', import.meta.url)))
}

/** Draws one moment of a progressive, phone-readable whiteboard explanation. */
export function whiteboardFrame(
  actions: WhiteboardAction[],
  progress: number,
  title: string,
  source: string | null,
  captions: Cue[],
  completedActions: WhiteboardAction[] = [],
): Buffer {
  const canvas = createCanvas(WHITEBOARD_WIDTH, WHITEBOARD_HEIGHT)
  const ctx = canvas.getContext('2d')

  ctx.fillStyle = '#fbfaf6'
  ctx.fillRect(0, 0, WHITEBOARD_WIDTH, WHITEBOARD_HEIGHT)
  ctx.fillStyle = '#e8e5dc'
  for (let y = 30; y < BOARD_BOTTOM; y += 36) {
    for (let x = 30; x < WHITEBOARD_WIDTH; x += 36) ctx.fillRect(x, y, 2, 2)
  }

  ctx.fillStyle = '#172033'
  ctx.font = 'bold 26px sans-serif'
  ctx.textAlign = 'left'
  ctx.fillText(title, PAD, 42)

  for (const action of completedActions) draw(ctx, action, 1)
  for (const action of actions) draw(ctx, action, localProgress(action, progress))
  const active = actions.findLast((action) => {
    const raw = rawProgress(action, progress)
    return raw > 0 && raw < 1
  })
  if (active && hand) drawHand(ctx, active, localProgress(active, progress))

  const cue = cueAt(captions, progress)
  ctx.fillStyle = '#172033'
  ctx.fillRect(0, BOARD_BOTTOM, WHITEBOARD_WIDTH, WHITEBOARD_HEIGHT - BOARD_BOTTOM)
  if (cue) {
    ctx.fillStyle = '#ffffff'
    ctx.font = '32px sans-serif'
    ctx.textAlign = 'center'
    cue.lines.forEach((line, index) => ctx.fillText(line, WHITEBOARD_WIDTH / 2, 620 + index * 42))
  }
  if (source) {
    ctx.fillStyle = '#9ca3af'
    ctx.font = '18px sans-serif'
    ctx.textAlign = 'left'
    ctx.fillText(source, PAD, WHITEBOARD_HEIGHT - 18)
  }

  return canvas.toBuffer('image/png')
}

type Context = ReturnType<ReturnType<typeof createCanvas>['getContext']>

function draw(ctx: Context, action: WhiteboardAction, progress: number): void {
  if (progress <= 0) return
  const x = (value: number): number => PAD + value * (WHITEBOARD_WIDTH - PAD * 2)
  const y = (value: number): number => 72 + value * (BOARD_BOTTOM - 100)
  const width = (value: number): number => value * (WHITEBOARD_WIDTH - PAD * 2)
  const height = (value: number): number => value * (BOARD_BOTTOM - 100)

  ctx.lineWidth = 5
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  if (action.type === 'erase') {
    ctx.fillStyle = '#fbfaf6'
    ctx.fillRect(x(action.x), y(action.y), width(action.width), height(action.height))
    return
  }

  if (action.type === 'highlight') {
    ctx.save()
    ctx.globalAlpha = 0.38 * progress
    ctx.fillStyle = action.color
    ctx.fillRect(x(action.x), y(action.y), width(action.width) * progress, height(action.height))
    ctx.restore()
    return
  }

  ctx.strokeStyle = action.color
  ctx.fillStyle = action.color

  if (action.type === 'write') {
    ctx.font = `${action.size}px sans-serif`
    ctx.textAlign = 'left'
    ctx.fillText(
      action.text.slice(0, Math.ceil(action.text.length * progress)),
      x(action.x),
      y(action.y),
    )
    return
  }

  if (action.type === 'box') {
    const w = width(action.width) * progress
    const h = height(action.height) * progress
    ctx.strokeRect(x(action.x), y(action.y), w, h)
    if (action.label && progress >= 0.75)
      label(ctx, action.label, x(action.x) + w / 2, y(action.y) + h / 2)
    return
  }

  if (action.type === 'circle') {
    ctx.beginPath()
    ctx.arc(
      x(action.x),
      y(action.y),
      width(action.radius),
      -Math.PI / 2,
      -Math.PI / 2 + Math.PI * 2 * progress,
    )
    ctx.stroke()
    if (action.label && progress >= 0.75) label(ctx, action.label, x(action.x), y(action.y))
    return
  }

  const startX = x(action.fromX)
  const startY = y(action.fromY)
  const endX = startX + (x(action.toX) - startX) * progress
  const endY = startY + (y(action.toY) - startY) * progress
  ctx.beginPath()
  ctx.moveTo(startX, startY)
  ctx.lineTo(endX, endY)
  ctx.stroke()

  if (action.type === 'arrow' && progress > 0.85) {
    const angle = Math.atan2(endY - startY, endX - startX)
    ctx.beginPath()
    ctx.moveTo(endX, endY)
    ctx.lineTo(endX - 18 * Math.cos(angle - Math.PI / 6), endY - 18 * Math.sin(angle - Math.PI / 6))
    ctx.moveTo(endX, endY)
    ctx.lineTo(endX - 18 * Math.cos(angle + Math.PI / 6), endY - 18 * Math.sin(angle + Math.PI / 6))
    ctx.stroke()
    if (action.label) label(ctx, action.label, (startX + endX) / 2, (startY + endY) / 2 - 18)
  }
}

function label(ctx: Context, text: string, x: number, y: number): void {
  ctx.save()
  ctx.fillStyle = '#172033'
  ctx.font = 'bold 28px sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, x, y)
  ctx.restore()
}

function localProgress(action: WhiteboardAction, sceneProgress: number): number {
  const progress = rawProgress(action, sceneProgress)
  // Smooth acceleration and deceleration keeps the marker from starting and stopping mechanically.
  return progress * progress * (3 - 2 * progress)
}

function rawProgress(action: WhiteboardAction, sceneProgress: number): number {
  return Math.max(0, Math.min(1, (sceneProgress - action.at) / action.duration))
}

function drawHand(ctx: Context, action: WhiteboardAction, progress: number): void {
  if (!hand || action.type === 'erase') return
  const point = penPoint(ctx, action, progress)
  if (!point) return
  const width = 315
  const height = (width * hand.height) / hand.width
  // The generated asset's marker tip is at roughly 18% of its width and height.
  ctx.drawImage(hand, point.x - width * 0.18, point.y - height * 0.18, width, height)
}

function penPoint(
  ctx: Context,
  action: WhiteboardAction,
  progress: number,
): { x: number; y: number } | null {
  const x = (value: number): number => PAD + value * (WHITEBOARD_WIDTH - PAD * 2)
  const y = (value: number): number => 72 + value * (BOARD_BOTTOM - 100)
  const width = (value: number): number => value * (WHITEBOARD_WIDTH - PAD * 2)
  const height = (value: number): number => value * (BOARD_BOTTOM - 100)

  if (action.type === 'write') {
    ctx.font = `${action.size}px sans-serif`
    const shown = action.text.slice(0, Math.ceil(action.text.length * progress))
    return { x: x(action.x) + ctx.measureText(shown).width, y: y(action.y) }
  }
  if (action.type === 'circle') {
    const angle = -Math.PI / 2 + Math.PI * 2 * progress
    const radius = width(action.radius)
    return { x: x(action.x) + Math.cos(angle) * radius, y: y(action.y) + Math.sin(angle) * radius }
  }
  if (action.type === 'line' || action.type === 'arrow') {
    return {
      x: x(action.fromX) + (x(action.toX) - x(action.fromX)) * progress,
      y: y(action.fromY) + (y(action.toY) - y(action.fromY)) * progress,
    }
  }
  if (action.type === 'box' || action.type === 'highlight') {
    return {
      x: x(action.x) + width(action.width) * progress,
      y: y(action.y) + height(action.height) * progress,
    }
  }
  return null
}

function cueAt(captions: Cue[], progress: number): Cue | null {
  const total = captions.reduce((sum, cue) => sum + cue.seconds, 0)
  let cursor = progress * total
  for (const cue of captions) {
    cursor -= cue.seconds
    if (cursor <= 0) return cue
  }
  return captions.at(-1) ?? null
}
