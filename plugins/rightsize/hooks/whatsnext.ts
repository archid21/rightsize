// What rightsize knows about whatsnext, for Compact now and the handoff before the cache goes cold: whatsnext's compact
// text (a copy), the wrap-up limits and whether a plugin is whatsnext. Pure: no engine calls. register.tsx finds out
// whether whatsnext is installed and runs it.

/**
 * What rightsize's own compaction is told to keep and drop when whatsnext cannot compact. A copy of whatsnext's
 * `COMPACT_BASE` (`skills/whatsnext/scripts/wn/wrapup.py`): when whatsnext changes its text, change this one the same day.
 */
export const COMPACT_BASE =
  'Keep: the current task and its goal, the decisions made and why, the open questions, the file paths and commands that matter, and the next steps. Drop: tool output, file dumps and dead ends (approaches tried and abandoned), unless the reason one failed still matters.'

/** Over this many tokens of room left in the window, a wrap-up turn is safe; under it rightsize compacts with the handoff it has. */
export const WRAP_HEADROOM = 40_000
/** A wrap-up that whatsnext still says is missing after this many main-turn ends is given up on. */
export const WRAP_TURNS = 2
/** Said on the band when the compaction goes ahead without a fresh handoff. */
export const NO_FRESH_HANDOFF = 'no fresh handoff'

/** True when a plugin's name is whatsnext's (`whatsnext`, or `whatsnext@<marketplace>`). */
export const isWhatsnext = (plugin: string | undefined) => plugin === 'whatsnext' || (plugin ?? '').startsWith('whatsnext@')
