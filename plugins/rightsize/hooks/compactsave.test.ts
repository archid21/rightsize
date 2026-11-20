import { expect, test } from 'claude-code/testing'
import { COMPACT_SUMMARY_TOKENS, DEFAULT_PRICES as P, atPrompt, coldCost, dollars, type Usage } from './cost'
import { FRESH_MAX, compactCost, compactSaving, finishCompact, learnedSummary, startCompact, stepCompact } from './compactsave'

// ---- P-85: measured compact savings ----------------------------------------------------------------------------

const warm = (ctx: number): Usage => ({ input_tokens: 10, output_tokens: 500, cache_read_input_tokens: ctx - 10, cache_creation_input_tokens: 0 })
const cold = (ctx: number): Usage => ({ input_tokens: 10, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: ctx - 10 })
const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-9)

test('one estimate formula: cold return avoided, less the compaction (warm: read; cold: input) and the summary coming back cold', () => {
  const ctx = 150_000
  const c = compactCost(P, 'opus', ctx, { by: 'opus', warm: true })
  near(c, dollars(atPrompt(P.opus, ctx), { cacheRead: ctx, output: COMPACT_SUMMARY_TOKENS }))
  near(compactCost(P, 'opus', ctx, { by: 'sonnet', warm: false }), dollars(atPrompt(P.sonnet, ctx), { input: ctx, output: COMPACT_SUMMARY_TOKENS }))
  near(compactSaving(P, 'opus', ctx, { by: 'opus', warm: true }), coldCost(P, 'opus', ctx) - c - coldCost(P, 'opus', COMPACT_SUMMARY_TOKENS))
  expect(compactSaving(P, 'opus', 1000, { by: 'opus', warm: true }), 'never below 0').toBe(0)
})

test('tokens cut are the context before less the first request after; each later request adds cut x its own price', () => {
  let t = startCompact({ id: 'c1', at: 0, source: 'button', tier: 'opus', before: 200_000, cost: 0.1, limit: 835_000 })
  t = stepCompact(t, warm(60_000), P)
  expect(t.after).toBe(60_000)
  expect(t.cut).toBe(140_000)
  near(t.gain, dollars(P.opus, { cacheRead: 140_000 }))
  t = stepCompact(t, cold(61_000), P)
  near(t.gain, dollars(P.opus, { cacheRead: 140_000 }) + dollars(P.opus, { cacheWrite: 140_000 }))
  expect(t.requests).toBe(2)
  near(finishCompact(t, 'session end').saved, t.gain - 0.1)
})

test('counting stops when the uncompacted chat would have reached auto-compact, or at the next compact or session end', () => {
  let t = startCompact({ id: 'c1', at: 0, source: 'auto', tier: 'sonnet', before: 800_000, cost: 0.2, limit: 835_000 })
  t = stepCompact(t, warm(100_000), P)
  t = stepCompact(t, warm(140_000), P) // 800K + 40K growth: past the limit
  expect(t.requests).toBe(1)
  expect(t.stop).toBe('auto-compact point')
  const again = stepCompact(t, warm(150_000), P)
  expect(again.requests, 'a stopped compact counts nothing more').toBe(1)
  const n = startCompact({ id: 'c2', at: 0, source: 'button', tier: 'opus', before: 200_000, cost: 0.1, limit: 835_000 })
  expect(finishCompact(stepCompact(n, warm(50_000), P), 'next compact').stop).toBe('next compact')
})

test('no later request: a loss of its own cost; ending within FRESH_MAX requests marks it startedFresh', () => {
  const t = startCompact({ id: 'c1', at: 0, source: 'button', tier: 'opus', before: 200_000, cost: 0.15, limit: 835_000 })
  const done = finishCompact(t, 'session end')
  expect(done.saved).toBe(-0.15)
  expect(done.startedFresh).toBe(true)
  let u = t
  for (let i = 0; i < FRESH_MAX + 1; i++) u = stepCompact(u, warm(50_000), P)
  expect(finishCompact(u, 'session end').startedFresh, 'more than FRESH_MAX requests').toBe(false)
  expect(finishCompact(stepCompact(t, warm(50_000), P), 'next compact').startedFresh, 'only a session end starts fresh').toBe(false)
  expect(FRESH_MAX).toBe(3)
})

test('a compact that grew the context cuts nothing: a pure loss', () => {
  const t = stepCompact(startCompact({ id: 'c1', at: 0, source: 'button', tier: 'sonnet', before: 53_000, cost: 0.03, limit: 835_000 }), warm(55_000), P)
  expect(t.cut).toBe(0)
  expect(finishCompact(t, 'session end').saved).toBe(-0.03)
})

test('cost unknown: the line says so and saves nothing', () => {
  const t = startCompact({ id: 'c1', at: 0, source: 'button', tier: 'opus', before: 200_000, limit: 835_000 })
  expect(t.cost).toBeUndefined()
  expect(finishCompact(stepCompact(t, warm(50_000), P), 'session end').saved).toBe(0)
})

test('the summary size is learned: the median of the last 10 logged, the default until 3 are logged', () => {
  expect(learnedSummary([])).toBe(COMPACT_SUMMARY_TOKENS)
  expect(learnedSummary([9000, 11_000])).toBe(COMPACT_SUMMARY_TOKENS)
  expect(learnedSummary([9000, 11_000, 10_000])).toBe(10_000)
  expect(learnedSummary([...Array(20).fill(1), 5, 5, 5, 5, 5, 7, 7, 7, 7, 7]), 'the last 10 only').toBe(6)
})
