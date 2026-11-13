import { money } from './cost'
import type { RunLine } from './report'
import type { SettingKey } from './settings'

// "Did it work?": for each setting you changed, your prompts after the change against your prompts before it,
// measured from the run log (rightsize ADR 0054). Pure: lines in, text rows out. No estimates: every figure is
// what the prompts really cost, took or hit.

/** One logged change: `at` (ISO, UTC), the setting's key, and the value before and after. */
export type ChangeLine = { at: string; key: string; from: string; to: string }

/** Claude Code's own setting that the cache-life advice writes (P-16): tracked like a rightsize row, so Did it work? measures the change. */
export const CACHE_LIFE_KEY = 'promptCacheTtl'

/** Settings that change what rightsize does. Cosmetic rows (band, tips, wording, reports, price check) are not tracked. */
export const TRACKED: readonly (SettingKey | typeof CACHE_LIFE_KEY)[] = [
  'mode', 'routing', 'handOffs', 'askFirst', 'cache', 'floor', 'ceiling', 'lowerRule', 'raiseRule', 'upRule', 'downRule',
  'useHaiku', 'useFable', 'subagents', 'workflows', 'pacing', 'escalation', 'rater', 'beforeCold', 'promptCacheTtl',
]
export const isTracked = (key: string): key is SettingKey | typeof CACHE_LIFE_KEY => (TRACKED as readonly string[]).includes(key)

const DAY = 24 * 60 * 60 * 1000
/** Days of "before" tried, shortest first; and the most days of "after" used. */
export const BASELINES = [3, 5, 7, 14] as const
export const AFTER_MAX_DAYS = 14
/** What a verdict needs: days with a prompt and prompts after the change, and prompts in a baseline. */
export const MIN_DAYS = 3
export const MIN_PROMPTS = 30
export const MIN_BEFORE = 10
/** A move under this share of the before figure is within the usual swing: no clear effect. */
export const SWING = 0.1
/** A failed-test rate must rise by this many points to count as a trade-off. */
const POINTS = 0.05

export type Period = { prompts: number; days: number; cost: number; requests: number; errors: number; failed: number; tested: number; ms: number; timed: number }
export type Verdict = 'cheaper' | 'costs more' | 'not clear' | 'too early' | 'no before'
export type Row = { label: string; before: string; after: string; move: string; tradeoff: boolean }
export type Result = {
  change: ChangeLine
  verdict: Verdict
  /** Cost per prompt: lowest and highest move across the baselines that had enough prompts (negative is cheaper). */
  range?: { lo: number; hi: number }
  after: Period
  before?: Period
  baseline?: number
  rows: Row[]
  /** What this cannot tell apart: another change in the same days, a short baseline. */
  notes: string[]
  /** Too early: what is still missing. */
  need?: string
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** Prompts (run lines that ran to the end) in [from, to), summed. */
export function period(lines: readonly RunLine[], from: number, to: number): Period {
  const p: Period = { prompts: 0, days: 0, cost: 0, requests: 0, errors: 0, failed: 0, tested: 0, ms: 0, timed: 0 }
  const days = new Set<string>()
  for (const l of lines) {
    if ((l.kind ?? 'run') !== 'run' || l.aborted) continue
    const at = Date.parse(l.at)
    if (!(at >= from && at < to)) continue
    p.prompts += 1
    days.add(l.at.slice(0, 10))
    p.cost += num(l.actual)
    p.requests += num(l.requests)
    p.errors += num(l.errors)
    if (l.tests) {
      p.tested += 1
      if (l.tests === 'failed') p.failed += 1
    }
    if (typeof l.durationMs === 'number' && l.durationMs > 0) {
      p.ms += l.durationMs
      p.timed += 1
    }
  }
  p.days = days.size
  return p
}

const per = (p: Period, x: number) => (p.prompts ? x / p.prompts : 0)
const pct = (before: number, after: number) => (before > 0 ? (after - before) / before : 0)
const sign = (x: number) => `${x > 0 ? '+' : x < 0 ? '-' : ''}${Math.abs(Math.round(x * 100))}%`
const secs = (p: Period) => (p.timed ? p.ms / p.timed / 1000 : 0)
const fmtSecs = (s: number) => (s >= 90 ? `${(s / 60).toFixed(1)}m` : `${Math.round(s)}s`)

function rowsOf(before: Period, after: Period): Row[] {
  const rows: Row[] = []
  const cost = (b: number, a: number): Row => ({ label: 'cost per prompt', before: money(b), after: money(a), move: sign(pct(b, a)), tradeoff: false })
  rows.push(cost(per(before, before.cost), per(after, after.cost)))
  const ratio = (label: string, b: number, a: number): Row => ({
    label,
    before: b.toFixed(b < 10 ? 1 : 0),
    after: a.toFixed(a < 10 ? 1 : 0),
    move: sign(pct(b, a)),
    tradeoff: b > 0 ? pct(b, a) > SWING : a >= 0.5,
  })
  rows.push(ratio('requests per prompt', per(before, before.requests), per(after, after.requests)))
  rows.push(ratio('tool errors per prompt', per(before, before.errors), per(after, after.errors)))
  if (before.tested && after.tested) {
    const b = before.failed / before.tested
    const a = after.failed / after.tested
    rows.push({ label: 'tests failed', before: `${Math.round(b * 100)}%`, after: `${Math.round(a * 100)}%`, move: `${a >= b ? '+' : '-'}${Math.abs(Math.round((a - b) * 100))} pts`, tradeoff: a - b > POINTS })
  }
  if (before.timed && after.timed) rows.push(ratioTime(secs(before), secs(after)))
  return rows
}

function ratioTime(b: number, a: number): Row {
  return { label: 'time per prompt', before: fmtSecs(b), after: fmtSecs(a), move: sign(pct(b, a)), tradeoff: b > 0 && pct(b, a) > SWING }
}

/**
 * One change against the days around it. The after period runs from the change to the next tracked change (or now),
 * at most 14 days. The before period is tried at 3, 5, 7 and 14 days; those with 10 prompts or more count. Cheaper or
 * Costs more needs every counted baseline past 10% the same way; otherwise Not clear yet.
 */
export function compare(lines: readonly RunLine[], change: ChangeLine, all: readonly ChangeLine[], now: number): Result {
  const at = Date.parse(change.at)
  const next = all.map(c => Date.parse(c.at)).filter(t => t > at).sort((a, b) => a - b)[0]
  const end = Math.min(now, next ?? now, at + AFTER_MAX_DAYS * DAY)
  const after = period(lines, at, end)
  const result: Result = { change, verdict: 'too early', after, rows: [], notes: [] }
  if (after.days < MIN_DAYS || after.prompts < MIN_PROMPTS) {
    result.need = `${after.prompts} of ${MIN_PROMPTS} prompts, ${after.days} of ${MIN_DAYS} days so far`
    return result
  }
  const baselines = BASELINES.map(d => ({ d, p: period(lines, at - d * DAY, at) })).filter(b => b.p.prompts >= MIN_BEFORE)
  if (!baselines.length) {
    result.verdict = 'no before'
    return result
  }
  const moves = baselines.map(b => pct(per(b.p, b.p.cost), per(after, after.cost)))
  result.range = { lo: Math.min(...moves), hi: Math.max(...moves) }
  result.verdict = moves.every(m => m <= -SWING) ? 'cheaper' : moves.every(m => m >= SWING) ? 'costs more' : 'not clear'
  const longest = baselines[baselines.length - 1]!
  result.before = longest.p
  result.baseline = longest.d
  result.rows = rowsOf(longest.p, after)
  if (baselines.length < BASELINES.length) result.notes.push(`only ${baselines.map(b => `${b.d}`).join(', ')}-day baselines had enough prompts`)
  const near = all.filter(c => !(c.at === change.at && c.key === change.key) && Date.parse(c.at) >= at - longest.d * DAY && Date.parse(c.at) < end)
  if (near.length) result.notes.push(`${near.length === 1 ? 'another change was' : `${near.length} other changes were`} made in the same days`)
  return result
}

/** Every tracked change that has at least one run line after it, newest first, at most `limit`. Same-moment repeats are one. */
export function results(lines: readonly RunLine[], changes: readonly ChangeLine[], now: number, limit = 3): Result[] {
  const sorted = changes.filter(c => isTracked(c.key) && c.from !== c.to && Date.parse(c.at) > 0).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  return sorted
    .slice(-limit)
    .reverse()
    .map(c => compare(lines, c, sorted, now))
}

const TITLE: Record<string, string> = {
  mode: 'Mode', routing: 'Routing', handOffs: 'Hand-offs', askFirst: 'Ask before changing', cache: 'Cache', floor: 'Lowest effort', ceiling: 'Highest effort',
  lowerRule: 'Lowering', raiseRule: 'Raising', upRule: 'Stronger model', downRule: 'Cheaper model', useHaiku: 'Use Haiku', useFable: 'Use Fable',
  subagents: "Claude's subagents", workflows: 'Workflows', pacing: 'Budget pacing', escalation: 'Raise when stuck', rater: 'Rater', beforeCold: 'Before the cache goes cold', promptCacheTtl: 'Cache life',
}

/** A value as the section shows it: Claude Code's cache life in words (5m is 5 minutes), the rest as stored. */
const shown = (key: string, v: string) => (key === CACHE_LIFE_KEY ? (v === '5m' ? '5 minutes' : v === '1h' ? '1 hour' : v) : v)

const VERDICT: Record<Verdict, string> = {
  cheaper: 'Cheaper',
  'costs more': 'Costs more',
  'not clear': 'Not clear yet',
  'too early': 'Too early to tell',
  'no before': 'No days before it to compare',
}

/** The section's rows, plain text, ready to indent. Empty when no change has been made. */
export function resultRows(rs: readonly Result[]): string[] {
  const out: string[] = []
  for (const r of rs) {
    const day = r.change.at.slice(0, 10)
    out.push(`${TITLE[r.change.key] ?? r.change.key}: ${shown(r.change.key, r.change.from)} to ${shown(r.change.key, r.change.to)}, ${day}`)
    let line = VERDICT[r.verdict]
    if (r.range) {
      const lo = Math.round(r.range.lo * 100)
      const hi = Math.round(r.range.hi * 100)
      const part = (x: number) => `${Math.abs(x)}% ${x <= 0 ? 'less' : 'more'}`
      line += `: ${lo === hi ? part(lo) : `${part(lo)} to ${part(hi)}`} per prompt than the days before`
    }
    if (r.need) line += ` (${r.need})`
    out.push(`  ${line}`)
    if (r.rows.length) {
      const w = Math.max(...r.rows.map(x => x.label.length))
      out.push(`  ${''.padEnd(w)}  before  after`)
      for (const x of r.rows) out.push(`  ${x.label.padEnd(w)}  ${x.before.padStart(6)}  ${x.after.padStart(5)}  ${x.move}${x.tradeoff ? '  trade-off' : ''}`)
      out.push(`  Before: the ${r.baseline} days ahead of the change. After: ${r.after.prompts} prompts in ${r.after.days} days.`)
    }
    for (const n of r.notes) out.push(`  Note: ${n}.`)
  }
  return out
}

/** Parses changes.jsonl: a torn or foreign line is skipped. */
export function parseChanges(text: string): ChangeLine[] {
  const out: ChangeLine[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const v = JSON.parse(line) as Partial<ChangeLine>
      if (v && typeof v.at === 'string' && typeof v.key === 'string' && typeof v.from === 'string' && typeof v.to === 'string') out.push({ at: v.at, key: v.key, from: v.from, to: v.to })
    } catch {
      // A torn line (the log is trimmed from the front) is skipped.
    }
  }
  return out
}
