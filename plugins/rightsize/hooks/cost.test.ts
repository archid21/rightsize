import { expect, test } from 'claude-code/testing'
import {
  CAL_FULL,
  DEFAULT_PRICES,
  DEFAULT_RULES,
  SWITCH_KEY,
  type Rating,
  type Situation,
  delegateCost,
  effortPlan,
  factor,
  learn,
  mainCost,
  money,
  parsePrices,
  parseShare,
  plan,
  share,
  tierOf,
} from './cost'
import { parseRating } from './rate'
import { report } from './register'

const rating = (over: Partial<Rating>): Rating => ({
  level: 'medium',
  model: 'same',
  size: 'small',
  type: 'other',
  read: 2000,
  write: 300,
  steps: 1,
  reason: '',
  ...over,
})
const opus: Situation = { tier: 'opus', level: 'medium', context: 20_000, prices: DEFAULT_PRICES, cal: {} }
const fable: Situation = { tier: 'fable', level: 'high', context: 60_000, prices: DEFAULT_PRICES, cal: {} }
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6 * Math.max(1, Math.abs(b))
const freeSwitches = { [SWITCH_KEY]: { n: CAL_FULL, ratio: 0 } }

test('reads a rating, filling gaps and refusing a missing level', async () => {
  const r = parseRating('```json\n{"level":"High","model":"FABLE","size":"bulky","type":"debug","read":5000,"write":800,"steps":6,"reason":"race in token refresh."}\n```')
  expect(r).toEqual({ level: 'high', model: 'fable', size: 'bulky', type: 'debug', read: 5000, write: 800, steps: 6, reason: 'race in token refresh' })
  const loose = parseRating('{"level":"low","model":"gpt","type":"nonsense","read":-4}')
  expect(loose?.model, 'unknown model is same').toBe('same')
  expect(loose?.type, 'unknown type is other').toBe('other')
  expect(loose?.read, 'bad read is the default').toBe(2000)
  expect(parseRating('{"model":"haiku"}'), 'no level').toBeUndefined()
  expect(parseRating('no json here'), 'no json').toBeUndefined()
})

test('knows the model family from an API model id', async () => {
  expect(tierOf('claude-opus-5-5')).toBe('opus')
  expect(tierOf('claude-fable-5-1[1m]')).toBe('fable')
  expect(tierOf('claude-haiku-5-5')).toBe('haiku')
  expect(tierOf('gpt-5')).toBeUndefined()
})

test('reads prices.json, keeping defaults for what it lacks', async () => {
  const p = parsePrices(JSON.stringify({ cacheTtl: '1h', models: { opus: { input: 4, output: 20, cacheRead: 0.2, cacheWrite1h: 8 }, haiku: { output: 'x' } } }))
  expect(p.opus.cacheWrite, '1h write price chosen').toBe(8)
  expect(p.haiku.output, 'bad field keeps the default').toBe(DEFAULT_PRICES.haiku.output)
  expect(p.haiku.cacheWrite, '1h write falls back to 2x input').toBe(0.2)
  expect(parsePrices('not json'), 'unreadable file: defaults').toEqual(DEFAULT_PRICES)
  expect(parsePrices('{}').opus.cacheWrite, 'no TTL named: the 1-hour write').toBe(8)
  expect(parsePrices(JSON.stringify({ cacheTtl: '5m' })).opus.cacheWrite, '5m with no price: 1.25x input').toBe(5)
})

test('does not lower effort when the cache rewrite costs more than it saves', async () => {
  const p = effortPlan(rating({ level: 'low', type: 'lookup' }), opus, 'low')
  expect(p.kind).toBe('none')
  if (p.kind === 'none') expect(p.why).toContain('cache')
})

test('lowers effort once switches are measured to keep the cache', async () => {
  const p = effortPlan(rating({ level: 'low', type: 'lookup', write: 1500 }), { ...opus, cal: freeSwitches }, 'low')
  expect(p.kind).toBe('effort')
  if (p.kind === 'effort') {
    expect(p.dir).toBe('lower')
    expect(p.level).toBe('low')
  }
})

test('never lowers below the floor, and raises when the work needs it', async () => {
  const floored = effortPlan(rating({ level: 'low', write: 1500 }), { ...opus, cal: freeSwitches }, 'medium')
  expect(floored.kind, 'low clamped to the medium floor = the level in use').toBe('none')
  const up = effortPlan(rating({ level: 'xhigh' }), opus, 'low')
  expect(up).toEqual({ kind: 'effort', dir: 'raise', level: 'xhigh' })
})

test('hands a big mechanical task on Fable down to Haiku', async () => {
  const r = rating({ level: 'low', model: 'haiku', size: 'bulky', type: 'search', read: 150_000, write: 3000, steps: 30 })
  const p = plan(r, fable, 'low')
  expect(p.kind).toBe('delegate')
  if (p.kind === 'delegate') {
    expect(p.dir).toBe('down')
    expect(p.tier).toBe('haiku')
    expect(p.delegateCost, 'well under staying').toBeLessThan(p.mainCost * 0.7)
  }
})

test('the hand-off and lowering thresholds follow the settings, 70% and 90% by default', async () => {
  expect(DEFAULT_RULES).toEqual({ handOff: 0.7, lower: 0.9 })
  expect(parseShare('50%', 0.7)).toBe(0.5)
  expect(parseShare('150%', 0.7), 'over 100%: the default').toBe(0.7)
  expect(parseShare(undefined, 0.9), 'unset: the default').toBe(0.9)

  // Hand-off: the same task passes or not as the threshold moves past its cost ratio.
  const big = rating({ level: 'low', model: 'haiku', size: 'bulky', type: 'search', read: 150_000, write: 3000, steps: 30 })
  const sent = plan(big, fable, 'low')
  if (sent.kind !== 'delegate') throw new Error('expected a hand-off at the default')
  const ratio = sent.delegateCost / sent.mainCost
  expect(plan(big, { ...fable, rules: { ...DEFAULT_RULES, handOff: ratio * 0.9 } }, 'low').kind, 'stricter: stays').not.toBe('delegate')
  expect(plan(big, { ...fable, rules: { ...DEFAULT_RULES, handOff: ratio * 1.1 } }, 'low').kind).toBe('delegate')

  // Lowering: the same.
  const small = rating({ level: 'low', type: 'lookup', write: 1500 })
  const s = { ...opus, cal: freeSwitches }
  const keep = mainCost(small, s, 'medium', 0)
  const low = mainCost(small, s, 'low', 2)
  expect(effortPlan(small, { ...s, rules: { ...DEFAULT_RULES, lower: (low / keep) * 0.9 } }, 'low').kind, 'stricter: keeps medium').toBe('none')
  expect(effortPlan(small, { ...s, rules: { ...DEFAULT_RULES, lower: (low / keep) * 1.1 } }, 'low').kind).toBe('effort')
})

test('keeps a small task on the main model even when a cheaper one could do it', async () => {
  const p = plan(rating({ level: 'high', model: 'haiku', size: 'small' }), fable, 'low')
  expect(p.kind, 'small: the level in use fits').toBe('none')
})

test('does not hand down when the hand-off costs more than it saves', async () => {
  // A bulky label on tiny work: the brief, report and check outweigh the savings.
  const r = rating({ level: 'high', model: 'sonnet', size: 'bulky', read: 500, write: 200, steps: 1 })
  const p = plan(r, fable, 'low')
  expect(p.kind).not.toBe('delegate')
})

test('offers a stronger model as a subagent, with both costs', async () => {
  const p = plan(rating({ level: 'high', model: 'fable', type: 'debug', read: 30_000, write: 4000, steps: 12 }), opus, 'low')
  expect(p.kind).toBe('delegate')
  if (p.kind === 'delegate') {
    expect(p.dir).toBe('up')
    expect(p.tier).toBe('fable')
    expect(p.delegateCost).toBeGreaterThan(p.mainCost)
  }
})

test('calibration moves estimates toward what runs really cost', async () => {
  const r = rating({ type: 'search', read: 10_000, write: 1000, steps: 4 })
  const before = mainCost(r, opus, 'medium', 0)
  let cal = {}
  for (let i = 0; i < CAL_FULL; i++) cal = learn(cal, 'search:main', 2)
  expect(near(factor(cal, 'search:main'), 2), 'fully measured after 20 runs').toBe(true)
  expect(near(mainCost(r, { ...opus, cal }, 'medium', 0), before * 2), 'estimate doubled').toBe(true)
  const half = learn(learn({}, 'x', 3), 'x', 3)
  expect(near(factor(half, 'x'), 1 + (3 - 1) * (2 / CAL_FULL)), 'two runs move it 10% of the way').toBe(true)
  const sub = rating({ type: 'search', model: 'haiku', size: 'bulky', read: 100_000, steps: 20 })
  const d0 = delegateCost(sub, fable, 'haiku', 'low')
  const d1 = delegateCost(sub, { ...fable, cal: learn({}, 'search:delegate', 0.5) }, 'haiku', 'low')
  expect(d1, 'delegate estimates calibrate too').toBeLessThan(d0)
})

test('reports a hand-off in dollars or as a share of usage', async () => {
  const run = { tier: 'fable' as const, stay: 0.31, delegate: { tier: 'haiku' as const, level: 'low' as const, dir: 'down' as const } }
  expect(report(run, 0.04, 'api')).toBe('rightsize: Sent to Haiku: $0.04 vs about $0.31 on Fable (estimated), saved about 87%.')
  expect(report(run, 0.04, 'subscription')).toContain('used about 13% of the usage staying on Fable would')
  const up = { tier: 'opus' as const, stay: 0.3, delegate: { tier: 'fable' as const, level: 'high' as const, dir: 'up' as const } }
  expect(report(up, 0.81, 'api')).toBe('rightsize: Sent to Fable: $0.81 vs about $0.30 on Opus (estimated), cost about 2.7x staying.')
  expect(money(0.001)).toBe('under $0.01')
  expect(share(1, 0)).toBe('an unknown share of')
})
