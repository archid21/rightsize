import { expect, test } from 'claude-code/testing'
import { AUTO_KEY, BILLING_KEY, CONSENT_TEXT, COMPACT_BASE, TURN_ON_BUTTON, WRAP_HEADROOM, HOW_IT_WORKS, NOTE_MORE, noteButton, WHATSNEXT_URL, isWhatsnext, noteLink, noteText } from './whatsnext'

test('the note says what whatsnext could have saved: dollars on the API, with any saving above 0', async () => {
  expect(noteText(0.12, false, undefined)).toBe('whatsnext could have saved $0.12 here.')
  expect(noteText(0.4199, false, undefined)).toBe('whatsnext could have saved $0.42 here.')
  expect(noteText(12.4, false, undefined), 'whole dollars from $10').toBe('whatsnext could have saved $12 here.')
  expect(noteText(0.001, false, undefined), 'no minimum').toBe('whatsnext could have saved under $0.01 here.')
  expect(noteText(0.12, false, { low: 1, high: 3 }), 'the rate is for a subscription only').toBe('whatsnext could have saved $0.12 here.')
})

test('on a subscription the note says the share of your window, in the band\'s percent form; with no rate, dollars labelled API-equivalent', async () => {
  // $0.12 at 15 to 20 points of the window a dollar: 1.8 to 2.4 points, the band's short form "~2%" when both ends round alike.
  expect(noteText(0.12, true, { low: 16.5, high: 17.5 })).toBe('whatsnext could have saved ~2% of your window here.')
  expect(noteText(0.42, true, { low: 0.6, high: 3.4 })).toBe('whatsnext could have saved ~0.3–1% of your window here.')
  expect(noteText(0.12, true, undefined)).toBe('whatsnext could have saved $0.12 API-equivalent here.')
})

test('no saving, no note: 0, a negative, and a figure that is not there', async () => {
  for (const saving of [0, -0.1, undefined, Number.NaN, Number.POSITIVE_INFINITY]) expect(noteText(saving, false, undefined), String(saving)).toBeUndefined()
  expect(noteText(0, true, { low: 1, high: 2 })).toBeUndefined()
})

test('whatsnext is found by plugin name, bare or with a marketplace', async () => {
  expect(isWhatsnext('whatsnext')).toBe(true)
  expect(isWhatsnext('whatsnext@whatsnext')).toBe(true)
  expect(isWhatsnext('whatsnext-lite')).toBe(false)
  expect(isWhatsnext('groundwork')).toBe(false)
  expect(isWhatsnext(undefined)).toBe(false)
})

test('the one button: Get whatsnext when it is not installed; none for a link when it is, and none when nobody knows', async () => {
  expect(noteLink(false)).toEqual({ label: 'Get whatsnext', href: 'https://github.com/archid21/whatsnext' })
  expect(WHATSNEXT_URL).toBe('https://github.com/archid21/whatsnext')
  expect(noteLink(true)).toBeUndefined()
  expect(noteLink(undefined)).toBeUndefined()
})

test('the ⋯ menu has How it works and Don\'t show again, and nothing else', async () => {
  expect(NOTE_MORE.map(m => m.label)).toEqual(['How it works', "Don't show again"])
  expect(HOW_IT_WORKS).toBe('whatsnext compacts large, closed threads with Haiku before you come back, so reopening one re-reads a short summary, not the whole conversation. At most 5 a day; it skips threads that are open.')
})

test('Turn on is a button, only when whatsnext is installed and the closed-thread setting is known to be off', async () => {
  expect(noteButton(true, false)).toEqual(TURN_ON_BUTTON)
  expect(noteButton(true, true), 'on: nothing to turn on').toBeUndefined()
  expect(noteButton(true, undefined), 'unknown').toBeUndefined()
  expect(noteButton(false, false)).toBeUndefined()
  expect(noteButton(undefined, false)).toBeUndefined()
})

test('the consent text states the cap and the cost, and 5 a day matches How it works', async () => {
  expect(CONSENT_TEXT).toBe('whatsnext will compact up to 5 closed threads a day with Haiku. Cost: up to $0.50 a day in API money, or up to 1M tokens a day of your usage windows on a subscription.')
  expect(HOW_IT_WORKS).toContain('At most 5 a day')
  expect([AUTO_KEY, BILLING_KEY]).toEqual(['compact.closed.auto', 'compact.closed.billing'])
  expect(WRAP_HEADROOM).toBe(40_000)
  expect(COMPACT_BASE.startsWith('Keep: the current task and its goal')).toBe(true)
})
