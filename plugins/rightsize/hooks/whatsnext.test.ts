import { expect, test } from 'claude-code/testing'
import { COMPACT_BASE, NO_FRESH_HANDOFF, WRAP_HEADROOM, WRAP_TURNS, isWhatsnext } from './whatsnext'

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
  expect(COMPACT_BASE.startsWith('Keep: the current task and its goal')).toBe(true)
})
