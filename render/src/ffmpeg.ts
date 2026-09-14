import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/**
 * ffmpeg writes its progress to stderr and exits 0, so stderr is not an error signal
 * here — only a non-zero exit is. `maxBuffer` is raised because a long render's
 * progress output alone will exceed the default and kill the process.
 */
export async function run(bin: string, args: string[]): Promise<string> {
  const { stdout } = await exec(bin, args, { maxBuffer: 32 * 1024 * 1024 })
  return stdout
}
