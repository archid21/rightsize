// What rightsize knows about whatsnext, for Compact now and the handoff before the cache goes cold: rightsize's own compact
// text, the wrap-up limits and whether a plugin is whatsnext. Pure: no engine calls. register.tsx finds out
// whether whatsnext is installed and runs it.

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
