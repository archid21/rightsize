import { expect, test } from 'claude-code/testing'
import {
  CAL_FULL,
  DEFAULT_PRICES,
  DEFAULT_RULES,
  SWITCH_KEY,
  type Rating,
  type Situation,
  delegateCost,
  delegateKeys,
  effortPlan,
  mainKeys,
  factor,
  learn,
  mainCost,
  money,
  parsePrices,
  parseShare,
  plan,
  share,
  paceOf,
  pacedRules,
  sizeSubagent,
  tierOf,
} from './cost'
import { parseRating } from './rate'
import { report } from './register'

const rating = (over: Partial<Rating>): Rating => ({
  level: 'medium',
  fit: { opus: 'medium' },
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

test('reads each model\'s level, filling gaps from the models below', async () => {
  const r = parseRating(
    '```json\n{"fit":{"haiku":"High","sonnet":"high","opus":"medium","fable":"high"},"size":"small","type":"feature","read":5000,"write":800,"steps":6,"reason":"small helper."}\n```',
    'opus',
  )
  expect(r).toEqual({
    level: 'medium',
    fit: { haiku: 'high', sonnet: 'high', opus: 'medium', fable: 'medium' },
    size: 'small',
    type: 'feature',
    read: 5000,
    write: 800,
    steps: 6,
    reason: 'small helper',
  })
  const gaps = parseRating('{"fit":{"haiku":"no","sonnet":"xhigh","opus":"no","fable":"oops"}}', 'opus')
  expect(gaps?.fit, 'a stronger model fits what a weaker one fits; unreadable is filled too').toEqual({ haiku: null, sonnet: 'xhigh', opus: 'xhigh', fable: 'xhigh' })
  const hard = parseRating('{"fit":{"haiku":"no","sonnet":"no","opus":"no","fable":"high"}}', 'opus')
  expect(hard?.level, 'the current model would struggle: the stronger model\'s level').toBe('high')
  expect(parseRating('{"fit":{"haiku":"no","opus":"no"}}', 'opus'), 'no model fits').toBeUndefined()
  expect(parseRating('no json here', 'opus'), 'no json').toBeUndefined()
})

test('still reads the older one-level rating', async () => {
  const up = parseRating('{"level":"High","model":"FABLE","size":"bulky","type":"debug","read":5000,"write":800,"steps":6}', 'opus')
  expect(up?.fit, 'a stronger model named: the current one would struggle').toEqual({ opus: null, fable: 'high' })
  expect(up?.level).toBe('high')
  const down = parseRating('{"level":"low","model":"haiku","type":"search"}', 'fable')
  expect(down?.fit).toEqual({ haiku: 'low', sonnet: 'low', opus: 'low', fable: 'low' })
  const loose = parseRating('{"level":"low","model":"gpt","type":"nonsense","read":-4}', 'opus')
  expect(loose?.fit, 'unknown model is the current one').toEqual({ opus: 'low', fable: 'low' })
  expect(loose?.type, 'unknown type is other').toBe('other')
  expect(loose?.read, 'bad read is the default').toBe(2000)
  expect(parseRating('{"model":"haiku"}', 'opus'), 'no level').toBeUndefined()
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
  const r = rating({ level: 'low', fit: { haiku: 'low', fable: 'low' }, size: 'bulky', type: 'search', read: 150_000, write: 3000, steps: 30 })
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
  const big = rating({ level: 'low', fit: { haiku: 'low', fable: 'low' }, size: 'bulky', type: 'search', read: 150_000, write: 3000, steps: 30 })
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
  const p = plan(rating({ level: 'high', fit: { haiku: 'high', fable: 'high' }, size: 'small' }), fable, 'low')
  expect(p.kind, 'small: the brief and check outweigh the saving').toBe('none')
})

test('does not hand down when the hand-off costs more than it saves', async () => {
  // A bulky label on tiny work: the brief, report and check outweigh the savings.
  const r = rating({ level: 'high', fit: { sonnet: 'high', fable: 'high' }, size: 'bulky', read: 500, write: 200, steps: 1 })
  const p = plan(r, fable, 'low')
  expect(p.kind).not.toBe('delegate')
})

test('offers a stronger model as a subagent, with both costs', async () => {
  const p = plan(rating({ level: 'high', fit: { opus: null, fable: 'high' }, type: 'debug', read: 30_000, write: 4000, steps: 12 }), opus, 'low')
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
  const sub = rating({ type: 'search', fit: { haiku: 'low' }, size: 'bulky', read: 100_000, steps: 20 })
  const d0 = delegateCost(sub, fable, 'haiku', 'low')
  const d1 = delegateCost(sub, { ...fable, cal: learn({}, 'search:delegate', 0.5) }, 'haiku', 'low')
  expect(d1, 'delegate estimates calibrate too').toBeLessThan(d0)
})

// The case that needs both changes at once: Opus at medium is not enough, and a
// cheaper model at a higher level would do it for less than raising Opus.
const helper = { type: 'feature' as const, read: 20_000, write: 2000, steps: 6 }
const bulky = { type: 'feature' as const, size: 'bulky' as const, read: 150_000, write: 3000, steps: 30 }

test('on Opus at medium, sends work Haiku can do at high to Haiku at high, not Opus to high', async () => {
  const r = rating({ ...helper, level: 'high', fit: { haiku: 'high', sonnet: 'high', opus: 'high', fable: 'medium' } })
  const p = plan(r, opus, 'low')
  expect(p.kind).toBe('delegate')
  if (p.kind !== 'delegate') return
  expect(p.dir).toBe('down')
  expect(p.tier).toBe('haiku')
  expect(p.level, 'the subagent runs at the level Haiku needs').toBe('high')
  expect(p.instead, 'what Opus would have needed').toBe('high')
  expect(near(p.mainCost, mainCost(r, opus, 'high', 2)), 'compared with raising Opus, its switch there and back counted').toBe(true)
  expect(p.delegateCost).toBeLessThan(p.mainCost * DEFAULT_RULES.handOff)
})

test('picks Sonnet when Haiku would struggle, at the level Sonnet needs', async () => {
  const r = rating({ ...bulky, level: 'high', fit: { haiku: null, sonnet: 'xhigh', opus: 'high', fable: 'high' } })
  const p = plan(r, fable, 'low')
  expect(p.kind === 'delegate' && `${p.tier} at ${p.level}`).toBe('sonnet at xhigh')
})

test('on Opus, Sonnet must still clear the hand-off share of raising Opus', async () => {
  // Sonnet costs half of Opus per token; the brief, check and likely rework eat most of that.
  const r = rating({ ...helper, level: 'high', fit: { haiku: null, sonnet: 'xhigh', opus: 'high', fable: 'high' } })
  const ratio = delegateCost(r, opus, 'sonnet', 'xhigh') / mainCost(r, opus, 'high', 2)
  expect(ratio).toBeGreaterThan(DEFAULT_RULES.handOff)
  expect(plan(r, opus, 'low')).toEqual({ kind: 'effort', dir: 'raise', level: 'high' })
  const loose = plan(r, { ...opus, rules: { ...DEFAULT_RULES, handOff: ratio * 1.1 } }, 'low')
  expect(loose.kind === 'delegate' && loose.tier, 'a looser hand-off share sends it').toBe('sonnet')
})

test('of two models that fit, picks the cheaper route, and calibration per model and level can change it', async () => {
  const r = rating({ ...bulky, level: 'medium', fit: { haiku: 'xhigh', sonnet: 'medium', opus: 'medium', fable: 'medium' } })
  const s = { ...fable, level: 'medium' as const }
  const haiku = delegateCost(r, s, 'haiku', 'xhigh')
  const sonnet = delegateCost(r, s, 'sonnet', 'medium')
  expect(haiku, 'Haiku at xhigh is the cheaper guess').toBeLessThan(sonnet)
  const p = plan(r, s, 'low')
  expect(p.kind === 'delegate' && p.tier).toBe('haiku')
  // Haiku at xhigh measured at 10x its estimate: Sonnet at medium wins.
  let cal = {}
  for (let i = 0; i < CAL_FULL; i++) for (const k of delegateKeys('feature', 'haiku', 'xhigh').slice(1)) cal = learn(cal, k, 10)
  const q = plan(r, { ...s, cal }, 'low')
  expect(q.kind === 'delegate' && q.tier).toBe('sonnet')
  expect(delegateCost(r, { ...s, cal }, 'sonnet', 'medium'), 'other models keep their estimates').toBe(sonnet)
})

test('a model and level with few runs leans on the task type as a whole', async () => {
  const r = rating({ ...helper, fit: { haiku: 'high', opus: 'medium' } })
  const typeWide = learn({}, 'feature:delegate', 3)
  const base = delegateCost(r, opus, 'haiku', 'high')
  expect(near(delegateCost(r, { ...opus, cal: typeWide }, 'haiku', 'high'), base * (1 + 2 / CAL_FULL)), 'the type-wide ratio is the prior').toBe(true)
})

test('raises effort on the main model when the switch is free and the work is too small to brief', async () => {
  const r = rating({ level: 'high', fit: { haiku: 'high', opus: 'high' }, read: 1000, write: 200, steps: 1 })
  expect(plan(r, { ...opus, cal: freeSwitches }, 'low')).toEqual({ kind: 'effort', dir: 'raise', level: 'high' })
})

test('the floor applies to the subagent\'s level too', async () => {
  const r = rating({ ...helper, level: 'medium', fit: { haiku: 'low', opus: 'medium' }, size: 'bulky', read: 150_000, steps: 30 })
  const p = plan(r, opus, 'medium')
  expect(p.kind === 'delegate' && p.level).toBe('medium')
})

test('the main chat learns per model and level: expensive high runs leave the low estimate alone', async () => {
  const r = rating({ type: 'debug', read: 10_000, write: 1000, steps: 4 })
  const low = mainCost(r, opus, 'low', 0)
  const high = mainCost(r, opus, 'high', 0)
  let cal = {}
  for (let i = 0; i < CAL_FULL; i++) for (const k of mainKeys('debug', 'opus', 'high').slice(1)) cal = learn(cal, k, 3)
  expect(near(mainCost(r, { ...opus, cal }, 'high', 0), high * 3), 'Opus at high: 3x').toBe(true)
  expect(near(mainCost(r, { ...opus, cal }, 'low', 0), low * 3), 'Opus at low: only the model-wide key moved it').toBe(true)
  // The model-wide key moved low too; with only the level key taught, low stays put.
  let levelOnly = {}
  for (let i = 0; i < CAL_FULL; i++) levelOnly = learn(levelOnly, 'debug:main:opus:high', 3)
  expect(mainCost(r, { ...opus, cal: levelOnly }, 'low', 0), 'another level: untouched').toBe(low)
  expect(mainCost(r, { ...fable, cal: levelOnly }, 'high', 0), 'another model: untouched').toBe(mainCost(r, fable, 'high', 0))
  // A level with few runs leans on the type-wide ratio.
  const typeWide = learn({}, 'debug:main', 3)
  expect(near(mainCost(r, { ...opus, cal: typeWide }, 'low', 0), low * (1 + 2 / CAL_FULL))).toBe(true)
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

test("sizes Claude's own subagent: the cheapest weaker model that fits, never a stronger one", async () => {
  const listing = rating({ fit: { haiku: 'low', sonnet: 'low', opus: 'low', fable: 'low' }, read: 8000, write: 500, steps: 5 })
  expect(sizeSubagent(listing, opus, 'opus', 'low')?.tier).toBe('haiku')
  expect(sizeSubagent(listing, opus, 'opus', 'low')?.level).toBe('low')
  expect(sizeSubagent(listing, opus, 'opus', 'medium')?.level, 'the lowest level still holds').toBe('medium')
  const routine = rating({ fit: { haiku: null, sonnet: 'medium', opus: 'low', fable: 'low' }, read: 8000, write: 500, steps: 5 })
  expect(sizeSubagent(routine, opus, 'opus', 'low')?.tier).toBe('sonnet')
  expect(sizeSubagent(routine, opus, 'opus', 'low')?.level).toBe('medium')
  const hard = rating({ fit: { haiku: null, sonnet: null, opus: null, fable: 'high' } })
  expect(sizeSubagent(hard, opus, 'opus', 'low'), 'the parent would struggle: not a saving to make').toBeUndefined()
  expect(sizeSubagent(listing, opus, 'haiku', 'low'), 'nothing is weaker than Haiku').toBeUndefined()
  const cheapFable = { ...opus, prices: { ...DEFAULT_PRICES, fable: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } }
  expect(sizeSubagent(rating({ fit: { haiku: null, sonnet: null, opus: 'low', fable: 'low' } }), cheapFable, 'opus', 'low'), 'not a stronger model, even when it is priced lower').toBeUndefined()
  expect(sizeSubagent(rating({ fit: { haiku: 'low', opus: null } }), opus, 'opus', 'low'), 'a rating where the parent would struggle moves nothing').toBeUndefined()
  const strict = { ...opus, rules: { ...DEFAULT_RULES, handOff: 0.01 } }
  expect(sizeSubagent(routine, strict, 'opus', 'low'), 'the hand-off share applies').toBeUndefined()
})

test('paces the window that would stop the person first', async () => {
  const now = Date.parse('2026-10-23T12:00:00Z')
  const H = 3600_000
  const at = (ms: number) => new Date(now + ms).toISOString()
  const hot = paceOf([{ kind: 'five_hour', percentUsed: 80, resetsAt: at(2 * H) }], now)
  expect([hot.mode, hot.window, Number(hot.pace?.toFixed(2))]).toEqual(['hot', 'five_hour', 1.33])
  const week = paceOf([
    { kind: 'five_hour', percentUsed: 20, resetsAt: at(2 * H) },
    { kind: 'seven_day', percentUsed: 85, resetsAt: at(72 * H) },
  ], now)
  expect([week.mode, week.window], 'the 5-hour window at 0.33 does not hide the week at 1.49').toEqual(['hot', 'seven_day'])
  const weekFirst = paceOf([
    { kind: 'seven_day', percentUsed: 85, resetsAt: at(72 * H) },
    { kind: 'five_hour', percentUsed: 20, resetsAt: at(2 * H) },
  ], now)
  expect(weekFirst.window, 'in either order').toBe('seven_day')
  expect(paceOf([{ kind: 'five_hour', percentUsed: 95 }, { kind: 'seven_day', percentUsed: 92 }], now).used, 'the fuller of two nearly-used windows').toBe(95)
  expect(paceOf([{ kind: 'seven_day', percentUsed: 30, resetsAt: at(6 * H) }], now).mode).toBe('cool')
  expect(paceOf([{ kind: 'five_hour', percentUsed: 6, resetsAt: at(4 * H + 40 * 60_000) }], now).mode, 'too early in the window').toBe('normal')
  expect(paceOf([{ kind: 'five_hour', percentUsed: 6, resetsAt: at(4 * H + 40 * 60_000) }], now).pace).toBeUndefined()
  const max = paceOf([{ kind: 'five_hour', percentUsed: 93 }, { kind: 'seven_day', percentUsed: 85, resetsAt: at(72 * H) }], now)
  expect([max.mode, max.window, max.used], 'nearly used up wins, reset time or not').toEqual(['max', 'five_hour', 93])
  expect(paceOf([{ kind: 'spend_limit', percentUsed: 95 }], now).mode, 'a gateway spend limit is not paced').toBe('normal')
  expect(paceOf([], now).mode).toBe('normal')
})

test('moves the thresholds by pace', async () => {
  const at = (mode: 'normal' | 'hot' | 'cool' | 'max') => {
    const r = pacedRules(DEFAULT_RULES, { mode })
    return [Math.round(r.handOff * 100), Math.round(r.lower * 100)]
  }
  expect(at('normal')).toEqual([70, 90])
  expect(at('hot')).toEqual([85, 97])
  expect(at('cool')).toEqual([50, 80])
  expect(at('max')).toEqual([95, 100])
})
