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

export const missKey = (type: string, tier: string) => `${type}:${tier}`

const delegateTier = (l: RunLine) => {
  const t = (l.route ?? '').startsWith('delegate:') ? (l.route ?? '').slice('delegate:'.length) : ''
  return isTier(t) ? t : undefined
}

type Outcome = { type: TaskType; tier: Tier; miss: boolean }

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

/** Every outcome in the log, in order. */
export function outcomes(lines: readonly RunLine[]): Outcome[] {
  const out: Outcome[] = []
  const runs = new Map<string, RunLine>()
  const verdicts = new Map<string, 'up' | 'down'>()
  for (const l of lines) {
    const kind = l.kind ?? 'run'
    if (kind === 'run') {
      const o = ofRun(l)
      if (o) out.push(o)
      if (l.id) runs.set(l.id, l)
    } else if (kind === 'feedback') {
      // A person who changed their mind is counted once, on the last verdict.
      if (l.ref && (l.value === 'up' || l.value === 'down')) verdicts.set(l.ref, l.value)
    } else if (kind === 'check' && isTaskType(l.type) && l.fit && l.check?.fit) {
      for (const tier of TIERS) {
        const [first, second] = [l.fit[tier], l.check.fit[tier]]
        if (!isLevel(first) || second === undefined) continue
        out.push({ type: l.type, tier, miss: second === null })
      }
    }
  }
  for (const [ref, value] of verdicts) {
    const run = runs.get(ref)
    const tier = run ? workedOn(run) : undefined
    if (run && tier && isTaskType(run.type)) out.push({ type: run.type, tier, miss: value === 'down' })
  }
  return out
}

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

/** The share of wrong judgements for a task type on a model; with too few outcomes, the model's across all types; with too few of those, 0. */
export function missRate(rates: Rates, type: string, tier: string) {
  const own = rates[missKey(type, tier)]
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

/** All outcomes together: how many were misses of how many. */
export function missTotals(rates: Rates) {
  return Object.values(rates).reduce((t, e) => ({ n: t.n + e.n, misses: t.misses + e.misses }), { n: 0, misses: 0 })
}
