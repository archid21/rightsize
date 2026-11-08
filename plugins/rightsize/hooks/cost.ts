import { HANDOFF_SHARE, pricedSteps } from './steps'
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
/** The four prices of a request whose prompt is over 100,000 tokens, where the model has a second tier (Haiku). The prompt counts cache reads and writes. */
export type LongPrice = { input: number; output: number; cacheRead: number; cacheWrite: number }
/** `over100k`: the prices a request pays when its prompt is over 100,000 tokens, where the model has a second tier (Haiku). */
export type Price = { input: number; output: number; cacheRead: number; cacheWrite: number; over100k?: LongPrice }
export type Prices = Record<Tier, Price>

// Anthropic first-party prices from the pricing page, checked 2026-10-23;
// prices.json beside the mod overrides them. cacheWrite is the 1-hour TTL (2x input),
// the one Claude Code sessions usually write.
export const DEFAULT_PRICES: Prices = {
  haiku: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.2, over100k: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 1 } },
  sonnet: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 4 },
  opus: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 8 },
  fable: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 20 },
}

const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback)

/** A request whose prompt is over this many tokens pays a model's `over100k` prices, where it has them. */
export const LONG_PROMPT = 100_000

/** The prices one request pays: its prompt (all input, cache reads and cache writes) decides the tier. */
export const atPrompt = (p: Price, prompt: number): Price => (prompt > LONG_PROMPT && p.over100k ? { ...p, ...p.over100k } : p)

/** A model's over-100K prices from prices.json: any field that is missing keeps the default, the cache write follows the file's TTL. */
function longPrice(m: Record<string, unknown>, d: LongPrice, writeKey: string): LongPrice {
  const input = num(m.input, d.input)
  return {
    input,
    output: num(m.output, d.output),
    cacheRead: num(m.cacheRead, d.cacheRead),
    cacheWrite: num(m[writeKey], input * (writeKey === 'cacheWrite1h' ? 2 : 1.25)),
  }
}

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
    const long = (m.over100k ?? {}) as Record<string, unknown>
    out[t] = {
      input,
      output: num(m.output, d.output),
      cacheRead: num(m.cacheRead, d.cacheRead),
      cacheWrite: num(m[writeKey], input * (writeKey === 'cacheWrite1h' ? 2 : 1.25)),
      ...(d.over100k ? { over100k: longPrice(long, d.over100k, writeKey) } : {}),
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
  return dollars(atPrompt(prices[t], contextOf(u)), {
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
  type: TaskType
  /** Tokens of files, logs and tool output the work reads. */
  read: number
  /** Tokens the work writes, thinking left out. */
  write: number
  /** Tool calls the work makes. */
  steps: number
  /** Mainly a step only the person can approve (push, publish, deploy, send): never handed off. */
  approval?: boolean
  /** The prompt carries on the task in the last reply rather than starting a new goal. */
  continues?: boolean
  /** The prompt says the last reply was wrong or must be undone: an outcome for the route that made it. */
  corrects?: boolean
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
/** Key for the share of effort switches that cost a cache miss, learned from each measured switch. */
export const SWITCH_KEY = 'cache:effort-switch'
/** The share assumed to miss before any switch is measured. Measured switches almost all kept the cache, so the prior is low, rounded up to stay cautious. */
export const SWITCH_MISS_PRIOR = 0.1
/**
 * Anthropic's docs say an effort change keeps the cache on the current models. Once this many measured switches
 * have missed at most SWITCH_KEPT_MAX of the time, a switch is priced as free: the rare miss is noise, and pricing it
 * would stop every small lowering on a big conversation.
 */
export const SWITCH_KEPT_N = 20
export const SWITCH_KEPT_MAX = 0.05
/** main: the main chat. delegate: rightsize's hand-off. subagent: a subagent Claude started, moved to a cheaper model. */
export type CalRoute = 'main' | 'delegate' | 'subagent'
export const calKey = (type: TaskType, route: CalRoute) => `${type}:${route}`
/** A route's keys, from the most general to the most specific: the task type, then the model, then the model at its level. */
export const routeKeys = (type: TaskType, route: CalRoute, tier: Tier, level: Level) => [
  calKey(type, route),
  `${type}:${route}:${tier}`,
  `${type}:${route}:${tier}:${level}`,
]
export const mainKeys = (type: TaskType, tier: Tier, level: Level) => routeKeys(type, 'main', tier, level)
export const delegateKeys = (type: TaskType, tier: Tier, level: Level) => routeKeys(type, 'delegate', tier, level)
export const subagentKeys = (type: TaskType, tier: Tier, level: Level) => routeKeys(type, 'subagent', tier, level)

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

/**
 * Rescales every key's ratio by `factor`, for when the estimate's basis changes (the step exponent applied or
 * stopped): the ratios were learned against the old basis. The switch key is a share of misses, not a cost, so it stays.
 */
export function rebaseCal(cal: Calibration, factor: number): Calibration {
  const out: Calibration = {}
  for (const [key, e] of Object.entries(cal)) out[key] = key === SWITCH_KEY ? e : { n: e.n, ratio: Math.min(10, Math.max(0.1, e.ratio * factor)) }
  return out
}

// ---- Estimates -------------------------------------------------------------

/**
 * The store key for calibration. It changed from 'calibration' when estimates began to
 * differ by model and level: ratios learned against the old estimates would double-count,
 * so the old key is ignored, never read, migrated or deleted.
 */
export const CAL_STORE = 'calibration-v2'

// Work a model does on the same task, as multiples of Sonnet's: `out` scales output tokens
// (thinking is billed as output and grows with effort) and `steps` scales tool calls, which
// drive cache reads. Calibration corrects the guess. Sonnet is the baseline.
// Sources: Anthropic's "optimizing-for-cost-and-intelligence" doc (Opus low at about 0.55x
// Sonnet high's output and a third of its cache reads; Opus medium slightly above Sonnet
// high; Fable about 1.3x Opus medium at medium and 2x at high), Artificial Analysis (Haiku
// medium writes about 1.6x Sonnet medium's output), and interpolated for guessed cells.
export const WORK: Record<Tier, Record<Level, { out: number; steps: number }>> = {
  sonnet: {
    low: { out: 1, steps: 1 },
    medium: { out: 1.6, steps: 1 },
    high: { out: 2.5, steps: 1 },
    xhigh: { out: 3.5, steps: 1 },
    max: { out: 5, steps: 1 },
  },
  opus: {
    low: { out: 1.4, steps: 0.4 },
    medium: { out: 2.6, steps: 1.05 },
    high: { out: 4, steps: 1.2 },
    xhigh: { out: 6, steps: 1.8 },
    max: { out: 8, steps: 2.2 },
  },
  haiku: {
    low: { out: 1.6, steps: 1.2 },
    medium: { out: 2.56, steps: 1.2 },
    high: { out: 4, steps: 1.2 },
    xhigh: { out: 5.6, steps: 1.2 },
    max: { out: 8, steps: 1.2 },
  },
  fable: {
    low: { out: 2, steps: 1 },
    medium: { out: 3.3, steps: 1.3 },
    high: { out: 5, steps: 1.6 },
    xhigh: { out: 6.5, steps: 1.9 },
    max: { out: 8, steps: 2.2 },
  },
}
const PROMPT = 200
const BRIEF = 1500
const REPORT = 1500
const FINAL = 800
/** Times the main chat reads its whole conversation from cache across a hand-off (the brief, the report, the check, the answer, and their tool calls). */
const HANDOFF_READS = 8
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
  /** Close calls seen so far, persisted: every fifth takes the route the guide did not pick. */
  ties?: number
  /** How often the rater's judgement was wrong, by `${type}:${tier}` (see misses.ts): at the pause share or more, that model gets no hand-down and no lowering. */
  misses?: Record<string, number>
  /** The share of misses at which that pause starts (Pause after misses); null: never pause. MISS_BLOCK when absent. */
  missBlock?: number | null
  /** Tasks logged per `${type}:${tier}` (misses.ts): what minTasks is counted against. */
  counts?: Record<string, number>
  /** The tasks a task type must have logged on a model before a cheaper route to it, or a lowering on it, is used (the profile's evidence rule). 0 when absent. */
  minTasks?: number
  /** The highest effort rightsize raises to (Highest effort); max when absent. A ceiling under the level in use stops raises; it never lowers. */
  ceiling?: Level
  /** The highest level a review switched to Opus runs at (the profile's; Economy stops at high); the ceiling when absent. */
  reviewCeiling?: Level
  /** Models rightsize sends no work to: hand-offs and Claude's subagents never go to them (Use Haiku, Use Fable). */
  without?: readonly Tier[]
  /** False: a close call always takes the guide's pick (Explore close calls). True when absent. */
  explore?: boolean
  /** The learned step exponent (see steps.ts): the work is priced for `steps ** (1 + stepExp)` steps. 0 when absent, which prices the rater's guess as it is. */
  stepExp?: number
}

/** The share of wrong judgements at which rightsize stops trusting the rater for a task type and model: the default of Pause after misses. */
export const MISS_BLOCK = 0.3
/** Fewer tasks logged than the evidence rule asks for. */
const unproven = (s: Situation, type: TaskType, tier: Tier) => (s.minTasks ?? 0) > (s.counts?.[`${type}:${tier}`] ?? 0)
const blocked = (s: Situation, type: TaskType, tier: Tier) => {
  const line = s.missBlock === undefined ? MISS_BLOCK : s.missBlock
  return unproven(s, type, tier) || (line !== null && (s.misses?.[`${type}:${tier}`] ?? 0) >= line)
}

/** The main chat doing the work at `level`, before calibration. */
export function rawMainCost(r: Rating, s: Situation, level: Level) {
  const w = WORK[s.tier][level]
  const steps = Math.max(1, pricedSteps(r.steps, s.stepExp ?? 0) * w.steps)
  // Each step re-reads the conversation from cache; what the work reads is written once.
  return dollars(atPrompt(s.prices[s.tier], s.context + r.read / 2), {
    cacheRead: steps * s.context + ((steps - 1) * r.read) / 2,
    cacheWrite: r.read + PROMPT,
    output: r.write * w.out,
  })
}

/** What `switches` effort changes cost: each one may make the next request re-write the whole conversation. */
export function switchCost(s: Situation, switches: number) {
  const p = atPrompt(s.prices[s.tier], s.context)
  const miss = dollars(p, { cacheWrite: s.context }) - dollars(p, { cacheRead: s.context })
  return switches * switchMissShare(s.cal) * miss
}

/** The share of effort switches priced as a cache miss: the learned share, or none once enough measured switches have kept the cache. */
export function switchMissShare(cal: Calibration) {
  const e = cal[SWITCH_KEY]
  if (e && e.n >= SWITCH_KEPT_N && e.ratio <= SWITCH_KEPT_MAX) return 0
  return factor(cal, SWITCH_KEY, SWITCH_MISS_PRIOR)
}

export function mainCost(r: Rating, s: Situation, level: Level, switches: number) {
  return rawMainCost(r, s, level) * routeFactor(s.cal, mainKeys(r.type, s.tier, level)) + switchCost(s, switches)
}

const reworkFactor = (main: Tier, sub: Tier) => (tierRank(sub) >= tierRank(main) ? 1.2 : sub === 'haiku' ? 1.5 : 1.3)

/** A subagent's own requests on `sub`, before calibration: it starts with no cache, so its base and the brief are written fresh. */
export function subWork(r: Rating, s: Situation, sub: Tier, subLevel: Level) {
  const w = WORK[sub][subLevel]
  const steps = Math.max(1, pricedSteps(r.steps, (s.stepExp ?? 0) * HANDOFF_SHARE) * w.steps)
  const tokens: Tokens = {
    cacheWrite: SUB_BASE + BRIEF + r.read,
    cacheRead: steps * (SUB_BASE + BRIEF) + ((steps - 1) * r.read) / 2,
    output: r.write * w.out + REPORT,
  }
  // Its prompt grows from the base and brief to the whole of what it read. The requests past 100,000 tokens pay the model's over-100K prices (Haiku).
  const p = s.prices[sub]
  const start = SUB_BASE + BRIEF
  const peak = start + r.read
  const over = p.over100k && peak > LONG_PROMPT ? Math.min(1, (peak - Math.max(LONG_PROMPT, start)) / (peak - start)) : 0
  return over > 0 ? (1 - over) * dollars(p, tokens) + over * dollars(atPrompt(p, Infinity), tokens) : dollars(p, tokens)
}

/** The work handed to a subagent on `sub`, before calibration: brief, work, check, likely rework. */
export function rawDelegateCost(r: Rating, s: Situation, sub: Tier, subLevel: Level) {
  // The main chat writes the brief, reads the report, checks the result and answers.
  // Reads and output follow measured hand-offs: more requests than the brief and the answer alone, but the text is plain output,
  // near the model's lowest-effort multiple, not the medium-effort thinking multiple the work itself gets.
  const main = dollars(atPrompt(s.prices[s.tier], s.context), {
    cacheRead: HANDOFF_READS * s.context,
    cacheWrite: REPORT + Math.min(CHECK_CAP, r.read * 0.2) + PROMPT,
    output: (BRIEF + FINAL) * WORK[s.tier].low.out,
  })
  return (main + subWork(r, s, sub, subLevel)) * reworkFactor(s.tier, sub)
}

export function delegateCost(r: Rating, s: Situation, sub: Tier, subLevel: Level) {
  return rawDelegateCost(r, s, sub, subLevel) * routeFactor(s.cal, delegateKeys(r.type, sub, subLevel))
}

// ---- Close calls -----------------------------------------------------------

// A cold-start prior from benchmark research: measured cost takes over after CAL_FULL runs.
export const PREFERRED: Record<TaskType, Tier> = {
  lookup: 'haiku',
  search: 'haiku',
  'bulk-edit': 'haiku',
  extract: 'haiku',
  summarize: 'haiku',
  writing: 'sonnet',
  review: 'opus',
  other: 'sonnet',
  feature: 'sonnet',
  debug: 'sonnet',
  refactor: 'sonnet',
  design: 'opus',
}

/** How close two routes' costs must be, as a share of the cheaper one, before any run is measured. */
export const TIE_BAND = 0.25
/** The band with `n` measured runs: it shrinks to nothing at CAL_FULL. */
export const tieBand = (n: number) => TIE_BAND * (1 - Math.min(n, CAL_FULL) / CAL_FULL)

/** One in this many close calls takes the route the guide did not pick, so both get measured. */
const EXPLORE_EVERY = 5

/** How a close call was decided: `over` is the route it beat, or the guide's pick when exploring. */
export type Tie = { by: 'guide' | 'stronger' | 'explore'; over: Tier }

/**
 * Chooses among candidate routes that already passed every other rule, sorted by cost.
 * The cheapest wins unless another is close to it (see tieBand, over the smaller run count
 * of the pair): then the one on the task type's preferred model, else the stronger model.
 * Every fifth close call takes the best close route the guide did not pick, unless exploring is off.
 * It never widens the candidates: it only chooses among them.
 */
function choose<T extends { tier: Tier; cost: number; n: number }>(type: TaskType, ties: number, sorted: readonly T[], explore = true): { pick: T; tie?: Tie } | undefined {
  const [cheapest] = sorted
  if (!cheapest) return undefined
  // A closed band (both measured CAL_FULL runs) means no close calls, even at an equal cost.
  const close = sorted.slice(1).filter(c => {
    const band = tieBand(Math.min(cheapest.n, c.n))
    return band > 0 && c.cost <= cheapest.cost * (1 + band)
  })
  if (!close.length) return { pick: cheapest }
  const group = [cheapest, ...close]
  const preferred = group.find(c => c.tier === PREFERRED[type])
  const guide = preferred ?? group.reduce((a, b) => (tierRank(b.tier) > tierRank(a.tier) ? b : a))
  if (explore && ties % EXPLORE_EVERY === EXPLORE_EVERY - 1) {
    const other = group.find(c => c !== guide)
    if (other) return { pick: other, tie: { by: 'explore', over: guide.tier } }
  }
  const beaten = group.find(c => c !== guide)
  return { pick: guide, tie: { by: preferred ? 'guide' : 'stronger', over: (beaten ?? guide).tier } }
}

const runsOn = (cal: Calibration, keys: readonly string[]) => cal[keys[keys.length - 1] ?? '']?.n ?? 0

// ---- Plans -----------------------------------------------------------------

export type Plan =
  | { kind: 'none'; why: string }
  | { kind: 'effort'; dir: 'lower' | 'raise'; level: Level; saving?: number; rule?: 'review' }
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
      /** Set when two routes were close in cost and the task-type guide broke the tie. */
      tie?: Tie
    }
  /** The main chat runs this one turn on another model, then goes back: reviews on Opus. */
  | { kind: 'switch'; tier: Tier; level: Level; cost: number; mainCost: number; rule: 'review' }

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
export function idleCost(price: Price, context: number) {
  const p = atPrompt(price, context)
  return { resend: dollars(p, { cacheWrite: context }) - dollars(p, { cacheRead: context }), compact: dollars(p, { input: context }) }
}

/** What a Haiku compaction of an idle session is assumed to leave behind: the summary the next prompt re-reads instead of the whole conversation. */
export const COMPACT_SUMMARY_TOKENS = 6000

/** What coming back cold costs on `tier`: `tokens` written to the cache again, less the read it would have been warm. The same figure as idleCost's `resend`. */
export const coldCost = (prices: Prices, tier: Tier, tokens: number) => idleCost(prices[tier], tokens).resend

/**
 * What compacting `context` tokens now would save after a 5-hour reset, on `tier`: the cold re-read of the whole conversation
 * after the reset, less [a compaction now, with the cache still warm: the conversation read from the cache and
 * `summaryTokens` written as output, on the session's own model] and less the cold re-read of that summary after the reset.
 * Never below 0 (a small context costs more to compact than to read again).
 */
export const limitSaving = (prices: Prices, tier: Tier, context: number, summaryTokens = COMPACT_SUMMARY_TOKENS) =>
  Math.max(0, coldCost(prices, tier, context) - (dollars(atPrompt(prices[tier], context), { cacheRead: context, output: summaryTokens }) + coldCost(prices, tier, summaryTokens)))

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
  /**
   * hot: on pace to hit a limit before it resets. max: a window is nearly used up.
   * cool: much of a window will go unused. It is kept for the log only: an unused window never changes a decision.
   */
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

/**
 * The thresholds at this pace: looser when running hot or nearly used up.
 * An underused window (cool) moves nothing: a lower bar would make rightsize spend more, and spare room in a window
 * is never a reason to spend. A threshold you set (`set`) stays as you set it: pacing moves only one left at its default.
 */
export function pacedRules(rules: Rules, p: Pace, set: { handOff?: boolean; lower?: boolean } = {}): Rules {
  const moved = (to: Rules): Rules => ({ handOff: set.handOff ? rules.handOff : to.handOff, lower: set.lower ? rules.lower : to.lower })
  if (p.mode === 'max') return moved({ handOff: Math.max(rules.handOff, 0.95), lower: 1 })
  if (p.mode === 'hot') return moved({ handOff: Math.min(0.95, rules.handOff + 0.15), lower: Math.min(0.99, rules.lower + 0.07) })
  return rules
}

const WINDOW_NAME = { five_hour: '5-hour', seven_day: '7-day' } as const

/**
 * Why a decision moved, for the band; empty at a normal pace and at a cool one (an underused window changes nothing). `acts` is false when pacing changed
 * nothing because every setting it could move was yours: a window nearly used up is then only reported.
 */
export function paceNote(p: Pace, acts = true) {
  if (p.mode === 'normal' || !p.window) return ''
  const w = WINDOW_NAME[p.window]
  if (p.mode === 'max') return `${Math.round(p.used ?? 0)}% of the ${w} window is used${acts ? ', so rightsize saves all it can' : ''}.`
  if (!acts || p.mode !== 'hot') return ''
  return `The ${w} window is on pace to run out before it resets, so rightsize saves harder.`
}

const clampFloor = (l: Level, floor: Level) => (levelRank(l) < levelRank(floor) ? floor : l)
const clampCeiling = (l: Level, ceiling: Level) => (levelRank(l) > levelRank(ceiling) ? ceiling : l)
const ceilingOf = (s: Situation): Level => s.ceiling ?? 'max'
/** A model whose rated level is above Highest effort does not fit: capped lower, it would do the work worse than rated. */
const overCeiling = (need: Level, s: Situation) => levelRank(need) > levelRank(ceilingOf(s))

/** A level on the session's model: a raise stops at the ceiling, and never falls below the level in use. */
const capRaise = (target: Level, s: Situation) => {
  if (levelRank(target) <= levelRank(s.level)) return target
  const capped = clampCeiling(target, ceilingOf(s))
  return levelRank(capped) > levelRank(s.level) ? capped : s.level
}

// A rated raise is not taken from the rating alone where it bought no passes. On Opus and Fable it is never taken
// (ADR 0021: on 145 Django runs the rated level did not predict the misses, and low passed as often as medium); on a
// Sonnet session it is not taken for debugging (the rater cannot tell a routine bug from a subtle one from the prompt).
// The session stays at its level (a lowering still goes through), and raising is left to stuck detection
// (struggle.ts), which sees the turn go wrong. A review is never held: reviewPlan raises Opus to high on purpose.
export const NO_PROMPT_RAISE: readonly Tier[] = ['opus', 'fable']
const DEBUG_HOLD_TIER: Tier = 'sonnet'
function heldRating(r: Rating, s: Situation): Rating {
  const own = r.fit[s.tier]
  // A model the rater says would struggle at any level is not held: the raise is the fallback when no stronger route exists.
  if (!own) return r
  if (levelRank(own) <= levelRank(s.level) && levelRank(r.level) <= levelRank(s.level)) return r
  const held = NO_PROMPT_RAISE.includes(s.tier) ? r.type !== 'review' : r.type === 'debug' && s.tier === DEBUG_HOLD_TIER
  if (!held) return r
  return { ...r, level: levelRank(r.level) > levelRank(s.level) ? s.level : r.level, fit: { ...r.fit, [s.tier]: levelRank(own) > levelRank(s.level) ? s.level : own } }
}

// The effort-only plan: lower or raise on the main model, or nothing.
export function effortPlan(r0: Rating, s: Situation, floor: Level): Plan {
  const r = heldRating(r0, s)
  const target = capRaise(clampFloor(r.level, floor), s)
  if (target === s.level) return { kind: 'none', why: 'the level in use fits' }
  if (levelRank(target) > levelRank(s.level)) return { kind: 'effort', dir: 'raise', level: target }
  if (blocked(s, r.type, s.tier)) {
    const why = unproven(s, r.type, s.tier) ? `only ${s.counts?.[`${r.type}:${s.tier}`] ?? 0} of the ${s.minTasks} tasks it needs are logged` : 'the rating was wrong too often'
    return { kind: 'none', why: `lowering ${r.type} work on ${TIER_NAME[s.tier]} is paused: ${why}` }
  }
  // A per-prompt lower switches twice: down for this turn, back for the next.
  const now = mainCost(r, s, s.level, 0)
  const lowered = mainCost(r, s, target, 2)
  if (lowered >= now * (s.rules ?? DEFAULT_RULES).lower) return { kind: 'none', why: `lowering to ${target} saves less than the cache it costs` }
  return { kind: 'effort', dir: 'lower', level: target, saving: now - lowered }
}

// Reviews run on Opus at high effort or more, whatever the rating says: below that, a review
// misses the subtle bugs it is for, and the rater can't tell from the prompt. A session below
// Opus switches the main chat to Opus for that turn; an Opus session raises to high and doesn't lower. Fable plans as usual,
// with no route below Opus.
export const REVIEW_TIER: Tier = 'opus'
/** The weakest session model a hand-down to a helper starts from. */
export const HAND_DOWN_FROM: Tier = 'opus'
export const REVIEW_LEVEL: Level = 'high'
const atLeast = (l: Level, min: Level) => (levelRank(l) < levelRank(min) ? min : l)

function reviewPlan(r: Rating, s: Situation, floor: Level): Plan | undefined {
  // Unlike a route in plan(), a ceiling below high does not drop this one: the review must still run,
  // so the switch is capped at the ceiling on purpose, though it then runs below the level a review needs.
  // The profile's review ceiling (Economy: high) caps it too.
  const top = s.reviewCeiling && levelRank(s.reviewCeiling) < levelRank(ceilingOf(s)) ? s.reviewCeiling : ceilingOf(s)
  const level = clampCeiling(clampFloor(atLeast(r.fit[REVIEW_TIER] ?? REVIEW_LEVEL, REVIEW_LEVEL), floor), top)
  if (tierRank(s.tier) < tierRank(REVIEW_TIER)) {
    if (s.without?.includes(REVIEW_TIER)) return undefined
    // The main chat on Opus for one turn: its work at that level, plus writing the conversation to Opus's cache once.
    const cost = mainCost(r, { ...s, tier: REVIEW_TIER }, level, 0) + (s.context * atPrompt(s.prices[REVIEW_TIER], s.context).cacheWrite) / 1e6
    return { kind: 'switch', tier: REVIEW_TIER, level, cost, mainCost: mainCost(r, s, s.level, 0), rule: 'review' }
  }
  if (s.tier !== REVIEW_TIER) return undefined
  const target = capRaise(level, s)
  if (levelRank(target) > levelRank(s.level)) return { kind: 'effort', dir: 'raise', level: target, rule: 'review' }
  return { kind: 'none', why: `reviews stay on ${TIER_NAME[REVIEW_TIER]} at ${REVIEW_LEVEL} effort or more` }
}

// Every model that fits is a route: the session's model at its level in the main
// chat, each other model at its own level as a subagent. When the session's model
// would struggle, the cheapest stronger route that fits. Otherwise the cheapest
// cheaper route, when it costs under the hand-off share of staying at the level
// the work needs (a raise counted with its switch there and back); else an effort change.
export function plan(r: Rating, s: Situation, floor: Level): Plan {
  // The routes and the hand-off bar use the rating as given: a hand-off is judged against the level the work needs.
  // Only the effort plan holds a rated raise back (heldRating, in effortPlan).
  // A subagent cannot see the person's approval, so it would refuse the work.
  if (r.approval) return effortPlan(r, s, floor)
  if (r.type === 'review') {
    const p = reviewPlan(r, s, floor)
    if (p) return p
  }
  const stay = mainCost(r, s, s.level, 0)
  const routes = TIERS.flatMap(t => {
    const need = r.fit[t]
    if (t === s.tier || !need || s.without?.includes(t)) return []
    if (r.type === 'review' && tierRank(t) < tierRank(REVIEW_TIER)) return []
    // A model that needs more than Highest effort allows does not fit: no route, up or down. The review
    // minimum is not counted here: a review on Opus is capped at the ceiling on purpose (see reviewPlan).
    if (overCeiling(need, s)) return []
    // A hand-down to a model the rater has been wrong about for this kind of work waits until its record mends.
    if (tierRank(t) < tierRank(s.tier) && blocked(s, r.type, t)) return []
    const level = clampCeiling(clampFloor(r.type === 'review' && t === REVIEW_TIER ? atLeast(need, REVIEW_LEVEL) : need, floor), ceilingOf(s))
    return [{ tier: t, level, cost: delegateCost(r, s, t, level), n: runsOn(s.cal, delegateKeys(r.type, t, level)) }]
  }).sort((a, b) => a.cost - b.cost)
  const ties = s.ties ?? 0
  const own = r.fit[s.tier]
  if (!own) {
    const up = choose(r.type, ties, routes.filter(x => tierRank(x.tier) > tierRank(s.tier)), s.explore !== false)
    if (up) return { kind: 'delegate', dir: 'up', tier: up.pick.tier, level: up.pick.level, delegateCost: up.pick.cost, mainCost: stay, ...(up.tie ? { tie: up.tie } : {}) }
    return effortPlan(r, s, floor)
  }
  const level = capRaise(clampFloor(own, floor), s)
  const atNeed = mainCost(r, s, level, level === s.level ? 0 : 2)
  const alt = levelRank(level) > levelRank(s.level) ? atNeed : Math.min(stay, atNeed)
  // Only routes under the hand-off share are candidates; a close call is chosen among them.
  const bar = (s.rules ?? DEFAULT_RULES).handOff * alt
  // Hand-downs start only from Opus or Fable: from Sonnet the brief and the check cost more than the
  // cheaper model saves (ADR 0008).
  if (tierRank(s.tier) < tierRank(HAND_DOWN_FROM)) return effortPlan(r, s, floor)
  const down = choose(r.type, ties, routes.filter(x => tierRank(x.tier) < tierRank(s.tier) && x.cost < bar), s.explore !== false)
  if (down) {
    return {
      kind: 'delegate',
      dir: 'down',
      tier: down.pick.tier,
      level: down.pick.level,
      delegateCost: down.pick.cost,
      mainCost: alt,
      instead: level,
      ...(down.tie ? { tie: down.tie } : {}),
    }
  }
  return effortPlan(r, s, floor)
}

// A subagent Claude starts on its own runs on its parent's model unless the call
// names one. Its brief is rated like a prompt: the cheapest weaker model that fits,
// at its own level, when its work (likely rework counted) costs under the hand-off
// share of running on the parent. Never a stronger model, and nothing when the
// parent itself would struggle: that is Claude's call, not a saving.
// Each model's estimate is calibrated by what Claude's subagents moved to it really cost.
export type SubagentSize = {
  tier: Tier
  level: Level
  /** Calibrated, likely rework counted: what the choice was made on. */
  cost: number
  parentCost: number
  /** Before calibration and rework: what a run teaches against, and the parent's for the saving. */
  raw: number
  parentRaw: number
  /** Set when two weaker models were close in cost and the task-type guide broke the tie. */
  tie?: Tie
}

export function sizeSubagent(r: Rating, s: Situation, parent: Tier, floor: Level): SubagentSize | undefined {
  const own = r.fit[parent]
  if (!own) return undefined
  const priced = (t: Tier, level: Level) => {
    const raw = subWork(r, s, t, level)
    const keys = subagentKeys(r.type, t, level)
    return { raw, cost: raw * routeFactor(s.cal, keys) * reworkFactor(parent, t), n: runsOn(s.cal, keys) }
  }
  const p = priced(parent, clampCeiling(clampFloor(own, floor), ceilingOf(s)))
  const bar = (s.rules ?? DEFAULT_RULES).handOff * p.cost
  const weaker = TIERS.flatMap(t => {
    const need = r.fit[t]
    if (tierRank(t) >= tierRank(parent) || !need || s.without?.includes(t)) return []
    // A model that needs more than Highest effort allows does not fit.
    if (overCeiling(need, s)) return []
    // A model paused for too many misses on this kind of work gets no subagent either.
    if (blocked(s, r.type, t)) return []
    const level = clampCeiling(clampFloor(need, floor), ceilingOf(s))
    return [{ tier: t, level, ...priced(t, level), parentCost: p.cost, parentRaw: p.raw }]
  })
    .filter(x => x.cost < bar)
    .sort((a, b) => a.cost - b.cost)
  const chosen = choose(r.type, s.ties ?? 0, weaker, s.explore !== false)
  if (!chosen) return undefined
  const { n: _n, ...best } = chosen.pick
  return { ...best, ...(chosen.tie ? { tie: chosen.tie } : {}) }
}

// ---- Wording ---------------------------------------------------------------

export const money = (d: number) => (d < 0.005 ? 'under $0.01' : `$${d < 10 ? d.toFixed(2) : d.toFixed(0)}`)

/** "~13% of Opus usage", "~2.4x Opus usage": a cost against what staying on `cur` would use. */
export function usageVs(part: number, whole: number, cur: string) {
  if (whole <= 0) return `an unknown share of ${cur} usage`
  const x = part / whole
  return x < 1 ? `~${Math.max(1, Math.round(x * 100))}% of ${cur} usage` : `~${x.toFixed(1)}x ${cur} usage`
}

/** "about 13% of", "about 2.4x" */
export function share(part: number, whole: number) {
  if (whole <= 0) return 'an unknown share of'
  const x = part / whole
  return x < 1 ? `about ${Math.max(1, Math.round(x * 100))}% of` : `about ${x.toFixed(1)}x`
}
