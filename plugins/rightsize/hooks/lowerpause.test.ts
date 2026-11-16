import { expect, test } from 'claude-code/testing'
import { PAUSE_LAST, type Pauses, UNTIL_LOGGED, capPauses, judge, pauseLength, pausedNow, pausesOf, retryRoute, tick } from './lowerpause'
import type { RouteOutcome } from './misses'

const T0 = Date.parse('2026-11-16T12:00:00Z')
const at = (min: number) => new Date(T0 + min * 60_000).toISOString()
/** Outcomes from minute `from`, one a minute: true is a miss. */
const run = (misses: boolean[], from = 0): RouteOutcome[] => misses.map((miss, i) => ({ miss, at: at(from + i) }))
const K = 'other:opus'

test('the row: 5, 10, 15 or 20 prompts; anything else is 10', () => {
  expect([pauseLength('5 prompts'), pauseLength('15 prompts'), pauseLength('20 prompts')]).toEqual([5, 15, 20])
  expect([pauseLength(undefined), pauseLength('7 prompts'), pauseLength(3)]).toEqual([10, 10, 10])
})

test('a route is judged on its last 10 outcomes: 2 wrong pauses it, 1 does not; fewer than 5 outcomes never', () => {
  expect(judge({ [K]: run([true, false, false, false, false, false, false, false, false, true]) }, {}, 0.2, 10)).toEqual({ pauses: { [K]: { left: 10 } }, started: [K] })
  expect(judge({ [K]: run([true, ...Array(9).fill(false)]) }, {}, 0.2, 10).started).toEqual([])
  expect(judge({ [K]: run([true, true, false, false]) }, {}, 0.2, 10).started, 'only 4 outcomes').toEqual([])
  // Old misses fall out of the last 10.
  expect(judge({ [K]: run([true, true, true, ...Array(PAUSE_LAST).fill(false)]) }, {}, 0.2, 10).started).toEqual([])
})

test('a paused route is not judged again; never pause (null) clears every pause', () => {
  const p = { [K]: { left: 3 } }
  expect(judge({ [K]: run(Array(10).fill(true)) }, p, 0.2, 10)).toEqual({ pauses: p, started: [] })
  expect(judge({ [K]: run(Array(10).fill(true)) }, p, null, 10)).toEqual({ pauses: {}, started: [] })
})

test('each prompt counts the pause down; at 0 the route comes back on probation from that time', () => {
  let p: Pauses = { [K]: { left: 2 } }
  const a = tick(p, [K, 'other:sonnet'], at(1))
  expect(a).toEqual({ pauses: { [K]: { left: 1 } }, resumed: [] })
  p = a.pauses
  const b = tick(p, [K], at(2))
  expect(b).toEqual({ pauses: { [K]: { left: 0, since: at(2) } }, resumed: [K] })
  expect(tick(b.pauses, [K], at(3)).pauses, 'a route not paused does not count').toEqual(b.pauses)
})

test('on probation one wrong outcome after it came back pauses it again; the misses before do not count', () => {
  const p = { [K]: { left: 0, since: at(10) } }
  const old = run([true, true, true, true, true])
  expect(judge({ [K]: old }, p, 0.2, 5).started, 'only old misses').toEqual([])
  expect(judge({ [K]: [...old, ...run([false, false], 11)] }, p, 0.2, 5).started).toEqual([])
  expect(judge({ [K]: [...old, ...run([false, true], 11)] }, p, 0.2, 5)).toEqual({ pauses: { [K]: { left: 5 } }, started: [K] })
  // 10 outcomes on: probation is over, and one miss in 10 is under the line.
  expect(judge({ [K]: [...old, ...run([...Array(9).fill(false), true], 11)] }, p, 0.2, 5).started).toEqual([])
})

test('Try lowering again ends the pause now, on probation', () => {
  expect(retryRoute({ [K]: { left: 7 }, 'lookup:opus': { left: 2 } }, K, at(5))).toEqual({ [K]: { left: 0, since: at(5) }, 'lookup:opus': { left: 2 } })
})

test('paused now: the prompts left, and a research prior over the line until 10 own outcomes', () => {
  const now = pausedNow({ [K]: { left: 4 }, 'lookup:opus': { left: 0, since: at(1) } }, {}, 0.2)
  expect(now[K]).toBe(4)
  expect(now['lookup:opus']).toBeUndefined()
  expect(now['review:haiku'], 'reviews on Haiku: the research says 80% missed').toBe(UNTIL_LOGGED)
  expect(pausedNow({}, { 'review:haiku': { n: 10, misses: 0 } }, 0.2)['review:haiku'], 'own outcomes take over').toBeUndefined()
  expect(pausedNow({ [K]: { left: 4 } }, {}, null)).toEqual({})
})

test('the store value is read back with only well-formed entries', () => {
  expect(pausesOf({ a: { left: 3 }, b: { left: 0, since: 'x' }, c: { left: -1 }, d: 'no', e: { left: 2.7 } })).toEqual({ a: { left: 3 }, b: { left: 0, since: 'x' }, e: { left: 2 } })
  expect(pausesOf(null)).toEqual({})
})

test('a shorter Lowering pause shortens the pauses already running; a longer one does not lengthen them', () => {
  expect(capPauses({ a: { left: 9 }, b: { left: 3 }, c: { left: 0, since: 'x' } }, 5)).toEqual({ a: { left: 5 }, b: { left: 3 }, c: { left: 0, since: 'x' } })
})
