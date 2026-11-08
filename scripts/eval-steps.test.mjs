// Tests for the pure math in eval-steps.mjs, on hand-made rows. Run: node --test scripts/eval-steps.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bestG, collectHandoffs, countMeasures, errorStats, evaluate, extractHandoff, lnRatio, median, parseLines, quantile, shares, shrink } from './eval-steps.mjs'

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`)
const run = (extra = {}) => ({ kind: 'run', id: 'r1', session: 's1', route: 'delegate:sonnet', steps: 10, aborted: false, helpers: [{ kind: 'handoff', steps: 5 }], ...extra })

test('quantile is the upper nearest-rank, sorted[floor(p * n)]', () => {
  assert.equal(quantile([], 0.5), undefined)
  assert.equal(quantile([7], 0.9), 7)
  assert.equal(quantile([4, 1, 3, 2], 0.5), 3)
  assert.equal(quantile([1, 2, 3, 4, 5], 0.5), 3)
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1)
  assert.equal(quantile(hundred, 0.25), 26)
  assert.equal(quantile(hundred, 0.9), 91)
  assert.equal(quantile(hundred, 1), 100)
  assert.equal(median([9, 1, 5]), 5)
})

test('quantile does not reorder its input', () => {
  const xs = [3, 1, 2]
  quantile(xs, 0.5)
  assert.deepEqual(xs, [3, 1, 2])
})

test('lnRatio floors both numbers at 1', () => {
  close(lnRatio(10, 5), Math.log(2))
  close(lnRatio(5, 10), -Math.log(2))
  close(lnRatio(0, 0), 0)
  close(lnRatio(0, 4), -Math.log(4))
  close(lnRatio(8, 0.5), Math.log(8))
})

test('shrink is rated ** (1 + g * 0.8)', () => {
  close(shrink(10, 0), 10)
  close(shrink(100, -0.25), 100 ** 0.8)
  close(shrink(1, -0.4), 1)
})

test('errorStats: median and p90 of |ln|, and the signed bias', () => {
  const rows = [{ rated: 10, actual: 10 }, { rated: 10, actual: 20 }, { rated: 10, actual: 5 }]
  const s = errorStats(rows, 0)
  close(s.bias, 0)
  close(s.medianAbs, Math.log(2))
  close(s.p90Abs, Math.log(2))
  const low = errorStats([{ rated: 2, actual: 8 }, { rated: 4, actual: 8 }, { rated: 2, actual: 2 }], 0)
  close(low.bias, Math.log(2))
  assert.ok(low.bias > 0)
})

test('errorStats with g shrinks the guess, and bestG picks the lowest median error', () => {
  const rows = [{ rated: 100, actual: 100 ** 0.68 }, { rated: 100, actual: 100 ** 0.68 }]
  const stats = [0, -0.1, -0.2, -0.3, -0.4].map(g => errorStats(rows, g))
  close(stats[4].medianAbs, 0)
  assert.ok(stats[0].medianAbs > stats[2].medianAbs)
  assert.equal(bestG(stats), -0.4)
  assert.equal(bestG([]), undefined)
  assert.equal(bestG([{ g: 0, medianAbs: 1 }, { g: -0.1, medianAbs: 1 }]), 0)
})

test('shares counts actuals above p90 and below p25 (strictly)', () => {
  const rows = [{ actual: 1 }, { actual: 3 }, { actual: 5 }, { actual: 17 }, { actual: 18 }]
  assert.deepEqual(shares(rows, { p25: 3, p90: 17 }), { aboveP90: 1 / 5, belowP25: 1 / 5 })
  assert.equal(shares(rows, undefined), undefined)
  assert.equal(shares([], { p25: 3, p90: 17 }), undefined)
})

test('extractHandoff reads route tier, rated steps and the summed handoff steps', () => {
  assert.deepEqual(extractHandoff(run({ helpers: [{ kind: 'handoff', steps: 2 }, { kind: 'handoff', steps: 3 }, { kind: 'moved', steps: 50 }] })), { tier: 'sonnet', rated: 10, actual: 5, measure: 'steps', key: 's1|r1' })
  assert.equal(extractHandoff(run({ route: 'delegate:Haiku' })).tier, 'haiku')
  assert.equal(extractHandoff(run({ id: undefined })).key, undefined)
})

test('extractHandoff skips what is not a usable hand-off', () => {
  assert.equal(extractHandoff(undefined), undefined)
  assert.equal(extractHandoff('x'), undefined)
  assert.equal(extractHandoff(run({ kind: 'subagent' })), undefined)
  assert.equal(extractHandoff(run({ aborted: true })), undefined)
  assert.equal(extractHandoff(run({ route: 'main' })), undefined)
  assert.equal(extractHandoff(run({ route: 'delegate:gemini' })), undefined)
  assert.equal(extractHandoff(run({ helpers: [] })), undefined)
  assert.equal(extractHandoff(run({ helpers: undefined })), undefined)
  assert.equal(extractHandoff(run({ helpers: [{ kind: 'moved', steps: 4 }] })), undefined)
  assert.equal(extractHandoff(run({ steps: undefined })), undefined)
  assert.equal(extractHandoff(run({ steps: 0 })), undefined)
})

test('a handoff helper with no usable step count counts as 0 actual steps', () => {
  assert.equal(extractHandoff(run({ helpers: [{ kind: 'handoff' }] })).actual, 0)
})

test('actual is the helpers\' tool calls when every one has them, and falls back to requests otherwise', () => {
  const withCalls = extractHandoff(run({ helpers: [{ kind: 'handoff', steps: 9, calls: 4 }, { kind: 'handoff', steps: 3, calls: 0 }] }))
  assert.deepEqual(withCalls, { tier: 'sonnet', rated: 10, actual: 4, measure: 'calls', key: 's1|r1' })
  const withoutCalls = extractHandoff(run({ helpers: [{ kind: 'handoff', steps: 9 }] }))
  assert.deepEqual(withoutCalls, { tier: 'sonnet', rated: 10, actual: 9, measure: 'steps', key: 's1|r1' })
  // One helper without calls (an older line) sends the whole hand-off to requests, so calls and requests never mix.
  const mixed = extractHandoff(run({ helpers: [{ kind: 'handoff', steps: 9, calls: 4 }, { kind: 'handoff', steps: 2 }] }))
  assert.deepEqual([mixed.actual, mixed.measure], [11, 'steps'])
  assert.equal(extractHandoff(run({ helpers: [{ kind: 'handoff', steps: 9, calls: -1 }] })).measure, 'steps')
  assert.equal(extractHandoff(run({ helpers: [{ kind: 'handoff', steps: 9, calls: 2.5 }] })).actual, 9)
})

test('countMeasures counts hand-offs that used tool calls and those that fell back to requests', () => {
  const rows = [{ measure: 'calls' }, { measure: 'steps' }, { measure: 'steps' }]
  assert.deepEqual(countMeasures(rows), { calls: 1, requests: 2 })
  assert.deepEqual(countMeasures([]), { calls: 0, requests: 0 })
})

test('parseLines counts broken lines; collectHandoffs drops repeated run ids and counts moved lines', () => {
  const text = [JSON.stringify(run()), 'not json', '', JSON.stringify(run()), JSON.stringify(run({ id: 'r2' })), JSON.stringify({ kind: 'subagent', tier: 'sonnet' })].join('\n')
  const { lines, bad } = parseLines(text)
  assert.equal(bad, 1)
  assert.equal(lines.length, 4)
  const { rows, moved } = collectHandoffs(lines)
  assert.equal(rows.length, 2)
  assert.equal(moved, 1)
})

test('evaluate groups by tier, holds each against its own reference, and leaves haiku with none', () => {
  const rows = [
    { tier: 'sonnet', rated: 10, actual: 20 },
    { tier: 'sonnet', rated: 10, actual: 2 },
    { tier: 'haiku', rated: 4, actual: 4 },
  ]
  const table = { models: { sonnet: { n: 100, p25: 3, p50: 4, p75: 6, p90: 17 } } }
  const r = evaluate(rows, table)
  assert.deepEqual(Object.keys(r.tiers), ['haiku', 'sonnet'])
  assert.equal(r.tiers.haiku.reference, null)
  assert.equal(r.tiers.haiku.vsReference, null)
  assert.equal(r.tiers.sonnet.n, 2)
  assert.deepEqual(r.tiers.sonnet.vsReference, { aboveP90: 0.5, belowP25: 0.5 })
  assert.equal(r.tiers.sonnet.medianRatedMinusReference, 6)
  assert.equal(r.overall.n, 3)
  assert.deepEqual(r.overall.vsReference, { aboveP90: 0.5, belowP25: 0.5, covered: 2 })
  assert.equal(r.overall.errors.length, 5)
})
