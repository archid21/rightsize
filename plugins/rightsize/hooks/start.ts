import type {
  RightsizeChoices as Choices,
  RightsizeLevel as Level,
  RightsizeTaskType as TaskType,
  RightsizeTier as Tier,
} from '../types'
import { type Calibration, type Fit, type Prices, type Rules, TIER_NAME, effortPlan, isLevel, isTaskType, isTier, levelRank, mainCost, needOn, plan, tierRank } from './cost'
import { type Rates, missRate, missRates } from './misses'
import { type RunLine, parseLines } from './report'

// Which model and effort a session should start on. Every rated prompt in the run log
// carries the level each model would need, which does not depend on the model the
// session ran on, so the log can be replayed through plan() from any start. The start
// with the lowest total cost (rightsize's hand-offs and effort changes counted) wins,
// unless too many of its prompts would go to a stronger model, checked by a weaker one.
// The rating is not taken on trust: where it has been wrong about a model for a kind of
// work (misses.ts), that share of the prompts is replayed as if the model had been
// rated unable. Pure functions, no engine calls.

export type Start = { tier: Tier; level: Level }

/** The starts compared. Haiku is too weak to lead a session; Fable is never the cheapest start. */
export const STARTS: readonly Start[] = [
  { tier: 'sonnet', level: 'medium' },
  { tier: 'sonnet', level: 'high' },
  { tier: 'opus', level: 'medium' },
  { tier: 'opus', level: 'high' },
]

/** Rated prompts in the window before any suggestion. */
export const START_MIN_PROMPTS = 50
/** Rated prompts on the current start before it is judged. */
export const START_MIN_ON_CURRENT = 20
/** How much cheaper another start must be; more when its main chat has few measured runs. */
export const START_MARGIN = 0.15
export const START_MARGIN_UNMEASURED = 0.25
/** Main-chat runs on a start before its estimate counts as measured. */
export const START_MEASURED = 20
/** At most this share of prompts handed to a stronger model, checked by the weaker main chat. */
export const START_MAX_UP = 0.1
/** Over this share needing a stronger model or a mid-turn raise, suggest a stronger start. */
export const START_QUALITY_UP = 0.15
/** Context for log lines from before the size was logged, when no line in the window has one. */
export const START_CONTEXT = 50_000
const DAY = 24 * 60 * 60 * 1000
export const START_WINDOW_DAYS = 30
export const START_CHECK_DAYS = 7
export const START_SNOOZE_DAYS = 14

export const startKey = (s: Start) => `${s.tier}:${s.level}`
export const startName = (s: Start) => `${TIER_NAME[s.tier]} at ${s.level}`
const same = (a: Start, b: Start) => a.tier === b.tier && a.level === b.level
/** Stronger: a stronger model, or the same model at a higher level. */
const stronger = (a: Start, than: Start) => tierRank(a.tier) > tierRank(than.tier) || (a.tier === than.tier && levelRank(a.level) > levelRank(than.level))

type Rated = RunLine & { fit: Fit; type: TaskType; read: number; write: number; steps: number }

const isRated = (l: RunLine): l is Rated => {
  const x = l as RunLine & Record<string, unknown>
  return (l.kind ?? 'run') === 'run' && !l.aborted && !l.afterWorkflow && !!x.fit && typeof x.fit === 'object' && isTaskType(l.type) && [x.read, x.write, x.steps].every(v => typeof v === 'number')
}

/** The session's own model and level on a line: `normal` from 0.7, else the level it ran at. */
export function startOf(l: RunLine): Start | undefined {
  const level = isLevel(l.normal) ? l.normal : l.level
  return isTier(l.tier) && isLevel(level) ? { tier: l.tier, level } : undefined
}

export type StartContext = {
  prices: Prices
  cal: Calibration
  rules: Rules
  floor: Level
  choices: Choices
  /** How often the rater's judgement was wrong (misses.ts); read off the log's lines when absent. */
  misses?: Rates
}

export type Replay = {
  start: Start
  /** Total estimated cost of the prompts from this start, rightsize's changes counted. */
  cost: number
  prompts: number
  /** Prompts handed to a stronger model. */
  up: number
  /** Main-chat runs logged on this start: how far its estimate is measured. */
  measured: number
}

/** What rightsize would have spent on one prompt from `start`, and whether it goes to a stronger model, for the rating `fit`. */
function once(l: Rated, fit: Fit, start: Start, context: number, c: StartContext) {
  const r = { level: needOn(fit, start.tier), fit, type: l.type, read: l.read, write: l.write, steps: l.steps, reason: '' }
  // ties 1: no exploring, so the replay picks what the guide would.
  const s = { tier: start.tier, level: start.level, context, prices: c.prices, cal: c.cal, rules: c.rules, ties: 1 }
  let p = plan(r, s, c.floor)
  if (p.kind === 'delegate' && c.choices[p.dir] === 'stay') p = effortPlan(r, s, c.floor)
  if (p.kind === 'delegate') return { cost: p.delegateCost, up: p.dir === 'up' ? 1 : 0 }
  if (p.kind === 'effort' && c.choices[p.dir] !== 'never') return { cost: mainCost(r, s, p.level, 2), up: 0 }
  return { cost: mainCost(r, s, start.level, 0), up: 0 }
}

/**
 * What rightsize would have spent on these prompts from `start`, following the person's rules.
 * The rater is sometimes wrong that the start's model does the work: with a miss rate m for the
 * task type on that model, a prompt costs (1 - m) of its cost as rated plus m of its cost had
 * the model been rated unable, and counts the same way toward the hand-ups.
 */
export function replay(lines: readonly RunLine[], start: Start, c: StartContext): Replay {
  const rated = lines.filter(isRated)
  const sized = rated.map(l => l.context).filter((v): v is number => typeof v === 'number' && v > 0)
  const fallback = sized.length ? [...sized].sort((a, b) => a - b)[Math.floor(sized.length / 2)] ?? START_CONTEXT : START_CONTEXT
  const rates = c.misses ?? {}
  let cost = 0
  let up = 0
  for (const l of rated) {
    const context = typeof l.context === 'number' && l.context > 0 ? l.context : fallback
    const asRated = once(l, l.fit, start, context, c)
    const m = l.fit[start.tier] ? missRate(rates, l.type, start.tier) : 0
    const wrong = m > 0 ? once(l, { ...l.fit, [start.tier]: null }, start, context, c) : asRated
    cost += (1 - m) * asRated.cost + m * wrong.cost
    up += (1 - m) * asRated.up + m * wrong.up
  }
  const measured = rated.filter(l => l.route === 'main' && l.tier === start.tier && l.level === start.level).length
  return { start, cost, prompts: rated.length, up, measured }
}

export type StartAdvice =
  | { kind: 'wait'; prompts: number; need: number; current?: Start }
  | { kind: 'stay'; current: Start; replays: Replay[] }
  | { kind: 'switch'; why: 'cost' | 'quality'; current: Start; to: Start; replays: Replay[]; saving: number; upShare: number; struggled: number }

/** The start to suggest from the last 30 days of the run log. */
export function adviseStart(lines: readonly RunLine[], c: StartContext, now: number): StartAdvice {
  const windowed = lines.filter(l => now - Date.parse(l.at) <= START_WINDOW_DAYS * DAY)
  const recent = windowed.filter(isRated)
  const current = [...recent].reverse().map(startOf).find(s => s !== undefined)
  if (recent.length < START_MIN_PROMPTS || !current) return { kind: 'wait', prompts: recent.length, need: START_MIN_PROMPTS, ...(current ? { current } : {}) }
  // Judge the current start only on prompts run from it, counted back from the newest.
  let onCurrent = 0
  for (const l of [...recent].reverse()) {
    const s = startOf(l)
    if (!s || !same(s, current)) break
    onCurrent += 1
  }
  if (onCurrent < START_MIN_ON_CURRENT) return { kind: 'wait', prompts: onCurrent, need: START_MIN_ON_CURRENT, current }
  const starts = STARTS.some(s => same(s, current)) ? STARTS : [...STARTS, current]
  const ctx = { ...c, misses: c.misses ?? missRates(windowed) }
  const replays = starts.map(s => replay(recent, s, ctx))
  const mine = replays.find(r => same(r.start, current))
  if (!mine || mine.cost <= 0) return { kind: 'stay', current, replays }
  const share = (r: Replay) => (r.prompts ? r.up / r.prompts : 0)

  // Quality first: prompts that needed a stronger model, or that Claude got stuck on, from the current start.
  const own = recent.slice(-onCurrent)
  const struggled = own.filter(l => l.escalations?.length || l.steppedUp).length
  const upNow = (mine.up + struggled) / mine.prompts
  if (upNow > START_QUALITY_UP) {
    const better = replays.filter(r => stronger(r.start, current) && share(r) <= START_MAX_UP).sort((a, b) => a.cost - b.cost)[0]
    if (better) return { kind: 'switch', why: 'quality', current, to: better.start, replays, saving: 1 - better.cost / mine.cost, upShare: share(better), struggled: upNow }
  }

  const fits = replays
    .filter(r => !same(r.start, current) && share(r) <= START_MAX_UP)
    .filter(r => r.cost <= mine.cost * (1 - (r.measured >= START_MEASURED ? START_MARGIN : START_MARGIN_UNMEASURED)))
    .sort((a, b) => a.cost - b.cost)
  const best = fits[0]
  if (!best) return { kind: 'stay', current, replays }
  return { kind: 'switch', why: 'cost', current, to: best.start, replays, saving: 1 - best.cost / mine.cost, upShare: share(best), struggled: upNow }
}

/** Reads the log text and advises; the engine-facing entry point. */
export const adviseFromLog = (text: string, c: StartContext, now: number) => adviseStart(parseLines<RunLine>(text), c, now)

const pct = (x: number) => `${Math.max(1, Math.round(x * 100))}%`

/** The band's one line for a suggestion. */
export function startTip(a: Extract<StartAdvice, { kind: 'switch' }>, subscription: boolean) {
  const n = a.replays[0]?.prompts ?? 0
  const to = startName(a.to)
  if (a.why === 'quality') {
    return `${pct(a.struggled)} of your last ${n} rated prompts needed a stronger model or more effort than ${startName(a.current)}. Starting on ${to} would need fewer hand-offs. Switch with /model.`
  }
  const less = subscription ? `used ~${pct(a.saving)} less of your usage` : `cost ~${pct(a.saving)} less`
  const up = a.upShare > 0 ? ` (~${pct(a.upShare)} of them would go to a stronger model)` : ''
  return `Starting on ${to} would have ${less} than ${startName(a.current)} on your last ${n} rated prompts${up}. Switch with /model.`
}

/** The report's block: each start's replayed cost, and the advice. */
export function startLines(a: StartAdvice, subscription: boolean, money: (d: number) => string): string[] {
  if (a.kind === 'wait') {
    const on = a.current ? ` on ${startName(a.current)}` : ''
    return [`Starting point: needs ${a.need} rated prompts${on} to compare starts (has ${a.prompts}).`]
  }
  const mine = a.replays.find(r => same(r.start, a.current))
  const n = mine?.prompts ?? 0
  const each = a.replays.map(r => {
    const value = subscription ? `${Math.round((r.cost / Math.max(mine?.cost ?? 1, 1e-9)) * 100)}% of yours` : `~${money((r.cost / Math.max(n, 1)) * 100)} per 100 prompts`
    const up = r.up ? `, ${pct(r.up / r.prompts)} to a stronger model` : ''
    const yours = same(r.start, a.current) ? ' (yours)' : ''
    return `${startName(r.start)}${yours} ${value}${up}`
  })
  const out = [`Starting point (last ${START_WINDOW_DAYS} days, ${n} rated prompts): ${startName(a.current)}.`, `  Estimated from your log: ${each.join('; ')}.`]
  out.push(a.kind === 'switch' ? `  Suggestion: ${startTip(a, subscription)}` : '  Your start fits: no other start is clearly cheaper without sending more work to a stronger model.')
  return out
}
