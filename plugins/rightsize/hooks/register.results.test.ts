import { expect, test } from 'claude-code/testing'
import { engine, drive } from './testkit'

// A change you make in /config is logged (ADR 0054), and /rightsize report measures it against the days before.

const CHANGES = '/home/test/.claude/mods-logs/rightsize/changes.jsonl'
const logged = (h: ReturnType<typeof engine>) => (h.files[CHANGES] ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l) as { key: string; from: string; to: string })

for (const surface of ['desktop', 'terminal'] as const) {
  test(`results: a behavior change by the person is logged and the report lists it (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    await d.config('pacing', 'off')
    expect(logged(h)).toEqual([{ at: expect.any(String), key: 'pacing', from: 'on', to: 'off' }])
    await d.step('t0')
    const text = await d.report()
    expect(text).toContain('DID IT WORK?')
    expect(text).toContain('Budget pacing: on to off')
    expect(text).toContain('Too early to tell')
  })

  test(`results: another plugin's change, a cosmetic row and a same-value set are not logged (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    await d.config('cache', 'off', 'plugin')
    await d.config('band', 'always')
    await d.config('routing', 'on')
    expect(logged(h)).toEqual([])
    await d.step('t0')
    expect(await d.report()).not.toContain('DID IT WORK?')
  })
}
