import { expect, test } from 'claude-code/testing'
import { DEFAULT_PRICES, DEFAULT_RULES, money } from './cost'
import type { RunLine } from './report'
import { START_CHECK_DAYS, START_MIN_PROMPTS, adviseStart, replay, startLines, startOf, startTip } from './start'

const NOW = Date.parse('2026-10-23T18:00:00.000Z')
const at = (i: number) => new Date(NOW - (100 - i) * 60_000).toISOString()
const C = { prices: DEFAULT_PRICES, cal: {}, rules: DEFAULT_RULES, floor: 'low' as const, choices: {} }
type Fit = Record<string, string | null>
const line = (i: number, fit: Fit, x: Partial<RunLine> & Record<string, unknown> = {}): RunLine =>
  ({ at: at(i), kind: 'run', type: 'feature', route: 'main', tier: 'opus', level: 'medium', normal: 'medium', fit, read: 8000, write: 2000, steps: 8, context: 60_000, ...x }) as RunLine
const easy: Fit = { haiku: null, sonnet: 'medium', opus: 'low', fable: 'low' }
const hard: Fit = { haiku: null, sonnet: null, opus: 'high', fable: 'medium' }
const many = (n: number, fit: Fit, x: Partial<RunLine> & Record<string, unknown> = {}) => Array.from({ length: n }, (_, i) => line(i, fit, x))

test('replays a prompt from any start and counts hand-ups to a stronger model', async () => {
  const lines = [line(0, easy), line(1, hard)]
  const sonnet = replay(lines, { tier: 'sonnet', level: 'medium' }, C)
  expect(sonnet.prompts).toBe(2)
  expect(sonnet.up, 'Sonnet cannot do the hard one: it goes to Opus').toBe(1)
  expect(replay(lines, { tier: 'opus', level: 'high' }, C).up).toBe(0)
  expect(replay(lines, { tier: 'opus', level: 'medium' }, C).measured, 'two main-chat runs on Opus at medium').toBe(2)
  const kept = replay(lines, { tier: 'sonnet', level: 'medium' }, { ...C, choices: { up: 'stay' } })
  expect(kept.up, '"Stay" keeps work on the start').toBe(0)
})

test('waits for enough prompts, and for enough on the current start', async () => {
  expect(adviseStart(many(START_MIN_PROMPTS - 1, easy), C, NOW)).toMatchObject({ kind: 'wait', need: 50, prompts: 49 })
  const moved = [...many(45, easy), ...many(10, easy, { tier: 'sonnet', normal: 'high', level: 'high' }).map((l, i) => ({ ...l, at: at(60 + i) }))]
  expect(adviseStart(moved, C, NOW), 'only 10 since the switch').toMatchObject({ kind: 'wait', need: 20, prompts: 10, current: { tier: 'sonnet', level: 'high' } })
  const old = many(60, easy).map(l => ({ ...l, at: new Date(NOW - 40 * 24 * 60 * 60_000).toISOString() }))
  expect(adviseStart(old, C, NOW).kind, 'older than 30 days').toBe('wait')
})

test('suggests a cheaper start when Sonnet can do the work, with the unmeasured margin', async () => {
  const a = adviseStart(many(60, easy), C, NOW)
  expect(a.kind).toBe('switch')
  if (a.kind !== 'switch') return
  expect(a.why).toBe('cost')
  expect(a.to.tier).toBe('sonnet')
  expect(a.saving, 'over the 25% margin for a start with no measured runs').toBeGreaterThan(0.25)
  expect(startTip(a, false)).toMatch(/^Starting on Sonnet at (medium|high) would have cost ~\d+% less than Opus at medium on your last 60 rated prompts\. Switch with \/model\.$/)
  expect(startTip(a, true)).toContain('used ~')
})

test('keeps a start whose work too often needs a stronger model', async () => {
  // A third of the prompts need Opus: a Sonnet start would hand up 33%, over the 10% limit.
  const lines = Array.from({ length: 60 }, (_, i) => line(i, i % 3 === 0 ? hard : easy))
  const a = adviseStart(lines, C, NOW)
  expect(a.kind === 'switch' ? a.to.tier : 'opus', 'never a start that hands up over 10%').not.toBe('sonnet')
})

test('suggests a stronger start when the current one keeps handing up or getting stuck', async () => {
  const lines = Array.from({ length: 60 }, (_, i) =>
    line(i, i % 4 === 0 ? hard : easy, { tier: 'sonnet', level: 'medium', normal: 'medium', ...(i % 4 === 0 ? { route: 'delegate:opus' } : {}) }),
  )
  const a = adviseStart(lines, C, NOW)
  expect(a).toMatchObject({ kind: 'switch', why: 'quality', current: { tier: 'sonnet', level: 'medium' }, to: { tier: 'opus' } })
  if (a.kind === 'switch') expect(startTip(a, false)).toMatch(/^25% of your last 60 rated prompts needed a stronger model or more effort than Sonnet at medium\. Starting on Opus at (medium|high) would need fewer hand-offs\./)
})

test('reads the start off a line: normal first, else the level it ran at', async () => {
  expect(startOf({ at: at(0), tier: 'opus', level: 'low', normal: 'medium' } as RunLine)).toEqual({ tier: 'opus', level: 'medium' })
  expect(startOf({ at: at(0), tier: 'opus', level: 'high' })).toEqual({ tier: 'opus', level: 'high' })
  expect(startOf({ at: at(0), tier: 'gpt' })).toBeUndefined()
})

test('the report block: each start per 100 prompts, or a share of yours on a subscription', async () => {
  const a = adviseStart(many(60, easy), C, NOW)
  const api = startLines(a, false, money)
  expect(api[0]).toBe('Starting point (last 30 days, 60 rated prompts): Opus at medium.')
  expect(api[1]).toMatch(/Opus at medium \(yours\) ~\$[\d.]+ per 100 prompts/)
  expect(api[2]).toMatch(/^ {2}Suggestion: Starting on Sonnet/)
  expect(startLines(a, true, money)[1]).toContain('Opus at medium (yours) 100% of yours')
  expect(startLines(adviseStart([], C, NOW), false, money)).toEqual(['Starting point: needs 50 rated prompts to compare starts (has 0).'])
})

test('a miss rate on the start model raises its cost and hand-ups in proportion', async () => {
  const lines = many(10, easy)
  const start = { tier: 'sonnet' as const, level: 'medium' as const }
  const base = replay(lines, start, C)
  expect(base.up, 'rated as it is, Sonnet does it all').toBe(0)
  const rate = { 'feature:sonnet': { n: 10, misses: 3 } }
  const m = replay(lines, start, { ...C, misses: rate })
  // Wrong 3 times in 10: that share is replayed as if Sonnet had been rated unable, so it goes to Opus.
  const wrong = replay(many(10, { ...easy, sonnet: null }), start, C)
  expect(wrong.up).toBe(10)
  expect(Math.abs(m.cost - (0.7 * base.cost + 0.3 * wrong.cost)) < 1e-9, 'a blend of the two costs').toBe(true)
  expect(m.cost).toBeGreaterThan(base.cost)
  expect(Math.abs(m.up - 3) < 1e-9, '3 of 10 prompts handed up').toBe(true)
  expect(replay(lines, { tier: 'opus', level: 'medium' }, { ...C, misses: rate }).cost, "Sonnet's record does not touch an Opus start").toBe(replay(lines, { tier: 'opus', level: 'medium' }, C).cost)
  const thin = replay(lines, start, { ...C, misses: { 'feature:sonnet': { n: 4, misses: 4 } } })
  expect(thin.cost, 'under 5 outcomes: not used').toBe(base.cost)
  const across = replay(lines, start, { ...C, misses: { 'debug:sonnet': { n: 10, misses: 10 } } })
  expect(across.up, "no record for this type: Sonnet's across types is used").toBe(10)
  const unable = replay(many(4, { ...easy, sonnet: null }), start, { ...C, misses: { 'feature:sonnet': { n: 10, misses: 10 } } })
  expect(unable.up, 'where the rater already said Sonnet would struggle, nothing more to blend').toBe(4)
})

test("the advice reads the rater's record off the log: a Sonnet start is no longer cheaper when checks say Sonnet would struggle", async () => {
  const lines = many(60, easy)
  expect(adviseStart(lines, C, NOW), 'without a record').toMatchObject({ kind: 'switch', to: { tier: 'sonnet' } })
  const checks = Array.from({ length: 20 }, (_, i) => ({ at: at(i), kind: 'check', type: 'feature', fit: easy, check: { by: 'sonnet', fit: { ...easy, sonnet: null } } }) as RunLine)
  const a = adviseStart([...lines, ...checks], C, NOW)
  expect(a.kind === 'switch' ? a.to.tier : 'opus', 'Sonnet wrong on every check: too many hand-ups').not.toBe('sonnet')
  expect(a.kind === 'switch' ? a.replays[0]?.prompts : 60, 'check lines are not prompts').toBe(60)
  expect(adviseStart([...lines, ...checks], { ...C, misses: {} }, NOW), 'a given record replaces the log\'s').toMatchObject({ kind: 'switch', to: { tier: 'sonnet' } })
})

test('suggestions come every 7 days, or every 30 on monthly', async () => {
  expect(START_CHECK_DAYS).toEqual({ weekly: 7, monthly: 30 })
})

test('the replay follows Use Haiku, Use Fable and Highest effort: the limits rightsize works under live', async () => {
  // Haiku can do the work at low: a Sonnet start hands it down to Haiku unless Haiku is out.
  const cheap: Fit = { haiku: 'low', sonnet: 'low', opus: 'low', fable: 'low' }
  const lines = many(20, cheap, { type: 'search', read: 150_000, write: 3000, steps: 30 })
  const start = { tier: 'opus' as const, level: 'medium' as const }
  const open = replay(lines, start, C)
  const noHaiku = replay(lines, start, { ...C, without: ['haiku'] })
  expect(noHaiku.cost, 'Sonnet instead of Haiku costs more').toBeGreaterThan(open.cost)
  expect(replay(lines, start, { ...C, without: [] }).cost, 'an empty list changes nothing').toBe(open.cost)
  // The work needs xhigh on Opus at medium: raised, or capped by the ceiling.
  const deep: Fit = { haiku: null, sonnet: null, opus: 'xhigh', fable: 'xhigh' }
  const rich = many(20, deep, { read: 8000, write: 2000, steps: 8 })
  const free = { ...C, cal: { 'cache:effort-switch': { n: 20, ratio: 0 } } }
  const raised = replay(rich, start, free)
  const capped = replay(rich, start, { ...free, ceiling: 'high' })
  expect(capped.cost, 'a lower ceiling costs less: it raises less').toBeLessThan(raised.cost)
})

test('the advice ignores prompts from before Cost measurement restarted', async () => {
  const lines = many(60, easy)
  expect(adviseStart(lines, C, NOW).kind, 'all of them count').toBe('switch')
  const from = NOW - 30 * 60_000
  // The lines are a minute apart, the newest 41 minutes before NOW: all older than `from`.
  const after = adviseStart(lines, { ...C, from }, NOW)
  expect(after.kind).toBe('wait')
  if (after.kind === 'wait') expect(after.prompts, 'only the lines since then').toBe(0)
  expect(adviseStart(lines, { ...C, from: NOW + 1 }, NOW), 'nothing since').toMatchObject({ kind: 'wait', prompts: 0 })
  expect(adviseStart(lines, { ...C, from: 0 }, NOW).kind, 'never restarted').toBe('switch')
})
