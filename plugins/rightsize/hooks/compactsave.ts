// Measured compact savings (P-85, ADR 0098).
//
// A compact's saving is its whole effect: every later main request in the same session reads (or, after a cold return, writes)
// fewer tokens. saved = Σ (tokens cut × the price that request really paid for them) − the compact's own cost. Counting stops
// at the first of: the uncompacted chat would have reached Claude Code's auto-compact (it would have been compacted anyway),
// the next compact, the session's end. A new session never adds to an earlier compact. The figure is a running one ("so far").
// It counts as if the chat went the same way without the compact; lost detail or rework is not priced.

import { COMPACT_SUMMARY_TOKENS, atPrompt, dollars, contextOf, type Prices, type Usage } from './cost'
export { compactCost, compactSaving } from './cost'
import type { RightsizeTier as Tier } from '../types'


/** A compact followed by the session's end within this many requests "started fresh": the person moved on, the compact was not needed. */
export const FRESH_MAX = 3

/** Summaries kept to learn the summary size from, and how many must be logged before the learned size replaces the default. */
export const SUMMARY_LAST = 10
export const SUMMARY_MIN = 3

/** Where a compact came from: rightsize's buttons and advice, the tip on Sonnet, the person's own /compact, or Claude Code's auto-compact. */
export type CompactSource = 'button' | 'limit' | 'tip' | 'keepwarm' | 'manual' | 'auto'
export type CompactStop = 'auto-compact point' | 'next compact' | 'session end'

/** One compact being measured. `cost` undefined: its usage could not be read, so it saves nothing in the report. */
export type CompactTrack = {
  id: string
  at: number
  source: CompactSource
  tier: Tier
  before: number
  /** The context of the first request after the compact: the summary plus what is always sent. */
  after?: number
  cut: number
  cost?: number
  gain: number
  requests: number
  /** The auto-compact point in tokens: the uncompacted chat would have been compacted there anyway. */
  limit: number
  stop?: CompactStop
}

export function startCompact(o: { id: string; at: number; source: CompactSource; tier: Tier; before: number; cost?: number; limit: number }): CompactTrack {
  return { id: o.id, at: o.at, source: o.source, tier: o.tier, before: o.before, cut: 0, gain: 0, requests: 0, limit: o.limit, ...(o.cost === undefined ? {} : { cost: o.cost }) }
}

/** One later main request: the first sets `after` and the tokens cut; each adds the cut tokens at the price it paid (cache write if it wrote most of its context, else cache read). */
export function stepCompact(t: CompactTrack, u: Usage, prices: Prices): CompactTrack {
  if (t.stop) return t
  const ctx = contextOf(u)
  const after = t.after ?? ctx
  const cut = t.after === undefined ? Math.max(0, t.before - ctx) : t.cut
  // A chat already at or past the point (the limit is a guess, or the person compacted late): there is no such stop, count to the next compact or the end.
  if (t.before < t.limit && t.before + (ctx - after) >= t.limit) return { ...t, after, cut, stop: 'auto-compact point' }
  const p = atPrompt(prices[t.tier], ctx)
  const coldReq = u.cache_creation_input_tokens > 0.5 * ctx
  const gain = t.gain + dollars(p, coldReq ? { cacheWrite: cut } : { cacheRead: cut })
  return { ...t, after, cut, gain, requests: t.requests + 1 }
}

/** The compact's figures as the log keeps them. `saved` is the gain less the cost, 0 when the cost is unknown. */
export function finishCompact(t: CompactTrack, stop?: CompactStop) {
  const end = t.stop ?? stop
  const saved = t.cost === undefined ? 0 : Math.round((t.gain - t.cost) * 1e6) / 1e6
  return { ...t, ...(end ? { stop: end } : {}), saved, startedFresh: end === 'session end' && t.requests <= FRESH_MAX }
}

/** The summary sizes (`ctxAfter`) of the logged compacts, oldest first: the latest 'compactSaved' line of each compact. */
export function loggedSummaries(lines: readonly { kind?: string; compactId?: string; ctxAfter?: number }[]) {
  const m = new Map<string, number | undefined>()
  for (const l of lines) if (l.kind === 'compactSaved' && l.compactId) m.set(l.compactId, l.ctxAfter ?? m.get(l.compactId))
  return [...m.values()].filter((n): n is number => typeof n === 'number')
}

/** The summary size for estimates: the median of the last SUMMARY_LAST logged, the default until SUMMARY_MIN are logged. */
export function learnedSummary(logged: readonly number[]) {
  const last = logged.filter(n => n > 0).slice(-SUMMARY_LAST)
  if (last.length < SUMMARY_MIN) return COMPACT_SUMMARY_TOKENS
  const s = [...last].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2)
}
