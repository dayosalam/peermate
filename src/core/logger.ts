import pino from 'pino'
import { config } from '../config.js'

export const logger = pino({
  level: config.logLevel,
  ...(config.isProduction
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        },
      }),
})

export type Logger = typeof logger

/**
 * Keep development traces useful without letting a pasted document or retrieval
 * result flood the terminal. Production never receives student content through
 * this helper.
 */
export function devPreview(value: unknown, limit = 2000): string | undefined {
  if (config.isProduction || value === undefined || value === null) return undefined
  const rendered = typeof value === 'string' ? value : JSON.stringify(value)
  if (!rendered) return undefined
  return rendered.length <= limit ? rendered : `${rendered.slice(0, limit)}… [truncated]`
}
