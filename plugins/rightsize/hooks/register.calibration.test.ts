import { type TestBody, expect, test } from 'claude-code/testing'
import { CAL_AT_STORE, CAL_STORE } from './cost'
import { RUNS_FILE, LOOKUP, FREE_SWITCHES, engine, drive, settle } from './testkit'

// P-21 (ADR 0062): the calibration was already the weekly-tuning idea, running after every rated turn. The run line now logs
// `stayRaw` beside `stay`, the details view says how the estimates are tuned, and a reset clears when calibration last saved.

for (const surface of ['desktop', 'terminal'] as const) {
  const OPUS = { model: 'claude-opus-5-5', effort: 'medium' }
  const RATING = '{"level":"low","model":"same","size":"small","type":"lookup","read":2000,"write":40000,"steps":1}'
  const readRuns = (h: ReturnType<typeof engine>) => (h.files[RUNS_FILE] ?? '').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
  /** One finished lookup turn with a calibration that doubles every lookup estimate on the main chat. */
  const oneTurn = async ($: unknown, on: Parameters<TestBody>[1]) => {
    const h = engine(on, { ...OPUS, store: { [CAL_STORE]: { ...FREE_SWITCHES, 'lookup:main': { n: 20, ratio: 2 } } } })
    h.now = Date.parse('2026-11-13T20:00:00.000Z')
    h.rating = RATING
    const d = drive($, h)
    await d.start(surface)
    await d.submit(LOOKUP)
    await d.step('t1')
    await d.complete('t1')
    await settle()
    return { h, d }
  }

  test(`a run line logs the estimate of staying before calibration beside the calibrated one (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h } = await oneTurn($, on)
    const line = readRuns(h).find(l => l.kind === 'run') as { stay: number; stayRaw: number; taken: number; estimate: number }
    expect(line.stayRaw, 'the raw estimate is logged').toBeGreaterThan(0)
    expect(line.stay / line.stayRaw, 'stay is the raw estimate times the calibration factor').toBeGreaterThan(1.9)
    expect(line.stay / line.stayRaw).toBeLessThan(2.1)
    expect(line.estimate, 'the raw estimate of the route taken is still logged').toBeGreaterThan(0)
  })

  test(`the calibration save stores when it last ran, and the details view says how estimates are tuned (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await oneTurn($, on)
    expect(h.store[CAL_AT_STORE]).toBe(new Date(h.now).toISOString())
    const text = await d.report()
    const details = text.slice(text.indexOf('rightsize report details'))
    expect(details).toMatch(/Estimates tuned after each rated turn: last updated Nov 13; 21 runs measured\./)
    expect(details).toContain('lookup ')
    expect(text.slice(0, text.indexOf('rightsize report details')), 'the main view leaves it out').not.toContain('Estimates tuned')
  })
}
