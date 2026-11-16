import { expect, test } from 'claude-code/testing'
import { rebuildCause, rebuildSums, rebuildTokens } from './rebuild'

const HOUR = 3_600_000
const base = { compacted: false, fromModel: 'claude-opus-5-5', toModel: 'claude-opus-5-5', fromEffort: 'high', toEffort: 'high', gapMs: 60_000, ttlMs: HOUR }

test('a rebuild: at least 2,000 tokens and more than 5% of what the cache held', () => {
  expect(rebuildTokens(100_000, 0)).toBe(100_000)
  expect(rebuildTokens(100_000, 94_000)).toBe(6000)
  // 5% exactly is not more than 5%; under 2,000 tokens is never one.
  expect(rebuildTokens(100_000, 95_000)).toBe(0)
  expect(rebuildTokens(30_000, 28_500)).toBe(0)
  expect(rebuildTokens(1500, 0)).toBe(0)
})

test('the first request, or a read over what was held, is no rebuild', () => {
  expect(rebuildTokens(0, 0)).toBe(0)
  expect(rebuildTokens(50_000, 60_000)).toBe(0)
  expect(rebuildTokens(Number.NaN, 0)).toBe(0)
})

test('the cause, first match: compact, model, gap, effort, other', () => {
  expect(rebuildCause({ ...base, compacted: true, toModel: 'claude-sonnet-5-5', gapMs: 2 * HOUR })).toBe('compact')
  expect(rebuildCause({ ...base, toModel: 'claude-sonnet-5-5', gapMs: 2 * HOUR })).toBe('model')
  expect(rebuildCause({ ...base, gapMs: 2 * HOUR, toEffort: 'low' })).toBe('gap')
  expect(rebuildCause({ ...base, toEffort: 'low' })).toBe('effort')
  expect(rebuildCause(base)).toBe('other')
})

test('a gap counts only past the cache life', () => {
  expect(rebuildCause({ ...base, gapMs: HOUR })).toBe('other')
  expect(rebuildCause({ ...base, gapMs: 6 * 60_000, ttlMs: 5 * 60_000 })).toBe('gap')
})

test('an unknown model or effort is no switch', () => {
  expect(rebuildCause({ ...base, fromModel: undefined, toEffort: undefined })).toBe('other')
})

test('sums by cause: most costly first, the expected compact row last', () => {
  const rows = rebuildSums([
    { kind: 'rebuild', cause: 'compact', tokens: 9000, rebuildCost: 5 },
    { kind: 'rebuild', cause: 'model', tokens: 50_000, rebuildCost: 0.4, ours: true },
    { kind: 'rebuild', cause: 'gap', tokens: 700_000, rebuildCost: 3 },
    { kind: 'rebuild', cause: 'gap', tokens: 100_000, rebuildCost: 1 },
    { kind: 'rebuild', cause: 'nonsense', tokens: 3000, rebuildCost: 0.01 },
    { kind: 'run', tokens: 1, rebuildCost: 99 },
  ])
  expect(rows.map(r => r.cause)).toEqual(['gap', 'model', 'other', 'compact'])
  expect(rows[0]).toEqual({ cause: 'gap', count: 2, tokens: 800_000, cost: 4, ours: 0 })
  expect(rows[1]?.ours).toBe(1)
  expect(rebuildSums([])).toEqual([])
})
