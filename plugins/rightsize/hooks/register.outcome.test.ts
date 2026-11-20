import { expect, test } from 'claude-code/testing'
import { CAL_STORE } from './cost'
import { parseRating, ratingSystem } from './rate'
import { type RunLine, type WholeTask, outcomeRows, taskOutcome, taskRoute } from './report'
import { FREE_SWITCHES, LOG_PATH, LOOKUP, RUNS_FILE, drive, engine, last } from './testkit'

// Outcome per task and a rater that can say "not sure" (P-30, ADR 0071).

const at = (min: number) => new Date(Date.UTC(2026, 10, 14, 18, min)).toISOString()
const run = (id: string, over: Partial<RunLine> = {}): RunLine => ({ at: at(0), id, task: 'T', type: 'lookup', tier: 'opus', change: 'none', ...over })

test('a task\'s outcome: the person\'s signals first (undone, corrected, 👎), then its last test run, then a 👍; else unknown', () => {
  const two = [run('a', { tests: 'failed', at: at(1) }), run('b', { tests: 'passed', at: at(2) })]
  expect(taskOutcome(two, 'T'), 'the last test run counts').toBe('tests passed')
  expect(taskOutcome([run('a', { tests: 'passed', at: at(1) }), run('b', { tests: 'failed', at: at(2) })], 'T')).toBe('tests failed')
  expect(taskOutcome([...two, { at: at(3), kind: 'feedback', ref: 'a', value: 'down' }], 'T'), 'a 👎 beats a passing test').toBe('down')
  expect(taskOutcome([...two, { at: at(3), kind: 'corrected', ref: 'b' }], 'T')).toBe('corrected')
  expect(taskOutcome([...two, { at: at(3), kind: 'corrected', ref: 'b' }, { at: at(4), kind: 'undone', ref: 'a', undone: 'lower' }], 'T')).toBe('undone')
  expect(taskOutcome([run('a'), { at: at(3), kind: 'feedback', ref: 'a', value: 'up' }], 'T')).toBe('up')
  expect(taskOutcome([run('a'), { at: at(3), kind: 'corrected', ref: 'other-task-run' }], 'T'), 'a signal about another task\'s run').toBe('unknown')
})

test('a task\'s route is its strongest change: raised (more effort, a stronger model, or a mid-turn raise), lowered, handed off, unchanged', () => {
  expect(taskRoute([run('a', { change: 'lower' }), run('b', { change: 'raise' })], 'T')).toBe('raised')
  expect(taskRoute([run('a', { change: 'lower', escalations: [{ step: 3, from: 'low', to: 'medium', why: 'x' }] })], 'T')).toBe('raised')
  expect(taskRoute([run('a', { change: 'switch-up' })], 'T')).toBe('raised')
  expect(taskRoute([run('a', { change: 'lower' }), run('b', { change: 'delegate-down' })], 'T')).toBe('lowered')
  expect(taskRoute([run('a', { change: 'delegate-down' })], 'T')).toBe('handed off')
  expect(taskRoute([run('a'), run('b', { change: 'lower', aborted: true })], 'T'), 'a stopped turn does not count').toBe('unchanged')
})

test('Whole tasks: outcomes counted with unknown shown as unknown, and clean tasks per route with their median cost', () => {
  const t = (route: WholeTask['route'], outcome: WholeTask['outcome'], actual: number): WholeTask => ({ task: `${route}${outcome}${actual}`, type: 'lookup', estimated: 1, stay: 1, actual, outcome, route })
  const tasks = [t('unchanged', 'tests passed', 0.4), t('unchanged', 'unknown', 9), t('unchanged', 'up', 0.6), t('lowered', 'tests passed', 0.2), t('lowered', 'corrected', 3), t('lowered', 'unknown', 1), t('raised', 'unknown', 2)]
  expect(outcomeRows(tasks, false)).toEqual([
    ['Outcomes', '3 of 7 tasks clean · tests passed 2 · 👍 1 · corrected 1 · unknown 3'],
    ['Clean by route', 'unchanged: 2 of 3 clean, 1 unknown · $0.50 per clean task (median)'],
    ['', 'lowered: 1 of 3 clean, 1 unknown · $0.20 per clean task (median)'],
    ['', 'raised: 0 of 1 clean, 1 unknown'],
  ])
  expect(outcomeRows(tasks, true)[1]?.[1]).toContain('(median, API-equivalent)')
  expect(outcomeRows([], false)).toEqual([])
})

test('the rater is asked whether it is sure, and "sure": false is read as not sure; anything else is sure', () => {
  expect(ratingSystem('opus', 'medium')).toContain('"sure":<true|false>')
  const base = { fit: { haiku: 'no', sonnet: 'medium', opus: 'low', fable: 'low' }, type: 'debug', read: 1000, write: 500, steps: 4, reason: 'x' }
  expect(parseRating(JSON.stringify({ ...base, sure: false }), 'opus')?.unsure).toBe(true)
  expect(parseRating(JSON.stringify({ ...base, sure: true }), 'opus')?.unsure).toBeUndefined()
  expect(parseRating(JSON.stringify(base), 'opus')?.unsure, 'an older rating with no field').toBeUndefined()
})

const NOT_SURE_LOW = '{"fit":{"haiku":"no","sonnet":"medium","opus":"low","fable":"low"},"type":"lookup","read":2000,"write":3000,"steps":1,"continues":false,"sure":false,"reason":"unclear which config"}'

for (const surface of ['desktop', 'terminal'] as const) {
  // With Try lowering when unsure off (P-83): on, an unsure "lower effort" plan is lowered one level (register.unsure.test.ts).
  test(`a "not sure" rating leaves the prompt alone, logs it, and marks the run line (${surface})`, { timeoutMs: 30000, options: { lowerUnsure: 'off' } }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES }, stored: { lowerUnsure: 'off' } })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = NOT_SURE_LOW
    await d.submit(LOOKUP)
    await d.step('t1', 0)
    expect(last(h.sent)?.effort, 'not lowered').toBe('medium')
    await d.complete('t1')
    expect(h.files[LOG_PATH] ?? '').toContain('rater not sure: prompt left alone (the plan was effort lower)')
    const line = (h.files[RUNS_FILE] ?? '')
      .trim()
      .split('\n')
      .map(l => JSON.parse(l) as RunLine)
      .find(l => (l.kind ?? 'run') === 'run')
    expect(line?.unsure).toBe('rater')
    expect(line?.change).toBe('none')
  })
}
