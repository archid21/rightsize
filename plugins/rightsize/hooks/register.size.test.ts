import { type TestBody, expect, test } from 'claude-code/testing'
import { LOG_PATH, NO_CHANGE, NO_COLD, engine, drive, mount, rowText } from './testkit'
import { COMPACT_BASE } from './whatsnext'

// ---- The context-size warning (ADR 0013) ----------------------------------------------------------------------
// At the end of a main turn, a conversation that reached the next 40/50/60/70/80/90% step of the window gets one cache row
// with Compact now. Each step once; steps at or above autoCompactThreshold are skipped. Only the button compacts.

const OPUS = { model: 'claude-opus-5-5', effort: 'medium' }
const API = { billing: 'api' }

for (const surface of ['desktop', 'terminal'] as const) {
  const setup = (on: Parameters<TestBody>[1], tokens: number, auto?: number, stored: Record<string, string> = {}) => {
    const h = engine(on, { ...OPUS, stored: { ...NO_COLD, ...API, ...stored } })
    h.rating = NO_CHANGE
    h.contextTokens = tokens
    if (auto !== undefined) h.breakdown = { autoCompactThreshold: auto, mcpTools: [], memoryFiles: [], agents: [] }
    return h
  }
  const turn = async (d: ReturnType<typeof drive>, id: string) => {
    await d.submit('continue')
    await d.turnStart(id, 'continue')
    await d.step(id)
    await d.complete(id)
  }
  const row = async ($: unknown) => {
    const ui = await mount($, surface)
    const text = await rowText(ui, 'Cache')
    const buttons = (await ui.findAll({ type: 'Button' })).map(b => b.key)
    await ui.unmount()
    return { text, buttons }
  }
  const log = (h: ReturnType<typeof engine>) => h.files[LOG_PATH] ?? ''

  test(`a conversation at 60% gets one row with Compact now, and nothing is compacted (${surface})`, { timeoutMs: 30000, options: API }, async ($, on) => {
    const h = setup(on, 120_000)
    const d = drive($, h)
    await d.start(surface)
    expect((await row($)).text, 'nothing before a turn ends').toBe('')
    await turn(d, 't1')
    const r = await row($)
    expect(r.text).toBe('Context is 60% full (120K of 200K tokens). A compact now makes every later turn cheaper.')
    expect(r.buttons).toContain('cold-size-compact')
    expect(log(h)).toContain('context warning: shown at 60%')
    expect(h.compactions).toBe(0)
  })

  test(`each step is said once: the next turn at the same size says nothing (${surface})`, { timeoutMs: 30000, options: API }, async ($, on) => {
    const h = setup(on, 120_000)
    const d = drive($, h)
    await d.start(surface)
    await turn(d, 't1')
    await turn(d, 't2')
    expect((await row($)).text, 'the second prompt takes the row away and nothing replaces it').toBe('')
    h.contextTokens = 150_000
    await turn(d, 't3')
    expect((await row($)).text).toContain('Context is 70% full (150K of 200K')
  })

  test(`under 40% there is no row (${surface})`, { timeoutMs: 30000, options: API }, async ($, on) => {
    const h = setup(on, 70_000)
    const d = drive($, h)
    await d.start(surface)
    await turn(d, 't1')
    expect((await row($)).text).toBe('')
  })

  test(`steps at or above the auto-compact threshold are skipped (${surface})`, { timeoutMs: 30000, options: API }, async ($, on) => {
    const h = setup(on, 170_000, 160_000)
    const d = drive($, h)
    await d.start(surface)
    await turn(d, 't1')
    expect((await row($)).text, '85% full: the 80 step sits at the threshold and is skipped, so 70 is said').toContain('70%')
    h.contextTokens = 190_000
    await turn(d, 't2')
    expect((await row($)).text, 'nothing above the threshold').toBe('')
  })

  test(`Compact now compacts with rightsize's own text when whatsnext is not installed, and starts the steps over (${surface})`, { timeoutMs: 30000, options: API }, async ($, on) => {
    const h = setup(on, 120_000)
    const d = drive($, h)
    await d.start(surface)
    await turn(d, 't1')
    const ui = await mount($, surface)
    await ui.press({ key: 'cold-size-compact' })
    await ui.unmount()
    expect(h.compactCalls).toEqual([{ instructions: COMPACT_BASE }])
    expect((await row($)).text).toBe('Compacted. Later turns read a short summary, not the whole conversation.')
    expect(log(h)).toContain("context warning: compacted on the person's button")
  })

  test(`Don't show again hides the warning for good (${surface})`, { timeoutMs: 30000, options: API }, async ($, on) => {
    const h = setup(on, 120_000)
    h.answers = { Options: "Don't show again" }
    const d = drive($, h)
    await d.start(surface)
    await turn(d, 't1')
    h.store.sizeWarningHidden = true
    h.contextTokens = 190_000
    await turn(d, 't2')
    expect((await row($)).text).toBe('')
  })
}
