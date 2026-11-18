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
/** What a request is about, as the rater reads it (P-70, ADR 0086). Only a review's `design` and `text` change a route. */
export const SUBJECTS = ['code', 'design', 'text', 'architecture', 'ui', 'plain', 'code-legal-images', 'short-copy', 'long-docs'] as const
export type Subject = (typeof SUBJECTS)[number]
export const isSubject = (v: unknown): v is Subject => typeof v === 'string' && (SUBJECTS as readonly string[]).includes(v)
export const isTaskType = (v: unknown): v is TaskType => typeof v === 'string' && (TASK_TYPES as readonly string[]).includes(v)
export const levelRank = (l: Level) => LEVELS.indexOf(l)
export const tierRank = (t: Tier) => TIERS.indexOf(t)
export const tierOf = (model: string | null | undefined): Tier | undefined => {
  const m = (model ?? '').toLowerCase()
  return TIERS.find(t => m.includes(t))
}

/** The newest version of each family, the one prices.json prices (ADR 0032). The price check's page rows are named from it. */
export const NEWEST: Record<Tier, readonly [number, number]> = { haiku: [5, 5], sonnet: [5, 5], opus: [5, 5], fable: [5, 2] }
export const versionName = (t: Tier, [major, minor]: readonly [number, number]) => `${TIER_NAME[t]} ${major}${minor ? `.${minor}` : ''}`

/** A model ID's family and version, or undefined when it names no version (`opus`, `sonnet[1m]`). Reads `claude-opus-4-8`,
 * `claude-opus-4-20250514` (an 8-digit part is a date), `claude-3-5-sonnet-…`, and Bedrock or Vertex wraps of these
 * (`anthropic.claude-opus-4-8-v1:0`, `claude-opus-4-8@20260101`): the version is found anywhere in the ID (ADR 0031). */
export function modelVersion(model: string | null | undefined): { tier: Tier; v: readonly [number, number] } | undefined {
  const m = (model ?? '').toLowerCase()
  const t = tierOf(m)
  if (!t) return undefined
  const num = (s: string | undefined) => (s !== undefined && /^\d{1,2}$/.test(s) ? Number(s) : undefined)
  const after = new RegExp(`${t}-(\\d+)(?:[-.](\\d+))?`).exec(m)
  const before = new RegExp(`(?:^|[^a-z0-9])claude-(\\d+)(?:[-.](\\d+))?-${t}`).exec(m)
  const hit = num(after?.[1]) !== undefined ? after : before
  const major = num(hit?.[1])
  if (major === undefined) return undefined
  return { tier: t, v: [major, num(hit?.[2]) ?? 0] }
}

/** The key of a version in prices.json's `versions`: `claude-opus-4-8`, `claude-opus-4` (ADR 0031). */
export const versionKey = (t: Tier, [major, minor]: readonly [number, number]) => `claude-${t}-${major}${minor ? `-${minor}` : ''}`

const isOlder = (t: Tier, v: readonly [number, number]) => {
  const [nMajor, nMinor] = NEWEST[t]
  return v[0] < nMajor || (v[0] === nMajor && v[1] < nMinor)
}

/** "Opus 4.8" when the model ID names a version older than NEWEST, else undefined. */
export function olderModel(model: string | null | undefined): string | undefined {
  const mv = modelVersion(model)
  return mv && isOlder(mv.tier, mv.v) ? versionName(mv.tier, mv.v) : undefined
}

/** The prices.json key of an older version the ID names, else undefined. */
export function olderKey(model: string | null | undefined): string | undefined {
  const mv = modelVersion(model)
  return mv && isOlder(mv.tier, mv.v) ? versionKey(mv.tier, mv.v) : undefined
}

// ---- Prices ----------------------------------------------------------------

/** US dollars per 1 million tokens. */
/** The four prices of a request whose prompt is over 100,000 tokens, where the model has a second tier (Haiku). The prompt counts cache reads and writes. */
export type LongPrice = { input: number; output: number; cacheRead: number; cacheWrite: number }
/** `over100k`: the prices a request pays when its prompt is over 100,000 tokens, where the model has a second tier (Haiku).
 * `window`: the model's context window in tokens; absent when prices.json does not say. */
export type Price = { input: number; output: number; cacheRead: number; cacheWrite: number; over100k?: LongPrice; window?: number }
/** Each family's newest model, and (ADR 0031) older versions by `versionKey` where prices.json has them. `family` keeps the
 * families' own rows when a family's row stands in for the main chat's older version (`forModel`). */
export type Prices = Record<Tier, Price> & { versions?: Record<string, Price>; family?: Record<Tier, Price>; /** Fast mode's prices by version key (P-29, ADR 0069). */ fast?: Record<string, Price> }

/** Fast mode's input and output prices for one version, as the pricing page lists them. Its cache prices follow from input. */
export type FastRow = { input: number; output: number }

/** Fast mode's prices from the pricing page, checked 2026-11-14 (P-29); prices.json's `fast` overrides them. */
export const DEFAULT_FAST: Readonly<Record<string, FastRow>> = {
  'claude-fable-5-2': { input: 16, output: 80 },
  'claude-opus-5-5': { input: 8, output: 40 },
  'claude-opus-5': { input: 10, output: 50 },
  'claude-opus-4-8': { input: 10, output: 50 },
}

/** The version key a model ID runs on, for fast mode: its own version, or its family's newest when the ID names none (`opus`). */
export function fastKey(model: string | null | undefined): string | undefined {
  const mv = modelVersion(model)
  if (mv) return versionKey(mv.tier, mv.v)
  const t = tierOf(model)
  return t ? versionKey(t, NEWEST[t]) : undefined
}

/**
 * A version's fast-mode price from its standard price: fast input and output, and the cache prices at the same multiples of
 * input as the standard row (the pricing page: caching multipliers apply on top of fast prices). Flat over the whole window.
 */
export function fastPrice(standard: Price, row: FastRow): Price {
  const k = standard.input > 0 ? row.input / standard.input : 1
  return { input: row.input, output: row.output, cacheRead: standard.cacheRead * k, cacheWrite: standard.cacheWrite * k, ...(standard.window ? { window: standard.window } : {}) }
}

/** True when the model has fast-mode prices: Claude Code can run it in fast mode. */
export const fastSupported = (prices: Prices, model: string | null | undefined) => {
  const k = fastKey(model)
  return k !== undefined && prices.fast?.[k] !== undefined
}

// Anthropic first-party prices from the pricing page, checked 2026-11-09;
// prices.json beside the mod overrides them. cacheWrite is the 1-hour TTL (2x input),
// the one Claude Code sessions usually write.
export const DEFAULT_PRICES: Prices = {
  haiku: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.2, over100k: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 1 }, window: 1_000_000 },
  sonnet: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 4, window: 1_000_000 },
  opus: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 8, window: 1_000_000 },
  fable: { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 16, window: 1_000_000 },
}

const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback)
/** A context window from prices.json: a whole number of tokens above 0, else `fallback`. */
const windowOf = (v: unknown, fallback?: number) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : fallback)

/** The default prices with every cache write at `ttl`'s multiple of input (1.25x for 5m, 2x for 1h). */
const withTtl = (p: Prices, ttl: Ttl): Prices => {
  const k = ttl === '5m' ? 1.25 : 2
  const out = { ...p }
  for (const t of TIERS) {
    const d = p[t]
    out[t] = { ...d, cacheWrite: d.input * k, ...(d.over100k ? { over100k: { ...d.over100k, cacheWrite: d.over100k.input * k } } : {}) }
  }
  return out
}

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

// Reads prices.json for a cache life: `ttl` (the resolved one), else the file's cacheTtl, else 1 hour. Any field that is
// missing or not a number keeps the default.
export function parsePrices(raw: string, ttl?: Ttl): Prices {
  let json: { cacheTtl?: unknown; models?: Record<string, Record<string, unknown> | undefined> } = {}
  try {
    json = JSON.parse(raw) as typeof json
  } catch {
    const base = ttl === '5m' ? withTtl(DEFAULT_PRICES, '5m') : DEFAULT_PRICES
    return { ...base, fast: withFast(base, {}, {}) }
  }
  const writeKey = (ttl ?? (json.cacheTtl === '5m' ? '5m' : '1h')) === '5m' ? 'cacheWrite5m' : 'cacheWrite1h'
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
      ...(windowOf(m.window, d.window) !== undefined ? { window: windowOf(m.window, d.window) } : {}),
    }
  }
  const versions: Record<string, Price> = {}
  for (const [key, m] of Object.entries((json as { versions?: Record<string, Record<string, unknown> | undefined> }).versions ?? {})) {
    const mv = modelVersion(key)
    if (!m || !mv || versionKey(mv.tier, mv.v) !== key) continue
    const input = num(m.input, Number.NaN)
    const output = num(m.output, Number.NaN)
    const cacheRead = num(m.cacheRead, Number.NaN)
    // A version row needs its own prices: a missing field has no family default to fall back on.
    if (![input, output, cacheRead].every(Number.isFinite)) continue
    const window = windowOf(m.window)
    versions[key] = { input, output, cacheRead, cacheWrite: num(m[writeKey], input * (writeKey === 'cacheWrite1h' ? 2 : 1.25)), ...(window ? { window } : {}) }
  }
  const fileFast = (json as { fast?: Record<string, Record<string, unknown> | undefined> }).fast ?? {}
  const fast = withFast(out, versions, fileFast)
  return { ...out, ...(Object.keys(versions).length ? { versions } : {}), ...(Object.keys(fast).length ? { fast } : {}) }
}

/**
 * Fast mode's prices by version key: the defaults, with any row in prices.json's `fast` over them (a row needs both input and
 * output). Each is priced from its version's standard row: the family's own for the newest version, else its `versions` row.
 */
function withFast(families: Record<Tier, Price>, versions: Record<string, Price>, file: Record<string, Record<string, unknown> | undefined>): Record<string, Price> {
  const rows: Record<string, FastRow> = { ...DEFAULT_FAST }
  for (const [key, m] of Object.entries(file)) {
    const input = num(m?.input, Number.NaN)
    const output = num(m?.output, Number.NaN)
    if (Number.isFinite(input) && Number.isFinite(output) && input > 0) rows[key] = { input, output }
  }
  const out: Record<string, Price> = {}
  for (const [key, row] of Object.entries(rows)) {
    const mv = modelVersion(key)
    if (!mv || versionKey(mv.tier, mv.v) !== key) continue
    const newest = NEWEST[mv.tier]
    const standard = mv.v[0] === newest[0] && mv.v[1] === newest[1] ? families[mv.tier] : versions[key]
    if (standard) out[key] = fastPrice(standard, row)
  }
  return out
}

/**
 * One request's price: its version's own row when prices.json has one, else its family's; undefined for no family (ADR 0031).
 * `fast`: the request ran in fast mode, so its version's fast row prices it where there is one (P-29).
 */
export function priceOf(prices: Prices, model: string | null | undefined, fast = false): Price | undefined {
  const t = tierOf(model)
  if (!t) return undefined
  const fk = fast ? fastKey(model) : undefined
  if (fk && prices.fast?.[fk]) return prices.fast[fk]
  const key = olderKey(model)
  return (key && prices.versions?.[key]) || (prices.family ?? prices)[t]
}

/** Whether the ID names an older version that prices.json has no row for: rightsize pauses there (ADR 0032, 0031). */
export const unpricedOlder = (prices: Prices, model: string | null | undefined): boolean => {
  const key = olderKey(model)
  return key !== undefined && !prices.versions?.[key]
}

/**
 * The prices the main chat plans with: on an older version with its own row, that row stands in for its family. `fast`: the
 * main chat runs in fast mode, so its version's fast row stands in instead, where there is one (P-29).
 */
export function forModel(prices: Prices, model: string | null | undefined, fast = false): Prices {
  const base: Prices = prices.family ? { ...prices, ...prices.family } : prices
  const key = olderKey(model)
  const t = tierOf(model)
  const fk = fast ? fastKey(model) : undefined
  const own = (fk ? base.fast?.[fk] : undefined) ?? (key ? base.versions?.[key] : undefined)
  if (!own || !t) return prices.family ? (({ family: _f, ...rest }) => rest as Prices)(base) : prices
  const family = Object.fromEntries(TIERS.map(x => [x, base[x]])) as Record<Tier, Price>
  return { ...base, [t]: own, family }
}

// ---- Cache life ---------------------------------------------------------------
// Claude Code decides the prompt cache's life (its TTL) per request, in two buckets: the main conversation, and everything
// else (subagents, forks, compaction). Its precedence (docs, "How Claude Code uses prompt caching", v2.1.242+):
// FORCE_PROMPT_CACHING_5M=1; the bucket's environment variable; the bucket's setting; ENABLE_PROMPT_CACHING_1H=1; the
// bucket's default. The main conversation's default is 1 hour on a Claude subscription within its plan, 5 minutes on an API
// key, a cloud provider or gateway, or a subscription drawing on usage credits. Everything else defaults to 5 minutes. A cacheTtl in
// prices.json is the person's own word, kept for a gateway rightsize cannot read; it ranks just above the default.

export type Ttl = '5m' | '1h'
export const TTL_MS: Record<Ttl, number> = { '5m': 5 * 60_000, '1h': 60 * 60_000 }
export const isTtl = (v: unknown): v is Ttl => v === '5m' || v === '1h'
const on = (v: unknown) => v === '1' || v === 'true'

/** prices.json's cacheTtl, when the person set one; undefined when absent, unreadable or not 5m/1h. */
export function fileTtl(raw: string): Ttl | undefined {
  try {
    const v = (JSON.parse(raw) as { cacheTtl?: unknown }).cacheTtl
    return isTtl(v) ? v : undefined
  } catch {
    return undefined
  }
}

export type TtlInputs = {
  /** FORCE_PROMPT_CACHING_5M */
  force5m?: string
  /** CLAUDE_CODE_PROMPT_CACHE_TTL, or CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL for helpers */
  env?: string
  /** The promptCacheTtl setting, or subagentPromptCacheTtl for helpers */
  setting?: unknown
  /** ENABLE_PROMPT_CACHING_1H */
  enable1h?: string
  /** prices.json's cacheTtl (main conversation only) */
  file?: Ttl
  /** What the rate limits showed; undefined before the first response */
  billing?: 'api' | 'subscription'
  /** True when a subscription window reads 100% or more: the session is on usage credits, billed per token */
  onCredits?: boolean
  /** True on Bedrock, Vertex or a gateway (a base URL that is not Anthropic's): per-token billing, whatever rate limits show or do not show (P-16) */
  cloud?: boolean
}

/** The main conversation's cache life and what decided it. Before the first response (`billing` unknown) it is 1 hour, as before. */
export function resolveTtl(i: TtlInputs): { ttl: Ttl; by: string } {
  if (on(i.force5m)) return { ttl: '5m', by: 'FORCE_PROMPT_CACHING_5M' }
  if (isTtl(i.env)) return { ttl: i.env, by: 'CLAUDE_CODE_PROMPT_CACHE_TTL' }
  if (isTtl(i.setting)) return { ttl: i.setting, by: 'the promptCacheTtl setting' }
  if (on(i.enable1h)) return { ttl: '1h', by: 'ENABLE_PROMPT_CACHING_1H' }
  if (i.file) return { ttl: i.file, by: 'prices.json' }
  // A cloud provider or gateway has no plan to be inside: 5 minutes, even before (or without) rate limits that say the billing.
  if (i.cloud && i.billing !== 'subscription') return { ttl: '5m', by: 'a cloud provider or gateway' }
  if (i.billing === 'api') return { ttl: '5m', by: 'API billing' }
  if (i.billing === 'subscription') return i.onCredits ? { ttl: '5m', by: 'a subscription on usage credits' } : { ttl: '1h', by: 'a subscription within its plan' }
  return { ttl: '1h', by: 'default, billing not seen yet' }
}

/** The cache life of helpers, Claude's subagents and forks, and what decided it: 5 minutes unless Claude Code is told otherwise. */
export function resolveHelperTtl(i: Pick<TtlInputs, 'force5m' | 'env' | 'setting' | 'enable1h'>): { ttl: Ttl; by: string } {
  if (on(i.force5m)) return { ttl: '5m', by: 'FORCE_PROMPT_CACHING_5M' }
  if (isTtl(i.env)) return { ttl: i.env, by: 'CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL' }
  if (isTtl(i.setting)) return { ttl: i.setting, by: 'the subagentPromptCacheTtl setting' }
  if (on(i.enable1h)) return { ttl: '1h', by: 'ENABLE_PROMPT_CACHING_1H' }
  return { ttl: '5m', by: 'default' }
}

/** "1 hour" or "5 minutes". */
export const ttlText = (ms: number) => (ms >= TTL_MS['1h'] ? '1 hour' : '5 minutes')

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

// What one API response cost. An unknown model costs nothing rather than a guess. `fast`: it ran in fast mode (P-29).
export function usageCost(prices: Prices, model: string, u: Usage, fast = false) {
  const p = priceOf(prices, model, fast)
  if (!p) return 0
  return dollars(atPrompt(p, contextOf(u)), {
    input: u.input_tokens,
    output: u.output_tokens,
    cacheRead: u.cache_read_input_tokens,
    cacheWrite: u.cache_creation_input_tokens,
  })
}

/** What one response's output tokens cost (thinking tokens are output). An unknown model costs nothing rather than a guess. */
export function outputCost(prices: Prices, model: string, u: Usage, fast = false) {
  const p = priceOf(prices, model, fast)
  if (!p) return 0
  return dollars(atPrompt(p, contextOf(u)), { output: u.output_tokens })
}

/** Characters per token for the text and tool input a response wrote: the rough ratio the rest of the mod uses to size text. */
const OUTPUT_CHARS_PER_TOKEN = 4

/** What one response's output was made of: tokens and list-price dollars, split into thinking, text and code written (tool input). */
export type OutputSplit = { tokens: number; thinking: number; text: number; code: number; cost: number; thinkingCost: number; textCost: number; codeCost: number }

/**
 * Splits one response's output (its `output_tokens`, thinking included) into thinking, text and code written. The engine reports
 * only the total, so the text and the tool calls are sized from what the response wrote (its visible text; each tool call's name and
 * input as JSON, about 4 characters a token), and thinking is what is left. When the sizes come to more than the total, they are
 * scaled down to it and thinking is 0. Costs are the response's output cost shared out by those tokens. An unknown model costs nothing.
 */
export function splitOutput(prices: Prices, model: string, u: Usage, answer: string, toolUses: readonly { name: string; input: unknown }[], fast = false): OutputSplit {
  const tokens = Math.max(0, u.output_tokens)
  const size = (chars: number) => Math.ceil(chars / OUTPUT_CHARS_PER_TOKEN)
  const json = (v: unknown) => (typeof v === 'string' ? v : (JSON.stringify(v) ?? '')).length
  let text = size(answer.length)
  let code = toolUses.reduce((n, t) => n + size(t.name.length + json(t.input)), 0)
  if (text + code > tokens) {
    const k = tokens / (text + code)
    text = Math.floor(text * k)
    code = Math.floor(code * k)
  }
  const thinking = tokens - text - code
  const cost = outputCost(prices, model, u, fast)
  const part =(n: number) => (tokens > 0 ? (cost * n) / tokens : 0)
  return { tokens, thinking, text, code, cost, thinkingCost: part(thinking), textCost: part(text), codeCost: part(code) }
}

// ---- Output advice ----------------------------------------------------------

/** When rightsize suggests the Concise output style: output at least 25% of the session's cost, 20 main-chat requests, $1.00 at list prices (ADR 0050). */
export const OUTPUT_ADVICE = { share: 0.25, requests: 20, cost: 1 } as const

/** The main chat's totals so far this session, at list (API) prices. */
export type SessionSpend = { output: number; total: number; requests: number }

/** True when all three bars are met. */
export const outputAdviceDue = (s: SessionSpend): boolean =>
  s.requests >= OUTPUT_ADVICE.requests && s.total >= OUTPUT_ADVICE.cost && s.total > 0 && s.output / s.total >= OUTPUT_ADVICE.share

/** "Output is about 38% of this session's cost." */
export const outputShareText = (s: SessionSpend): string => `Output is about ${Math.round((s.output / s.total) * 100)}% of this session's cost.`

// ---- Rating ----------------------------------------------------------------

/** Per model, the lowest level it does the work well at; null where it would struggle, absent where unknown. */
export type Fit = Partial<Record<Tier, Level | null>>

export type Rating = {
  /** The level the work needs on the session's model (see needOn). */
  level: Level
  fit: Fit
  type: TaskType
  /** What the request is about, as the rater read it (P-70). Only a review's design and text subjects change a route. */
  subject?: Subject
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
  /** The rater said it was not sure how hard the work is: the prompt is left as it is (P-30, ADR 0071). */
  unsure?: true
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

/**
 * Per key, how many runs were seen and the ratio of actual to estimated cost. Since P-44 (ADR 0074) the ratio is learned in
 * dollars: `act` and `est` are moving averages of the actual and estimated cost, and `ratio` is act / est (0.1 to 10). A key
 * stored before that has only `ratio` (the mean of per-turn ratios); its next sample starts the dollar averages from it.
 */
export type Calibration = Record<string, { n: number; ratio: number; act?: number; est?: number }>
/** Runs per key before the measured ratio fully replaces the guess. */
export const CAL_FULL = 20
/** Key for the share of effort switches that cost a cache miss, learned from each measured switch. */
export const SWITCH_KEY = 'cache:effort-switch'
/**
 * The share assumed to miss before any switch is measured: none (ADR 0024). Anthropic's docs say an effort change
 * keeps the prompt cache on Opus 5.5, Sonnet 5.5, Haiku 5.5 and Fable 5.1 with the Claude API or a subscription
 * (Claude Code 2.1.260 or later), and every measured switch in the private bench kept it. A gateway, Bedrock, Google
 * Cloud's Agent Platform or an older model still rebuilds the conversation: there the person's own measured switches
 * raise the share (factor blends them in from the first one), so a switch is priced again after a few misses.
 */
export const SWITCH_MISS_PRIOR = 0
/**
 * Once this many measured switches have missed at most SWITCH_KEPT_MAX of the time, a switch is priced as free
 * whatever the blend says: the rare miss is noise, and pricing it would stop every small lowering on a big conversation.
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
    const { n, ratio, act, est } = (e ?? {}) as { n?: unknown; ratio?: unknown; act?: unknown; est?: unknown }
    if (typeof n === 'number' && n > 0 && typeof ratio === 'number' && Number.isFinite(ratio)) {
      const dollars = typeof act === 'number' && Number.isFinite(act) && act >= 0 && typeof est === 'number' && Number.isFinite(est) && est > 0
      out[k] = dollars ? { n, ratio, act, est } : { n, ratio }
    }
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

/** Runs after which the averages become moving averages, so old runs fade. */
export const CAL_WINDOW = 50

/**
 * Learns one run. With its `actual` and `estimated` cost (P-44, ADR 0074), the key keeps moving averages of both and its ratio
 * is their ratio: the dollar-weighted error, the one a route choice compares. A cheap turn that ran 10 times its estimate no longer
 * moves the ratio as much as an expensive one that did. A key learned the old way starts its averages from its ratio over a unit
 * estimate. With `sample` only (no amounts, as the switch key is learned), it keeps the plain running mean of samples.
 */
export function learn(cal: Calibration, key: string, sample: number, amounts?: { actual: number; estimated: number }): Calibration {
  const e = cal[key] ?? { n: 0, ratio: 0 }
  const n = e.n + 1
  const w = Math.min(n, CAL_WINDOW)
  if (!amounts || !(amounts.estimated > 0) || !(amounts.actual >= 0) || !Number.isFinite(amounts.actual)) {
    return { ...cal, [key]: { n, ratio: e.ratio + (sample - e.ratio) / w } }
  }
  const act0 = e.act ?? (e.n > 0 ? e.ratio : 0)
  const est0 = e.est ?? (e.n > 0 ? 1 : 0)
  // The averages are of the costs relative to this run's estimate scale: dollars, so a big run weighs more.
  const act = act0 + (amounts.actual - act0) / w
  const est = est0 + (amounts.estimated - est0) / w
  const ratio = est > 0 ? Math.min(10, Math.max(0.1, act / est)) : sample
  return { ...cal, [key]: { n, ratio, act, est } }
}

export const ratioSample = (actual: number, estimated: number) =>
  estimated > 0 ? Math.min(10, Math.max(0.1, actual / estimated)) : 1

/**
 * Rescales every key's ratio by `factor`, for when the estimate's basis changes (the step exponent applied or
 * stopped): the ratios were learned against the old basis. The switch key is a share of misses, not a cost, so it stays.
 */
export function rebaseCal(cal: Calibration, factor: number): Calibration {
  const out: Calibration = {}
  for (const [key, e] of Object.entries(cal)) {
    if (key === SWITCH_KEY) {
      out[key] = e
      continue
    }
    const ratio = Math.min(10, Math.max(0.1, e.ratio * factor))
    // The dollar averages keep their estimate side; the actual side moves with the new basis.
    out[key] = e.act !== undefined && e.est !== undefined ? { n: e.n, ratio, act: e.act * factor, est: e.est } : { n: e.n, ratio }
  }
  return out
}

// ---- Estimates -------------------------------------------------------------

/**
 * The store key for calibration. It changed from 'calibration' when estimates began to
 * differ by model and level: ratios learned against the old estimates would double-count,
 * so the old key is ignored, never read, migrated or deleted.
 */
export const CAL_STORE = 'calibration-v2'
/** When calibration was last saved (ISO, UTC): the report's "last updated". Cleared with CAL_STORE. */
export const CAL_AT_STORE = 'calibration-at'

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
  /** The context window Claude Code reports for the session (its current model); absent when it did not say. See `fitsWindow`. */
  reportedWindow?: number
  prices: Prices
  /** The main chat runs an older version (ADR 0031): an effort switch there rebuilds the conversation, so every switch is priced as a miss. */
  older?: boolean
  /** Prices at the helpers' cache life (5 minutes unless Claude Code is told otherwise); `prices` when absent. */
  helperPrices?: Prices
  cal: Calibration
  /** The hand-off and lowering shares; DEFAULT_RULES when absent. */
  rules?: Rules
  /** How often the rater's judgement was wrong, by `${type}:${tier}` (see misses.ts): at the pause share or more, that model gets no hand-down and no lowering. */
  misses?: Record<string, number>
  /**
   * The routes paused now (lowerpause.ts pausedNow): prompts left per `${type}:${tier}`, or -1 for a route paused on the
   * research alone. When present it decides the pause and `misses` does not; absent, a share of misses at the line pauses.
   */
  paused?: Record<string, number>
  /** The share of misses at which that pause starts; null: never pause. MISS_BLOCK when absent. */
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
  /** The learned step exponent (see steps.ts): the work is priced for `steps ** (1 + stepExp)` steps. 0 when absent, which prices the rater's guess as it is. */
  stepExp?: number
}

/** The share of wrong judgements at which rightsize stops trusting the rater for a task type and model: the fixed Pause after misses share. */
export const MISS_BLOCK = 0.2
/** Fewer tasks logged than the evidence rule asks for. */
const unproven = (s: Situation, type: TaskType, tier: Tier) => (s.minTasks ?? 0) > (s.counts?.[`${type}:${tier}`] ?? 0)
const missPaused = (s: Situation, type: TaskType, tier: Tier) => {
  if (s.paused) return (s.paused[`${type}:${tier}`] ?? 0) !== 0
  const line = s.missBlock === undefined ? MISS_BLOCK : s.missBlock
  return line !== null && (s.misses?.[`${type}:${tier}`] ?? 0) >= line
}
const blocked = (s: Situation, type: TaskType, tier: Tier) => unproven(s, type, tier) || missPaused(s, type, tier)

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
  return switches * (s.older ? 1 : switchMissShare(s.cal)) * miss
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
  // A subagent writes the 5-minute cache (its own bucket), whatever the main conversation writes.
  const p = (s.helperPrices ?? s.prices)[sub]
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
  extract: 'sonnet',
  summarize: 'sonnet',
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

/** How a close call was decided: `over` is the route it beat, or the guide's pick when exploring. */
export type Tie = { by: 'guide' | 'stronger' | 'explore'; over: Tier }

/**
 * Chooses among candidate routes that already passed every other rule, sorted by cost.
 * The cheapest wins unless another is close to it (see tieBand, over the smaller run count
 * of the pair): then the one on the task type's preferred model, else the stronger model.
 * It never widens the candidates: it only chooses among them.
 */
function choose<T extends { tier: Tier; cost: number; n: number }>(type: TaskType, sorted: readonly T[]): { pick: T; tie?: Tie } | undefined {
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
  | { kind: 'switch'; tier: Tier; level: Level; cost: number; mainCost: number; rule: 'review' | 'haiku' }

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
 * is never a reason to spend.
 */
export function pacedRules(rules: Rules, p: Pace): Rules {
  if (p.mode === 'max') return { handOff: Math.max(rules.handOff, 0.95), lower: 1 }
  if (p.mode === 'hot') return { handOff: Math.min(0.95, rules.handOff + 0.15), lower: Math.min(0.99, rules.lower + 0.07) }
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
/** A review of a design document or of prose (subject `design` or `text`): it runs on Sonnet at medium or more, not on Opus at high (P-70, ADR 0086). */
export const lightReview = (r: Rating) => r.type === 'review' && (r.subject === 'design' || r.subject === 'text')
/** A review that keeps its level on Opus and Fable: every review but a light one. */
const heldReview = (r: Rating) => r.type === 'review' && !lightReview(r)
export const NO_PROMPT_RAISE: readonly Tier[] = ['opus', 'fable']
const DEBUG_HOLD_TIER: Tier = 'sonnet'
/** On Sonnet a rated raise is taken only for a task rated at least this hard and at least SONNET_RAISE_STEPS big (ADR 0021). */
export const SONNET_RAISE_LEVEL: Level = 'high'
export const SONNET_RAISE_STEPS = 20
/** On Opus and Fable every task but a review runs at low (ADR 0021: on 145 runs low passed as often as medium). */
export const LOWER_TO: Level = 'low'
function heldRating(r: Rating, s: Situation): Rating {
  const own = r.fit[s.tier]
  // A model the rater says would struggle at any level is not held: the raise is the fallback when no stronger route exists.
  if (!own) return r
  // Opus and Fable: lower to low on every task type but review, whatever the rating says, and never raise at prompt time.
  if (NO_PROMPT_RAISE.includes(s.tier) && !heldReview(r)) return { ...r, level: LOWER_TO, fit: { ...r.fit, [s.tier]: LOWER_TO } }
  if (levelRank(own) <= levelRank(s.level) && levelRank(r.level) <= levelRank(s.level)) return r
  // Sonnet: a debugging raise is never taken (it bought no passes); any other raise only for a hard-rated task of 20 steps or more.
  const hardAndBig = levelRank(r.level) >= levelRank(SONNET_RAISE_LEVEL) && r.steps >= SONNET_RAISE_STEPS
  const held = NO_PROMPT_RAISE.includes(s.tier) ? !heldReview(r) : s.tier === DEBUG_HOLD_TIER && (r.type === 'debug' || !hardAndBig)
  if (!held) return r
  return { ...r, level: levelRank(r.level) > levelRank(s.level) ? s.level : r.level, fit: { ...r.fit, [s.tier]: levelRank(own) > levelRank(s.level) ? s.level : own } }
}

// The effort-only plan: lower or raise on the main model, or nothing.
/**
 * How many effort switches a lowering pays for. A per-prompt lower switches twice: down for this turn, back for the
 * next. Under the lower-to-low rule (NO_PROMPT_RAISE tiers, every task but a review) the next prompt lowers too, so
 * only the first switch is ever paid (ADR 0024).
 */
export function lowerSwitches(r: Rating, s: Situation): number {
  return NO_PROMPT_RAISE.includes(s.tier) && !heldReview(r) ? 1 : 2
}

/**
 * Whether the main chat may be lowered one level now, on `type` work on the session's model: the checks the effort plan makes
 * (P-46). There has to be room above the floor (Lowest effort), the route must not be paused (too few logged tasks, or the
 * rater wrong too often), and a review stays at its level (`reviews: true` lets a review through, for the effort plan, which only
 * sees one when no Opus route exists). `to` is the next level down, never under the floor. It does not weigh the saving: the
 * effort plan does that itself, and a person's own choice to lower needs no saving. The caller's own guards (the Lowering rule,
 * a pause, an unsure rating, Routing off, watch only) are not here.
 */
/** The end of canLowerNow's reason at the floor (the Lowest effort setting). */
export const LOWEST_EFFORT = ' is already the lowest effort'
/** The end of canLowerNow's reason when the route is paused on misses: the band offers Try lowering again for it. */
export const MISS_PAUSED = ': the rating was wrong too often'

export function canLowerNow(type: TaskType, s: Situation, floor: Level, o: { level?: Level; reviews?: boolean } = {}): { ok: true; to: Level } | { ok: false; why: string } {
  const level = o.level ?? s.level
  const next = LEVELS[levelRank(level) - 1]
  if (next === undefined || levelRank(level) <= levelRank(floor)) return { ok: false, why: `${level}${LOWEST_EFFORT}` }
  if (blocked(s, type, s.tier)) {
    if (unproven(s, type, s.tier)) return { ok: false, why: `lowering ${type} work on ${TIER_NAME[s.tier]} is paused: only ${s.counts?.[`${type}:${s.tier}`] ?? 0} of the ${s.minTasks} tasks it needs are logged` }
    const left = s.paused?.[`${type}:${s.tier}`] ?? 0
    const span = left > 0 ? ` for ${left} more ${left === 1 ? 'prompt' : 'prompts'}` : ''
    return { ok: false, why: `lowering ${type} work on ${TIER_NAME[s.tier]} is paused${span}${MISS_PAUSED}` }
  }
  if (type === 'review' && !o.reviews) return { ok: false, why: 'a review stays at its level' }
  return { ok: true, to: next }
}

/** The plan's reason when the level in use already fits: nothing was held back. */
export const NONE_FITS = 'the level in use fits'

/** "saves under 10%" for a lowering bar of 0.9; "saves nothing" when the bar is 1 or more. */
const pctUnder = (bar: number) => (bar >= 1 ? 'saves nothing' : `saves under ${Math.round((1 - bar) * 100)}%`)

export function effortPlan(r0: Rating, s: Situation, floor: Level): Plan {
  const r = heldRating(r0, s)
  const target = capRaise(clampFloor(r.level, floor), s)
  if (target === s.level) return { kind: 'none', why: NONE_FITS }
  if (levelRank(target) > levelRank(s.level)) return { kind: 'effort', dir: 'raise', level: target }
  // Reviews are not stopped here: plan() sends them to reviewPlan first, and only a review with no Opus route reaches this.
  const can = canLowerNow(r.type, s, floor, { level: s.level, reviews: true })
  if (!can.ok) return { kind: 'none', why: can.why }
  const now = mainCost(r, s, s.level, 0)
  const lowered = mainCost(r, s, target, lowerSwitches(r, s))
  if (lowered >= now * (s.rules ?? DEFAULT_RULES).lower) {
    // Name the cache only when the switch is priced; a free switch fails the bar because effort barely changes this prompt's cost.
    const why = switchCost(s, lowerSwitches(r, s)) > 0
      ? `lowering to ${target} saves less than the cache it costs`
      : `lowering to ${target} ${pctUnder((s.rules ?? DEFAULT_RULES).lower)}: most of this prompt's cost is reading the conversation, the same at any effort`
    return { kind: 'none', why }
  }
  return { kind: 'effort', dir: 'lower', level: target, saving: now - lowered }
}

// Reviews run on Opus at high effort or more, whatever the rating says: below that, a review
// misses the subtle bugs it is for, and the rater can't tell from the prompt. A session below
// Opus switches the main chat to Opus for that turn; an Opus session raises to high and doesn't lower. Fable plans as usual,
// with no route below Opus. A conversation larger than the target model's window is not switched (fitsWindow).
export const REVIEW_TIER: Tier = 'opus'
/** The weakest session model a hand-down to a helper starts from. */
export const HAND_DOWN_FROM: Tier = 'opus'
/** A hand-down to a helper other than Haiku pays only for a task of this many rated steps or more (ADR 0021). */
export const HAND_DOWN_STEPS = 20
/** The task types a Haiku helper takes (ADR 0021): mechanical work. The rest stays on a stronger model. */
export const HAIKU_TYPES: readonly TaskType[] = ['lookup', 'search', 'bulk-edit']
/** Extract and summarize went to Haiku until P-70 (ADR 0086). They now go to a Sonnet helper, at any size: no HAND_DOWN_STEPS floor. */
export const SONNET_HELPER_TYPES: readonly TaskType[] = ['extract', 'summarize']
/** A light review (see lightReview) runs on Sonnet at medium or more. */
export const LIGHT_REVIEW_TIER: Tier = 'sonnet'
export const LIGHT_REVIEW_LEVEL: Level = 'medium'
/** On a Haiku session these task types switch the main chat to Sonnet for the turn, as a review switches to Opus (ADR 0021). */
export const HAIKU_SWITCH_TYPES: readonly TaskType[] = ['debug', 'feature', 'refactor', 'writing']
export const HAIKU_SWITCH_TIER: Tier = 'sonnet'

/** The window a switch to `tier` must fit: prices.json's `window` for it, capped by the window Claude Code reports for the
 * session (ADR 0053). The report is for the session's own model, so it caps a target only when it is below that model's
 * window in prices.json: the account or plan holds the session under the model's full window (a 1M model run at 200K), and the
 * target is held the same way. A report equal to or above the session model's own window says nothing about other models
 * (a 200K Haiku session must still reach Sonnet at 1M). Undefined: no window known. */
export const switchWindow = (s: Situation, tier: Tier) => {
  const w = s.prices[tier].window
  const r = s.reportedWindow
  if (typeof r !== 'number' || !(r > 0)) return w
  const own = s.prices[s.tier].window
  const held = own === undefined || r < own
  return held ? (w === undefined ? r : Math.min(w, r)) : w
}

/** Whether the main conversation fits `tier`'s context window (`switchWindow`): a switch to a smaller window would
 * fail or compact mid-turn, so it is not made. A model with no window on file and no report fits. */
export const fitsWindow = (s: Situation, tier: Tier) => {
  const w = switchWindow(s, tier)
  return w === undefined || s.context <= w
}

// A Haiku session on work Haiku is not suited to: the main chat runs this turn on Sonnet, then goes back, under the
// Stronger model rule. Nothing when the rater says Sonnet would struggle too, or Sonnet is over the ceiling: plan() then routes as usual.
function haikuSwitchPlan(r: Rating, s: Situation, floor: Level): Plan | undefined {
  if (s.tier !== 'haiku' || !HAIKU_SWITCH_TYPES.includes(r.type)) return undefined
  const need = r.fit[HAIKU_SWITCH_TIER]
  if (!need || s.without?.includes(HAIKU_SWITCH_TIER) || overCeiling(need, s) || !fitsWindow(s, HAIKU_SWITCH_TIER)) return undefined
  const level = clampCeiling(clampFloor(need, floor), ceilingOf(s))
  const cost = mainCost(r, { ...s, tier: HAIKU_SWITCH_TIER }, level, 0) + (s.context * atPrompt(s.prices[HAIKU_SWITCH_TIER], s.context).cacheWrite) / 1e6
  return { kind: 'switch', tier: HAIKU_SWITCH_TIER, level, cost, mainCost: mainCost(r, s, s.level, 0), rule: 'haiku' }
}
export const REVIEW_LEVEL: Level = 'high'
const atLeast = (l: Level, min: Level) => (levelRank(l) < levelRank(min) ? min : l)

// A light review (subject design or text) is planned on Sonnet at medium or more. On Haiku it switches the main chat to Sonnet;
// on Sonnet it stays; on Opus and Fable it is not held, so plan() lowers it like other work.
function lightReviewPlan(r: Rating, s: Situation, floor: Level): Plan | undefined {
  const top = s.reviewCeiling && levelRank(s.reviewCeiling) < levelRank(ceilingOf(s)) ? s.reviewCeiling : ceilingOf(s)
  const level = clampCeiling(clampFloor(atLeast(r.fit[LIGHT_REVIEW_TIER] ?? LIGHT_REVIEW_LEVEL, LIGHT_REVIEW_LEVEL), floor), top)
  if (tierRank(s.tier) < tierRank(LIGHT_REVIEW_TIER)) {
    if (s.without?.includes(LIGHT_REVIEW_TIER) || !fitsWindow(s, LIGHT_REVIEW_TIER)) return undefined
    const cost = mainCost(r, { ...s, tier: LIGHT_REVIEW_TIER }, level, 0) + (s.context * atPrompt(s.prices[LIGHT_REVIEW_TIER], s.context).cacheWrite) / 1e6
    return { kind: 'switch', tier: LIGHT_REVIEW_TIER, level, cost, mainCost: mainCost(r, s, s.level, 0), rule: 'review' }
  }
  if (s.tier !== LIGHT_REVIEW_TIER) return undefined
  const target = capRaise(level, s)
  if (levelRank(target) > levelRank(s.level)) return { kind: 'effort', dir: 'raise', level: target, rule: 'review' }
  return { kind: 'none', why: `this kind of review stays on ${TIER_NAME[LIGHT_REVIEW_TIER]} at ${LIGHT_REVIEW_LEVEL} effort or more` }
}

function reviewPlan(r: Rating, s: Situation, floor: Level): Plan | undefined {
  if (lightReview(r)) return lightReviewPlan(r, s, floor)
  // Unlike a route in plan(), a ceiling below high does not drop this one: the review must still run,
  // so the switch is capped at the ceiling on purpose, though it then runs below the level a review needs.
  // The profile's review ceiling (Economy: high) caps it too.
  const top = s.reviewCeiling && levelRank(s.reviewCeiling) < levelRank(ceilingOf(s)) ? s.reviewCeiling : ceilingOf(s)
  const level = clampCeiling(clampFloor(atLeast(r.fit[REVIEW_TIER] ?? REVIEW_LEVEL, REVIEW_LEVEL), floor), top)
  if (tierRank(s.tier) < tierRank(REVIEW_TIER)) {
    if (s.without?.includes(REVIEW_TIER) || !fitsWindow(s, REVIEW_TIER)) return undefined
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
  const haiku = haikuSwitchPlan(r, s, floor)
  if (haiku) return haiku
  const stay = mainCost(r, s, s.level, 0)
  const routes = TIERS.flatMap(t => {
    const need = r.fit[t]
    if (t === s.tier || !need || s.without?.includes(t)) return []
    if (heldReview(r) && tierRank(t) < tierRank(REVIEW_TIER)) return []
    // A model that needs more than Highest effort allows does not fit: no route, up or down. The review
    // minimum is not counted here: a review on Opus is capped at the ceiling on purpose (see reviewPlan).
    if (overCeiling(need, s)) return []
    if (tierRank(t) < tierRank(s.tier)) {
      // A hand-down to a model the rater has been wrong about for this kind of work waits until its record mends.
      if (blocked(s, r.type, t)) return []
      // Haiku takes mechanical work only; any other helper pays only on a task of 20 steps or more (the brief and the check
      // cost more than it saves on a short one).
      if (t === 'haiku' ? !HAIKU_TYPES.includes(r.type) : r.steps < HAND_DOWN_STEPS && !SONNET_HELPER_TYPES.includes(r.type)) return []
    }
    const need2 = heldReview(r) && t === REVIEW_TIER ? atLeast(need, REVIEW_LEVEL) : lightReview(r) && t === LIGHT_REVIEW_TIER ? atLeast(need, LIGHT_REVIEW_LEVEL) : need
    const level = clampCeiling(clampFloor(need2, floor), ceilingOf(s))
    return [{ tier: t, level, cost: delegateCost(r, s, t, level), n: runsOn(s.cal, delegateKeys(r.type, t, level)) }]
  }).sort((a, b) => a.cost - b.cost)
  const own = r.fit[s.tier]
  if (!own) {
    const up = choose(r.type, routes.filter(x => tierRank(x.tier) > tierRank(s.tier)))
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
  const down = choose(r.type, routes.filter(x => tierRank(x.tier) < tierRank(s.tier) && x.cost < bar))
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
  const chosen = choose(r.type, weaker)
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

// ---- Re-estimate during a turn (P-44) -----------------------------------------

/** Main-chat requests after which a turn's cost is projected again from what it has really spent. */
export const REESTIMATE_AFTER = 5

/**
 * A turn's cost projected from its own pace after REESTIMATE_AFTER requests (P-44, ADR 0074): the cost per request so far
 * times the requests it will likely make. That is the rated steps while the turn is within them; a turn already at or past
 * its rated steps is assumed to be about halfway (a turn that has run long tends to run as long again). Never under what it
 * has spent. Logged beside the first estimate; nothing acts on it yet.
 */
export function reestimate(o: { spent: number; requests: number; steps: number }): number {
  if (!(o.spent > 0) || !(o.requests > 0)) return Math.max(0, o.spent)
  const per = o.spent / o.requests
  const expected = o.requests >= o.steps ? o.requests * 2 : o.steps
  return Math.max(o.spent, per * expected)
}
