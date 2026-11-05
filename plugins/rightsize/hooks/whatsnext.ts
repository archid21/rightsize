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
  // TODO(whatsnext-turn-on): when whatsnext has its "Turn on" setting, installed (installed === true) gets that button here.
  // Pressing it should turn the setting on and need no link; until whatsnext builds the setting there is nothing to press.
  return undefined
}
