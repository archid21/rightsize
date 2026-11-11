import { expect, test } from 'claude-code/testing'
import { engine, drive } from './testkit'

// The report reads trim's two savings files (trim ADR 0012), read only: with them it shows a trim section, without them it does not.

for (const surface of ['desktop', 'terminal'] as const) {
  const entry = (ago: number, now: number) => JSON.stringify({ v: 1, ts: new Date(now - ago).toISOString(), session: null, feature: 'tool_cleanup', before: 5400, after: 0, tokens_saved: 2000, assumed: false, full_copy: null })

  test(`trim: the report shows trim's savings from its shared log (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    h.files['/home/test/.claude/trim/savings.jsonl'] = entry(60_000, h.now) + '\n' + entry(2_000, h.now) + '\n'
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    const text = await d.report()
    expect(text).toContain('TRIM SAVINGS')
    expect(text).toMatch(/Tool results cleaned\s+4\.0K\s+4\.0K/)
    expect(Object.keys(h.files).filter(f => f.includes('/trim/')), 'read only: no file added').toEqual(['/home/test/.claude/trim/savings.jsonl'])
  })

  test(`trim: TRIM_HOME moves the folder (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    h.env.TRIM_HOME = '/elsewhere/trim'
    h.files['/elsewhere/trim/savings.jsonl'] = entry(1000, h.now) + '\n'
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    expect(await d.report()).toContain('TRIM SAVINGS')
  })

  test(`trim: no file or a damaged one shows no trim section (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    expect(await d.report()).not.toContain('TRIM SAVINGS')
    h.files['/home/test/.claude/trim/savings.jsonl'] = 'garbage\n'
    h.files['/home/test/.claude/trim/savings-totals.json'] = '{bad'
    const text = await d.report()
    expect(text).toContain('rightsize report')
    expect(text).not.toContain('TRIM SAVINGS')
  })
}
