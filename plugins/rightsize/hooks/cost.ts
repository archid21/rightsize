import type {
  RightsizeLevel as Level,
  RightsizeTaskType as TaskType,
  RightsizeTier as Tier,
} from '../types'

// The cost model: what a prompt is likely to cost in the main chat versus
// handed to a subagent, from the rating's token guesses, the price table and
// what past runs really cost (calibration). Pure functions, no engine calls.

export const LEVELS: readonly Level[] = ['low', 'medium', 'high', 'xhigh', 'max']
export const TIERS: readonly Tier[] = ['haiku', 'sonnet', 'opus', 'fable']
export const TASK_TYPES: readonly TaskType[] = [
  'lookup',
  'search',
  'bulk-edit',
  'extract',
  'summarize',
  'feature',
  'debug',
  'refactor',
  'review',
  'design',
  'writing',
  'other',
]
export const TIER_NAME: Record<Tier, string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus', fable: 'Fable' }
// The API's default effort per model, used before the session's own level is seen.
export const DEFAULT_LEVEL: Record<Tier, Level> = { haiku: 'medium', sonnet: 'high', opus: 'medium', fable: 'high' }

export const isLevel = (v: unknown): v is Level => typeof v === 'string' && (LEVELS as readonly string[]).includes(v)
export const isTier = (v: unknown): v is Tier => typeof v === 'string' && (TIERS as readonly string[]).includes(v)
export const isTaskType = (v: unknown): v is TaskType => typeof v === 'string' && (TASK_TYPES as readonly string[]).includes(v)
export const levelRank = (l: Level) => LEVELS.indexOf(l)
export const tierRank = (t: Tier) => TIERS.indexOf(t)
export const tierOf = (model: string | null | undefined): Tier | undefined => {
  const m = (model ?? '').toLowerCase()
  return TIERS.find(t => m.includes(t))
}

// ---- Prices ----------------------------------------------------------------

/** US dollars per 1 million tokens. */
export type Price = { input: number; output: number; cacheRead: number; cacheWrite: number }
export type Prices = Record<Tier, Price>

// Anthropic first-party prices from the pricing page, checked 2026-10-23;
// prices.json beside the mod overrides them. cacheWrite is the 1-hour TTL (2x input),
// the one Claude Code sessions usually write.
export const DEFAULT_PRICES: Prices = {
  haiku: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.2 },
  sonnet: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 4 },
  opus: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 8 },
  fable: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 20 },
}

const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback)

// Reads prices.json. Any field that is missing or not a number keeps the default.
export function parsePrices(raw: string): Prices {
  let json: { cacheTtl?: unknown; models?: Record<string, Record<string, unknown> | undefined> } = {}
  try {
    json = JSON.parse(raw) as typeof json
  } catch {
    return DEFAULT_PRICES
  }
  const writeKey = json.cacheTtl === '5m' ? 'cacheWrite5m' : 'cacheWrite1h'
  const out = { ...DEFAULT_PRICES }
  for (const t of TIERS) {
    const m = json.models?.[t] ?? {}
    const d = DEFAULT_PRICES[t]
    const input = num(m.input, d.input)
    out[t] = {
      input,
      output: num(m.output, d.output),
      cacheRead: num(m.cacheRead, d.cacheRead),
      cacheWrite: num(m[writeKey], input * (writeKey === 'cacheWrite1h' ? 2 : 1.25)),
    }
  }
  return out
}

/** How long a cache write lives: prices.json's cacheTtl, 1 hour unless it says 5m. */
export function cacheTtlMs(raw: string) {
  try {
    return (JSON.parse(raw) as { cacheTtl?: unknown }).cacheTtl === '5m' ? 5 * 60_000 : 60 * 60_000
  } catch {
    return 60 * 60_000
  }
}

export type Tokens = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
export const dollars = (p: Price, t: Tokens) =>
  ((t.input ?? 0) * p.input + (t.output ?? 0) * p.output + (t.cacheRead ?? 0) * p.cacheRead + (t.cacheWrite ?? 0) * p.cacheWrite) / 1e6

export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}
export const contextOf = (u: Usage) => u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens

// What one API response cost. An unknown model costs nothing rather than a guess.
export function usageCost(prices: Prices, model: string, u: Usage) {
  const t = tierOf(model)
  if (!t) return 0
  return dollars(prices[t], {
    input: u.input_tokens,
    output: u.output_tokens,
    cacheRead: u.cache_read_input_tokens,
    cacheWrite: u.cache_creation_input_tokens,
  })
}

// ---- Rating ----------------------------------------------------------------

/** Per model, the lowest level it does the work well at; null where it would struggle, absent where unknown. */
export type Fit = Partial<Record<Tier, Level | null>>

export type Rating = {
  /** The level the work needs on the session's model (see needOn). */
  level: Level
  fit: Fit
  size: 'small' | 'bulky'
  type: TaskType
  /** Tokens of files, logs and tool output the work reads. */
  read: number
  /** Tokens the work writes, thinking left out. */
  write: number
  /** Tool calls the work makes. */
  steps: number
  reason: string
}

/** The level `tier` needs; where it would struggle, the level of the nearest stronger model that fits, else max. */
export function needOn(fit: Fit, tier: Tier): Level {
  const own = fit[tier]
  if (own) return own
  return TIERS.filter(t => tierRank(t) > tierRank(tier))
    .map(t => fit[t])
    .find(isLevel) ?? 'max'
}

// ---- Calibration -----------------------------------------------------------

/** Per key, how many runs were seen and the mean of actual / estimated. */
export type Calibration = Record<string, { n: number; ratio: number }>
/** Runs per key before the measured ratio fully replaces the guess. */
export const CAL_FULL = 20
/** Key for the share of effort switches that cost a cache miss (prior: all of them). */
export const SWITCH_KEY = 'cache:effort-switch'
export const calKey = (type: TaskType, route: 'main' | 'delegate') => `${type}:${route}`
/** A route's keys, from the most general to the most specific: the task type, then the model, then the model at its level. */
export const routeKeys = (type: TaskType, route: 'main' | 'delegate', tier: Tier, level: Level) => [
  calKey(type, route),
  `${type}:${route}:${tier}`,
  `${type}:${route}:${tier}:${level}`,
]
export const mainKeys = (type: TaskType, tier: Tier, level: Level) => routeKeys(type, 'main', tier, level)
export const delegateKeys = (type: TaskType, tier: Tier, level: Level) => routeKeys(type, 'delegate', tier, level)

// Each key's measured ratio stands on the one before it as its prior, so a model
// and level with few runs leans on what the task type as a whole has shown.
export const routeFactor = (cal: Calibration, keys: readonly string[]) => keys.reduce((prior, key) => factor(cal, key, prior), 1)

export function parseCalibration(v: unknown): Calibration {
  const out: Calibration = {}
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out
  for (const [k, e] of Object.entries(v as Record<string, unknown>)) {
    const { n, ratio } = (e ?? {}) as { n?: unknown; ratio?: unknown }
    if (typeof n === 'number' && n > 0 && typeof ratio === 'number' && Number.isFinite(ratio)) out[k] = { n, ratio }
  }
  return out
}

// The measured ratio, blended with the prior until CAL_FULL runs are in.
export function factor(cal: Calibration, key: string, prior = 1) {
  const e = cal[key]
  if (!e) return prior
  const w = Math.min(e.n, CAL_FULL) / CAL_FULL
  return prior + (e.ratio - prior) * w
}

// A running mean that turns into a moving average after 50 runs, so old runs fade.
export function learn(cal: Calibration, key: string, sample: number): Calibration {
  const e = cal[key] ?? { n: 0, ratio: 0 }
  const n = e.n + 1
  return { ...cal, [key]: { n, ratio: e.ratio + (sample - e.ratio) / Math.min(n, 50) } }
}

export const ratioSample = (actual: number, estimated: number) =>
  estimated > 0 ? Math.min(10, Math.max(0.1, actual / estimated)) : 1

// ---- Estimates -------------------------------------------------------------

// Thinking is billed as output and grows with effort; calibration corrects the guess.
export const EFFORT_OUT: Record<Level, number> = { low: 1, medium: 1.6, high: 2.5, xhigh: 3.5, max: 5 }
const PROMPT = 200
const BRIEF = 1500
const REPORT = 1500
const FINAL = 800
/** A subagent's own system prompt and tool list, read fresh at full price. */
const SUB_BASE = 15000
const CHECK_CAP = 20000

export type Situation = {
  tier: Tier
  /** The effort the next request would run at with no change. */
  level: Level
  /** Tokens in the main conversation. */
  context: number
  prices: Prices
  cal: Calibration
  /** The hand-off and lowering shares; DEFAULT_RULES when absent. */
  rules?: Rules
}

/** The main chat doing the work at `level`, before calibration. */
export function rawMainCost(r: Rating, s: Situation, level: Level) {
  const steps = Math.max(1, Math.round(r.steps))
  // Each step re-reads the conversation from cache; what the work reads is written once.
  return dollars(s.prices[s.tier], {
    cacheRead: steps * s.context + ((steps - 1) * r.read) / 2,
    cacheWrite: r.read + PROMPT,
    output: r.write * EFFORT_OUT[level],
  })
}

/** What `switches` effort changes cost: each one may make the next request re-write the whole conversation. */
export function switchCost(s: Situation, switches: number) {
  const p = s.prices[s.tier]
  const miss = dollars(p, { cacheWrite: s.context }) - dollars(p, { cacheRead: s.context })
  return switches * factor(s.cal, SWITCH_KEY, 1) * miss
}

export function mainCost(r: Rating, s: Situation, level: Level, switches: number) {
  return rawMainCost(r, s, level) * routeFactor(s.cal, mainKeys(r.type, s.tier, level)) + switchCost(s, switches)
}

const reworkFactor = (main: Tier, sub: Tier) => (tierRank(sub) >= tierRank(main) ? 1.2 : sub === 'haiku' ? 1.5 : 1.3)

/** A subagent's own requests on `sub`: it starts with no cache, so its base and the brief are written fresh. */
function subWork(r: Rating, s: Situation, sub: Tier, subLevel: Level) {
  const steps = Math.max(1, Math.round(r.steps))
  return dollars(s.prices[sub], {
    cacheWrite: SUB_BASE + BRIEF + r.read,
    cacheRead: steps * (SUB_BASE + BRIEF) + ((steps - 1) * r.read) / 2,
    output: r.write * EFFORT_OUT[subLevel] + REPORT,
  })
}

/** The work handed to a subagent on `sub`, before calibration: brief, work, check, likely rework. */
export function rawDelegateCost(r: Rating, s: Situation, sub: Tier, subLevel: Level) {
  // The main chat writes the brief, reads the report, checks the result and answers.
  const main = dollars(s.prices[s.tier], {
    cacheRead: 3 * s.context,
    cacheWrite: REPORT + Math.min(CHECK_CAP, r.read * 0.2) + PROMPT,
    output: (BRIEF + FINAL) * EFFORT_OUT.medium,
  })
  return (main + subWork(r, s, sub, subLevel)) * reworkFactor(s.tier, sub)
}

export function delegateCost(r: Rating, s: Situation, sub: Tier, subLevel: Level) {
  return rawDelegateCost(r, s, sub, subLevel) * routeFactor(s.cal, delegateKeys(r.type, sub, subLevel))
}

// ---- Plans -----------------------------------------------------------------

export type Plan =
  | { kind: 'none'; why: string }
  | { kind: 'effort'; dir: 'lower' | 'raise'; level: Level; saving?: number }
  | {
      kind: 'delegate'
      dir: 'up' | 'down'
      tier: Tier
      level: Level
      delegateCost: number
      /** Staying on the session's model: at the level it needs when that is higher, else the cheaper of now and that level. */
      mainCost: number
      /** The level the session's model would need; absent when it would struggle. */
      instead?: Level
    }

/** Hand work down only when the subagent route costs under this share of staying. */
export const SAVING_RULE = 0.7
/** Lower effort only when the lower level, cache cost included, costs under this share of staying. */
export const LOWER_RULE = 0.9

/** The two shares above, as the person set them in /config. */
export type Rules = { handOff: number; lower: number }
export const DEFAULT_RULES: Rules = { handOff: SAVING_RULE, lower: LOWER_RULE }

/** A /config share such as "70%" as 0.7; anything else, the fallback. */
export function parseShare(v: unknown, fallback: number) {
  const m = typeof v === 'string' ? /^(\d{1,3})%$/.exec(v.trim()) : null
  const n = m ? Number(m[1]) / 100 : NaN
  return n > 0 && n <= 1 ? n : fallback
}

// ---- Idle resume -------------------------------------------------------------

/** Over this, Claude Code compacts an idle session itself before the cache expires. */
export const IDLE_MAX_CONTEXT = 200_000

/** Sending into an expired cache: what writing the conversation again costs over reading it warm, and what /compact's read costs. */
export function idleCost(p: Price, context: number) {
  return { resend: dollars(p, { cacheWrite: context }) - dollars(p, { cacheRead: context }), compact: dollars(p, { input: context }) }
}

/** "over $0.50" from /config as 0.5; "off" as null; anything else, the default. */
export function parseIdleWarning(v: unknown): number | null {
  if (v === 'off') return null
  const m = typeof v === 'string' ? /^over \$(\d+(?:\.\d+)?)$/.exec(v.trim()) : null
  return m ? Number(m[1]) : 0.1
}

// ---- Pacing ----------------------------------------------------------------

/** One rate-limit window as a response reports it. */
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Pace = {
  /** hot: on pace to hit a limit before it resets. cool: much of a window will go unused. max: a window is nearly used up. */
  mode: 'normal' | 'hot' | 'cool' | 'max'
  window?: 'five_hour' | 'seven_day'
  /** Share of the window used over share of its time gone. */
  pace?: number
  used?: number
}
export const NORMAL_PACE: Pace = { mode: 'normal' }
const WINDOW_MS = { five_hour: 5 * 3600_000, seven_day: 7 * 24 * 3600_000 } as const
/** Pace in the first part of a window says little: a few prompts look like a flood. */
export const PACE_FROM = 0.15
export const HOT_PACE = 1.2
export const COOL_PACE = 0.6
export const MAX_USED = 90

// The window that would stop the person first: one nearly used up, else the one
// with the highest pace. A gateway's spend limit has no reset to pace against.
export function paceOf(limits: readonly Limit[], now: number): Pace {
  let worst: Pace = NORMAL_PACE
  for (const l of limits) {
    if (l.kind !== 'five_hour' && l.kind !== 'seven_day') continue
    if (l.percentUsed >= MAX_USED) {
      if (worst.mode !== 'max' || l.percentUsed > (worst.used ?? 0)) worst = { mode: 'max', window: l.kind, used: l.percentUsed }
      continue
    }
    const reset = l.resetsAt ? Date.parse(l.resetsAt) : NaN
    if (!Number.isFinite(reset) || worst.mode === 'max') continue
    const gone = 1 - (reset - now) / WINDOW_MS[l.kind]
    if (gone < PACE_FROM || gone > 1) continue
    const pace = l.percentUsed / 100 / gone
    if (worst.pace === undefined || pace > worst.pace) {
      worst = { mode: pace > HOT_PACE ? 'hot' : pace < COOL_PACE ? 'cool' : 'normal', window: l.kind, pace, used: l.percentUsed }
    }
  }
  return worst
}

/** The thresholds at this pace: looser when running hot, stricter when running cool. */
export function pacedRules(rules: Rules, p: Pace): Rules {
  if (p.mode === 'max') return { handOff: Math.max(rules.handOff, 0.95), lower: 1 }
  if (p.mode === 'hot') return { handOff: Math.min(0.95, rules.handOff + 0.15), lower: Math.min(0.99, rules.lower + 0.07) }
  if (p.mode === 'cool') return { handOff: Math.max(0.3, rules.handOff - 0.2), lower: Math.max(0.5, rules.lower - 0.1) }
  return rules
}

const WINDOW_NAME = { five_hour: '5-hour', seven_day: '7-day' } as const

/** Why the thresholds moved, for the band; empty at a normal pace. */
export function paceNote(p: Pace) {
  if (p.mode === 'normal' || !p.window) return ''
  const w = WINDOW_NAME[p.window]
  if (p.mode === 'max') return `${Math.round(p.used ?? 0)}% of the ${w} window is used, so rightsize saves all it can.`
  if (p.mode === 'hot') return `The ${w} window is on pace to run out before it resets, so rightsize saves harder.`
  return `Much of the ${w} window will go unused, so rightsize puts quality first.`
}

const clampFloor = (l: Level, floor: Level) => (levelRank(l) < levelRank(floor) ? floor : l)

// The effort-only plan: lower or raise on the main model, or nothing.
export function effortPlan(r: Rating, s: Situation, floor: Level): Plan {
  const target = clampFloor(r.level, floor)
  if (target === s.level) return { kind: 'none', why: 'the level in use fits' }
  if (levelRank(target) > levelRank(s.level)) return { kind: 'effort', dir: 'raise', level: target }
  // A per-prompt lower switches twice: down for this turn, back for the next.
  const now = mainCost(r, s, s.level, 0)
  const lowered = mainCost(r, s, target, 2)
  if (lowered >= now * (s.rules ?? DEFAULT_RULES).lower) return { kind: 'none', why: `lowering to ${target} saves less than the cache it costs` }
  return { kind: 'effort', dir: 'lower', level: target, saving: now - lowered }
}

// Every model that fits is a route: the session's model at its level in the main
// chat, each other model at its own level as a subagent. When the session's model
// would struggle, the cheapest stronger route that fits. Otherwise the cheapest
// cheaper route, when it costs under the hand-off share of staying at the level
// the work needs (a raise counted with its switch there and back); else an effort change.
export function plan(r: Rating, s: Situation, floor: Level): Plan {
  const stay = mainCost(r, s, s.level, 0)
  const routes = TIERS.flatMap(t => {
    const need = r.fit[t]
    if (t === s.tier || !need) return []
    const level = clampFloor(need, floor)
    return [{ tier: t, level, cost: delegateCost(r, s, t, level) }]
  }).sort((a, b) => a.cost - b.cost)
  const own = r.fit[s.tier]
  if (!own) {
    const up = routes.find(x => tierRank(x.tier) > tierRank(s.tier))
    if (up) return { kind: 'delegate', dir: 'up', tier: up.tier, level: up.level, delegateCost: up.cost, mainCost: stay }
    return effortPlan(r, s, floor)
  }
  const level = clampFloor(own, floor)
  const atNeed = mainCost(r, s, level, level === s.level ? 0 : 2)
  const alt = levelRank(level) > levelRank(s.level) ? atNeed : Math.min(stay, atNeed)
  const down = routes.find(x => tierRank(x.tier) < tierRank(s.tier))
  if (down && down.cost < (s.rules ?? DEFAULT_RULES).handOff * alt) {
    return { kind: 'delegate', dir: 'down', tier: down.tier, level: down.level, delegateCost: down.cost, mainCost: alt, instead: level }
  }
  return effortPlan(r, s, floor)
}

// A subagent Claude starts on its own runs on its parent's model unless the call
// names one. Its brief is rated like a prompt: the cheapest weaker model that fits,
// at its own level, when its work (likely rework counted) costs under the hand-off
// share of running on the parent. Never a stronger model, and nothing when the
// parent itself would struggle: that is Claude's call, not a saving.
export type SubagentSize = { tier: Tier; level: Level; cost: number; parentCost: number }

export function sizeSubagent(r: Rating, s: Situation, parent: Tier, floor: Level): SubagentSize | undefined {
  const own = r.fit[parent]
  if (!own) return undefined
  const parentCost = subWork(r, s, parent, clampFloor(own, floor)) * reworkFactor(parent, parent)
  const best = TIERS.flatMap(t => {
    const need = r.fit[t]
    if (tierRank(t) >= tierRank(parent) || !need) return []
    const level = clampFloor(need, floor)
    return [{ tier: t, level, cost: subWork(r, s, t, level) * reworkFactor(parent, t), parentCost }]
  }).sort((a, b) => a.cost - b.cost)[0]
  return best && best.cost < (s.rules ?? DEFAULT_RULES).handOff * parentCost ? best : undefined
}

// ---- Wording ---------------------------------------------------------------

export const money = (d: number) => (d < 0.005 ? 'under $0.01' : `$${d < 10 ? d.toFixed(2) : d.toFixed(0)}`)

/** "about 13% of", "about 2.4x" */
export function share(part: number, whole: number) {
  if (whole <= 0) return 'an unknown share of'
  const x = part / whole
  return x < 1 ? `about ${Math.max(1, Math.round(x * 100))}% of` : `about ${x.toFixed(1)}x`
}
