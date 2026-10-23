import { money } from './cost'

// /rightsize report: what the mod saved, what it cost to run, and what went
// wrong, read from its run log. Pure functions, no engine calls.
//
// A saving is an estimate. Staying would have cost what the turn really cost,
// scaled by the ratio of the two routes' estimates (staying at the person's own
// level and model vs the route taken), so the estimates' own error cancels out.

export type Change = 'none' | 'lower' | 'raise' | 'delegate-up' | 'delegate-down'
/** Rate-limit windows as percent used: `five_hour`, `seven_day`, `spend_limit`. */
export type Windows = Record<string, number>

/** One line of rightsize-runs.jsonl. Lines from before 0.5 lack the newer fields. */
export type RunLine = {
  at: string
  /** 'overhead': a rating call that came to nothing (failed or unreadable). */
  kind?: 'run' | 'overhead'
  session?: string
  type?: string
  route?: string
  change?: Change
  /** What the plan suggested; differs from `change` when the person kept their level. */
  offered?: Change
  steppedUp?: boolean
  aborted?: boolean
  /** Calibrated estimates: of the route taken, and of staying at the person's own level and model. */
  taken?: number
  stay?: number
  actual?: number
  /** The rating call's cost. */
  overhead?: number
  /** What effort-switch cache misses cost. */
  missCost?: number
  /** Subagent calls (Agent and SendMessage) on the main thread: more than one on a hand-off is rework. */
  agentCalls?: number
  durationMs?: number
  before?: Windows
  after?: Windows
}

export type SwitchLine = { at: string; kept?: boolean }

const DAY = 24 * 60 * 60 * 1000

export function parseLines<T>(text: string): T[] {
  const out: T[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const v = JSON.parse(line) as unknown
      if (v && typeof v === 'object' && typeof (v as { at?: unknown }).at === 'string') out.push(v as T)
    } catch {
      // A torn line (the log is trimmed from the front) is skipped.
    }
  }
  return out
}

const isRun = (l: RunLine) => (l.kind ?? 'run') === 'run'
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const SAVING: readonly Change[] = ['lower', 'delegate-down']
const SPENDING: readonly Change[] = ['raise', 'delegate-up']
const delegated = (l: RunLine) => (l.route ?? '').startsWith('delegate:')

/** What staying would have cost, by the estimate; the actual cost where there is nothing to compare. */
export function counterfactual(l: RunLine) {
  const actual = num(l.actual)
  if (l.steppedUp || !l.taken || !l.stay || l.change === undefined || l.change === 'none') return actual
  return (actual * l.stay) / l.taken
}

type Totals = {
  rated: number
  changed: Record<Change, number>
  declined: number
  saved: number
  extra: number
  overhead: number
  spent: number
}

export function totals(lines: readonly RunLine[]): Totals {
  const t: Totals = {
    rated: 0,
    changed: { none: 0, lower: 0, raise: 0, 'delegate-up': 0, 'delegate-down': 0 },
    declined: 0,
    saved: 0,
    extra: 0,
    overhead: 0,
    spent: 0,
  }
  for (const l of lines) {
    t.overhead += num(l.overhead)
    if (!isRun(l)) continue
    t.rated += 1
    const c = l.change ?? 'none'
    t.changed[c] += 1
    if (c === 'none' && l.offered && l.offered !== 'none') t.declined += 1
    if (l.aborted) continue
    t.spent += num(l.actual)
    const diff = counterfactual(l) - num(l.actual)
    if (SAVING.includes(c)) t.saved += diff
    else if (SPENDING.includes(c)) t.extra -= diff
  }
  return t
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

function changedLine(t: Totals) {
  const c = t.changed
  const n = t.rated - c.none
  const parts = [
    c.lower && `${c.lower} lowered`,
    c.raise && `${c.raise} raised`,
    c['delegate-down'] && `${c['delegate-down']} sent to a cheaper model`,
    c['delegate-up'] && `${c['delegate-up']} sent to a stronger model`,
  ].filter(Boolean)
  const declined = t.declined ? ` You kept your level on ${plural(t.declined, 'suggestion')}.` : ''
  return `${plural(t.rated, 'prompt')} rated, ${n} changed${parts.length ? ` (${parts.join(', ')})` : ''}.${declined}`
}

function savedLine(t: Totals) {
  const net = t.saved - t.overhead
  const rating = `${money(t.overhead)} of rating calls`
  const extra = t.extra > 0.005 ? ` Raising effort and stronger models: ${money(t.extra)} more, for harder work.` : ''
  if (net >= 0.005) {
    const pct = Math.round((net / (t.spent + t.overhead + net)) * 100)
    return `Saved ~${money(net)} (~${pct}% of what these turns would have cost) after ${rating}.${extra}`
  }
  if (net <= -0.005) return `Cost ~${money(-net)} more than it saved, counting ${rating}.${extra}`
  return `About even: savings and rating calls (${money(t.overhead)}) cancel out.${extra}`
}

/** Percent of a window per dollar, and per minute of turn time, over runs whose window did not reset. */
function windowRates(lines: readonly RunLine[], kind: string) {
  let pct = 0
  let usd = 0
  let ms = 0
  for (const l of lines) {
    if (!isRun(l) || l.aborted) continue
    const b = l.before?.[kind]
    const a = l.after?.[kind]
    if (b === undefined || a === undefined || a < b) continue
    pct += a - b
    usd += num(l.actual)
    ms += num(l.durationMs)
  }
  if (pct <= 0 || usd <= 0) return undefined
  return { perDollar: pct / usd, perMinute: ms > 0 ? pct / (ms / 60000) : undefined }
}

function windowLine(lines: readonly RunLine[], t: Totals) {
  const net = t.saved - t.overhead
  const five = windowRates(lines, 'five_hour')
  // Matches the money line: "about even" there gets no window line.
  if (!five || Math.abs(net) < 0.005) return undefined
  const savedPct = net * five.perDollar
  const week = windowRates(lines, 'seven_day')
  const weekPart = week ? ` and ~${(net * week.perDollar).toFixed(1)}% of your 7-day window` : ''
  if (savedPct >= 0.05) {
    const mins = five.perMinute ? Math.round(savedPct / five.perMinute) : 0
    const time = mins >= 1 ? `, about ${plural(mins, 'more minute')} at this pace` : ''
    return `Kept ~${savedPct.toFixed(1)}% of your 5-hour window${time}${weekPart}.`
  }
  if (savedPct <= -0.05) return `Used ~${(-savedPct).toFixed(1)}% more of your 5-hour window than staying would have.`
  return undefined
}

function period(title: string, lines: readonly RunLine[], subscription: boolean) {
  const t = totals(lines)
  if (!t.rated && !t.overhead) return [`${title}: nothing rated yet.`]
  const out = [`${title}: ${changedLine(t)}`, `  ${savedLine(t)}`]
  const w = subscription ? windowLine(lines, t) : undefined
  if (w) out.push(`  ${w}`)
  return out
}

/** How far estimates were from what turns cost: the mean of max(actual/estimate, estimate/actual). */
function offBy(lines: readonly RunLine[]) {
  const xs = lines.map(l => (num(l.actual) > 0 && num(l.taken) > 0 ? Math.max(num(l.actual) / num(l.taken), num(l.taken) / num(l.actual)) : 0)).filter(x => x > 0)
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
}

export function wentWrong(lines: readonly RunLine[], switches: readonly SwitchLine[]) {
  const runs = lines.filter(l => isRun(l) && !l.aborted)
  const out: string[] = []
  const steppedUp = runs.filter(l => l.steppedUp).length
  if (steppedUp) out.push(`${plural(steppedUp, 'lowered turn')} stepped back up: the task was harder than rated. No saving is counted for them.`)
  const dearer = runs.filter(l => delegated(l) && num(l.stay) > 0 && num(l.actual) > num(l.stay))
  if (dearer.length) {
    const a = dearer.reduce((s, l) => s + num(l.actual), 0)
    const st = dearer.reduce((s, l) => s + num(l.stay), 0)
    out.push(`${plural(dearer.length, 'hand-off')} cost more than staying would have: ${money(a)} vs ~${money(st)}.`)
  }
  const rework = runs.filter(l => delegated(l) && num(l.agentCalls) > 1).length
  if (rework) out.push(`${plural(rework, 'hand-off')} needed rework (more than one subagent call).`)
  const skipped = runs.filter(l => (l.change === 'delegate-up' || l.change === 'delegate-down') && !delegated(l)).length
  if (skipped) out.push(`Claude skipped ${plural(skipped, 'hand-off')} you chose and did the work itself.`)
  const missed = switches.filter(s => s.kept === false).length
  if (missed) {
    const cost = runs.reduce((s, l) => s + num(l.missCost), 0)
    out.push(`${missed} of ${plural(switches.length, 'effort switch', 'effort switches')} missed the cache${cost >= 0.005 ? ` (~${money(cost)})` : ''}.`)
  }
  const aborted = lines.filter(l => isRun(l) && l.aborted).length
  if (aborted) out.push(`${plural(aborted, 'turn')} you stopped: their rating cost counts, no saving does.`)
  const measured = runs.filter(l => num(l.actual) > 0 && num(l.taken) > 0)
  if (measured.length >= 6) {
    const n = Math.min(10, Math.floor(measured.length / 2))
    const first = offBy(measured.slice(0, n))
    const lastN = offBy(measured.slice(-n))
    out.push(`Estimates were off by ${first.toFixed(1)}x on average in the first ${n} runs, ${lastN.toFixed(1)}x in the last ${n}${lastN < first ? ': calibration is closing the gap' : ''}.`)
  }
  return out
}

export function buildReport(
  lines: readonly RunLine[],
  switches: readonly SwitchLine[],
  opts: { now: number; session: string; subscription: boolean },
) {
  const since = (days: number) => (l: { at: string }) => opts.now - Date.parse(l.at) <= days * DAY
  const month = lines.filter(since(30))
  const out = [
    'Rightsize report. Savings are estimated: what staying at your own level and model would have cost, scaled by what each turn really cost.',
    '',
    ...period('This session', lines.filter(l => opts.session !== '' && l.session === opts.session), opts.subscription),
    ...period('Last 7 days', lines.filter(since(7)), opts.subscription),
    ...period('Last 30 days', month, opts.subscription),
    '',
  ]
  const wrong = wentWrong(month, switches.filter(since(30)))
  out.push('What went wrong (last 30 days):', ...(wrong.length ? wrong.map(w => `- ${w}`) : ['- Nothing yet.']))
  return out.join('\n')
}
