// Reads trim's savings files (trim ADR 0012, v1), read only. Pure: the text of the log and of the totals file in, sums out.
// A missing or damaged file counts for nothing; a line whose version is not 1 is ignored.

export const TRIM_FEATURES = ['output_cap', 'tool_cleanup', 'repeat_reads', 'browser_scale'] as const

export type TrimSum = { saves: number; tokens: number; assumed: boolean }
export type TrimSums = Record<string, TrimSum>
export type TrimSavings = { allTime: TrimSums; last30: TrimSums; session: TrimSums }

const DAY = 24 * 60 * 60 * 1000

function add(sums: TrimSums, feature: string, saves: number, tokens: number, assumed: boolean) {
  const s = (sums[feature] ??= { saves: 0, tokens: 0, assumed: false })
  s.saves += saves
  s.tokens += tokens
  s.assumed = s.assumed || assumed
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** The totals file: per UTC day and feature, and `through` (the newest log line already folded in). */
function readTotals(text: string): { through: string; days: [number, string, { saves: number; tokens: number; assumed: boolean }][] } {
  try {
    const t = JSON.parse(text) as { v?: unknown; through?: unknown; days?: unknown }
    if (!t || typeof t !== 'object' || t.v !== 1 || !t.days || typeof t.days !== 'object') return { through: '', days: [] }
    const days: [number, string, { saves: number; tokens: number; assumed: boolean }][] = []
    for (const [day, by] of Object.entries(t.days as Record<string, unknown>)) {
      const start = Date.parse(`${day}T00:00:00Z`)
      if (!Number.isFinite(start) || !by || typeof by !== 'object') continue
      for (const [feature, row] of Object.entries(by as Record<string, unknown>)) {
        const r = row as { saves?: unknown; tokens_saved?: unknown; assumed?: unknown }
        const tokens = num(r?.tokens_saved)
        if (tokens === undefined) continue
        days.push([start, feature, { saves: num(r.saves) ?? 0, tokens, assumed: r.assumed === true }])
      }
    }
    return { through: typeof t.through === 'string' ? t.through : '', days }
  } catch {
    return { through: '', days: [] }
  }
}

/**
 * Sums per feature: all time (the totals file plus the log lines newer than its `through`), the last 30 days, and this
 * session (from the log; command output caps log no session). Undefined when there is nothing to show.
 */
export function readTrimSavings(logText: string, totalsText: string, now: number, session: string): TrimSavings | undefined {
  const out: TrimSavings = { allTime: {}, last30: {}, session: {} }
  const totals = readTotals(totalsText)
  for (const [start, feature, r] of totals.days) {
    add(out.allTime, feature, r.saves, r.tokens, r.assumed)
    // A day's totals end 24 hours after it starts.
    if ((now - (start + DAY)) / DAY <= 30) add(out.last30, feature, r.saves, r.tokens, r.assumed)
  }
  for (const line of logText.split('\n')) {
    if (!line.trim()) continue
    let e: { v?: unknown; ts?: unknown; session?: unknown; feature?: unknown; tokens_saved?: unknown; assumed?: unknown }
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    const tokens = num(e?.tokens_saved)
    if (!e || e.v !== 1 || typeof e.ts !== 'string' || typeof e.feature !== 'string' || tokens === undefined) continue
    const at = Date.parse(e.ts)
    if (!Number.isFinite(at)) continue
    const assumed = e.assumed === true
    if (typeof e.session === 'string' && session && e.session === session) add(out.session, e.feature, 1, tokens, assumed)
    if (e.ts <= totals.through) continue
    add(out.allTime, e.feature, 1, tokens, assumed)
    if (now - at <= 30 * DAY) add(out.last30, e.feature, 1, tokens, assumed)
  }
  return Object.keys(out.allTime).length || Object.keys(out.session).length ? out : undefined
}
