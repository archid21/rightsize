// What rightsize knows about whatsnext, for Compact now and the handoff before the cache goes cold: rightsize's own compact
// text, the wrap-up limits and whether a plugin is whatsnext. Pure: no engine calls. register.tsx finds out
// whether whatsnext is installed and runs it.

import { money } from './cost'
import type { Price } from './cost'
import { WRAP_UP, pingCost } from './warm'

/**
 * What rightsize's own compaction is told to write when whatsnext is not there or cannot compact: a handoff under eight
 * headings. rightsize's own text, no longer a copy of whatsnext's compact text; whatsnext keeps its own text and
 * appends its handoff note. The text was chosen by a test on saved sessions (ADR 0067).
 */
export const COMPACT_TEXT =
  "Write the summary as a handoff for someone resuming this work cold. Use these headings, in this order, and leave out any that are empty: Goal: the current task and what done looks like. Next action: the one next step, the command that verifies it, and what to do if it fails. State: what is finished, what is half done, and what is not yet verified. Files: each file changed or central to the task, as path:line, with one line on why. Decisions: each decision made and why. Instructions: what the user asked for or ruled out, in their words. Quote the user's words when they are unclear or are text to reuse, and do not turn an unclear phrase into a rule. Open questions: what is waiting on the user. Dead ends: each approach tried and abandoned, with the reason it failed. Drop tool output and file contents; keep exact paths, commands, error messages and numbers."

/** Over this many tokens of room left in the window, a wrap-up turn is safe; under it rightsize compacts with the handoff it has. */
export const WRAP_HEADROOM = 40_000
/** A wrap-up that whatsnext still says is missing after this many main-turn ends is given up on. */
export const WRAP_TURNS = 2
/** Said on the band when the compaction goes ahead without a fresh handoff. */
export const NO_FRESH_HANDOFF = 'no fresh handoff'

/** True when a plugin's name is whatsnext's (`whatsnext`, or `whatsnext@<marketplace>`). */
export const isWhatsnext = (plugin: string | undefined) => plugin === 'whatsnext' || (plugin ?? '').startsWith('whatsnext@')

/** True when a typed prompt is exactly `wrap up` (spaces and capitals do not matter): whatsnext's trigger for a handoff note. */
export const isWrapUp = (text: string) => text.trim().toLowerCase() === WRAP_UP

/** What a handoff note writes, in output tokens: the figure the hints price it at. */
export const NOTE_OUTPUT_TOKENS = 2000

/** What a whatsnext handoff note costs: one keep-warm request (the conversation read from the cache) and the note itself as output. */
export const noteCost = (price: Price, context: number) => pingCost(price, context) + (NOTE_OUTPUT_TOKENS * price.output) / 1e6

/** The install hint shows only when a note would have saved at least this much (dollars, API-equivalent on a subscription too). */
export const INSTALL_HINT_MIN = 0.25
/** It shows at most once in this long. */
export const INSTALL_HINT_EVERY_MS = 30 * 24 * 60 * 60_000

/** True when the install hint may show: the saving is enough, the person did not hide it for good, and the last one was over 30 days ago (`last`: when it last showed, ms; undefined: never). */
export const installHintDue = (o: { saved: number; hidden: boolean; last: unknown; now: number }) =>
  !o.hidden && o.saved >= INSTALL_HINT_MIN && !(typeof o.last === 'number' && Number.isFinite(o.last) && o.now - o.last < INSTALL_HINT_EVERY_MS)

/** "about $0.31", with " API-equivalent" on a subscription (the dollars are what the same use would cost on the API). */
const aboutMoney = (d: number, subscription: boolean) => `about ${money(d)}${subscription ? ' API-equivalent' : ''}`

/** The hint for a person without whatsnext: what a handoff note would have saved, and where to get it. */
export const installHintText = (saved: number, subscription: boolean) =>
  `A whatsnext handoff note would have saved ${aboutMoney(saved, subscription)} here. Install whatsnext (github.com/archid21/whatsnext) to save handoffs instead of compacting.`

/** The hint for whatsnext installed but not set up in this project. */
export const initHintText = (extra: number, subscription: boolean) =>
  `whatsnext isn't set up in this project, so rightsize compacted instead (${aboutMoney(extra, subscription)} more). Run \`whatsnext init\` here to save handoff notes.`

/** The init hint needs a saving that shows as a positive amount. */
export const INIT_HINT_MIN = 0.01
