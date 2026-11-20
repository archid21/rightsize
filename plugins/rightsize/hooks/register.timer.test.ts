import { type TestBody, expect, test } from 'claude-code/testing'
import { LOG_PATH, BIG_TURN, NO_CHANGE, engine, drive, mount, rowText, WHATSNEXT_CMDS, installWhatsnext, freshAnswer } from './testkit'

// P-80 (ADR 0094, group 3): the Cache timer row after every main-chat turn, the cold-compact tip on every path, and the tip for
// a reopened chat that has gone cold. Runs on a virtual clock, as the keep-warm tests do.

for (const surface of ['desktop', 'terminal'] as const) {
  const MIN = 60_000
  const HOUR = 60 * MIN
  /** 18:00 local on Friday 2027-01-15. */
  const EVENING = new Date(2027, 0, 15, 18, 0, 0, 0).getTime()
  /** A turn that leaves the conversation at exactly `tokens` (BIG_TURN's 500 other tokens counted). */
  const turnOf = (tokens: number) => ({ ...BIG_TURN, cache_read_input_tokens: tokens - 500 })
  const LOW = 'Goes cold at 7:00 PM · coming back then costs ~$0.16 · context 10%'

  type Over = {
    tokens?: number
    stored?: Record<string, string>
    whatsnext?: boolean
    model?: string
    liveModel?: string
    store?: Record<string, unknown>
    window?: number
    contextTokens?: number
    settings?: Record<string, unknown>
    env?: Record<string, string>
    fork?: Record<string, number>
  }
  const session = async ($: unknown, on: Parameters<TestBody>[1], over: Over = {}) => {
    const h = engine(on, { model: over.model ?? 'claude-opus-5-5', effort: 'medium', ...(over.stored ? { stored: over.stored } : {}), ...(over.store ? { store: over.store } : {}) })
    h.now = EVENING
    h.virtual = true
    h.rating = NO_CHANGE
    h.stepUsage = turnOf(over.tokens ?? 20_000)
    h.commands = []
    if (over.whatsnext) {
      h.commands = WHATSNEXT_CMDS
      installWhatsnext(h)
    }
    if (over.liveModel !== undefined) h.liveModel = over.liveModel
    if (over.fork) h.forkUsage = over.fork
    if (over.window !== undefined) h.contextWindow = over.window
    if (over.contextTokens !== undefined) h.contextTokens = over.contextTokens
    Object.assign(h.settings, over.settings ?? {})
    Object.assign(h.env, over.env ?? {})
    const d = drive($, h)
    await d.start(surface)
    return { h, d }
  }
  const turn = async (d: ReturnType<typeof drive>, id: string) => {
    await d.step(id)
    await d.complete(id)
  }
  /** The cache row, its buttons, and how many Cache rows the band draws. */
  const cacheRow = async ($: unknown) => {
    const ui = await mount($, surface)
    const text = await rowText(ui, 'Cache')
    const buttons = (await ui.findAll({ type: 'Button' })).map(b => [b.key, b.text])
    const rows = (await ui.findAll({ type: 'Text' })).filter(t => t.text === 'Cache' || t.text === 'rightsize · Cache').length
    await ui.unmount()
    return { text, buttons, rows }
  }
  const press = async ($: unknown, key: string) => {
    const ui = await mount($, surface)
    await ui.press({ key })
    await ui.unmount()
  }
  const logOf = (h: ReturnType<typeof engine>) => h.files[LOG_PATH] ?? ''
  const TIP = 'Cache is cold. Compact on Sonnet first to save'
  /** 180K tokens: big enough that a compaction on Sonnet saves the Idle warning amount, under Claude Code's idle-compact size. */
  const BIG = 180_000

  // ---- The timer row -------------------------------------------------------------------------------------------

  test(`timer: a small conversation (20K tokens) still gets the Cache row at the turn's end, with Compact now (${surface})`, { timeoutMs: 30000, options: {} }, async ($, on) => {
    const { h, d } = await session($, on)
    expect((await cacheRow($)).text, 'nothing before a turn ends').toBe('')
    await turn(d, 't1')
    const r = await cacheRow($)
    expect(r.text, 'a clock time, 12-hour, not a countdown').toBe(LOW)
    expect(r.buttons.filter(b => String(b[0]).startsWith('cold-')), 'no whatsnext: Compact now alone').toEqual([['cold-compact', 'Compact now']])
    expect(h.compactions + h.submitted.length + h.forks.length, 'it only shows: nothing runs').toBe(0)
    expect(logOf(h)).toContain(`cache timer: ${LOW}`)
  })

  test(`timer: with whatsnext set up it also has Save handoff note, which saves the note (${surface})`, { timeoutMs: 30000, options: {} }, async ($, on) => {
    const { h, d } = await session($, on, { whatsnext: true })
    await turn(d, 't1')
    const r = await cacheRow($)
    expect(r.text).toBe(LOW)
    expect(r.buttons.filter(b => String(b[0]).startsWith('cold-'))).toEqual([['cold-compact', 'Compact now'], ['cold-handoff', 'Save handoff note']])
    await press($, 'cold-handoff')
    expect(h.submitted.map(s => s.text), 'the existing handoff: whatsnext\'s wrap-up').toEqual(['wrap up'])
  })

  test(`timer: Compact now compacts (${surface})`, { timeoutMs: 30000, options: {} }, async ($, on) => {
    const { h, d } = await session($, on)
    await turn(d, 't1')
    await press($, 'cold-compact')
    expect(h.compactions).toBe(1)
  })

  test(`timer: a bigger conversation shows its own cost and percent; a turn that ran under the same row replaces it (${surface})`, { timeoutMs: 30000, options: {} }, async ($, on) => {
    const { d } = await session($, on, { tokens: 100_000 })
    await turn(d, 't1')
    expect((await cacheRow($)).text).toBe('Goes cold at 7:00 PM · coming back then costs ~$0.78 · context 50%')
  })

  test(`timer: it shows on Sonnet too, at any size (${surface})`, { timeoutMs: 30000, options: {} }, async ($, on) => {
    const { d } = await session($, on, { model: 'claude-sonnet-5-5' })
    await turn(d, 't1')
    expect((await cacheRow($)).text).toMatch(/^Goes cold at 7:00 PM · coming back then costs ~\$0\.\d\d · context 10%$/)
  })

  test(`timer: on a subscription with no usage record yet, the cost is labelled API-equivalent (${surface})`, { timeoutMs: 30000, options: { billing: 'subscription' } }, async ($, on) => {
    const { d } = await session($, on, { stored: { billing: 'subscription' } })
    await turn(d, 't1')
    expect((await cacheRow($)).text).toBe('Goes cold at 7:00 PM · coming back then costs ~$0.16 API-equivalent · context 10%')
  })

  test(`timer: a subagent's turn end draws nothing (${surface})`, { timeoutMs: 30000, options: {} }, async ($, on) => {
    const { d } = await session($, on)
    await d.step('t1')
    await d.answer('agent-helper')
    expect((await cacheRow($)).text, 'a helper ending is not the main chat ending').toBe('')
    await d.complete('t1')
    expect((await cacheRow($)).text).toBe(LOW)
  })

  test(`timer: a prompt takes the row away, and the next turn's end draws it again (${surface})`, { timeoutMs: 30000, options: {} }, async ($, on) => {
    const { h, d } = await session($, on)
    await turn(d, 't1')
    await h.advance(10 * MIN)
    await d.submit('continue')
    expect((await cacheRow($)).text).toBe('')
    await turn(d, 't2')
    expect((await cacheRow($)).text, 'counted from the new turn\'s end').toBe('Goes cold at 7:10 PM · coming back then costs ~$0.16 · context 10%')
  })

  test(`timer: Cache timer off hides the line (${surface})`, { timeoutMs: 30000, options: { cacheTimer: 'off' } }, async ($, on) => {
    const { h, d } = await session($, on, { stored: { cacheTimer: 'off' } })
    await turn(d, 't1')
    expect((await cacheRow($)).text).toBe('')
    expect(logOf(h)).not.toContain('cache timer:')
  })

  test(`timer: Cache timer off hides only the line: an offer still shows (${surface})`, { timeoutMs: 30000, options: { cacheTimer: 'off', beforeCold: 'ask' } }, async ($, on) => {
    const { h, d } = await session($, on, { tokens: 80_500, stored: { cacheTimer: 'off', beforeCold: 'ask' } })
    await turn(d, 't1')
    expect((await cacheRow($)).text).toBe('')
    await h.advance(5 * MIN)
    expect((await cacheRow($)).text).toContain('Goes cold in 55 min')
  })

  test(`timer: Cache off hides everything, the timer too (${surface})`, { timeoutMs: 30000, options: { cache: 'off' } }, async ($, on) => {
    const { d } = await session($, on, { stored: { cache: 'off' } })
    await turn(d, 't1')
    expect((await cacheRow($)).text).toBe('')
  })

  test(`timer: the band off draws no row (${surface})`, { timeoutMs: 30000, options: { band: 'off' } }, async ($, on) => {
    const { d } = await session($, on, { stored: { band: 'off' } })
    await turn(d, 't1')
    expect((await cacheRow($)).text).toBe('')
  })

  test(`timer: switching Cache timer off in /config takes the line off at once (${surface})`, { timeoutMs: 30000, options: {} }, async ($, on) => {
    const { d } = await session($, on)
    await turn(d, 't1')
    expect((await cacheRow($)).text).toBe(LOW)
    await d.config('cacheTimer', 'off')
    expect((await cacheRow($)).text).toBe('')
  })

  // ---- Keep warm, offers and the context warning own or join the one row ---------------------------------------

  test(`row: a keep-warm run's row replaces the timer line: one Cache row (${surface})`, { timeoutMs: 30000, options: { beforeCold: 'keep warm 2 h' } }, async ($, on) => {
    const { d } = await session($, on, { tokens: 80_500, stored: { beforeCold: 'keep warm 2 h' } })
    await turn(d, 't1')
    const r = await cacheRow($)
    expect(r.text).toBe('Warm until 20:00 · $0.00')
    expect(r.rows).toBe(1)
  })

  test(`row: the keep-warm offer replaces the timer line when it shows, 5 minutes after the turn on a 1-hour cache (${surface})`, { timeoutMs: 30000, options: { beforeCold: 'ask' } }, async ($, on) => {
    const { h, d } = await session($, on, { tokens: 80_500, stored: { beforeCold: 'ask' } })
    await turn(d, 't1')
    expect((await cacheRow($)).text, 'the timer until then').toBe('Goes cold at 7:00 PM · coming back then costs ~$0.63 · context 40%')
    await h.advance(5 * MIN)
    const r = await cacheRow($)
    expect(r.text).toBe('Goes cold in 55 min ▰▰▰▰▰▰▰▰▰▱ (19:00) · coming back after costs about $0.63')
    expect(r.rows).toBe(1)
  })

  test(`row: the context warning joins the timer row instead of taking a row of its own (${surface})`, { timeoutMs: 30000, options: {} }, async ($, on) => {
    const { h, d } = await session($, on, { tokens: 120_000, contextTokens: 120_000 })
    await turn(d, 't1')
    const r = await cacheRow($)
    expect(r.text).toBe('Goes cold at 7:00 PM · coming back then costs ~$0.94. Context is 60% full (120K of 200K tokens). A compact now makes every later turn cheaper.')
    expect(r.rows, 'one Cache row').toBe(1)
    expect(r.buttons.filter(b => String(b[0]).startsWith('cold-')), 'the context warning\'s own Compact now, no second one').toEqual([['cold-size-compact', 'Compact now']])
    expect(logOf(h)).toContain('context warning: shown at 60%')
  })

  test(`row: with whatsnext, the joined row also has Save handoff note (${surface})`, { timeoutMs: 30000, options: {} }, async ($, on) => {
    const { d } = await session($, on, { tokens: 120_000, contextTokens: 120_000, whatsnext: true, window: 200_000 })
    await turn(d, 't1')
    const r = await cacheRow($)
    expect(r.text).toContain('Context is 60% full')
    expect(r.buttons.filter(b => String(b[0]).startsWith('cold-')).map(b => b[1]).slice(0, 1)).toEqual(['Compact now'])
    expect(r.rows).toBe(1)
  })

  // ---- Claude Code's idle compact ---------------------------------------------------------------------------

  test(`idle compact: the row says when Claude Code compacts, not when the cache goes cold, and offers no keep warm (${surface})`, { timeoutMs: 30000, options: { beforeCold: 'keep warm 8 h' } }, async ($, on) => {
    const { h, d } = await session($, on, { tokens: 250_000, window: 1_000_000, stored: { beforeCold: 'keep warm 8 h' } })
    await turn(d, 't1')
    const r = await cacheRow($)
    expect(r.text).toBe('Claude Code compacts this at about 6:54 PM · context 25%')
    expect(r.buttons.filter(b => String(b[0]).startsWith('cold-')), 'no whatsnext: Compact now alone').toEqual([['cold-compact', 'Compact now']])
    await h.advance(8 * HOUR)
    expect(h.forks.length, 'no keep-warm request').toBe(0)
    expect(h.submitted.length, 'no whatsnext: no handoff note').toBe(0)
  })

  test(`idle compact: with whatsnext a handoff note is saved 3 minutes before Claude Code compacts (${surface})`, { timeoutMs: 30000, options: {} }, async ($, on) => {
    const { h, d } = await session($, on, { tokens: 250_000, window: 1_000_000, whatsnext: true })
    await turn(d, 't1')
    const r = await cacheRow($)
    expect(r.text).toBe('Claude Code compacts this at about 6:54 PM · context 25%')
    expect(r.buttons.filter(b => String(b[0]).startsWith('cold-'))).toEqual([['cold-compact', 'Compact now'], ['cold-handoff', 'Save handoff note']])
    await h.advance(50 * MIN)
    expect(h.submitted.length, 'not yet').toBe(0)
    await h.advance(MIN)
    expect(h.submitted.map(s => s.text), 'at 51 minutes, before the compact at 54').toEqual(['wrap up'])
    expect(h.compactions, 'rightsize leaves the compact to Claude Code').toBe(0)
  })

  test(`idle compact: below the threshold the row is the usual timer (${surface})`, { timeoutMs: 30000, options: {} }, async ($, on) => {
    const { d } = await session($, on, { tokens: 150_000 })
    await turn(d, 't1')
    expect((await cacheRow($)).text).toMatch(/^Goes cold at 7:00 PM/)
  })

  test(`idle compact: with idle compaction off in Claude Code the row is the usual timer (${surface})`, { timeoutMs: 30000, options: {} }, async ($, on) => {
    const { d } = await session($, on, { tokens: 250_000, window: 1_000_000, settings: { idleCompaction: false } })
    await turn(d, 't1')
    expect((await cacheRow($)).text).toMatch(/^Goes cold at 7:00 PM/)
  })

  // ---- The cold-compact tip on every path -------------------------------------------------------------------

  test(`tip: with whatsnext and an offer nobody answered, the tip shows once the cache has gone cold (${surface})`, { timeoutMs: 30000, options: { beforeCold: 'ask' } }, async ($, on) => {
    const { h, d } = await session($, on, { tokens: BIG, whatsnext: true, stored: { beforeCold: 'ask' } })
    await turn(d, 't1')
    await h.advance(59 * MIN)
    expect(logOf(h), 'not while the cache lives').not.toContain('cold-compact tip: offered')
    await h.advance(2 * MIN)
    expect(logOf(h)).toContain('cold-compact tip: offered')
    expect((await cacheRow($)).text).toContain(TIP)
    expect(h.submitted.length, 'nothing was sent: the offer went unanswered').toBe(0)
  })

  test(`tip: after a keep-warm run ends, the tip shows when the cache it kept warm has gone cold (${surface})`, { timeoutMs: 30000, options: { beforeCold: 'keep warm 2 h' } }, async ($, on) => {
    const { h, d } = await session($, on, { tokens: BIG, stored: { beforeCold: 'keep warm 2 h' }, fork: { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: BIG - 500, cache_creation_input_tokens: 0 } })
    await turn(d, 't1')
    await h.advance(2 * HOUR + 30 * MIN)
    expect(h.forks.length, 'the run sent its requests').toBe(2)
    expect(logOf(h), 'the last request at 1:54 kept it warm to 2:54').not.toContain('cold-compact tip: offered')
    await h.advance(30 * MIN)
    expect(logOf(h)).toContain('cold-compact tip: offered')
    expect((await cacheRow($)).text).toContain(TIP)
  })

  test(`tip: with Before the cache goes cold off, the tip still shows when the cache goes cold (${surface})`, { timeoutMs: 30000, options: { beforeCold: 'off' } }, async ($, on) => {
    const { h, d } = await session($, on, { tokens: BIG, stored: { beforeCold: 'off' } })
    await turn(d, 't1')
    expect((await cacheRow($)).text).toMatch(/^Goes cold at 7:00 PM/)
    await h.advance(HOUR + MIN)
    expect((await cacheRow($)).text).toContain(TIP)
  })

  test(`tip: the default (keep warm while it pays), with whatsnext, shows it after the handoff note (${surface})`, { timeoutMs: 30000, options: {} }, async ($, on) => {
    const { h, d } = await session($, on, { tokens: BIG, whatsnext: true })
    await turn(d, 't1')
    await h.advance(5 * HOUR)
    expect(logOf(h)).toContain('cold-compact tip: offered')
    expect((await cacheRow($)).text).toContain(TIP)
  })

  test(`tip: a prompt before the cache goes cold cancels it (${surface})`, { timeoutMs: 30000, options: { beforeCold: 'off' } }, async ($, on) => {
    const { h, d } = await session($, on, { tokens: BIG, stored: { beforeCold: 'off' } })
    await turn(d, 't1')
    await h.advance(30 * MIN)
    await d.submit('continue')
    await h.advance(2 * HOUR)
    expect(logOf(h)).not.toContain('cold-compact tip: offered')
    expect((await cacheRow($)).text).toBe('')
  })

  test(`tip: a conversation on Sonnet gets no tip and no timer waits for one (${surface})`, { timeoutMs: 30000, options: { beforeCold: 'off' } }, async ($, on) => {
    const sonnet = await session($, on, { tokens: BIG, model: 'claude-sonnet-5-5', stored: { beforeCold: 'off' } })
    await turn(sonnet.d, 't1')
    await sonnet.h.advance(2 * HOUR)
    expect(logOf(sonnet.h)).not.toContain('cold-compact tip: offered')
    expect((await cacheRow($)).text, 'the cold row instead').toMatch(/^Went cold at 7:00 PM\. OK to continue here \(~\$/)
    expect(sonnet.h.sleepers.length, 'no timer waits after it').toBe(0)
  })

  test(`tip: with the band off nothing shows and no timer waits (${surface})`, { timeoutMs: 30000, options: { beforeCold: 'off', band: 'off' } }, async ($, on) => {
    const { h, d } = await session($, on, { tokens: BIG, stored: { beforeCold: 'off', band: 'off' } })
    await turn(d, 't1')
    await h.advance(2 * HOUR)
    expect(logOf(h)).not.toContain('cold-compact tip: offered')
    expect(h.sleepers.length).toBe(0)
  })

  test(`tip: not while Claude Code's idle compact will shrink the conversation first (${surface})`, { timeoutMs: 30000, options: { beforeCold: 'off' } }, async ($, on) => {
    const { h, d } = await session($, on, { tokens: 250_000, window: 1_000_000, stored: { beforeCold: 'off' } })
    await turn(d, 't1')
    await h.advance(3 * HOUR)
    expect(logOf(h)).not.toContain('cold-compact tip: offered')
  })

  test(`tip: Don't show again keeps it hidden on every path (${surface})`, { timeoutMs: 30000, options: { beforeCold: 'off' } }, async ($, on) => {
    const { h, d } = await session($, on, { tokens: BIG, stored: { beforeCold: 'off' }, store: { coldTipHidden: true } })
    await turn(d, 't1')
    await h.advance(2 * HOUR)
    expect(logOf(h)).not.toContain('cold-compact tip: offered')
  })

  // ---- The cold row: a small chat once the cache has gone cold ---------------------------------------------------

  const COLD = 'Went cold at 7:00 PM. OK to continue here (~$0.16). New topic? Clear chat.'
  const COLD_OFFER = `${COLD} Pausing this work? Save a handoff first.`
  const COLD_SAVED = 'Went cold at 7:00 PM. OK to continue here (~$0.16). Handoff saved: Clear chat for a new topic.'
  const coldButtons = async ($: unknown) => (await cacheRow($)).buttons.filter(b => String(b[0]).startsWith('cold-'))

  test(`cold row: a small chat's timer row turns past tense when the cache goes cold, with Clear chat alone (${surface})`, { timeoutMs: 30000, options: { beforeCold: 'off' } }, async ($, on) => {
    const { h, d } = await session($, on, { stored: { beforeCold: 'off' } })
    await turn(d, 't1')
    await h.advance(59 * MIN)
    expect((await cacheRow($)).text, 'still warm: the timer row').toBe(LOW)
    await h.advance(2 * MIN)
    const r = await cacheRow($)
    expect(r.text).toBe(COLD)
    expect(r.rows).toBe(1)
    expect(await coldButtons($), 'no Compact now: it would cost the same reload').toEqual([['cold-fresh', 'Clear chat']])
    expect(logOf(h)).toContain(`cache timer: ${COLD}`)
    expect(logOf(h)).not.toContain('cold-compact tip: offered')
  })

  test(`cold row: with whatsnext and no handoff yet, it offers Save handoff note, even with Before the cache goes cold off (${surface})`, { timeoutMs: 30000, options: { beforeCold: 'off' } }, async ($, on) => {
    const { h, d } = await session($, on, { whatsnext: true, stored: { beforeCold: 'off' } })
    h.wnFresh = { exitCode: 0, stdout: freshAnswer(true) }
    await turn(d, 't1')
    await h.advance(HOUR + MIN)
    expect((await cacheRow($)).text).toBe(COLD_OFFER)
    expect(await coldButtons($)).toEqual([['cold-fresh', 'Clear chat'], ['cold-handoff', 'Save handoff note']])
    expect(h.submitted.length, 'Off: nothing automatic').toBe(0)
  })

  test(`cold row: Save handoff note sends wrap up, then says it is saved and keeps Clear chat (${surface})`, { timeoutMs: 30000, options: { beforeCold: 'off' } }, async ($, on) => {
    const { h, d } = await session($, on, { whatsnext: true, stored: { beforeCold: 'off' } })
    h.wnFresh = { exitCode: 0, stdout: freshAnswer(true) }
    await turn(d, 't1')
    await h.advance(HOUR + MIN)
    await press($, 'cold-handoff')
    expect(h.submitted.map(s => s.text)).toEqual(['wrap up'])
    const r = await cacheRow($)
    expect(r.text, 'not "before the cache went cold": it already had').toBe('Saved a handoff note. New topic? Clear chat.')
    expect(await coldButtons($)).toEqual([['cold-fresh', 'Clear chat']])
  })

  test(`cold row: when whatsnext says the handoff is already written, no second one is offered (${surface})`, { timeoutMs: 30000, options: { beforeCold: 'off' } }, async ($, on) => {
    const { h, d } = await session($, on, { whatsnext: true, stored: { beforeCold: 'off' } })
    h.wnFresh = { exitCode: 0, stdout: freshAnswer(false) }
    await turn(d, 't1')
    await h.advance(HOUR + MIN)
    expect((await cacheRow($)).text).toBe(COLD_SAVED)
    expect(await coldButtons($)).toEqual([['cold-fresh', 'Clear chat']])
  })

  test(`cold row: an older whatsnext that cannot say still gets the offer (${surface})`, { timeoutMs: 30000, options: { beforeCold: 'off' } }, async ($, on) => {
    const { h, d } = await session($, on, { whatsnext: true, stored: { beforeCold: 'off' } })
    await turn(d, 't1')
    await h.advance(HOUR + MIN)
    expect((await cacheRow($)).text).toBe(COLD_OFFER)
  })

  test(`cold row: Clear chat puts /clear in the prompt box and sends nothing (${surface})`, { timeoutMs: 30000, options: { beforeCold: 'off' } }, async ($, on) => {
    const { h, d } = await session($, on, { stored: { beforeCold: 'off' } })
    await turn(d, 't1')
    await h.advance(HOUR + MIN)
    await press($, 'cold-fresh')
    expect(h.fills.map(f => f.text)).toEqual(['/clear'])
    expect(h.submitted.length + h.compactions, 'the person sends it').toBe(0)
  })

  test(`cold row: a big chat gets the tip, not the cold row (${surface})`, { timeoutMs: 30000, options: { beforeCold: 'off' } }, async ($, on) => {
    const { h, d } = await session($, on, { tokens: BIG, stored: { beforeCold: 'off' } })
    await turn(d, 't1')
    await h.advance(HOUR + MIN)
    expect((await cacheRow($)).text).toContain(TIP)
  })

  test(`cold row: Cache timer off shows no cold row and no timer waits (${surface})`, { timeoutMs: 30000, options: { beforeCold: 'off', cacheTimer: 'off' } }, async ($, on) => {
    const { h, d } = await session($, on, { stored: { beforeCold: 'off', cacheTimer: 'off' } })
    await turn(d, 't1')
    await h.advance(HOUR + MIN)
    expect((await cacheRow($)).text).toBe('')
    expect(h.sleepers.length).toBe(0)
  })

  test(`cold row: a prompt before the cache goes cold cancels it (${surface})`, { timeoutMs: 30000, options: { beforeCold: 'off' } }, async ($, on) => {
    const { h, d } = await session($, on, { stored: { beforeCold: 'off' } })
    await turn(d, 't1')
    await h.advance(30 * MIN)
    await d.submit('continue')
    await h.advance(2 * HOUR)
    expect((await cacheRow($)).text).toBe('')
  })

  // ---- A reopened chat that went cold -------------------------------------------------------------------------

  const LAST = (over: Record<string, unknown> = {}) => ({ lastTurns: { 'sess-1': { at: EVENING - 3 * HOUR, context: BIG, ...over } } })

  test(`reopened: a chat whose last turn ended over a cache life ago gets the tip at the session's start, before the person types (${surface})`, { timeoutMs: 30000, options: {} }, async ($, on) => {
    const { h } = await session($, on, { store: LAST() })
    expect((await cacheRow($)).text).toContain(TIP)
    expect(logOf(h)).toContain('cold-compact tip: offered')
    expect((await cacheRow($)).buttons.some(b => b[0] === 'cold-tip-start')).toBe(true)
  })

  test(`reopened: a chat that is still warm gets no tip (${surface})`, { timeoutMs: 30000, options: {} }, async ($, on) => {
    await session($, on, { store: LAST({ at: EVENING - 10 * MIN }) })
    expect((await cacheRow($)).text).toBe('')
  })

  test(`reopened: a chat on Sonnet gets no tip (${surface})`, { timeoutMs: 30000, options: {} }, async ($, on) => {
    const sonnet = await session($, on, { store: LAST(), model: 'claude-sonnet-5-5' })
    expect((await cacheRow($)).text, 'Sonnet: the cold row, no tip').toMatch(/^Went cold at 4:00 PM\. OK to continue here \(~\$/)
    expect(logOf(sonnet.h)).not.toContain('cold-compact tip: offered')
  })

  test(`reopened: too small to save anything shows the cold row, not the tip (${surface})`, { timeoutMs: 30000, options: {} }, async ($, on) => {
    await session($, on, { store: LAST({ context: 20_000 }) })
    const r = await cacheRow($)
    expect(r.text).toBe('Went cold at 4:00 PM. OK to continue here (~$0.16). New topic? Clear chat.')
    expect(r.buttons.filter(b => String(b[0]).startsWith('cold-'))).toEqual([['cold-fresh', 'Clear chat']])
  })

  test(`reopened: a chat with no last turn in the store shows nothing (${surface})`, { timeoutMs: 30000, options: {} }, async ($, on) => {
    await session($, on, { store: { lastTurns: { 'another-session': { at: EVENING - 3 * HOUR, context: BIG } } } })
    expect((await cacheRow($)).text).toBe('')
  })

  test(`reopened: Cache off shows nothing (${surface})`, { timeoutMs: 30000, options: { cache: 'off' } }, async ($, on) => {
    await session($, on, { store: LAST(), stored: { cache: 'off' } })
    expect((await cacheRow($)).text).toBe('')
  })

  test(`reopened: a session that does not report its model at the start uses the model the last turn ran on (${surface})`, { timeoutMs: 30000, options: {} }, async ($, on) => {
    await session($, on, { store: LAST({ tier: 'opus' }), liveModel: '' })
    expect((await cacheRow($)).text).toContain(TIP)
  })

  test(`reopened: with no model from the session and none stored, nothing shows (${surface})`, { timeoutMs: 30000, options: {} }, async ($, on) => {
    const { h } = await session($, on, { store: LAST(), liveModel: '' })
    expect((await cacheRow($)).text).toBe('')
    expect(logOf(h)).toContain('a reopened chat, but its model is not known at the start')
  })

  // The whole path, with nothing seeded: a turn ends and writes the store's last-turn record; the process ends; a later process starts
  // the same session id (Claude Code's `--resume` keeps the id: every resumed transcript in this project's history does) and finds it.
  // The restart is a second session.start with the clock moved on and the old process's timers dropped (a session.end first).
  const reopen = async (h: ReturnType<typeof engine>, d: ReturnType<typeof drive>, gap: number, over: { id?: string; liveModel?: string } = {}) => {
    await d.end()
    h.sleepers.length = 0
    h.now += gap
    if (over.id !== undefined) h.sessionId = over.id
    if (over.liveModel !== undefined) h.liveModel = over.liveModel
    await d.start(surface)
  }

  test(`reopened, end to end: a turn on Opus ends, a new process starts the same session id 3 hours later, and the tip shows (${surface})`, { timeoutMs: 30000, options: { beforeCold: 'off' } }, async ($, on) => {
    const { h, d } = await session($, on, { tokens: BIG, stored: { beforeCold: 'off' } })
    await turn(d, 't1')
    expect(h.store.lastTurns, 'the turn end wrote the record the reopened chat reads').toEqual({ 'sess-1': { at: EVENING, context: BIG, tier: 'opus' } })
    expect(logOf(h), 'nothing yet: the cache is warm').not.toContain('cold-compact tip: offered')
    await reopen(h, d, 3 * HOUR)
    expect((await cacheRow($)).text, 'before the person types').toContain(TIP)
    expect(logOf(h)).toContain('cold-compact tip: offered')
    expect((await cacheRow($)).buttons.some(b => b[0] === 'cold-tip-start')).toBe(true)
  })

  test(`reopened, end to end: the model comes from the stored turn when the new process does not report one yet (${surface})`, { timeoutMs: 30000, options: { beforeCold: 'off' } }, async ($, on) => {
    const { h, d } = await session($, on, { tokens: BIG, stored: { beforeCold: 'off' } })
    await turn(d, 't1')
    await reopen(h, d, 3 * HOUR, { liveModel: '' })
    expect((await cacheRow($)).text).toContain(TIP)
  })

  test(`reopened, end to end: the same session id inside one cache life shows nothing (${surface})`, { timeoutMs: 30000, options: { beforeCold: 'off' } }, async ($, on) => {
    const { h, d } = await session($, on, { tokens: BIG, stored: { beforeCold: 'off' } })
    await turn(d, 't1')
    await reopen(h, d, 30 * MIN)
    expect((await cacheRow($)).text).toBe('')
  })

  test(`reopened, end to end: a session id the store has no turn for shows nothing (a resume under a new id would not be found; resume keeps the id) (${surface})`, { timeoutMs: 30000, options: { beforeCold: 'off' } }, async ($, on) => {
    const { h, d } = await session($, on, { tokens: BIG, stored: { beforeCold: 'off' } })
    await turn(d, 't1')
    await reopen(h, d, 3 * HOUR, { id: 'sess-2' })
    expect((await cacheRow($)).text).toBe('')
  })

  test(`reopened: a prompt typed with the tip up ends it (${surface})`, { timeoutMs: 30000, options: {} }, async ($, on) => {
    const { d } = await session($, on, { store: LAST() })
    expect((await cacheRow($)).text).toContain(TIP)
    await d.submit('continue')
    expect((await cacheRow($)).text).toBe('')
  })
}
