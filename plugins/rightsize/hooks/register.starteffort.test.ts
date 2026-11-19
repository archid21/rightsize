import { expect, test } from 'claude-code/testing'
import { CAL_STORE } from './cost'
import { RUNS_FILE, LOOKUP, LOWER, FREE_SWITCHES, engine, drive, last, mount, bandText, setBand } from './testkit'

// The engine gives a hook no read of the person's effort at prompt time, so the first prompt of a session is planned from what
// rightsize saved or the default. When that start is stale, the first step shows the real effort: if the plan's level is what
// the request goes out at anyway, nothing changed, and the band, the run line and the saving must say so.

const runLines = (h: ReturnType<typeof engine>) => (h.files[RUNS_FILE] ?? '').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>)

for (const surface of ['desktop', 'terminal'] as const) {
  test(`first prompt on a session already at low, with a stale saved medium: no "lowered", no saving, no Retry (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'low', store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    await d.start(surface)
    // Left over from an earlier session.
    await ($ as unknown as { config: { set: (x: unknown) => Promise<unknown> } }).config.set({ key: 'rightsize.seenEffort', value: 'medium' })
    await setBand($, 'always')
    h.rating = LOWER
    await d.submit(LOOKUP)
    await d.step('t1', 0)
    expect(last(h.sent)?.effort, 'goes out at low').toBe('low')
    const text = await bandText($, surface)
    expect(text, 'no lowering was made').not.toMatch(/lowered|medium → low/)
    expect(text).toMatch(/^No change: low on Opus/)
    const ui = await mount($, surface)
    expect((await ui.findAll({ type: 'Button' })).map(b => b.key), 'nothing to retry').not.toContain('retry')
    await ui.unmount()
    await d.complete('t1')
    const run = runLines(h).find(l => l.kind === 'run')
    expect(run?.normal, 'the real level').toBe('low')
    expect(run?.change, 'no change taken').toBe('none')
    expect(run?.auto).toBe(false)
    expect((await d.command('retry')).text ?? '', 'no retry offered').toContain('Nothing to retry')
  })

  test(`a real lowering still says medium → low, with Retry (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    await d.start(surface)
    await ($ as unknown as { config: { set: (x: unknown) => Promise<unknown> } }).config.set({ key: 'rightsize.seenEffort', value: 'medium' })
    await setBand($, 'always')
    h.rating = LOWER
    await d.submit(LOOKUP)
    await d.step('t1', 0)
    expect(last(h.sent)?.effort).toBe('low')
    expect(await bandText($, surface)).toMatch(/^Effort lowered: medium → low for this prompt \(automatically\)/)
    const ui = await mount($, surface)
    expect((await ui.findAll({ type: 'Button' })).map(b => b.key)).toContain('retry')
    await ui.unmount()
    await d.complete('t1')
    expect(runLines(h).find(l => l.kind === 'run')?.change).toBe('lower')
  })

  test(`a stale saved medium on a session really at high: the band says high → low, Retry goes back to high (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'high', store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    await d.start(surface)
    await ($ as unknown as { config: { set: (x: unknown) => Promise<unknown> } }).config.set({ key: 'rightsize.seenEffort', value: 'medium' })
    h.rating = LOWER
    await d.submit(LOOKUP)
    await d.step('t1', 0)
    expect(last(h.sent)?.effort).toBe('low')
    expect(await bandText($, surface)).toMatch(/^Effort lowered: high → low for this prompt \(automatically\)/)
    const ui = await mount($, surface)
    expect((await ui.findAll({ type: 'Button' })).map(b => b.key)).toContain('retry')
    await ui.unmount()
    await d.complete('t1')
    const run = runLines(h).find(l => l.kind === 'run')
    expect(run?.normal).toBe('high')
    expect(run?.change).toBe('lower')
    const undo = await d.command('retry')
    expect(undo.text ?? '').toContain('run it at high')
  })
}
