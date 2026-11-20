import { expect, test } from 'claude-code/testing'
import { UNSURE_WINDOW, missRates, ownTasks, unsureKey, unsureOutcomes, unsurePaused } from './misses'
import { type RunLine, accuracyRows } from './report'

// P-83 (ADR 0096): lowering when the rater is not sure. Own miss bucket (`unsure:${type}:${tier}`), a window of the last 10 unsure
// prompts, a pause over 20% misses, and a cooldown by count: a left prompt still enters the window as a non-miss.

const T0 = Date.parse('2026-11-19T12:00:00Z')
let n = 0
const at = () => new Date(T0 + n++ * 60_000).toISOString()
const OPUS = 'claude-opus-5-5'

/** An unsure prompt that was lowered (a miss when `miss`: it had to step up after a tool error). */
const lowered = (miss = false, over: Partial<RunLine> = {}): RunLine => ({ at: at(), kind: 'run', id: `u${n}`, type: 'lookup', route: 'main', tier: 'opus', model: OPUS, unsure: 'rater', change: 'lower', unsureTry: 'lowered', unsureKey: unsureKey('lookup', 'opus'), ...(miss ? { steppedUp: true, steppedUpBy: 'error' } : {}), ...over })
/** An unsure prompt left as it was because lowering unsure prompts was paused. */
const left = (over: Partial<RunLine> = {}): RunLine => ({ at: at(), kind: 'run', id: `l${n}`, type: 'lookup', route: 'main', tier: 'opus', model: OPUS, unsure: 'rater', change: 'none', unsureTry: 'paused', unsureKey: unsureKey('lookup', 'opus'), ...over })
/** A normal lowered prompt (the rater was sure). */
const normal = (miss = false, over: Partial<RunLine> = {}): RunLine => ({ at: at(), kind: 'run', id: `n${n}`, type: 'lookup', route: 'main', tier: 'opus', model: OPUS, change: 'lower', ...(miss ? { steppedUp: true, steppedUpBy: 'error' } : {}), ...over })
const K = unsureKey('lookup', 'opus')
const list = (lines: RunLine[], current?: Parameters<typeof unsureOutcomes>[1]) => unsureOutcomes(lines, current)[K] ?? []
const pausedAfter = (lines: RunLine[], line: number | null = 0.2) => unsurePaused(list(lines), line).paused

test('the bucket key is unsure:type:tier', () => {
  expect(unsureKey('lookup', 'opus')).toBe('unsure:lookup:opus')
  expect(UNSURE_WINDOW).toBe(10)
})

test('window of 10: 2 misses in 10 do not pause, 3 do; with fewer than 10 prompts lowering is allowed', () => {
  const ten = (misses: number) => [...Array(misses).fill(true), ...Array(10 - misses).fill(false)].map(m => lowered(m))
  expect(pausedAfter(ten(0))).toBe(false)
  expect(pausedAfter(ten(2)), '2 of 10 is 20%: not over the line').toBe(false)
  expect(pausedAfter(ten(3))).toBe(true)
  expect(pausedAfter(Array.from({ length: 9 }, () => lowered(true))), '9 prompts, all missed: under the window').toBe(false)
  expect(unsurePaused(list(ten(3)), 0.2)).toMatchObject({ paused: true, misses: 3, n: 10 })
  // Only the last 10 count: three old misses fall out behind ten good prompts.
  expect(pausedAfter([lowered(true), lowered(true), lowered(true), ...Array.from({ length: 10 }, () => lowered())])).toBe(false)
})

test('Pause after misses null never pauses; a stricter line pauses sooner', () => {
  const lines = Array.from({ length: 10 }, (_, i) => lowered(i < 5))
  expect(pausedAfter(lines, null)).toBe(false)
  expect(pausedAfter(Array.from({ length: 10 }, (_, i) => lowered(i < 2)), 0.1)).toBe(true)
})

test('cooldown: each left prompt enters the window as a non-miss, and lowering resumes once the rate is back at 20% or under', () => {
  const lines = [lowered(true), lowered(true), lowered(true), ...Array.from({ length: 7 }, () => lowered())]
  expect(pausedAfter(lines), '3 of 10: paused').toBe(true)
  lines.push(left())
  expect(list(lines).at(-1)?.miss, 'a left prompt is no miss').toBe(false)
  expect(pausedAfter(lines), 'the oldest miss left the window: 2 of 10').toBe(false)
  // A different shape: misses are the newest, so it takes more left prompts.
  const late = [...Array.from({ length: 7 }, () => lowered()), lowered(true), lowered(true), lowered(true)]
  expect(pausedAfter(late)).toBe(true)
  const more = [...late]
  for (let i = 1; i <= 8; i++) {
    more.push(left())
    expect(pausedAfter(more), `${i} left`).toBe(i < 8)
  }
})

test('a miss means what it means today: error step-up, raise, failing tests, corrected, 👎; not the 5-step rule, not a 👍', () => {
  const base = lowered()
  const hit = (over: Partial<RunLine>) => list([lowered(false, { id: 'x', ...over })])[0]?.miss
  expect(hit({})).toBe(false)
  expect(hit({ steppedUp: true, steppedUpBy: 'error' })).toBe(true)
  expect(hit({ steppedUp: true, steppedUpBy: 'steps' })).toBe(false)
  expect(hit({ escalations: [{ step: 3, from: 'low', to: 'medium', why: 'stuck' }] })).toBe(true)
  expect(hit({ tests: 'failed' })).toBe(true)
  expect(hit({ aborted: true }), 'an aborted turn says nothing').toBeUndefined()
  const corrected: RunLine = { at: at(), kind: 'corrected', ref: 'x' }
  expect(list([lowered(false, { id: 'x' }), corrected])[0]?.miss).toBe(true)
  const down: RunLine = { at: at(), kind: 'feedback', ref: 'x', value: 'down' }
  const up: RunLine = { at: at(), kind: 'feedback', ref: 'x', value: 'up' }
  expect(list([lowered(false, { id: 'x' }), down])[0]?.miss).toBe(true)
  expect(list([lowered(false, { id: 'x' }), corrected, up])[0]?.miss, 'a verdict stands over a correction').toBe(false)
  expect(base.unsureTry).toBe('lowered')
})

test('buckets are separate both ways: unsure results never move the normal rates, normal results never move the unsure bucket', () => {
  const lines: RunLine[] = [
    ...Array.from({ length: 5 }, () => normal()),
    normal(true, { id: 'nm' }),
    lowered(true, { id: 'um' }),
    lowered(true),
    lowered(),
    left(),
    { at: at(), kind: 'corrected', ref: 'um' },
    { at: at(), kind: 'feedback', ref: 'um', value: 'down' },
  ]
  expect(missRates(lines)['lookup:opus'], 'only the six normal prompts').toEqual({ n: 6, misses: 1 })
  expect(missRates(lines)['unsure:lookup:opus']).toBeUndefined()
  expect(ownTasks(lines)['lookup:opus']).toBe(6)
  const u = unsureOutcomes(lines)
  expect(Object.keys(u)).toEqual([K])
  expect(u[K]?.map(o => o.miss), 'the three unsure lowerings and the left one; no normal prompt').toEqual([true, true, false, false])
  expect(unsureOutcomes(lines.filter(l => !l.unsureTry))).toEqual({})
  // Another task type or model is another bucket.
  const other = unsureOutcomes([lowered(true, { type: 'debug' }), lowered(true, { tier: 'sonnet', model: 'claude-sonnet-5-5' })])
  expect(Object.keys(other).sort()).toEqual(['unsure:debug:opus', 'unsure:lookup:sonnet'])
})

test('a new model version starts the unsure bucket clean', () => {
  const lines = Array.from({ length: 10 }, () => lowered(true))
  expect(list(lines, { opus: 'claude-opus-5-5' })).toHaveLength(10)
  expect(list(lines, { opus: 'claude-opus-6' }), 'the old version says nothing about the new one').toHaveLength(0)
})

test('the "Rater not sure" report row: lowered, their misses, the left ones, and a paused bucket', () => {
  const plain = (): RunLine => ({ at: at(), kind: 'run', id: `p${n}`, type: 'lookup', route: 'main', tier: 'opus', model: OPUS, change: 'none' })
  const before = Array.from({ length: 8 }, plain)
  // 7 good, 3 missed, then 2 left: the window ends 3 missed of 10.
  const tries = [...Array.from({ length: 7 }, () => lowered()), lowered(true), lowered(true), lowered(true), left(), left()]
  const rows = accuracyRows([...before, ...tries], 0.2, 0).rows
  expect(rows.find(r => r[0] === 'Rater not sure')?.[1]).toBe('12 of 20 rated prompts (60%), 10 lowered one level (3 missed), 2 left as they were; unsure lowering paused for lookup on Opus')
  // Not paused when the window is under the line, or Pause after misses is never.
  const calm = accuracyRows([...before, ...Array.from({ length: 10 }, () => lowered()), left()], 0.2, 0).rows.find(r => r[0] === 'Rater not sure')?.[1]
  expect(calm).toBe('11 of 19 rated prompts (58%), 10 lowered one level (0 missed), 1 left as they were')
  expect(accuracyRows([...before, ...tries], null, 0).rows.find(r => r[0] === 'Rater not sure')?.[1]).not.toContain('paused')
  // Unsure prompts that were left alone with no lowering tried read as before.
  const old = accuracyRows([...before, { ...plain(), unsure: 'rater' }], 0.2, 0).rows.find(r => r[0] === 'Rater not sure')?.[1]
  expect(old).toBe('1 of 9 rated prompts (11%), left as they were')
})
