import type { RightsizeTier as Tier } from '../types'
import { COMPACT_SUMMARY_TOKENS, TIER_NAME, type Prices, atPrompt, compactSaving, dollars } from './cost'

// The cold-compact tip (P-47, ADR 0081): a mod cannot send a compaction to another model, and `/model` saves the person's
// default, so rightsize cannot compact on Sonnet by itself. When the cache has gone cold on a big Opus or Fable conversation,
// the band walks the person through it: /model sonnet, /compact, /model default (which puts the usual model back and saves
// no default). Each button puts the next command in the prompt box; the person sends it. This file is the pure part.

/** The models whose cold compaction costs enough more than Sonnet's to be worth the steps. */
export const TIP_TIERS: readonly Tier[] = ['opus', 'fable']
export const TIP_TO: Tier = 'sonnet'
export const TIP_STEPS = ['/model sonnet', '/compact', '/model default'] as const

/**
 * What compacting on Sonnet first saves on the next prompt: the whole conversation written to the cache on `tier`, less
 * [the compaction on Sonnet (the conversation read uncached, the summary written as output) and the summary written to the
 * cache on `tier`]. Never below 0.
 */
export function tipSaving(prices: Prices, tier: Tier, context: number, summary = COMPACT_SUMMARY_TOKENS) {
  // The cache is cold and the compaction runs on Sonnet (P-85: the one estimate formula).
  return compactSaving(prices, tier, context, { by: TIP_TO, warm: false, summary })
}

/**
 * Whether the tip is due: an Opus or Fable session whose conversation fits Sonnet's window, and a saving of at least `min`
 * (the Idle warning amount). Returns the saving, or undefined.
 */
export function tipDue(prices: Prices, tier: Tier, context: number, min: number, summary = COMPACT_SUMMARY_TOKENS) {
  if (!TIP_TIERS.includes(tier) || !(context > 0)) return undefined
  const w = prices[TIP_TO].window
  if (w !== undefined && context > w) return undefined
  const saving = tipSaving(prices, tier, context, summary)
  return saving >= min ? saving : undefined
}

/** Step 0 is the offer; 1 to 3 the command just put in the box; 4 done. */
export type TipStep = 0 | 1 | 2 | 3 | 4

/** The row's line for each step. `cost` is the saving as the band words it ("~$0.45", or a share of the window). */
export function tipText(step: TipStep, cost: string) {
  if (step === 0) return `Cache is cold. Compact on Sonnet first to save ${cost} on your next prompt.`
  if (step === 4) return `Done: compacted on Sonnet, back on your usual model. Saved ${cost}.`
  if (step === 2) return `Step 2 of 3: press Enter to send /compact (it is in your prompt box), then press Next.`
  return `Step ${step} of 3: press Enter to send ${TIP_STEPS[step - 1]} (it is in your prompt box).`
}

/** The command the person sends at `step` (1 to 3); the tip moves on when it sees it. */
export const tipCommandAt = (text: string): TipStep | undefined => {
  const t = text.trim().replace(/\s+/g, ' ').toLowerCase()
  const i = TIP_STEPS.findIndex(c => t === c)
  return i < 0 ? undefined : ((i + 1) as TipStep)
}

/** Shown when the person sends a prompt while the tip left them on Sonnet. */
export const TIP_STILL_SONNET = 'You are still on Sonnet: /model default puts your usual model back.'

export const TIP_WHY = (tokens: number, tier: Tier) =>
  `Your next prompt reads the whole conversation (~${Math.round(tokens / 1000)}K tokens) again at full price. A compact on Sonnet costs less, and then ${TIER_NAME[tier]} reads only a short summary. A compact keeps a summary, not every detail. /model default puts your usual model back and saves nothing.`

/** Button and ⋯ ids. */
export const TIP_START = 'tip-start'
export const TIP_FILL = 'tip-fill'
export const TIP_NEXT = 'tip-next'
export const TIP_WHY_ID = 'tip-why'
export const TIP_HIDE = 'tip-hide'
export const isTipId = (id: string) => id === TIP_START || id === TIP_FILL || id === TIP_NEXT || id === TIP_WHY_ID || id === TIP_HIDE
