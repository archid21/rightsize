import type { RightsizeLevel as Level, RightsizeTier as Tier } from '../types'
import { MAX_USED, PACE_FROM, TIER_NAME, type Limit, money } from './cost'
import { bandShareText, shareOf } from './report'
import { clock12, clockText } from './warm'

export { clock12 }

// The "compact before the usage limit" advice on the band: near the 5-hour limit, with a big conversation and a reset far
// enough off for the cache to go cold, a compaction now (the cache is warm) leaves a short summary to read after the reset
// instead of the whole conversation. This file is the pure part: when the advice is due, its words and its button ids.
// register.tsx reads the usage, draws the row and runs the compaction, and only when the person presses the button.

/** The advice needs more than this many tokens of conversation: under it a compaction saves too little to bother with. */
export const LIMIT_MIN_CONTEXT = 30_000

/** What the row's ⋯ menu says under "Why?". */
export const LIMIT_WHY =
  'After the reset the whole conversation is read again at full price. A compact now, while the cache is warm, leaves a short summary instead.'

/** The row's button and ⋯ entries, with the ids `pressLimit` answers. */
export const LIMIT_COMPACT = 'limit-compact'
export const LIMIT_WHY_ID = 'limit-why'
export const LIMIT_HIDE = 'limit-hide'
export const LIMIT_BUTTON = { id: LIMIT_COMPACT, label: 'Compact Now' }
export const LIMIT_MORE: readonly { id: string; label: string }[] = [
  { id: LIMIT_WHY_ID, label: 'Why?' },
  { id: LIMIT_HIDE, label: "Don't show again" },
]
export const isLimitId = (id: string) => id === LIMIT_COMPACT || id === LIMIT_WHY_ID || id === LIMIT_HIDE

/**
 * The 5-hour window the advice is about, or undefined when none is due: it is used up to MAX_USED or more, the conversation
 * is over LIMIT_MIN_CONTEXT tokens, and its reset is further off than the cache lives (`ttl`): a shorter wait keeps the cache
 * warm, so there is nothing to save. The saving itself (limitSaving) is checked by the caller.
 */
export function limitDue(limits: readonly Limit[], context: number | undefined, now: number, ttl: number) {
  if (typeof context !== 'number' || !Number.isFinite(context) || context <= LIMIT_MIN_CONTEXT) return undefined
  const w = limits.find(l => l.kind === 'five_hour')
  if (!w || !(w.percentUsed >= MAX_USED) || !w.resetsAt) return undefined
  const resetAt = Date.parse(w.resetsAt)
  if (!Number.isFinite(resetAt) || resetAt - now <= ttl) return undefined
  return { resetsAt: w.resetsAt, resetAt }
}

/**
 * The row's line: "Near your 5-hour limit, resets 21:40. Compact now to save ~$0.31 after the reset." On a subscription the
 * saving is the share of the next window ("~3% of your next window") once runs show the rate, else the dollars, labelled
 * API-equivalent. Undefined when there is no saving (0, or not a number).
 */
export function limitText(resetAt: number, saving: number, subscription: boolean, rates: { low: number; high: number } | undefined) {
  if (!Number.isFinite(saving) || saving <= 0) return undefined
  const dollars = money(saving)
  const amount = dollars.startsWith('under') ? dollars : `~${dollars}`
  const what =
    !subscription ? `${amount} after the reset` : rates ? `${bandShareText(shareOf(saving, rates))} of your next window` : `${amount} API-equivalent after the reset`
  return `Near your 5-hour limit, resets ${clockText(resetAt)}. Compact now to save ${what}.`
}

/**
 * The question's line when Compact asks (ADR 0094): "Compact now to save ~$0.59 after reset?". On a subscription the saving is the share
 * of the next window once runs show the rate, else the dollars, labelled API-equivalent. Undefined when there is no saving.
 */
export function limitAskText(saving: number, subscription: boolean, rates: { low: number; high: number } | undefined) {
  if (!Number.isFinite(saving) || saving <= 0) return undefined
  const dollars = money(saving)
  const amount = dollars.startsWith('under') ? dollars : `~${dollars}`
  const what = !subscription ? amount : rates ? `${bandShareText(shareOf(saving, rates))} of your next window` : `${amount} API-equivalent`
  return `Compact now to save ${what} after reset?`
}

// ---- The status line (P-9) ---------------------------------------------------------------------------------
// At most "Sonnet (M) · limit ~3:45 PM" or "Sonnet (M) · $1.84 session": the model with its effort as a letter, then
// the limit part (only when on pace to run out before the reset) or, on API billing, the session cost. The cache stays
// on the band, never here.

const LETTER: Record<Level, string> = { low: 'L', medium: 'M', high: 'H', xhigh: 'XH', max: 'Max' }

/** "M", "H↑" when rightsize raised it, "L auto" when rightsize picked it. */
export const effortTag = (level: Level, how?: 'raised' | 'auto') => `${LETTER[level]}${how === 'raised' ? '↑' : how === 'auto' ? ' auto' : ''}`

/** "Sonnet (M)"; "(M)" when the model is not known. */
export const modelTag = (tier: Tier | undefined, tag: string) => (tier ? `${TIER_NAME[tier]} (${tag})` : `(${tag})`)

const WINDOW_LEN = { five_hour: 5 * 3600_000, seven_day: 7 * 24 * 3600_000 } as const
const QUARTER = 15 * 60_000
/** The limit part shows only when the limit is hit at least this long before the reset, so a borderline pace does not flicker. */
export const LIMIT_MARGIN = QUARTER

/**
 * When the first window runs out at its average rate since it started, rounded to 15 minutes; undefined when no window
 * runs out at least LIMIT_MARGIN before its reset, in the first PACE_FROM of a window (too little to judge), or past MAX_USED
 * (the band says so instead).
 */
export function limitHit(limits: readonly Limit[], now: number) {
  let first: number | undefined
  for (const l of limits) {
    if (l.kind !== 'five_hour' && l.kind !== 'seven_day') continue
    const reset = l.resetsAt ? Date.parse(l.resetsAt) : NaN
    if (!Number.isFinite(reset) || !(l.percentUsed > 0) || l.percentUsed >= MAX_USED) continue
    const start = reset - WINDOW_LEN[l.kind]
    const gone = now - start
    if (gone < PACE_FROM * WINDOW_LEN[l.kind] || reset <= now) continue
    const hit = start + (gone * 100) / l.percentUsed
    if (hit > reset - LIMIT_MARGIN) continue
    if (first === undefined || hit < first) first = hit
  }
  return first === undefined ? undefined : Math.round(first / QUARTER) * QUARTER
}

/** The status line: the model part, then "limit ~3:45 PM" when due, else "$1.84 session" on API billing. */
export function statusLine(model: string, o: { limits: readonly Limit[]; now: number; api: boolean; cost?: number; total?: string }) {
  const hit = limitHit(o.limits, o.now)
  const extra = hit !== undefined ? `limit ~${clock12(hit)}` : o.api && typeof o.cost === 'number' && o.cost >= 0.01 ? `${money(o.cost)} session` : ''
  return [model, extra, o.total].filter(Boolean).join(' · ')
}
