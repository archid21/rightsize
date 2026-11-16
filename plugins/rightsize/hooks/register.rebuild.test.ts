import { expect, test } from 'claude-code/testing'
import { RUNS_FILE, drive, engine } from './testkit'

// Cache rebuilds (P-35, ADR 0083): a main request that writes again what the cache held gets one 'rebuild' line with its
// likely cause and cost. Runs on a virtual clock with keep warm off, so no ping refreshes the cache.

const MIN = 60_000
const HOUR = 60 * MIN
const OFF = { options: { beforeCold: 'off' }, stored: { beforeCold: 'off' } }
/** A request that read the whole conversation from the cache: 100,500 tokens in all. */
const WARM = { input_tokens: 500, output_tokens: 400, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 0 }
/** The same conversation written again: nothing read. */
const COLD = { input_tokens: 500, output_tokens: 400, cache_read_input_tokens: 0, cache_creation_input_tokens: 100_000 }

const rebuilds = (h: ReturnType<typeof engine>) =>
  (h.files[RUNS_FILE] ?? '')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as Record<string, unknown>)
    .filter(l => l.kind === 'rebuild')

test('back after the cache expired: one rebuild line, cause gap, with tokens and cost', { timeoutMs: 30000, options: OFF.options }, async ($, on) => {
  const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', stored: OFF.stored })
  h.now = Date.parse('2027-01-15T18:00:00Z')
  h.virtual = true
  const d = drive($, h)
  await d.start('terminal')
  h.stepUsage = WARM
  await d.step('t1')
  await d.complete('t1')
  await h.advance(2 * HOUR)
  h.stepUsage = COLD
  await d.step('t2')
  await d.complete('t2')
  const [r, more] = rebuilds(h)
  expect(more, 'one line').toBeUndefined()
  expect(r).toMatchObject({ kind: 'rebuild', cause: 'gap', tokens: 100_500, tier: 'opus', context: 100_500, ttl: HOUR })
  expect(r?.gapMs as number).toBeGreaterThan(HOUR)
  expect(r?.rebuildCost as number, 'writing again costs more than reading').toBeGreaterThan(0)
  expect(r?.ours, 'not rightsize: a gap').toBeUndefined()
})

test('a request that read the cache, and the first request, log nothing', { timeoutMs: 30000, options: OFF.options }, async ($, on) => {
  const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', stored: OFF.stored })
  h.now = Date.parse('2027-01-15T18:00:00Z')
  h.virtual = true
  const d = drive($, h)
  await d.start('terminal')
  h.stepUsage = COLD
  await d.step('t1')
  await d.complete('t1')
  await h.advance(5 * MIN)
  h.stepUsage = WARM
  await d.step('t2')
  await d.complete('t2')
  expect(rebuilds(h)).toEqual([])
})

test('a rebuild within the cache life, same model and effort: cause other', { timeoutMs: 30000, options: OFF.options }, async ($, on) => {
  const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', stored: OFF.stored })
  h.now = Date.parse('2027-01-15T18:00:00Z')
  h.virtual = true
  const d = drive($, h)
  await d.start('terminal')
  h.stepUsage = WARM
  await d.step('t1')
  await d.complete('t1')
  await h.advance(5 * MIN)
  h.stepUsage = COLD
  await d.step('t2')
  await d.complete('t2')
  expect(rebuilds(h).map(r => r.cause)).toEqual(['other'])
})

