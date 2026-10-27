import { type Price, type Tokens, dollars } from './cost'

// Before the cache goes cold: what rightsize can do for a big session that has ended a turn, before its prompt
// cache expires. Prices and the times come from rightsize's own parts (cost.ts prices, idleCost, cacheTtl).
// This file is the pure part: what each choice costs, how long keeping warm can last, the person's usual start
// time, and the words of the offer. Pure functions, no engine calls; register.tsx does the waiting and the calls.

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** The row acts only when coming back cold costs at least this many dollars (API-equivalent on a subscription too). */
export const COLD_MIN = 0.5

/** The request that keeps the cache warm: the fork re-reads the whole conversation from the cache, and so refreshes it. */
export const PING_PROMPT = 'Reply with the single word OK.'

/** The prompt Groundwork's skill answers with its wrap-up flow. */
export const WRAP_UP = 'wrap up'

/** How long before the cache expires rightsize acts: 3 minutes for a 1-hour cache, 1 minute for a 5-minute cache. */
export const leadMs = (ttl: number) => (ttl >= HOUR ? 3 * MIN : MIN)

/** Time between two keep-warm requests: the cache's life less the lead. */
export const pingEvery = (ttl: number) => ttl - leadMs(ttl)

/**
 * What one keep-warm request cost, from its usage; when the usage is missing, a cache read of the whole conversation.
 * The fork answers over the cached conversation, so that is what it is billed for, give or take a few tokens.
 */
export function pingCost(p: Price, context: number, usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }) {
  const t: Tokens = usage
    ? { input: usage.input_tokens, output: usage.output_tokens, cacheRead: usage.cache_read_input_tokens, cacheWrite: usage.cache_creation_input_tokens }
    : { cacheRead: context }
  return dollars(p, t)
}

/** How many requests keep the cache warm for `ms` after the turn ended: one each `pingEvery`, while the time is before the end. */
export const pingsFor = (ms: number, ttl: number) => Math.max(0, Math.ceil(ms / pingEvery(ttl)) - 1)

/** How many requests cost no more than coming back cold (the 1e-9 keeps a division that should be a whole number from rounding down). */
export const breakEvenPings = (cold: number, ping: number) => (ping > 0 ? Math.floor(cold / ping + 1e-9) : Infinity)

/** How long keeping warm lasts before it costs more than coming back cold, in ms. */
export const breakEvenMs = (cold: number, ping: number, ttl: number) => breakEvenPings(cold, ping) * pingEvery(ttl)

/** The plan for keeping warm for `ms` after the turn ended: the requests, whether break-even cut them short, and what they cost. */
export function warmPlan(o: { ms: number; ttl: number; cold: number; ping: number; endedAt: number }) {
  const wanted = pingsFor(o.ms, o.ttl)
  const most = breakEvenPings(o.cold, o.ping)
  const pings = Math.min(wanted, most)
  // The cache is warm until the last request's life runs out, or the chosen end if that is first.
  const endsAt = Math.min(o.endedAt + o.ms, o.endedAt + pings * pingEvery(o.ttl) + o.ttl)
  return { pings, wanted, capped: pings < wanted, cost: pings * o.ping, endsAt }
}

// ---- The person's usual start time -------------------------------------------

export const START_DAYS = 14
/** Fewer days of runs than this say nothing about a habit. */
export const START_MIN_DAYS = 5
/** Used until the log shows a habit: 9:00 local time. */
export const DEFAULT_START = 9 * 60

type Stamped = { at: string; submittedAt?: string; kind?: string }

/**
 * The time of day the person usually sends their first prompt: the median, over the last 14 days of the run log, of each
 * day's first prompt (local time; the prompt's `submittedAt`, else the line's `at`), rounded to 15 minutes. As minutes
 * after midnight. Fewer than 5 days of runs: 9:00.
 */
export function usualStart(lines: readonly Stamped[], now: number): { minutes: number; days: number; fallback: boolean } {
  const first = new Map<string, number>()
  for (const l of lines) {
    if ((l.kind ?? 'run') !== 'run') continue
    const t = Date.parse(l.submittedAt ?? l.at)
    if (!Number.isFinite(t) || t > now || now - t > START_DAYS * DAY) continue
    const d = new Date(t)
    const day = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
    const minute = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60
    const had = first.get(day)
    if (had === undefined || minute < had) first.set(day, minute)
  }
  const days = first.size
  if (days < START_MIN_DAYS) return { minutes: DEFAULT_START, days, fallback: true }
  const sorted = [...first.values()].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  const median = sorted.length % 2 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
  return { minutes: (Math.round(median / 15) * 15) % (24 * 60), days, fallback: false }
}

/** The next time the clock reads `minutes` after midnight (local time) after `from`; `tomorrow` says it is on the next calendar day. */
export function nextStart(from: number, minutes: number) {
  const d = new Date(from)
  d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0)
  if (d.getTime() <= from) d.setDate(d.getDate() + 1)
  const today = new Date(from)
  const tomorrow = d.getDate() !== today.getDate() || d.getMonth() !== today.getMonth() || d.getFullYear() !== today.getFullYear()
  return { at: d.getTime(), tomorrow }
}

/** "9:15", "14:05": local time, 24-hour clock. */
export function clockText(ms: number) {
  const d = new Date(ms)
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
}

// ---- The offer ---------------------------------------------------------------

export type Choice = { id: string; label: string; /** Where keeping warm ends, for a duration. */ endsAt?: number; cost?: number }

/** How long a duration is, by id, for the offer: 2 h and 8 h on a 1-hour cache; 30 min and 1 h on a 5-minute one. */
const DURATIONS: Record<'long' | 'short', readonly { id: string; ms: number; name: string }[]> = {
  long: [
    { id: '2h', ms: 2 * HOUR, name: '2 h' },
    { id: '8h', ms: 8 * HOUR, name: '8 h' },
  ],
  short: [
    { id: '30m', ms: 30 * MIN, name: '30 min' },
    { id: '1h', ms: HOUR, name: '1 h' },
  ],
}

/**
 * The keep-warm choices for the offer, each with its price: only those that cost less than coming back cold. On a 1-hour
 * cache they are 2 h, 8 h and until the person's usual start time; on a 5-minute cache 30 min and 1 h, so a 5-minute
 * cache never offers more than break-even. `tag` writes a cost for a button.
 */
export function keepWarmChoices(o: { ttl: number; endedAt: number; cold: number; ping: number; startMinutes: number; tag: (usd: number) => string }): Choice[] {
  const long = o.ttl >= HOUR
  const out: Choice[] = []
  const add = (id: string, label: string, ms: number) => {
    const plan = warmPlan({ ms, ttl: o.ttl, cold: Infinity, ping: o.ping, endedAt: o.endedAt })
    if (plan.pings < 1 || plan.cost >= o.cold) return
    out.push({ id, label: `${label} · ${o.tag(plan.cost)}`, endsAt: o.endedAt + ms, cost: plan.cost })
  }
  for (const d of DURATIONS[long ? 'long' : 'short']) add(d.id, `Keep warm ${d.name}`, d.ms)
  if (long) {
    const next = nextStart(o.endedAt, o.startMinutes)
    // Shorter than the 2 h choice, it would be the same choice twice.
    if (next.at - o.endedAt > 2 * HOUR) add('start', `Until ${clockText(next.at)}${next.tomorrow ? ' tomorrow' : ''}`, next.at - o.endedAt)
  }
  return out
}

/** "Cache goes cold in ~60 min (80K tokens on Opus). Coming back cold: about $0.63." On a 5-minute cache it adds where keeping warm stops paying. */
export function offerText(o: { ttl: number; context: number; model: string; coldText: string; breakEven: number }) {
  const tokens = `${Math.round(o.context / 1000)}K`
  const head = `Cache goes cold in ~${Math.round(o.ttl / MIN)} min (${tokens} tokens on ${o.model}). Coming back cold: ${o.coldText}.`
  return o.ttl >= HOUR ? head : `${head} Keeping warm past about ${Math.floor(o.breakEven / MIN)} min costs more than coming back cold.`
}

/** The band while keeping warm: "Keeping warm until 14:05 · 3 pings, $0.04 so far". */
export function warmingText(o: { until: number; pings: number; spentText: string }) {
  const done = o.pings === 0 ? 'no pings yet' : `${o.pings} ping${o.pings === 1 ? '' : 's'}, ${o.spentText} so far`
  return `Keeping warm until ${clockText(o.until)} · ${done}`
}

/** What a row value does at a turn's end: `warm` has the hours. A handoff without Groundwork is a compaction. */
export type ColdPlan = { action: 'ask' | 'warm' | 'handoff' | 'compact' | 'off'; hours?: number }

export function coldPlan(value: string, groundwork: boolean): ColdPlan {
  switch (value) {
    case 'keep warm 2 h':
      return { action: 'warm', hours: 2 }
    case 'keep warm 8 h':
      return { action: 'warm', hours: 8 }
    case 'save a handoff':
      return { action: groundwork ? 'handoff' : 'compact' }
    case 'compact':
      return { action: 'compact' }
    case 'off':
      return { action: 'off' }
    default:
      return { action: 'ask' }
  }
}

/** True when a plugin's name is Cache Clock's, which already keeps a cache warm: rightsize leaves the cache to it. */
export const isCacheClock = (plugin: string | undefined) => /cache.?clock/i.test(plugin ?? '')

/** True when a plugin's name is Groundwork's (`groundwork`, or `groundwork@<marketplace>`). */
export const isGroundwork = (plugin: string | undefined) => plugin === 'groundwork' || (plugin ?? '').startsWith('groundwork@')
