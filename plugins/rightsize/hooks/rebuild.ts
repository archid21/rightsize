// Cache rebuilds by cause (P-35, ADR 0083). Claude Code names the cause of a cache miss only to status-line scripts
// (`prompt_cache.miss_causes`), not to mods, so rightsize finds rebuilds itself from each main request's cache tokens, with
// Claude Code's own rule, and names the cause from what it already knows: a compact, a model switch, an effort switch, a gap
// past the cache life. Pure functions here; the run log gets one 'rebuild' line per rebuild, and report details sums them.

/** Claude Code's miss rule: a request re-read at least this many fewer tokens than the cache held... */
export const REBUILD_MIN = 2000
/** ...and more than this share of them. */
export const REBUILD_SHARE = 0.05

/**
 * 'compact': a compact (or Claude's idle compact) replaced the conversation just before; expected, not waste.
 * 'model': the model changed since the last request; a model's cache is its own.
 * 'gap': more time passed since the cache was last refreshed than the cache life.
 * 'effort': the effort changed since the last request, with no other cause.
 * 'other': none of these (a tool or system prompt change, or the server dropped the cache).
 */
export type RebuildCause = 'compact' | 'model' | 'gap' | 'effort' | 'other'
export const REBUILD_CAUSES: readonly RebuildCause[] = ['gap', 'model', 'effort', 'other', 'compact']

/**
 * The tokens a request wrote again that the cache held: `held` is the last request's conversation (its input, cache read and
 * cache write), `read` this request's cache read. 0 when it is not a rebuild by Claude Code's rule.
 */
export function rebuildTokens(held: number, read: number) {
  if (!(held > 0) || !(read >= 0)) return 0
  const short = held - read
  return short >= REBUILD_MIN && short > held * REBUILD_SHARE ? short : 0
}

export type RebuildFacts = {
  /** A compact replaced the conversation since the last request. */
  compacted: boolean
  /** The last request's model and this one's. */
  fromModel?: string
  toModel?: string
  /** The last request's effort and this one's, when known. */
  fromEffort?: string
  toEffort?: string
  /** Ms since the cache was last refreshed (the last request, or a keep-warm request after it). */
  gapMs: number
  /** The cache life, in ms. */
  ttlMs: number
}

/** The likely cause, first match: compact, model, gap, effort, other. */
export function rebuildCause(f: RebuildFacts): RebuildCause {
  if (f.compacted) return 'compact'
  if (f.fromModel && f.toModel && f.fromModel !== f.toModel) return 'model'
  if (f.ttlMs > 0 && f.gapMs > f.ttlMs) return 'gap'
  if (f.fromEffort && f.toEffort && f.fromEffort !== f.toEffort) return 'effort'
  return 'other'
}

/** The report's name for each cause. */
export const CAUSE_NAME: Record<RebuildCause, string> = {
  gap: 'Back after the cache expired',
  model: 'Model switch',
  effort: 'Effort switch',
  other: 'Other (tools, system prompt, server)',
  compact: 'After a compact (expected)',
}

type Line = { kind?: string; cause?: string; tokens?: number; rebuildCost?: number; ours?: boolean }

export type RebuildRow = { cause: RebuildCause; count: number; tokens: number; cost: number; ours: number }

/** Sums 'rebuild' lines by cause, most costly first, the expected compact row last. Empty when there are none. */
export function rebuildSums(lines: readonly Line[]): RebuildRow[] {
  const by = new Map<RebuildCause, RebuildRow>()
  for (const l of lines) {
    if (l.kind !== 'rebuild') continue
    const cause = (REBUILD_CAUSES as readonly string[]).includes(l.cause ?? '') ? (l.cause as RebuildCause) : 'other'
    const r = by.get(cause) ?? { cause, count: 0, tokens: 0, cost: 0, ours: 0 }
    r.count += 1
    r.tokens += Number.isFinite(l.tokens) ? (l.tokens as number) : 0
    r.cost += Number.isFinite(l.rebuildCost) ? (l.rebuildCost as number) : 0
    if (l.ours) r.ours += 1
    by.set(cause, r)
  }
  const rows = [...by.values()]
  return [...rows.filter(r => r.cause !== 'compact').sort((a, b) => b.cost - a.cost || b.tokens - a.tokens), ...rows.filter(r => r.cause === 'compact')]
}
