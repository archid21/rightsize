import { expect, test } from 'claude-code/testing'
import { COMPACT_TEXT, NO_FRESH_HANDOFF, WRAP_HEADROOM, WRAP_TURNS, isWhatsnext } from './whatsnext'

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
