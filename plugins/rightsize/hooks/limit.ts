import { MAX_USED, type Limit, money } from './cost'
import { bandShareText, shareOf } from './report'
import { clockText } from './warm'

// The "compact before the usage limit" advice on the band: near the 5-hour limit, with a big conversation and a reset far
// enough off for the cache to go cold, a compaction now (the cache is warm) leaves a short summary to read after the reset
// instead of the whole conversation. This file is the pure part: when the advice is due, its words and its button ids.
// register.tsx reads the usage, draws the row and runs the compaction, and only when the person presses the button.

/** The advice needs more than this many tokens of conversation: under it a compaction saves too little to bother with. */
export const LIMIT_MIN_CONTEXT = 30_000

/** What a compaction started from the advice is told to keep and drop. */
export const LIMIT_COMPACT_INSTRUCTIONS =
  'Keep the current task, the decisions made, open questions, file paths and next steps. Drop tool output and dead ends.'

/** What the row's ⋯ menu says under "Why?". */
export const LIMIT_WHY =
  'After the reset the whole conversation is read again at full price. A compact now, while the cache is warm, leaves a short summary instead.'

/** The row's button and ⋯ entries, with the ids `pressLimit` answers. */
export const LIMIT_COMPACT = 'limit-compact'
export const LIMIT_WHY_ID = 'limit-why'
export const LIMIT_HIDE = 'limit-hide'
export const LIMIT_BUTTON = { id: LIMIT_COMPACT, label: 'Compact now' }
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
