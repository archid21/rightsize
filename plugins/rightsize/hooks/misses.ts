import type { RightsizeTaskType as TaskType, RightsizeTier as Tier } from '../types'
import { TASK_TYPES, TIERS, isLevel, isTaskType, isTier } from './cost'
import type { RunLine } from './report'

// How often the rater (Haiku) was wrong, scored against what happened. Each rated
// turn, 👍/👎 and Sonnet spot-check in the run log is one outcome for a task type and
// model: a hit when the rater's judgement held, a miss when it did not. Pure
// functions, no engine calls.

/** Per `${type}:${tier}`, the outcomes seen and how many were misses. */
export type Rates = Record<string, { n: number; misses: number }>

/** Outcomes a key needs before its own rate is used. */
export const MISS_MIN = 5

/** The tasks a research prior stands for: the most any profile asks for, so every profile can start from it. */
export const PRIOR_N = 10

// Research priors: the share of misses each kind of work had on a cheaper model in rightsize's own research,
// where the strongest model did the same work reliably. Every profile starts from them. A prior counts as
// PRIOR_N pseudo-tasks; every real outcome on this machine pushes one out, and with PRIOR_N real outcomes only
// this machine's log is left. Work with no prior waits for its own log. Opus and Fable are the reference: none.
export const RESEARCH_PRIORS: Readonly<Record<string, number>> = {
  'lookup:haiku': 0,
  'search:haiku': 0,
  'bulk-edit:haiku': 0,
  'debug:haiku': 0,
  'refactor:haiku': 0,
  'feature:haiku': 0,
  /** Reviews hunt subtle bugs, which a Haiku-level read tends to miss. */
  'review:haiku': 0.8,
  /** Writing is judged on style. The research could not tell models apart on it, so this is a starting guess. */
  'writing:haiku': 0.5,
  'lookup:sonnet': 0,
  'search:sonnet': 0,
  'bulk-edit:sonnet': 0,
  'debug:sonnet': 0,
  'refactor:sonnet': 0,
  'feature:sonnet': 0,
  'review:sonnet': 0.3,
}

export const missKey = (type: string, tier: string) => `${type}:${tier}`

const delegateTier = (l: RunLine) => {
  const t = (l.route ?? '').startsWith('delegate:') ? (l.route ?? '').slice('delegate:'.length) : ''
  return isTier(t) ? t : undefined
}

type Outcome = { type: TaskType; tier: Tier; miss: boolean }
/** An outcome, the task it belongs to (a run's task, its own id before 0.8; a feedback's run's; a check is a task of its own), and where it came from. */
type Counted = [Outcome, string, 'auto' | 'verdict']

/** The model a run's work ran on: a hand-off's subagent, else the main chat. */
const workedOn = (l: RunLine) => delegateTier(l) ?? (isTier(l.tier) ? l.tier : undefined)

// What one run line says about the rater, apart from feedback.
function ofRun(l: RunLine): Outcome | undefined {
  if (l.aborted || !isTaskType(l.type)) return undefined
  const type = l.type
  const tier = isTier(l.tier) ? l.tier : undefined
  const raised = (l.escalations?.length ?? 0) > 0
  // Handed to a cheaper model: more than one subagent call is rework.
  const sub = delegateTier(l)
  if (sub && l.change === 'delegate-down') return { type, tier: sub, miss: (l.agentCalls ?? 0) > 1 }
  if (!tier) return undefined
  // Lowered: it had to step back up, or was raised mid-turn.
  if (l.change === 'lower') return { type, tier, miss: l.steppedUp === true || raised }
  // Left in the main chat unchanged: only a mid-turn raise says the rating was wrong.
  if (!sub && (l.change ?? 'none') === 'none' && raised) return { type, tier, miss: true }
  return undefined
}

// A Sonnet check: for each model Haiku named a level for, a miss where Sonnet says it would struggle.
function ofCheck(l: RunLine): Outcome[] {
  if (!isTaskType(l.type) || !l.fit || !l.check?.fit) return []
  const out: Outcome[] = []
  for (const tier of TIERS) {
    const [first, second] = [l.fit[tier], l.check.fit[tier]]
    if (!isLevel(first) || second === undefined) continue
    out.push({ type: l.type, tier, miss: second === null })
  }
  return out
}

/** Sonnet's spot-checks that compared at least one model, and how many of them agreed with Haiku on every model. */
export function checkTotals(lines: readonly RunLine[]) {
  let n = 0
  let agreed = 0
  for (const l of lines) {
    if (l.kind !== 'check') continue
    const o = ofCheck(l)
    if (!o.length) continue
    n += 1
    if (!o.some(x => x.miss)) agreed += 1
  }
  return { n, agreed }
}

// Every outcome in the log, in order, with its task.
function counted(lines: readonly RunLine[]): Counted[] {
  const out: Counted[] = []
  const runs = new Map<string, RunLine>()
  const verdicts = new Map<string, 'up' | 'down'>()
  const taskOf = (l: RunLine, i: number) => l.task ?? l.id ?? `line ${i}`
  lines.forEach((l, i) => {
    const kind = l.kind ?? 'run'
    if (kind === 'run') {
      const o = ofRun(l)
      if (o) out.push([o, taskOf(l, i), 'auto'])
      if (l.id) runs.set(l.id, l)
    } else if (kind === 'feedback') {
      // A person who changed their mind is counted once, on the last verdict.
      if (l.ref && (l.value === 'up' || l.value === 'down')) verdicts.set(l.ref, l.value)
    } else if (kind === 'check') {
      for (const o of ofCheck(l)) out.push([o, `check ${i}`, 'auto'])
    }
  })
  for (const [ref, value] of verdicts) {
    const run = runs.get(ref)
    const tier = run ? workedOn(run) : undefined
    if (run && tier && isTaskType(run.type)) out.push([{ type: run.type, tier, miss: value === 'down' }, run.task ?? ref, 'verdict'])
  }
  return out
}

/** Every outcome in the log, in order. */
export const outcomes = (lines: readonly RunLine[]): Outcome[] => counted(lines).map(([o]) => o)

/** Outcomes and misses per task type and model. */
export function missRates(lines: readonly RunLine[]): Rates {
  const rates: Rates = {}
  for (const o of outcomes(lines)) {
    const e = (rates[missKey(o.type, o.tier)] ??= { n: 0, misses: 0 })
    e.n += 1
    if (o.miss) e.misses += 1
  }
  return rates
}

/**
 * The rates the pause decision uses: as missRates, but the first automatic miss on each route not in `used` is
 * forgiven (left out). A person's 👎 is never forgiven. `forgiven` lists the routes whose forgiveness this call used.
 */
export function pauseRates(lines: readonly RunLine[], used: ReadonlySet<string>): { rates: Rates; forgiven: string[] } {
  const rates: Rates = {}
  const forgiven: string[] = []
  for (const [o, , source] of counted(lines)) {
    const key = missKey(o.type, o.tier)
    if (o.miss && source === 'auto' && !used.has(key) && !forgiven.includes(key)) {
      forgiven.push(key)
      continue
    }
    const e = (rates[key] ??= { n: 0, misses: 0 })
    e.n += 1
    if (o.miss) e.misses += 1
  }
  return { rates, forgiven }
}

/**
 * The share of wrong judgements for a task type on a model; with too few outcomes, the model's across all types; with too few of those, 0.
 * A key with a research prior (RESEARCH_PRIORS) and fewer than PRIOR_N own outcomes is scored on its own outcomes
 * plus enough prior pseudo-outcomes to make PRIOR_N.
 */
export function missRate(rates: Rates, type: string, tier: string) {
  const own = rates[missKey(type, tier)]
  const prior = RESEARCH_PRIORS[missKey(type, tier)]
  if (prior !== undefined && (own?.n ?? 0) < PRIOR_N) return ((own?.misses ?? 0) + (PRIOR_N - (own?.n ?? 0)) * prior) / PRIOR_N
  if (own && own.n >= MISS_MIN) return own.misses / own.n
  let n = 0
  let misses = 0
  for (const [key, e] of Object.entries(rates)) {
    if (!key.endsWith(`:${tier}`)) continue
    n += e.n
    misses += e.misses
  }
  return n >= MISS_MIN ? misses / n : 0
}

/** Every task type and model with a rate above zero, for Situation.misses. */
export function missMap(rates: Rates): Record<string, number> {
  const out: Record<string, number> = {}
  for (const type of TASK_TYPES) {
    for (const tier of TIERS) {
      const m = missRate(rates, type, tier)
      if (m > 0) out[missKey(type, tier)] = m
    }
  }
  return out
}

/**
 * The tasks per task type and model: what the profile's minimum of logged tasks is counted against. A task with
 * several outcomes (a run and its 👎) counts once. A key with a research prior counts its PRIOR_N pseudo-tasks
 * until real tasks outnumber them.
 */
export function missCounts(lines: readonly RunLine[]): Record<string, number> {
  const tasks = new Map<string, Set<string>>()
  for (const [o, task] of counted(lines)) {
    const key = missKey(o.type, o.tier)
    const seen = tasks.get(key) ?? new Set<string>()
    seen.add(task)
    tasks.set(key, seen)
  }
  const out: Record<string, number> = Object.fromEntries([...tasks].map(([key, seen]) => [key, seen.size]))
  for (const key of Object.keys(RESEARCH_PRIORS)) out[key] = Math.max(out[key] ?? 0, PRIOR_N)
  return out
}

/** All outcomes together: how many were misses of how many. */
export function missTotals(rates: Rates) {
  return Object.values(rates).reduce((t, e) => ({ n: t.n + e.n, misses: t.misses + e.misses }), { n: 0, misses: 0 })
}
