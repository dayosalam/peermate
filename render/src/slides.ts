import { readFile } from 'node:fs/promises'
import { createCanvas, GlobalFonts, loadImage, type Image } from '@napi-rs/canvas'
import { renderPageAsImage } from 'unpdf'
import type { Cue } from './captions.js'
import type { Visual } from './storyboard.js'

/** 720p. Slides are static, so the file stays small even at this size. */
export const WIDTH = 1280
export const HEIGHT = 720

/** Where the source line sits, and where the caption band sits above it. */
const SOURCE_BAR = 44
const CAPTION_BAND = 132

const BACKGROUND = '#0f1720'
const INK = '#f5f7fa'
const MUTED = '#8fa3b8'
const PAPER = '#ffffff'

/** White space kept around the content, as a fraction of the cropped size. */
const MARGIN = 0.04

/** Darker than this counts as ink. Paper, including a grey scan, sits above it. */
const INK_BELOW = 200

/**
 * A scene's visual, decoded once.
 *
 * Rasterising a PDF page takes a moment and a scene has several captions over it, so
 * the expensive half is done once and each caption is composited onto a copy.
 */
export interface Prepared {
  image: Image | null
  title: string | null
}

export async function prepare(visual: Visual): Promise<Prepared> {
  if (visual.kind === 'title') return { image: null, title: visual.text }

  const bytes = new Uint8Array(await readFile(visual.pdfPath))
  // Rendered larger than it is shown, then scaled down: a page rasterised at exactly
  // the display size has visibly soft text once ffmpeg has finished with it.
  const png = await renderPageAsImage(bytes, visual.page, {
    scale: 2,
    // pdf.js has no canvas in Node, so one has to be handed to it. This is the whole
    // reason @napi-rs/canvas is a dependency here and not in the bot.
    canvasImport: () => import('@napi-rs/canvas'),
  })

  const page = await loadImage(Buffer.from(png))
  const ink = inkBounds(page)

  // Cropped now rather than at every composite: the crop is the same for every caption
  // over this scene, and cropping once keeps the per-caption step to a plain drawImage.
  const cropped = createCanvas(ink.width, ink.height)
  const ctx = cropped.getContext('2d')
  // Insurance, not decoration: a page whose own background is transparent would
  // otherwise be black text drawn straight onto a dark canvas — present, correct
  // and completely invisible. Most render opaque and paint over this harmlessly.
  ctx.fillStyle = PAPER
  ctx.fillRect(0, 0, ink.width, ink.height)
  ctx.drawImage(page, ink.x, ink.y, ink.width, ink.height, 0, 0, ink.width, ink.height)

  return { image: await loadImage(cropped.toBuffer('image/png')), title: null }
}

/** One frame: the visual, the source it came from, and the line being spoken over it. */
export function frame(prepared: Prepared, source: string | null, cue: Cue | null): Buffer {
  const canvas = createCanvas(WIDTH, HEIGHT)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = BACKGROUND
  ctx.fillRect(0, 0, WIDTH, HEIGHT)

  const available = HEIGHT - SOURCE_BAR - (cue ? CAPTION_BAND : 0)

  if (prepared.image) {
    const { image } = prepared
    const scale = Math.min(WIDTH / image.width, available / image.height)
    const width = image.width * scale
    const height = image.height * scale
    ctx.drawImage(image, (WIDTH - width) / 2, (available - height) / 2, width, height)
  } else if (prepared.title) {
    ctx.fillStyle = INK
    ctx.font = 'bold 52px sans-serif'
    ctx.textAlign = 'center'
    const lines = wrapTitle(prepared.title, 26)
    for (const [index, line] of lines.entries()) {
      ctx.fillText(line, WIDTH / 2, available / 2 - (lines.length - 1) * 32 + index * 64)
    }
  }

  if (cue) {
    ctx.fillStyle = INK
    ctx.font = '34px sans-serif'
    ctx.textAlign = 'center'
    for (const [index, line] of cue.lines.entries()) {
      ctx.fillText(line, WIDTH / 2, available + 46 + index * 44)
    }
  }

  if (source) {
    ctx.fillStyle = MUTED
    ctx.font = '22px sans-serif'
    ctx.textAlign = 'left'
    ctx.fillText(source, 32, HEIGHT - 16)
  }

  return canvas.toBuffer('image/png')
}

/**
 * The part of the page that actually has something on it.
 *
 * Lecture notes are A4 with the content in the top third; fitted whole into a 16:9
 * frame that is mostly blank paper and text too small to read on a phone. Cropping to
 * the content lets the same text fill the frame.
 *
 * Measured on luminance rather than alpha. pdf.js renders an opaque white page — every
 * pixel comes back at alpha 255 — so transparency says nothing about where the ink is.
 * The threshold is generous because a scan's paper is grey rather than white, and
 * cropping a scanned notice to nothing is worse than cropping it too little.
 */
function inkBounds(image: Image): Box {
  const probe = createCanvas(image.width, image.height)
  const ctx = probe.getContext('2d')
  ctx.drawImage(image, 0, 0)
  const { data } = ctx.getImageData(0, 0, image.width, image.height)

  let top = image.height
  let left = image.width
  let right = 0
  let bottom = 0

  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const at = (y * image.width + x) * 4
      const lit = (data[at]! + data[at + 1]! + data[at + 2]!) / 3
      if (lit > INK_BELOW) continue
      if (y < top) top = y
      if (y > bottom) bottom = y
      if (x < left) left = x
      if (x > right) right = x
    }
  }

  // A page with nothing on it at all: show it whole rather than dividing by zero.
  if (right <= left || bottom <= top) {
    return { x: 0, y: 0, width: image.width, height: image.height }
  }

  const margin = Math.round(Math.max(right - left, bottom - top) * MARGIN)
  const x = Math.max(0, left - margin)
  const y = Math.max(0, top - margin)
  return {
    x,
    y,
    width: Math.min(image.width - x, right - left + margin * 2),
    height: Math.min(image.height - y, bottom - top + margin * 2),
  }
}

interface Box {
  x: number
  y: number
  width: number
  height: number
}

function wrapTitle(text: string, perLine: number): string[] {
  const lines: string[] = []
  let current = ''
  for (const word of text.split(/\s+/)) {
    if (current && (current + word).length > perLine) {
      lines.push(current.trim())
      current = ''
    }
    current += `${word} `
  }
  if (current.trim()) lines.push(current.trim())
  return lines
}

export { GlobalFonts }
