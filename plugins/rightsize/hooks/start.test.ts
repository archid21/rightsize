import { expect, test } from 'claude-code/testing'
import { DEFAULT_PRICES, DEFAULT_RULES, money } from './cost'
import type { RunLine } from './report'
import { START_MIN_PROMPTS, adviseStart, replay, startLines, startOf, startTip } from './start'

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
