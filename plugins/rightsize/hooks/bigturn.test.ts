import { expect, test } from 'claude-code/testing'
import { CAL_FULL, DEFAULT_PRICES, DEFAULT_RULES, LEVELS, type Rating, type Situation, canLowerNow, effortPlan, plan } from './cost'
import { OVER_BUDGET_REASON, STOPPED_TEXT, STOP_REPORT_TEXT, isOverBudgetRow, BIG_TURN_FLOOR, BIG_TURN_MIN_TURNS, BIG_TURN_RECOMPUTE_MS, BIG_TURN_START, DURING_HIGH, DURING_LOW, PLAN_FIRST_TEXT, amountText, autoAmount, autoAmountNow, bigTurnRange, duringRange, duringText, headsUpText, optInText, parseStoredAmount, percentile, rangeText, stillLearning, turnCosts, withPlanFirst } from './bigturn'
import type { RunLine } from './report'

const near = (a: number, b: number) => expect(Math.abs(a - b) < 1e-6, `${a} is not ${b}`).toBe(true)
const DAY = 24 * 60 * 60_000
const NOW = Date.parse('2026-11-14T18:00:00.000Z')
const at = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString()
const run = (x: Partial<RunLine>): RunLine => ({ at: at(1), kind: 'run', type: 'feature', route: 'main', tier: 'opus', actual: 0.5, taken: 0.5, ...x })
/** `n` finished turns costing 1..n cents-ish: cost k * step. */
const turns = (n: number, cost: (i: number) => number, x: Partial<RunLine> = {}) => Array.from({ length: n }, (_, i) => run({ actual: cost(i), ...x }))

test('percentile interpolates between neighbours and is NaN for nothing', () => {
  expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3)
  expect(percentile([10, 20], 0.5)).toBe(15)
  expect(percentile([5], 0.99)).toBe(5)
  expect(percentile([], 0.5)).toBeNaN()
})

test('auto amount: the 99th percentile of the last 30 days of finished turns', () => {
  // 100 turns costing $0.10 ... $10.00: the 99th percentile sits at index 98.01 of 0..99, $9.901, which is $9.90 to the cent.
  const lines = turns(100, i => (i + 1) / 10)
  expect(autoAmount(lines, NOW)).toBe(9.9)
  // One huge turn among 100 moves it: the top 1% is a percentile, not the maximum.
  expect(autoAmount([...turns(99, () => 0.5), run({ actual: 100 })], NOW)).toBe(Math.max(1, Math.round((0.5 + (100 - 0.5) * 0.01) * 100) / 100))
})

test('auto amount: $2 until 50 turns exist, however big they are', () => {
  expect(autoAmount(turns(BIG(), () => 40), NOW)).toBe(BIG_TURN_START)
  expect(BIG_TURN_START).toBe(2)
  expect(autoAmount(turns(BIG_TURN_MIN_TURNS, () => 40), NOW)).toBe(40)
  expect(autoAmount([], NOW)).toBe(2)
})
const BIG = () => BIG_TURN_MIN_TURNS - 1

test('auto amount: never under $1', () => {
  expect(autoAmount(turns(60, () => 0.05), NOW)).toBe(BIG_TURN_FLOOR)
  expect(BIG_TURN_FLOOR).toBe(1)
})

test('auto amount counts only finished turns of the last 30 days', () => {
  const lines = [
    ...turns(50, () => 0.2),
    run({ actual: 99, aborted: true }),
    run({ actual: 99, at: at(31) }),
    run({ actual: 99, kind: 'warm' }),
    run({ actual: 99, kind: 'unrated' }),
    { ...run({ actual: 99 }), kind: undefined },
  ]
  // The line with no kind is a run line; the other four are not counted.
  expect(turnCosts(lines, NOW).length).toBe(51)
  // 50 turns at $0.20 and one at $99: 51 turns, so the percentile is read, and the $99 turn is the top.
  expect(autoAmount(lines, NOW)).toBe(Math.round((0.2 + (99 - 0.2) * 0.5) * 100) / 100)
})

test('auto amount is recomputed at most weekly: a stored value under 7 days old is reused', () => {
  const lines = turns(60, i => (i + 1) / 10)
  const first = autoAmountNow(undefined, lines, NOW)
  expect(first).toMatchObject({ fresh: true, at: NOW })
  expect(first.value).toBe(autoAmount(lines, NOW))
  // A day later, with much bigger turns in the log: the stored value stands.
  const bigger = turns(60, () => 50)
  const reused = autoAmountNow({ value: first.value, at: first.at }, bigger, NOW + DAY)
  expect(reused).toEqual({ value: first.value, at: first.at, fresh: false })
  // Seven days later it is computed again.
  const again = autoAmountNow({ value: first.value, at: first.at }, bigger, NOW + BIG_TURN_RECOMPUTE_MS)
  expect(again).toMatchObject({ fresh: true, value: 50, at: NOW + BIG_TURN_RECOMPUTE_MS })
  // A stored time in the future (a clock that moved back) is not trusted.
  expect(autoAmountNow({ value: 9, at: NOW + DAY }, bigger, NOW).fresh).toBe(true)
})

test('a stored amount that is not a value and a time is ignored', () => {
  expect(parseStoredAmount({ value: 3.4, at: 5 })).toEqual({ value: 3.4, at: 5 })
  for (const bad of [undefined, null, 3, { value: 'x', at: 1 }, { value: 0, at: 1 }, { value: 2 }]) expect(parseStoredAmount(bad)).toBeUndefined()
})

test('range: the 25th and 75th percentile of past actual / estimate for the same type and model', () => {
  // 10 feature turns on Opus with ratios 0.5, 1, 1.5 ... 5: p25 and p75 of those, times the estimate.
  const lines = Array.from({ length: 10 }, (_, i) => run({ actual: (i + 1) * 0.5, taken: 1 }))
  const r = bigTurnRange(lines, 'feature', 'opus', 4, NOW)
  expect(r.basis).toBe('type')
  near(r.lo, 4 * percentile(lines.map(l => (l.actual as number) / (l.taken as number)), 0.25))
  near(r.hi, 4 * percentile(lines.map(l => (l.actual as number) / (l.taken as number)), 0.75))
  expect(r.lo).toBeLessThan(r.hi)
})

test('range: under 10 turns of that type, the same model across types (at least 10)', () => {
  const lines = [
    ...Array.from({ length: 9 }, () => run({ type: 'feature', actual: 2, taken: 1 })),
    ...Array.from({ length: 3 }, () => run({ type: 'debug', actual: 4, taken: 1 })),
    // Other models and old lines do not count.
    ...Array.from({ length: 20 }, () => run({ tier: 'sonnet', actual: 9, taken: 1 })),
    ...Array.from({ length: 20 }, () => run({ at: at(40), actual: 9, taken: 1 })),
  ]
  const r = bigTurnRange(lines, 'feature', 'opus', 3, NOW)
  expect(r.basis).toBe('model')
  near(r.lo, 6)
  near(r.hi, 3 * percentile([...Array(9).fill(2), ...Array(3).fill(4)], 0.75))
})

test('range: a hand-off counts under the model that did the work', () => {
  const lines = Array.from({ length: 10 }, () => run({ route: 'delegate:haiku', tier: 'opus', actual: 3, taken: 1 }))
  expect(bigTurnRange(lines, 'feature', 'haiku', 1, NOW)).toMatchObject({ basis: 'type', lo: 3, hi: 3 })
  expect(bigTurnRange(lines, 'feature', 'opus', 1, NOW).basis).toBe('default')
})

test('range: with fewer than 10 ratios, half to double the estimate', () => {
  const r = bigTurnRange(turns(9, () => 2), 'feature', 'opus', 5, NOW)
  expect(r).toEqual({ lo: 2.5, hi: 10, basis: 'default' })
  expect(bigTurnRange([], 'debug', 'sonnet', 1, NOW)).toEqual({ lo: 0.5, hi: 2, basis: 'default' })
  // Aborted turns and turns with no estimate say nothing.
  const none = bigTurnRange([...turns(10, () => 2, { aborted: true }), ...turns(10, () => 2, { taken: 0 })], 'feature', 'opus', 1, NOW)
  expect(none.basis).toBe('default')
})

test('during a turn the range is 0.8x to 1.25x of the projection', () => {
  expect(DURING_LOW).toBe(0.8)
  expect(DURING_HIGH).toBe(1.25)
  const r = duringRange(4)
  near(r.lo, 3.2)
  near(r.hi, 5)
})

test('still learning: under 20 calibrated runs for that type on that model', () => {
  expect(stillLearning({}, 'feature', 'main', 'opus')).toBe(true)
  expect(stillLearning({ 'feature:main:opus': { n: CAL_FULL - 1, ratio: 1 } }, 'feature', 'main', 'opus')).toBe(true)
  expect(stillLearning({ 'feature:main:opus': { n: CAL_FULL, ratio: 1 } }, 'feature', 'main', 'opus')).toBe(false)
  // Another model's or another type's runs do not count; a hand-off has its own keys.
  expect(stillLearning({ 'feature:main:sonnet': { n: 99, ratio: 1 }, 'debug:main:opus': { n: 99, ratio: 1 } }, 'feature', 'main', 'opus')).toBe(true)
  expect(stillLearning({ 'feature:delegate:haiku': { n: 30, ratio: 1 } }, 'feature', 'delegate', 'haiku')).toBe(false)
})

test('the words: dollars on the API, a window share on a subscription, labelled dollars until the rate is known', () => {
  const api = { subscription: false }
  const sub = { subscription: true, rates: { low: 2, high: 4 } }
  const unknown = { subscription: true }
  expect(headsUpText({ lo: 1.2, hi: 3.4, top: 3.44, learning: false }, api)).toBe('Heads-up: this looks like a long turn, about $1.20–$3.40 (your top 1% start at $3.44).')
  expect(headsUpText({ lo: 1.2, hi: 3.4, top: 3.44, learning: true }, api)).toBe('Heads-up: this looks like a long turn, about $1.20–$3.40 (your top 1% start at $3.44). (still learning your work)')
  expect(rangeText(1, 2, sub)).toBe('~2–8% of your 5-hour window')
  expect(amountText(2, sub)).toBe('~4–8% of your 5-hour window')
  expect(rangeText(1, 2, unknown)).toBe('$1.00–$2.00 API-equivalent')
  expect(amountText(2, unknown)).toBe('$2.00 API-equivalent')
  expect(rangeText(2, 2, api)).toBe('$2.00')
  expect(optInText(3.5, api)).toBe('That turn cost ~$3.50, more than 99% of your turns. Warn you before a prompt that looks this expensive?')
  expect(duringText({ lo: 4, hi: 5, spent: 1.5, desktop: false }, api)).toBe('Turn estimate $4.00–$5.00 ($1.50 spent so far). Finish up ends this turn with a report; Esc stops it now.')
  expect(duringText({ lo: 4, hi: 5, spent: 1.5, desktop: true }, api)).toBe('Turn estimate $4.00–$5.00 ($1.50 spent so far). Finish up ends this turn with a report; click Stop to stop it now.')
  expect(duringText({ lo: 1, hi: 2, spent: 0.5, desktop: false }, sub)).toBe('Turn estimate ~2–8% of your 5-hour window (~1–2% of your 5-hour window spent so far). Finish up ends this turn with a report; Esc stops it now.')
  expect(duringText({ lo: 1, hi: 2, spent: 0.5, desktop: false }, unknown)).toBe('Turn estimate $1.00–$2.00 API-equivalent ($0.50 API-equivalent spent so far). Finish up ends this turn with a report; Esc stops it now.')
  expect(OVER_BUDGET_REASON).toBe('Budget reached: stop here and report what is done and what is left.')
  expect(isOverBudgetRow('Keep going') && isOverBudgetRow('Finish up')).toBe(true)
  expect(isOverBudgetRow('keep going') || isOverBudgetRow(undefined) || isOverBudgetRow('')).toBe(false)
  expect(STOP_REPORT_TEXT).toBe("Report what you've done so far and what's left.")
  expect(STOPPED_TEXT).toBe('Stopped. A report request is in your prompt box: send it if you want one.')
})

test('Plan first appends its request after a blank line', () => {
  expect(PLAN_FIRST_TEXT).toBe('Before doing the work, propose a short plan and wait for my go-ahead.')
  expect(withPlanFirst('refactor the parser')).toBe('refactor the parser\n\nBefore doing the work, propose a short plan and wait for my go-ahead.')
})

// ---- canLowerNow: the one check the effort plan and the big-turn warning's Lower effort share ----

const situation = (x: Partial<Situation> = {}): Situation => ({ tier: 'opus', level: 'high', context: 20_000, prices: DEFAULT_PRICES, cal: {}, rules: DEFAULT_RULES, minTasks: 0, ...x })

test('canLowerNow: the next level down, never under the floor', () => {
  expect(canLowerNow('feature', situation({ level: 'high' }), 'low')).toEqual({ ok: true, to: 'medium' })
  expect(canLowerNow('feature', situation({ level: 'max' }), 'low')).toEqual({ ok: true, to: 'xhigh' })
  expect(canLowerNow('feature', situation({ level: 'medium' }), 'low')).toEqual({ ok: true, to: 'low' })
  expect(canLowerNow('feature', situation({ level: 'low' }), 'low').ok).toBe(false)
  expect(canLowerNow('feature', situation({ level: 'medium' }), 'medium').ok, 'at the Lowest effort row').toBe(false)
  expect(canLowerNow('feature', situation({ level: 'high' }), 'medium', { level: 'medium' }).ok).toBe(false)
  expect(LEVELS[0]).toBe('low')
})

test('canLowerNow: a paused route is not lowered, and neither is a review', () => {
  const paused = situation({ misses: { 'feature:opus': 0.5 } })
  const r = canLowerNow('feature', paused, 'low')
  expect(r.ok).toBe(false)
  expect(!r.ok && r.why).toBe('lowering feature work on Opus is paused: the rating was wrong too often')
  const few = canLowerNow('debug', situation({ minTasks: 5, counts: { 'debug:opus': 2 } }), 'low')
  expect(!few.ok && few.why).toBe('lowering debug work on Opus is paused: only 2 of the 5 tasks it needs are logged')
  const review = canLowerNow('review', situation(), 'low')
  expect(!review.ok && review.why).toBe('a review stays at its level')
  expect(canLowerNow('review', situation(), 'low', { reviews: true }).ok, 'the effort plan lets a review through').toBe(true)
  // Other types and models are not affected by the pause.
  expect(canLowerNow('lookup', paused, 'low').ok).toBe(true)
  expect(canLowerNow('feature', situation({ tier: 'sonnet', misses: { 'feature:opus': 0.5 } }), 'low').ok).toBe(true)
})

test('the effort plan gives the same reason through canLowerNow', () => {
  const rating: Rating = { type: 'feature', fit: { haiku: 'low', sonnet: 'low', opus: 'low', fable: 'low' }, level: 'low', read: 2000, write: 3000, steps: 3, continues: false } as Rating
  const p = effortPlan(rating, situation({ level: 'high', misses: { 'feature:opus': 0.5 } }), 'low')
  expect(p).toEqual({ kind: 'none', why: 'lowering feature work on Opus is paused: the rating was wrong too often' })
  expect(plan(rating, situation({ level: 'high' }), 'low').kind).toBe('effort')
})
