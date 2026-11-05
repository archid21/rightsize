import { type TestBody, expect, test } from 'claude-code/testing'
import { RUNS_FILE, LOG_PATH, NO_CHANGE, NO_COLD, engine, drive, untilAsked, mount, rowText } from './testkit'
import { clockText } from './warm'
import { LIMIT_COMPACT_INSTRUCTIONS, LIMIT_WHY } from './limit'

// ---- Compact before the usage limit --------------------------------------------------------------------------
//
// At the end of a main turn, with the 5-hour window at 90% or more, more than 30K tokens of conversation and a reset further
// off than the cache lives, the band's cache row says a compaction now would save money after the reset. Once per window.
// Nothing is compacted unless the person presses "Compact now".

const OPUS = { model: 'claude-opus-5-5', effort: 'medium' }
const MIN = 60_000
const HOUR = 60 * MIN
const WHATSNEXT = [{ name: 'whatsnext:whatsnext', description: 'whatsnext', source: 'plugin', plugin: 'whatsnext' }]
/** A main request that read 100,000 tokens in all: on Opus a compaction now saves $0.59 after the reset. */
const BIG = { input_tokens: 200, output_tokens: 400, cache_read_input_tokens: 99_500, cache_creation_input_tokens: 300 }
const SMALL = { input_tokens: 200, output_tokens: 400, cache_read_input_tokens: 29_500, cache_creation_input_tokens: 300 }
const API = { billing: 'api' }

for (const surface of ['desktop', 'terminal'] as const) {
  type Over = { stored?: Record<string, string>; percent?: number; waitMs?: number; usage?: typeof BIG; commands?: typeof WHATSNEXT }
  const setup = (on: Parameters<TestBody>[1], over: Over = {}) => {
    const h = engine(on, { ...OPUS, stored: { ...NO_COLD, ...API, ...over.stored } })
    h.rating = NO_CHANGE
    h.stepUsage = over.usage ?? BIG
    h.commands = over.commands ?? []
    h.rateLimits = [{ kind: 'five_hour', percentUsed: over.percent ?? 92, resetsAt: new Date(h.now + (over.waitMs ?? 3 * HOUR)).toISOString() }]
    return h
  }
  /** One main turn: the prompt, its step and its end. */
  const turn = async (d: ReturnType<typeof drive>, id: string) => {
    await d.submit('continue')
    await d.turnStart(id, 'continue')
    await d.step(id)
    await d.complete(id)
  }
  const advice = async ($: unknown) => {
    const ui = await mount($, surface)
    const text = await rowText(ui, 'Cache')
    const buttons = (await ui.findAll({ type: 'Button' })).map(b => b.key)
    await ui.unmount()
    return { text, buttons }
  }
  const press = async ($: unknown, key: string) => {
    const ui = await mount($, surface)
    await ui.press({ key })
    await ui.unmount()
  }
  const menu = async ($: unknown, h: ReturnType<typeof engine>, choice: string) => {
    h.answers = { Options: choice }
    const before = h.asked.length
    const ui = await mount($, surface)
    await ui.press({ key: 'mode' })
    await untilAsked(h, before)
    await ui.unmount()
    return h.asked.slice(before)
  }
  const log = (h: ReturnType<typeof engine>) => h.files[LOG_PATH] ?? ''
  const SHOWN = (h: ReturnType<typeof engine>, waitMs = 3 * HOUR) => `Near your 5-hour limit, resets ${clockText(h.now + waitMs)}. Compact now to save ~$0.59 after the reset.`

  test(`at 90% or more, with a big conversation and a long wait, the cache row advises compacting, with a Compact now button (${surface})`, { timeoutMs: 30000, options: API }, async ($, on) => {
    const h = setup(on, { percent: 90 })
    const d = drive($, h)
    await d.start(surface)
    expect((await advice($)).text, 'nothing before the first turn ends').toBe('')
    await turn(d, 't1')
    const a = await advice($)
    expect(a.text).toBe(SHOWN(h))
    expect(a.buttons, 'one button, and the ⋯ menu').toContain('cold-limit-compact')
    expect(log(h)).toContain('usage-limit advice: shown, compacting now saves $0.59 after the reset')
    expect(h.compactions, 'nothing compacted yet: only the button does').toBe(0)
  })

  test(`on a subscription the row says the share of the next window (${surface})`, { timeoutMs: 30000, options: { billing: 'subscription' } }, async ($, on) => {
    const h = setup(on, { stored: { billing: 'subscription' } })
    // 2 points of the 5-hour window over $1 of spend: 0.59 dollars is about 1.2 points.
    const run = (i: number) => JSON.stringify({ at: new Date(h.now - (2 - i) * MIN).toISOString(), kind: 'run', session: 'old', type: 'lookup', route: 'main', tier: 'opus', change: 'none', actual: 0.5, before: { five_hour: 10 + i }, after: { five_hour: 11 + i } })
    h.files[RUNS_FILE] = `${run(0)}\n${run(1)}\n`
    const d = drive($, h)
    await d.start(surface)
    await turn(d, 't1')
    expect((await advice($)).text).toMatch(/^Near your 5-hour limit, resets \d+:\d\d\. Compact now to save ~[\d.–]+% of your next window\.$/)
  })

  test(`no advice when the reset is within the cache life: the cache stays warm (${surface})`, { timeoutMs: 30000, options: API }, async ($, on) => {
    const h = setup(on, { waitMs: 30 * MIN })
    const d = drive($, h)
    await d.start(surface)
    await turn(d, 't1')
    expect((await advice($)).text, '30 minutes to wait').toBe('')
    expect(log(h)).not.toContain('usage-limit')
  })

  test(`no advice with a wait of exactly the cache life, advice one minute past it (${surface})`, { timeoutMs: 30000, options: API }, async ($, on) => {
    const h = setup(on, { waitMs: HOUR })
    const d = drive($, h)
    await d.start(surface)
    await turn(d, 't1')
    expect((await advice($)).text, 'exactly the cache life').toBe('')
    h.rateLimits = [{ kind: 'five_hour', percentUsed: 92, resetsAt: new Date(h.now + HOUR + MIN).toISOString() }]
    await turn(d, 't2')
    expect((await advice($)).text, 'one minute past the cache life').toBe(SHOWN(h, HOUR + MIN))
  })

  test(`no advice under 90% (${surface})`, { timeoutMs: 30000, options: API }, async ($, on) => {
    const h = setup(on, { percent: 89 })
    const d = drive($, h)
    await d.start(surface)
    await turn(d, 't1')
    expect((await advice($)).text).toBe('')
    expect(log(h)).not.toContain('usage-limit')
  })

  test(`no advice at 30,000 tokens or less, advice just over it (${surface})`, { timeoutMs: 30000, options: API }, async ($, on) => {
    const h = setup(on, { usage: SMALL })
    const d = drive($, h)
    await d.start(surface)
    await turn(d, 't1')
    expect((await advice($)).text, 'exactly 30,000').toBe('')
    h.stepUsage = { ...SMALL, cache_read_input_tokens: SMALL.cache_read_input_tokens + 1 }
    await turn(d, 't2')
    expect((await advice($)).text, '30,001').toContain('Compact now to save ~$0.')
  })

  test(`once per 5-hour window: a second turn in the same window says nothing, a new window may (${surface})`, { timeoutMs: 30000, options: API }, async ($, on) => {
    const h = setup(on)
    const d = drive($, h)
    await d.start(surface)
    await turn(d, 't1')
    expect((await advice($)).text).toBe(SHOWN(h))
    expect(h.store.limitAdviceWindow, 'the window it was shown for is kept').toBe(h.rateLimits[0]?.resetsAt)
    await turn(d, 't2')
    expect((await advice($)).text, 'same window, no second row').toBe('')
    expect(log(h).split('usage-limit advice: shown').length - 1, 'shown once').toBe(1)
    // The next window: its reset is 5 hours on.
    h.rateLimits = [{ kind: 'five_hour', percentUsed: 95, resetsAt: new Date(h.now + 8 * HOUR).toISOString() }]
    await turn(d, 't3')
    expect((await advice($)).text, 'a new window').toBe(SHOWN(h, 8 * HOUR))
  })

  test(`not while Cache is off (${surface})`, { timeoutMs: 30000, options: { ...API, cache: 'off' } }, async ($, on) => {
    const h = setup(on, { stored: { cache: 'off' } })
    const d = drive($, h)
    await d.start(surface)
    await turn(d, 't1')
    expect((await advice($)).text).toBe('')
    expect(h.store.limitAdviceWindow, 'and the window is not used up').toBeUndefined()
    expect(log(h)).not.toContain('usage-limit')
  })

  test(`not while rightsize is off (${surface})`, { timeoutMs: 30000, options: API }, async ($, on) => {
    const h = setup(on)
    h.files['/home/test/.claude/mods/switches.json'] = '{"rightsize": false}'
    const d = drive($, h)
    await d.start(surface)
    await turn(d, 't1')
    expect((await advice($)).text).toBe('')
    expect(log(h)).not.toContain('usage-limit')
  })

  test(`watch only: the advice is logged, not shown, once per window (${surface})`, { timeoutMs: 30000, options: { ...API, mode: 'watch only' } }, async ($, on) => {
    const h = setup(on, { stored: { mode: 'watch only' } })
    const d = drive($, h)
    await d.start(surface)
    await turn(d, 't1')
    expect((await advice($)).text).toBe('')
    expect(log(h)).toContain('watch only: would advise compacting before the 5-hour limit ($0.59 saved after the reset, 100K tokens on Opus')
    await turn(d, 't2')
    expect(log(h).split('watch only: would advise').length - 1, 'logged once').toBe(1)
    expect(h.compactions).toBe(0)
  })

  test(`the band being off shows nothing, and the window is kept for later (${surface})`, { timeoutMs: 30000, options: { ...API, band: 'off' } }, async ($, on) => {
    const h = setup(on, { stored: { band: 'off' } })
    const d = drive($, h)
    await d.start(surface)
    await turn(d, 't1')
    expect((await advice($)).text).toBe('')
    expect(h.store.limitAdviceWindow).toBeUndefined()
  })

  test(`⋯ has Why? and Don't show again; Why? explains and leaves the row (${surface})`, { timeoutMs: 30000, options: API }, async ($, on) => {
    const h = setup(on)
    const d = drive($, h)
    await d.start(surface)
    await turn(d, 't1')
    const asked = await menu($, h, 'Why?')
    expect(asked[0]?.options).toEqual(['Why?', "Don't show again", 'When the band shows…'])
    expect(h.logs).toContain(LIMIT_WHY)
    expect((await advice($)).text, 'reading it leaves the row').toBe(SHOWN(h))
    expect(h.compactions).toBe(0)
  })

  test(`Don't show again hides this row for good, in later windows and sessions too (${surface})`, { timeoutMs: 30000, options: API }, async ($, on) => {
    const h = setup(on)
    const d = drive($, h)
    await d.start(surface)
    await turn(d, 't1')
    await menu($, h, "Don't show again")
    expect((await advice($)).text, 'gone now').toBe('')
    expect(h.store.limitAdviceHidden, 'kept in the store').toBe(true)
    expect(h.compactions).toBe(0)
    h.rateLimits = [{ kind: 'five_hour', percentUsed: 95, resetsAt: new Date(h.now + 8 * HOUR).toISOString() }]
    await turn(d, 't2')
    expect((await advice($)).text, 'a new window').toBe('')
    await d.start(surface)
    await turn(d, 't3')
    expect((await advice($)).text, 'a new session').toBe('')
  })

  test(`Compact now compacts with the instructions, once the person presses it and not before (${surface})`, { timeoutMs: 30000, options: API }, async ($, on) => {
    const h = setup(on)
    const d = drive($, h)
    await d.start(surface)
    await turn(d, 't1')
    expect(h.compactions, 'the advice shown, nothing compacted').toBe(0)
    await press($, 'cold-limit-compact')
    expect(h.compactions).toBe(1)
    expect(h.compactCalls).toEqual([{ instructions: LIMIT_COMPACT_INSTRUCTIONS }])
    expect((await advice($)).text).toBe('Compacted. After the reset a short summary is read, not the whole conversation.')
    expect(log(h)).toContain('usage-limit advice: compacted before the reset, on the person\'s button')
  })

  test(`with whatsnext installed Compact now still compacts the same way for now (TODO(whatsnext-compact)) (${surface})`, { timeoutMs: 30000, options: API }, async ($, on) => {
    const h = setup(on, { commands: WHATSNEXT })
    const d = drive($, h)
    await d.start(surface)
    await turn(d, 't1')
    expect(h.compactions).toBe(0)
    await press($, 'cold-limit-compact')
    expect(h.compactCalls).toEqual([{ instructions: LIMIT_COMPACT_INSTRUCTIONS }])
  })

  test(`a compaction that is skipped says so and leaves no row (${surface})`, { timeoutMs: 30000, options: API }, async ($, on) => {
    const h = setup(on)
    h.compactSkip = 'a hook vetoed it'
    const d = drive($, h)
    await d.start(surface)
    await turn(d, 't1')
    await press($, 'cold-limit-compact')
    expect((await advice($)).text).toBe('')
    expect(log(h)).toContain('usage-limit advice: compact skipped: a hook vetoed it')
  })

  test(`the next prompt takes the row away (${surface})`, { timeoutMs: 30000, options: API }, async ($, on) => {
    const h = setup(on)
    const d = drive($, h)
    await d.start(surface)
    await turn(d, 't1')
    await d.submit('next')
    expect((await advice($)).text).toBe('')
  })

  test(`an unreadable usage reading never breaks the turn (${surface})`, { timeoutMs: 30000, options: API }, async ($, on) => {
    const h = setup(on)
    h.rateLimits = [{ kind: 'five_hour', percentUsed: Number.NaN, resetsAt: 'soon' }]
    const d = drive($, h)
    await d.start(surface)
    await turn(d, 't1')
    expect((await advice($)).text).toBe('')
  })
}
