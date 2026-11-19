import { expect, test } from 'claude-code/testing'
import { CAL_STORE } from './cost'
import { FREE_SWITCHES, LEGACY_RUNS, LOOKUP, RUNS_FILE, bandText, drive, engine, last, LOWER, NO_CHANGE } from './testkit'

// P-77: misses, pauses and probation are kept per model version; a new version starts clean.

const RUNS = LEGACY_RUNS
const NOTE = 'Opus 5.6 is new: past misses from older versions no longer count.'

for (const surface of ['desktop', 'terminal'] as const) {
  const lookupLog = (h: { now: number }, steppedUp: number) =>
    Array.from({ length: 6 }, (_, i) => JSON.stringify({ at: new Date(h.now - (6 - i) * 60_000).toISOString(), kind: 'run', type: 'lookup', route: 'main', tier: 'opus', change: 'lower', steppedUp: i < steppedUp })).join('\n') + '\n'
  const runs = (h: ReturnType<typeof engine>) => (h.files[RUNS_FILE] ?? '').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)

  test(`a run line records the model its route ran on (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    await d.start(surface)
    h.rating = LOWER
    await d.submit(LOOKUP)
    await d.step('t1')
    await d.complete('t1')
    expect(runs(h).find(l => l.kind === 'run')?.model).toBe('claude-opus-5-5')
  })

  // Two wrong lowerings in six pause lookups on Opus (the first is forgiven: 1 of 5 is 20%).
  for (const row of [
    { model: 'claude-opus-5-5', effort: 'medium', why: 'the same version: the old misses pause it' },
    { model: 'claude-opus-5-6', effort: 'low', why: 'a newer version: a clean slate, lowering goes on' },
  ]) {
    test(`old misses and a newer version: ${row.why} (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
      const h = engine(on, { model: row.model, effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES } })
      h.now = Date.now()
      h.files[RUNS] = lookupLog(h, 2)
      const d = drive($, h)
      await d.start(surface)
      h.rating = LOWER
      await d.submit(LOOKUP)
      await d.step('t1')
      expect(last(h.sent)?.effort).toBe(row.effort)
    })
  }

  for (const row of [
    { model: 'claude-opus-5-5', effort: 'medium', why: 'a stored pause on the same version still holds' },
    { model: 'claude-opus-5-6', effort: 'low', why: 'a stored pause from an older version does not apply' },
  ]) {
    test(`${row.why} (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
      const h = engine(on, { model: row.model, effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES, lowerPauses: { 'lookup:opus': { left: 5, version: 'claude-opus-5-5' } } } })
      const d = drive($, h)
      await d.start(surface)
      h.rating = LOWER
      await d.submit(LOOKUP)
      await d.step('t1')
      expect(last(h.sent)?.effort).toBe(row.effort)
    })
  }

  test(`lines with no model count as today's version: the old misses pause it, and a stored pause with no version holds (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES, lowerPauses: { 'lookup:opus': { left: 5 } } } })
    const d = drive($, h)
    await d.start(surface)
    h.rating = LOWER
    await d.submit(LOOKUP)
    await d.step('t1')
    expect(last(h.sent)?.effort).toBe('medium')
  })

  test(`a new version is said once on the band, and remembered (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-6', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    await d.start(surface)
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    await d.step('t1', 0)
    expect(await bandText($, surface)).toContain(NOTE)
    await d.complete('t1')
    await d.submit(LOOKUP)
    await d.step('t2', 0)
    expect(await bandText($, surface), 'not said again').not.toContain(NOTE)
  })

  test(`a model on today's version says nothing (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    await d.start(surface)
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    await d.step('t1', 0)
    expect(await bandText($, surface)).not.toContain('is new')
  })
}
