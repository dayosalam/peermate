import { writeFile } from 'node:fs/promises'
import OpenAI from 'openai'
import { run } from './ffmpeg.js'
import { speak } from './livepeer.js'

let client: OpenAI | null = null
function openai(): OpenAI {
  client ??= new OpenAI({ apiKey: process.env['OPENAI_API_KEY'] })
  return client
}

/** Which network spoke the words. Reported, never guessed at from the output. */
export type Voice = 'livepeer' | 'openai'

/**
 * Keyless is a working caller, so "has a key" no longer distinguishes anything. The
 * network is the default because running on it is the point; `LIVEPEER_TTS=0` is for
 * working offline, not for degrading quietly.
 */
export function provider(): Voice {
  return process.env['LIVEPEER_TTS'] === '0' ? 'openai' : 'livepeer'
}

/**
 * One scene's narration as an audio file, with the length it turned out to be.
 *
 * The duration is measured rather than estimated. A words-per-minute guess drifts a
 * second or two per scene, which by scene twelve has the slide changing in the middle
 * of the sentence that explains it.
 *
 * Livepeer speaks it when there is a key that the network will actually bill, and the
 * local provider otherwise. The choice is printed rather than silent: a demo that
 * believes it is running on Livepeer while quietly using something else is worse than
 * one that fails.
 */
export async function narrate(text: string, path: string): Promise<number> {
  const audio =
    provider() === 'livepeer'
      ? await speak(text)
      : Buffer.from(
          await (
            await openai().audio.speech.create({
              model: 'gpt-4o-mini-tts',
              voice: 'alloy',
              input: text,
              response_format: 'mp3',
            })
          ).arrayBuffer(),
        )

  await writeFile(path, audio)
  return durationOf(path)
}

export async function durationOf(path: string): Promise<number> {
  const out = await run('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    path,
  ])
  return Number.parseFloat(out.trim())
}
