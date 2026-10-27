import type { RightsizeLevel as Level } from '../types'
import { LEVELS, levelRank } from './cost'

// Signs, inside one turn, that the main chat is struggling at the effort it runs
// at: tool calls failing, the same call failing again, the same call going round,
// or a turn running far past the rating's step guess. An error that comes from the
// environment (blockedError) is not one of them. Each kind can raise effort
// once a turn. How soon each sign counts is the Stuck sensitivity setting (LIMITS).
// Pure functions, no engine calls.

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

/** Failures of one identical call before it counts as struggling. */
export const REPEAT = 2
/** Tool errors in a turn before it counts as struggling. */
export const ERRORS = 3
/** Runs of one identical call before it counts as going round. */
export const LOOP = 3
/** A turn this many times past the rating's step guess, and at least LONG_MIN steps, is long. */
export const LONG_X = 3
export const LONG_MIN = 15

/** How soon each sign counts. */
export type Limits = { repeat: number; errors: number; loop: number; longX: number; longMin: number }
/** Stuck sensitivity: normal is the values above; relaxed waits for more, sensitive for less. */
export const LIMITS = {
  relaxed: { repeat: 3, errors: 4, loop: 4, longX: 4, longMin: 20 },
  normal: { repeat: REPEAT, errors: ERRORS, loop: LOOP, longX: LONG_X, longMin: LONG_MIN },
  sensitive: { repeat: 2, errors: 2, loop: 2, longX: 2, longMin: 10 },
} as const satisfies Record<string, Limits>
export type Sensitivity = keyof typeof LIMITS
export const isSensitivity = (v: unknown): v is Sensitivity => typeof v === 'string' && Object.hasOwn(LIMITS, v)
/** Raises in one turn, and the highest level a raise goes to: max stays a person's choice. */
export const MAX_RAISES = 2
export const CEILING: Level = 'xhigh'

/**
 * Whether a failed tool call's text shows the environment, not the work: a denied permission or
 * sandbox, no network, no login, or a program that is not installed. More effort would not fix
 * these (a Blocked stall), so they are not signs of struggling. A missing file is not here: the
 * model typed a wrong path, which is its own mistake. Only the shell's "command not found" form
 * counts as a missing program.
 */
const BLOCKED: readonly RegExp[] = [
  // Permission and sandbox.
  /operation not permitted/i,
  /\b(?:EACCES|EPERM)\b/,
  /permission denied/i,
  /sandbox\b[^\n]{0,80}\b(?:den(?:y|ied)|block(?:ed)?|restrict(?:ed)?|violation|not allowed)/i,
  /\b(?:den(?:y|ied)|block(?:ed)?|restrict(?:ed)?|violation)\b[^\n]{0,80}\bsandbox\b/i,
  // Network.
  /could not resolve host/i,
  /temporary failure in name resolution/i,
  /\b(?:ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN)\b/,
  /network is unreachable/i,
  /connection refused/i,
  // Login. A bare 401 or 403 could be a line number, so it needs an HTTP word beside it.
  /\b(?:http|status|error|code)\b\D{0,12}\b(?:401|403)\b/i,
  /\b(?:401|403)\s+(?:unauthorized|forbidden)\b/i,
  /\bnot (?:logged|signed) in\b/i,
  /\bauthentication (?:failed|failure|required|error)\b/i,
  /\bplease (?:log|sign) ?in\b/i,
  // A program that is not installed.
  /\bcommand not found\b/i,
]

export const blockedError = (text: string): boolean => {
  const t = text.slice(0, 20_000)
  return BLOCKED.some(re => re.test(t))
}

export const noSignals = (): Signals => ({ errors: 0, calls: {}, fired: [] })

/** Keys that label a call rather than make it: Claude writes a fresh `description` for the same Bash command. */
const NOT_THE_CALL = new Set(['tool', 'tool_use_id', 'agentId', 'requestMeta', 'description'])

/** The call's identity: the tool and its arguments, without its id or its label. */
export function callKey(tool: string, input: Record<string, unknown>) {
  const args: Record<string, unknown> = {}
  for (const k of Object.keys(input).sort()) if (!NOT_THE_CALL.has(k)) args[k] = input[k]
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
export function struggle(s: Signals, step: number, ratedSteps: number, limits: Limits = LIMITS.normal): Struggle | undefined {
  if (s.fired.length >= MAX_RAISES) return undefined
  const calls = Object.values(s.calls)
  const found: Struggle[] = []
  if (calls.some(c => c.errors >= limits.repeat)) found.push({ kind: 'repeat-fail', why: `the same tool call failed ${limits.repeat === 2 ? 'twice' : `${limits.repeat} times`}` })
  if (s.errors >= limits.errors) found.push({ kind: 'errors', why: `${s.errors} tool calls failed` })
  if (calls.some(c => c.n >= limits.loop)) found.push({ kind: 'loop', why: `the same tool call ran ${limits.loop} times` })
  const long = Math.max(limits.longMin, limits.longX * Math.max(1, ratedSteps))
  if (step >= long) found.push({ kind: 'long', why: `the turn passed ${long} steps, ${limits.longX}x the estimate` })
  return found.find(f => !s.fired.includes(f.kind))
}

/** One level up, at most CEILING and the Highest effort setting; undefined when already there. */
export function oneUp(level: Level, ceiling: Level = 'max'): Level | undefined {
  const top = levelRank(ceiling) < levelRank(CEILING) ? ceiling : CEILING
  const next = LEVELS[levelRank(level) + 1]
  return next && levelRank(next) <= levelRank(top) ? next : undefined
}
