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

/** The returning prompt's first request must read at least this share of the kept conversation from the cache, or keeping warm is not credited. */
export const WARM_PROOF = 0.8

/**
 * Whether a person's prompt at `now` is a return that keeping warm earned: a request of the run was answered after the turn
 * ended (`lastWarmAt`), the cache it refreshed was still alive (within `ttl` of that request, so the run was still going or had just
 * ended), and the prompt came after the time the cache would have gone cold without it (`endedAt + ttl`). A prompt before that
 * would have found a warm cache anyway, and one after the last request's life finds a cold one.
 */
export const warmReturned = (o: { now: number; endedAt: number; lastWarmAt: number; ttl: number }) =>
  o.lastWarmAt > o.endedAt && o.now - o.lastWarmAt <= o.ttl && o.now > o.endedAt + o.ttl

/** True when the cache read of a request is the kept conversation: at least WARM_PROOF of its tokens. */
export const cacheHeld = (read: number, context: number) => context > 0 && read >= context * WARM_PROOF

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

/** True when two times fall on the same local calendar day. */
const sameDay = (a: number, b: number) => {
  const x = new Date(a)
  const y = new Date(b)
  return x.getDate() === y.getDate() && x.getMonth() === y.getMonth() && x.getFullYear() === y.getFullYear()
}

// ---- The offer ---------------------------------------------------------------

export type Choice = { id: string; label: string; /** Where keeping warm ends, for a duration. */ endsAt?: number; cost?: number }

/** How long a duration is, by id, for the offer: 2 and 8 hours on a 1-hour cache; 30 min and 1 hour on a 5-minute one. */
const DURATIONS: Record<'long' | 'short', readonly { id: string; ms: number; name: string }[]> = {
  long: [
    { id: '2h', ms: 2 * HOUR, name: '2 hours' },
    { id: '8h', ms: 8 * HOUR, name: '8 hours' },
  ],
  short: [
    { id: '30m', ms: 30 * MIN, name: '30 min' },
    { id: '1h', ms: HOUR, name: '1 hour' },
  ],
}

/**
 * The keep-warm choices for the offer, each with its price: only those that cost less than coming back cold. On a 1-hour
 * cache they are 2 h, 8 h and until the person's usual start time; on a 5-minute cache 30 min and 1 h, so a 5-minute
 * cache never offers more than break-even. `tag` writes a cost for a button.
 *
 * Each label gives the clock time keeping warm ends ("Keep warm until 16:00 · $0.06"), counted from the turn's end, so it
 * never goes stale; " tomorrow" follows when that is a later calendar day than the turn's end. Two choices that end at the
 * same minute are one choice: the first stays.
 */
export function keepWarmChoices(o: { ttl: number; endedAt: number; cold: number; ping: number; startMinutes: number; tag: (usd: number) => string }): Choice[] {
  const long = o.ttl >= HOUR
  const out: Choice[] = []
  const seen = new Set<string>()
  const add = (id: string, ms: number) => {
    const plan = warmPlan({ ms, ttl: o.ttl, cold: Infinity, ping: o.ping, endedAt: o.endedAt })
    if (plan.pings < 1 || plan.cost >= o.cold) return
    const end = o.endedAt + ms
    const until = `${clockText(end)}${sameDay(end, o.endedAt) ? '' : ' tomorrow'}`
    if (seen.has(until)) return
    seen.add(until)
    out.push({ id, label: `Keep warm until ${until} · ${o.tag(plan.cost)}`, endsAt: end, cost: plan.cost })
  }
  for (const d of DURATIONS[long ? 'long' : 'short']) add(d.id, d.ms)
  if (long) {
    const next = nextStart(o.endedAt, o.startMinutes)
    // Shorter than the 2 h choice, it would be the same choice twice.
    if (next.at - o.endedAt > 2 * HOUR) add('start', next.at - o.endedAt)
  }
  return out
}

/**
 * The offer's line: "Cache goes cold at 14:55 · coming back cold costs ~2% ($1.10)". `endedAt` is when the turn ended; the
 * cache goes cold one `ttl` later, a clock time that stays true however long the row shows. `cost` is the cold cost as the
 * caller writes it ("about $1.10", "~2% ($1.10)"). On a 5-minute cache it adds where keeping warm stops paying, also as a
 * clock time.
 */
export function offerText(o: { ttl: number; endedAt: number; cost: string; breakEven: number }) {
  const head = `Cache goes cold at ${clockText(o.endedAt + o.ttl)} · coming back cold costs ${o.cost}`
  return o.ttl >= HOUR ? head : `${head}. Keeping warm past ${clockText(o.endedAt + o.breakEven)} costs more than coming back cold.`
}

/** How long after a turn ends the offer shows on a cache of 1 hour or more: the person may be about to send a prompt, and the offer would only be in the way. */
export const OFFER_AFTER_MS = 5 * MIN

/** When the offer shows, for a turn that ended at `endedAt`: at once on a cache under 1 hour, `OFFER_AFTER_MS` later on a longer one. */
export const offerAt = (endedAt: number, ttl: number) => (ttl >= HOUR ? endedAt + OFFER_AFTER_MS : endedAt)

/**
 * The band while keeping warm: "Keeping warm until 14:05 · ~0.1% used so far", "· ~$0.04 so far", "· $0.04 so far".
 * `used` is what the requests cost, as the caller writes it ("~0.1% used", "~$0.04", "$0.04"); none before the first request.
 */
export function warmingText(o: { until: number; used: string | undefined }) {
  return `Keeping warm until ${clockText(o.until)} · ${o.used === undefined ? 'nothing used yet' : `${o.used} so far`}`
}

/** How a keep-warm run ends on the band: "Stopped keeping warm · ~0.1% used." `what` is the end's words, without a full stop. */
export const warmEndText = (what: string, used: string | undefined) => `${what} · ${used ?? 'nothing used'}.`

// ---- What the person picks ---------------------------------------------------

/** A log line as the offer's history reads it: a `cold` line carries the choice pressed, or `ignored`. */
type Answered = { at: string; kind?: string; choice?: string }

/** The offers' outcomes in the log, oldest first. */
const outcomes = (lines: readonly Answered[]) =>
  lines
    .filter(l => l.kind === 'cold' && typeof l.choice === 'string')
    .sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0))
    .map(l => l.choice as string)

/** Offers that were pressed, not ignored. */
const pressed = (lines: readonly Answered[]) => outcomes(lines).filter(c => c !== 'ignored')

/** The one button looks back over this many answered offers. */
export const LEARN_OVER = 10

/**
 * The choice the person picked most often in their last 10 answered offers (any session), counting only the choices in
 * `among`: those this offer has. A tie goes to the one picked most recently. Undefined with no history or no match.
 */
export function learnedChoice(lines: readonly Answered[], among: readonly string[]): string | undefined {
  const last = pressed(lines).slice(-LEARN_OVER)
  let best: { id: string; count: number; latest: number } | undefined
  for (const id of new Set(last)) {
    if (!among.includes(id)) continue
    const count = last.filter(c => c === id).length
    const latest = last.lastIndexOf(id)
    if (!best || count > best.count || (count === best.count && latest > best.latest)) best = { id, count, latest }
  }
  return best?.id
}

/** The /config row value a choice stands for; a choice with none (a keep-warm until the usual start, let it go cold) is not here. */
export const ROW_OF: Readonly<Record<string, string>> = { '2h': 'keep warm 2 h', '8h': 'keep warm 8 h', handoff: 'save a handoff', compact: 'compact' }

/** The same answer this many offers in a row makes the person a standing-rule offer. */
export const ALWAYS_AFTER = 3

const ALWAYS: Readonly<Record<string, string>> = { '2h': 'Always keep warm 2 hours?', '8h': 'Always keep warm 8 hours?', handoff: 'Always save a handoff?', compact: 'Always compact?' }

/** The standing-rule question for a choice: "Always keep warm 2 hours?", "Always save a handoff?", "Always compact?". */
export const alwaysText = (choice: string) => ALWAYS[choice] ?? ''

/** The choice to ask "Always …?" about: the last 3 answered offers were that one choice, it has a row value, this offer has it, and it was not asked about before. */
export function standingChoice(lines: readonly Answered[], among: readonly string[], asked: readonly string[]): string | undefined {
  const last = pressed(lines).slice(-ALWAYS_AFTER)
  const id = last[0]
  if (last.length < ALWAYS_AFTER || id === undefined || !last.every(c => c === id)) return undefined
  return id in ROW_OF && among.includes(id) && !asked.includes(id) ? id : undefined
}

/** This many offers in a row with no answer make the person a back-off offer. */
export const BACK_OFF_AFTER = 5

/** True when the last 5 offers were all ignored. */
export const ignoredLately = (lines: readonly Answered[]) => {
  const last = outcomes(lines).slice(-BACK_OFF_AFTER)
  return last.length === BACK_OFF_AFTER && last.every(c => c === 'ignored')
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
