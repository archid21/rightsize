import { expect, test } from 'claude-code/testing'
import {
  CAL_FULL,
  DEFAULT_PRICES,
  DEFAULT_RULES,
  PREFERRED,
  SWITCH_KEY,
  TASK_TYPES,
  MISS_BLOCK,
  TIE_BAND,
  TIERS,
  WORK,
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
  cacheTtlMs,
  idleCost,
  parseIdleWarning,
  paceOf,
  pacedRules,
  paceNote,
  sizeSubagent,
  subagentKeys,
  subWork,
  rawMainCost,
  tierOf,
  tieBand,
  type Calibration,
} from './cost'
import { parseRating } from './rate'
import { report } from './register'

const rating = (over: Partial<Rating>): Rating => ({
  level: 'medium',
  fit: { opus: 'medium' },
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
  const r = rating({ level: 'low', fit: { haiku: 'low', fable: 'low' }, type: 'search', read: 150_000, write: 3000, steps: 30 })
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
  const big = rating({ level: 'low', fit: { haiku: 'low', fable: 'low' }, type: 'search', read: 150_000, write: 3000, steps: 30 })
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
  const p = plan(rating({ level: 'high', fit: { haiku: 'high', fable: 'high' } }), fable, 'low')
  expect(p.kind, 'small: the brief and check outweigh the saving').toBe('none')
})

test('does not hand down when the hand-off costs more than it saves', async () => {
  // A bulky label on tiny work: the brief, report and check outweigh the savings.
  const r = rating({ level: 'high', fit: { sonnet: 'high', fable: 'high' }, read: 500, write: 200, steps: 1 })
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
  const sub = rating({ type: 'search', fit: { haiku: 'low' }, read: 100_000, steps: 20 })
  const d0 = delegateCost(sub, fable, 'haiku', 'low')
  const d1 = delegateCost(sub, { ...fable, cal: learn({}, 'search:delegate', 0.5) }, 'haiku', 'low')
  expect(d1, 'delegate estimates calibrate too').toBeLessThan(d0)
})

// The case that needs both changes at once: Opus at medium is not enough, and a
// cheaper model at a higher level would do it for less than raising Opus.
const helper = { type: 'feature' as const, read: 20_000, write: 2000, steps: 6 }
const bulky = { type: 'feature' as const, read: 150_000, write: 3000, steps: 30 }

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
  const r = rating({ ...helper, level: 'medium', fit: { haiku: 'low', opus: 'medium' }, read: 150_000, steps: 30 })
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
  expect(report(run, 0.04, 'api')).toBe('rightsize: Sent to Haiku: $0.04 vs about $0.31 staying on Fable (estimated), saved about 87%.')
  expect(report(run, 0.04, 'subscription')).toContain('used about 13% of the usage vs staying on Fable')
  const up = { tier: 'opus' as const, stay: 0.3, delegate: { tier: 'fable' as const, level: 'high' as const, dir: 'up' as const } }
  expect(report(up, 0.81, 'api')).toBe('rightsize: Sent to Fable: $0.81 vs about $0.30 staying on Opus (estimated), cost about 2.7x vs staying.')
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

test('idle resume: the rewrite over a warm read, the cache life, and the warning bar', async () => {
  const c = idleCost(DEFAULT_PRICES.opus, 100_000)
  expect(near(c.resend, 0.78)).toBe(true)
  expect(near(c.compact, 0.4)).toBe(true)
  expect(cacheTtlMs('{"cacheTtl":"5m"}')).toBe(300_000)
  expect(cacheTtlMs('{}')).toBe(3_600_000)
  expect(cacheTtlMs('not json')).toBe(3_600_000)
  expect([parseIdleWarning('over $0.50'), parseIdleWarning('over $1'), parseIdleWarning('off'), parseIdleWarning(undefined)]).toEqual([0.5, 1, null, 0.1])
})

test("a moved subagent's model learns from what such subagents really cost", async () => {
  const listing = rating({ type: 'search', fit: { haiku: 'low', sonnet: 'low', opus: 'low', fable: 'low' }, read: 8000, write: 500, steps: 5 })
  expect(sizeSubagent(listing, opus, 'opus', 'low')?.tier).toBe('haiku')
  // Haiku's runs of this kind cost 40x their estimate; Sonnet has no record of its own.
  const dear = { ...opus, cal: { 'search:subagent:haiku': { n: CAL_FULL, ratio: 40 } } }
  expect(sizeSubagent(listing, dear, 'opus', 'low')?.tier).toBe('sonnet')
  const size = sizeSubagent(listing, opus, 'opus', 'low')
  expect(size !== undefined && size.parentRaw > size.raw * 10, 'the raw estimates for the saving').toBe(true)
})

test('Sonnet is the baseline: its work equals the old effort multipliers, so its estimates do not change', async () => {
  expect(Object.fromEntries(Object.entries(WORK.sonnet).map(([l, w]) => [l, w.out]))).toEqual({ low: 1, medium: 1.6, high: 2.5, xhigh: 3.5, max: 5 })
  expect(Object.values(WORK.sonnet).every(w => w.steps === 1), 'Sonnet steps are the rated steps').toBe(true)
})

test('work never falls as effort rises, for every model', async () => {
  const levels = ['low', 'medium', 'high', 'xhigh', 'max'] as const
  for (const t of TIERS) {
    for (let i = 1; i < levels.length; i++) {
      expect(WORK[t][levels[i]!].out >= WORK[t][levels[i - 1]!].out, `${t} out ${levels[i]}`).toBe(true)
      expect(WORK[t][levels[i]!].steps >= WORK[t][levels[i - 1]!].steps, `${t} steps ${levels[i]}`).toBe(true)
    }
  }
})

test('a Haiku subagent writes 1.6x the output tokens of a Sonnet one on the same work', async () => {
  // Only output costs money, and the fixed report is taken out by subtracting a run that writes nothing.
  const only = { input: 0, cacheRead: 0, cacheWrite: 0, output: 1_000_000 }
  const prices = { ...DEFAULT_PRICES, haiku: only, sonnet: only }
  const s: Situation = { ...opus, prices }
  const written = (sub: 'haiku' | 'sonnet') => subWork(rating({ write: 1000 }), s, sub, 'medium') - subWork(rating({ write: 0 }), s, sub, 'medium')
  expect(near(written('haiku') / written('sonnet'), 1.6)).toBe(true)
})

test('Opus at low effort re-reads the cache less than at medium, because it takes fewer steps', async () => {
  const prices = { ...DEFAULT_PRICES, opus: { input: 0, output: 0, cacheWrite: 0, cacheRead: 1_000_000 } }
  const s: Situation = { ...opus, prices }
  const r = rating({ steps: 10 })
  expect(rawMainCost(r, s, 'low')).toBeLessThan(rawMainCost(r, s, 'medium'))
})

// ---- Close calls -----------------------------------------------------------

// Pins one route's calibrated estimate to `target` with `n` runs behind its specific key. Below
// CAL_FULL runs the ratio only counts n/CAL_FULL of the way, so the stored ratio is stretched to land on `target`.
const pinned = (cal: Calibration, keys: readonly string[], raw: number, target: number, n: number): Calibration => {
  const last = keys[keys.length - 1] ?? ''
  return { ...cal, [last]: { n, ratio: 1 + (target / raw - 1) * (CAL_FULL / Math.min(n, CAL_FULL)) } }
}

// A Fable session handing a feature down: Sonnet and Opus both fit, so they are the routes to choose between.
const tieRating = rating({ type: 'feature', level: 'medium', fit: { sonnet: 'medium', opus: 'medium', fable: 'medium' }, read: 150_000, write: 3000, steps: 30 })
const tieSession: Situation = { ...fable, level: 'medium' }
const sonnetRaw = delegateCost(tieRating, tieSession, 'sonnet', 'medium')
const opusRaw = delegateCost(tieRating, tieSession, 'opus', 'medium')
// Opus's estimate pinned to `x` times Sonnet's (Sonnet unmeasured, so the band is the full 25%).
const opusAt = (x: number, n = CAL_FULL): Situation => ({
  ...tieSession,
  cal: pinned({}, delegateKeys('feature', 'opus', 'medium'), opusRaw, sonnetRaw * x, n),
})

test('the band starts at 25% and shrinks to nothing as runs are measured', async () => {
  expect(TIE_BAND).toBe(0.25)
  expect(tieBand(0)).toBe(0.25)
  expect(tieBand(10)).toBe(0.125)
  expect(tieBand(CAL_FULL)).toBe(0)
  expect(tieBand(CAL_FULL + 30), 'stays at zero').toBe(0)
})

test('the task-type guide names a model for every task type', async () => {
  for (const t of TASK_TYPES) expect(TIERS.includes(PREFERRED[t]), t).toBe(true)
  expect(PREFERRED.lookup).toBe('haiku')
  expect(PREFERRED.feature).toBe('sonnet')
  expect(PREFERRED.design).toBe('opus')
})

test('a close call on a hand-down goes to the guide\'s model, not the slightly cheaper one', async () => {
  const s = opusAt(0.9)
  expect(delegateCost(tieRating, s, 'opus', 'medium'), 'Opus is the cheaper route').toBeLessThan(delegateCost(tieRating, s, 'sonnet', 'medium'))
  const p = plan(tieRating, s, 'low')
  expect(p.kind === 'delegate' && p.dir, 'still a hand-down').toBe('down')
  expect(p.kind === 'delegate' && p.tier, 'feature: Sonnet').toBe('sonnet')
  expect(p.kind === 'delegate' && p.tie).toEqual({ by: 'guide', over: 'opus' })
  expect(p.kind === 'delegate' && p.delegateCost, 'the cost shown is the route chosen').toBe(delegateCost(tieRating, s, 'sonnet', 'medium'))
})

test('outside the band the cheapest route wins, and there is no tie', async () => {
  const p = plan(tieRating, opusAt(0.7), 'low')
  expect(p.kind === 'delegate' && p.tier).toBe('opus')
  expect(p.kind === 'delegate' && p.tie).toBeUndefined()
  expect('tie' in p, 'the key is absent, not undefined').toBe(false)
})

test('the band shrinks with runs: a gap that is close at 10 runs is not at 20', async () => {
  // Sonnet 11% dearer than Opus: inside 12.5% at 10 runs on each, outside 0% at 20.
  const tieAt = (n: number) => {
    const cal = pinned(pinned({}, delegateKeys('feature', 'opus', 'medium'), opusRaw, sonnetRaw * 0.9, n), delegateKeys('feature', 'sonnet', 'medium'), sonnetRaw, sonnetRaw, n)
    const p = plan(tieRating, { ...tieSession, cal }, 'low')
    return p.kind === 'delegate' ? p.tie : undefined
  }
  expect(tieAt(10)?.by, '1/0.9 = 11% apart').toBe('guide')
  expect(tieAt(20)).toBeUndefined()
})

test('both routes measured 20 or more runs: the cheapest wins, with no tie', async () => {
  const cal = pinned(pinned({}, delegateKeys('feature', 'opus', 'medium'), opusRaw, sonnetRaw * 0.95, CAL_FULL), delegateKeys('feature', 'sonnet', 'medium'), sonnetRaw, sonnetRaw, CAL_FULL)
  const p = plan(tieRating, { ...tieSession, cal }, 'low')
  expect(p.kind === 'delegate' && p.tier).toBe('opus')
  expect(p.kind === 'delegate' && p.tie).toBeUndefined()
  // An equal cost with the band closed is not a close call either.
  const even = pinned(pinned({}, delegateKeys('feature', 'opus', 'medium'), opusRaw, sonnetRaw, CAL_FULL), delegateKeys('feature', 'sonnet', 'medium'), sonnetRaw, sonnetRaw, CAL_FULL)
  const level = plan(tieRating, { ...tieSession, cal: even }, 'low')
  expect(level.kind === 'delegate' && level.tie, 'equal cost, both measured').toBeUndefined()
  // One route measured, the other not: the pair counts the smaller, so the band is open.
  const one = plan(tieRating, opusAt(0.95), 'low')
  expect(one.kind === 'delegate' && one.tie?.by).toBe('guide')
})

test('every fifth close call takes the route the guide did not pick', async () => {
  const s = opusAt(0.9)
  for (const ties of [0, 1, 2, 3]) {
    const p = plan(tieRating, { ...s, ties }, 'low')
    expect(p.kind === 'delegate' && p.tier, `tie ${ties + 1}: the guide's pick`).toBe('sonnet')
  }
  const p = plan(tieRating, { ...s, ties: 4 }, 'low')
  expect(p.kind === 'delegate' && p.tier).toBe('opus')
  expect(p.kind === 'delegate' && p.tie).toEqual({ by: 'explore', over: 'sonnet' })
  const tierAt = (ties: number) => {
    const q = plan(tieRating, { ...s, ties }, 'low')
    return q.kind === 'delegate' ? q.tier : undefined
  }
  expect(tierAt(5), 'then the guide again').toBe('sonnet')
  expect(tierAt(9), 'and the tenth call explores').toBe('opus')
  // Outside the band there is no close call to explore.
  const far = plan(tieRating, { ...opusAt(0.7), ties: 4 }, 'low')
  expect(far.kind === 'delegate' && far.tie).toBeUndefined()
})

test('when the guide\'s model is not among the close routes, the stronger one wins', async () => {
  // A lookup guides to Haiku, which does not fit here: Sonnet and Opus are close, Sonnet cheaper.
  const r = { ...tieRating, type: 'lookup' as const }
  const sonnet = delegateCost(r, tieSession, 'sonnet', 'medium')
  const opus = delegateCost(r, tieSession, 'opus', 'medium')
  const s = { ...tieSession, cal: pinned({}, delegateKeys('lookup', 'opus', 'medium'), opus, sonnet * 1.1, CAL_FULL) }
  const p = plan(r, s, 'low')
  expect(p.kind === 'delegate' && p.tier).toBe('opus')
  expect(p.kind === 'delegate' && p.tie).toEqual({ by: 'stronger', over: 'sonnet' })
  const e = plan(r, { ...s, ties: 4 }, 'low')
  expect(e.kind === 'delegate' && e.tier, 'exploring takes the other close route').toBe('sonnet')
  expect(e.kind === 'delegate' && e.tie).toEqual({ by: 'explore', over: 'opus' })
})

test('a close route that misses the hand-off share is not a candidate, and the tie never overrides it', async () => {
  const s = opusAt(0.9)
  const p = plan(tieRating, s, 'low')
  expect(p.kind === 'delegate' && p.tie?.by).toBe('guide')
  // Squeeze the share so only the cheaper Opus route (not Sonnet, 11% dearer) is under it.
  const opusCost = delegateCost(tieRating, s, 'opus', 'medium')
  const sonnetCost = delegateCost(tieRating, s, 'sonnet', 'medium')
  const alt = p.kind === 'delegate' ? p.mainCost : 0
  const handOff = ((opusCost + sonnetCost) / 2) / alt
  const q = plan(tieRating, { ...s, rules: { ...DEFAULT_RULES, handOff } }, 'low')
  expect(q.kind === 'delegate' && q.tier, 'the only route under the share').toBe('opus')
  expect(q.kind === 'delegate' && q.tie).toBeUndefined()
  // Nothing under the share: no hand-off, close or not.
  expect(plan(tieRating, { ...s, rules: { ...DEFAULT_RULES, handOff: 0.01 } }, 'low').kind).not.toBe('delegate')
})

test('a close call among stronger models goes to the guide\'s model too, when the session\'s would struggle', async () => {
  // A design on Sonnet that Sonnet cannot do: Opus and Fable fit; Fable is a touch cheaper.
  const r = rating({ type: 'design', level: 'high', fit: { sonnet: null, opus: 'high', fable: 'medium' }, read: 40_000, write: 2000, steps: 12 })
  const s: Situation = { tier: 'sonnet', level: 'medium', context: 60_000, prices: DEFAULT_PRICES, cal: {} }
  const opus = delegateCost(r, s, 'opus', 'high')
  const fableRaw = delegateCost(r, s, 'fable', 'medium')
  const tied = { ...s, cal: pinned({}, delegateKeys('design', 'fable', 'medium'), fableRaw, opus * 0.9, CAL_FULL) }
  const p = plan(r, tied, 'low')
  expect(p.kind === 'delegate' && p.dir).toBe('up')
  expect(p.kind === 'delegate' && p.tier, 'design: Opus').toBe('opus')
  expect(p.kind === 'delegate' && p.tie).toEqual({ by: 'guide', over: 'fable' })
  const far = plan(r, { ...s, cal: pinned({}, delegateKeys('design', 'fable', 'medium'), fableRaw, opus * 0.5, CAL_FULL) }, 'low')
  expect(far.kind === 'delegate' && far.tier, 'outside the band: the cheapest').toBe('fable')
})

test("sizing Claude's own subagent breaks a close call the same way", async () => {
  const r = rating({ type: 'feature', fit: { sonnet: 'medium', opus: 'medium', fable: 'medium' }, read: 40_000, write: 2000, steps: 12 })
  const s = { ...tieSession, tier: 'fable' as const }
  const sonnet = subWork(r, s, 'sonnet', 'medium') * 1.3
  const opus = subWork(r, s, 'opus', 'medium') * 1.3
  const at = (x: number, extra: Partial<Situation> = {}) => ({ ...s, ...extra, cal: pinned({}, ['feature:subagent', 'feature:subagent:opus', 'feature:subagent:opus:medium'], opus / 1.3, (sonnet * x) / 1.3, CAL_FULL) })
  const close = sizeSubagent(r, at(0.9), 'fable', 'low')
  expect(close?.tier, 'feature: Sonnet').toBe('sonnet')
  expect(close?.tie).toEqual({ by: 'guide', over: 'opus' })
  const explore = sizeSubagent(r, at(0.9, { ties: 4 }), 'fable', 'low')
  expect(explore?.tier).toBe('opus')
  expect(explore?.tie).toEqual({ by: 'explore', over: 'sonnet' })
  const far = sizeSubagent(r, at(0.7), 'fable', 'low')
  expect(far?.tier, 'outside the band: the cheapest').toBe('opus')
  expect(far?.tie).toBeUndefined()
  expect('n' in (close ?? {}), 'no internal fields leak').toBe(false)
  // The hand-off share still decides first: a close route above it is not a candidate.
  const strict = sizeSubagent(r, at(0.9, { rules: { ...DEFAULT_RULES, handOff: 0.01 } }), 'fable', 'low')
  expect(strict).toBeUndefined()
})

// The rater's record (Situation.misses, from misses.ts): where it has been wrong too often, rightsize stops betting on it.

test('a model the rater is wrong about for this task type gets no hand-down, at MISS_BLOCK and over', async () => {
  const r = rating({ level: 'low', fit: { haiku: 'low', sonnet: 'low', fable: 'low' }, type: 'search', read: 150_000, write: 3000, steps: 30 })
  expect(MISS_BLOCK).toBe(0.3)
  const open = plan(r, fable, 'low')
  expect(open.kind === 'delegate' && open.tier, 'the cheapest fit').toBe('haiku')
  const under = plan(r, { ...fable, misses: { 'search:haiku': 0.29 } }, 'low')
  expect(under.kind === 'delegate' && under.tier, 'under the bar: still Haiku').toBe('haiku')
  const paused = plan(r, { ...fable, misses: { 'search:haiku': MISS_BLOCK } }, 'low')
  expect(paused.kind === 'delegate' && paused.tier, 'Haiku skipped: the next cheapest fit').toBe('sonnet')
  const other = plan(r, { ...fable, misses: { 'debug:haiku': 0.9 } }, 'low')
  expect(other.kind === 'delegate' && other.tier, 'another task type is not affected').toBe('haiku')
  const both = plan(r, { ...fable, misses: { 'search:haiku': 0.5, 'search:sonnet': 0.5 } }, 'low')
  expect(both.kind, 'every cheaper model paused: no hand-down').not.toBe('delegate')
})

test('a hand-up is never paused by the record of the stronger model', async () => {
  const r = rating({ level: 'high', fit: { sonnet: null, opus: 'high', fable: 'medium' }, type: 'debug', read: 30_000, write: 4000, steps: 12 })
  const s = { ...opus, tier: 'sonnet' as const, level: 'high' as const }
  const p = plan(r, { ...s, misses: { 'debug:opus': 0.9, 'debug:fable': 0.9 } }, 'low')
  expect(p.kind === 'delegate' && p.dir).toBe('up')
})

test('effort is not lowered on a model the rater is wrong about for this task type', async () => {
  const r = rating({ level: 'low', type: 'lookup', write: 1500 })
  const s = { ...opus, cal: freeSwitches }
  expect(effortPlan(r, s, 'low').kind, 'lowers without a record').toBe('effort')
  expect(effortPlan(r, { ...s, misses: { 'lookup:opus': 0.29 } }, 'low').kind).toBe('effort')
  const p = effortPlan(r, { ...s, misses: { 'lookup:opus': MISS_BLOCK } }, 'low')
  expect(p.kind).toBe('none')
  if (p.kind === 'none') expect(p.why).toContain('paused')
  expect(effortPlan(r, { ...s, misses: { 'lookup:haiku': 0.9 } }, 'low').kind, 'another model: not affected').toBe('effort')
  expect(effortPlan(rating({ level: 'xhigh' }), { ...s, misses: { 'other:opus': 0.9 } }, 'low'), 'a raise is never paused').toEqual({ kind: 'effort', dir: 'raise', level: 'xhigh' })
})

// Settings that limit what rightsize does (Highest effort, Use Haiku and Use Fable, Pause after misses,
// Explore close calls) ride on the Situation; each changes one decision and leaves the rest alone.

test('Highest effort stops a raise at the ceiling, and never lowers what you are on', async () => {
  const need = rating({ level: 'xhigh' })
  expect(effortPlan(need, opus, 'low'), 'no ceiling: raises to what the work needs').toEqual({ kind: 'effort', dir: 'raise', level: 'xhigh' })
  expect(effortPlan(need, { ...opus, ceiling: 'max' }, 'low')).toEqual({ kind: 'effort', dir: 'raise', level: 'xhigh' })
  expect(effortPlan(need, { ...opus, ceiling: 'high' }, 'low'), 'capped at high').toEqual({ kind: 'effort', dir: 'raise', level: 'high' })
  expect(effortPlan(need, { ...opus, ceiling: 'xhigh' }, 'low'), 'the ceiling itself is allowed').toEqual({ kind: 'effort', dir: 'raise', level: 'xhigh' })
  // On high already, with a ceiling of high: nothing to raise to.
  expect(effortPlan(need, { ...opus, level: 'high', ceiling: 'high' }, 'low').kind).toBe('none')
  // A level in use above the ceiling is left alone: the ceiling stops raises, it does not lower.
  const onMax = { ...opus, level: 'max' as const, ceiling: 'high' as const }
  expect(effortPlan(rating({ level: 'max' }), onMax, 'low').kind, 'needs max, on max: stays').toBe('none')
  // Lowering is not a raise: the ceiling does not touch it, whatever level is in use.
  const lowering = effortPlan(rating({ level: 'low', write: 1500 }), { ...opus, cal: freeSwitches, ceiling: 'high' }, 'low')
  expect(lowering).toMatchObject({ kind: 'effort', dir: 'lower', level: 'low' })
  expect(effortPlan(rating({ level: 'low', write: 1500 }), { ...onMax, cal: freeSwitches }, 'low'), 'on max, over the ceiling: lowers as usual').toMatchObject({ kind: 'effort', dir: 'lower', level: 'low' })
})

test('Highest effort caps the level a hand-off subagent and Claude\'s own subagents run at', async () => {
  // Haiku needs max for this: a hand-down from Fable still pays, and the level is the ceiling at most.
  const r = rating({ level: 'max', fit: { haiku: 'max', sonnet: null, opus: null, fable: 'low' }, type: 'search', read: 150_000, write: 3000, steps: 30 })
  const open = plan(r, fable, 'low')
  expect(open.kind === 'delegate' && [open.tier, open.level], 'no ceiling').toEqual(['haiku', 'max'])
  const capped = plan(r, { ...fable, ceiling: 'xhigh' }, 'low')
  expect(capped.kind === 'delegate' && [capped.tier, capped.level], 'the same hand-down, at xhigh').toEqual(['haiku', 'xhigh'])
  expect(capped.kind === 'delegate' && capped.delegateCost, 'priced at the level it runs at').toBe(delegateCost(r, fable, 'haiku', 'xhigh'))
  const listing = rating({ type: 'search', fit: { haiku: 'max', sonnet: 'max', opus: 'low', fable: 'low' }, read: 8000, write: 500, steps: 5 })
  expect(sizeSubagent(listing, opus, 'opus', 'low')?.level, 'no ceiling').toBe('max')
  expect(sizeSubagent(listing, { ...opus, ceiling: 'high' }, 'opus', 'low')?.level, 'capped').toBe('high')
})

test('Use Haiku and Use Fable off: no hand-off or resized subagent goes to that model', async () => {
  const r = rating({ level: 'low', fit: { haiku: 'low', sonnet: 'low', fable: 'low' }, type: 'search', read: 150_000, write: 3000, steps: 30 })
  expect(plan(r, fable, 'low').kind === 'delegate' && (plan(r, fable, 'low') as { tier: string }).tier, 'Haiku is the cheapest fit').toBe('haiku')
  const noHaiku = plan(r, { ...fable, without: ['haiku'] }, 'low')
  expect(noHaiku.kind === 'delegate' && noHaiku.tier, 'the next cheapest fit').toBe('sonnet')
  expect(plan(r, { ...fable, without: ['haiku', 'sonnet'] }, 'low').kind, 'nothing cheaper may be used').not.toBe('delegate')
  // Going up: Fable is excluded, so the stronger model is Opus.
  const hard = rating({ level: 'high', fit: { sonnet: null, opus: 'high', fable: 'medium' }, type: 'debug', read: 30_000, write: 4000, steps: 12 })
  const s = { ...opus, tier: 'sonnet' as const, level: 'high' as const }
  const up = plan(hard, { ...s, without: ['opus'] }, 'low')
  expect(up.kind === 'delegate' && [up.dir, up.tier], 'Opus excluded in this check: Fable').toEqual(['up', 'fable'])
  const noFable = plan(hard, { ...s, without: ['fable'] }, 'low')
  expect(noFable.kind === 'delegate' && [noFable.dir, noFable.tier]).toEqual(['up', 'opus'])
  const none = plan(hard, { ...s, without: ['opus', 'fable'] }, 'low')
  expect(none.kind, 'no stronger model allowed: no hand-up').not.toBe('delegate')
  // Claude's own subagents.
  const listing = rating({ type: 'search', fit: { haiku: 'low', sonnet: 'low', opus: 'low', fable: 'low' }, read: 8000, write: 500, steps: 5 })
  expect(sizeSubagent(listing, opus, 'opus', 'low')?.tier).toBe('haiku')
  expect(sizeSubagent(listing, { ...opus, without: ['haiku'] }, 'opus', 'low')?.tier, 'Sonnet instead').toBe('sonnet')
  expect(sizeSubagent(listing, { ...opus, without: ['haiku', 'sonnet'] }, 'opus', 'low'), 'none left').toBeUndefined()
  // An empty list changes nothing.
  expect(plan(r, { ...fable, without: [] }, 'low')).toEqual(plan(r, fable, 'low'))
})

test('Pause after misses: the share sets the line, and off never pauses', async () => {
  const r = rating({ level: 'low', fit: { haiku: 'low', sonnet: 'low', fable: 'low' }, type: 'search', read: 150_000, write: 3000, steps: 30 })
  const wrong = { 'search:haiku': 0.25 }
  const tier = (s: Situation) => {
    const p = plan(r, s, 'low')
    return p.kind === 'delegate' ? p.tier : p.kind
  }
  expect(tier({ ...fable, misses: wrong }), 'the default line is 30%').toBe('haiku')
  expect(tier({ ...fable, misses: wrong, missBlock: 0.2 }), 'a stricter line pauses it').toBe('sonnet')
  expect(tier({ ...fable, misses: wrong, missBlock: 0.25 }), 'at the line').toBe('sonnet')
  expect(tier({ ...fable, misses: { 'search:haiku': 0.9 }, missBlock: 0.5 })).toBe('sonnet')
  expect(tier({ ...fable, misses: { 'search:haiku': 0.9 }, missBlock: null }), 'off: even 90% wrong does not pause').toBe('haiku')
  expect(tier({ ...fable, misses: { 'search:haiku': 0.45 }, missBlock: 0.5 }), 'under a looser line').toBe('haiku')
  const lower = rating({ level: 'low', type: 'lookup', write: 1500 })
  const s = { ...opus, cal: freeSwitches, misses: { 'lookup:opus': 0.4 } }
  expect(effortPlan(lower, s, 'low').kind, 'default line: paused').toBe('none')
  expect(effortPlan(lower, { ...s, missBlock: 0.5 }, 'low').kind, 'a looser line').toBe('effort')
  expect(effortPlan(lower, { ...s, missBlock: null }, 'low').kind, 'off').toBe('effort')
  expect(effortPlan(lower, { ...s, missBlock: 0.2 }, 'low').kind, 'a stricter line').toBe('none')
})

test('Explore close calls off: a close call always takes the guide\'s pick', async () => {
  const s = opusAt(0.9)
  const exploring = plan(tieRating, { ...s, ties: 4 }, 'low')
  expect(exploring.kind === 'delegate' && exploring.tie).toEqual({ by: 'explore', over: 'sonnet' })
  for (const ties of [0, 4, 9]) {
    const p = plan(tieRating, { ...s, ties, explore: false }, 'low')
    expect(p.kind === 'delegate' && [p.tier, p.tie], `close call ${ties + 1}`).toEqual(['sonnet', { by: 'guide', over: 'opus' }])
  }
  expect(plan(tieRating, { ...s, ties: 4, explore: true }, 'low'), 'on is the same as absent').toEqual(exploring)
  // Claude's own subagents follow the same switch.
  const sub: Situation = { ...fable, tier: 'fable' }
  const raw = (t: 'sonnet' | 'opus') => subWork(tieRating, sub, t, 'medium')
  const cal = pinned({}, subagentKeys('feature', 'opus', 'medium'), raw('opus'), raw('sonnet') * 0.9, CAL_FULL)
  expect(sizeSubagent(tieRating, { ...sub, cal, ties: 4 }, 'fable', 'low')?.tie?.by).toBe('explore')
  expect(sizeSubagent(tieRating, { ...sub, cal, ties: 4, explore: false }, 'fable', 'low')?.tie?.by).toBe('guide')
})

test('pacing moves only a threshold left at its default', async () => {
  const at = (mode: 'hot' | 'cool' | 'max', set: { handOff?: boolean; lower?: boolean }) => {
    const r = pacedRules(DEFAULT_RULES, { mode }, set)
    return [Math.round(r.handOff * 100), Math.round(r.lower * 100)]
  }
  // Each row: nothing set, the hand-off threshold set, the lowering threshold set, both set.
  expect([at('hot', {}), at('hot', { handOff: true }), at('hot', { lower: true }), at('hot', { handOff: true, lower: true })]).toEqual([[85, 97], [70, 97], [85, 90], [70, 90]])
  expect([at('cool', {}), at('cool', { handOff: true }), at('cool', { lower: true }), at('cool', { handOff: true, lower: true })]).toEqual([[50, 80], [70, 80], [50, 90], [70, 90]])
  expect([at('max', {}), at('max', { handOff: true }), at('max', { lower: true }), at('max', { handOff: true, lower: true })]).toEqual([[95, 100], [70, 100], [95, 90], [70, 90]])
  // A threshold you set below what the pace would move it to stays where you put it, at any pace.
  const mine = { handOff: 0.5, lower: 0.7 }
  for (const mode of ['normal', 'hot', 'cool', 'max'] as const) expect(pacedRules(mine, { mode }, { handOff: true, lower: true }), mode).toEqual(mine)
  // No set given: as before.
  expect(pacedRules(DEFAULT_RULES, { mode: 'hot' })).toEqual(pacedRules(DEFAULT_RULES, { mode: 'hot' }, {}))
})

test('the pace note says what pacing did: nothing to say when it moved nothing, except that a window is nearly used up', async () => {
  const hot = { mode: 'hot' as const, window: 'five_hour' as const, pace: 1.5 }
  const cool = { mode: 'cool' as const, window: 'seven_day' as const, pace: 0.3 }
  const max = { mode: 'max' as const, window: 'five_hour' as const, used: 93 }
  expect(paceNote(hot)).toBe('The 5-hour window is on pace to run out before it resets, so rightsize saves harder.')
  expect(paceNote(cool)).toBe('Much of the 7-day window will go unused, so rightsize puts quality first.')
  expect(paceNote(max)).toBe('93% of the 5-hour window is used, so rightsize saves all it can.')
  expect(paceNote(hot, false), 'nothing moved').toBe('')
  expect(paceNote(cool, false), 'nothing moved').toBe('')
  expect(paceNote(max, false), 'only reported').toBe('93% of the 5-hour window is used.')
  expect(paceNote({ mode: 'normal' }, true)).toBe('')
})
