import type { RightsizeLevel as Level } from '../types'
import { LEVELS, levelRank } from './cost'

// Signs, inside one turn, that the main chat is struggling at the effort it runs
// at: tool calls failing, the same call failing again, the same call going round,
// or a turn running far past the rating's step guess. Each kind can raise effort
// once a turn. Pure functions, no engine calls.

/** What the turn's tool calls have shown so far. */
export type Signals = {
  errors: number
  /** Per call (tool and arguments), how often it ran and how often it failed. */
  calls: Record<string, { n: number; errors: number }>
  /** Kinds that have already raised effort this turn. */
  fired: Kind[]
}

export type Kind = 'errors' | 'repeat-fail' | 'loop' | 'long'
export type Struggle = { kind: Kind; why: string }

/** Tool errors in a turn before it counts as struggling. */
export const ERRORS = 3
/** Runs of one identical call before it counts as going round. */
export const LOOP = 3
/** A turn this many times past the rating's step guess, and at least LONG_MIN steps, is long. */
export const LONG_X = 3
export const LONG_MIN = 15
/** Raises in one turn, and the highest level a raise goes to: max stays a person's choice. */
export const MAX_RAISES = 2
export const CEILING: Level = 'xhigh'

export const noSignals = (): Signals => ({ errors: 0, calls: {}, fired: [] })

/** The call's identity: the tool and its arguments, without the call's own id. */
export function callKey(tool: string, input: Record<string, unknown>) {
  const args: Record<string, unknown> = {}
  for (const k of Object.keys(input).sort()) if (k !== 'tool' && k !== 'tool_use_id' && k !== 'agentId' && k !== 'requestMeta') args[k] = input[k]
  return `${tool} ${JSON.stringify(args)}`
}

export function noteCall(s: Signals, key: string, isError: boolean): Signals {
  const c = s.calls[key] ?? { n: 0, errors: 0 }
  return {
    ...s,
    errors: s.errors + (isError ? 1 : 0),
    calls: { ...s.calls, [key]: { n: c.n + 1, errors: c.errors + (isError ? 1 : 0) } },
  }
}

/** The first sign that has not raised effort yet, at the step about to go out; undefined when none. */
export function struggle(s: Signals, step: number, ratedSteps: number): Struggle | undefined {
  if (s.fired.length >= MAX_RAISES) return undefined
  const calls = Object.values(s.calls)
  const found: Struggle[] = []
  if (calls.some(c => c.errors >= 2)) found.push({ kind: 'repeat-fail', why: 'the same tool call failed twice' })
  if (s.errors >= ERRORS) found.push({ kind: 'errors', why: `${s.errors} tool calls failed` })
  if (calls.some(c => c.n >= LOOP)) found.push({ kind: 'loop', why: `the same tool call ran ${LOOP} times` })
  const long = Math.max(LONG_MIN, LONG_X * Math.max(1, ratedSteps))
  if (step >= long) found.push({ kind: 'long', why: `the turn passed ${long} steps, ${LONG_X}x the estimate` })
  return found.find(f => !s.fired.includes(f.kind))
}

/** One level up, at most CEILING; undefined when already there. */
export function oneUp(level: Level): Level | undefined {
  const next = LEVELS[levelRank(level) + 1]
  return next && levelRank(next) <= levelRank(CEILING) ? next : undefined
}
