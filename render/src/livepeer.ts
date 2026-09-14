/**
 * Text-to-speech on the Livepeer network.
 *
 * The endpoint and request shape are taken from the live service rather than the docs
 * page, which is out of date: it still tells you to use an `sk_` key, and the network
 * answers such a request with "Daydream `sk_` API keys are retired and can no longer
 * pay for inference on this network." `GET /capabilities` and `GET /openapi.json` on
 * the host below are the authoritative description of what it accepts.
 */
const INFERENCE = 'https://sdk.daydream.monster/inference'

/** What the network will bill. An `sk_` key is refused, whatever the documentation says. */
const BILLABLE = /^app_[^_]+_pmth_/

export function hasLivepeerKey(): boolean {
  return BILLABLE.test(process.env['LIVEPEER_API_KEY'] ?? '')
}

/**
 * Speaks one scene, and returns the audio itself rather than a link to it.
 *
 * The network answers with a URL, not bytes. Fetching it here keeps the caller's
 * contract identical to the local provider's — a Buffer it can write to disk and hand
 * to ffmpeg — so which network spoke the words changes nothing downstream.
 */
export async function speak(text: string, capability = 'chatterbox-tts'): Promise<Buffer> {
  const key = process.env['LIVEPEER_API_KEY'] ?? ''
  if (!BILLABLE.test(key)) {
    throw new Error(
      'LIVEPEER_API_KEY is not a key this network can bill. It wants app_<appId>_pmth_<token>; `sk_` keys are retired.',
    )
  }

  const response = await fetch(INFERENCE, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ capability, input: { text } }),
  })

  // The body carries the reason and the plain status does not — a retired key and an
  // unknown capability are both 401/422 with nothing useful in the status line.
  if (!response.ok) {
    throw new Error(`livepeer ${capability} failed: ${response.status} ${await response.text()}`)
  }

  const payload = (await response.json()) as Record<string, unknown>
  const url = findAudioUrl(payload)
  if (!url) throw new Error(`livepeer ${capability} returned no audio url: ${JSON.stringify(payload).slice(0, 300)}`)

  const audio = await fetch(url)
  if (!audio.ok) throw new Error(`could not fetch generated audio: ${audio.status}`)
  return Buffer.from(await audio.arrayBuffer())
}

/**
 * Finds the audio URL wherever this capability happens to put it.
 *
 * 207 capabilities share one envelope and they do not agree on its shape — some answer
 * `{data:{audio:{url}}}`, others nest differently. Searching for the first audio-ish
 * URL is uglier than a typed path and survives a model being swapped for another.
 */
function findAudioUrl(value: unknown): string | null {
  if (typeof value === 'string') {
    return /^https?:\/\//.test(value) && /\.(mp3|wav|ogg|m4a|flac)(\?|$)/i.test(value) ? value : null
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
