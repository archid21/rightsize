// Fast mode (P-29, ADR 0069): whether the main chat runs in fast mode, and what a switch in or out of it costs. Pure functions;
// register.tsx reads the settings and the cost ledger and acts.
//
// Claude Code's `fastMode` setting is the person's saved choice, not the session's state: on Fable 5.2 it takes effect only after
// /fast on Fable 5.2, `fastModePerSessionOptIn` starts each session off, and a rate limit drops a request to standard speed. So
// the setting is the first guess, and what each main-chat request really cost (Claude Code's cost ledger, which prices as /cost
// does) settles it.

/** Fast mode as rightsize sees it: on or off, and what said so last. `pending` is a cost reading that disagreed once. */
export type FastState = { on: boolean; by: 'setting' | 'cost'; pending?: boolean }

const isOn = (v: string | undefined) => v === '1' || v === 'true'

/**
 * The first guess from Claude Code's settings and environment: the `fastMode` setting is true, per-session opt-in is not set,
 * CLAUDE_CODE_DISABLE_FAST_MODE is not set, and the main chat's model has fast prices. Off a first-party API, the setting does
 * not turn fast mode on (on Google Cloud it has no effect), so the guess is off there; the cost check still sees it.
 */
export function fastGuess(o: { setting: unknown; perSession: unknown; disabled: string | undefined; supported: boolean; firstParty: boolean }): boolean {
  return o.supported && o.firstParty && o.setting === true && o.perSession !== true && !isOn(o.disabled)
}

/** A request this cheap at standard prices says nothing: the ledger's rounding could be most of it. */
export const SPEED_MIN_USD = 0.0005
/** How far the ledger may be from a price and still match it: 20%. */
export const SPEED_TOLERANCE = 0.2

/**
 * What one main-chat request's ledger cost says about its speed: `true` when it is within 20% of the fast price and nearer that
 * than the standard one, `false` the same for the standard price, undefined when it matches neither (another request ran at the
 * same time, the ledger had not counted it yet) or the request was too small to tell.
 */
export function speedFromCost(o: { ledger: number; standard: number; fast: number }): boolean | undefined {
  if (!(o.standard >= SPEED_MIN_USD) || !(o.fast > o.standard) || !Number.isFinite(o.ledger) || o.ledger <= 0) return undefined
  const near = (price: number) => Math.abs(o.ledger - price) <= price * SPEED_TOLERANCE
  const fastNearer = Math.abs(o.ledger - o.fast) < Math.abs(o.ledger - o.standard)
  if (fastNearer && near(o.fast)) return true
  if (!fastNearer && near(o.standard)) return false
  return undefined
}

/**
 * The state after one cost reading. A reading that agrees clears any pending one. A standard-price reading against the setting's
 * guess of on wins at once: the guess was only a guess, and a rate limit drops requests to standard speed. Every other change
 * needs a second reading in a row, turning on always: a false "on" prices everything at fast rates, and a request whose window
 * took in another's cost reads as fast (ADR 0078).
 */
export function nextFast(s: FastState, reading: boolean | undefined): FastState {
  if (reading === undefined) return s
  if (reading === s.on) return { on: s.on, by: 'cost' }
  if (s.pending === reading || (s.by === 'setting' && !reading)) return { on: reading, by: 'cost' }
  return { ...s, pending: reading }
}

/**
 * What the first request after fast mode turns on or off pays for the conversation: fast and standard speed keep separate caches,
 * so it writes all `context` tokens again at the new speed's cache-write price (`write`, dollars per million tokens), as a model
 * switch does. In dollars, at least 0.
 */
export const speedSwitchCost = (o: { context: number; write: number }) => Math.max(0, (o.context * o.write) / 1e6)

/**
 * The band's line when fast mode turns on or off before a prompt: "Fast mode on: fast and standard speed keep separate caches, so
 * this prompt reads the whole conversation again (about $1.20)." `model`, when a model switch did it: " with the switch to Sonnet".
 */
export function speedSwitchText(o: { on: boolean; cost: string; model?: string }): string {
  return `Fast mode ${o.on ? 'on' : 'off'}${o.model ? ` with the switch to ${o.model}` : ''}: fast and standard speed keep separate caches, so this prompt reads the whole conversation again (${o.cost}).`
}
