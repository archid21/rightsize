import { expect, test } from 'claude-code/testing'
import { LEGACY_RUNS, engine, drive } from './testkit'

// The report's Today and Lifetime columns: at session start, run lines older than 30 days are folded into a roll-up kept in
// the plugin's own store, so the Lifetime figure survives the logs being trimmed or pruned. The roll-up holds sums only.

for (const surface of ['desktop', 'terminal'] as const) {
  const DAYS = 24 * 60 * 60 * 1000
  const line = (at: number, saved: number) => JSON.stringify({ at: new Date(at).toISOString(), kind: 'run', session: 'old', change: 'lower', offered: 'lower', actual: 0.1, stay: 0.1 + saved, taken: 0.1, overhead: 0 })
  const lifetime = (h: ReturnType<typeof engine>) => h.store.lifetime as { since: string; through: string; t: { rated: number; saved: number } } | undefined

  test(`lifetime: session start folds runs older than 30 days into the store, and the report keeps them after the log is gone (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const now = h.now
    h.files[LEGACY_RUNS] = [line(now - 40 * DAYS, 0.2), line(now - 35 * DAYS, 0.3), line(now - 2 * DAYS, 0.5)].join('\n') + '\n'
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    expect(lifetime(h)?.t.rated, 'the two old lines are folded; the recent one waits').toBe(2)
    expect(Math.round((lifetime(h)?.t.saved ?? 0) * 1000), 'what the two saved: $0.20 and $0.30').toBe(500)
    expect(Object.keys(lifetime(h) ?? {}).sort(), 'sums only').toEqual(['since', 't', 'through'])
    const before = (await d.command('report')).text ?? ''
    expect(before.replace(/\s+/g, ' '), 'lifetime counts all three, labelled as an estimate').toMatch(/Today Lifetime[\s\S]*Prompts rated \d+ 3/)
    expect(before).toContain('Estimates. Lifetime counts from')
    // The log loses the old lines (trimmed or pruned): the roll-up still holds them.
    h.files[LEGACY_RUNS] = line(now - 2 * DAYS, 0.5) + '\n'
    const after = (await d.command('report')).text ?? ''
    expect(after.replace(/\s+/g, ' ')).toMatch(/Prompts rated \d+ 3/)
  })

  test(`lifetime: a second start folds nothing twice (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    h.files[LEGACY_RUNS] = [line(h.now - 40 * DAYS, 0.2)].join('\n') + '\n'
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    const first = lifetime(h)
    expect(first?.t.rated).toBe(1)
    await d.start(surface)
    await d.step('t1')
    expect(lifetime(h), 'the same line is not folded again').toEqual(first)
  })

  test(`lifetime: a damaged store counts for nothing and does not break the report (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { lifetime: { since: 'never', through: 5, t: 'x' } } })
    h.files[LEGACY_RUNS] = line(h.now - 1 * DAYS, 0.2) + '\n'
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    const text = (await d.command('report')).text ?? ''
    expect(text).toContain('rightsize report')
    expect(text.replace(/\s+/g, ' ')).toMatch(/Prompts rated \d+ 1/)
  })
}
