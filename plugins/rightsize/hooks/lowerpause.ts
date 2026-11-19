import { MISS_MIN, PRIOR_N, RESEARCH_PRIORS, type Rates, type RouteOutcome, type Versions, currentVersion, missRate, todayVersion } from './misses'

// The lowering pause that recovers (ADR 0082). A route (a kind of work on a model) is judged on its last PAUSE_LAST
// outcomes. When too many went wrong, lowering and hand-downs on it pause for a number of prompts of that work (the
// Advanced · Lowering pause row), counted down as the person works. Then the route is on probation: one wrong outcome
// pauses it again, until PAUSE_LAST outcomes since it came back. Try lowering again ends a pause at once, on probation.
// Pure functions, no engine calls.

/** The outcomes a route is judged on: the most recent ones. */
export const PAUSE_LAST = 10

/** The Advanced · Lowering pause options, in prompts. */
export const PAUSE_OPTIONS = ['5 prompts', '10 prompts', '15 prompts', '20 prompts'] as const
export const PAUSE_DEFAULT = '10 prompts'
/** The prompts a pause lasts, from the row's value; 10 for anything else. */
export const pauseLength = (v: unknown): number => {
  const n = typeof v === 'string' && (PAUSE_OPTIONS as readonly string[]).includes(v) ? Number.parseInt(v, 10) : 10
  return n
}

/** A route's pause: `left` prompts still paused (0: not paused); `since`, when it came back (its probation starts there). */
export type RoutePause = { left: number; since?: string; /** The model version the pause or probation was made on (P-77); none: the version current when P-77 shipped. */ version?: string }
export type Pauses = Record<string, RoutePause>

/** The store's value read back: only well-formed entries. */
export function pausesOf(v: unknown): Pauses {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  const out: Pauses = {}
  for (const [key, e] of Object.entries(v as Record<string, unknown>)) {
    if (!e || typeof e !== 'object') continue
    const { left, since, version } = e as { left?: unknown; since?: unknown; version?: unknown }
    if (typeof left !== 'number' || !(left >= 0)) continue
    out[key] = { left: Math.floor(left), ...(typeof since === 'string' ? { since } : {}), ...(typeof version === 'string' ? { version } : {}) }
  }
  return out
}

const tierOfKey = (key: string) => key.split(':')[1] ?? ''

/** Whether a stored pause or probation is on the version its tier is on now: another version's is a clean slate (P-77). */
export const pauseApplies = (p: RoutePause, key: string, current: Versions | undefined): boolean => (p.version ?? todayVersion(tierOfKey(key))) === currentVersion(current, tierOfKey(key))

/** The pauses that apply to the versions in use now; the others are left out. */
export const livePauses = (pauses: Pauses, current: Versions | undefined): Pauses => Object.fromEntries(Object.entries(pauses).filter(([key, p]) => pauseApplies(p, key, current)))

/** The stamp a new pause carries: its tier's version now (only when versions are tracked). */
const stamp = (key: string, current: Versions | undefined) => (current === undefined ? {} : { version: currentVersion(current, tierOfKey(key)) })

/** Whether a route on probation (or never judged before) went wrong again: what starts a pause. */
function due(list: readonly RouteOutcome[], p: RoutePause | undefined, line: number) {
  const since = p?.since ? Date.parse(p.since) : undefined
  const after = since === undefined ? list : list.filter(o => Date.parse(o.at) > since)
  const last = after.slice(-PAUSE_LAST)
  const misses = last.filter(o => o.miss).length
  // Back from a pause and not yet PAUSE_LAST outcomes on: one wrong outcome is enough.
  if (since !== undefined && after.length < PAUSE_LAST) return misses > 0
  return last.length >= MISS_MIN && misses / last.length >= line
}

/**
 * Judges every route with outcomes: a route not paused now whose recent outcomes are wrong too often starts a pause of
 * `length` prompts. `line` is the miss share that pauses (null: never pause, which clears every pause). Returns the new
 * pauses and the routes that just paused.
 */
export function judge(byKey: Readonly<Record<string, readonly RouteOutcome[]>>, pauses: Pauses, line: number | null, length: number, current?: Versions): { pauses: Pauses; started: string[] } {
  if (line === null) return { pauses: {}, started: [] }
  // A pause or probation made on another version of the model is gone: that route starts clean (P-77).
  const kept = current === undefined ? pauses : livePauses(pauses, current)
  const out: Pauses = { ...kept }
  const started: string[] = []
  for (const [key, list] of Object.entries(byKey)) {
    const p = kept[key]
    if (p && p.left > 0) continue
    if (!due(list, p, line)) continue
    out[key] = { left: length, ...stamp(key, current) }
    started.push(key)
  }
  return { pauses: out, started }
}

/**
 * One prompt of work on the paused `keys`: each counts down by one. A route that reaches 0 comes back, on probation
 * from `now`. Returns the new pauses and the routes that came back.
 */
export function tick(pauses: Pauses, keys: readonly string[], now: string): { pauses: Pauses; resumed: string[] } {
  const out: Pauses = { ...pauses }
  const resumed: string[] = []
  for (const key of keys) {
    const p = pauses[key]
    if (!p || p.left <= 0) continue
    if (p.left === 1) {
      out[key] = { left: 0, since: now, ...(p.version ? { version: p.version } : {}) }
      resumed.push(key)
    } else out[key] = { left: p.left - 1, ...(p.version ? { version: p.version } : {}) }
  }
  return { pauses: out, resumed }
}

/** A shorter Lowering pause applies to the pauses already running: none lasts longer than `length` more prompts. */
export const capPauses = (pauses: Pauses, length: number): Pauses =>
  Object.fromEntries(Object.entries(pauses).map(([key, p]) => [key, p.left > length ? { ...p, left: length } : p]))

/** Try lowering again: the route comes back now, on probation from `now`. */
export const retryRoute = (pauses: Pauses, key: string, now: string, current?: Versions): Pauses => ({ ...pauses, [key]: { left: 0, since: now, ...stamp(key, current) } })

/** Prompts left on a route with no count: paused on the research alone, until enough of the person's own tasks are logged. */
export const UNTIL_LOGGED = -1

/**
 * What Situation.paused holds: prompts left per paused route, and UNTIL_LOGGED for a route whose research prior says
 * it misses too often while fewer than PRIOR_N of the person's own outcomes are logged (Haiku on reviews, for one).
 */
export function pausedNow(pauses: Pauses, rates: Rates, line: number | null, current?: Versions): Record<string, number> {
  const out: Record<string, number> = {}
  if (line === null) return out
  for (const key of Object.keys(RESEARCH_PRIORS)) {
    const [type, tier] = key.split(':') as [string, string]
    // The research was done on today's versions: a newer version has not been measured, so its prior pauses nothing (P-77).
    if (currentVersion(current, tier) !== todayVersion(tier)) continue
    if ((rates[key]?.n ?? 0) < PRIOR_N && missRate(rates, type, tier, current) >= line) out[key] = UNTIL_LOGGED
  }
  for (const [key, p] of Object.entries(pauses)) if (p.left > 0 && pauseApplies(p, key, current)) out[key] = p.left
  return out
}
