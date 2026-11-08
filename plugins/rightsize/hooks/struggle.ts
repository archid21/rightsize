import type { RightsizeLevel as Level } from '../types'
import { LEVELS, levelRank } from './cost'

// Signs, inside one turn, that the main chat is struggling at the effort it runs
// at: tool calls failing, the same call failing again, the same call going round,
// a turn running far past the rating's step guess with nothing to show for the
// last calls, or a failing test run the turn leaves behind. A long turn that keeps
// editing files, passes its tests or reads new things is just working through a
// big plan, so it is not one. An error that comes from the environment
// (blockedError) is not a sign either, and a failing test run is often an expected
// red (isTestCommand), so it counts less, until the turn goes on without running
// it again. Each kind can raise effort once a turn. How soon each sign counts is
// the Stuck sensitivity setting (LIMITS). Pure functions, no engine calls.

/** What the turn's tool calls have shown so far. */
export type Signals = {
  errors: number
  /** Per call (tool and arguments), how often it ran and how often it failed; `test` marks a test-runner command. */
  calls: Record<string, { n: number; errors: number; test?: true }>
  /** Kinds that have already raised effort this turn. */
  fired: Kind[]
  /** How the last test run in the turn ended: the objective outcome of the work, where there was one. */
  lastTest?: 'passed' | 'failed'
  /** Calls since the last failing test run that were not a test run themselves; absent when the last run passed or none ran. */
  afterFail?: number
  /**
   * The last few calls, oldest first, bounded at RECENT_MAX. `novel`: the call had not run earlier in the
   * turn. `progress`: a file edit or write that worked, or a test run that passed. Absent in an old shape.
   */
  recent?: { novel: boolean; progress: boolean }[]
}

/** What the turn's test runs say about the work: how the last one ended, or nothing when none ran. */
export const testsOutcome = (s: Signals) => s.lastTest

export type Kind = 'errors' | 'repeat-fail' | 'loop' | 'long' | 'failed-check'
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
/** A long turn is stuck only when the last WINDOW calls hold no progress and under NOVEL of them are new calls. */
export const WINDOW = 10
export const NOVEL = 0.5
/** Calls after a failing test run, with no run since, before the turn counts as leaving the failure behind. */
export const AFTER_FAIL = 4

/** How soon each sign counts. */
export type Limits = { repeat: number; errors: number; loop: number; longX: number; longMin: number; window: number; novel: number; afterFail: number }
/** Stuck sensitivity: normal is the values above; relaxed waits for more, sensitive for less. */
export const LIMITS = {
  relaxed: { repeat: 3, errors: 4, loop: 4, longX: 4, longMin: 20, window: 12, novel: 0.4, afterFail: 6 },
  normal: { repeat: REPEAT, errors: ERRORS, loop: LOOP, longX: LONG_X, longMin: LONG_MIN, window: WINDOW, novel: NOVEL, afterFail: AFTER_FAIL },
  sensitive: { repeat: 2, errors: 2, loop: 2, longX: 2, longMin: 10, window: 8, novel: 0.6, afterFail: 3 },
} as const satisfies Record<string, Limits>
/** How many recent calls the signals keep: enough for the widest window. */
export const RECENT_MAX = Math.max(...Object.values(LIMITS).map(l => l.window))
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

/**
 * Whether a failed tool call's text is the person saying no at the permission prompt. Core reports that
 * as an error result, not a deny, so it would otherwise count as the work failing. Saying no is the
 * person steering, not Claude struggling: it neither raises effort nor steps a lowered turn back up.
 */
const REFUSED = /^(?:The user doesn't want to proceed with this tool use\b|User rejected tool use\b)/

export const refusedByPerson = (text: string): boolean => REFUSED.test(text.trimStart())

export const noSignals = (): Signals => ({ errors: 0, calls: {}, fired: [] })

/** Keys that label a call rather than make it: Claude writes a fresh `description` for the same Bash command. */
const NOT_THE_CALL = new Set(['tool', 'tool_use_id', 'agentId', 'requestMeta', 'description'])

/** The call's identity: the tool and its arguments, without its id or its label. */
export function callKey(tool: string, input: Record<string, unknown>) {
  const args: Record<string, unknown> = {}
  for (const k of Object.keys(input).sort()) if (!NOT_THE_CALL.has(k)) args[k] = input[k]
  return `${tool} ${JSON.stringify(args)}`
}

/**
 * Whether a tool call runs a test suite. A failing test run is often an expected red (a test written
 * before the code, a fix half done), so it is not an error of the work: it adds nothing to `errors`
 * and needs one more repeat before it counts. A runner counts only where a command starts (after
 * `&&`, `;`, `|`, or a `cd`), so a word like "npm test" inside an argument is not one.
 */
const TEST_RUNNER =
  /(?:^|[;&|(\n])\s*(?:\w+=\S*\s+)*(?:(?:time|npx|bunx|uv run|poetry run|pnpm exec|pnpm dlx)\s+)?(?:npm (?:run )?test|pnpm (?:run )?test|yarn (?:run )?test|bun (?:run )?test|deno test|vitest|jest|mocha|playwright test|cypress run|(?:\S*\/)?pytest|python3? -m (?:pytest|unittest|nose2?|tox|django test)|python3? (?:\S*\/)?(?:runtests\.py|manage\.py test)|(?:\S*\/)?(?:manage\.py|django-admin) test|tox|nox|nose2|go test|cargo test|claude plugin test|mvn test|(?:\S*\/)?mvnw test|gradle test|(?:\S*\/)?gradlew test|sbt test|bazel test|dotnet test|swift test|mix test|flutter test|ctest|(?:bundle exec )?rspec|(?:bundle exec )?rake test|(?:\S*\/)?rails test|(?:\S*\/)?phpunit|(?:\S*\/)?pest|bats|make (?:test|check))(?![\w-])/
export function isTestCommand(tool: string, input: Record<string, unknown>): boolean {
  return tool === 'Bash' && typeof input.command === 'string' && TEST_RUNNER.test(input.command)
}

/** Tools that change a file: a call to one that works is progress. */
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
export const isEditTool = (tool: string): boolean => EDIT_TOOLS.has(tool)

/**
 * A test run that fails does not add to `errors`, but its repeats are still counted, one more allowed.
 * `edit` marks a file edit or write. The call joins the recent window: new or a repeat, and progress
 * when it is an edit that worked or a test run that passed.
 */
export function noteCall(s: Signals, key: string, isError: boolean, test = false, edit = false): Signals {
  const c = s.calls[key] ?? { n: 0, errors: 0 }
  const isTest = test || c.test === true
  const step = { novel: s.calls[key] === undefined, progress: !isError && (edit || test) }
  return {
    ...s,
    recent: [...(s.recent ?? []), step].slice(-RECENT_MAX),
    errors: s.errors + (isError && !test ? 1 : 0),
    calls: { ...s.calls, [key]: { n: c.n + 1, errors: c.errors + (isError ? 1 : 0), ...(isTest ? { test: true as const } : {}) } },
    ...(isTest ? { lastTest: isError ? ('failed' as const) : ('passed' as const) } : {}),
    // A test run resets the count: a red one starts it, a green one ends it. Any other call after a red one adds to it.
    ...(isTest ? { afterFail: isError ? 0 : undefined } : s.afterFail !== undefined ? { afterFail: s.afterFail + 1 } : {}),
  }
}

/**
 * The first sign that has not raised effort yet, at the step about to go out; undefined when none.
 * `maxRaises` is the turn's cap on raises: a helper's cap is the task's retry budget, not this one.
 */
export function struggle(s: Signals, step: number, ratedSteps: number, limits: Limits = LIMITS.normal, maxRaises = MAX_RAISES): Struggle | undefined {
  if (s.fired.length >= maxRaises) return undefined
  const calls = Object.values(s.calls)
  const found: Struggle[] = []
  // A failing test run needs one more repeat than any other call.
  const again = (c: { test?: true }) => limits.repeat + (c.test ? 1 : 0)
  const repeated = calls.find(c => c.errors >= again(c))
  if (repeated) {
    const n = again(repeated)
    found.push({ kind: 'repeat-fail', why: `the same ${repeated.test ? 'test run' : 'tool call'} failed ${n === 2 ? 'twice' : `${n} times`}` })
  }
  if (s.errors >= limits.errors) found.push({ kind: 'errors', why: `${s.errors} tool calls failed` })
  // Running the tests again after each change is the normal way to work, not going round.
  if (calls.some(c => !c.test && c.n >= limits.loop)) found.push({ kind: 'loop', why: `the same tool call ran ${limits.loop} times` })
  const long = Math.max(limits.longMin, limits.longX * Math.max(1, ratedSteps))
  // A failing test run, then the turn goes on without running it again: the failure is being left behind
  // (an answer that is complete and wrong looks like this; ADR 0021). Editing counts as going on: the fix
  // is not known to work until the run is green.
  if (s.lastTest === 'failed' && (s.afterFail ?? 0) >= limits.afterFail)
    found.push({ kind: 'failed-check', why: `the last test run failed and ${limits.afterFail} calls later it has not run again` })
  if (step >= long) {
    // Only the last `window` calls count, so a turn that stalls later is still caught. A short record is not enough to say.
    const last = (s.recent ?? []).slice(-limits.window)
    if (last.length >= limits.window && !last.some(r => r.progress) && last.filter(r => r.novel).length / last.length < limits.novel)
      found.push({ kind: 'long', why: `the turn passed ${long} steps, ${limits.longX}x the estimate, and the last ${limits.window} calls made no progress` })
  }
  return found.find(f => !s.fired.includes(f.kind))
}

/**
 * Helper call cap: the most tool calls a helper on a cheaper tier may make for one task, however well they go.
 * A stall is otherwise found by lack of progress; this is the hard limit for a helper that keeps busy and never finishes.
 * A tier with no entry (Opus, Fable) has no cap. `tight` and `loose` move both numbers; `off` removes the cap.
 */
export const CAPS = {
  tight: { haiku: 15, sonnet: 25 },
  normal: { haiku: 25, sonnet: 40 },
  loose: { haiku: 40, sonnet: 60 },
  off: {},
} as const satisfies Record<string, Partial<Record<'haiku' | 'sonnet', number>>>
export type CapSetting = keyof typeof CAPS
export const isCapSetting = (v: unknown): v is CapSetting => typeof v === 'string' && Object.hasOwn(CAPS, v)
/** The cap for a helper on `tier` under the setting; undefined when that tier has none. */
export const helperCap = (setting: CapSetting, tier: string): number | undefined => (CAPS[setting] as Partial<Record<string, number>>)[tier]

/** One level up, at most CEILING and the Highest effort setting; undefined when already there. */
export function oneUp(level: Level, ceiling: Level = 'max'): Level | undefined {
  const top = levelRank(ceiling) < levelRank(CEILING) ? ceiling : CEILING
  const next = LEVELS[levelRank(level) + 1]
  return next && levelRank(next) <= levelRank(top) ? next : undefined
}
