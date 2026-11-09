import { type TestBody, expect, test } from 'claude-code/testing'
import { CAL_STORE } from './cost'
import { type Engine, RUNS_FILE, LOG_PATH, LEGACY_RUNS, LOOKUP, DEBUG, NO_CHANGE, FREE_SWITCHES, BIG_TURN, cellsOf, engine, drive, untilAsked, last, mount, rowText, bandText, LOWER, WHATSNEXT_CMDS, installWhatsnext } from './testkit'

for (const surface of ['desktop', 'terminal'] as const) {
  const HOUR = 3600_000

  const MIN = 60_000
  const settingsText = async (d: ReturnType<typeof drive>) => (await d.command('status')).text ?? ''
  // A raise fixture: a review, the one task type whose rated raise is still taken at prompt time on Opus (ADR 0021).
  const RAISE_HIGH = '{"level":"high","model":"same","type":"review","read":20000,"write":3000,"steps":8,"reason":"unknown cause"}'
  /** Rows set the way /config does: declared at load, and stored. */
  const inProfile = (_profile: string, more: Record<string, string> = {}) => ({ options: { ...more }, stored: { ...more } })


  // ---- Before the cache goes cold ------------------------------------------------------------------------------
  //
  // A big session (a cold return would cost $0.50 or more) gets, at the end of a main turn, an offer, keep-warm
  // requests, a handoff or a compaction, by the row. These run on a virtual clock: a sleep ends when `advance` reaches it.

  /** 18:00 local: the next 9:00 is 15 hours away. */
  const EVENING = new Date(2027, 0, 15, 18, 0, 0, 0).getTime()
  const WHATSNEXT = WHATSNEXT_CMDS
  type ColdOver = {
    /** The rows the person set (settings.json); Before the cache goes cold is "ask" unless these say otherwise, since only that row offers. */
    stored?: Record<string, string>
    /** True: leave Before the cache goes cold unset, so the fixed value applies. */
    unset?: boolean
    commands?: typeof WHATSNEXT
    prices?: string
    usage?: typeof BIG_TURN
    fork?: Record<string, number> | undefined
    model?: string
    store?: Record<string, unknown>
    rateLimits?: { kind: string; percentUsed: number }[]
    /** True: the 3-second band timer fires on the virtual clock. */
    ticks?: boolean
  }
  // Opus: 80,500 tokens in the conversation, $0.63 to come back cold.
  const coldSession = async ($: unknown, on: Parameters<TestBody>[1], over: ColdOver = {}) => {
    const stored = over.unset ? over.stored : { beforeCold: 'ask', ...over.stored }
    const h = engine(on, { model: over.model ?? 'claude-opus-5-5', effort: 'medium', ...(stored ? { stored } : {}), ...(over.store ? { store: over.store } : {}) })
    if (over.rateLimits) h.rateLimits = over.rateLimits
    h.now = EVENING
    h.virtual = true
    h.ticks = over.ticks === true
    h.stepUsage = over.usage ?? BIG_TURN
    h.commands = over.commands ?? []
    if (over.commands?.length) installWhatsnext(h)
    if ('fork' in over) h.forkUsage = over.fork
    if (over.prices) h.pricesFile = over.prices
    const d = drive($, h)
    await d.start(surface)
    return { h, d }
  }
  const coldTurn = async (d: ReturnType<typeof drive>, id: string) => {
    await d.step(id)
    await d.complete(id)
  }
  const bandButtons = async ($: unknown) => {
    const ui = await mount($, surface)
    const found = await ui.findAll({ type: 'Button' })
    await ui.unmount()
    return found.map(b => [b.key, b.text])
  }
  const pressBand = async ($: unknown, key: string) => {
    const ui = await mount($, surface)
    await ui.press({ key })
    await ui.unmount()
  }
  /** The turn ends and 5 minutes pass: on a 1-hour cache the offer shows then, not at the turn's end. */
  const coldOffer = async (h: ReturnType<typeof engine>, d: ReturnType<typeof drive>, id: string) => {
    await coldTurn(d, id)
    await h.advance(5 * MIN)
  }
  /** The text of the cache row (its own line), without the route's row above it. */
  const coldRow = async ($: unknown) => {
    const ui = await mount($, surface)
    const text = await rowText(ui, 'Cache')
    await ui.unmount()
    return text
  }
  /** Presses ⋯, answers the menu's questions by header (no answer: dismissed), and returns the questions asked. */
  const openMenu = async ($: unknown, h: ReturnType<typeof engine>, answers: Record<string, string> = {}, questions = 1) => {
    h.answers = answers
    const before = h.asked.length
    const ui = await mount($, surface)
    await ui.press({ key: 'mode' })
    await untilAsked(h, before, questions)
    await ui.unmount()
    return h.asked.slice(before)
  }
  /** The cache offer's ⋯ menu is one paged list (the cache choices, then the band setting): the first 3 and More… on page 1 (header Options), the rest on the next page (header More options). */
  const CACHE_MENU = { Options: 'More…' }
  const warmLines = (h: ReturnType<typeof engine>) =>
    (h.files[RUNS_FILE] ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l) as { kind?: string; overhead?: number; session?: string; tier?: string; context?: number }).filter(l => l.kind === 'warm')
  const coldLog = (h: ReturnType<typeof engine>) => h.files[LOG_PATH] ?? ''
  const NOTHING_DONE = (h: ReturnType<typeof engine>) => ({ forks: h.forks.length, submitted: h.submitted.length, compactions: h.compactions })
  const NONE = { forks: 0, submitted: 0, compactions: 0 }
  const ZERO = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

  test(`ask: a big Opus session gets the offer 5 minutes after the turn on a 1-hour cache: one line, one button, the other choices in the ⋯ menu; nobody presses, nothing happens (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await coldSession($, on)
    await coldTurn(d, 't1')
    expect(await bandText($, surface), 'not at the turn\'s end').toBe('')
    expect(h.afters, 'one timer, for 5 minutes after the turn').toEqual([5 * MIN])
    await h.advance(4 * MIN)
    expect(await bandText($, surface), 'not at 4 minutes').toBe('')
    await h.advance(MIN)
    expect(await bandText($, surface), 'the cache line stands alone: no route text, so it carries the prefix').toBe('Goes cold in 55 min (19:00) · coming back after costs about $0.63')
    expect(await bandButtons($), 'one button; ⋯ and × follow it').toEqual([
      ['cold-2h', 'Keep warm to 20:00 ($0.03)'],
      ['mode', '⋯'],
      ['close', '×'],
    ])
    // $.ui.ask takes 4 options at most: the menu is one list, the cache choices and then the band setting, three to a page with More….
    const asks = await openMenu($, h, CACHE_MENU, 2)
    expect(asks.map(a => a.options)).toEqual([
      ['Keep warm to 2:00 tomorrow ($0.13)', 'Keep warm to 9:00 tomorrow ($0.24)', 'Compact now', 'More…'],
      ['Let it go cold', "Don't offer again", 'When the band shows…'],
    ])
    expect(asks[1]?.options.length, 'a page is 4 options at most').toBeLessThanOrEqual(4)
    expect(asks[0]?.question, 'the menu says what the dollars are').toContain('API-equivalent')
    await h.advance(3 * HOUR)
    expect(NOTHING_DONE(h), 'the cache goes cold').toEqual(NONE)
    expect(h.sleepers.length, 'no timer waits').toBe(0)
  })

  test(`ask: the offer names the clock time the cache goes cold, and the tokens and the model stay out of the band, in the log (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await coldSession($, on)
    await coldTurn(d, 't1')
    await h.advance(5 * MIN)
    expect(await bandText($, surface)).toContain('Goes cold in 55 min (19:00)')
    expect(await bandText($, surface)).not.toMatch(/tokens|Opus/)
    expect(coldLog(h)).toContain('($0.63 cold, 81K tokens on Opus')
  })

  test(`ask: the offer's minutes count down once a minute, from the 3-second timer; ten seconds later the row is the same (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await coldSession($, on, { ticks: true })
    await coldTurn(d, 't1')
    await h.advance(5 * MIN)
    expect(await coldRow($)).toBe('Goes cold in 55 min (19:00) · coming back after costs about $0.63')
    await h.advance(10_000)
    expect(await coldRow($), 'ten seconds later: still 55 min').toBe('Goes cold in 55 min (19:00) · coming back after costs about $0.63')
    await h.advance(MIN - 10_000)
    expect(await coldRow($), 'a minute later: 54 min').toBe('Goes cold in 54 min (19:00) · coming back after costs about $0.63')
    expect(h.everies.every(ms => ms === 3000), 'the 3-second timer is the only one for the band').toBe(true)
  })

  test(`ask: a prompt in the first 5 minutes cancels the offer (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await coldSession($, on)
    await coldTurn(d, 't1')
    await h.advance(3 * MIN)
    h.rating = NO_CHANGE
    await d.submit('continue')
    await h.advance(10 * MIN)
    expect(await bandText($, surface), 'no offer for the turn before it').not.toContain('Goes cold')
    expect(h.afters.length, 'the timer was the only one; it was cancelled before it fired').toBe(1)
  })

  test(`ask: with a route band above, the cache line is a second row with the one button, and ⋯ and × go on a header line (${surface})`, { timeoutMs: 30000, options: { lowerRule: 'lower automatically' } }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: { lowerRule: 'lower automatically' }, store: { [CAL_STORE]: FREE_SWITCHES } })
    await coldTurn(d, 't0')
    h.rating = LOWER
    await d.submit(LOOKUP)
    await d.step('t1')
    await d.complete('t1')
    expect(await coldRow($), 'not yet').toBe('')
    await h.advance(5 * MIN)
    const ui = await mount($, surface)
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    expect(texts.slice(0, 2), 'a header line, then the labelled rows').toEqual(['rightsize', 'Prompt'])
    expect(await rowText(ui, 'Prompt'), 'row 1 is the route text alone').toMatch(/^Effort lowered/)
    expect(await coldRow($)).toBe('Goes cold in 55 min (19:00) · coming back after costs about $0.63')
    await ui.unmount()
    expect((await bandButtons($)).map(b => b[0]), '⋯ and × on the header; the route buttons; then the cache button').toEqual(['mode', 'close', 'retry', 'cold-2h'])
  })

  test(`ask: with a route band above, the ⋯ menu lists the rule options first, then the cache choices, then the band setting, paged (${surface})`, { timeoutMs: 30000, options: { raiseRule: 'raise automatically' } }, async ($, on) => {
    // A raise has no 👍 or 👎 in the menu, so the first list is the rule's other two options, the way down, and the band setting.
    const { h, d } = await coldSession($, on, { stored: { raiseRule: 'raise automatically' } })
    await coldTurn(d, 't0')
    h.rating = RAISE_HIGH
    await d.submit(DEBUG)
    await d.step('t1')
    await d.complete('t1')
    await h.advance(5 * MIN)
    expect(await coldRow($)).toBe('Goes cold in 55 min (19:00) · coming back after costs about $0.63')
    expect((await bandButtons($)).map(b => b[0]), '⋯ and × on the header, then the cache button').toEqual(['mode', 'close', 'cold-2h'])
    expect((await openMenu($, h))[0]?.options, 'the rule options, then the cache choices, three to a page').toEqual(['Ask me each time', 'Never raise', 'Keep warm to 2:00 tomorrow ($0.13)', 'More…'])
  })

  test(`ask: with whatsnext installed the offer says Save a handoff, and the usual start time comes from the run log (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await coldSession($, on, { commands: WHATSNEXT })
    // Six days whose first prompt was at 8:21, 8:22 ... 8:26: the median, 8:23.5, rounds to 8:30.
    const day = (n: number) => JSON.stringify({ at: new Date(2027, 0, 15 - n, 9, 30).toISOString(), submittedAt: new Date(2027, 0, 15 - n, 8, 20 + n).toISOString(), kind: 'run' })
    h.files[LEGACY_RUNS] = `${[1, 2, 3, 4, 5, 6].map(day).join('\n')}\n`
    await d.start(surface)
    await coldOffer(h, d, 't1')
    expect((await bandButtons($)).map(b => b[1])).toEqual(['Keep warm to 20:00 ($0.03)', '⋯', '×'])
    const asks = await openMenu($, h, CACHE_MENU, 2)
    expect(asks[0]?.options).toEqual(['Keep warm to 2:00 tomorrow ($0.13)', 'Keep warm to 8:30 tomorrow ($0.24)', 'Save a handoff', 'More…'])
    expect(asks[1]?.options).toEqual(['Let it go cold', "Don't offer again", 'When the band shows…'])
    expect(coldLog(h)).toContain('offered 2h, 8h, start')
  })

  test(`ask: nothing for a small conversation or for Haiku; Sonnet needs about 128K, and there is no size ceiling (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await coldSession($, on, { usage: { ...BIG_TURN, cache_read_input_tokens: 20_000 } })
    await coldTurn(d, 't1')
    expect(await bandText($, surface), '20K tokens on Opus: $0.16 cold').toBe('')
    // Haiku with a big conversation: a cold return costs about a cent and a half.
    h.stepUsage = BIG_TURN
    h.model = 'claude-haiku-5-5'
    await coldTurn(d, 't2')
    expect(await bandText($, surface), 'Haiku never').toBe('')
    // Sonnet at 100K tokens: $0.39 cold, under the bar; at 140K: $0.55.
    h.model = 'claude-sonnet-5-5'
    h.stepUsage = { ...BIG_TURN, cache_read_input_tokens: 99_500 }
    await coldTurn(d, 't3')
    expect(await bandText($, surface)).toBe('')
    h.stepUsage = { ...BIG_TURN, cache_read_input_tokens: 139_500 }
    await coldOffer(h, d, 't4')
    expect(await bandText($, surface)).toBe('Goes cold in 55 min (19:00) · coming back after costs about $0.55')
    // Opus at exactly 200K tokens is offered, and so is one token more: the size ceiling is gone. (With Claude's idle compaction
    // on, its default, nothing is offered at 200K: register.idlecompact.test.ts.)
    h.settings.idleCompaction = false
    h.model = 'claude-opus-5-5'
    h.stepUsage = { ...BIG_TURN, cache_read_input_tokens: 199_500 }
    await coldOffer(h, d, 't5')
    expect(coldLog(h)).toContain('200K tokens on Opus')
    expect(await bandText($, surface)).toContain('Goes cold')
    h.stepUsage = { ...BIG_TURN, cache_read_input_tokens: 199_501 }
    await coldOffer(h, d, 't6')
    expect(await bandText($, surface), 'no ceiling any more').toContain('Goes cold')
  })

  test(`ask: the size bar is the Idle warning amount: over $0.10 offers 20K tokens on Opus (${surface})`, { timeoutMs: 30000, options: { idleWarning: 'over $0.10' } }, async ($, on) => {
    const { h, d } = await coldSession($, on, { usage: { ...BIG_TURN, cache_read_input_tokens: 20_000 } })
    await coldOffer(h, d, 't1')
    expect(await bandText($, surface)).toContain('Goes cold')
  })

  test(`ask: Idle warning over $1 skips a $0.55 cold return (${surface})`, { timeoutMs: 30000, options: { idleWarning: 'over $1' } }, async ($, on) => {
    const { h, d } = await coldSession($, on)
    h.model = 'claude-sonnet-5-5'
    h.stepUsage = { ...BIG_TURN, cache_read_input_tokens: 139_500 }
    await coldTurn(d, 't1')
    expect(await bandText($, surface)).toBe('')
  })

  test(`ask: an aborted turn gets no offer: the person is at the keyboard (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { d } = await coldSession($, on)
    await d.step('t1')
    await ($ as Engine).turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: true, reason: 'aborted' })
    expect(await bandText($, surface)).toBe('')
  })

  test(`Don't offer again saves the row as yours, says where it is, and nothing offers again (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await coldSession($, on)
    await coldOffer(h, d, 't1')
    await openMenu($, h, { ...CACHE_MENU, 'More options': "Don't offer again" }, 2)
    expect(last(h.sets)).toMatchObject({ key: 'rightsize.beforeCold', value: 'off' })
    expect(h.stored.beforeCold, 'written to settings.json as the person\'s own').toBe('off')
    expect(last(h.toasts)).toBe('Rightsize: Before the cache goes cold is now "off". It is the row in /config; set it back any time.')
    expect(await settingsText(d), 'yours now').toContain('Before the cache goes cold: off')
    expect(await bandText($, surface), 'the offer closes').toBe('')
    await coldTurn(d, 't2')
    expect(await bandText($, surface), 'and does not come back').toBe('')
    // Not in the next session either.
    await d.start(surface)
    await coldTurn(d, 't4')
    await h.advance(3 * HOUR)
    expect(NOTHING_DONE(h)).toEqual(NONE)
    expect(await bandText($, surface)).toBe('')
  })

  test(`Let it go cold closes the offer and does nothing; Compact now runs at once, while the cache is warm (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await coldSession($, on)
    await coldOffer(h, d, 't1')
    await openMenu($, h, { ...CACHE_MENU, 'More options': 'Let it go cold' }, 2)
    expect(await bandText($, surface)).toBe('')
    expect(NOTHING_DONE(h)).toEqual(NONE)
    expect(coldLog(h)).toContain('let it go cold')
    await coldOffer(h, d, 't2')
    // Let it go cold is the one button now (the choice picked most); Compact now is on the second page of the menu.
    expect((await bandButtons($)).map(b => b[1]).slice(0, 1)).toEqual(['Let it go cold'])
    await openMenu($, h, { ...CACHE_MENU, 'More options': 'Compact now' }, 2)
    expect(h.compactions, 'right away').toBe(1)
    expect(await bandText($, surface)).toBe('Compacted while the cache was warm.')
    await h.advance(3 * HOUR)
    expect(h.compactions, 'once').toBe(1)
  })

  test(`Save a handoff from the offer submits "wrap up" at once, and the turn it starts does not bring the offer back (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await coldSession($, on, { commands: WHATSNEXT })
    await coldOffer(h, d, 't1')
    await openMenu($, h, { Options: 'Save a handoff' }, 1)
    expect(h.submitted.map(s => s.text)).toEqual(['wrap up'])
    expect(await bandText($, surface)).toBe('Saved a handoff with whatsnext before the cache went cold.')
    expect(h.ratings, 'rightsize\'s own prompt is not rated').toBe(0)
    // whatsnext's wrap-up is a turn of its own.
    await d.turnStart('t2', 'wrap up')
    await coldTurn(d, 't2')
    expect(await bandText($, surface), 'no second offer after a handoff').toBe('Saved a handoff with whatsnext before the cache went cold.')
    await h.advance(3 * HOUR)
    expect(h.submitted.length).toBe(1)
    // The person comes back and works: it starts afresh.
    h.rating = NO_CHANGE
    await d.submit('continue')
    await coldOffer(h, d, 't3')
    expect(await coldRow($), 'the offer is its own row under the prompt\'s').toContain('Goes cold in ')
  })

  test(`an offered keep-warm time starts at once and counts from the turn's end (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await coldSession($, on)
    await coldTurn(d, 't1')
    await h.advance(10 * MIN)
    await pressBand($, 'cold-2h')
    expect(await bandText($, surface)).toBe('Warm until 20:00 · $0.00 so far')
    expect(await bandButtons($)).toEqual([['cold-stop', 'Stop keeping warm'], ['mode', '⋯'], ['close', '×']])
    await h.advance(46 * MIN)
    expect(h.forks.length, '56 minutes after the turn ended').toBe(0)
    await h.advance(MIN)
    expect(h.forks, 'at 57').toEqual(['Reply with the single word OK.'])
    await h.advance(HOUR)
    expect(h.forks.length, 'and at 114: two for 2 hours').toBe(2)
    await h.advance(4 * HOUR)
    expect(h.forks.length).toBe(2)
    expect(await bandText($, surface)).toBe('Kept the cache warm until 20:00 · $0.03.')
  })

  test(`a keep-warm button pressed 40 minutes after the turn ends keeps the end time and the cost it showed (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await coldSession($, on)
    await coldOffer(h, d, 't1')
    expect((await bandButtons($))[0], 'the button as shown at 5 minutes').toEqual(['cold-2h', 'Keep warm to 20:00 ($0.03)'])
    await h.advance(35 * MIN)
    expect((await bandButtons($))[0], 'the same at 40 minutes').toEqual(['cold-2h', 'Keep warm to 20:00 ($0.03)'])
    await pressBand($, 'cold-2h')
    expect(await bandText($, surface)).toBe('Warm until 20:00 · $0.00 so far')
    await h.advance(4 * HOUR)
    expect(h.forks.length, 'two pings, as for a press at 5 minutes').toBe(2)
    expect(await bandText($, surface)).toBe('Kept the cache warm until 20:00 · $0.03.')
  })

  test(`an offered time on a cache that already went cold says so and keeps nothing warm (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await coldSession($, on)
    await coldTurn(d, 't1')
    await h.advance(61 * MIN)
    await pressBand($, 'cold-2h')
    expect(last(h.toasts)).toBe('Rightsize: the cache already went cold, so there is nothing to keep warm.')
    await h.advance(3 * HOUR)
    expect(h.forks.length).toBe(0)
  })

  const WARM8 = inProfile('Balanced', { beforeCold: 'keep warm 8 h' })
  test(`keep warm 8 h: starts at the turn's end with no question, pings through $0.model.fork each 57 minutes, and each ping is a warm line of overhead (${surface})`, { timeoutMs: 30000, options: WARM8.options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: WARM8.stored })
    await coldTurn(d, 't1')
    expect(h.asked.length, 'no question').toBe(0)
    expect(await bandText($, surface)).toBe('Warm until 2:00 · $0.00 so far')
    expect(await bandButtons($)).toEqual([['cold-stop', 'Stop keeping warm'], ['mode', '⋯'], ['close', '×']])
    expect(h.afters, 'one timer, for the first ping: a long wait is an after, not a sleep').toEqual([57 * MIN])
    await h.advance(56 * MIN)
    expect(h.forks.length).toBe(0)
    await h.advance(MIN)
    expect(h.forks.length, 'the first at 57 minutes: 3 before the cache expires').toBe(1)
    expect(h.afters, 'the first ping armed the second').toEqual([57 * MIN, 57 * MIN])
    expect(await bandText($, surface)).toBe('Warm until 2:00 · $0.02 so far')
    expect(warmLines(h).length).toBe(1)
    expect(warmLines(h)[0]).toMatchObject({ kind: 'warm', session: 'sess-1', tier: 'opus', context: 80_500, overhead: 0.01613 })
    await h.advance(7 * HOUR)
    expect(h.forks.length, 'eight in eight hours').toBe(8)
    expect(h.forks.every(f => f === 'Reply with the single word OK.')).toBe(true)
    expect(warmLines(h).length).toBe(8)
    expect(h.afters.length, 'one timer per ping, and none after the last').toBe(8)
    expect(h.sleeps.every(ms => ms <= 120_000), 'no long sleep').toBe(true)
    expect(await bandText($, surface)).toBe('Kept the cache warm until 2:00 · $0.13.')
    // Nearly 8 hours after the turn ended, but 21 minutes after the last ping: coming back is not an idle return.
    h.rating = NO_CHANGE
    await d.submit('continue')
    expect(h.asked.length, 'no idle question: the pings kept the cache warm').toBe(0)
    await h.advance(3 * HOUR)
    expect(h.forks.length, 'and no more').toBe(8)
  })

  test(`the pings count against rightsize in the report: Total saved is lower by what they cost (${surface})`, { timeoutMs: 30000, options: WARM8.options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: WARM8.stored })
    await coldTurn(d, 't1')
    await h.advance(8 * HOUR)
    expect(warmLines(h).length).toBe(8)
    h.now = Date.now()
    const only = (await d.command('report')).text ?? ''
    expect(only.split('\n')[1]).toBe('Cost ~$0.13 more than it saved in the last 30 days.')
    expect(only.replace(/\s+/g, ' ')).toContain('Total saved is after the cost of rating prompts and of keeping the cache warm ($0.13 in 30 days), and counts what keeping it warm saved when you came back to a warm cache.')
    // A saving of $0.30 in another session: the 30 days show it less the pings.
    h.files[LEGACY_RUNS] = `${JSON.stringify({ at: new Date().toISOString(), kind: 'run', session: 'other', change: 'lower', offered: 'lower', stay: 0.4, taken: 0.1, actual: 0.1, overhead: 0 })}\n`
    expect(cellsOf((await d.command('report')).text ?? '', 'Total saved')).toEqual(['-$0.13', '~$0.17', '~$0.17'])
  })

  test(`keep warm stops when the person submits a prompt (${surface})`, { timeoutMs: 30000, options: WARM8.options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: WARM8.stored })
    await coldTurn(d, 't1')
    await h.advance(57 * MIN)
    expect(h.forks.length).toBe(1)
    h.rating = NO_CHANGE
    await d.submit('continue')
    // Opus at medium lowers every prompt, so the band now shows that row; the keep-warm row is what must be gone.
    expect(await bandText($, surface), 'the prompt closes the keep-warm row').not.toContain('Warm until')
    await h.advance(4 * HOUR)
    expect(h.forks.length, 'no more').toBe(1)
    expect(coldLog(h)).toContain('keep warm stopped (a prompt was submitted): 1 ping')
  })
}
