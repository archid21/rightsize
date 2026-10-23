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

export type Rating = {
  level: Level
  model: 'same' | Tier
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

// ---- Calibration -----------------------------------------------------------

/** Per key, how many runs were seen and the mean of actual / estimated. */
export type Calibration = Record<string, { n: number; ratio: number }>
/** Runs per key before the measured ratio fully replaces the guess. */
export const CAL_FULL = 20
/** Key for the share of effort switches that cost a cache miss (prior: all of them). */
export const SWITCH_KEY = 'cache:effort-switch'
export const calKey = (type: TaskType, route: 'main' | 'delegate') => `${type}:${route}`

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
  return rawMainCost(r, s, level) * factor(s.cal, calKey(r.type, 'main')) + switchCost(s, switches)
}

const reworkFactor = (main: Tier, sub: Tier) => (tierRank(sub) >= tierRank(main) ? 1.2 : sub === 'haiku' ? 1.5 : 1.3)

/** The work handed to a subagent on `sub`, before calibration: brief, work, check, likely rework. */
export function rawDelegateCost(r: Rating, s: Situation, sub: Tier, subLevel: Level) {
  const steps = Math.max(1, Math.round(r.steps))
  // The main chat writes the brief, reads the report, checks the result and answers.
  const main = dollars(s.prices[s.tier], {
    cacheRead: 3 * s.context,
    cacheWrite: REPORT + Math.min(CHECK_CAP, r.read * 0.2) + PROMPT,
    output: (BRIEF + FINAL) * EFFORT_OUT.medium,
  })
  // The subagent starts with no cache: its base and the brief are written fresh.
  const work = dollars(s.prices[sub], {
    cacheWrite: SUB_BASE + BRIEF + r.read,
    cacheRead: steps * (SUB_BASE + BRIEF) + ((steps - 1) * r.read) / 2,
    output: r.write * EFFORT_OUT[subLevel] + REPORT,
  })
  return (main + work) * reworkFactor(s.tier, sub)
}

export function delegateCost(r: Rating, s: Situation, sub: Tier, subLevel: Level) {
  return rawDelegateCost(r, s, sub, subLevel) * factor(s.cal, calKey(r.type, 'delegate'))
}

// ---- Plans -----------------------------------------------------------------

export type Plan =
  | { kind: 'none'; why: string }
  | { kind: 'effort'; dir: 'lower' | 'raise'; level: Level; saving?: number }
  | { kind: 'delegate'; dir: 'up' | 'down'; tier: Tier; level: Level; delegateCost: number; mainCost: number }

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

export function plan(r: Rating, s: Situation, floor: Level): Plan {
  const level = clampFloor(r.level, floor)
  const want = r.model === 'same' ? s.tier : r.model
  const stay = mainCost(r, s, s.level, 0)
  if (tierRank(want) > tierRank(s.tier)) {
    return { kind: 'delegate', dir: 'up', tier: want, level, delegateCost: delegateCost(r, s, want, level), mainCost: stay }
  }
  if (tierRank(want) < tierRank(s.tier) && r.size === 'bulky') {
    const lowered = levelRank(level) < levelRank(s.level) ? mainCost(r, s, level, 2) : Infinity
    const d = delegateCost(r, s, want, level)
    if (d < (s.rules ?? DEFAULT_RULES).handOff * Math.min(stay, lowered)) return { kind: 'delegate', dir: 'down', tier: want, level, delegateCost: d, mainCost: stay }
  }
  return effortPlan(r, s, floor)
}

// ---- Wording ---------------------------------------------------------------

export const money = (d: number) => (d < 0.005 ? 'under $0.01' : `$${d < 10 ? d.toFixed(2) : d.toFixed(0)}`)

/** "about 13% of", "about 2.4x" */
export function share(part: number, whole: number) {
  if (whole <= 0) return 'an unknown share of'
  const x = part / whole
  return x < 1 ? `about ${Math.max(1, Math.round(x * 100))}% of` : `about ${x.toFixed(1)}x`
}
