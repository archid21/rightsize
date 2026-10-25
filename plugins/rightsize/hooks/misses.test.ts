import { expect, test } from 'claude-code/testing'
import { MISS_BLOCK } from './cost'
import { MISS_MIN, missMap, missRate, missRates, missTotals, outcomes } from './misses'
import type { RunLine } from './report'

const at = new Date(Date.parse('2026-10-23T18:00:00.000Z')).toISOString()
const run = (x: Partial<RunLine>): RunLine => ({ at, kind: 'run', type: 'search', route: 'main', tier: 'opus', change: 'none', ...x })
const handDown = (x: Partial<RunLine> = {}) => run({ route: 'delegate:haiku', change: 'delegate-down', agentCalls: 1, ...x })
const lowered = (x: Partial<RunLine> = {}) => run({ change: 'lower', type: 'lookup', ...x })
const rates = (lines: RunLine[]) => missRates(lines)

test('a hand-down is a miss for the delegate model when it needed rework, else a hit', async () => {
  expect(rates([handDown(), handDown(), handDown({ agentCalls: 2 })])).toEqual({ 'search:haiku': { n: 3, misses: 1 } })
  expect(rates([handDown({ agentCalls: 3, aborted: true })]), 'a stopped turn says nothing').toEqual({})
  expect(rates([run({ route: 'main', change: 'delegate-down' })]), 'Claude did the work itself: not counted').toEqual({})
  expect(rates([handDown({ change: 'delegate-up', route: 'delegate:fable' })]), 'a hand-up is not a hand-down').toEqual({})
})

test('a lowered run is a miss for its own model when it stepped back up or was raised mid-turn', async () => {
  const raised = [{ step: 3, from: 'low', to: 'medium', why: 'x' }]
  expect(rates([lowered(), lowered({ steppedUp: true }), lowered({ escalations: raised }), lowered({ aborted: true, steppedUp: true })])).toEqual({ 'lookup:opus': { n: 3, misses: 2 } })
})

test('a main-chat run with no change counts only when it was raised mid-turn', async () => {
  const raised = [{ step: 3, from: 'medium', to: 'high', why: 'x' }]
  expect(rates([run({}), run({}), run({ escalations: raised })])).toEqual({ 'search:opus': { n: 1, misses: 1 } })
  expect(rates([run({ change: 'raise', escalations: raised })]), 'a raised run is not a judgement of the rater').toEqual({})
  expect(rates([run({ type: 'nonsense', escalations: raised }), run({ tier: 'gpt', escalations: raised })]), 'unknown type or model').toEqual({})
})

test('feedback joins its run by ref: 👎 is a miss and 👍 a hit, for the model the work ran on', async () => {
  const lines: RunLine[] = [
    handDown({ id: 'a', tier: 'opus' }),
    lowered({ id: 'b', tier: 'sonnet' }),
    run({ id: 'c', tier: 'fable' }),
    { at, kind: 'feedback', ref: 'a', value: 'down' },
    { at, kind: 'feedback', ref: 'b', value: 'up' },
    { at, kind: 'feedback', ref: 'c', value: 'down' },
    { at, kind: 'feedback', ref: 'nobody', value: 'down' },
  ]
  // The hand-off's own hit (one subagent call) plus the 👎: Haiku, not Opus. The lowered run's hit and its 👍. The main run's 👎 on Fable.
  expect(rates(lines)).toEqual({ 'search:haiku': { n: 2, misses: 1 }, 'lookup:sonnet': { n: 2, misses: 0 }, 'search:fable': { n: 1, misses: 1 } })
  const changed = [...lines, { at, kind: 'feedback', ref: 'a', value: 'up' } as RunLine]
  expect(rates(changed)['search:haiku'], 'the last verdict on a run stands').toEqual({ n: 2, misses: 0 })
  expect(outcomes([{ at, kind: 'feedback', ref: 'a', value: 'up' }, handDown({ id: 'a' })]).length, 'a verdict before its run in the log still joins').toBe(2)
})

test('a check line is a miss for each model Haiku said fits and the checker says would struggle', async () => {
  const check = (first: RunLine['fit'], second: NonNullable<RunLine['check']>['fit']): RunLine => ({ at, kind: 'check', type: 'debug', fit: first, check: { by: 'sonnet', fit: second } })
  const lines = [
    check({ haiku: null, sonnet: 'medium', opus: 'low', fable: 'low' }, { haiku: null, sonnet: null, opus: 'high', fable: 'high' }),
    check({ haiku: 'low', sonnet: 'low', opus: 'low', fable: 'low' }, { haiku: 'low', sonnet: 'medium', opus: 'medium', fable: 'medium' }),
  ]
  expect(rates(lines)).toEqual({
    'debug:sonnet': { n: 2, misses: 1 },
    'debug:opus': { n: 2, misses: 0 },
    'debug:fable': { n: 2, misses: 0 },
    'debug:haiku': { n: 1, misses: 0 },
  })
  expect(rates([check({ haiku: 'low' }, {})]), 'the checker said nothing of a model: skipped').toEqual({})
  expect(rates([{ at, kind: 'check', type: 'debug' }]), 'a check line with no fits').toEqual({})
})

test('a check line or feedback line is never a rated run', async () => {
  const lines: RunLine[] = [{ at, kind: 'check', type: 'debug', fit: { sonnet: 'low' }, check: { by: 'sonnet', fit: { sonnet: null } } }, { at, kind: 'feedback', ref: 'a', value: 'down' }]
  expect(outcomes(lines).length).toBe(1)
})

test(`the rate for a type and model needs ${MISS_MIN} outcomes, else the model's across types, else 0`, async () => {
  const lines = (n: number, misses: number, type: string, tier = 'opus') => Array.from({ length: n }, (_, i) => run({ type, tier, change: 'lower', steppedUp: i < misses }))
  const own = missRates([...lines(5, 2, 'lookup'), ...lines(20, 0, 'debug', 'sonnet')])
  expect(missRate(own, 'lookup', 'opus'), 'its own, at 5').toBe(0.4)
  const few = missRates([...lines(4, 4, 'lookup'), ...lines(3, 0, 'debug')])
  expect(few['lookup:opus'], '4 outcomes of its own').toEqual({ n: 4, misses: 4 })
  expect(missRate(few, 'lookup', 'opus') === 4 / 7, 'own is too few, but Opus across types has 7: 4 of 7').toBe(true)
  expect(missRate(few, 'review', 'opus') === 4 / 7, 'a type with none falls back to the model too').toBe(true)
  expect(missRate(few, 'lookup', 'sonnet'), 'no outcomes on Sonnet').toBe(0)
  const thin = missRates(lines(4, 4, 'lookup'))
  expect(missRate(thin, 'lookup', 'opus'), 'under 5 anywhere').toBe(0)
  expect(missTotals(few)).toEqual({ n: 7, misses: 4 })
})

test('the map for plan() holds each type and model with a rate above zero, keyed type:tier', async () => {
  const hard = Array.from({ length: 6 }, (_, i) => handDown({ agentCalls: i < 3 ? 2 : 1 }))
  const map = missMap(missRates(hard))
  expect(map['search:haiku']).toBe(0.5)
  expect(map['search:haiku'] ?? 0, 'over the block line').toBeGreaterThanOrEqual(MISS_BLOCK)
  expect(map['lookup:haiku'], 'another type leans on the model across types').toBe(0.5)
  expect(map['search:opus'], 'no outcomes on Opus').toBeUndefined()
})
