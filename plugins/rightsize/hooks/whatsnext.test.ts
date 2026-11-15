import { expect, test } from 'claude-code/testing'
import { DEFAULT_PRICES } from './cost'
import { COMPACT_TEXT, INIT_HINT_MIN, INSTALL_HINT_EVERY_MS, INSTALL_HINT_MIN, NOTE_OUTPUT_TOKENS, NO_FRESH_HANDOFF, WRAP_HEADROOM, WRAP_TURNS, initHintText, installHintDue, installHintText, isWhatsnext, isWrapUp, noteCost } from './whatsnext'

test('whatsnext is found by plugin name, bare or with a marketplace', async () => {
  expect(isWhatsnext('whatsnext')).toBe(true)
  expect(isWhatsnext('whatsnext@whatsnext')).toBe(true)
  expect(isWhatsnext('whatsnext-lite')).toBe(false)
  expect(isWhatsnext('groundwork')).toBe(false)
  expect(isWhatsnext(undefined)).toBe(false)
})

test('the wrap-up limits and the compact text', async () => {
  expect(WRAP_HEADROOM).toBe(40_000)
  expect(WRAP_TURNS).toBe(2)
  expect(NO_FRESH_HANDOFF).toBe('no fresh handoff')
  expect(COMPACT_TEXT.startsWith('Write the summary as a handoff')).toBe(true)
  const headings = ['Goal:', 'Next action:', 'State:', 'Files:', 'Decisions:', 'Instructions:', 'Open questions:', 'Dead ends:']
  const at = headings.map(h => COMPACT_TEXT.indexOf(h))
  expect(at.every(i => i >= 0)).toBe(true)
  expect(at).toEqual([...at].sort((a, b) => a - b))
  expect(COMPACT_TEXT).toContain("Quote the user's words when they are unclear or are text to reuse, and do not turn an unclear phrase into a rule.")
  expect(COMPACT_TEXT.includes('\n')).toBe(false)
})

test('a typed prompt is wrap up when it is exactly that, whatever the spaces and capitals', async () => {
  for (const t of ['wrap up', 'Wrap up', '  WRAP UP\n']) expect(isWrapUp(t), t).toBe(true)
  for (const t of ['wrap up now', 'wrap  up', 'wrapup', '/wrap up', 'please wrap up', '']) expect(isWrapUp(t), t).toBe(false)
})

test('a handoff note costs one keep-warm request and 2,000 tokens of output', async () => {
  const opus = DEFAULT_PRICES.opus
  expect(NOTE_OUTPUT_TOKENS).toBe(2000)
  // 80,500 tokens read from the cache at $0.20 a million, 2,000 tokens written at $20 a million.
  expect(Math.round(noteCost(opus, 80_500) * 10_000) / 10_000).toBe(0.0561)
})

test('the install hint is due at $0.25 or more, once in 30 days, and never after it was hidden', async () => {
  const now = 1_800_000_000_000
  const base = { saved: 0.3, hidden: false, last: undefined as unknown, now }
  expect([INSTALL_HINT_MIN, INSTALL_HINT_EVERY_MS, INIT_HINT_MIN]).toEqual([0.25, 30 * 24 * 60 * 60_000, 0.01])
  expect(installHintDue(base)).toBe(true)
  expect(installHintDue({ ...base, saved: 0.25 }), 'exactly $0.25').toBe(true)
  expect(installHintDue({ ...base, saved: 0.2499 })).toBe(false)
  expect(installHintDue({ ...base, last: now - 29 * 24 * 60 * 60_000 })).toBe(false)
  expect(installHintDue({ ...base, last: now - INSTALL_HINT_EVERY_MS })).toBe(true)
  expect(installHintDue({ ...base, last: 'garbage' })).toBe(true)
  expect(installHintDue({ ...base, hidden: true, last: undefined })).toBe(false)
})

test('the hints say what was saved, and label the dollars API-equivalent on a subscription', async () => {
  expect(installHintText(0.266, false)).toBe('A whatsnext handoff note would have saved about $0.27 here. Install whatsnext (github.com/archid21/whatsnext) to save handoffs instead of compacting.')
  expect(installHintText(0.266, true)).toContain('about $0.27 API-equivalent here.')
  expect(initHintText(0.266, false)).toBe("whatsnext isn't set up in this project, so rightsize compacted instead (about $0.27 more). Run `whatsnext init` here to save handoff notes.")
  expect(initHintText(0.266, true)).toContain('(about $0.27 API-equivalent more)')
})
