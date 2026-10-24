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
  /** 'overhead': a rating call that came to nothing (failed or unreadable). 'subagent': one of Claude's subagents moved to a cheaper model, when it answered. */
  kind?: 'run' | 'overhead' | 'subagent'
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
      if (!l.aborted && num(l.estimate) > 0) t.saved += (num(l.actual) * num(l.parentEstimate)) / num(l.estimate) - num(l.actual)
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
  const subs = t.subagents ? ` ${plural(t.subagents, 'subagent')} Claude started ran on a cheaper model.` : ''
  return `${plural(t.rated, 'prompt')} rated, ${n} changed${parts.length ? ` (${parts.join(', ')})` : ''}.${declined}${subs}`
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

/** The saving as a share of usage, with dollars as API-equivalent: a subscription is not billed them. */
function usageLine(t: Totals) {
  const net = t.saved - t.overhead
  const rating = `${money(t.overhead)} of rating calls`
  const extra = t.extra > 0.005 ? ` Raising effort and stronger models: ${money(t.extra)} more API-equivalent, for harder work.` : ''
  if (net >= 0.005) {
    const pct = Math.round((net / (t.spent + t.overhead + net)) * 100)
    return `Saved ~${pct}% of the usage these turns would have taken, after rating calls (API-equivalent: ~${money(net)} saved, ${rating}).${extra}`
  }
  if (net <= -0.005) return `Used more than it saved, counting rating calls (API-equivalent: ~${money(-net)} more, ${rating}).${extra}`
  return `About even: savings and rating calls cancel out (API-equivalent: ${rating}).${extra}`
}

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

function period(title: string, lines: readonly RunLine[], subscription: boolean, withTies = false) {
  const t = totals(lines)
  if (!t.rated && !t.overhead && !t.subagents) return [`${title}: nothing rated yet.`]
  const out = [`${title}: ${changedLine(t)}`]
  // A subscriber reads the window first; dollars follow as API-equivalent.
  const w = subscription ? windowLine(lines, t) : undefined
  if (w) out.push(`  ${w}`)
  out.push(`  ${subscription ? usageLine(t) : savedLine(t)}`)
  const ties = withTies ? tieCounts(lines) : { guided: 0, explored: 0 }
  if (ties.guided + ties.explored > 0) out.push(`  ${plural(ties.guided, 'close call')} decided by the task-type guide, ${ties.explored} explored.`)
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
  const raised = runs.filter(l => l.escalations?.length)
  if (raised.length) {
    const why = new Map<string, number>()
    for (const l of raised) for (const x of l.escalations ?? []) why.set(x.why.replace(/^\d+ /, 'several '), (why.get(x.why.replace(/^\d+ /, 'several ')) ?? 0) + 1)
    const top = [...why.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w, n]) => `${w} (${n})`).join(', ')
    out.push(`${plural(raised.length, 'turn')} raised effort mid-turn because Claude looked stuck: ${top}. No saving is counted for them.`)
  }
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
  const fanned = runs.filter(l => l.afterWorkflow)
  if (fanned.length) {
    const flows = fanned.reduce((s, l) => s + num(l.workflows), 0)
    out.push(
      `${plural(fanned.length, 'turn')} ran during or after a workflow (${plural(flows, 'workflow')}, ultracode or asked for): ${money(fanned.reduce((s, l) => s + num(l.actual), 0))}. No saving is counted for them, they teach calibration nothing, and hand-offs paused for those sessions.`,
    )
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

const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}K` : `${Math.round(n)}`)

/** The context every request carried, by part, request-weighted, and what re-reading it cost. */
export function fixedLines(lines: readonly RunLine[]) {
  const runs = lines.filter(l => isRun(l) && l.fixed && num(l.requests) > 0)
  const requests = runs.reduce((n, l) => n + num(l.requests), 0)
  const cost = runs.reduce((n, l) => n + num(l.fixed?.cost), 0)
  if (!requests || cost < 0.005) return []
  const avg = (part: 'tokens' | 'mcp' | 'memory' | 'agents' | 'skills') => runs.reduce((n, l) => n + num(l.fixed?.[part]) * num(l.requests), 0) / requests
  const servers = Object.entries(runs[runs.length - 1]?.fixed?.servers ?? {})
  const mcp = `MCP tools ~${k(avg('mcp'))}${servers.length ? ` (${servers.map(([n, t]) => `${n} ${k(t)}`).join(', ')})` : ''}`
  const parts = [
    [avg('mcp'), mcp, "disconnect MCP servers you don't use (/mcp)"],
    [avg('memory'), `CLAUDE.md and memory ~${k(avg('memory'))}`, 'trim CLAUDE.md and memory files'],
    [avg('skills'), `skills and commands ~${k(avg('skills'))}`, "turn off plugins and skills you don't use (/plugin)"],
    [avg('agents'), `agent descriptions ~${k(avg('agents'))}`, "remove custom agents you don't use (/agents)"],
  ] as const
  const big = parts.filter(([t]) => t >= 500).sort((a, b) => b[0] - a[0])
  const listed = big.map(([, text]) => text)
  // The advice follows the biggest parts, so it names what would cut the most.
  const how = big.slice(0, 2).map(([, , fix]) => fix).join(', or ')
  const spent = runs.reduce((n, l) => n + num(l.actual), 0)
  const pct = spent > 0 ? ` (~${Math.round((cost / spent) * 100)}% of what those turns cost)` : ''
  return [
    `Fixed context (last 30 days): ~${k(avg('tokens'))} tokens rode along on every request${listed.length ? `: ${listed.join(', ')}` : ''}.`,
    `  Re-reading it cost at least ~${money(cost)} over ${plural(requests, 'request')}${pct}. rightsize can't trim it${how ? `: ${how}` : ''}.`,
  ]
}

export function buildReport(
  lines: readonly RunLine[],
  switches: readonly SwitchLine[],
  opts: { now: number; session: string; subscription: boolean; start?: readonly string[] },
) {
  const since = (days: number) => (l: { at: string }) => opts.now - Date.parse(l.at) <= days * DAY
  const month = lines.filter(since(30))
  const out = [
    'Rightsize report. Savings are estimated: what staying at your own level and model would have cost, scaled by what each turn really cost.',
    ...(opts.subscription ? ['Dollar amounts are API-equivalent: what the same tokens would cost at API prices. Your subscription is not billed them.'] : []),
    '',
    ...period('This session', lines.filter(l => opts.session !== '' && l.session === opts.session), opts.subscription),
    ...period('Last 7 days', lines.filter(since(7)), opts.subscription, true),
    ...period('Last 30 days', month, opts.subscription, true),
    '',
  ]
  if (opts.start?.length) out.push(...opts.start, '')
  const fixed = fixedLines(month)
  if (fixed.length) out.push(...fixed, '')
  const wrong = wentWrong(month, switches.filter(since(30)))
  out.push('What went wrong (last 30 days):', ...(wrong.length ? wrong.map(w => `- ${w}`) : ['- Nothing yet.']))
  return out.join('\n')
}
