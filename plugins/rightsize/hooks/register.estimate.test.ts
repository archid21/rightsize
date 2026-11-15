import { expect, test } from 'claude-code/testing'
import { CAL_WINDOW, REESTIMATE_AFTER, learn, parseCalibration, rebaseCal, reestimate } from './cost'
import type { RunLine } from './report'
import { LOG_PATH, LOOKUP, REVIEW, RUNS_FILE, drive, engine } from './testkit'

// Estimate accuracy (P-44, ADR 0074): calibration learns the dollar-weighted ratio of actual to estimated cost, not the mean of
// per-turn ratios, and a turn's cost is projected again from its own pace after its first requests.

test('calibration learns in dollars: a cheap turn that ran 10x over moves the ratio less than an expensive one', () => {
  // Nine turns on estimate, one cheap turn at 10x: the mean of ratios would be 1.9; the dollars say about 1.1.
  let cal = {}
  for (let i = 0; i < 9; i++) cal = learn(cal, 'k', 1, { actual: 1, estimated: 1 })
  cal = learn(cal, 'k', 10, { actual: 1, estimated: 0.1 })
  const e = (cal as Record<string, { ratio: number }>)['k']
  expect(e?.ratio).toBeGreaterThan(1.05)
  expect(e?.ratio).toBeLessThan(1.15)
  // The same ten as plain samples: the old mean of ratios.
  let old = {}
  for (let i = 0; i < 9; i++) old = learn(old, 'k', 1)
  old = learn(old, 'k', 10)
  expect((old as Record<string, { ratio: number }>)['k']?.ratio).toBe(1.9)
})

test('the dollar averages become moving averages after the window, and the ratio stays between 0.1 and 10', () => {
  let cal = {}
  for (let i = 0; i < CAL_WINDOW * 3; i++) cal = learn(cal, 'k', 0.5, { actual: 0.5, estimated: 1 })
  const e = (cal as Record<string, { ratio: number; n: number }>)['k']
  expect(Math.abs((e?.ratio ?? 0) - 0.5)).toBeLessThan(0.001)
  expect(e?.n).toBe(CAL_WINDOW * 3)
  let big = {}
  big = learn(big, 'k', 10, { actual: 500, estimated: 1 })
  expect((big as Record<string, { ratio: number }>)['k']?.ratio).toBe(10)
})

test('a key learned the old way carries over: its next dollar sample starts from its ratio', () => {
  const stored = parseCalibration({ k: { n: 30, ratio: 2 } })
  expect(stored['k']).toEqual({ n: 30, ratio: 2 })
  const next = learn(stored, 'k', 1, { actual: 1, estimated: 1 })['k']
  expect(next?.ratio, 'one sample barely moves 30 runs of history').toBeGreaterThan(1.9)
  expect(next?.act).toBeDefined()
  expect(parseCalibration({ k: { n: 3, ratio: 1.2, act: 0.6, est: 0.5 } })['k']).toEqual({ n: 3, ratio: 1.2, act: 0.6, est: 0.5 })
  expect(parseCalibration({ k: { n: 3, ratio: 1.2, act: 0.6, est: 0 } })['k'], 'a bad estimate side is dropped').toEqual({ n: 3, ratio: 1.2 })
})

test('a rebase moves the actual side and keeps the estimate side', () => {
  const out = rebaseCal({ k: { n: 5, ratio: 1, act: 2, est: 2 }, old: { n: 5, ratio: 1 } }, 0.5)
  expect(out['k']).toEqual({ n: 5, ratio: 0.5, act: 1, est: 2 })
  expect(out['old']).toEqual({ n: 5, ratio: 0.5 })
})

test('the re-estimate: pace times the rated steps within them, twice the requests past them, never under what was spent', () => {
  expect(reestimate({ spent: 1, requests: 5, steps: 20 }), '$0.20 a request over 20 rated steps').toBe(4)
  expect(reestimate({ spent: 1, requests: 5, steps: 1 }), 'past its rated step: about halfway').toBe(2)
  expect(reestimate({ spent: 1, requests: 5, steps: 5 })).toBe(2)
  expect(reestimate({ spent: 0, requests: 5, steps: 20 })).toBe(0)
})

for (const surface of ['desktop', 'terminal'] as const) {
  test(`after ${REESTIMATE_AFTER} main-chat requests a turn is projected again, logged and kept on its run line (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    h.rating = REVIEW
    await d.submit(LOOKUP)
    for (let i = 0; i < REESTIMATE_AFTER + 2; i++) await d.step('t1', i)
    await d.complete('t1')
    expect(h.files[LOG_PATH] ?? '').toMatch(/re-estimate after 5 requests: \$[\d.]+ spent, about \$[\d.]+ projected \(first estimate \$[\d.]+, 10 steps rated\)/)
    const line = (h.files[RUNS_FILE] ?? '')
      .trim()
      .split('\n')
      .map(l => JSON.parse(l) as RunLine)
      .find(l => (l.kind ?? 'run') === 'run')
    expect(line?.reestimate?.after).toBe(5)
    expect(line?.reestimate?.projected).toBeGreaterThan(line?.reestimate?.spent ?? Infinity)
  })

  test(`a turn shorter than ${REESTIMATE_AFTER} requests has no re-estimate (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    h.rating = REVIEW
    await d.submit(LOOKUP)
    for (let i = 0; i < 3; i++) await d.step('t1', i)
    await d.complete('t1')
    expect(h.files[LOG_PATH] ?? '').not.toContain('re-estimate after')
  })
}
