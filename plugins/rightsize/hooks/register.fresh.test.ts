import { type TestBody, expect, test } from 'claude-code/testing'
import { LOG_PATH, NO_CHANGE, NO_COLD, FRESH, WHATSNEXT_ARGS, WHATSNEXT_SCRIPT, engine, drive, freshAnswer, installWhatsnext, mount, rowText, untilAsked } from './testkit'
import { SIZE_FRESH_TEXT, SIZE_WHY, SIZE_WHY_FRESH } from './size'

// ---- Wrap up and start fresh (ADR 0051; whatsnext ADR 0025) ----------------------------------------------------
// The context-size warning also offers Wrap up and start fresh when whatsnext's `fresh-instructions --json` says this is a
// whatsnext project and the window has room for a wrap-up turn (WRAP_HEADROOM, 40,000 tokens). Every text comes from the
// command's answer; the tests give it texts that are not whatsnext's own.

const OPUS = { model: 'claude-opus-5-5', effort: 'medium' }
const API = { billing: 'api' }
const WRAP = 'wrap up, please'
const FRESH_BTN = 'cold-size-fresh'
const COMPACT_BTN = 'cold-size-compact'

for (const surface of ['desktop', 'terminal'] as const) {
  /** A session at `tokens` of a 200K window with whatsnext installed; `fresh` is what `fresh-instructions` answers (undefined: the command is unknown). */
  const setup = (on: Parameters<TestBody>[1], tokens: number, fresh?: string) => {
    const h = engine(on, { ...OPUS, stored: { ...NO_COLD, ...API } })
    h.rating = NO_CHANGE
    h.contextTokens = tokens
    installWhatsnext(h)
    h.virtual = true
    if (fresh !== undefined) h.wnFresh = { exitCode: 0, stdout: fresh }
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
  const press = async ($: unknown, key: string) => {
    const ui = await mount($, surface)
    await ui.press({ key })
    await ui.unmount()
  }
  const log = (h: ReturnType<typeof engine>) => h.files[LOG_PATH] ?? ''
  const freshRuns = (h: ReturnType<typeof engine>) => h.wnRuns.filter(a => a.includes('fresh-instructions'))
  /** A started session whose first turn ended: the warning is on the row. */
  const warned = async ($: unknown, on: Parameters<TestBody>[1], tokens: number, fresh?: string) => {
    const h = setup(on, tokens, fresh)
    const d = drive($, h)
    await d.start(surface)
    await turn(d, 't1')
    return { h, d }
  }

  test(`the warning offers Wrap up and start fresh beside Compact now when the command says project and there is room (${surface})`, { timeoutMs: 30000, options: API }, async ($, on) => {
    const { h } = await warned($, on, 120_000, freshAnswer(false))
    const r = await row($)
    expect(r.text).toContain('Context is 60% full')
    expect(r.buttons).toContain(COMPACT_BTN)
    expect(r.buttons).toContain(FRESH_BTN)
    expect(freshRuns(h)).toEqual([['python3', WHATSNEXT_SCRIPT, 'fresh-instructions', '--session', 'sess-1', '--json']])
    expect(h.submitted.map(x => x.text), 'nothing is submitted until the button is pressed').toEqual(['continue'])
  })

  const NOT_OFFERED = [
    { name: 'the command is unknown (whatsnext has not got it yet)', tokens: 120_000, fresh: undefined, why: 'fresh-instructions exited 2' },
    { name: 'the command answers with something that is not JSON', tokens: 120_000, fresh: 'wrap up and start fresh', why: 'did not answer in JSON' },
    { name: 'the command leaves out a text', tokens: 120_000, fresh: JSON.stringify({ project: true, wrap_up_first: true, wrap_up_prompt: 'wrap up' }), why: 'without every field' },
    { name: 'project is false', tokens: 120_000, fresh: freshAnswer(false, false), why: undefined },
    { name: 'less room is left than WRAP_HEADROOM', tokens: 170_000, fresh: freshAnswer(true), why: undefined },
  ]
  for (const c of NOT_OFFERED) {
    test(`the warning offers only Compact now when ${c.name} (${surface})`, { timeoutMs: 30000, options: API }, async ($, on) => {
      const { h } = await warned($, on, c.tokens, c.fresh)
      const r = await row($)
      expect(r.text).toContain('Context is ')
      expect(r.buttons).toContain(COMPACT_BTN)
      expect(r.buttons).not.toContain(FRESH_BTN)
      if (c.why) expect(log(h)).toContain(c.why)
      if (c.tokens > 160_000) expect(freshRuns(h), 'no question to whatsnext when there is no room').toEqual([])
    })
  }

  test(`without whatsnext the warning offers only Compact now and does not run it (${surface})`, { timeoutMs: 30000, options: API }, async ($, on) => {
    const h = engine(on, { ...OPUS, stored: { ...NO_COLD, ...API } })
    h.rating = NO_CHANGE
    h.contextTokens = 120_000
    h.wnFresh = { exitCode: 0, stdout: freshAnswer(false) }
    const d = drive($, h)
    await d.start(surface)
    await turn(d, 't1')
    const r = await row($)
    expect(r.buttons).toContain(COMPACT_BTN)
    expect(r.buttons).not.toContain(FRESH_BTN)
    expect(h.wnRuns).toEqual([])
  })

  test(`wrap_up_first true: the button submits exactly wrap_up_prompt, and nothing else starts until whatsnext's band takes over (${surface})`, { timeoutMs: 30000, options: API }, async ($, on) => {
    const { h } = await warned($, on, 120_000, freshAnswer(true, true, { wrap_up_prompt: WRAP }))
    await press($, FRESH_BTN)
    expect(h.submitted.map(x => x.text), 'the wrap-up is the only prompt after the person\'s own').toEqual(['continue', WRAP])
    expect(h.commandRuns, 'no /clear and no /compact before the note is written').toEqual([])
    expect(h.compactions).toBe(0)
    const r = await row($)
    expect(r.text, 'rightsize shows nothing more: whatsnext\'s band offers the new chat').toBe('')
    expect(r.buttons).not.toContain('cold-size-fresh-new')
    expect(log(h)).toContain(`submitted "${WRAP}"`)
  })

  test(`wrap_up_first true: a refused wrap-up leaves the row and says why (${surface})`, { timeoutMs: 30000, options: API }, async ($, on) => {
    const { h } = await warned($, on, 120_000, freshAnswer(true, true, { wrap_up_prompt: WRAP }))
    h.dropNext = 'blocked'
    await press($, FRESH_BTN)
    expect(h.submitted.map(x => x.text)).toEqual(['continue'])
    expect(log(h)).toContain('was refused: blocked')
    expect(h.toasts.at(-1)).toContain('wrap-up was refused')
  })

  test(`wrap_up_first false: no wrap-up turn runs; the row shows the two choices (${surface})`, { timeoutMs: 30000, options: API }, async ($, on) => {
    const { h } = await warned($, on, 120_000, freshAnswer(false))
    await press($, FRESH_BTN)
    expect(h.submitted.map(x => x.text), 'no wrap-up').toEqual(['continue'])
    expect(h.commandRuns).toEqual([])
    const r = await row($)
    expect(r.text).toBe(SIZE_FRESH_TEXT)
    expect(r.buttons).toEqual(expect.arrayContaining(['cold-size-fresh-new', 'cold-size-fresh-clear', 'cold-size-fresh-not-now']))
    expect(r.buttons).not.toContain(COMPACT_BTN)
  })

  test(`wrap_up_first false: New session uses new_session_prompt on the desktop and terminal_command on the terminal (${surface})`, { timeoutMs: 30000, options: API }, async ($, on) => {
    const { h } = await warned($, on, 120_000, freshAnswer(false))
    await press($, FRESH_BTN)
    await press($, 'cold-size-fresh-new')
    if (surface === 'desktop') {
      expect(h.submitted.at(-1)).toEqual({ text: FRESH.new_session_prompt, asUser: true })
      expect((await row($)).text).toBe('')
    } else {
      expect(h.submitted.map(x => x.text), 'a terminal cannot open a window: nothing is submitted').toEqual(['continue'])
      expect((await row($)).text).toContain(FRESH.terminal_command)
    }
    expect(h.commandRuns, 'New session keeps this chat').toEqual([])
  })

  test(`wrap_up_first false: Clear and continue runs clear_command, then submits continue_prompt (${surface})`, { timeoutMs: 30000, options: API }, async ($, on) => {
    const { h } = await warned($, on, 120_000, freshAnswer(false))
    await press($, FRESH_BTN)
    await press($, 'cold-size-fresh-clear')
    expect(h.commandRuns).toEqual([{ command: 'clear', args: '' }])
    expect(h.submitted.at(-1)).toEqual({ text: FRESH.continue_prompt, asUser: true })
    expect((await row($)).text).toBe('')
  })

  test(`wrap_up_first false: Clear and continue says what to type when /clear cannot run (${surface})`, { timeoutMs: 30000, options: API }, async ($, on) => {
    const { h } = await warned($, on, 120_000, freshAnswer(false))
    await press($, FRESH_BTN)
    h.commandRunFails = 'no clear'
    await press($, 'cold-size-fresh-clear')
    expect(h.submitted.map(x => x.text), 'the continue prompt is not sent into the old chat').toEqual(['continue'])
    expect((await row($)).text).toBe(`Could not clear this chat. Type /clear, then: ${FRESH.continue_prompt}`)
  })

  test(`wrap_up_first false: Not now takes the row away and starts nothing (${surface})`, { timeoutMs: 30000, options: API }, async ($, on) => {
    const { h } = await warned($, on, 120_000, freshAnswer(false))
    await press($, FRESH_BTN)
    await press($, 'cold-size-fresh-not-now')
    expect((await row($)).text).toBe('')
    expect(h.submitted.map(x => x.text)).toEqual(['continue'])
    expect(h.commandRuns).toEqual([])
  })

  test(`the answer is asked again at the press: a project that stopped being whatsnext's gets nothing (${surface})`, { timeoutMs: 30000, options: API }, async ($, on) => {
    const { h } = await warned($, on, 120_000, freshAnswer(true, true, { wrap_up_prompt: WRAP }))
    h.wnFresh = { exitCode: 0, stdout: freshAnswer(true, false) }
    await press($, FRESH_BTN)
    expect(h.submitted.map(x => x.text)).toEqual(['continue'])
    expect(h.toasts.at(-1)).toContain('whatsnext init')
  })

  const why = async ($: unknown, h: ReturnType<typeof engine>) => {
    h.logs.length = 0
    // The band carries a rating, so the cache choices sit on the second page of the menu.
    h.answers = { Options: 'More…', 'More options': 'Why?' }
    const before = h.asked.length
    const ui = await mount($, surface)
    await ui.press({ key: 'mode' })
    await untilAsked(h, before, 2)
    await ui.unmount()
    for (let i = 0; i < 40 && h.logs.length === 0; i++) await new Promise(r => setTimeout(r, 25))
    return h.logs.at(-1)
  }

  test(`Why? describes Wrap up and start fresh only when the row offers it (${surface})`, { timeoutMs: 30000, options: API }, async ($, on) => {
    const offered = await warned($, on, 120_000, freshAnswer(false))
    expect(await why($, offered.h)).toBe(SIZE_WHY + SIZE_WHY_FRESH)
  })

  test(`Why? says nothing of Wrap up and start fresh when the row does not offer it (${surface})`, { timeoutMs: 30000, options: API }, async ($, on) => {
    const plain = await warned($, on, 120_000, freshAnswer(false, false))
    expect(await why($, plain.h)).toBe(SIZE_WHY)
  })

  test(`Compact now behaves as before while Wrap up and start fresh is offered (${surface})`, { timeoutMs: 30000, options: API }, async ($, on) => {
    const { h } = await warned($, on, 120_000, freshAnswer(false))
    h.wnRuns.length = 0
    await press($, COMPACT_BTN)
    expect(h.wnRuns).toEqual([['python3', WHATSNEXT_SCRIPT, 'compact-instructions', '--session', 'sess-1', '--json']])
    expect(h.commandRuns).toEqual([{ command: 'compact', args: WHATSNEXT_ARGS }])
    expect(h.submitted.map(x => x.text)).toEqual(['continue'])
    expect(h.compactions).toBe(0)
  })
}
