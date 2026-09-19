import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'

/**
 * The Livepeer network, over the agent MCP rather than the inference host — that is the
 * surface that still bills, and an unauthenticated caller gets demo credits here rather
 * than a refusal. Plain JSON-RPC, no MCP client library, which is what lets a
 * subprocess call it at all.
 *
 * Capability parameters are undocumented, and an unrecognised one is dropped silently
 * rather than refused: the call succeeds having quietly used a default. Measure the
 * output before believing a parameter landed. Names are snake_case with their unit —
 * `duration_sec`, not `duration`.
 */
const AGENT = 'https://agent.livepeer.org/api/mcp'

/** A scene clip is a megabyte or two; anything past this is a stall, not a slow link. */
const UPLOAD_TIMEOUT_MS = 120_000

/**
 * Keyless is demo credits: every model available, spend limited. That balance is shared
 * with every other keyless caller and can empty without this project spending anything,
 * so get a key from https://app.daydream.live before a demo.
 */
function authorization(): Record<string, string> {
  const key = process.env['LIVEPEER_API_KEY'] ?? ''
  // A retired `sk_` key is worse than no key at all: keyless is a working caller on
  // demo credits, and sending one of these turns that into a 401. Only a key the
  // network can actually bill is worth presenting.
  return BILLABLE.test(key) ? { authorization: `Bearer ${key}` } : {}
}

/** What the network will bill. `sk_` keys are retired, whatever the documentation says. */
const BILLABLE = /^app_[^_]+_pmth_/

export interface ToolResult {
  url?: string
  cost_usd_estimated?: number
  budget_headroom_usd?: number
  [field: string]: unknown
}

/** Calls one MCP tool and unwraps its result, or throws with the reason it refused. */
export async function callTool(
  name: string,
  args: Record<string, unknown>,
  timeoutMs = 180_000,
): Promise<ToolResult> {
  const response = await fetch(AGENT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
      ...authorization(),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  })

  if (!response.ok) {
    throw new Error(`livepeer ${name} failed: ${response.status} ${await response.text()}`)
  }

  const payload = (await response.json()) as {
    error?: { message?: string }
    result?: { isError?: boolean; structuredContent?: ToolResult; content?: unknown }
  }

  // A capability that refuses answers 200 with the reason in the body. The transport
  // succeeded; the work did not, and only one of those shows in the status line.
  if (payload.error) throw new Error(`livepeer ${name} refused: ${payload.error.message}`)
  if (payload.result?.isError) {
    throw new Error(`livepeer ${name} refused: ${text(payload.result.content).slice(0, 300)}`)
  }
  return payload.result?.structuredContent ?? {}
}

/** Dispatches one capability — a model or a deterministic tool — and returns its output. */
export async function runCapability(
  capability: string,
  args: Record<string, unknown> = {},
  timeoutMs?: number,
): Promise<ToolResult> {
  return callTool('run_capability', { capability, async: false, ...args }, timeoutMs)
}

/**
 * Puts a local file where the network can fetch it.
 *
 * Always the signed PUT: the base64 `data` field caps around 3MB and a larger payload
 * arrives truncated rather than rejected. `contentType` is explicit because the `kind`
 * shortcut labels a WAV as audio/mpeg, and the tool downstream believes the label.
 */
export async function uploadFile(path: string, contentType: string): Promise<string> {
  const bytes = await readFile(path)
  const ticket = await callTool('create_upload_url', {
    content_type: contentType,
    filename: basename(path),
    size: bytes.byteLength,
  })

  const uploadUrl = ticket['upload_url']
  const publicUrl = ticket['public_url']
  if (typeof uploadUrl !== 'string' || typeof publicUrl !== 'string') {
    throw new Error(`create_upload_url returned no ticket: ${JSON.stringify(ticket).slice(0, 200)}`)
  }

  // Without a deadline this is the one place a render can hang for ever, leaving a
  // student watching a progress message that has stopped moving.
  const put = await fetch(uploadUrl, {
    method: 'PUT',
    headers: (ticket['headers'] ?? {}) as Record<string, string>,
    body: new Uint8Array(bytes),
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  })
  if (!put.ok) throw new Error(`upload failed: ${put.status} ${await put.text()}`)
  return publicUrl
}

/**
 * `inworld-tts` measured 7.2s for 19.9s of audio against `chatterbox-tts` at 18.4s for
 * 17.9s — roughly realtime — and is 2.5x cheaper. Overridable because the deciding axis
 * is how it sounds in code-switched Yoruba, which is judged by ear.
 */
const VOICE = process.env['LIVEPEER_TTS_CAPABILITY'] ?? 'inworld-tts'

/**
 * Speaks one scene. The network answers with a URL; fetching it here keeps the contract
 * identical to the local provider's, so which network spoke changes nothing downstream.
 */
export async function speak(text: string, capability = VOICE): Promise<Buffer> {
  const result = await runCapability(capability, { prompt: text })
  const url = result.url ?? findAudioUrl(result)
  if (!url) {
    throw new Error(
      `livepeer ${capability} returned no audio url: ${JSON.stringify(result).slice(0, 300)}`,
    )
  }

  // A 302 to the storage host. `fetch` follows it; curl does not without `-L`, which
  // is why a hand-check of this URL looks like an empty file.
  const audio = await fetch(url)
  if (!audio.ok) throw new Error(`could not fetch generated audio: ${audio.status}`)
  return Buffer.from(await audio.arrayBuffer())
}

function text(content: unknown): string {
  if (!Array.isArray(content)) return JSON.stringify(content ?? '')
  return content
    .map((part) => (part && typeof part === 'object' && 'text' in part ? String(part.text) : ''))
    .join(' ')
}

/**
 * The fallback when `url` is absent: 200-odd capabilities share one envelope and do not
 * agree on its shape, so a search survives a model swap where a typed path does not.
 */
function findAudioUrl(value: unknown): string | null {
  if (typeof value === 'string') {
    return /^https?:\/\//.test(value) && /\.(mp3|wav|ogg|m4a|flac)(\?|$)/i.test(value)
      ? value
      : null
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findAudioUrl(item)
      if (found) return found
    }
    return null
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) {
      const found = findAudioUrl(item)
      if (found) return found
    }
  }
  return null
}
