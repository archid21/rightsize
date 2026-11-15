import type { RightsizeTaskType as TaskType, RightsizeTier as Tier } from '../types'
import { type Calibration, CAL_FULL, isTier, money, routeKeys } from './cost'
import { type RunLine, type Share, bandShareText, shareOf } from './report'

// The big-turn warning (P-46, ADR 0075): an opt-in warning for an unusually expensive turn, before the prompt runs (from
// rightsize's estimate) and during the turn (from the re-estimate). Pure functions: the amount, the two ranges and the
// words. No engine calls.

/** The row's values: off, auto (the person's own top 1%), or a fixed amount. */
export type BigTurnRow = 'off' | 'auto' | '$1' | '$2' | '$5'

const DAY = 24 * 60 * 60_000
/** Turns older than this are not read: the amount and the ranges follow the last 30 days of work. */
export const BIG_TURN_DAYS = 30
/** auto: the percentile of the person's own finished turns. */
export const BIG_TURN_PERCENTILE = 0.99
/** auto: the amount until the person has this many finished turns in the window. */
export const BIG_TURN_MIN_TURNS = 50
/** auto: the amount before BIG_TURN_MIN_TURNS turns exist. */
export const BIG_TURN_START = 2
/** auto: never under this. */
export const BIG_TURN_FLOOR = 1
/** auto: recomputed at most this often. */
export const BIG_TURN_RECOMPUTE_MS = 7 * DAY
/** The opt-in question: after No thanks it is not asked again for this long. */
export const BIG_TURN_NO_THANKS_MS = 90 * DAY
/** The opt-in question: after no answer it is asked again at the next qualifying turn after this long. */
export const BIG_TURN_NO_ANSWER_MS = 7 * DAY

/** The fixed amounts' rows. */
export const BIG_TURN_FIXED: Record<'$1' | '$2' | '$5', number> = { $1: 1, $2: 2, $5: 5 }

/** Before the prompt: the range is the estimate times the 25th and 75th percentile of past actual / estimate ratios, when at least this many exist. */
export const RANGE_MIN_RATIOS = 10
export const RANGE_LOW_PERCENTILE = 0.25
export const RANGE_HIGH_PERCENTILE = 0.75
/** The range when there are too few past ratios: half to double the estimate. */
export const RANGE_DEFAULT = { lo: 0.5, hi: 2 } as const

/** During a turn: the range is the projected cost times these. */
export const DURING_LOW = 0.8
export const DURING_HIGH = 1.25

/** During a turn: after this many Keep going answers in a row, rightsize asks whether to stop the warnings during a turn. */
export const KEEP_GOING_ASK_AFTER = 3

/** Plan first appends this after a blank line. */
export const PLAN_FIRST_TEXT = 'Before doing the work, propose a short plan and wait for my go-ahead.'
/** Finish up puts this in the prompt box, for the person to send into the running turn. */
export const FINISH_UP_TEXT = "Finish the current step, then report what you've done and what's left."
/** A turn that showed the during-turn warning and was stopped by the person: this goes in the prompt box, never sent. */
export const STOP_REPORT_TEXT = "Report what you've done so far and what's left."
/** The band's line after that draft. */
export const STOPPED_TEXT = 'Stopped. A report request is in your prompt box: send it if you want one.'

/** The prompt with the plan-first request after a blank line. */
export const withPlanFirst = (text: string) => `${text}\n\n${PLAN_FIRST_TEXT}`

export const isBigTurnRow = (v: unknown): v is BigTurnRow => v === 'off' || v === 'auto' || v === '$1' || v === '$2' || v === '$5'

const isRun = (l: RunLine) => (l.kind ?? 'run') === 'run'
const recent = (l: RunLine, now: number) => {
  const t = Date.parse(l.at)
  return Number.isFinite(t) && now - t <= BIG_TURN_DAYS * DAY
}

/** The p-th percentile (0 to 1) of `values` by linear interpolation between neighbours. NaN for none. */
export function percentile(values: readonly number[], p: number): number {
  if (!values.length) return Number.NaN
  const v = [...values].sort((a, b) => a - b)
  const at = Math.min(1, Math.max(0, p)) * (v.length - 1)
  const lo = Math.floor(at)
  const hi = Math.ceil(at)
  const a = v[lo] ?? 0
  const b = v[hi] ?? a
  return a + (b - a) * (at - lo)
}

/** What the person's finished turns of the last 30 days cost (`actual` on run lines, not aborted). */
export function turnCosts(lines: readonly RunLine[], now: number): number[] {
  return lines.filter(l => isRun(l) && !l.aborted && recent(l, now) && typeof l.actual === 'number' && Number.isFinite(l.actual) && l.actual > 0).map(l => l.actual as number)
}

const cents = (x: number) => Math.round(x * 100) / 100

/** auto's amount: the 99th percentile of the person's own turn costs in the last 30 days; $2 until 50 such turns exist; never under $1. */
export function autoAmount(lines: readonly RunLine[], now: number): number {
  const costs = turnCosts(lines, now)
  if (costs.length < BIG_TURN_MIN_TURNS) return BIG_TURN_START
  return Math.max(BIG_TURN_FLOOR, cents(percentile(costs, BIG_TURN_PERCENTILE)))
}

/** The stored auto amount and when it was computed (ms). */
export type StoredAmount = { value: number; at: number }

export const parseStoredAmount = (v: unknown): StoredAmount | undefined => {
  if (!v || typeof v !== 'object') return undefined
  const { value, at } = v as { value?: unknown; at?: unknown }
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && typeof at === 'number' && Number.isFinite(at) ? { value, at } : undefined
}

/**
 * The auto amount to use now: the stored one while it is under a week old, else computed again from the lines. `stored` says
 * whether the result is new and has to be saved.
 */
export function autoAmountNow(stored: StoredAmount | undefined, lines: readonly RunLine[], now: number): StoredAmount & { fresh: boolean } {
  if (stored && now >= stored.at && now - stored.at < BIG_TURN_RECOMPUTE_MS) return { ...stored, fresh: false }
  return { value: autoAmount(lines, now), at: now, fresh: true }
}

/** The fixed amount a row stands for; undefined for off and auto. */
export const fixedAmount = (row: string): number | undefined => (row === '$1' || row === '$2' || row === '$5' ? BIG_TURN_FIXED[row] : undefined)

/** The model a run line's work ran on: the hand-off's model for a delegate route, else the main chat's. */
const modelOf = (l: RunLine): Tier | undefined => {
  const route = typeof l.route === 'string' && l.route.startsWith('delegate:') ? l.route.slice('delegate:'.length) : undefined
  const t = route ?? l.tier
  return isTier(t) ? t : undefined
}

/** Where a range came from: this type on this model, this model across types, or the default. */
export type RangeBasis = 'type' | 'model' | 'default'

/**
 * Before the prompt: the range of what a turn estimated at `estimate` may really cost. The 25th and 75th percentile of the
 * person's past actual / estimate ratios (`actual` over `taken` on finished run lines) for the same type and model in the last
 * 30 days when at least 10 exist; else the same model across types (at least 10); else 0.5x to 2x.
 */
export function bigTurnRange(lines: readonly RunLine[], type: TaskType, tier: Tier, estimate: number, now: number): { lo: number; hi: number; basis: RangeBasis } {
  const ratios = lines
    .filter(l => isRun(l) && !l.aborted && recent(l, now) && typeof l.actual === 'number' && l.actual > 0 && typeof l.taken === 'number' && l.taken > 0 && modelOf(l) === tier)
    .map(l => ({ type: l.type, ratio: (l.actual as number) / (l.taken as number) }))
  const same = ratios.filter(r => r.type === type).map(r => r.ratio)
  const [basis, use]: [RangeBasis, number[]] = same.length >= RANGE_MIN_RATIOS ? ['type', same] : ratios.length >= RANGE_MIN_RATIOS ? ['model', ratios.map(r => r.ratio)] : ['default', []]
  if (basis === 'default') return { lo: estimate * RANGE_DEFAULT.lo, hi: estimate * RANGE_DEFAULT.hi, basis }
  const a = estimate * percentile(use, RANGE_LOW_PERCENTILE)
  const b = estimate * percentile(use, RANGE_HIGH_PERCENTILE)
  return { lo: Math.min(a, b), hi: Math.max(a, b), basis }
}

/** During a turn: the range around the projected cost. */
export const duringRange = (projected: number) => ({ lo: projected * DURING_LOW, hi: projected * DURING_HIGH })

/** True while the calibration for this kind of work on this model has fewer than CAL_FULL runs: the warning says it is still learning. `route` is the main chat or a hand-off. */
export function stillLearning(cal: Calibration, type: TaskType, route: 'main' | 'delegate', tier: Tier): boolean {
  // The key for the task type on the model (the middle key of routeKeys): its run count is what the estimate stands on.
  const key = routeKeys(type, route, tier, 'low')[1] as string
  return (cal[key]?.n ?? 0) < CAL_FULL
}

// ---- Words ---------------------------------------------------------------------------

/** What the amounts are written in: dollars, or on a subscription a share of the 5-hour window once runs show the rate. */
export type Units = { subscription: boolean; rates?: { low: number; high: number } }

/** One amount: "$3.44"; on a subscription "~12%" of the window, or "$3.44 API-equivalent" until runs show the rate. */
export function amountText(usd: number, u: Units): string {
  if (!u.subscription) return money(usd)
  if (!u.rates) return `${money(usd)} API-equivalent`
  return `${bandShareText(shareOf(usd, u.rates))} of your 5-hour window`
}

/** A range: "$1.20–$3.40"; on a subscription "~10–25% of your 5-hour window", or the dollars labelled API-equivalent. */
export function rangeText(lo: number, hi: number, u: Units): string {
  if (u.subscription && u.rates) {
    const s: Share = { lo: shareOf(lo, u.rates).lo, hi: shareOf(hi, u.rates).hi }
    return `${bandShareText(s)} of your 5-hour window`
  }
  const a = money(lo)
  const b = money(hi)
  const dollars = a === b ? a : `${a}–${b}`
  return u.subscription ? `${dollars} API-equivalent` : dollars
}

/** The before-the-prompt warning. */
export function headsUpText(o: { lo: number; hi: number; top: number; learning: boolean }, u: Units): string {
  return `Heads-up: this looks like a long turn, about ${rangeText(o.lo, o.hi, u)} (your top 1% start at ${amountText(o.top, u)}).${o.learning ? ' (still learning your work)' : ''}`
}

/**
 * The during-turn warning: the range, what the turn has spent so far (worded like the range), what Finish up does and how to stop the
 * turn now: Esc in the terminal, the Stop button on the desktop app.
 */
export function duringText(o: { lo: number; hi: number; spent: number; desktop: boolean }, u: Units): string {
  return `Turn estimate ${rangeText(o.lo, o.hi, u)} (${rangeText(o.spent, o.spent, u)} spent so far). Finish up drafts a message to end this turn; ${o.desktop ? 'click Stop to stop it now' : 'Esc stops it now'}.`
}

/** The opt-in question. */
export function optInText(cost: number, u: Units): string {
  return `That turn cost ~${amountText(cost, u)}, more than 99% of your turns. Warn you before a prompt that looks this expensive?`
}

/** The sentence every amount choice carries. */
export const FALSE_ALARM_NOTE = 'rightsize learns as you go: early warnings can be false alarms.'

/** After Finish up filled the box: how to send it. The desktop app has a Send now button, the terminal Ctrl+Enter. */
export function draftedText(desktop: boolean): string {
  return desktop
    ? 'The message is in your prompt box. Click Send now to send it at once, or press Enter to send it after the current step.'
    : 'The message is in your prompt box. Send it now with Ctrl+Enter, or press Enter to send it after the current step.'
}

/** After Finish up could not fill the box. */
export const typeItYourself = (): string => `Could not fill your prompt box. Type it yourself: ${FINISH_UP_TEXT}`
