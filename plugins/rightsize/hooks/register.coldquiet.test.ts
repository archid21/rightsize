import { type TestBody, expect, test } from 'claude-code/testing'
import { RUNS_FILE, NO_CHANGE, NO_COLD, engine, drive, mount, rowText } from './testkit'

// ---- A cold return shows nothing --------------------------------------------------------------------------------
//
// A session that comes back cold (a resume past its cache life) gets a coldReturn line in the run log, a local measurement
// for the report's Cold returns line. Nothing is put on the band, asked or run: the cold-return note and the closed-thread
// consent flow are gone (ADR 0012 and 0013, Changed 2026-11-05).

const OPUS = { model: 'claude-opus-5-5', effort: 'medium' }
const HOUR = 3600
const runLines = (h: ReturnType<typeof engine>) => (h.files[RUNS_FILE] ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>)
const coldLines = (h: ReturnType<typeof engine>) => runLines(h).filter(l => l.kind === 'coldReturn')

/** The transcript tail of a session whose last response ended `agoMs` before the harness clock. */
const resumed = (h: ReturnType<typeof engine>, agoMs = 2 * HOUR * 1000) => {
  const row = { type: 'assistant', timestamp: new Date(h.now - agoMs).toISOString(), message: { model: 'claude-opus-5-5', usage: { input_tokens: 1000, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 10_000, output_tokens: 300 } } }
  h.transcript = ['{"type":"assistant","timest', JSON.stringify(row)].join('\n')
}

for (const surface of ['desktop', 'terminal'] as const) {
  const setup = (on: Parameters<TestBody>[1]) => {
    const h = engine(on, { ...OPUS, stored: { ...NO_COLD } })
    h.commands = [{ name: 'whatsnext:whatsnext', description: 'whatsnext', source: 'plugin', plugin: 'whatsnext' }]
    h.rating = NO_CHANGE
    resumed(h)
    return h
  }
  const cacheRow = async ($: unknown) => {
    const ui = await mount($, surface)
    const text = await rowText(ui, 'Cache')
    await ui.unmount()
    return text
  }

  test(`the first prompt after a cold resume logs the return and shows no note, even with whatsnext installed (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = setup(on)
    const d = drive($, h)
    await d.start(surface)
    expect(coldLines(h)[0]?.compactSaving, 'the line still carries the saving').toBe(0.4199)
    await d.submit('continue')
    await d.turnStart('t1', 'continue')
    await d.step('t1')
    expect(await cacheRow($), 'nothing on the Cache row').toBe('')
    expect(h.asked, 'nothing is asked').toEqual([])
  })

  test(`a warm resume logs nothing and shows nothing (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = setup(on)
    resumed(h, 10 * 60_000)
    const d = drive($, h)
    await d.start(surface)
    await d.submit('continue')
    expect(coldLines(h)).toEqual([])
    expect(await cacheRow($)).toBe('')
  })
}
