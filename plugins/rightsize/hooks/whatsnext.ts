import { money } from './cost'
import { bandShareText, shareOf } from './report'

// The band note on the first prompt after a cold resume: what a whatsnext compaction beforehand would have saved. This
// file is the pure part: the words, the link and which button there is. Pure functions, no engine calls; register.tsx
// finds out whether whatsnext is installed and draws the note.

/** Where "Get whatsnext" goes: whatsnext's repository. */
export const WHATSNEXT_URL = 'https://github.com/archid21/whatsnext'

/** What the note's ⋯ menu says under "How it works". */
export const HOW_IT_WORKS =
  'whatsnext compacts large, closed threads with Haiku before you come back, so reopening one re-reads a short summary, not the whole conversation. At most 5 a day; it skips threads that are open.'

/**
 * What rightsize's own compaction is told to keep and drop when whatsnext cannot compact. A copy of whatsnext's
 * `COMPACT_BASE` (`skills/whatsnext/scripts/wn/wrapup.py`): when whatsnext changes its text, change this one the same day.
 */
export const COMPACT_BASE =
  'Keep: the current task and its goal, the decisions made and why, the open questions, the file paths and commands that matter, and the next steps. Drop: tool output, file dumps and dead ends (approaches tried and abandoned), unless the reason one failed still matters.'

/** The confirm dialog behind "Turn on": nothing is on until it is confirmed. 5 a day matches ADR 0012 and HOW_IT_WORKS. */
export const CONSENT_TEXT =
  'whatsnext will compact up to 5 closed threads a day with Haiku. Cost: up to $0.50 a day in API money, or up to 1M tokens a day of your usage windows on a subscription.'
export const CONSENT_ON = 'Turn on'
export const CONSENT_CANCEL = 'Cancel'
/** The whatsnext settings "Turn on" writes, through `whatsnext.py config set --user`. */
export const AUTO_KEY = 'compact.closed.auto'
export const BILLING_KEY = 'compact.closed.billing'

/** The note's button when whatsnext is installed and the closed-thread setting is off (`false`; unknown or on: none). */
export const TURN_ON_ID = 'wn-turn-on'
export const TURN_ON_BUTTON = { id: TURN_ON_ID, label: CONSENT_ON }

/** Over this many tokens of room left in the window, a wrap-up turn is safe; under it rightsize compacts with the handoff it has. */
export const WRAP_HEADROOM = 40_000
/** A wrap-up that whatsnext still says is missing after this many main-turn ends is given up on. */
export const WRAP_TURNS = 2
/** Said on the band when the compaction goes ahead without a fresh handoff. */
export const NO_FRESH_HANDOFF = 'no fresh handoff'

/** The note's ⋯ menu entries, with the ids `pressCold` answers. */
export const NOTE_HOW = 'wn-how'
export const NOTE_HIDE = 'wn-hide'
export const NOTE_MORE: readonly { id: string; label: string }[] = [
  { id: NOTE_HOW, label: 'How it works' },
  { id: NOTE_HIDE, label: "Don't show again" },
]

/** True when a plugin's name is whatsnext's (`whatsnext`, or `whatsnext@<marketplace>`). */
export const isWhatsnext = (plugin: string | undefined) => plugin === 'whatsnext' || (plugin ?? '').startsWith('whatsnext@')

/**
 * The note's line: "whatsnext could have saved $0.12 here." On a subscription, the share of the window the dollars stand for
 * ("... saved ~2% of your window here.") once runs show the rate, else the dollars, labelled API-equivalent. Undefined when
 * there is no saving (0, or not a number): no note. Any saving above 0 counts; there is no minimum.
 */
export function noteText(saving: number | undefined, subscription: boolean, rates: { low: number; high: number } | undefined) {
  if (typeof saving !== 'number' || !Number.isFinite(saving) || saving <= 0) return undefined
  const what = !subscription ? money(saving) : rates ? `${bandShareText(shareOf(saving, rates))} of your window` : `${money(saving)} API-equivalent`
  return `whatsnext could have saved ${what} here.`
}

/**
 * The note's one button, by whether whatsnext is installed (`undefined`: the plugin list could not be read, so nobody is told
 * to get what they may have). Not installed: "Get whatsnext", a link to its page. Installed: none yet.
 */
export function noteLink(installed: boolean | undefined): { label: string; href: string } | undefined {
  if (installed === false) return { label: 'Get whatsnext', href: WHATSNEXT_URL }
  return undefined
}

/** "Turn on" (a button, not a link) when whatsnext is installed and its closed-thread setting is off; otherwise none. */
export const noteButton = (installed: boolean | undefined, auto: boolean | undefined) => (installed === true && auto === false ? TURN_ON_BUTTON : undefined)
