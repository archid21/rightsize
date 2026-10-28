import { expect, test } from 'claude-code/testing'
import { MISS_BLOCK } from './cost'
import { MISS_MIN, PRIOR_N, RESEARCH_PRIORS, checkTotals, confidence, missCounts, missMap, missRate, missRates, missTotals, outcomes, ownTasks, pauseRates } from './misses'
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

test('check totals: a check agreed when Sonnet struggles with none of the models Haiku named a level for', async () => {
  const check = (first: RunLine['fit'], second: NonNullable<RunLine['check']>['fit']): RunLine => ({ at, kind: 'check', type: 'debug', fit: first, check: { by: 'sonnet', fit: second } })
  const lines = [
    check({ sonnet: 'low', opus: 'low' }, { sonnet: 'low', opus: 'medium' }),
    check({ sonnet: 'low', opus: 'low' }, { sonnet: null, opus: 'low' }),
    check({ haiku: null }, { haiku: 'low' }),
    check({ haiku: 'low' }, {}),
    run({}),
  ]
  expect(checkTotals(lines), 'one agreed, one disagreed; the other two compared no model').toEqual({ n: 2, agreed: 1 })
  expect(checkTotals([]), 'no checks').toEqual({ n: 0, agreed: 0 })
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
  const hard = Array.from({ length: 6 }, (_, i) => handDown({ type: 'extract', agentCalls: i < 3 ? 2 : 1 }))
  const map = missMap(missRates(hard))
  expect(map['extract:haiku'], 'extract has no research prior: its own rate').toBe(0.5)
  expect(map['extract:haiku'] ?? 0, 'over the block line').toBeGreaterThanOrEqual(MISS_BLOCK)
  expect(map['summarize:haiku'], 'another type with no prior leans on the model across types').toBe(0.5)
  expect(map['lookup:haiku'], 'a type with a prior is blended with it: 0% prior, no outcomes of its own').toBeUndefined()
  expect(map['search:opus'], 'no outcomes on Opus').toBeUndefined()
})

test('research priors: every profile starts from them, and real outcomes take the place of the pseudo-outcomes', async () => {
  const hand = (type: string, n: number, bad = 0): RunLine[] => Array.from({ length: n }, (_, i) => handDown({ type, agentCalls: i < bad ? 2 : 1 }))
  expect(missRate({}, 'review', 'haiku'), 'review on Haiku starts high').toBe(RESEARCH_PRIORS['review:haiku'])
  expect(missRate({}, 'review', 'haiku'), 'at or over the pause line').toBeGreaterThanOrEqual(MISS_BLOCK)
  expect(missRate({}, 'search', 'haiku'), 'search on Haiku starts at 0%').toBe(0)
  expect(Math.abs(missRate(rates(hand('review', 5)), 'review', 'haiku') - 0.4) < 1e-9, 'five good outcomes leave half the prior').toBe(true)
  expect(missRate(rates(hand('review', PRIOR_N)), 'review', 'haiku'), `${PRIOR_N} good outcomes: the prior is gone`).toBe(0)
  expect(Math.abs(missRate(rates(hand('search', 1, 1)), 'search', 'haiku') - 0.1) < 1e-9, 'one miss on a 0% prior is 10%').toBe(true)
  expect(Math.abs(missRate(rates(hand('search', PRIOR_N, 3)), 'search', 'haiku') - 0.3) < 1e-9, 'own rate').toBe(true)
  expect(missRate({}, 'review', 'opus'), 'no prior for the reference models').toBe(0)
  expect(missRate({}, 'extract', 'haiku'), 'no prior for work the research did not cover').toBe(0)
  expect(missMap({})).toEqual({ 'review:haiku': 0.8, 'writing:haiku': 0.5, 'review:sonnet': 0.3 })
  // The report's counts are of real outcomes only.
  expect(missRates([])).toEqual({})
})

test('tasks are counted once each, and a research prior counts as ten', async () => {
  const counts = missCounts([])
  expect(counts['search:haiku'], 'the prior alone').toBe(PRIOR_N)
  expect(counts['extract:haiku'], 'no prior, nothing logged').toBeUndefined()
  // A run and the 👎 on it are one task; two runs of one task are one task.
  const lines: RunLine[] = [
    handDown({ type: 'extract', id: 'r1', task: 't1' }),
    { at, kind: 'feedback', ref: 'r1', value: 'down' } as RunLine,
    handDown({ type: 'extract', id: 'r2', task: 't1' }),
    handDown({ type: 'extract', id: 'r3', task: 't2' }),
  ]
  expect(missCounts(lines)['extract:haiku'], 'two tasks, four outcomes').toBe(2)
  expect(missCounts(Array.from({ length: 12 }, (_, i) => handDown({ id: `r${i}`, task: `t${i}` })))['search:haiku'], 'real tasks past the prior').toBe(12)
})

test('the first automatic miss on a route is forgiven once; a 👎 never is', async () => {
  const rework = (x: Partial<RunLine> = {}) => handDown({ type: 'extract', ...x })
  const hit = () => rework()
  const none = new Set<string>()
  const one = [rework({ agentCalls: 2 }), hit(), hit(), hit(), hit()]
  expect(pauseRates(one, none).rates['extract:haiku'], 'one rework miss in 5: the miss is forgiven').toEqual({ n: 4, misses: 0 })
  expect(pauseRates(one, none).forgiven).toEqual(['extract:haiku'])
  const two = [rework({ agentCalls: 2 }), rework({ agentCalls: 2 }), hit(), hit(), hit(), hit()]
  expect(pauseRates(two, none).rates['extract:haiku'], 'two rework misses: the second counts').toEqual({ n: 5, misses: 1 })
  expect(pauseRates(two, none).forgiven).toEqual(['extract:haiku'])
  expect(pauseRates(one, new Set(['extract:haiku'])).rates['extract:haiku'], 'forgiven before: nothing is forgiven now').toEqual({ n: 5, misses: 1 })
  expect(pauseRates(one, new Set(['extract:haiku'])).forgiven).toEqual([])
  const down = [rework({ id: 'r1' }), { at, kind: 'feedback', ref: 'r1', value: 'down' } as RunLine]
  expect(pauseRates(down, none).rates['extract:haiku'], 'a 👎 on a run with no automatic miss counts').toEqual({ n: 2, misses: 1 })
  expect(pauseRates(down, none).forgiven).toEqual([])
  const both = [rework({ agentCalls: 2, id: 'r2' }), { at, kind: 'feedback', ref: 'r2', value: 'down' } as RunLine]
  expect(pauseRates(both, none).rates['extract:haiku'], 'the automatic miss is forgiven, the 👎 on the same run is not').toEqual({ n: 1, misses: 1 })
  expect(missRates(two)['extract:haiku'], 'missRates still counts every miss').toEqual({ n: 6, misses: 2 })
})

test('confidence: under PRIOR_N own tasks it is low, from research and the tasks there are', async () => {
  expect(confidence('lookup', 'haiku', {}, {}), 'a fresh log: research alone').toEqual({ level: 'low', detail: 'from research' })
  expect(confidence('lookup', 'haiku', { 'lookup:haiku': 0 }, {})).toEqual({ level: 'low', detail: 'from research' })
  expect(confidence('lookup', 'haiku', { 'lookup:haiku': 3 }, { 'lookup:haiku': 0.04 })).toEqual({ level: 'low', detail: 'from research and 3 of your tasks' })
  expect(confidence('lookup', 'haiku', { 'lookup:haiku': PRIOR_N - 1 }, {}), 'one short of PRIOR_N').toEqual({ level: 'low', detail: `from research and ${PRIOR_N - 1} of your tasks` })
  expect(confidence('lookup', 'haiku', { 'search:haiku': 50 }, {}), 'another route\'s tasks do not count').toEqual({ level: 'low', detail: 'from research' })
  expect(confidence('lookup', 'opus', {}, {}), 'no research prior: says so').toEqual({ level: 'low', detail: 'none of your tasks yet' })
  expect(confidence('lookup', 'opus', { 'lookup:opus': 4 }, {})).toEqual({ level: 'low', detail: 'only 4 of your tasks' })
})

test('confidence: with PRIOR_N or more own tasks, high under 10% missed and medium at 10% or more', async () => {
  expect(confidence('lookup', 'haiku', { 'lookup:haiku': PRIOR_N }, {}), 'no misses: not in the map').toEqual({ level: 'high', detail: `${PRIOR_N} of your tasks, 0% missed` })
  expect(confidence('lookup', 'haiku', { 'lookup:haiku': 25 }, { 'lookup:haiku': 0.08 })).toEqual({ level: 'high', detail: '25 of your tasks, 8% missed' })
  expect(confidence('lookup', 'haiku', { 'lookup:haiku': 20 }, { 'lookup:haiku': 0.1 }), 'the line itself is medium').toEqual({ level: 'medium', detail: '20 of your tasks, 10% missed' })
  expect(confidence('lookup', 'haiku', { 'lookup:haiku': 20 }, { 'lookup:haiku': 0.25 })).toEqual({ level: 'medium', detail: '20 of your tasks, 25% missed' })
  expect(confidence('review', 'sonnet', { 'review:sonnet': 12 }, { 'review:sonnet': 0.3, 'lookup:sonnet': 0 }), 'reads its own key').toEqual({ level: 'medium', detail: '12 of your tasks, 30% missed' })
})

test('ownTasks counts the log\'s own tasks, not the research priors that missCounts adds', async () => {
  const lines = [handDown({ task: 'a' }), handDown({ task: 'a' }), handDown({ task: 'b' })]
  expect(ownTasks(lines), 'a task counts once').toEqual({ 'search:haiku': 2 })
  expect(ownTasks([])).toEqual({})
  expect(missCounts([])['lookup:haiku'], 'missCounts still stands for the prior').toBe(PRIOR_N)
})
