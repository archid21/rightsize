import { expect, test } from 'claude-code/testing'
import { compare, isTracked, parseChanges, period, resultRows, results, type ChangeLine } from './results'
import type { RunLine } from './report'

const NOW = Date.parse('2026-11-12T18:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const ago = (days: number) => new Date(NOW - days * DAY).toISOString()
const run = (days: number, x: Partial<RunLine> = {}): RunLine => ({ at: ago(days), kind: 'run', session: 's', actual: 1, requests: 5, errors: 0, ...x })
/** `n` prompts a day over `days` days starting `from` days ago, at `cost` each. */
const spread = (from: number, days: number, n: number, cost: number, x: Partial<RunLine> = {}) =>
  Array.from({ length: days * n }, (_, i) => run(from - Math.floor(i / n) - (i % n) / (n + 1), { actual: cost, ...x }))
const change = (days: number, x: Partial<ChangeLine> = {}): ChangeLine => ({ at: ago(days), key: 'mode', from: 'watch only', to: 'act', ...x })

test('results: a clear drop against every baseline reads Cheaper', () => {
  const lines = [...spread(19, 14, 4, 1), ...spread(5, 5, 8, 0.5)]
  const r = compare(lines, change(5), [change(5)], NOW)
  expect(r.verdict).toBe('cheaper')
  expect(r.notes).toEqual([])
  expect(r.range!.hi).toBeLessThan(-0.1)
  expect(resultRows([r]).join('\n')).toMatch(/Cheaper: 50% less per prompt/)
})

test('results: a rise against every baseline reads Costs more', () => {
  const lines = [...spread(19, 14, 4, 1), ...spread(5, 5, 8, 2)]
  expect(compare(lines, change(5), [change(5)], NOW).verdict).toBe('costs more')
})

test('results: baselines that disagree read Not clear yet, with the range', () => {
  // The 3 days before the change cost 1, the days before those 3: after at 1.5 is +50% against the 3-day baseline and about -40% against the 14-day one.
  const lines = [...spread(19, 11, 4, 3), ...spread(8, 3, 4, 1), ...spread(5, 5, 8, 1.5)]
  const r = compare(lines, change(5), [change(5)], NOW)
  expect(r.verdict).toBe('not clear')
})

test('results: a move inside the 10% swing is not clear', () => {
  const lines = [...spread(19, 14, 4, 1), ...spread(5, 5, 8, 0.95)]
  expect(compare(lines, change(5), [change(5)], NOW).verdict).toBe('not clear')
})

test('results: too few prompts or days says what is missing', () => {
  const lines = [...spread(19, 18, 4, 1), ...spread(1, 1, 8, 0.5)]
  const r = compare(lines, change(1), [change(1)], NOW)
  expect(r.verdict).toBe('too early')
  expect(r.need).toMatch(/of 30 prompts.*of 3 days/)
})

test('results: nothing before the change says so', () => {
  const r = compare(spread(5, 5, 8, 0.5), change(5), [change(5)], NOW)
  expect(r.verdict).toBe('no before')
})

test('results: a worse trade-off row is marked even when cost fell', () => {
  const lines = [...spread(19, 14, 4, 1, { errors: 0 }), ...spread(5, 5, 8, 0.5, { errors: 2 })]
  const r = compare(lines, change(5), [change(5)], NOW)
  expect(r.verdict).toBe('cheaper')
  expect(r.rows.find(x => x.label === 'tool errors per prompt')!.tradeoff).toBe(true)
  expect(resultRows([r]).join('\n')).toContain('trade-off')
})

test('results: failed tests count as a trade-off only past 5 points', () => {
  const before = spread(19, 14, 4, 1, { tests: 'passed' })
  const after = spread(5, 5, 8, 0.5, { tests: 'passed' }).map((l, i) => (i % 5 === 0 ? { ...l, tests: 'failed' as const } : l))
  const r = compare([...before, ...after], change(5), [change(5)], NOW)
  expect(r.rows.find(x => x.label === 'tests failed')!.tradeoff).toBe(true)
})

test('results: the after period stops at the next change, and an earlier change in the before days is noted', () => {
  const first = change(8, { key: 'routing', from: 'off', to: 'on' })
  const second = change(4, { key: 'cache', from: 'off', to: 'on' })
  const lines = [...spread(22, 14, 4, 1), ...spread(8, 4, 8, 0.5), ...spread(4, 4, 8, 0.5)]
  const earlier = change(12, { key: 'pacing', from: 'on', to: 'off' })
  const r = compare(lines, first, [earlier, first, second], NOW)
  expect(r.after.prompts).toBe(32)
  expect(r.notes.join(' ')).toContain('another change')
})

test('results: aborted runs, other kinds and lines outside the window are left out', () => {
  const lines = [run(1), run(1, { aborted: true }), run(1, { kind: 'subagent' }), run(9)]
  expect(period(lines, NOW - 2 * DAY, NOW).prompts).toBe(1)
})

test('results: only behavior settings, real changes and the newest three are listed', () => {
  expect(isTracked('mode')).toBe(true)
  expect(isTracked('band')).toBe(false)
  const cs = [change(9), change(8, { key: 'band', from: 'always', to: 'off' }), change(7, { key: 'cache', from: 'on', to: 'on' }), change(6, { key: 'routing' }), change(5, { key: 'handOffs' }), change(4, { key: 'pacing' }), change(3, { key: 'rater' })]
  const rs = results(spread(19, 19, 4, 1), cs, NOW)
  expect(rs.map(r => r.change.key)).toEqual(['rater', 'pacing', 'handOffs'])
})

test('results: no changes means no rows; a torn changes file is skipped', () => {
  expect(resultRows([])).toEqual([])
  const text = `${JSON.stringify(change(2))}\n{"at":"2026\n{"x":1}\n`
  expect(parseChanges(text)).toHaveLength(1)
})
