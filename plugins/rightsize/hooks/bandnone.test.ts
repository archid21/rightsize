import { expect, test } from 'claude-code/testing'
import { NONE_FITS } from './cost'
import { bandFor } from './register'

// A "No change" row: hidden when the level in use fits, shown with the real reason when rightsize's own checks kept a change.
const run = { id: 'r1', tier: 'opus', normal: 'medium', auto: false, delegate: undefined, stay: false, takenDelegate: 0, rating: { reason: 'simple arithmetic', type: 'lookup' } } as never
const none = (why: string) => bandFor(run, {} as never, { kind: 'none', why } as never)

test('the level in use fits: the plain row, not shown under "when it acts"', async () => {
  const b = none(NONE_FITS)
  expect(b.text).toBe('Medium on Opus fits.')
  expect(b.acted).toBe(false)
  expect(b.skipped).toBeUndefined()
})

test('a change kept by rightsize: the reason and the rater\'s why, shown under "when it acts"', async () => {
  const b = none('lowering to low saves less than the cache it costs')
  expect(b.text).toStartWith('No change: kept medium on Opus. Lowering to low saves less than the cache it costs. Why: Simple arithmetic.')
  expect(b.skipped).toBe(true)
  expect(b.acted).toBe(false)
})
