import { MISS_BLOCK, TIER_NAME, isTier, money } from './cost'
import { MISS_MIN, checkTotals, missRates, missTotals } from './misses'
import type { StartBlock } from './start'

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
  /**
   * 'overhead': a rating call that came to nothing (failed or unreadable). 'subagent': one of Claude's subagents moved to a cheaper model, when it answered.
   * 'check': Sonnet's second opinion on a rating. 'feedback': a 👍 or 👎 on a run. Neither counts as a rated run.
   */
  kind?: 'run' | 'overhead' | 'subagent' | 'check' | 'feedback'
  /** A run line's own id, which feedback lines name in `ref`. */
  id?: string
  session?: string
  type?: string
  route?: string
  change?: Change
  /** What the plan suggested; differs from `change` when the person kept their level. */
  offered?: Change
  steppedUp?: boolean
  /** Raised mid-turn when the turn showed it was struggling. */
  escalations?: { step: number; from: string; to: string; why: string }[]
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
  /** Main-chat steps only the person can approve (push, publish, deploy, send). */
  approvalSteps?: number
  /** Workflow calls in the turn (ultracode's fan-out). */
  workflows?: number
  /** A workflow ran in the session by this turn's end: its agents' cost may be in this turn's. */
  afterWorkflow?: boolean
  durationMs?: number
  /** A subagent line: the model it would have run on and the one it ran on, at what level, and the raw estimates on each. */
  from?: string
  tier?: string
  level?: string
  estimate?: number
  parentEstimate?: number
  /** The hand-off was a close call between two models, and how it was broken. */
  tie?: Tie
  /** Claude's subagents moved to a cheaper model this turn; each may carry a close call too. */
  resized?: { tie?: Tie }[]
  /** Main-chat requests in the turn. */
  requests?: number
  /** Tokens every request carried that the person can trim (MCP tools, memory, agents, skills), and what re-reading them cost. */
  fixed?: { tokens: number; mcp: number; memory: number; agents: number; skills: number; cost: number; servers?: Record<string, number> }
  before?: Windows
  after?: Windows
  /** The session's own level, before rightsize's change, and the conversation's size: from 0.7. */
  normal?: string
  context?: number
  /** Each model's lowest level for the work, or null where it would struggle: the rater's judgement. */
  fit?: Record<string, string | null>
  /** A check line: the second opinion, and who gave it. `fit` is then the first rater's. */
  check?: { by: string; fit: Record<string, string | null> }
  /** A feedback line: the run's `id` and the verdict. */
  ref?: string
  value?: 'up' | 'down'
}

type Tie = { by?: string; over?: string }

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
  if (l.steppedUp || l.escalations?.length || l.afterWorkflow || !l.taken || !l.stay || l.change === undefined || l.change === 'none') return actual
  return (actual * l.stay) / l.taken
}

type Totals = {
  rated: number
  /** Claude's own subagents moved to a cheaper model. */
  subagents: number
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
    subagents: 0,
    changed: { none: 0, lower: 0, raise: 0, 'delegate-up': 0, 'delegate-down': 0 },
    declined: 0,
    saved: 0,
    extra: 0,
    overhead: 0,
    spent: 0,
  }
  for (const l of lines) {
    t.overhead += num(l.overhead)
    // Its cost is already in its turn's; what it saved is not: the same work on the parent's model, scaled as a turn's is.
    if (l.kind === 'subagent') {
      t.subagents += 1
      // A workflow's agents say nothing about one route's estimate: no saving is counted for them.
      if (!l.aborted && !l.afterWorkflow && num(l.estimate) > 0) t.saved += (num(l.actual) * num(l.parentEstimate)) / num(l.estimate) - num(l.actual)
      continue
    }
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

/** Close calls between two models, from hand-offs and from Claude's moved subagents: broken by the task-type guide (or by the stronger model), and explored. */
export function tieCounts(lines: readonly RunLine[]) {
  let guided = 0
  let explored = 0
  for (const l of lines) {
    if (!isRun(l)) continue
    for (const t of [l.tie, ...(l.resized ?? []).map(x => x.tie)]) {
      if (t?.by === 'explore') explored += 1
      else if (t?.by === 'guide' || t?.by === 'stronger') guided += 1
    }
  }
  return { guided, explored }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** Percent of a window per dollar, and per minute of turn time, over runs whose window did not reset. */
export function windowRates(lines: readonly RunLine[], kind: string) {
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

/** The saving as a share of what the turns would have cost, after rating calls. */
const savedShare = (t: Totals) => {
  const net = t.saved - t.overhead
  return Math.round((net / (t.spent + t.overhead + net)) * 100)
}

/** Window share kept (negative: used more than staying would have), as `windowRates` measures it; minutes only when kept. */
type Kept = { five: number; week?: number; mins?: number }

function windowKept(lines: readonly RunLine[], t: Totals): Kept | undefined {
  const net = t.saved - t.overhead
  const five = windowRates(lines, 'five_hour')
  // "About even" in dollars gets no window figure.
  if (!five || Math.abs(net) < 0.005) return undefined
  const savedPct = net * five.perDollar
  if (Math.abs(savedPct) < 0.05) return undefined
  const week = windowRates(lines, 'seven_day')
  const mins = savedPct > 0 && five.perMinute ? Math.round(savedPct / five.perMinute) : 0
  return { five: savedPct, ...(week ? { week: net * week.perDollar } : {}), ...(mins >= 1 ? { mins } : {}) }
}

/** One period's numbers: `ties` only where the report counts close calls (7 and 30 days). */
type Stats = { t: Totals; net: number; empty: boolean; kept?: Kept; ties?: { guided: number; explored: number } }

function stats(lines: readonly RunLine[], subscription: boolean, withTies = false): Stats {
  const t = totals(lines)
  const kept = subscription ? windowKept(lines, t) : undefined
  return { t, net: t.saved - t.overhead, empty: !t.rated && !t.overhead && !t.subagents, ...(kept ? { kept } : {}), ...(withTies ? { ties: tieCounts(lines) } : {}) }
}

const DAYS_30 = 'in the last 30 days'

/** The one sentence the report opens with: a subscriber reads the window first, an API user reads dollars. */
function headline(s: Stats, subscription: boolean) {
  if (s.empty) return 'Nothing rated in the last 30 days.'
  const { t, net, kept } = s
  if (Math.abs(net) < 0.005) return `About even ${DAYS_30}: savings and rating calls cancel out.`
  if (subscription) {
    if (kept) {
      return kept.five > 0
        ? `Saved ~${kept.five.toFixed(1)}% of your 5-hour window${kept.mins ? ` (~${kept.mins} min)` : ''} ${DAYS_30}.`
        : `Used ~${(-kept.five).toFixed(1)}% more of your 5-hour window than staying would have ${DAYS_30}.`
    }
    return net > 0 ? `Saved ~${savedShare(t)}% of your usage ${DAYS_30}.` : `Used more than it saved ${DAYS_30} (~${money(-net)} more, API-equivalent).`
  }
  return net > 0 ? `Saved ~${money(net)} (~${savedShare(t)}%) ${DAYS_30}.` : `Cost ~${money(-net)} more than it saved ${DAYS_30}.`
}

/**
 * Plain-text columns that line up in a monospace font: every column but a row's last is padded to its widest cell, and
 * the columns in `right` are right-aligned. If alignment breaks somewhere (the desktop app's font), make this one
 * function join each row as `label: value` instead: `rows.map(r => r.join(': '))`.
 */
function grid(rows: readonly (readonly string[])[], right: readonly number[] = []) {
  const width = (i: number) => Math.max(0, ...rows.map(r => (r[i] ?? '').length))
  const widths = Array.from({ length: Math.max(0, ...rows.map(r => r.length)) }, (_, i) => width(i))
  return rows.map(r =>
    r
      .map((c, i) => (right.includes(i) ? c.padStart(widths[i] ?? 0) : i < r.length - 1 ? c.padEnd(widths[i] ?? 0) : c))
      .join('   '),
  )
}

/** Wraps `text` to `width` columns, starting with `first` and indenting later lines with `rest`. */
function wrap(text: string, first: string, rest: string, width = 78) {
  const out: string[] = []
  let line = first
  let fresh = true
  for (const w of text.split(' ')) {
    if (!fresh && line.length + 1 + w.length > width) {
      out.push(line)
      line = rest + w
    } else line += (fresh ? '' : ' ') + w
    fresh = false
  }
  return [...out, line]
}

/** A table row: shown when any period has something for it; a period with nothing rated shows a dash, except on `counts` rows. */
type Row = { label: string; any: (s: Stats) => boolean; cell: (s: Stats) => string; counts?: true }

const gain = (x: number) => `${x < 0 ? '-' : '~'}${Math.abs(x).toFixed(1)}%`
const whole = () => true
const measured = (s: Stats) => !s.empty

function tableRows(subscription: boolean): Row[] {
  const c = (s: Stats) => s.t.changed
  // The minutes the window share stands for are in the headline; a column of them would not fit in 80.
  const windows: Row[] = [
    { label: '5-hour window saved', any: s => !!s.kept, cell: s => (s.kept ? gain(s.kept.five) : '–') },
    { label: '7-day window saved', any: s => s.kept?.week !== undefined, cell: s => (s.kept?.week !== undefined ? gain(s.kept.week) : '–') },
  ]
  // Savings first, then what rightsize did.
  return [
    { label: 'Total saved', any: measured, cell: s => (s.net >= 0.005 ? `~${money(s.net)}` : s.net <= -0.005 ? `-${money(-s.net)}` : 'even') },
    ...(subscription ? windows : []),
    { label: 'Share of cost saved', any: measured, cell: s => (s.net >= 0.005 ? `~${savedShare(s.t)}%` : '–') },
    { label: 'Extra spent on harder prompts', any: s => s.t.extra > 0.005, cell: s => money(s.t.extra) },
    { label: 'Prompts rated', any: whole, cell: s => String(s.t.rated), counts: true },
    { label: 'Kept / lowered / raised', any: whole, cell: s => `${c(s).none}/${c(s).lower}/${c(s).raise}`, counts: true },
    { label: 'Sent to cheaper / stronger model', any: s => c(s)['delegate-down'] + c(s)['delegate-up'] > 0, cell: s => `${c(s)['delegate-down']}/${c(s)['delegate-up']}` },
    { label: 'Suggestions declined', any: s => s.t.declined > 0, cell: s => String(s.t.declined) },
    { label: 'Subagents on cheaper model', any: s => s.t.subagents > 0, cell: s => String(s.t.subagents) },
    { label: 'Close calls: guide / explored', any: s => !!s.ties && s.ties.guided + s.ties.explored > 0, cell: s => (s.ties ? `${s.ties.guided}/${s.ties.explored}` : '–') },
  ]
}

/** Prompts, changes and savings for the session, 7 days and 30 days, in columns. */
function periodTable(cols: readonly [Stats, Stats, Stats], subscription: boolean) {
  const rows = tableRows(subscription).filter(r => cols.some(r.any))
  const cell = (r: Row, s: Stats) => (s.empty && !r.counts ? '–' : r.cell(s))
  return grid([['', 'Session', '7 days', '30 days'], ...rows.map(r => [r.label, ...cols.map(s => cell(r, s))])], [1, 2, 3])
}

/** How far estimates were from what turns cost: the mean of max(actual/estimate, estimate/actual). */
function offBy(lines: readonly RunLine[]) {
  const xs = lines.map(l => (num(l.actual) > 0 && num(l.taken) > 0 ? Math.max(num(l.actual) / num(l.taken), num(l.taken) / num(l.actual)) : 0)).filter(x => x > 0)
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
}

/**
 * How often the rater was wrong where the log shows how it turned out, and the hand-downs paused for it (from `pause`
 * misses; null: Pause after misses is off). The count is all of the history; what is paused counts only the lines
 * from `from` on, the way rightsize does since Cost measurement was restarted. `paused` is the notice for NEXT STEPS.
 */
function haikuRows(lines: readonly RunLine[], pause: number | null, from: number) {
  const rates = missRates(lines)
  const { n, misses } = missTotals(rates)
  const rows: string[][] = []
  if (!misses) return { rows }
  rows.push(["Haiku's judgement", `wrong on ${misses} of ${n} checked prompts (${Math.round((misses / n) * 100)}%)`])
  const checks = checkTotals(lines)
  if (checks.n) rows.push(['Haiku vs Sonnet checks', `agreed on ${checks.agreed} of ${checks.n}`])
  const live = from > 0 ? missRates(lines.filter(l => Date.parse(l.at) >= from)) : rates
  const worst = Object.entries(live)
    .filter(([, e]) => e.n >= MISS_MIN)
    .map(([key, e]) => ({ key, n: e.n, rate: e.misses / e.n }))
    .sort((a, b) => b.rate - a.rate || b.n - a.n)[0]
  const [type, tier] = worst ? worst.key.split(':') : []
  if (!worst || pause === null || worst.rate < pause || !type || !isTier(tier)) return { rows }
  const what = `${type} work to ${TIER_NAME[tier]}`
  rows.push(['Hand-downs paused', `${what}, wrong on ${Math.round(worst.rate * 100)}% of ${worst.n}`])
  return { rows, paused: `Hand-downs of ${what}, and lowering effort on it, resume when its miss rate falls under the Pause after misses line (/config).` }
}

/** How far off the estimates were, early against late; nothing until there are enough measured runs. */
function calibrationRow(runs: readonly RunLine[]) {
  const measuredRuns = runs.filter(l => num(l.actual) > 0 && num(l.taken) > 0)
  if (measuredRuns.length < 6) return undefined
  const n = Math.min(10, Math.floor(measuredRuns.length / 2))
  const first = offBy(measuredRuns.slice(0, n))
  const last = offBy(measuredRuns.slice(-n))
  const trend = last.toFixed(1) === first.toFixed(1) ? 'same as' : last < first ? 'down from' : 'up from'
  return ['Estimates', `${last.toFixed(1)}x off, ${trend} ${first.toFixed(1)}x in the first ${n} runs`]
}

/** How good the ratings and estimates were: Haiku's misses, Sonnet's checks, what is paused for them, and the estimate error. */
export function accuracyRows(lines: readonly RunLine[], pause: number | null = MISS_BLOCK, from = 0) {
  const { rows, paused } = haikuRows(lines, pause, from)
  const calibration = calibrationRow(lines.filter(l => isRun(l) && !l.aborted))
  return { rows: [...rows, ...(calibration ? [calibration] : [])], ...(paused ? { paused } : {}) }
}

/** One thing that was off: `n` of `unit` (singular, plural), why, and any detail lines. */
export type Problem = { n: number; unit: [string, string]; reason: string; detail?: string[] }

const TURN: [string, string] = ['turn', 'turns']

/** Turns that cost more, went off course or were left out of the saving; most first. */
export function problems(lines: readonly RunLine[], switches: readonly SwitchLine[]) {
  const runs = lines.filter(l => isRun(l) && !l.aborted)
  const out: Problem[] = []
  const steppedUp = runs.filter(l => l.steppedUp).length
  if (steppedUp) out.push({ n: steppedUp, unit: TURN, reason: 'lowered, then stepped back up: the task was harder than rated' })
  const raised = runs.filter(l => l.escalations?.length)
  if (raised.length) {
    const why = new Map<string, number>()
    for (const l of raised) for (const x of l.escalations ?? []) why.set(x.why.replace(/^\d+ /, 'several '), (why.get(x.why.replace(/^\d+ /, 'several ')) ?? 0) + 1)
    const top = [...why.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w, n]) => `${w} (${n})`).join(', ')
    out.push({ n: raised.length, unit: TURN, reason: 'raised mid-turn because Claude looked stuck', detail: [top] })
  }
  const dearer = runs.filter(l => delegated(l) && num(l.stay) > 0 && num(l.actual) > num(l.stay))
  if (dearer.length) {
    const a = dearer.reduce((s, l) => s + num(l.actual), 0)
    const st = dearer.reduce((s, l) => s + num(l.stay), 0)
    out.push({ n: dearer.length, unit: TURN, reason: `hand-off cost more than staying (${money(a)} vs ~${money(st)})` })
  }
  const rework = runs.filter(l => delegated(l) && num(l.agentCalls) > 1).length
  if (rework) out.push({ n: rework, unit: TURN, reason: 'hand-off needed rework (more than one subagent call)' })
  // A hand-off kept in the main chat for steps only you can approve is not a miss.
  const skipped = runs.filter(l => (l.change === 'delegate-up' || l.change === 'delegate-down') && !delegated(l) && !num(l.approvalSteps)).length
  if (skipped) out.push({ n: skipped, unit: TURN, reason: 'Claude skipped the hand-off you chose and did the work itself' })
  const missed = switches.filter(s => s.kept === false).length
  if (missed) {
    const cost = runs.reduce((s, l) => s + num(l.missCost), 0)
    out.push({ n: missed, unit: ['switch', 'switches'], reason: `missed the cache, of ${plural(switches.length, 'effort switch', 'effort switches')}${cost >= 0.005 ? ` (~${money(cost)})` : ''}` })
  }
  const fanned = runs.filter(l => l.afterWorkflow)
  if (fanned.length) {
    const flows = fanned.reduce((s, l) => s + num(l.workflows), 0)
    out.push({
      n: fanned.length,
      unit: TURN,
      reason: `ran during or after a workflow (${money(fanned.reduce((s, l) => s + num(l.actual), 0))})`,
      detail: [`${plural(flows, 'workflow')}, from ultracode or asked for`, 'hand-offs paused in those sessions; nothing learned from them'],
    })
  }
  const aborted = lines.filter(l => isRun(l) && l.aborted).length
  if (aborted) out.push({ n: aborted, unit: TURN, reason: 'you stopped (their rating cost still counts)' })
  return out.sort((a, b) => b.n - a.n)
}

/** The problems as rows: count and unit lined up, then the reason, with detail lines under it. */
function problemRows(ps: readonly Problem[]) {
  const unit = (p: Problem) => p.unit[p.n === 1 ? 0 : 1]
  const nw = Math.max(0, ...ps.map(p => String(p.n).length))
  const uw = Math.max(0, ...ps.map(p => unit(p).length))
  return ps.flatMap(p => [[`${String(p.n).padStart(nw)} ${unit(p).padEnd(uw)}`, p.reason], ...(p.detail ?? []).map(d => ['', d])])
}

const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}K` : `${Math.round(n)}`)

/** The context every request carried, by part (largest first), request-weighted, what re-reading it cost, and how to cut it. */
export function fixedBlock(lines: readonly RunLine[]) {
  const runs = lines.filter(l => isRun(l) && l.fixed && num(l.requests) > 0)
  const requests = runs.reduce((n, l) => n + num(l.requests), 0)
  const cost = runs.reduce((n, l) => n + num(l.fixed?.cost), 0)
  if (!requests || cost < 0.005) return undefined
  const avg = (part: 'tokens' | 'mcp' | 'memory' | 'agents' | 'skills') => runs.reduce((n, l) => n + num(l.fixed?.[part]) * num(l.requests), 0) / requests
  const servers = Object.entries(runs[runs.length - 1]?.fixed?.servers ?? {}).sort((a, b) => b[1] - a[1])
  const parts = [
    [avg('mcp'), 'MCP tools', 'servers', "disconnect MCP servers you don't use (/mcp)"],
    [avg('memory'), 'Memory', '', 'trim CLAUDE.md and memory files'],
    [avg('skills'), 'Skills', '', "turn off plugins and skills you don't use (/plugin)"],
    [avg('agents'), 'Agents', '', "remove custom agents you don't use (/agents)"],
  ] as const
  const big = parts.filter(([t]) => t >= 500).sort((a, b) => b[0] - a[0])
  const labels = big.map(([, label], i) => `${i === big.length - 1 ? '└─' : '├─'} ${label}`)
  // Servers are named largest first while the row stays within 80 columns (indent, label, size and gaps come first); the rest are counted. The largest is always named.
  const room = 80 - (2 + Math.max(0, ...labels.map(l => l.length)) + 3 + Math.max(0, ...big.map(([t]) => k(t).length)) + 3)
  const named: string[] = []
  for (const [n, t] of servers) {
    const rest = servers.length - named.length - 1
    const row = [...named, `${n} ${k(t)}`].join(', ') + (rest ? `, +${rest} more` : '')
    if (named.length && row.length > room) break
    named.push(`${n} ${k(t)}`)
  }
  const note = named.join(', ') + (named.length < servers.length ? `, +${servers.length - named.length} more` : '')
  const tree = big.map(([t, , own], i) => [labels[i] ?? '', k(t), ...((own ? note : '') ? [note] : [])])
  // The advice follows the biggest parts, so it names what would cut the most.
  const how = big.slice(0, 2).map(([, , , fix]) => fix).join(', or ')
  const spent = runs.reduce((n, l) => n + num(l.actual), 0)
  // The share is of what those same turns cost (their actual spend), not of all spend.
  const pct = spent > 0 ? `, ~${Math.round((cost / spent) * 100)}% of what those turns cost` : ''
  return {
    head: `~${k(avg('tokens'))} tokens sent with every request`,
    notes: ['Fixed context adds to your cost in every session. Cutting it saves more.', `At least ~${money(cost)} over ${plural(requests, 'request')}${pct}.`],
    tree,
    ...(how ? { fix: `rightsize can't trim fixed context. To cut it: ${how}.` } : {}),
  }
}

export function buildReport(
  lines: readonly RunLine[],
  switches: readonly SwitchLine[],
  opts: { now: number; session: string; subscription: boolean; start?: StartBlock; pause?: number | null; measureFrom?: string; markdown?: boolean },
) {
  const since = (days: number) => (l: { at: string }) => opts.now - Date.parse(l.at) <= days * DAY
  const month = lines.filter(since(30))
  const sub = opts.subscription
  // The desktop app renders the text as Markdown, which drops the spaces that line columns up: there the aligned
  // blocks go in code fences, and prose is left for it to wrap.
  const md = opts.markdown === true
  const indent = (rows: readonly string[]) => {
    const out = rows.map(r => `  ${r}`)
    return md && out.length ? ['```', ...out, '```'] : out
  }
  const section = (t: string, rows: readonly string[]) => ['', t, ...indent(rows)]

  const cols = [stats(lines.filter(l => opts.session !== '' && l.session === opts.session), sub), stats(lines.filter(since(7)), sub, true), stats(month, sub, true)] as const
  const nothing = cols.every(s => s.empty)
  const out = ['rightsize report', nothing ? 'Nothing rated yet.' : headline(cols[2], sub)]
  if (opts.measureFrom) out.push(`Cost measurement restarted on ${opts.measureFrom.slice(0, 10)}.`)
  if (!nothing) out.push('', ...indent(periodTable(cols, sub)), '', 'Everything below covers the last 30 days.')

  const start = opts.start
  if (start) out.push('', `STARTING POINT  ${start.head}`, ...indent(grid(start.rows)), ...(start.note ? (md ? ['', start.note] : wrap(start.note, '  ', '  ')) : []))
  const fixed = fixedBlock(month)
  if (fixed) out.push('', `FIXED CONTEXT  ${fixed.head}`, ...fixed.notes.map(n => (md ? n : `  ${n}`)), ...indent(grid(fixed.tree, [1])))
  const accuracy = accuracyRows(month, opts.pause, opts.measureFrom ? Date.parse(opts.measureFrom) : 0)
  if (accuracy.rows.length) out.push(...section('ACCURACY', grid(accuracy.rows)))
  const problem = problems(month, switches.filter(since(30)))
  out.push(...(problem.length ? section('NOT COUNTED AS SAVINGS', grid(problemRows(problem))) : ['', 'NOT COUNTED AS SAVINGS', md ? 'Nothing yet.' : '  Nothing yet.']))
  // Actions from the sections above, in their own words: fixed context, the start, a pause.
  const next = [fixed?.fix, start?.tip, accuracy.paused].filter((n): n is string => !!n)
  if (next.length) out.push('', 'NEXT STEPS', ...(md ? next.map(n => `- ${n}`) : indent(next.flatMap(n => wrap(n, '- ', '  ', 76)))))
  const t = cols[2].t
  const foot = [
    'Estimated: actual cost vs staying at your own model and effort.',
    ...(nothing ? [] : [`Total saved is after the cost of rating prompts with Haiku (${money(t.overhead)} in 30 days).`]),
    ...(cols.some(s => s.t.extra > 0.005) ? ["Extra spent on harder prompts: what raising effort or using a stronger model cost, for better answers. It isn't taken off Total saved."] : []),
    ...(sub ? ['Dollar amounts are what the same use would cost on the API.', 'You only pay for your subscription.'] : []),
  ]
  out.push('', ...(md ? foot : foot.flatMap(f => wrap(f, '', '', 78))))
  return out.join('\n')
}

export const SHARE_MIN_RATED = 20
export const SHARE_MIN_PCT = 5
const SHARE_LINK = 'https://aivalue.blog/rightsize'

/**
 * /rightsize share: a message to paste anywhere, with the last 30 days' estimated saving once there is enough data.
 * Prints only; unrelated to the anonymous-feedback setting. Same totals and percentage as the report.
 */
export function shareMessage(lines: readonly RunLine[], opts: { now: number; subscription: boolean; measureFrom?: string }) {
  const from = opts.measureFrom ? Date.parse(opts.measureFrom) : 0
  const month = lines.filter(l => opts.now - Date.parse(l.at) <= 30 * DAY && Date.parse(l.at) >= from)
  const t = totals(month)
  const net = t.saved - t.overhead
  const pct = net > 0 ? Math.round((net / (t.spent + t.overhead + net)) * 100) : 0
  const enough = t.rated >= SHARE_MIN_RATED
  const head = 'Copy and paste this anywhere. rightsize sends nothing itself.'
  if (enough && pct >= SHARE_MIN_PCT) {
    const what = opts.subscription ? `saved about ${pct}% of my Claude Code usage` : `cut my Claude Code spend by about ${pct}%`
    return [
      head,
      '',
      `rightsize ${what} over the last 30 days, by its own estimate. It matches each prompt to the right model and effort level. Free and open source: ${SHARE_LINK}`,
      '',
      `The number is rightsize's estimate from your last 30 days (${t.rated} rated prompts); /rightsize report shows the details. Edit the message as you like.`,
    ].join('\n')
  }
  return [
    head,
    '',
    `I'm using rightsize, a free Claude Code mod that matches each prompt to the right model and effort level, and shows what it changed. Open source: ${SHARE_LINK}`,
    '',
    enough
      ? "No saving is included: rightsize's estimate for your last 30 days is under 5%."
      : `Once rightsize has ${SHARE_MIN_RATED} rated prompts and an estimated saving of ${SHARE_MIN_PCT}% or more in the last 30 days, this message includes it.`,
  ].join('\n')
}
