import { MISS_BLOCK, TIER_NAME, isTier, money } from './cost'
import { STEP_PROVE } from './steps'
import { MISS_MIN, checkTotals, missRates, missTotals } from './misses'
import type { StartBlock } from './start'
import type { TrimSavings, TrimSum } from './trim'

// /rightsize report: what the mod saved, what it cost to run, and what went
// wrong, read from its run log. Pure functions, no engine calls.
//
// A saving is an estimate. Staying would have cost the baseline: rightsize's estimate,
// made when it chose the route, of the task on the person's own model and level. It is
// never changed afterward, so a task that cost more than the baseline shows a negative saving.

export type Change = 'none' | 'lower' | 'raise' | 'delegate-up' | 'delegate-down' | 'switch-up'
/** Rate-limit windows as percent used: `five_hour`, `seven_day`, `spend_limit`. */
export type Windows = Record<string, number>

/** One line of a session's runs.jsonl (or of the old shared rightsize-runs.jsonl). Lines from before 0.5 lack the newer fields. */
export type RunLine = {
  at: string
  /**
   * 'overhead': a rating call that came to nothing (failed or unreadable). 'subagent': one of Claude's subagents moved to a cheaper model, when it answered.
   * 'check': Sonnet's second opinion on a rating. 'feedback': a 👍 or 👎 on a run. Neither counts as a rated run.
   * 'unrated': a prompt whose rating failed twice or could not be read, so the session was left as it was; `reason` says why and `overhead` is what the rating calls cost.
   * 'dropped': a rated prompt that never entered because something beneath rightsize refused it; `reason` is the refusal and `overhead` what its rating cost.
   * 'unbound': a rated prompt that never got a turn of its own, because it was delivered into a running turn or cancelled before its turn started; `reason` says which and `overhead` what its rating cost.
   * 'dropped' and 'unbound' are not rated runs: the report counts only their overhead.
   * 'warm': one keep-warm request that kept the prompt cache from expiring (Before the cache goes cold); `overhead` is what it cost, `tier` its model and `context` the conversation it re-read.
   * 'cold': how the person answered one offer before the cache goes cold; `choice` is the id they pressed, or 'ignored'. It carries no cost and is no part of any total.
   * 'warmSaved': the person came back to a kept-warm cache after the time it would have gone cold without keep warm, and the returning prompt's first request read the cache (at least ~80% of the kept conversation); `saved` is what coming back cold would have cost. It carries no `overhead`, and `totals` counts `saved` toward Total saved.
   * `totals` adds the `overhead` of every line, so these pings count as rightsize's own cost and lower Total saved.
   */
  kind?: 'run' | 'overhead' | 'subagent' | 'check' | 'feedback' | 'corrected' | 'unrated' | 'dropped' | 'unbound' | 'warm' | 'warmSaved' | 'cold'
  /** A run line: how the turn's last test run ended (the main chat's, else a helper's): the objective outcome of the work. */
  tests?: 'passed' | 'failed'
  /** A run line in watch-only mode: the change rightsize would have made, and the estimate of the route it would have taken. Nothing was applied. */
  would?: Change
  wouldTaken?: number
  /** A 'warmSaved' line: what coming back cold would have cost (the conversation written again, less a read), in dollars (API-equivalent on a subscription). */
  saved?: number
  /** A 'warm' line: the keep-warm run it belongs to, the ISO time of the turn that run kept warm. Lines of one run share it. */
  warmRun?: string
  /** A 'cold' line: the id of the choice pressed (`2h`, `8h`, `start`, `30m`, `1h`, `handoff`, `compact`, `let-go`, `off`), or `ignored` when the offer got no answer. */
  choice?: string
  /** A run line's own id, which feedback lines name in `ref`. */
  id?: string
  /** The task the line belongs to: the id of the run that started it. Follow-ups, unrated prompts, subagents, the rater's checks and keep-warm lines carry it. */
  task?: string
  /** A subagent line: the id of the run whose turn started it. */
  run?: string
  /** A run line: the main-chat turn the prompt ran in. */
  turnId?: string
  /** A run line: the prompt was typed while another turn was running, and waited for its own. */
  queued?: boolean
  session?: string
  type?: string
  route?: string
  change?: Change
  /** What the plan suggested; differs from `change` when the person kept their level. */
  offered?: Change
  steppedUp?: boolean
  /** Why it stepped up: the 5-step rule alone ('steps', not a miss) or a tool error ('error', a miss). Absent on older lines. */
  steppedUpBy?: 'steps' | 'error'
  /** Raised mid-turn when the turn showed it was struggling. */
  escalations?: { step: number; from: string; to: string; why: string }[]
  aborted?: boolean
  /** Calibrated estimates: of the route taken, and of staying at the person's own level and model. */
  taken?: number
  stay?: number
  actual?: number
  /** The model that rated the prompt: sonnet, or haiku (chosen in Rater, or the fallback). */
  rater?: 'sonnet' | 'haiku'
  /** The rating call's cost. */
  overhead?: number
  /** A run line: why the rater may have seen too little. 'cut': the request was longer than the rater is shown, so its middle was cut. 'missing': a task was in progress but Claude's last reply could not be read. Neither lowers effort or hands work to a cheaper model. */
  unsure?: 'cut' | 'missing'
  /** An unrated line: why the rating did not come (timeout, unreadable answer, and so on). A dropped or unbound line: why the prompt did not run. */
  reason?: string
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
  /** A run line: how long the turn took, in ms (from the turn's completion). */
  durationMs?: number
  /** A run or unrated line: wall time of all the prompt's rating attempts, in ms (0.8 on). Measured and reported; never used to choose a route. */
  ratingMs?: number
  /** A run line: when the prompt was submitted (ISO), before its rating; `at` is when its turn ended (0.8 on). */
  submittedAt?: string
  /** A subagent line: the model it would have run on and the one it ran on, at what level, and the raw estimates on each. */
  from?: string
  tier?: string
  level?: string
  estimate?: number
  parentEstimate?: number
  /** The hand-off was a close call between two models, and how it was broken. */
  tie?: Tie
  /** Learning mode: the plan the learned step exponent would have made beside the real one. `applied`: the real decision uses it. */
  learning?: { g: number; plan: string; differs: boolean; applied: boolean; delegateCost?: number; mainCost?: number }
  /** Claude's subagents moved to a cheaper model this turn; each may carry a close call too. */
  resized?: { tie?: Tie }[]
  /** Main-chat requests in the turn. */
  requests?: number
  /** A run line: each helper of the run that was watched (`agent` is its id, `kind` how it came to be one). */
  helpers?: (HelperLine & { agent: string; kind: 'handoff' | 'moved' })[]
  /** A run line: the task's retry budget used so far (helper raises and hand-off rework rounds); absent when none. */
  retries?: number
  /** A subagent line, when it was watched: the same fields as one entry of a run line's `helpers`. A run line's `steps` is the rater's guess; `errors` and `blocked` there are the main chat's. */
  steps?: number
  /** A subagent line, when it was watched: its tool calls. */
  calls?: number
  ms?: number
  errors?: number
  blocked?: number
  stall?: HelperLine['stall']
  raises?: HelperLine['raises']
  returned?: true
  /** Tokens every request carried that the person can trim (MCP tools, memory, agents, skills, SessionStart hook output), and what re-reading them cost. `files`: the largest memory files by name. `startHooks`: SessionStart hook output, absent when it could not be measured; `hooks`, from 0.9 to 0.11, was always 0 and is not read. */
  fixed?: { tokens: number; mcp: number; memory: number; agents: number; skills: number; cost: number; servers?: Record<string, number>; hooks?: number; startHooks?: number; files?: Record<string, number> }
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

/**
 * What watching one helper showed: the hand-off's subagent, or one of Claude's subagents moved to a cheaper model.
 * A helper that shows `stall: 'struggling'` and ended `returned` is the only kind of miss; 'blocked' is the environment's fault.
 */
export type HelperLine = {
  /** Requests it made. */
  steps: number
  /** Tool calls it made, counted as they go out (from 0.8; absent on older lines). */
  calls?: number
  /** How long it ran, in ms: from its start to its answer, or to the end of the run if it had not answered. */
  ms: number
  /** Tool calls of its own that failed, test runs included; blocked errors are counted apart. */
  errors: number
  /** Tool errors that came from the environment (no network, no login, a denied sandbox): more effort would not fix them. */
  blocked: number
  /** What it was stuck on: 'struggling' (raised or returned) or 'blocked' (the environment); absent when neither. */
  stall?: 'struggling' | 'blocked'
  /** Each raise of its effort, from the task's retry budget. */
  raises?: { step: number; from: string; to: string; why: string }[]
  /** Stopped and sent back to the main chat: the task's retry budget was used up while it was still stuck. */
  returned?: true
  /** The helper call cap it reached, when that is why it was sent back. */
  capped?: number
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

/**
 * What staying would have cost: the baseline, `stay`, which rightsize recorded when it chose the route and never changes.
 * The actual cost where there is nothing to compare (no change, a turn that stepped up or was raised, a workflow).
 */
export function counterfactual(l: RunLine) {
  const actual = num(l.actual)
  if (l.steppedUp || l.escalations?.length || l.afterWorkflow || !l.stay || l.change === undefined || l.change === 'none') return actual
  return l.stay
}

export type Totals = {
  rated: number
  /** Claude's own subagents moved to a cheaper model. */
  subagents: number
  /** Prompts whose rating failed: the session was left as it was. */
  unrated: number
  changed: Record<Change, number>
  declined: number
  saved: number
  extra: number
  overhead: number
  spent: number
  /** Keep-warm returns that held the cache: how many, and what they saved (already in `saved`). */
  returns: number
  keptSaved: number
}

export function totals(lines: readonly RunLine[]): Totals {
  const t: Totals = {
    rated: 0,
    subagents: 0,
    unrated: 0,
    changed: { none: 0, lower: 0, raise: 0, 'delegate-up': 0, 'delegate-down': 0, 'switch-up': 0 },
    declined: 0,
    saved: 0,
    extra: 0,
    overhead: 0,
    spent: 0,
    returns: 0,
    keptSaved: 0,
  }
  for (const l of lines) {
    t.overhead += num(l.overhead)
    // A return to a kept-warm cache: what a cold restart would have cost is saved. The pings stay their own cost lines.
    if (l.kind === 'warmSaved') {
      t.returns += 1
      t.keptSaved += num(l.saved)
      t.saved += num(l.saved)
      continue
    }
    if (l.kind === 'unrated') {
      t.unrated += 1
      continue
    }
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
    // Only what a raise spent over staying: one that came out cheaper adds nothing, so a longer period never shows less.
    else if (SPENDING.includes(c)) t.extra += Math.max(0, -diff)
  }
  return t
}

const zeroTotals = (): Totals => totals([])

/** Two totals added: every field of Totals is a count or a sum, so a period's total is the sum of its parts. */
export function addTotals(a: Totals, b: Totals): Totals {
  const changed = { ...a.changed }
  for (const k of Object.keys(b.changed) as Change[]) changed[k] = (changed[k] ?? 0) + b.changed[k]
  return {
    rated: a.rated + b.rated,
    subagents: a.subagents + b.subagents,
    unrated: a.unrated + b.unrated,
    changed,
    declined: a.declined + b.declined,
    saved: a.saved + b.saved,
    extra: a.extra + b.extra,
    overhead: a.overhead + b.overhead,
    spent: a.spent + b.spent,
    returns: a.returns + b.returns,
    keptSaved: a.keptSaved + b.keptSaved,
  }
}

/**
 * The lifetime roll-up: the totals of every run line older than `through`, folded in once so the run logs can be
 * trimmed and pruned without the lifetime figure losing them. `since` is the date of the earliest line folded.
 * It holds sums only: no prompt text, no ids. Lines after `through` are still in the logs and are added live.
 */
export type Lifetime = { since: string; through: string; t: Totals }

/** A stored value read back as a Lifetime, or undefined when it is not one (a missing or damaged store counts for nothing). */
export function parseLifetime(v: unknown): Lifetime | undefined {
  if (!v || typeof v !== 'object') return undefined
  const { since, through, t } = v as { since?: unknown; through?: unknown; t?: unknown }
  if (typeof since !== 'string' || typeof through !== 'string' || !Number.isFinite(Date.parse(since)) || !Number.isFinite(Date.parse(through))) return undefined
  if (!t || typeof t !== 'object') return undefined
  // Rebuilt field by field from numbers, so a damaged store cannot put anything else into the report.
  const x = t as Record<string, unknown>
  const changed = (x.changed ?? {}) as Record<string, unknown>
  const base = zeroTotals()
  const out: Totals = {
    ...base,
    rated: num(x.rated),
    subagents: num(x.subagents),
    unrated: num(x.unrated),
    declined: num(x.declined),
    saved: num(x.saved),
    extra: num(x.extra),
    overhead: num(x.overhead),
    spent: num(x.spent),
    returns: num(x.returns),
    keptSaved: num(x.keptSaved),
    changed: Object.fromEntries(Object.keys(base.changed).map(k => [k, num(changed[k])])) as Record<Change, number>,
  }
  return { since, through, t: out }
}

/**
 * The roll-up after folding in every line at or before `cutoff` that the roll-up does not hold yet. Lines are written
 * with the time they happened, so nothing later than `cutoff` is ever missing from the live part. Returns `prev`
 * unchanged when there is nothing to fold.
 */
export function foldLifetime(prev: Lifetime | undefined, lines: readonly RunLine[], cutoff: number): Lifetime | undefined {
  const from = prev ? Date.parse(prev.through) : -Infinity
  const old = lines.filter(l => Date.parse(l.at) <= cutoff && Date.parse(l.at) > from)
  if (!old.length) return prev
  const first = old.reduce((m, l) => Math.min(m, Date.parse(l.at)), Infinity)
  const since = prev && Date.parse(prev.since) <= first ? prev.since : new Date(first).toISOString()
  return { since, through: new Date(cutoff).toISOString(), t: addTotals(prev?.t ?? zeroTotals(), totals(old)) }
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

/**
 * Percent of a window per dollar, and per minute of turn time, over runs whose window did not reset.
 *
 * The window share is reported in whole percents, so each run's delta `after - before` has a rounding error, and the
 * total is not as certain as one number looks. `low` and `high` per dollar bound it: each endpoint is a whole percent,
 * and roughly 2 standard deviations of n independent roundings is about sqrt(n) points. `perDollar` is the point
 * estimate (the midpoint of that range unless `low` was clamped at 0), for code that needs one number, such as pacing math.
 */
export function windowRates(lines: readonly RunLine[], kind: string) {
  let pct = 0
  let usd = 0
  let ms = 0
  let n = 0
  for (const l of lines) {
    if (!isRun(l) || l.aborted) continue
    const b = l.before?.[kind]
    const a = l.after?.[kind]
    if (b === undefined || a === undefined || a < b) continue
    pct += a - b
    usd += num(l.actual)
    ms += num(l.durationMs)
    n += 1
  }
  if (pct <= 0 || usd <= 0) return undefined
  const spread = Math.sqrt(n)
  return {
    perDollar: pct / usd,
    low: Math.max(0, pct - spread) / usd,
    high: (pct + spread) / usd,
    perMinute: ms > 0 ? pct / (ms / 60000) : undefined,
  }
}

/** A window share in percent points as a range, signed (a loss is negative), `lo <= hi`. */
export type Share = { lo: number; hi: number }

/** The share of a window that `usd` API-equivalent dollars stand for, from the rates' `low` and `high` per dollar. */
export const shareOf = (usd: number, r: { low: number; high: number }): Share => (usd >= 0 ? { lo: usd * r.low, hi: usd * r.high } : { lo: usd * r.high, hi: usd * r.low })

const tenth = (x: number) => x.toFixed(1)

/**
 * A share as people read it, one decimal and an en dash: "~0.8–1.6%". The sign is left out (callers say saved or more).
 * When both ends round to the same text, the single value: "~1.0%". When the low end rounds to 0.0, "under 1.6%"
 * (and "under 0.1%" when the high end does too).
 */
export function shareText(s: Share) {
  const [lo, hi] = s.hi > 0 ? [s.lo, s.hi] : [-s.hi, -s.lo]
  const a = tenth(Math.max(0, lo))
  const b = tenth(hi)
  if (a === '0.0') return b === '0.0' ? 'under 0.1%' : `under ${b}%`
  return a === b ? `~${b}%` : `~${a}–${b}%`
}

/** Minutes the same way: "~8–16 min", "~12 min", "under 16 min". */
function minutesText(s: Share) {
  const a = Math.max(0, Math.round(s.lo))
  const b = Math.round(s.hi)
  if (a === 0) return `under ${b} min`
  return a === b ? `~${b} min` : `~${a}–${b} min`
}

/** What `usd` API-equivalent dollars cost in the 5-hour window, written for a sentence: a range, with the dollars beside it. */
export function windowCostText(usd: number, rates: { low: number; high: number } | undefined) {
  if (rates === undefined) return `about ${money(usd)} API-equivalent`
  return `${shareText(shareOf(usd, rates))} of your 5-hour window (${money(usd)} API-equivalent)`
}

/** Dollars with a "~" for an estimate; "under $0.01" stands alone. */
const tildeMoney = (usd: number) => (money(usd).startsWith('under') ? money(usd) : `~${money(usd)}`)

/**
 * A cost as a short tag for a band button, in one unit only: dollars on the API ("$0.06"); on a subscription the 5-hour
 * window share ("~0.1% usage"), or the API-equivalent dollars until runs show the rate ("~$0.06").
 */
export function costTag(usd: number, subscription: boolean, rates: { low: number; high: number } | undefined) {
  if (!subscription) return money(usd)
  return rates === undefined ? tildeMoney(usd) : `${bandShareText(shareOf(usd, rates))} usage`
}

/** What a keep-warm run has used, the same way: "$0.04" on the API, "~0.1% used" on a subscription with rates, else "~$0.04". */
export function usedTag(usd: number, subscription: boolean, rates: { low: number; high: number } | undefined) {
  if (!subscription) return money(usd)
  return rates === undefined ? tildeMoney(usd) : `${bandShareText(shareOf(usd, rates))} used`
}

/** The saving as a share of what the turns would have cost, after rating calls. */
const savedShare = (t: Totals) => {
  const net = t.saved - t.overhead
  return Math.round((net / (t.spent + t.overhead + net)) * 100)
}

/** Window share kept (negative: used more than staying would have), as `windowRates` measures it, as ranges; minutes only when kept. */
type Kept = { five: Share; week?: Share; mins?: Share }

function windowKept(lines: readonly RunLine[], t: Totals): Kept | undefined {
  const net = t.saved - t.overhead
  const five = windowRates(lines, 'five_hour')
  // "About even" in dollars gets no window figure.
  if (!five || Math.abs(net) < 0.005) return undefined
  const savedPct = net * five.perDollar
  if (Math.abs(savedPct) < 0.05) return undefined
  const week = windowRates(lines, 'seven_day')
  const share = shareOf(net, five)
  // The minutes the share stands for scale with it, so they carry its range.
  const perMinute = five.perMinute
  const mins = savedPct > 0 && perMinute && Math.round(savedPct / perMinute) >= 1 ? { lo: share.lo / perMinute, hi: share.hi / perMinute } : undefined
  return { five: share, ...(week ? { week: shareOf(net, week) } : {}), ...(mins ? { mins } : {}) }
}

/** One period's numbers: `ties` only where the report counts close calls (7 and 30 days). */
type Stats = { t: Totals; net: number; empty: boolean; kept?: Kept; ties?: { guided: number; explored: number } }

function stats(lines: readonly RunLine[], subscription: boolean, withTies = false): Stats {
  const t = totals(lines)
  const kept = subscription ? windowKept(lines, t) : undefined
  return { t, net: t.saved - t.overhead, empty: !t.rated && !t.overhead && !t.subagents && !t.unrated && !t.returns, ...(kept ? { kept } : {}), ...(withTies ? { ties: tieCounts(lines) } : {}) }
}

/**
 * Lifetime: the roll-up plus every line after it, as a period's numbers. Window shares need the lines themselves: with
 * no roll-up yet, every lifetime line is still in the logs and gets them like any period; once lines are folded, none.
 */
function lifetimeStats(life: Lifetime | undefined, lines: readonly RunLine[], subscription: boolean): Stats {
  if (!life) return stats(lines, subscription)
  const live = lines.filter(l => Date.parse(l.at) > Date.parse(life.through))
  const t = addTotals(life.t, totals(live))
  return { t, net: t.saved - t.overhead, empty: !t.rated && !t.overhead && !t.subagents && !t.unrated && !t.returns }
}

/** The date lifetime counts from: the earlier of the roll-up's first line and the first line still in the logs, in the person's time. */
function lifetimeSince(life: Lifetime | undefined, lines: readonly RunLine[]) {
  const first = Math.min(life ? Date.parse(life.since) : Infinity, ...lines.map(l => Date.parse(l.at)).filter(Number.isFinite))
  if (!Number.isFinite(first)) return ''
  const d = new Date(first)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const DAYS_30 = 'in the last 30 days'

/** Hours from minutes, for a sentence or a cell: "~22–23 h"; under two hours, minutes: "~8–16 min", "under 16 min". */
function workTime(m: Share) {
  if (m.hi < 120) return minutesText(m)
  const a = Math.max(0, Math.round(m.lo / 60))
  const b = Math.round(m.hi / 60)
  if (a === 0) return `under ${b} h`
  return a === b ? `~${b} h` : `~${a}–${b} h`
}

/** How many 5-hour windows a share of one stands for: "~10–11", "~3.3–3.5", "under 0.4"; a loss reads "-0.2 to -0.4". */
function windowsText(s: Share) {
  const one = (v: number) => (v < 9.95 ? v.toFixed(1) : String(Math.round(v)))
  const [lo, hi] = s.hi > 0 ? [Math.max(0, s.lo) / 100, s.hi / 100] : [-s.hi / 100, -s.lo / 100]
  const a = one(lo)
  const b = one(hi)
  if (s.hi <= 0) return a === '0.0' ? `0 to -${b === '0.0' ? '0.1' : b}` : a === b ? `-${b}` : `-${a} to -${b}`
  if (b === '0.0') return 'under 0.1'
  if (a === '0.0') return `under ${b}`
  return a === b ? `~${b}` : `~${a}–${b}`
}

/** A share in whole percents for a table cell ("~135–223%"); a loss reads "-3 to -5%". */
function pctCell(s: Share) {
  if (s.hi > 0) return bandShareText(s)
  const t = bandShareText(s)
  const m = /^~?([\d.]+)–([\d.]+)%$/.exec(t)
  if (m) return `-${m[1]} to -${m[2]}%`
  return t.startsWith('under ') ? `0 to -${t.slice('under '.length)}` : `-${t.replace('~', '')}`
}

/** The work time for a sentence: "about 22–23 more hours", "about 1 more minute", "up to 16 more minutes". */
function workWords(m: Share) {
  const t = workTime(m)
  const up = t.startsWith('under ')
  const n = t.replace(/^~|^under /, '')
  const one = /^1 (h|min)$/.test(n)
  return `${up ? 'up to' : 'about'} ${n.replace(/ h$/, one ? ' more hour' : ' more hours').replace(/ min$/, one ? ' more minute' : ' more minutes')}`
}

/**
 * The sentences the report opens with. A subscriber reads hours of Claude's work first (the window share the saving
 * stands for, at their own pace), then windows and the API-equivalent value; an API user reads dollars.
 */
function headline(s: Stats, subscription: boolean): string[] {
  if (s.empty) return ['Nothing rated in the last 30 days.']
  const { t, net, kept } = s
  if (Math.abs(net) < 0.005) return ['About even: savings and rating calls cancel out.']
  if (subscription) {
    if (kept) {
      if (kept.five.hi <= 0) return [`Used ${shareText(kept.five)} more of your 5-hour window than staying would have (~${money(-net)} more, API-equivalent).`]
      const value = `worth ~${money(net)} at API prices`
      // Under one window, the share reads better than a count of windows: "~3.3–4.7% of one 5-hour window".
      const wins = kept.five.hi < 100 ? `${shareText(kept.five)} of one 5-hour window` : `${windowsText(kept.five)} extra 5-hour ${kept.five.hi >= 150 ? 'windows' : 'window'}`
      return kept.mins
        ? [`You got ${workWords(kept.mins)} of Claude's work from your plan.`, `That is ${wins}, ${value}.`]
        : [`You saved ${wins}, ${value}.`]
    }
    return [net > 0 ? `You saved ~${savedShare(t)}% of your usage, worth ~${money(net)} at API prices.` : `Used more than it saved (~${money(-net)} more, API-equivalent).`]
  }
  return [net > 0 ? `You saved ~${money(net)} (~${savedShare(t)}% of your cost).` : `Cost ~${money(-net)} more than it saved.`]
}

/**
 * A share for the band, short: ends rounded to whole percent, one decimal only for a value under 1%. "~10–17%", "~2%"
 * (both ends equal), "under 17%" (the low end is 0), "under 0.1%". The sign is left out (callers say saved or more).
 * The /rightsize report keeps `shareText`.
 */
export function bandShareText(s: Share) {
  const [lo, hi] = s.hi > 0 ? [s.lo, s.hi] : [-s.hi, -s.lo]
  const one = (v: number) => (v < 0.95 ? v.toFixed(1) : String(Math.round(v)))
  const a = one(Math.max(0, lo))
  const b = one(hi)
  if (a === '0.0') return b === '0.0' ? 'under 0.1%' : `under ${b}%`
  return a === b ? `~${b}%` : `~${a}–${b}%`
}

/** A running total already on a band's text, in any of the forms `sessionTotal` writes (and the older ones): `setBand` strips it before it adds the current one. */
export const SESSION_TOTAL = /(?: ·)? Session: (?:about even|~\$[\d.,]+ (?:saved|more)(?: \(API-equivalent\))?|(?:~|under )[\d.]+(?:–[\d.]+)?% (?:of the 5-hour window saved|more of the 5-hour window|saved|more))/g

/**
 * The band shows its session total only from this many rated prompts in the session: one or two runs are too few for a
 * running net to mean anything. "Rated" is what `totals` counts as `rated`: lines of kind `run` (not unrated, dropped,
 * unbound, subagent or cache lines). `/rightsize report` and `/rightsize status` count from the first prompt.
 */
export const SESSION_TOTAL_FROM = 3

/** How many rated prompts the session has: the figure `SESSION_TOTAL_FROM` is held against. */
export const ratedInSession = (lines: readonly RunLine[], session: string) => totals(lines.filter(l => l.session === session)).rated

/** The session's running net, in the band's words: "Session: ~10–17% saved", "Session: ~$0.84 saved". The same figure as the report's Session "Total saved": it comes from `stats`. */
export function sessionTotal(lines: readonly RunLine[], session: string, subscription: boolean): string | undefined {
  if (session === '') return undefined
  const { net, empty, kept } = stats(lines.filter(l => l.session === session), subscription)
  if (empty) return undefined
  if (Math.abs(net) < 0.005) return 'Session: about even'
  if (kept) return `Session: ${bandShareText(kept.five)} ${kept.five.hi > 0 ? 'saved' : 'more'}`
  return net > 0 ? `Session: ~${money(net)} saved` : `Session: ~${money(-net)} more`
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

/**
 * The learned step exponent's status, from the run log alone: learning until STEP_PROVE runs are scored, then applied
 * since the first run of the current applied streak (dated in Pacific), or learning again after a pause.
 */
export function stepLine(lines: readonly RunLine[], from = 0) {
  const runs = lines.filter(l => l.learning !== undefined && Date.parse(l.at) >= from)
  const last = runs[runs.length - 1]
  if (!last?.learning?.applied) return `Step estimates: learning, ${Math.min(STEP_PROVE, runs.length)} of ${STEP_PROVE} runs`
  let start = 0
  runs.forEach((l, i) => {
    if (!l.learning?.applied) start = i + 1
  })
  const day = new Date(Date.parse(runs[start]?.at ?? last.at)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' })
  return `Step estimates: applied since ${day}`
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

/** A table row: shown when any period has something for it; a period with nothing rated shows a dash. */
type Row = { label: string; any: (s: Stats) => boolean; cell: (s: Stats) => string }

const measured = (s: Stats) => !s.empty
const dollars = (net: number) => (net >= 0.005 ? `~${money(net)}` : net <= -0.005 ? `-${money(-net)}` : 'even')

/** YOUR SAVINGS rows: on a subscription the work time and windows first, then the dollar rows both bills share. */
function savingsRows(subscription: boolean): Row[] {
  // On a subscription a dollar figure is what the same use would cost on the API, never money saved: the label says so.
  const windows: Row[] = [
    { label: 'Extra work time', any: s => !!s.kept?.mins, cell: s => (s.kept?.mins ? workTime(s.kept.mins) : '–') },
    { label: '5-hour windows', any: s => !!s.kept, cell: s => (s.kept ? windowsText(s.kept.five) : '–') },
    { label: 'Weekly limit', any: s => s.kept?.week !== undefined, cell: s => (s.kept?.week !== undefined ? pctCell(s.kept.week) : '–') },
  ]
  return [
    ...(subscription ? windows : []),
    { label: subscription ? 'Value (API prices)' : 'Saved', any: measured, cell: s => dollars(s.net) },
    { label: 'Share of cost saved', any: measured, cell: s => (s.net >= 0.005 ? `~${savedShare(s.t)}%` : '–') },
    { label: 'Extra on hard prompts', any: s => s.t.extra > 0.005, cell: s => money(s.t.extra).replace('under ', '<') },
  ]
}

/** Today, 7 days, 30 days and lifetime in columns. Once runs are folded into the roll-up, lifetime has no window shares: its window rows are dashes. */
function savingsTable(cols: readonly Stats[], subscription: boolean) {
  const rows = savingsRows(subscription).filter(r => cols.some(r.any))
  const cell = (r: Row, s: Stats) => (s.empty ? '–' : r.cell(s))
  return grid([['', 'Today', '7 days', '30 days', 'Lifetime'], ...rows.map(r => [r.label, ...cols.map(s => cell(r, s))])], [1, 2, 3, 4])
}

/** 30-DAY SUMMARY: what rightsize did, one row each. Effort and model changes always show once anything was rated. */
function summaryRows(s: Stats, warm: KeepWarm | undefined, subscription: boolean): string[][] {
  const c = s.t.changed
  const prompts = (n: number) => `${n.toLocaleString('en-US')} ${n === 1 ? 'prompt' : 'prompts'}`
  const rows: string[][] = []
  if (s.t.rated) {
    rows.push(['Prompts rated', s.t.rated.toLocaleString('en-US')], ['Left as they were', prompts(c.none)], ['Effort lowered', prompts(c.lower)], ['Cheaper model', prompts(c['delegate-down'])])
    if (c.raise) rows.push(['Effort raised', prompts(c.raise)])
    if (c['delegate-up']) rows.push(['Stronger model', prompts(c['delegate-up'])])
  }
  if (s.t.subagents) rows.push(['Subagents moved', `${s.t.subagents} to a cheaper model`])
  if (s.t.declined) rows.push(['You declined', plural(s.t.declined, 'suggestion')])
  if (warm) {
    const gain = warm.returns ? `saved ${tildeMoney(warm.saved)}` : 'no returns'
    const result = Math.abs(warm.net) < 0.005 ? 'about even' : warm.net > 0 ? `net ${tildeMoney(warm.net)} saved` : `net ${tildeMoney(-warm.net)} more`
    rows.push(['Keep warm', `${plural(warm.runs, 'run')}: ${gain}, cost ${tildeMoney(warm.cost)}, ${result}${subscription ? ' (API prices)' : ''}`])
  }
  return rows
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
  // The type `other` is no kind of work: it is what the rater files a prompt under when none fits.
  const what = type === 'other' ? `unclassified work (work the rater could not place in a kind) to ${TIER_NAME[tier]}` : `${type} work to ${TIER_NAME[tier]}`
  rows.push(['Hand-downs paused', `${type === 'other' ? `unclassified work to ${TIER_NAME[tier]}` : what}, wrong on ${Math.round(worst.rate * 100)}% of ${worst.n}`])
  const short = `${type === 'other' ? 'unclassified' : type} work to ${TIER_NAME[tier]}`
  return { rows, note: `hand-downs of ${short} (wrong on ${Math.round(worst.rate * 100)}% of ${worst.n}). They resume by themselves when the miss rate falls under Pause after misses (/config).`, paused: `Hand-downs of ${what}, and lowering effort on it, resume when its miss rate falls under the Pause after misses line (/config).` }
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
  const { rows, paused, note } = haikuRows(lines, pause, from)
  const calibration = calibrationRow(lines.filter(l => isRun(l) && !l.aborted))
  return { rows: [...rows, ...(calibration ? [calibration] : [])], ...(paused ? { paused } : {}), ...(note ? { note } : {}) }
}

/** One thing that was off: `n` of `unit` (singular, plural), why, and any detail lines. */
export type Problem = { n: number; unit: [string, string]; reason: string; detail?: string[] }

const TURN: [string, string] = ['turn', 'turns']

/** Turns that cost more, went off course or were left out of the saving; most first. */
export function problems(lines: readonly RunLine[], switches: readonly SwitchLine[], subscription = false) {
  // On a subscription these dollars are what the same use would cost on the API, and say so.
  const usd = (d: number) => `${money(d)}${subscription ? ' API-equivalent' : ''}`
  const runs = lines.filter(l => isRun(l) && !l.aborted)
  const out: Problem[] = []
  const steppedUp = runs.filter(l => l.steppedUp).length
  if (steppedUp) out.push({ n: steppedUp, unit: TURN, reason: 'lowered, then stepped back up: the task was harder than rated' })
  const raised = runs.filter(l => l.escalations?.length)
  if (raised.length) {
    const why = new Map<string, number>()
    for (const l of raised) for (const x of l.escalations ?? []) why.set(x.why.replace(/^\d+ /, 'several '), (why.get(x.why.replace(/^\d+ /, 'several ')) ?? 0) + 1)
    // One sign per line, most first: joined on one line they ran past 80 columns.
    const top = [...why.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w, n]) => `${w} (${n})`)
    out.push({ n: raised.length, unit: TURN, reason: 'raised mid-turn because Claude looked stuck', detail: top })
  }
  const dearer = runs.filter(l => delegated(l) && num(l.stay) > 0 && num(l.actual) > num(l.stay))
  if (dearer.length) {
    const a = dearer.reduce((s, l) => s + num(l.actual), 0)
    const st = dearer.reduce((s, l) => s + num(l.stay), 0)
    out.push({ n: dearer.length, unit: TURN, reason: `hand-off cost more than staying (${money(a)} vs ~${money(st)}${subscription ? ', API-equivalent' : ''})` })
  }
  const rework = runs.filter(l => delegated(l) && num(l.agentCalls) > 1).length
  if (rework) out.push({ n: rework, unit: TURN, reason: 'hand-off needed rework (more than one subagent call)' })
  // A hand-off kept in the main chat for steps only you can approve is not a miss.
  const skipped = runs.filter(l => (l.change === 'delegate-up' || l.change === 'delegate-down') && !delegated(l) && !num(l.approvalSteps)).length
  if (skipped) out.push({ n: skipped, unit: TURN, reason: 'Claude skipped the hand-off you chose and did the work itself' })
  const missed = switches.filter(s => s.kept === false).length
  if (missed) {
    const cost = runs.reduce((s, l) => s + num(l.missCost), 0)
    out.push({ n: missed, unit: ['switch', 'switches'], reason: `missed the cache, of ${plural(switches.length, 'effort switch', 'effort switches')}${cost >= 0.005 ? ` (~${usd(cost)})` : ''}` })
  }
  const fanned = runs.filter(l => l.afterWorkflow)
  if (fanned.length) {
    const flows = fanned.reduce((s, l) => s + num(l.workflows), 0)
    out.push({
      n: fanned.length,
      unit: TURN,
      reason: `ran during or after a workflow (${usd(fanned.reduce((s, l) => s + num(l.actual), 0))})`,
      detail: [`${plural(flows, 'workflow')}, from ultracode or asked for`, 'hand-offs paused in those sessions; nothing learned from them'],
    })
  }
  const unrated = lines.filter(l => l.kind === 'unrated').length
  if (unrated) out.push({ n: unrated, unit: ['prompt', 'prompts'], reason: 'not rated (the rating failed), so nothing was changed' })
  const aborted = lines.filter(l => isRun(l) && l.aborted).length
  if (aborted) out.push({ n: aborted, unit: TURN, reason: 'you stopped (their rating cost still counts)' })
  return out.sort((a, b) => b.n - a.n)
}

/** The problems as rows: count and unit lined up, then the reason, with detail lines under it. */
function problemRows(ps: readonly Problem[]) {
  const unit = (p: Problem) => p.unit[p.n === 1 ? 0 : 1]
  const nw = Math.max(0, ...ps.map(p => String(p.n).length))
  const uw = Math.max(0, ...ps.map(p => unit(p).length))
  // The text column starts after the 2-space indent, the count and unit, and the 3-space gap; it wraps to stay within 78.
  const room = 78 - (2 + nw + 1 + uw + 3)
  const lines = (text: string) => wrap(text, '', '', room)
  return ps.flatMap(p => [
    ...lines(p.reason).map((t, i) => [i === 0 ? `${String(p.n).padStart(nw)} ${unit(p).padEnd(uw)}` : '', t]),
    ...(p.detail ?? []).flatMap(d => lines(d).map(t => ['', t])),
  ])
}

const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}K` : `${Math.round(n)}`)

/** A duration for people: seconds under a minute (one decimal under 10), then minutes and seconds, then hours and minutes. */
export function span(ms: number) {
  const s = Math.max(0, ms) / 1000
  if (s < 9.95) return `${s.toFixed(1)} s`
  const whole = Math.round(s)
  if (whole < 60) return `${whole} s`
  const m = Math.floor(whole / 60)
  if (m < 60) return `${m} min ${String(whole % 60).padStart(2, '0')} s`
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`
}

/** The value at fraction `q` of the sorted values (nearest rank; 0.5 averages the two middle ones of an even count). Needs at least one value. */
function quantile(xs: readonly number[], q: number) {
  const v = [...xs].sort((a, b) => a - b)
  if (q === 0.5 && v.length % 2 === 0) return ((v[v.length / 2 - 1] ?? 0) + (v[v.length / 2] ?? 0)) / 2
  return v[Math.max(0, Math.ceil(q * v.length) - 1)] ?? 0
}

const median = (xs: readonly number[]) => quantile(xs, 0.5)
const p90 = (xs: readonly number[]) => quantile(xs, 0.9)
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

/** The reason an unrated line carries when the rating ran out of its time. */
const BUDGET_REASON = 'rating budget used up'

/**
 * Time, from run lines that carry `ratingMs` (0.8 on); older lines are left out. A task is the run lines that share a `task`
 * (or an `id`). Claude's time per task is rating plus turn time, summed over its runs; time to done runs from the task's
 * first submit to its last turn's end, so it includes your own time between prompts. Undefined when no line has the field.
 */
export function timeRows(lines: readonly RunLine[]) {
  const runs = lines.filter(l => isRun(l) && finite(l.ratingMs))
  const rated = lines.filter(l => l.kind === 'unrated' && finite(l.ratingMs))
  if (!runs.length && !rated.length) return undefined
  const tasks = new Map<string, RunLine[]>()
  for (const l of runs) {
    const key = l.task ?? l.id ?? l.at
    tasks.set(key, [...(tasks.get(key) ?? []), l])
  }
  const group = [...tasks.values()]
  const claude = (t: readonly RunLine[]) => t.reduce((n, l) => n + num(l.ratingMs) + num(l.durationMs), 0)
  const done = group.flatMap(t => {
    const starts = t.map(l => Date.parse(l.submittedAt ?? ''))
    const ends = t.map(l => Date.parse(l.at))
    return starts.every(Number.isFinite) && ends.every(Number.isFinite) ? [Math.max(...ends) - Math.min(...starts)] : []
  })
  const cheaper = group.filter(t => t.some(l => delegated(l) && l.change === 'delegate-down'))
  const stayed = group.filter(t => !t.some(delegated))
  const delays = [...runs, ...rated].map(l => num(l.ratingMs))
  const hit = rated.filter(l => l.reason?.startsWith(BUDGET_REASON)).length
  const per = (g: readonly (readonly RunLine[])[]) => (g.length ? `median ${span(median(g.map(claude)))} over ${plural(g.length, 'task')}` : 'none yet')
  const all = group.map(claude)
  return [
    ['Tasks finished', String(group.length)],
    ["Claude's time per task", all.length ? `median ${span(median(all))}, 90th percentile ${span(p90(all))}` : '–'],
    ['Time to done, with your time', done.length ? `median ${span(median(done))} over ${plural(done.length, 'task')}` : '–'],
    ['Rating delay per prompt', `median ${span(median(delays))}, 90th percentile ${span(p90(delays))}`],
    ['Rating budget used up', `${hit} of ${plural(delays.length, 'prompt')}`],
    ["Claude's time, cheaper route", per(cheaper)],
    ["Claude's time, stayed", per(stayed)],
  ]
}

// ---- Whole tasks -------------------------------------------------------------

/** The lines that carry one task id: its runs, helpers, retries, keep-warm requests and the rater's calls. An empty id has none. */
const ofTask = (lines: readonly RunLine[], task: string) => (task === '' ? [] : lines.filter(l => l.task === task))

/** The prompts of a task that count toward its estimate: rated runs that ran to the end. A stopped turn was redone by a later prompt, which has its own estimate. */
const counted = (lines: readonly RunLine[]) => lines.filter(l => isRun(l) && !l.aborted)

/**
 * ESTIMATED: what rightsize predicted, when it rated each prompt, for the route it chose: the sum of the runs' `taken`
 * (the calibrated estimate of the route taken, the figure the band quoted and ACCURACY compares with `actual`). Stopped turns are left out.
 */
export function taskEstimated(lines: readonly RunLine[], task: string): number {
  return counted(ofTask(lines, task)).reduce((n, l) => n + num(l.taken), 0)
}

/**
 * ACTUAL: everything the task cost. Each run's `actual` (stopped turns and retries too; it already holds the helpers and
 * Claude's subagents that ran in that turn) and the `overhead` of every line that carries the task: the rating calls (also
 * the ones that failed), the rater's checks, and the keep-warm requests. A 'subagent' line adds nothing: its cost is in its run's.
 */
export function taskActual(lines: readonly RunLine[], task: string): number {
  let usd = 0
  for (const l of ofTask(lines, task)) {
    usd += num(l.overhead)
    if (isRun(l)) usd += num(l.actual)
  }
  return usd
}

/** STAY: what staying on the person's own model and level would have cost, the sum of each prompt's `stay` as it was rated. */
export function taskStay(lines: readonly RunLine[], task: string): number {
  return counted(ofTask(lines, task)).reduce((n, l) => n + num(l.stay), 0)
}

/**
 * Where a task's cost above its estimate came from, in dollars: `retries` (stopped turns, and what a turn raised mid-turn
 * or stepped back up cost over its estimate), `helpers` (Claude's subagents moved to a cheaper model, already inside their
 * turns' costs), `warm` (keep-warm requests) and `other` (the rest, rating calls and a bad estimate among them). The parts
 * add up to the extra, `actual - estimated`; when the three named ones come to more than that, they are scaled down to it. Nothing for a task at or under its estimate.
 */
export function taskExtra(lines: readonly RunLine[], task: string) {
  const own = ofTask(lines, task)
  const extra = Math.max(0, taskActual(lines, task) - taskEstimated(lines, task))
  const stopped = own.filter(l => isRun(l) && l.aborted).reduce((n, l) => n + num(l.actual), 0)
  const struggled = own.filter(l => isRun(l) && !l.aborted && (l.steppedUp || l.escalations?.length)).reduce((n, l) => n + Math.max(0, num(l.actual) - num(l.taken)), 0)
  const named = { retries: stopped + struggled, helpers: own.filter(l => l.kind === 'subagent').reduce((n, l) => n + num(l.actual), 0), warm: own.filter(l => l.kind === 'warm').reduce((n, l) => n + num(l.overhead), 0) }
  const sum = named.retries + named.helpers + named.warm
  const scale = sum > extra && sum > 0 ? extra / sum : 1
  const parts = { retries: named.retries * scale, helpers: named.helpers * scale, warm: named.warm * scale }
  return { extra, ...parts, other: Math.max(0, extra - parts.retries - parts.helpers - parts.warm) }
}

/** One finished task with its three figures. */
export type WholeTask = { task: string; type: string; estimated: number; stay: number; actual: number }

/** A task with no line for this long is over, though the rater never said "new goal" after it. */
const TASK_IDLE_MS = DAY

/**
 * The tasks of `lines` that are finished and measurable: a task started in the last 30 days, with at least one rated prompt that
 * ran to the end, every such prompt carrying its estimate and its baseline (older logs lack them: those tasks are left out), and over:
 * a later task began in the same session (the rater said "new goal"), or nothing was logged for it for a day. Its type is the rater's, from its first prompt.
 */
export function wholeTasks(lines: readonly RunLine[], now: number): WholeTask[] {
  const groups = new Map<string, RunLine[]>()
  for (const l of lines) if (l.task) groups.set(l.task, [...(groups.get(l.task) ?? []), l])
  const start = (g: readonly RunLine[]) => Math.min(...g.map(l => Date.parse(l.submittedAt ?? l.at)).filter(Number.isFinite))
  const begun = [...groups.values()].map(g => ({ g, start: start(g), session: g[0]?.session ?? '' }))
  const out: WholeTask[] = []
  for (const { g, start: from, session } of begun) {
    const task = g[0]?.task ?? ''
    const runs = counted(g)
    if (!runs.length || !Number.isFinite(from) || now - from > 30 * DAY) continue
    if (runs.some(l => !(num(l.taken) > 0 && num(l.stay) > 0))) continue
    const last = Math.max(...g.map(l => Date.parse(l.at)).filter(Number.isFinite))
    const replaced = begun.some(o => o.session === session && o.g !== g && o.start > from)
    if (!replaced && now - last < TASK_IDLE_MS) continue
    const first = [...g].filter(isRun).sort((a, b) => Date.parse(a.submittedAt ?? a.at) - Date.parse(b.submittedAt ?? b.at))[0]
    out.push({ task, type: first?.type ?? 'unknown', estimated: taskEstimated(g, task), stay: taskStay(g, task), actual: taskActual(g, task) })
  }
  return out.filter(t => t.estimated > 0)
}

/** Finished tasks needed before the Whole tasks section shows. */
export const WHOLE_MIN = 5
/** A task cost more than its estimate by this factor: its extra is looked into. */
export const OVER_ESTIMATE = 1.5

/**
 * The Whole tasks section's rows, or the one line saying how many more finished tasks it needs. Rows: the median of
 * actual over estimated; the share of tasks that cost more than 1.5 times their estimate, and where the extra of those came
 * from (retries and rework, helpers, keep warm, other); what the tasks saved over staying, task by task (stay less actual; labelled API-equivalent on a subscription); and
 * the median ratio for the five task types with the most tasks. A dollar figure on a subscription is API-equivalent.
 */
export function wholeTaskRows(lines: readonly RunLine[], now: number, subscription: boolean): { rows: string[][] } | { need: string } {
  const tasks = wholeTasks(lines, now)
  if (tasks.length < WHOLE_MIN) return { need: `Whole tasks: ${plural(tasks.length, 'finished task')} so far; this section needs ${WHOLE_MIN}, ${WHOLE_MIN - tasks.length} more to go.` }
  const ratio = (t: WholeTask) => t.actual / t.estimated
  const over = tasks.filter(t => ratio(t) > OVER_ESTIMATE)
  const sums = { retries: 0, helpers: 0, warm: 0, other: 0 }
  for (const t of over) {
    const x = taskExtra(lines, t.task)
    sums.retries += x.retries
    sums.helpers += x.helpers
    sums.warm += x.warm
    sums.other += x.other
  }
  const all = sums.retries + sums.helpers + sums.warm + sums.other
  const pct = (v: number) => `${Math.round((v / all) * 100)}%`
  const came = all > 0 ? `retries/rework ${pct(sums.retries)}, helpers ${pct(sums.helpers)}, keep warm ${pct(sums.warm)}, other ${pct(sums.other)}` : undefined
  const saved = tasks.reduce((n, t) => n + t.stay - t.actual, 0)
  const types = new Map<string, number[]>()
  for (const t of tasks) types.set(t.type, [...(types.get(t.type) ?? []), ratio(t)])
  const top = [...types.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])).slice(0, 5)
  const x = (v: number) => `${v.toFixed(1)}x`
  const rows: string[][] = [
    ['Tasks finished', String(tasks.length)],
    ['Cost vs estimate', `median ${x(median(tasks.map(ratio)))} of the estimate`],
    [`Over ${OVER_ESTIMATE}x`, `${over.length} of ${plural(tasks.length, 'task')} (${Math.round((over.length / tasks.length) * 100)}%)`],
    ...(over.length && came ? [['Extra came from', came]] : []),
    ['Saved vs staying', `${saved >= 0.005 ? `~${money(saved)}` : saved <= -0.005 ? `-${money(-saved)}` : 'even'}${subscription ? ' (API-equivalent)' : ''}`],
    ...top.map(([type, rs], i) => [i === 0 ? 'Median by type' : '', `${type}: ${x(median(rs))} over ${plural(rs.length, 'task')}`]),
  ]
  return { rows }
}

// ---- Keep warm -----------------------------------------------------------------

/**
 * The Keep warm line: how many keep-warm runs, what they saved on the returns that held the cache, what their requests cost,
 * and the net. A run the person never came back to is pure cost. Undefined when there was no keep-warm run. A run is the
 * requests that share `warmRun` (an older line with none counts by its session); a dollar figure on a subscription is API-equivalent.
 */
type KeepWarm = { runs: number; returns: number; saved: number; cost: number; net: number }

/** Keep warm's numbers for the period: runs, returns that held the cache, what those saved, what the pings cost, the net. */
function keepWarm(lines: readonly RunLine[]): KeepWarm | undefined {
  const pings = lines.filter(l => l.kind === 'warm')
  const t = totals(lines.filter(l => l.kind === 'warmSaved'))
  if (!pings.length && !t.returns) return undefined
  const runs = new Set(pings.map(l => l.warmRun ?? `session ${l.session ?? ''}`)).size
  const cost = pings.reduce((n, l) => n + num(l.overhead), 0)
  return { runs, returns: t.returns, saved: t.keptSaved, cost, net: t.keptSaved - cost }
}

export function keepWarmLine(lines: readonly RunLine[], subscription: boolean): string | undefined {
  const w = keepWarm(lines)
  if (!w) return undefined
  const t = { returns: w.returns, keptSaved: w.saved }
  const { runs, cost, net } = w
  const result = Math.abs(net) < 0.005 ? 'net about even' : net > 0 ? `net ${tildeMoney(net)} saved` : `net ${tildeMoney(-net)} more`
  const gain = t.returns ? `saved ${tildeMoney(t.keptSaved)} on ${plural(t.returns, 'return')}` : 'saved nothing: no returns'
  return `Keep warm: ${plural(runs, 'run')} · ${gain} · cost ${tildeMoney(cost)} · ${result}${subscription ? ' (API-equivalent)' : ''}`
}

/** A part or memory file this large (tokens) is flagged in the fixed-context block. About the 40,000 characters at which Claude Code itself warns about a large CLAUDE.md. */
export const LARGE_FIXED = 10_000

/**
 * Names, largest first, as many as fit in `room` columns with the rest counted ("+N more"); the largest is always named.
 * Each name carries its size.
 */
function nameWithin(items: readonly (readonly [string, number])[], room: number) {
  const named: string[] = []
  for (const [n, t] of items) {
    const rest = items.length - named.length - 1
    const row = [...named, `${n} ${k(t)}`].join(', ') + (rest ? `, +${rest} more` : '')
    if (named.length && row.length > room) break
    named.push(`${n} ${k(t)}`)
  }
  return named.join(', ') + (named.length < items.length ? `, +${items.length - named.length} more` : '')
}

/** The context every request carried, by part (largest first), request-weighted, what re-reading it cost, and how to cut it. */
export function fixedBlock(lines: readonly RunLine[], subscription = false) {
  const runs = lines.filter(l => isRun(l) && l.fixed && num(l.requests) > 0)
  const requests = runs.reduce((n, l) => n + num(l.requests), 0)
  const cost = runs.reduce((n, l) => n + num(l.fixed?.cost), 0)
  if (!requests || cost < 0.005) return undefined
  const avg = (part: 'tokens' | 'mcp' | 'memory' | 'agents' | 'skills') => runs.reduce((n, l) => n + num(l.fixed?.[part]) * num(l.requests), 0) / requests
  // SessionStart output, over the turns that measured it: undefined when none did (no line says it, or the messages could not be read).
  const measured = runs.filter(l => typeof l.fixed?.startHooks === 'number')
  const measuredRequests = measured.reduce((n, l) => n + num(l.requests), 0)
  const hooks = measuredRequests ? measured.reduce((n, l) => n + num(l.fixed?.startHooks) * num(l.requests), 0) / measuredRequests : undefined
  const last = runs[runs.length - 1]?.fixed
  const byLargest = (r: Record<string, number> | undefined) => Object.entries(r ?? {}).sort((a, b) => b[1] - a[1])
  const servers = byLargest(last?.servers)
  const files = byLargest(last?.files)
  const parts = [
    [avg('mcp'), 'MCP tools', servers, "disconnect MCP servers you don't use (/mcp)"],
    [avg('memory'), 'Memory', files, 'trim CLAUDE.md and MEMORY.md (/memory)'],
    [avg('skills'), 'Skills', [], "turn off plugins and skills you don't use (/plugin)"],
    [avg('agents'), 'Agents', [], "remove custom agents you don't use (/agents)"],
    [hooks ?? 0, 'SessionStart hooks', [], "turn off plugins whose SessionStart hooks you don't use (/plugin), or trim your own hooks' output"],
  ] as const
  const big = parts.filter(([t]) => t >= 500).sort((a, b) => b[0] - a[0])
  const labels = big.map(([, label], i) => `${i === big.length - 1 ? '└─' : '├─'} ${label}`)
  // Servers and files are named largest first while the row stays within 80 columns (indent, label, size and gaps come first); the rest are counted. The largest is always named.
  const room = 80 - (2 + Math.max(0, ...labels.map(l => l.length)) + 3 + Math.max(0, ...big.map(([t]) => k(t).length)) + 3)
  const tree = big.map(([t, , names], i) => [labels[i] ?? '', k(t), ...(names.length ? [nameWithin(names, room)] : [])])
  // The advice follows the biggest parts, so it names what would cut the most.
  const how = big.slice(0, 2).map(([, , , fix]) => fix).join(', or ')
  const spent = runs.reduce((n, l) => n + num(l.actual), 0)
  // The share is of what those same turns cost (their actual spend), not of all spend.
  const pct = spent > 0 ? `, ~${Math.round((cost / spent) * 100)}% of what those turns cost` : ''
  // A memory file or the start hooks at LARGE_FIXED or more, largest first.
  const large = [...files.map(([n, t]) => [n, t] as const), ['SessionStart hooks', hooks ?? 0] as const].filter(([, t]) => t >= LARGE_FIXED).sort((a, b) => b[1] - a[1])
  return {
    head: `~${k(avg('tokens'))} tokens sent with every request`,
    notes: [
      `Fixed context adds to your ${subscription ? 'usage' : 'cost'} in every session. Cutting it saves more.`,
      `At least ~${money(cost)}${subscription ? ' API-equivalent' : ''} over ${plural(requests, 'request')}${pct}.`,
      ...(large.length ? [`Large: ${large.map(([n, t]) => `${n} ${k(t)}`).join(', ')}.`] : []),
      // Said, never shown as 0: the total above leaves it out.
      ...(hooks === undefined ? ['SessionStart hooks: not measured.'] : []),
    ],
    tree,
    ...(how ? { fix: `rightsize can't trim fixed context. To cut it: ${how}.` } : {}),
    ...(how
      ? {
          rec: `Cut fixed context. ~${k(avg('tokens'))} tokens go with every request: at least ~${money(cost)}${subscription ? ' at API prices' : ''} in 30 days${pct}. Largest: ${big
            .slice(0, 2)
            .map(([t, label]) => `${label} ${k(t)}`)
            .join(', ')}. To cut it: ${how}.`,
        }
      : {}),
  }
}

const TRIM_LABEL: Record<string, string> = { output_cap: 'Command output cut', tool_cleanup: 'Tool results cleaned', repeat_reads: 'Repeat reads', browser_scale: 'Browser screenshots' }
const TRIM_NOTE = 'Read from trim\'s savings log. "assumed" means a fixed estimate per use, not a measurement. Tokens only, not dollars.'
const tokensText = (n: number) => (n >= 1000 ? `${(Math.round(n / 100) / 10).toFixed(1)}K` : `${Math.round(n)}`)

/** Rows for the trim section (feature, all time, last 30 days), or undefined when trim saved nothing. */
export function trimRows(trim: TrimSavings | undefined) {
  if (!trim) return undefined
  const cell = (s: TrimSum | undefined) => (s && s.tokens > 0 ? `${tokensText(s.tokens)}${s.assumed ? ' assumed' : ''}` : '–')
  const names = [...new Set([...Object.keys(trim.allTime), ...Object.keys(trim.last30)])].filter(f => (trim.allTime[f]?.tokens ?? 0) > 0 || (trim.last30[f]?.tokens ?? 0) > 0)
  if (!names.length) return undefined
  const order = Object.keys(TRIM_LABEL)
  names.sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99))
  return [['', 'All time', '30 days'], ...names.map(f => [TRIM_LABEL[f] ?? f, cell(trim.allTime[f]), cell(trim.last30[f])])]
}

export function buildReport(
  lines: readonly RunLine[],
  switches: readonly SwitchLine[],
  opts: { now: number; session: string; subscription: boolean; start?: StartBlock; pause?: number | null; measureFrom?: string; markdown?: boolean; watching?: boolean; lifetime?: Lifetime; details?: boolean; trim?: TrimSavings },
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
  const para = (text: string, first = '', rest = '') => (md ? [text] : wrap(text, first, rest || first, 78))
  const section = (t: string, rows: readonly string[]) => ['', t, ...indent(rows)]
  const from = opts.measureFrom ? Date.parse(opts.measureFrom) : 0
  const thirty = stats(month, sub, true)
  const fixed = fixedBlock(month, sub)
  const start = opts.start
  const accuracy = accuracyRows(month, opts.pause, from)
  if (opts.details) return detailsReport()

  // Today (since local midnight), 7 days, 30 days and lifetime. All are estimates.
  const midnight = new Date(opts.now).setHours(0, 0, 0, 0)
  const cols = [stats(lines.filter(l => Date.parse(l.at) >= midnight), sub), stats(lines.filter(since(7)), sub), thirty, lifetimeStats(opts.lifetime, lines, sub)]
  const nothing = thirty.empty
  const out = ['rightsize report · last 30 days', ...(nothing ? [cols[3]?.empty ? 'Nothing rated yet.' : 'Nothing rated in the last 30 days.'] : headline(thirty, sub).flatMap(h => para(h)))]
  if (opts.measureFrom) out.push(`Cost measurement restarted on ${opts.measureFrom.slice(0, 10)}.`)
  if (!cols.every(s => s.empty)) out.push(...section('YOUR SAVINGS', savingsTable(cols, sub)))

  const warm = keepWarm(month)
  const summary = summaryRows(thirty, warm, sub)
  if (summary.length) out.push(...section('30-DAY SUMMARY', grid(summary)))
  const trimmed = trimRows(opts.trim)
  if (trimmed) out.push(...section('TRIM SAVINGS (tokens, estimated)', grid(trimmed)), ...para(TRIM_NOTE, md ? '' : '  '))
  // Watch only: what rightsize would have done, and what that would have saved, against staying. Nothing was applied.
  const watched = watchLine(month, sub, opts.watching === true)
  if (watched) out.push('', ...para(watched))

  // What to do, from the sections in details: fixed context, the start, keep warm. Then what needs no action.
  const recs = [
    fixed?.rec,
    start?.tip,
    warm && warm.net <= -0.005 ? `Keep warm cost more than it saved (${tildeMoney(-warm.net)} more${sub ? ' at API prices' : ''}). Set Before the cache goes cold to a shorter keep warm, or to ask (/config).` : undefined,
  ].filter((n): n is string => !!n)
  const notes = [
    ...(start?.fits ? [`Checked, no change needed: ${start.fits}.`] : []),
    ...(accuracy.note ? [`Paused: ${accuracy.note}`] : []),
  ]
  if (recs.length || notes.length) {
    out.push('', 'RECOMMENDATIONS')
    recs.forEach((r, i) => out.push(...(md ? [`${i + 1}. ${r}`] : wrap(r, `  ${i + 1}. `, '     ', 78))))
    for (const n of notes) out.push(...(md ? [`- ${n}`] : wrap(n, '  ', '  ', 78)))
  }

  const foot = [
    ...(nothing ? [] : ['Details: /rightsize report details']),
    `Estimates: actual cost against staying at your own model and effort, after the cost of rating prompts${month.some(l => l.kind === 'warm') ? ' and keeping the cache warm' : ''}.`,
    ...(cols.some(s => s.t.extra > 0.005) ? ["Extra on hard prompts: raising effort or using a stronger model, for better answers. It isn't taken off the saving."] : []),
    ...(sub && cols.some(s => s.kept?.mins) ? ["Extra work time is Claude's working time at your usual pace."] : []),
    ...(sub && cols.some(s => s.kept) ? ['Ranges: the rate limits report whole percents.'] : []),
    ...(cols[3]?.empty ? [] : [`Lifetime counts from ${lifetimeSince(opts.lifetime, lines)}.`]),
    ...(sub ? ['Dollar figures are API prices: what the same use would cost on the API. You pay only your subscription.'] : []),
  ]
  out.push('', ...foot.flatMap(f => para(f)))
  return out.join('\n')

  /** /rightsize report details: the sections behind the numbers, for the last 30 days. */
  function detailsReport() {
    const out = ['rightsize report details · last 30 days']
    if (opts.measureFrom) out.push(`Cost measurement restarted on ${opts.measureFrom.slice(0, 10)}.`)
    if (start) out.push('', `STARTING POINT  ${start.head}`, ...indent(grid(start.rows)), ...(start.note ? para(start.note, '  ') : []))
    if (fixed) out.push('', `FIXED CONTEXT  ${fixed.head}`, ...fixed.notes.flatMap(n => para(n, '  ')), ...indent(grid(fixed.tree, [1])))
    const ties = thirty.ties && thirty.ties.guided + thirty.ties.explored > 0 ? [['Close calls', `${thirty.ties.guided} guided, ${thirty.ties.explored} explored`]] : []
    const acc = [...accuracy.rows, ...ties]
    if (acc.length) out.push(...section('ACCURACY', grid(acc)))
    const problem = problems(month, switches.filter(since(30)), sub)
    out.push(...(problem.length ? section('NOT COUNTED AS SAVINGS', grid(problemRows(problem))) : ['', 'NOT COUNTED AS SAVINGS', md ? 'Nothing yet.' : '  Nothing yet.']))
    // Time is measured and reported here; it never chooses a route.
    const time = timeRows(month)
    out.push(...(time ? section('TIME', grid(time)) : ['', 'Time: not measured yet (needs prompts from rightsize 0.8).']))
    // What a whole task cost against its estimate, from its first prompt to the rater's "new goal".
    const whole = wholeTaskRows(lines, opts.now, sub)
    out.push(...('rows' in whole ? section('WHOLE TASKS', grid(whole.rows)) : ['', ...(thirty.empty ? [] : para(whole.need, '', '  '))]))
    const t = thirty.t
    const foot = [
      'Estimated: actual cost vs staying at your own model and effort.',
      ...(thirty.empty ? [] : [`The saving is after the cost of rating prompts${month.some(l => l.kind === 'warm') ? ' and of keeping the cache warm' : ''} (${money(t.overhead)}${sub ? ' API-equivalent' : ''} in 30 days)${month.some(l => l.kind === 'warm' || l.kind === 'warmSaved') ? ', and counts what keeping it warm saved when you came back to a warm cache' : ''}.`]),
      ...(t.extra > 0.005
        ? [sub ? "Extra on hard prompts: what raising effort or using a stronger model would cost on the API, for better answers. It isn't taken off the saving." : "Extra on hard prompts: what raising effort or using a stronger model cost, for better answers. It isn't taken off the saving."]
        : []),
      ...(thirty.empty ? [] : [stepLine(lines, from)]),
      ...(sub ? ['Dollar amounts are API-equivalent: what the same use would cost on the API.', 'You only pay for your subscription.'] : []),
    ]
    out.push('', ...foot.flatMap(f => para(f)))
    return out.join('\n')
  }
}

/**
 * The report's line for watch-only runs: how many prompts rightsize would have changed, and what those changes were
 * estimated to save against staying (the estimate of the route it would have taken, against the estimate of staying).
 * `watching` says whether the mode is on now; the line still shows for a month with watched runs.
 */
export function watchLine(lines: readonly RunLine[], subscription: boolean, watching: boolean) {
  const runs = lines.filter(l => (l.kind ?? 'run') === 'run' && !l.aborted && l.would !== undefined)
  if (!runs.length) return watching ? 'Watch only is on: every prompt is rated and planned, nothing is applied. Nothing to show yet.' : ''
  const changed = runs.filter(l => l.would !== 'none')
  const saving = changed.reduce((s, l) => s + ((l.stay ?? 0) - (l.wouldTaken ?? 0)), 0)
  const what = `would have ${saving >= 0 ? 'saved' : 'spent'} ~${money(Math.abs(saving))}${subscription ? ' API-equivalent' : ''}`
  return `Watch only: ${plural(runs.length, 'prompt')} rated, ${changed.length} would have been changed, which ${what} against staying (estimates; nothing was applied).${watching ? ' Mode in /config turns rightsize on.' : ''}`
}

export const SHARE_MIN_RATED = 20
export const SHARE_MIN_PCT = 5
const SHARE_LINK = 'https://aivalue.blog/rightsize'

/**
 * /rightsize share: a message to paste anywhere, with the last 30 days' estimated saving once there is enough data.
 * Prints only, sends nothing. Same totals and percentage as the report.
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
      `The number is rightsize's estimate from your last 30 days (${t.rated} rated prompts)${opts.subscription ? ', as a share of API-equivalent cost, not money' : ''}; /rightsize report shows the details. Edit the message as you like.`,
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
