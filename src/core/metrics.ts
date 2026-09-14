import { logger } from './logger.js'

/**
 * Counters, in process memory.
 *
 * Deliberately not a metrics backend. What an operator needs first is whether
 * anything is being answered at all and what it is costing — questions a restart is
 * allowed to forget. Anything that must survive a restart is already a Mongo
 * collection: `notifications` records every send and every suppression, and `outbox`
 * records what is still owed.
 */
const counters = new Map<string, number>()

/** Money, tracked separately because it is the number that surprises people. */
const spend = new Map<string, { calls: number; inputTokens: number; outputTokens: number }>()

export function count(name: string, by = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + by)
}

export function recordSpend(model: string, inputTokens: number, outputTokens: number): void {
  const seen = spend.get(model) ?? { calls: 0, inputTokens: 0, outputTokens: 0 }
  seen.calls += 1
  seen.inputTokens += inputTokens
  seen.outputTokens += outputTokens
  spend.set(model, seen)
}

export function snapshot(): Record<string, unknown> {
  return {
    counters: Object.fromEntries(counters),
    spend: Object.fromEntries(spend),
    since: startedAt.toISOString(),
  }
}

const startedAt = new Date()

/**
 * A question nobody could answer.
 *
 * Logged loudly and counted, because the most useful product signal here is the list
 * of things students asked that Peermate could not do — and it is invisible unless
 * something writes it down.
 */
export function unanswered(phone: string, question: string, why: string): void {
  count('questions.unanswered')
  logger.warn({ phone, question: question.slice(0, 200), why }, 'unanswered')
}
