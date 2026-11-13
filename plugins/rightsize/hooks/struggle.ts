import type { RightsizeLevel as Level } from '../types'
import { LEVELS, levelRank } from './cost'

// Signs, inside one turn, that the main chat is struggling at the effort it runs
// at: tool calls failing with nothing to show for the last calls, the same call failing
// again, the same call going round, a turn running far past the rating's step guess
// with nothing to show for the last calls, or fixes that keep leaving the tests red. A
// turn that keeps editing files, passes its tests or reads new things is just working
// through a big plan, and a failing command early in a debug turn is the work (a repro
// script is meant to fail), so neither is one (ADR 0025). An error that comes from the environment
// (blockedError) is not a sign either, and a failing test run is often an expected
// red (isTestCommand), so it counts less: what counts is a fix attempt (an edit
// after a red run) that leaves the next run red too. Each kind can raise effort once a turn. How soon each sign counts is
// set by LIMITS. Pure functions, no engine calls.

/** What the turn's tool calls have shown so far. */
export type Signals = {
  errors: number
  /** Per call (tool and arguments), how often it ran and how often it failed; `test` marks a test-runner command. */
  calls: Record<string, { n: number; errors: number; test?: true }>
  /** Kinds that have already raised effort this turn. */
  fired: Kind[]
  /** How the last test run in the turn ended: the objective outcome of the work, where there was one. */
  lastTest?: 'passed' | 'failed'
  /** Fix attempts that left the tests red: a red run, an edit, then a red run again. Reset by a green run. */
  failedTries?: number
  /** A file edit since the last failing test run: the next red run is a failed fix attempt, not a repeat of the same red. */
  editedSinceRed?: boolean
  /**
   * The last few calls, oldest first, bounded at RECENT_MAX. `novel`: the call had not run earlier in the
   * turn. `progress`: a file edit or write that worked, or a test run that passed. `error`: the call failed
   * and was not a test run. Absent in an old shape (`error` absent reads as false).
   */
  recent?: { novel: boolean; progress: boolean; error?: boolean }[]
}

/** What the turn's test runs say about the work: how the last one ended, or nothing when none ran. */
export const testsOutcome = (s: Signals) => s.lastTest

export type Kind = 'errors' | 'repeat-fail' | 'loop' | 'long' | 'failed-check'
export type Struggle = { kind: Kind; why: string }

/** Failures of one identical call before it counts as struggling. */
export const REPEAT = 2
/** Tool errors in the last WINDOW calls, with no progress among them, before it counts as struggling (ADR 0025). */
export const ERRORS = 3
/** Runs of one identical call before it counts as going round. */
export const LOOP = 3
/** A turn this many times past the rating's step guess, and at least LONG_MIN steps, is long. */
export const LONG_X = 3
export const LONG_MIN = 15
/** A long turn is stuck only when the last WINDOW calls hold no progress and under NOVEL of them are new calls. */
export const WINDOW = 10
export const NOVEL = 0.5
/** Fix attempts that left the tests red (red run, edit, red run) before the turn counts as failing to fix. */
export const FAILED_TRIES = 2

/** How soon each sign counts. */
export type Limits = { repeat: number; errors: number; loop: number; longX: number; longMin: number; window: number; novel: number; failedTries: number }
/** The limits the stuck signs use. */
export const LIMITS: Limits = { repeat: REPEAT, errors: ERRORS, loop: LOOP, longX: LONG_X, longMin: LONG_MIN, window: WINDOW, novel: NOVEL, failedTries: FAILED_TRIES }
/** How many recent calls the signals keep: the window. */
export const RECENT_MAX = LIMITS.window
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
 * The same holds for the denial core makes itself when a call needs approval and nobody can be asked
 * (a headless run, `claude -p`, CI): the setup said no, and more effort would not change it (ADR 0034).
 */
const REFUSED = /^(?:<tool_use_error>\s*)?(?:The user doesn't want to proceed with this tool use\b|User rejected tool use\b|Permission for this tool use was denied\b|File is in a directory that is denied by your permission settings\b)/

export const refusedByPerson = (text: string): boolean => REFUSED.test(text.trimStart())

/**
 * Core's text for a classic (settings.json or hooks.json) PreToolUse hook that refused a call: exit code 2,
 * an old-style {"decision":"block"}, or a hook set to block that crashed. The prefix is core's; the rest is
 * the hook's own words, so only the start is matched, never a plugin's name or message. A `permissionDecision`
 * of "deny" with no reason gives core's own `Blocked by hook`. The hook said no: that is the setup steering,
 * not Claude struggling (ADR 0049).
 */
const HOOK_REFUSED = /^(?:<tool_use_error>\s*)?PreToolUse:\S+ hook error:/
const HOOK_BLOCKED_BARE = /^(?:<tool_use_error>\s*)?Blocked by hook(?:\s*<\/tool_use_error>)?$/
/** Core's crash or timeout of a hook that must succeed: `[<hook>]: failed; blocking because ...` or `timed out; blocking because ...`. */
const HOOK_FAILED = /^(?:<tool_use_error>\s*)?PreToolUse:\S+ hook error: \[[^\n]*\]: (?:failed|timed out); blocking because /

export const refusedByHook = (text: string): boolean => {
  const t = text.trimStart()
  return HOOK_REFUSED.test(t) || HOOK_BLOCKED_BARE.test(t.trimEnd())
}

/** A blocking hook that crashed or timed out: an environment failure, like `blockedError`. Check this before `refusedByHook`. */
export const hookFailed = (text: string): boolean => HOOK_FAILED.test(text.trimStart())

/** Programs whose exit code 1 means "nothing found" or "the two differ" (or, for test and `[`, "false"), not "the call failed". */
const NO_MATCH_PROGRAMS: ReadonlySet<string> = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'git grep', 'diff', 'cmp', 'comm', 'test', '['])
/** Core's text for a Bash call that ended with exactly exit code 1 (not 10, not 2). */
const EXIT_ONE = /^\s*Exit code 1(?!\d)/

/**
 * Splits a shell line into words, honoring quotes and backslashes; `|` and the separators `&&`, `||`, `;` and a
 * newline outside quotes end a word and are kept as their own tokens. Not a shell parser: just enough to find
 * which program a command ends in.
 */
function shellTokens(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let has = false
  let quote = ''
  const push = () => {
    if (has) out.push(cur)
    cur = ''
    has = false
  }
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string
    if (quote) {
      if (ch === quote) quote = ''
      else if (ch === '\\' && quote === '"' && i + 1 < line.length) cur += line[++i]
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      has = true
    } else if (ch === '\\' && i + 1 < line.length) {
      cur += line[++i]
      has = true
    } else if (/\s/.test(ch) && ch !== '\n') push()
    else if (ch === '\n' || ch === ';') {
      push()
      out.push(';')
    } else if (ch === '&' && line[i + 1] === '&') {
      push()
      out.push('&&')
      i++
    } else if (ch === '|') {
      push()
      if (line[i + 1] === '|') {
        out.push('||')
        i++
      } else out.push('|')
    } else {
      cur += ch
      has = true
    }
  }
  push()
  return out
}

/** The program a simple command runs, after `VAR=value`, `time` and `timeout N` prefixes; `git grep` for that one; undefined when none. */
function programOf(words: string[]): string | undefined {
  let i = 0
  const skipPrefixes = () => {
    for (;;) {
      const w = words[i]
      if (w === undefined) return
      if (/^[A-Za-z_]\w*=/.test(w) || w === 'time' || w === 'command') i++
      else if (w === 'timeout') {
        i++
        while (words[i]?.startsWith('-')) i += /^-(?:s|k)$/.test(words[i] as string) ? 2 : 1
        if (words[i] !== undefined && /^[\d.]+[smhd]?$/.test(words[i] as string)) i++
      } else return
    }
  }
  skipPrefixes()
  const first = words[i]
  if (first === undefined) return undefined
  const name = first === '[' ? first : (first.split('/').pop() ?? first)
  if (name !== 'git') return name
  // git's own options (-C dir, -c key=value, --no-pager) come before the subcommand.
  for (i++; i < words.length; i++) {
    const w = words[i] as string
    if (w === '-C' || w === '-c') i++
    else if (!w.startsWith('-')) return w === 'grep' ? 'git grep' : `git ${w}`
  }
  return 'git'
}

/**
 * Whether a Bash call's result is "no match", not a failure. `grep`, `rg`, `diff`, `test` and the like exit 1 to say
 * "nothing found", "the files differ" or "false", and core hands that back as an error result whose text starts
 * `Exit code 1`. A model that searches is not failing when the search finds nothing, so such a call counts as a
 * success for every sign: it adds nothing to `errors`, is not a repeat failure, and does not step a lowered turn
 * back up. Exit code 2 or more (a bad pattern) is still an error. The program is the first command after any
 * `cd … &&` in the last `;` group, and the last stage of its pipeline, whose status is its last command's.
 * A line of read-only lookups that failed only on a missing file counts the same way (`lookupMiss`, ADR 0035).
 */
export function noMatchExit(tool: string, input: Record<string, unknown>, text: string): boolean {
  if (tool !== 'Bash' || typeof input.command !== 'string') return false
  return foundNothing(input.command, text) || lookupMiss(input.command, text)
}

/** Commands split on `&&`, `||` and `;` (a newline is a `;`), each kept with the separator before it. */
function commandsOf(line: string): { sep: string; words: string[] }[] {
  const out: { sep: string; words: string[] }[] = [{ sep: '', words: [] }]
  for (const t of shellTokens(line)) {
    if (t === '&&' || t === '||' || t === ';') out.push({ sep: t, words: [] })
    else (out[out.length - 1] as { words: string[] }).words.push(t)
  }
  return out.filter(c => c.words.length > 0)
}

const isCd = (words: string[]) => words[0] === 'cd' || words[0] === 'pushd'

/** A pipeline's stages, split on `|`. */
function stagesOf(words: string[]): string[][] {
  const out: string[][] = [[]]
  for (const w of words) {
    if (w === '|') out.push([])
    else (out[out.length - 1] as string[]).push(w)
  }
  return out
}

/** Exit code 1 from a grep-like program: the command the shell's status comes from is the first one after any leading `cd`s
 * in the last `;` group (a `;` list returns its last command's status), and its pipeline's last stage. */
function foundNothing(command: string, text: string): boolean {
  if (!EXIT_ONE.test(text)) return false
  const commands = commandsOf(command)
  let start = 0
  commands.forEach((c, i) => {
    if (c.sep === ';') start = i
  })
  const group = commands.slice(start)
  let first = 0
  while (first < group.length - 1 && isCd((group[first] as { words: string[] }).words)) first++
  const stages = stagesOf(group[first]?.words ?? [])
  const program = programOf(stages[stages.length - 1] ?? [])
  return program !== undefined && NO_MATCH_PROGRAMS.has(program)
}

/** Programs that only read. `sed` and `find` count only without the flags that write or run other programs. */
const LOOKUP_PROGRAMS: ReadonlySet<string> = new Set([
  ...NO_MATCH_PROGRAMS,
  'cat', 'head', 'tail', 'less', 'ls', 'tree', 'wc', 'file', 'stat', 'du', 'nl', 'cut', 'sort', 'uniq', 'tr', 'jq',
  'sed', 'find', 'echo', 'printf', 'true', 'pwd', 'basename', 'dirname', 'realpath', 'readlink',
  'git show', 'git log', 'git diff', 'git status', 'git ls-files', 'git blame', 'git rev-parse', 'git cat-file',
])
const EXIT_NONZERO = /^\s*Exit code [1-9]\d*\b/
const MISSING_FILE = /No such file or directory/
const EXIT_ONE_OR_TWO = /^\s*Exit code [12](?!\d)/
const HIDES_ERRORS = /(?:\b2|&)>\s*\/dev\/null\b/
/** Whether a stage redirects output to anything but /dev/null or another descriptor (`> b`, `>b`, `2>> log`). */
function writesFile(stage: string[]): boolean {
  return stage.some((w, i) => {
    const m = /^\d*>>?(.*)$/.exec(w)
    if (!m) return false
    const target = m[1] || (stage[i + 1] ?? '')
    return target !== '/dev/null' && !/^&\d$/.test(target)
  })
}

/**
 * A line of read-only lookups that ended non-zero because a file it named is not there: `grep x f; head CHANGES.rst` in a
 * repo that has CHANGES.md. The model is looking around, and one guessed path that does not exist is not the work
 * getting harder (ADR 0035). Every program on the line, in every command and pipeline stage, must be a lookup, nothing
 * may be written, and the output must say "No such file or directory". When the line sends errors to /dev/null
 * (`grep -rn x README.md docs 2>/dev/null`), the model said ahead that a path may be missing and the text cannot say so:
 * exit code 1 or 2 counts then. Any other non-zero exit is still an error.
 */
function lookupMiss(command: string, text: string): boolean {
  const said = EXIT_NONZERO.test(text) && MISSING_FILE.test(text)
  const hidden = EXIT_ONE_OR_TWO.test(text) && HIDES_ERRORS.test(command)
  if (!said && !hidden) return false
  const commands = commandsOf(command).filter(c => !isCd(c.words))
  if (commands.length === 0) return false
  for (const c of commands) {
    for (const stage of stagesOf(c.words)) {
      if (writesFile(stage)) return false
      const program = programOf(stage)
      if (program === undefined || !LOOKUP_PROGRAMS.has(program)) return false
      if (program === 'sed' && stage.some(w => /^-[^-]*i|^--in-place/.test(w))) return false
      if (program === 'find' && stage.some(w => /^-(?:delete|exec|execdir|ok|okdir|fprint\w*|fls)$/.test(w))) return false
    }
  }
  return true
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

/**
 * Tools that only report where the work stands: the app's task list and next-step box, Claude Code's own
 * task tools and a question to the person. Their calls repeat by design (`update_plan {"advance": true}` once
 * per finished step), so they are no sign of anything and do not join the signals at all.
 */
const BOOKKEEPING = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'AskUserQuestion', 'SubagentHandback'])
/**
 * The one tool a subagent delivers its report with. The call ends its run, so it can never be more work:
 * a helper that was stopped must still be able to make it, or its report is lost and the work is redone.
 */
export const HANDBACK = 'SubagentHandback'
export const isBookkeeping = (tool: string): boolean => BOOKKEEPING.has(tool) || tool.startsWith('mcp__ccd_turn__')

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
  const step = { novel: s.calls[key] === undefined, progress: !isError && (edit || test), ...(isError && !test ? { error: true } : {}) }
  return {
    ...s,
    recent: [...(s.recent ?? []), step].slice(-RECENT_MAX),
    errors: s.errors + (isError && !test ? 1 : 0),
    calls: { ...s.calls, [key]: { n: c.n + 1, errors: c.errors + (isError ? 1 : 0), ...(isTest ? { test: true as const } : {}) } },
    ...(isTest ? { lastTest: isError ? ('failed' as const) : ('passed' as const) } : {}),
    // A green run ends the count. A red run after an edit since the last red is a failed fix attempt; a red run
    // with no edit between (the same red again, or the first red) is not an attempt. An edit after a red arms the next run.
    ...(isTest
      ? isError
        ? { failedTries: (s.failedTries ?? 0) + (s.lastTest === 'failed' && s.editedSinceRed ? 1 : 0), editedSinceRed: false }
        : { failedTries: undefined, editedSinceRed: undefined }
      : edit && !isError && s.lastTest === 'failed' ? { editedSinceRed: true } : {}),
  }
}

/**
 * The first sign that has not raised effort yet, at the step about to go out; undefined when none.
 * `maxRaises` is the turn's cap on raises: a helper's cap is the task's retry budget, not this one.
 */
export function struggle(s: Signals, step: number, ratedSteps: number, limits: Limits = LIMITS, maxRaises = MAX_RAISES): Struggle | undefined {
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
  // Failed calls count only when the last `window` calls hold enough of them and no progress: a repro script that fails,
  // a probe that errors, then an edit that works is debugging, not struggling. A short record is not enough to say.
  const recent = (s.recent ?? []).slice(-limits.window)
  const failed = recent.filter(r => r.error).length
  if (recent.length >= limits.window && failed >= limits.errors && !recent.some(r => r.progress))
    found.push({ kind: 'errors', why: `${failed} of the last ${limits.window} tool calls failed and none made progress` })
  // Running the tests again after each change is the normal way to work, not going round.
  if (calls.some(c => !c.test && c.n >= limits.loop)) found.push({ kind: 'loop', why: `the same tool call ran ${limits.loop} times` })
  const long = Math.max(limits.longMin, limits.longX * Math.max(1, ratedSteps))
  // Fixes that keep leaving the tests red (ADR 0022): a red run, an edit, a red run again is one failed attempt.
  // How many calls a fix takes does not matter; only a run that is still red after a change counts.
  if (s.lastTest === 'failed' && (s.failedTries ?? 0) >= limits.failedTries) {
    const n = limits.failedTries
    found.push({ kind: 'failed-check', why: `${n === 1 ? 'a fix' : `${n} fixes in a row`} left the tests red` })
  }
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
 * A tier with no entry (Opus, Fable) has no cap.
 */
export const CAPS: Readonly<Partial<Record<string, number>>> = { haiku: 25, sonnet: 40 }
/** The cap for a helper on `tier`; undefined when that tier has none. */
export const helperCap = (tier: string): number | undefined => CAPS[tier]

/** One level up, at most CEILING and the Highest effort setting; undefined when already there. */
export function oneUp(level: Level, ceiling: Level = 'max'): Level | undefined {
  const top = levelRank(ceiling) < levelRank(CEILING) ? ceiling : CEILING
  const next = LEVELS[levelRank(level) + 1]
  return next && levelRank(next) <= levelRank(top) ? next : undefined
}
