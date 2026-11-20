import { type TestBody, expect, test } from 'claude-code/testing'
import { RUNS_FILE, LOG_PATH, LEGACY_RUNS, NO_CHANGE, BIG_TURN, engine, drive, mount, rowText, OLD_PRICES, installWhatsnext, untilAsked, wnAnswer } from './testkit'
import { COMPACT_TEXT } from './whatsnext'

// P-42 (ADR 0073): handoff-style text for a compaction told nothing, a Wrap up button, a typed `wrap up` when whatsnext is not
// set up, two hints about whatsnext, and the idle stretches made from the run log at the first start.

for (const surface of ['desktop', 'terminal'] as const) {
  const MIN = 60_000
  const HOUR = 60 * MIN
  const DAY = 24 * HOUR
  /** 18:00 local on Friday 2027-01-15. */
  const EVENING = new Date(2027, 0, 15, 18, 0, 0, 0).getTime()
  const runLines = (h: ReturnType<typeof engine>) => (h.files[RUNS_FILE] ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>)
  const warmLines = (h: ReturnType<typeof engine>) => runLines(h).filter(l => l.kind === 'warm')
  const historyLines = (h: ReturnType<typeof engine>) => runLines(h).filter(l => l.kind === 'idle' && l.history === true)
  const log = (h: ReturnType<typeof engine>) => h.files[LOG_PATH] ?? ''
  const ASK = { beforeCold: 'ask' }

  type Over = {
    stored?: Record<string, string>
    /** whatsnext as the session finds it: set up in the project, installed but not set up, or not installed (the default). */
    whatsnext?: 'ready' | 'uninitialized'
    prices?: string
    usage?: typeof BIG_TURN
    store?: Record<string, unknown>
    /** Stretches already in the run log: how long, and how each ended. */
    stretches?: { gapMin: number; ended: 'warm' | 'cold' | 'never' }[]
    lines?: object[]
    off?: boolean
    inGit?: boolean
  }
  // Opus: 80,500 tokens in the conversation: $0.63 to come back cold, $0.32 to compact, a handoff note about $0.06.
  const session = async ($: unknown, on: Parameters<TestBody>[1], over: Over = {}) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', ...(over.stored ? { stored: over.stored } : {}), store: { installHintAt: undefined, initHinted: [], ...over.store } })
    h.now = EVENING
    h.virtual = true
    h.stepUsage = over.usage ?? BIG_TURN
    h.commands = []
    h.inGit = over.inGit !== false
    if (over.whatsnext) installWhatsnext(h, { initialized: over.whatsnext === 'ready' })
    if (over.off) h.files['/home/test/.claude/mods/switches.json'] = '{"rightsize": false}'
    if (over.prices) {
      h.pricesFile = over.prices
      delete h.env.CLAUDE_CODE_PROMPT_CACHE_TTL
      delete h.env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL
    }
    const lines = [
      ...(over.stretches ?? []).map((s, i) => ({ at: new Date(EVENING - (i + 1) * HOUR).toISOString(), kind: 'idle', session: 'earlier', gapMs: s.gapMin * MIN, ended: s.ended, hour: 9, weekday: 2, billing: 'api', ttl: HOUR, context: 80_500, cold: 0.6279 })),
      ...(over.lines ?? []),
    ]
    if (lines.length) h.files[LEGACY_RUNS] = `${lines.map(l => JSON.stringify(l)).join('\n')}\n`
    const d = drive($, h)
    await d.start(surface)
    return { h, d }
  }
  const turn = async (d: ReturnType<typeof drive>, id: string) => {
    await d.step(id)
    await d.complete(id)
  }
  const buttons = async ($: unknown) => {
    const ui = await mount($, surface)
    const found = await ui.findAll({ type: 'Button' })
    await ui.unmount()
    return found.map(b => [b.key, b.text])
  }
  const press = async ($: unknown, key: string) => {
    const ui = await mount($, surface)
    await ui.press({ key })
    await ui.unmount()
  }
  /** The cache row's line ('' when it is not drawn). */
  const cacheRow = async ($: unknown) => {
    const ui = await mount($, surface)
    const text = await rowText(ui, 'Cache')
    await ui.unmount()
    return text
  }
  const comeBack = async (d: ReturnType<typeof drive>, h: ReturnType<typeof engine>, text = 'continue') => {
    h.rating = NO_CHANGE
    await d.submit(text)
  }
  const rep = (n: number, gapMin: number, ended: 'warm' | 'cold' | 'never' = 'cold') => Array.from({ length: n }, () => ({ gapMin, ended }))
  /** 20 stretches that all come back at 5 hours: the compaction gate compacts at 57 minutes. */
  const GATE = rep(20, 300)
  /** Stretches on which the rule sends requests at 57 and 114 minutes. */
  const RULE = [...rep(10, 116), ...rep(10, 175)]
  /** Nobody comes back early: no request, and no compaction either. */
  const SHORT = rep(20, 30, 'warm')
  const menu = async ($: unknown, h: ReturnType<typeof engine>, choice: string) => {
    h.answers = { Options: choice }
    const before = h.asked.length
    const ui = await mount($, surface)
    await ui.press({ key: 'mode' })
    await untilAsked(h, before)
    await ui.unmount()
    return h.asked.slice(before)
  }
  const INSTALL = (saved: string) => `A whatsnext handoff note would have saved about ${saved} here. Install whatsnext (github.com/archid21/whatsnext) to save handoffs instead of compacting.`
  const INIT = (extra: string) => `whatsnext isn't set up in this project, so rightsize compacted instead (about ${extra} more). Run \`whatsnext init\` here to save handoff notes.`
  const compact = ($: unknown, trigger: string, extra: Record<string, unknown> = {}) =>
    ($ as { session: { compact: (x: unknown) => Promise<unknown> } }).session.compact({ trigger, messages: [{ role: 'user', text: 'The conversation.', toolUses: [] }], ...extra })
  const lastCompact = (h: ReturnType<typeof engine>) => h.compactCalls[h.compactCalls.length - 1] as { trigger: string; instructions?: string; agentId?: string }

  // ---- Handoff-style text for a compaction told nothing ---------------------------------------------------------
  // The text comes from the classic PreCompact hook (hooks/precompact.py, ADR 0077), checked by scripts/check-precompact.mjs.
  // The mod hook only observes: on Team and Enterprise logins Claude Code's built-in guard keeps it from running at all.

  test(`compact text: the session.compact hook passes every compaction on as it came (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h } = await session($, on)
    await compact($, 'manual')
    expect(lastCompact(h).instructions, 'a bare /compact: the PreCompact hook adds the text').toBeUndefined()
    await compact($, 'auto')
    expect(lastCompact(h).instructions).toBeUndefined()
    await compact($, 'manual', { instructions: 'keep the API notes' })
    expect(lastCompact(h).instructions).toBe('keep the API notes')
    expect(log(h)).not.toContain('compact (manual)')
  })

  test(`compact text: where $.session.compact is not available, rightsize's own compact runs /compact with its text (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on, { store: { installHintHidden: true } })
    h.compactThrows = 'rightsize: $.session.compact: not available in a headless (-p / SDK) session yet'
    await turn(d, 't1')
    const r = (await d.submit('wrap up')) as { drop?: string }
    expect(r.drop).toContain('rightsize: wrapped up with a compact')
    await h.advance(0)
    expect(h.commandRuns).toEqual([{ command: 'compact', args: COMPACT_TEXT }])
    expect(await cacheRow($)).toBe('Wrapped up: compacted the conversation.')
    expect(log(h)).toContain("compact: $.session.compact is not available here (rightsize: $.session.compact: not available in a headless (-p / SDK) session yet); running /compact with rightsize's own text instead")
    expect(h.fills, 'nothing to give back').toEqual([])
  })

  test(`compact text: when the wrap-up compact fails, "wrap up" goes back in the prompt box (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on, { store: { installHintHidden: true } })
    h.compactThrows = 'not available in a headless (-p / SDK) session yet'
    h.commandRunFails = 'the command could not run'
    await turn(d, 't1')
    await d.submit('wrap up')
    await h.advance(0)
    expect(h.fills).toEqual([{ text: 'wrap up', mode: 'replace' }])
    expect(h.toasts.some(t => t.includes('the wrap-up compact failed') && t.includes('"wrap up" is back in the prompt box'))).toBe(true)
    expect(log(h)).toContain('wrap up failed: ')
  })

  // ---- The Wrap up button ----------------------------------------------------------------------------------------

  test(`wrap up button: beside Extend 1 hour on the countdown row, from 5 minutes on a 1-hour cache (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on)
    await turn(d, 't1')
    expect(await buttons($), 'the Cache timer row until then: no Extend, no Wrap up').toEqual([['cold-compact', 'Compact now'], ['mode', '⋯'], ['close', '×']])
    await h.advance(5 * MIN)
    expect(await buttons($)).toEqual([['cold-extend', 'Extend 1 hour'], ['cold-wrap', 'Wrap up'], ['mode', '⋯'], ['close', '×']])
  })

  test(`wrap up button: with whatsnext it sends wrap up, ends the run, and the row says so (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on, { whatsnext: 'ready', stretches: RULE })
    await turn(d, 't1')
    await h.advance(5 * MIN)
    await press($, 'cold-wrap')
    expect(h.submitted.map(s => s.text)).toEqual(['wrap up'])
    expect(h.compactions).toBe(0)
    expect(await cacheRow($)).toBe('Wrapped up: saved a handoff note with whatsnext.')
    expect(await buttons($)).toEqual([['mode', '⋯'], ['close', '×']])
    expect(log(h)).toContain('wrap up: Wrap up pressed; submitted "wrap up" to whatsnext before the cache went cold; keep warm ended')
    // The wrap-up's own turn starts no new round, and no request, compaction or second handoff follows.
    await d.turnStart('t2', 'wrap up')
    await turn(d, 't2')
    await h.advance(6 * HOUR)
    expect({ forks: h.forks.length, compactions: h.compactions, submitted: h.submitted.length }).toEqual({ forks: 0, compactions: 0, submitted: 1 })
  })

  test(`wrap up button: without whatsnext it compacts with the handoff-style text, ends the run, and the row says so (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on, { stretches: RULE, store: { installHintHidden: true } })
    await turn(d, 't1')
    await h.advance(5 * MIN)
    await press($, 'cold-wrap')
    expect(h.compactions).toBe(1)
    expect(lastCompact(h).instructions).toBe(COMPACT_TEXT)
    expect(h.submitted).toEqual([])
    expect(await cacheRow($)).toBe('Wrapped up: compacted the conversation.')
    expect(log(h)).toContain("wrap up: Wrap up pressed; whatsnext cannot write a note here; compacting with rightsize's own text; keep warm ended")
    await h.advance(6 * HOUR)
    expect({ forks: h.forks.length, compactions: h.compactions, submitted: h.submitted.length }, 'no request, no gate compaction, no handoff').toEqual({ forks: 0, compactions: 1, submitted: 0 })
  })

  test(`wrap up button: whatsnext installed but not set up here counts as alone: it compacts (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on, { whatsnext: 'uninitialized', store: { initHinted: ['/repo'] } })
    await turn(d, 't1')
    await h.advance(5 * MIN)
    await press($, 'cold-wrap')
    expect(h.compactions).toBe(1)
    expect(h.submitted).toEqual([])
    expect(await cacheRow($)).toBe('Wrapped up: compacted the conversation.')
  })

  test(`wrap up button: still there after Extend 1 hour, and pressing it ends the extended run (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on, { stretches: RULE, store: { installHintHidden: true } })
    await turn(d, 't1')
    await h.advance(5 * MIN)
    await press($, 'cold-extend')
    expect(await buttons($)).toEqual([['cold-extend', 'Extend 1 hour'], ['cold-wrap', 'Wrap up'], ['cold-stop', 'Stop keeping warm'], ['mode', '⋯'], ['close', '×']])
    await press($, 'cold-wrap')
    expect(h.compactions).toBe(1)
    expect(log(h)).toContain('keep warm stopped (Wrap up pressed)')
    await h.advance(6 * HOUR)
    expect(h.forks.length).toBe(0)
    expect(await cacheRow($)).toBe('Wrapped up: compacted the conversation.')
  })

  test(`wrap up button: gone before the cache goes cold: the row ends at the last decision point (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on, { stretches: SHORT })
    await turn(d, 't1')
    await h.advance(5 * MIN)
    expect((await buttons($)).map(b => b[0])).toContain('cold-wrap')
    await h.advance(53 * MIN)
    expect(await buttons($), 'the row is gone before the expiry').toEqual([])
    await h.advance(HOUR)
    expect((await buttons($)).map(b => b[0]), 'once cold: the cold row, with no Wrap up').toEqual(['cold-fresh', 'mode', 'close'])
  })

  test(`wrap up button: never on a 5-minute cache (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on, { prices: OLD_PRICES, usage: { ...BIG_TURN, cache_read_input_tokens: 150_000 } })
    await turn(d, 't1')
    await h.advance(3 * MIN)
    expect(await buttons($), 'the timer row\'s Compact now, and no Wrap up').toEqual([['cold-compact', 'Compact now'], ['mode', '⋯'], ['close', '×']])
  })

  test(`wrap up button: pressed while a turn runs it waits, with a note (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on, { stretches: RULE })
    await turn(d, 't1')
    await h.advance(5 * MIN)
    await d.turnStart('t2', 'next')
    await press($, 'cold-wrap')
    expect(h.compactions + h.submitted.length).toBe(0)
  })

  // ---- A typed wrap up -------------------------------------------------------------------------------------------

  test(`typed wrap up: with rightsize alone it is dropped and compacted with the handoff-style text (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on, { store: { installHintHidden: true } })
    await turn(d, 't1')
    const r = (await d.submit('  Wrap Up ')) as { drop?: string }
    expect(r.drop).toContain('rightsize: wrapped up with a compact')
    expect(h.submitted, 'the prompt never reached the engine').toEqual([])
    await h.advance(0)
    expect(h.compactions).toBe(1)
    expect(lastCompact(h)).toMatchObject({ instructions: COMPACT_TEXT })
    expect(await cacheRow($)).toBe('Wrapped up: compacted the conversation.')
    expect(log(h)).toContain("wrap up: typed; whatsnext is not installed; dropped the prompt and compacting with rightsize's own text")
  })

  test(`typed wrap up: also on a 5-minute cache (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on, { prices: OLD_PRICES, usage: { ...BIG_TURN, cache_read_input_tokens: 150_000 } })
    await turn(d, 't1')
    const r = (await d.submit('wrap up')) as { drop?: string }
    expect(r.drop).toBeDefined()
    await h.advance(0)
    expect(h.compactions).toBe(1)
  })

  test(`typed wrap up: with whatsnext set up it goes through unchanged and nothing is compacted (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on, { whatsnext: 'ready' })
    await turn(d, 't1')
    h.rating = NO_CHANGE
    const r = (await d.submit('wrap up')) as { drop?: string; text?: string }
    expect(r.drop).toBeUndefined()
    expect(h.submitted.map(s => s.text)).toEqual(['wrap up'])
    await h.advance(0)
    expect(h.compactions).toBe(0)
  })

  test(`typed wrap up: whatsnext installed but not set up in this project counts as alone (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on, { whatsnext: 'uninitialized', store: { initHinted: ['/repo'] } })
    await turn(d, 't1')
    const r = (await d.submit('wrap up')) as { drop?: string }
    expect(r.drop).toBeDefined()
    expect(h.submitted).toEqual([])
    await h.advance(0)
    expect(h.compactions).toBe(1)
    expect(log(h)).toContain('wrap up: typed; whatsnext is not set up in this project')
  })

  test(`typed wrap up: whatsnext is asked again, so a project set up a minute ago is not compacted (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on, { whatsnext: 'uninitialized' })
    await turn(d, 't1')
    await h.advance(MIN)
    // `whatsnext init` ran since the turn ended.
    h.wnReply = { exitCode: 0, stdout: wnAnswer(false, true) }
    h.rating = NO_CHANGE
    const r = (await d.submit('wrap up')) as { drop?: string }
    expect(r.drop).toBeUndefined()
    expect(h.submitted.map(s => s.text)).toEqual(['wrap up'])
  })

  test(`typed wrap up: any other text and a turn running go through (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on)
    await turn(d, 't1')
    h.rating = NO_CHANGE
    for (const text of ['wrap up the PR', 'please wrap up', 'wrap  up']) expect(((await d.submit(text)) as { drop?: string }).drop, text).toBeUndefined()
    await d.turnStart('t2', 'continue')
    expect(((await d.submit('wrap up', 't2')) as { drop?: string }).drop, 'typed into a running turn').toBeUndefined()
    await h.advance(0)
    expect(h.compactions).toBe(0)
  })

  test(`typed wrap up: rightsize off lets it through (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on, { off: true })
    await turn(d, 't1')
    expect(((await d.submit('wrap up')) as { drop?: string }).drop).toBeUndefined()
    await h.advance(0)
    expect(h.compactions).toBe(0)
  })

  test(`typed wrap up: it cancels a keep-warm run: no request and no second compaction follow (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on, { stretches: RULE, store: { installHintHidden: true } })
    await turn(d, 't1')
    await h.advance(10 * MIN)
    await d.submit('wrap up')
    await h.advance(6 * HOUR)
    expect({ forks: h.forks.length, compactions: h.compactions }).toEqual({ forks: 0, compactions: 1 })
    expect(warmLines(h)).toEqual([])
  })

  // ---- The install hint --------------------------------------------------------------------------------------------

  test(`install hint: a compaction before the cache goes cold, with whatsnext not installed and a saving of $0.25 or more, says so on the row (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on, { stretches: GATE })
    await turn(d, 't1')
    await h.advance(57 * MIN)
    expect(h.compactions).toBe(1)
    expect(await cacheRow($)).toBe(`Compacted while the cache was warm. ${INSTALL('$0.27')}`)
    expect(h.store.installHintAt, 'the time is kept').toBe(EVENING + 57 * MIN)
    expect(log(h)).toContain('install hint: shown; a whatsnext handoff note would have saved $0.27')
  })

  test(`install hint: a saving under $0.25 shows nothing (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on, { stretches: GATE, usage: { ...BIG_TURN, cache_read_input_tokens: 69_500 } })
    await turn(d, 't1')
    await h.advance(57 * MIN)
    expect(h.compactions).toBe(1)
    expect(await cacheRow($), 'a note would have saved $0.23').toBe('Compacted while the cache was warm.')
    expect(h.store.installHintAt).toBeUndefined()
  })

  test(`install hint: not twice: the second compaction right after the first says nothing (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on, { stretches: GATE })
    await turn(d, 't1')
    await h.advance(57 * MIN)
    expect(await cacheRow($)).toContain('A whatsnext handoff note')
    await h.advance(10 * MIN)
    h.rating = NO_CHANGE
    await d.submit('continue')
    await turn(d, 't2')
    await h.advance(57 * MIN)
    expect(h.compactions).toBe(2)
    expect(await cacheRow($)).toBe('Compacted while the cache was warm.')
  })

  test(`install hint: within 30 days of the last one nothing shows; after 30 days it shows again (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on, { stretches: GATE, store: { installHintAt: EVENING - 29 * DAY } })
    await turn(d, 't1')
    await h.advance(57 * MIN)
    expect(h.compactions).toBe(1)
    expect(await cacheRow($)).toBe('Compacted while the cache was warm.')
    expect(h.store.installHintAt, 'the time is left as it was').toBe(EVENING - 29 * DAY)
  })

  test(`install hint: 31 days after the last one it shows again (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on, { stretches: GATE, store: { installHintAt: EVENING - 31 * DAY } })
    await turn(d, 't1')
    await h.advance(57 * MIN)
    expect(await cacheRow($)).toContain('A whatsnext handoff note')
    expect(h.store.installHintAt).toBe(EVENING + 57 * MIN)
  })

  test(`install hint: Don't show again in the ⋯ menu hides it for good (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on, { stretches: GATE })
    await turn(d, 't1')
    await h.advance(57 * MIN)
    const asked = await menu($, h, "Don't show again")
    expect(asked[0]?.options).toEqual(["Don't show again", 'When the band shows…'])
    expect(h.stored.tips, 'the Tips row is off').toBe('off')
    expect(await cacheRow($), 'the hint is gone').toBe('')
    expect(log(h)).toContain('install hint: hidden')
  })

  test(`install hint: never after Don't show again, however long ago the last one was (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on, { stretches: GATE, store: { installHintHidden: true, installHintAt: EVENING - 90 * DAY } })
    await turn(d, 't1')
    await h.advance(57 * MIN)
    expect(h.compactions).toBe(1)
    expect(await cacheRow($)).toBe('Compacted while the cache was warm.')
  })

  test(`install hint: a Wrap up press without whatsnext carries it (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on, { stretches: RULE })
    await turn(d, 't1')
    await h.advance(5 * MIN)
    await press($, 'cold-wrap')
    expect(await cacheRow($)).toBe(`Wrapped up: compacted the conversation. ${INSTALL('$0.27')}`)
  })

  test(`install hint: a typed wrap up without whatsnext carries it (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on)
    await turn(d, 't1')
    await d.submit('wrap up')
    await h.advance(0)
    expect(await cacheRow($)).toBe(`Wrapped up: compacted the conversation. ${INSTALL('$0.27')}`)
  })

  test(`install hint: coming back to a cold cache shows it when that turn ends, with the saving over a cold return (${surface})`, { timeoutMs: 30000, options: { ...ASK, cacheTimer: 'off' } }, async ($, on) => {
    const { h, d } = await session($, on, { stored: ASK })
    await turn(d, 't1')
    await h.advance(130 * MIN)
    await comeBack(d, h)
    expect(await cacheRow($), 'not before the turn ends').toBe('')
    await turn(d, 't2')
    expect(await cacheRow($)).toBe(INSTALL('$0.57'))
    expect(log(h)).toContain('install hint: shown; a whatsnext handoff note would have saved $0.57')
  })

  test(`install hint: a return to a warm cache shows nothing (${surface})`, { timeoutMs: 30000, options: { ...ASK, cacheTimer: 'off' } }, async ($, on) => {
    const { h, d } = await session($, on, { stored: ASK })
    await turn(d, 't1')
    await h.advance(20 * MIN)
    await comeBack(d, h)
    await turn(d, 't2')
    expect(await cacheRow($)).toBe('')
  })

  test(`install hint: a cold return that a note would have saved under $0.25 on shows nothing (${surface})`, { timeoutMs: 30000, options: { ...ASK, cacheTimer: 'off' } }, async ($, on) => {
    const { h, d } = await session($, on, { stored: ASK, usage: { ...BIG_TURN, cache_read_input_tokens: 29_500 } })
    await turn(d, 't1')
    await h.advance(130 * MIN)
    await comeBack(d, h)
    await turn(d, 't2')
    expect(await cacheRow($), 'a cold return of $0.23 less a note of $0.05 is $0.19').toBe('')
    expect(h.store.installHintAt).toBeUndefined()
  })

  test(`install hint: a return after the conversation was compacted while away shows nothing (${surface})`, { timeoutMs: 30000, options: { ...ASK, cacheTimer: 'off' } }, async ($, on) => {
    const { h, d } = await session($, on, { stored: ASK })
    await turn(d, 't1')
    await compact($, 'manual', { instructions: 'x' })
    await h.advance(130 * MIN)
    await comeBack(d, h)
    await turn(d, 't2')
    expect(await cacheRow($)).toBe('')
  })

  test(`install hint: not when whatsnext is installed (${surface})`, { timeoutMs: 30000, options: { ...ASK, cacheTimer: 'off' } }, async ($, on) => {
    const { h, d } = await session($, on, { stored: ASK, whatsnext: 'uninitialized', store: { initHinted: ['/repo'] } })
    await turn(d, 't1')
    await h.advance(130 * MIN)
    await comeBack(d, h)
    await turn(d, 't2')
    expect(await cacheRow($)).toBe('')
  })

  test(`install hint: not while the band is off (${surface})`, { timeoutMs: 30000, options: { band: 'off' } }, async ($, on) => {
    const { h, d } = await session($, on, { stored: { band: 'off' }, stretches: GATE })
    await turn(d, 't1')
    await h.advance(57 * MIN)
    expect(h.compactions).toBe(1)
    expect(h.store.installHintAt, 'not used up').toBeUndefined()
  })

  // ---- The init hint -----------------------------------------------------------------------------------------------

  test(`init hint: Tips off keeps it off the row and keeps no project (${surface})`, { timeoutMs: 30000, options: { tips: 'off' } }, async ($, on) => {
    const { h, d } = await session($, on, { whatsnext: 'uninitialized', stored: { tips: 'off' } })
    await turn(d, 't1')
    await h.advance(5 * MIN)
    await press($, 'cold-wrap')
    expect(await cacheRow($)).toBe('Wrapped up: compacted the conversation.')
    expect(h.store.initHinted).toEqual([])
  })

  test(`init hint: whatsnext installed but not set up, in a git project, after a Wrap up press that compacted: once per project (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on, { whatsnext: 'uninitialized' })
    await turn(d, 't1')
    await h.advance(5 * MIN)
    await press($, 'cold-wrap')
    expect(await cacheRow($)).toBe(`Wrapped up: compacted the conversation. ${INIT('$0.27')}`)
    expect(h.store.initHinted).toEqual(['/repo'])
    expect(log(h)).toContain('init hint: shown for /repo')
    // The same project again, a later break: no hint.
    await comeBack(d, h)
    await turn(d, 't2')
    await h.advance(5 * MIN)
    await press($, 'cold-wrap')
    expect(h.compactions).toBe(2)
    expect(await cacheRow($)).toBe('Wrapped up: compacted the conversation.')
    // Another project: shown.
    h.cwd = '/other'
    await d.start(surface)
    await turn(d, 't3')
    await h.advance(5 * MIN)
    await press($, 'cold-wrap')
    expect(await cacheRow($)).toBe(`Wrapped up: compacted the conversation. ${INIT('$0.27')}`)
    expect(h.store.initHinted).toEqual(['/repo', '/other'])
  })

  test(`init hint: a typed wrap up carries it (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on, { whatsnext: 'uninitialized' })
    await turn(d, 't1')
    await d.submit('wrap up')
    await h.advance(0)
    expect(await cacheRow($)).toBe(`Wrapped up: compacted the conversation. ${INIT('$0.27')}`)
  })

  test(`init hint: the compaction before the cache goes cold carries it (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on, { whatsnext: 'uninitialized', stretches: GATE })
    await turn(d, 't1')
    await h.advance(57 * MIN)
    expect(h.compactions).toBe(1)
    expect(await cacheRow($)).toBe(`Compacted while the cache was warm. ${INIT('$0.27')}`)
  })

  test(`init hint: not outside a git repository (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on, { whatsnext: 'uninitialized', inGit: false })
    await turn(d, 't1')
    await h.advance(5 * MIN)
    await press($, 'cold-wrap')
    expect(h.compactions).toBe(1)
    expect(await cacheRow($)).toBe('Wrapped up: compacted the conversation.')
    expect(h.store.initHinted).toEqual([])
  })

  test(`init hint: not when whatsnext is set up: a note is saved, not a compaction (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on, { whatsnext: 'ready' })
    await turn(d, 't1')
    await h.advance(5 * MIN)
    await press($, 'cold-wrap')
    expect(h.compactions).toBe(0)
    expect(await cacheRow($)).toBe('Wrapped up: saved a handoff note with whatsnext.')
    expect(h.store.initHinted).toEqual([])
  })

  // ---- The idle stretches made from the run log -------------------------------------------------------------------

  /** A run line: the prompt went in at `submitted`, the turn ended `ms` later. */
  const run = (sess: string, submitted: Date, ms = 2 * MIN, over: Record<string, unknown> = {}) => ({ at: new Date(submitted.getTime() + ms).toISOString(), kind: 'run', session: sess, submittedAt: submitted.toISOString(), context: 60_000, ...over })
  // Wednesday 2027-01-13, local times.
  const at = (hour: number, minute = 0, day = 13) => new Date(2027, 0, day, hour, minute, 0, 0)

  test(`history: the first start makes idle lines from the run log: returned stretches ended cold, a never for an old last run (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const lines = [
      run('s1', at(9, 0)), // ends 9:02
      run('s1', at(9, 32)), // 30 minutes away: a stretch; ends 9:34
      run('s1', at(9, 36), 2 * MIN, { after: { five_hour: 40 } }), // 2 minutes away: a pause, no stretch; ends 9:38; subscription
      run('s1', at(14, 0), 2 * MIN, { contextEnd: 90_000 }), // 4 h 22 min away; ends 14:02; the last: over 8 h before the start
      { at: at(9, 20).toISOString(), kind: 'warm', session: 's1', overhead: 0.1 },
      run('s2', new Date(EVENING - 3 * HOUR)), // the last run, 3 h before the start: no never stretch
      run('s3', at(10, 0), MIN, { aborted: true }),
      run('s4', new Date(EVENING - 40 * DAY)),
    ]
    const { h } = await session($, on, { lines, store: { backfilled: false } })
    const idle = historyLines(h).map(l => ({ ...l, at: undefined }))
    const lastEnd = at(14, 2).getTime()
    expect(idle).toEqual([
      { at: undefined, kind: 'idle', session: 's1', gapMs: 30 * MIN, ended: 'cold', hour: 9, weekday: 3, billing: 'api', context: 60_000, cold: 0 },
      { at: undefined, kind: 'idle', session: 's1', gapMs: 4 * HOUR + 22 * MIN, ended: 'cold', hour: 9, weekday: 3, billing: 'subscription', context: 60_000, cold: 0 },
      { at: undefined, kind: 'idle', session: 's1', gapMs: EVENING - lastEnd, ended: 'never', hour: 14, weekday: 3, billing: 'api', context: 90_000, cold: 0 },
    ].map(l => ({ ...l, history: true })))
    expect(h.store.backfilled).toBe(true)
    expect(log(h)).toContain('idle stretches: 3 made from earlier runs (1 never returned)')
    // The lines are stamped with when the stretch ended: a return at the next prompt, a never at the end of the 8-hour cap.
    expect(historyLines(h).map(l => l.at)).toEqual([at(9, 32), at(14, 0), new Date(lastEnd + 8 * HOUR)].map(x => x.toISOString()))
  })

  test(`history: made once: a second start writes none, and an install that has history lines makes none (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const lines = [run('s1', at(9, 0)), run('s1', at(10, 0))]
    const { h, d } = await session($, on, { lines, store: { backfilled: false } })
    expect(historyLines(h).length).toBe(2)
    await d.start(surface)
    expect(historyLines(h).length, 'the flag is set').toBe(2)
    h.store.backfilled = false
    await d.start(surface)
    expect(historyLines(h).length, 'history lines already there').toBe(2)
    expect(h.store.backfilled).toBe(true)
  })

  test(`history: an empty run log makes none and is still done (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h } = await session($, on, { store: { backfilled: false } })
    expect(historyLines(h)).toEqual([])
    expect(h.store.backfilled).toBe(true)
  })

  test(`history: a session with only backfilled history is past the start-up of 20 stretches (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    // 21 runs an hour apart, two days ago: 20 returns and a last run that never returned.
    const lines = Array.from({ length: 21 }, (_, i) => run('old', new Date(EVENING - 2 * DAY + i * HOUR)))
    const { h, d } = await session($, on, { lines, store: { backfilled: false } })
    expect(historyLines(h).length).toBe(21)
    await turn(d, 't1')
    expect(log(h)).toContain('keep warm while it pays: 21 idle stretches on record (api)')
    expect(log(h)).not.toContain('too few for a chance')
  })

  test(`history: another billing's stretches are not this session's (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const lines = Array.from({ length: 21 }, (_, i) => run('old', new Date(EVENING - 2 * DAY + i * HOUR), 2 * MIN, { after: { five_hour: 10 } }))
    const { h, d } = await session($, on, { lines, store: { backfilled: false } })
    expect(historyLines(h).every(l => l.billing === 'subscription')).toBe(true)
    await turn(d, 't1')
    expect(log(h)).toContain('keep warm while it pays: 0 idle stretches on record (api)')
  })
}
