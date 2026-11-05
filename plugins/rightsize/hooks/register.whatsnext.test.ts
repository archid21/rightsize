import { type TestBody, expect, test } from 'claude-code/testing'
import { RUNS_FILE, LOG_PATH, NO_CHANGE, NO_COLD, WHATSNEXT_SCRIPT, engine, drive, installWhatsnext, untilAsked, mount, rowText } from './testkit'
import { CONSENT_TEXT, HOW_IT_WORKS, WHATSNEXT_URL } from './whatsnext'

// ---- The whatsnext note ------------------------------------------------------------------------------------
//
// A session that comes back cold (a resume past its cache life) and whose cold-return line says a Haiku compaction would
// have saved more than 0 gets one note on the band at its first prompt: "whatsnext could have saved $0.42 here.", with one
// button by state (Get whatsnext when whatsnext is not installed, none when it is) and How it works / Don't show again in ⋯.
// It leaves when the turn ends. The Cold returns line in the report is not touched by hiding it.

const OPUS = { model: 'claude-opus-5-5', effort: 'medium' }
const HOUR = 3600
const WHATSNEXT = [{ name: 'whatsnext:whatsnext', description: 'whatsnext', source: 'plugin', plugin: 'whatsnext' }]
const runLines = (h: ReturnType<typeof engine>) => (h.files[RUNS_FILE] ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>)
const coldLines = (h: ReturnType<typeof engine>) => runLines(h).filter(l => l.kind === 'coldReturn')

/** The transcript tail of a session whose last response ended `agoMs` before the harness clock, over `usage`. */
const resumed = (h: ReturnType<typeof engine>, agoMs = 2 * HOUR * 1000, usage: Record<string, unknown> = {}, model = 'claude-opus-5-5') => {
  const row = { type: 'assistant', timestamp: new Date(h.now - agoMs).toISOString(), message: { model, usage: { input_tokens: 1000, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 10_000, output_tokens: 300, ...usage } } }
  h.transcript = ['{"type":"assistant","timest', JSON.stringify(row)].join('\n')
}

/** Runs that show the window rate: 2 points of the 5-hour window over $1 of spend. */
const withRate = (h: ReturnType<typeof engine>) => {
  const run = (i: number) => JSON.stringify({ at: new Date(h.now - (2 - i) * 60_000).toISOString(), kind: 'run', session: 'old', type: 'lookup', route: 'main', tier: 'opus', change: 'none', actual: 0.5, before: { five_hour: 10 + i }, after: { five_hour: 11 + i } })
  h.files[RUNS_FILE] = `${run(0)}\n${run(1)}\n`
}

for (const surface of ['desktop', 'terminal'] as const) {
  const setup = (on: Parameters<TestBody>[1], over: { stored?: Record<string, string>; commands?: { name: string; description: string; source: string; plugin?: string }[]; usage?: Record<string, unknown>; model?: string } = {}) => {
    const h = engine(on, { ...OPUS, stored: { ...NO_COLD, ...over.stored } })
    h.commands = over.commands ?? []
    h.rating = NO_CHANGE
    resumed(h, 2 * HOUR * 1000, over.usage ?? {}, over.model)
    return h
  }
  /** The cache row of the band, and what else it draws: the row's text, its Link, its buttons. */
  const note = async ($: unknown) => {
    const ui = await mount($, surface)
    const text = await rowText(ui, 'Cache')
    const links = await ui.findAll({ type: 'Link' })
    const buttons = (await ui.findAll({ type: 'Button' })).map(b => [b.key, b.text])
    await ui.unmount()
    return { text, links, buttons }
  }
  /** Presses ⋯ and picks `choice` in the menu it opens. */
  const menu = async ($: unknown, h: ReturnType<typeof engine>, choice: string) => {
    h.answers = { Options: choice }
    const before = h.asked.length
    const ui = await mount($, surface)
    await ui.press({ key: 'mode' })
    await untilAsked(h, before)
    await ui.unmount()
    return h.asked.slice(before)
  }
  const prompt = async (d: ReturnType<typeof drive>, id: string, text = 'continue') => {
    await d.submit(text)
    await d.turnStart(id, text)
    await d.step(id)
  }

  test(`the first prompt after a cold resume shows what whatsnext could have saved, in dollars on the API (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = setup(on)
    const d = drive($, h)
    await d.start(surface)
    expect(coldLines(h)[0]?.compactSaving, 'the saving the line carries').toBe(0.4199)
    expect((await note($)).text, 'nothing before the first prompt').toBe('')
    await prompt(d, 't1')
    const n = await note($)
    expect(n.text).toBe('whatsnext could have saved $0.42 here.')
    expect(h.files[LOG_PATH] ?? '').toContain('whatsnext note: could have saved $0.42 on the cold return')
  })

  test(`on a subscription the note says the share of your window, from the rate the runs show (${surface})`, { timeoutMs: 30000, options: { billing: 'subscription' } }, async ($, on) => {
    const h = setup(on, { stored: { billing: 'subscription' } })
    withRate(h)
    const d = drive($, h)
    await d.start(surface)
    await prompt(d, 't1')
    // 2 points of the window over $1: $0.42 stands for about 0.2 to 1.4 points, in the band's short form.
    expect((await note($)).text).toBe('whatsnext could have saved ~0.2–1% of your window here.')
  })

  test(`on a subscription with no rate yet, the note gives the dollars, API-equivalent (${surface})`, { timeoutMs: 30000, options: { billing: 'subscription' } }, async ($, on) => {
    const h = setup(on, { stored: { billing: 'subscription' } })
    const d = drive($, h)
    await d.start(surface)
    await prompt(d, 't1')
    expect((await note($)).text).toBe('whatsnext could have saved $0.42 API-equivalent here.')
  })

  test(`no note when the saving is 0: a conversation smaller than its summary (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = setup(on, { usage: { input_tokens: 0, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 } })
    const d = drive($, h)
    await d.start(surface)
    expect(coldLines(h)[0]?.compactSaving, 'clamped to 0').toBe(0)
    await prompt(d, 't1')
    expect((await note($)).text, 'no saving, no note').toBe('')
  })

  test(`no note when the saving is unknown: no model, so no tier and no figure (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = setup(on, { model: 'mystery-1' })
    h.transcript = JSON.stringify({ type: 'assistant', timestamp: new Date(h.now - 2 * HOUR * 1000).toISOString(), message: { usage: { input_tokens: 61_000 } } })
    h.model = 'mystery-1'
    const d = drive($, h)
    await d.start(surface)
    expect(coldLines(h)[0], 'a line with no saving').not.toHaveProperty('compactSaving')
    await prompt(d, 't1')
    expect((await note($)).text, 'unknown, no note').toBe('')
  })

  test(`a warm resume has no note (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = setup(on)
    resumed(h, 10 * 60_000)
    const d = drive($, h)
    await d.start(surface)
    await prompt(d, 't1')
    expect(coldLines(h)).toEqual([])
    expect((await note($)).text).toBe('')
  })

  test(`the button is "Get whatsnext", a link to its page, only when whatsnext is not installed (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const absent = setup(on)
    const d = drive($, absent)
    await d.start(surface)
    await prompt(d, 't1')
    const n = await note($)
    expect(n.links.length, 'one link').toBe(1)
    expect(n.links[0]?.props?.label ?? n.links[0]?.text).toBe('Get whatsnext')
    expect(JSON.stringify(n.links[0]), 'it goes to whatsnext').toContain(WHATSNEXT_URL)
    expect(n.buttons.map(b => b[0]), 'the others are ⋯ and ×').toEqual(['mode', 'close'])
    expect(n.text, 'the note itself is the same').toBe('whatsnext could have saved $0.42 here.')
  })

  test(`whatsnext installed, the setting off: the note has Turn on, and no link (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = setup(on, { commands: WHATSNEXT })
    installWhatsnext(h)
    h.wnAuto = false
    const d = drive($, h)
    await d.start(surface)
    await prompt(d, 't1')
    const n = await note($)
    expect(n.text, 'the note shows').toBe('whatsnext could have saved $0.42 here.')
    expect(n.links, 'no Get whatsnext').toEqual([])
    expect(n.buttons.map(b => b[0]), 'Turn on, ⋯ and ×').toEqual(['cold-wn-turn-on', 'mode', 'close'])
  })

  test(`whatsnext installed, the setting unknown: no button (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = setup(on, { commands: WHATSNEXT })
    const d = drive($, h)
    await d.start(surface)
    await prompt(d, 't1')
    const n = await note($)
    expect(n.text).toBe('whatsnext could have saved $0.42 here.')
    expect(n.buttons.map(b => b[0]), 'only ⋯ and ×').toEqual(['mode', 'close'])
  })

  test(`whatsnext installed, the setting on: no note at all (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = setup(on, { commands: WHATSNEXT })
    installWhatsnext(h)
    h.wnAuto = true
    const d = drive($, h)
    await d.start(surface)
    await prompt(d, 't1')
    expect((await note($)).text).toBe('')
  })

  const pressTurnOn = async ($: unknown) => {
    const ui = await mount($, surface)
    await ui.press({ key: 'cold-wn-turn-on' })
    await ui.unmount()
  }
  const sets = (h: ReturnType<typeof engine>) => h.wnRuns.filter(r => r[2] === 'config' && r[3] === 'set')

  test(`Turn on opens the confirm dialog with the cap and the cost; nothing is on until confirm, then it runs config set for billing and auto (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = setup(on, { commands: WHATSNEXT })
    installWhatsnext(h)
    h.wnAuto = false
    h.answers = { whatsnext: 'Turn on' }
    const d = drive($, h)
    await d.start(surface)
    await prompt(d, 't1')
    const before = h.asked.length
    await pressTurnOn($)
    await untilAsked(h, before)
    expect(h.asked[before]?.question, 'the dialog says what it costs').toBe(CONSENT_TEXT)
    expect(h.asked[before]?.options).toEqual(['Turn on', 'Cancel'])
    await h.advance(0)
    expect(sets(h)).toEqual([
      ['python3', WHATSNEXT_SCRIPT, 'config', 'set', '--user', 'compact.closed.billing', 'api'],
      ['python3', WHATSNEXT_SCRIPT, 'config', 'set', '--user', 'compact.closed.auto', 'true'],
    ])
    expect((await note($)).text, 'the note goes').toBe('')
    expect(h.files[LOG_PATH] ?? '').toContain('whatsnext turn on: confirmed')
  })

  test(`Cancel in the dialog changes nothing (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = setup(on, { commands: WHATSNEXT })
    installWhatsnext(h)
    h.wnAuto = false
    h.answers = { whatsnext: 'Cancel' }
    const d = drive($, h)
    await d.start(surface)
    await prompt(d, 't1')
    const before = h.asked.length
    await pressTurnOn($)
    await untilAsked(h, before)
    await h.advance(0)
    expect(sets(h), 'nothing written').toEqual([])
    expect(h.files[LOG_PATH] ?? '').toContain('whatsnext turn on: not confirmed; nothing changed')
  })

  test(`a config set that fails leaves it off and says why (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = setup(on, { commands: WHATSNEXT })
    installWhatsnext(h)
    h.wnAuto = false
    h.wnSetFails = 'unknown key'
    h.answers = { whatsnext: 'Turn on' }
    const d = drive($, h)
    await d.start(surface)
    await prompt(d, 't1')
    const before = h.asked.length
    await pressTurnOn($)
    await untilAsked(h, before)
    await h.advance(0)
    expect(sets(h).length, 'stopped at the first failure').toBe(1)
    expect(h.files[LOG_PATH] ?? '').toContain('failed (exit 1: unknown key)')
  })

  test(`a whatsnext worker's own start is not a cold return: nothing logged, no note (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = setup(on)
    h.env.WHATSNEXT_COMPACT_WORKER = '1'
    const d = drive($, h)
    await d.start(surface)
    expect(coldLines(h)).toEqual([])
    await prompt(d, 't1')
    expect((await note($)).text).toBe('')
  })

  test(`whatsnext found by its plugin name with a marketplace too (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = setup(on, { commands: [{ name: 'whatsnext', description: 'x', source: 'plugin', plugin: 'whatsnext@whatsnext' }] })
    const d = drive($, h)
    await d.start(surface)
    await prompt(d, 't1')
    expect((await note($)).links, 'installed under a marketplace').toEqual([])
  })

  test(`a look-alike plugin name, or a user command called whatsnext, is not whatsnext (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = setup(on, { commands: [{ name: 'whatsnext-lite', description: 'x', source: 'plugin', plugin: 'whatsnext-lite' }, { name: 'whatsnext', description: 'x', source: 'user' }] })
    const d = drive($, h)
    await d.start(surface)
    await prompt(d, 't1')
    expect((await note($)).links.length, 'Get whatsnext still shows').toBe(1)
  })

  test(`the plugin list cannot be read: the person is not told to get what they may have (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = setup(on)
    h.commandsFail = true
    const d = drive($, h)
    await d.start(surface)
    await prompt(d, 't1')
    const n = await note($)
    expect(n.text).toBe('whatsnext could have saved $0.42 here.')
    expect(n.links).toEqual([])
  })

  test(`the note is for the first prompt only, and leaves when its turn ends (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = setup(on)
    const d = drive($, h)
    await d.start(surface)
    await prompt(d, 't1')
    expect((await note($)).text).toBe('whatsnext could have saved $0.42 here.')
    await d.complete('t1')
    expect((await note($)).text, 'the turn ended').toBe('')
    expect(await note($).then(n => n.links), 'with its link').toEqual([])
    await prompt(d, 't2')
    expect((await note($)).text, 'not again on the second prompt').toBe('')
  })

  test(`a slash command does not use up the note (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = setup(on)
    const d = drive($, h)
    await d.start(surface)
    await d.submit('/help')
    expect((await note($)).text).toBe('')
    await prompt(d, 't1')
    expect((await note($)).text).toBe('whatsnext could have saved $0.42 here.')
  })

  test(`⋯ has How it works and Don't show again, and no Compact now, Remind me later or Turn on (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = setup(on)
    const d = drive($, h)
    await d.start(surface)
    await prompt(d, 't1')
    const asked = await menu($, h, 'How it works')
    expect(asked[0]?.options, 'a page of the menu: the two entries and the band setting').toEqual(['How it works', "Don't show again", 'When the band shows…'])
    expect(h.logs, 'How it works says what whatsnext does, as a line in the transcript').toContain(HOW_IT_WORKS)
    expect(HOW_IT_WORKS).toBe('whatsnext compacts large, closed threads with Haiku before you come back, so reopening one re-reads a short summary, not the whole conversation. At most 5 a day; it skips threads that are open.')
    expect((await note($)).text, 'reading it leaves the note where it was').toBe('whatsnext could have saved $0.42 here.')
  })

  test(`Don't show again hides this note for good, keeps the report line, and nothing else (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = setup(on)
    const d = drive($, h)
    await d.start(surface)
    await prompt(d, 't1')
    await menu($, h, "Don't show again")
    expect((await note($)).text, 'gone now').toBe('')
    expect(h.store.whatsnextNoteHidden, 'kept in the store').toBe(true)
    expect(coldLines(h).length, 'the log line stays').toBe(1)
    expect((await d.command('report')).text ?? '', 'and so does the report line').toContain('Cold returns: 1 · whatsnext could have saved $0.42')
    await d.complete('t1')

    // Another cold resume, later: the saving is logged as before, and nothing is shown.
    resumed(h)
    await d.start(surface)
    expect(coldLines(h).length, 'a second line').toBe(2)
    await prompt(d, 't2')
    expect((await note($)).text, 'no note any more').toBe('')
    expect((await d.command('report')).text ?? '').toContain('Cold returns: 2 · whatsnext could have saved $0.84')
  })

  test(`× closes the note for its turn, and it does not come back on the turn's next band (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = setup(on)
    const d = drive($, h)
    await d.start(surface)
    await prompt(d, 't1')
    const ui = await mount($, surface)
    await ui.press({ key: 'close' })
    await ui.unmount()
    expect((await note($)).text).toBe('')
    await d.complete('t1')
    expect((await note($)).text).toBe('')
  })

  test(`Band set to Never: no note, and the saving is still logged (${surface})`, { timeoutMs: 30000, options: { band: 'off' } }, async ($, on) => {
    const h = setup(on, { stored: { band: 'off' } })
    const d = drive($, h)
    await d.start(surface)
    await prompt(d, 't1')
    expect((await note($)).text).toBe('')
    expect(coldLines(h)[0]?.compactSaving).toBe(0.4199)
  })

  test(`rightsize off: no note (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = setup(on)
    h.files['/home/test/.claude/mods/switches.json'] = '{"rightsize": false}'
    const d = drive($, h)
    await d.start(surface)
    await d.submit('continue')
    expect((await note($)).text).toBe('')
  })
}
