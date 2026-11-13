import { expect, test } from 'claude-code/testing'
import { CAL_FULL, CAL_STORE, DEFAULT_PRICES, type Calibration, type Rating, type Situation, delegateCost, delegateKeys, plan, sizeSubagent, subagentKeys, subWork } from './cost'
import { type Engine, RUNS_FILE, LOG_PATH, LEGACY_RUNS, LOOKUP, DEBUG, SEARCH, REVIEW, NO_CHANGE, FREE_SWITCHES, NO_COLD, cellsOf, engine, drive, flush, settle, untilAsked, DAY, PAGE, OLD_PRICES, last, mount, bandText, setBand, LOWER } from './testkit'

for (const surface of ['desktop', 'terminal'] as const) {

  const rated = (type: string, continues: boolean) => `{"fit":{"haiku":"no","sonnet":"medium","opus":"medium","fable":"medium"},"type":"${type}","read":8000,"write":1200,"steps":5,"continues":${continues},"reason":"rated"}`

  const AUTO_RAISE = { remember: true, choices: { raise: 'auto' } }

  const RUNS = LEGACY_RUNS
  /** 60 rated prompts on Opus at medium that Sonnet could do at medium: a cheaper start. */
  const easyLog = (now: number) =>
    Array.from({ length: 60 }, (_, i) =>
      JSON.stringify({
        at: new Date(now - (60 - i) * 60_000).toISOString(),
        kind: 'run',
        type: 'feature',
        route: 'main',
        tier: 'opus',
        level: 'medium',
        normal: 'medium',
        fit: { haiku: null, sonnet: 'medium', opus: 'low', fable: 'low' },
        read: 8000,
        write: 2000,
        steps: 8,
        context: 60_000,
      }),
    ).join('\n')

  // ---- The day-one tip: once per install, on an Opus start with too few rated prompts to compare ----

  const DAY_ONE = 'Starting tip: most work runs as well on Sonnet 5.5 at medium for well under half the usage of Opus. Reviews still run on Opus, and work Sonnet would struggle with goes to a stronger helper. Switch with /model sonnet.'
  const FRESH_INSTALL = { startDayOne: undefined }

  test(`day one: an Opus start with under 50 rated prompts shows the tip once, with Switch: /model sonnet and Not now (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: FRESH_INSTALL })
    h.files[RUNS] = easyLog(h.now).split('\n').slice(0, 30).join('\n')
    const d = drive($, h)
    await d.start(surface)
    expect(await bandText($, surface)).toBe(DAY_ONE)
    expect(await buttons($), 'Not now, Switch, then ⋯ and ×').toEqual(['tip-later', 'tip-switch', 'mode', 'close'])
    const ui = await mount($, surface)
    expect((await ui.find({ type: 'Button', key: 'tip-switch' }))?.text, 'the button names the command').toBe('Switch: /model sonnet')
    await ui.unmount()
    expect(h.store.startDayOne, 'once per install: the store remembers').toBe(true)
    expect(h.files[LOG_PATH] ?? '').toContain('day-one start tip shown: Sonnet 5.5 at medium')
    expect(h.sent, 'rightsize changes no model').toEqual([])
    // The next session, and the one after: not again.
    await d.start(surface)
    expect(await bandText($, surface), 'not again in the next session').toBe('')
    await d.start(surface)
    expect(await bandText($, surface)).toBe('')
  })

  test(`day one: Switch puts /model sonnet in the prompt box and closes the band; rightsize does not run it (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: FRESH_INSTALL })
    const d = drive($, h)
    await d.start(surface)
    expect(await bandText($, surface)).toBe(DAY_ONE)
    await pressBandKey($, 'tip-switch')
    expect(h.filled, 'the command is in the prompt box, for the person to run').toEqual(['/model sonnet'])
    expect(last(h.toasts)).toBe('Rightsize: press Enter to run /model sonnet.')
    expect(await bandText($, surface), 'the band closes').toBe('')
    expect(h.submitted, 'nothing was submitted').toEqual([])
    expect(h.ratings, 'nothing was rated').toBe(0)
  })

  test(`day one: Not now closes the tip, and it does not come back (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: FRESH_INSTALL })
    const d = drive($, h)
    await d.start(surface)
    await pressBandKey($, 'tip-later')
    expect(await bandText($, surface)).toBe('')
    expect(h.filled, 'nothing in the prompt box').toEqual([])
    await d.start(surface)
    expect(await bandText($, surface), 'once per install').toBe('')
  })

  test(`day one: not on a Sonnet start: the tip is for an Opus start, and it stays unspent (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    // Sonnet: the tip is for an Opus start.
    const sonnet = engine(on, { model: 'claude-sonnet-5-5', effort: 'medium', store: FRESH_INSTALL })
    await drive($, sonnet).start(surface)
    expect(await bandText($, surface), 'Sonnet').toBe('')
    expect(sonnet.store.startDayOne, 'and it is still to come').toBeUndefined()
  })

  test(`day one: 50 rated prompts are enough for the log to speak: no day-one tip, and it stays unspent (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: FRESH_INSTALL })
    h.files[RUNS] = easyLog(h.now)
    const d = drive($, h)
    await d.start(surface)
    expect(await bandText($, surface)).not.toContain('Starting tip')
    expect(h.store.startDayOne).toBeUndefined()
  })

  test(`day one: Start suggestions set to off shows no tip and spends none (${surface})`, { timeoutMs: 30000, options: { startTips: 'off' } }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: FRESH_INSTALL, stored: { startTips: 'off' } })
    const d = drive($, h)
    await d.start(surface)
    expect(await bandText($, surface)).toBe('')
    expect(h.store.startDayOne).toBeUndefined()
  })

  test(`day one: with Band set to Never there is no band to put it on: no tip, and none spent (${surface})`, { timeoutMs: 30000, options: { band: 'off' } }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: FRESH_INSTALL, stored: { band: 'off' } })
    const d = drive($, h)
    await d.start(surface)
    expect(await bandText($, surface)).toBe('')
    expect(h.store.startDayOne).toBeUndefined()
    expect(h.files[LOG_PATH] ?? '').not.toContain('day-one')
  })

  test(`day one: Stop suggesting in the ⋯ menu turns start suggestions off in /config (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: FRESH_INSTALL })
    const d = drive($, h)
    await d.start(surface)
    expect(await bandText($, surface)).toBe(DAY_ONE)
    await openMenu($, h, { Options: 'Stop suggesting' })
    expect(last(h.configSet)).toBe('off')
    expect(h.stored.startTips).toBe('off')
    expect(await bandText($, surface)).toBe('')
  })

  test(`the Band setting: when it acts, always, off, and the ⋯ and × buttons (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    // Opus at low: a lookup needs nothing there (at medium it would be lowered, ADR 0021).
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'low', store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')

    // "when it acts" (the default): no change, no band.
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    expect(await bandText($, surface)).toBe('')

    // "always": the same prompt shows that nothing changed.
    await setBand($, 'always')
    expect(await bandText($, surface)).toBe('No change: low on Opus fits this prompt.')

    // × closes it until the next prompt.
    let ui = await mount($, surface)
    await ui.press({ key: 'close' })
    await ui.unmount()
    expect(await bandText($, surface)).toBe('')
    await d.submit(LOOKUP)
    expect(await bandText($, surface)).toContain('No change')

    // ⋯ opens the menu; "When the band shows…" asks when the band should show, and saves the answer in /config.
    h.answers = { Options: 'When the band shows…', Band: 'Never (status line only)' }
    ui = await mount($, surface)
    const asked = h.asked.length
    await ui.press({ key: 'mode' })
    await untilAsked(h, asked, 2)
    await ui.unmount()
    expect(last(h.configSet)).toBe('off')
    expect(await bandText($, surface)).toBe('')

    // "off": a hand-off result goes back to a transcript line.
    h.rating = '{"level":"high","model":"fable","size":"small","type":"debug","read":30000,"write":4000,"steps":12,"reason":"subtle concurrency bug"}'
    await d.submit(DEBUG)
    await d.step('t1')
    await d.complete('t1')
    expect(await bandText($, surface)).toBe('')
    expect(last(h.logs) ?? '').toContain('did not hand this to a Fable subagent')
  })

  test(`adds its calibration to what another session saved, and skips turns that stepped up (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')

    // Another session saves its runs after this one loaded the calibration.
    h.store[CAL_STORE] = { ...FREE_SWITCHES, 'debug:main': { n: 3, ratio: 2 } }
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    await d.step('t1')
    await d.complete('t1')
    let cal = h.store[CAL_STORE] as Record<string, { n: number }>
    expect(cal['debug:main']?.n, "the other session's runs are kept").toBe(3)
    expect(cal['lookup:main']?.n, "this session's run is added").toBe(1)
    expect(cal['cache:effort-switch']?.n, 'the switch record is kept, plus this lowered turn\'s switch').toBe(21)

    // An auto-lowered turn that steps back up (a tool error brings the session's level back) teaches nothing.
    h.rating = LOWER
    await d.submit(LOOKUP)
    await d.step('t2', 0)
    await d.bash('fail x')
    await d.step('t2', 1)
    expect(last(h.sent)?.effort, 'back to medium after the error').toBe('medium')
    await d.complete('t2')
    cal = h.store[CAL_STORE] as Record<string, { n: number }>
    expect(cal['lookup:main']?.n, 'the stepped-up turn is not counted').toBe(1)
  })

  test(`learns calibration into calibration-v2 and ignores the old calibration key (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { calibration: { 'lookup:main': { n: 40, ratio: 9 } }, [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    await d.start(surface)
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    await d.step('t1')
    await d.complete('t1')
    expect(CAL_STORE).toBe('calibration-v2')
    const cal = h.store['calibration-v2'] as Record<string, { n: number; ratio: number }>
    expect(cal['lookup:main']?.n, 'learned from zero, not from the old key').toBe(1)
    expect(cal['cache:effort-switch']?.n, 'read back from the new key').toBe(20)
    expect(h.store.calibration, 'the old key is left as it was').toEqual({ 'lookup:main': { n: 40, ratio: 9 } })
  })

  test(`a stored Hand-off threshold is ignored: not listed as yours (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', stored: { handOff: '50%' } })
    const d = drive($, h)
    await d.start(surface)
    expect((await d.command('status')).text ?? '').not.toContain('Hand-off threshold:')
  })

  test(`skips slash commands and other senders (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    await d.submit('/rightsize show me the current level please')
    await ($ as unknown as Engine).prompt.submit({ text: DEBUG, origin: { kind: 'task-notification' }, wait: false })
    expect(h.ratings).toBe(0)
    const status = await d.command('status')
    expect(status.text ?? '').not.toContain('Lowering:')
  })

  test(`checks prices every 30 days, and on /rightsize prices (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { pricesCheckedAt: 1_800_000_000_000 - DAY } })
    const d = drive($, h)
    h.page = PAGE
    h.pricesFile = OLD_PRICES
    await d.start(surface)
    await flush()
    expect(h.fetches, 'checked yesterday: not due').toBe(0)

    const r = await d.command('prices')
    expect(h.fetches).toBe(1)
    expect(r.text ?? '').toContain('Sonnet 5.5 cache read: $0.2 → $0.1')
    expect(h.backup, 'old file kept').toBe(OLD_PRICES)
    expect((JSON.parse(h.pricesFile) as { models: { sonnet: { cacheRead: number } } }).models.sonnet.cacheRead).toBe(0.1)
    expect(last(h.logs) ?? '').toContain('Prices updated')
    expect(h.store.pricesCheckedAt).toBe(h.now)

    // Again, right away: /rightsize prices always checks.
    expect((await d.command('prices')).text ?? '').toContain('no change')
    expect(h.fetches).toBe(2)
    // "check now" is not a Price check option any more: the row refuses it, and nothing is checked.
    const refused = await d.config('priceCheck', 'check now')
    await flush()
    expect(refused.deny).toBeDefined()
    expect(h.fetches).toBe(2)
    expect(h.configSet, 'nothing was written').toEqual([])

    // 31 days on, the next session start checks by itself.
    h.now += 31 * DAY
    await d.start(surface)
    await flush()
    expect(h.fetches).toBe(3)

    // A page that moved: nothing is written, and the check is not marked done.
    h.page = '<html>moved</html>'
    h.now += 31 * DAY
    const before = h.pricesFile
    const moved = await d.command('prices')
    expect(moved.text ?? '').toContain('found 0 of 4 models')
    expect(h.pricesFile).toBe(before)
    expect(h.store.pricesCheckedAt, 'still due').not.toBe(h.now)
  })

  test(`claims the monthly check before fetching, and gives the claim back when it fails (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const lastMonth = 1_800_000_000_000 - 31 * DAY
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { pricesCheckedAt: lastMonth } })
    const d = drive($, h)
    h.page = PAGE
    h.pricesFile = OLD_PRICES
    let release = () => {}
    h.hold = new Promise<void>(resolve => {
      release = resolve
    })
    await d.start(surface)
    await flush()
    expect(h.fetches).toBe(1)
    // Another session starting now reads this and finds the check not due.
    expect(h.store.pricesCheckedAt, 'claimed while the page is still loading').toBe(h.now)
    release()
    await flush()
    expect(h.store.pricesCheckedAt).toBe(h.now)

    // 31 days on, the page fails: the claim goes back, so the next start tries again.
    h.hold = null
    h.fetchFails = true
    h.now += 31 * DAY
    const claimedFrom = h.store.pricesCheckedAt
    await d.start(surface)
    await flush()
    expect(h.fetches).toBe(2)
    expect(h.store.pricesCheckedAt, 'given back: still due').toBe(claimedFrom)
  })

  test(`reads a subscription off the rate limits and does not ask (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    h.rateLimits = [{ kind: 'five_hour', percentUsed: 12 }, { kind: 'seven_day', percentUsed: 3 }]
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    expect(h.store.billing).toEqual({ value: 'subscription', by: 'detected' })
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    expect(h.asked.length, 'no billing question').toBe(0)
    expect((await d.command('status')).text ?? '').toContain('Reports: subscription (detected)')
  })

  test(`asks about billing only after a response says nothing, and keeps the answer (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    h.rateLimits = []
    h.rating = NO_CHANGE
    h.answers = { Billing: 'API (pay per token)' }
    await d.start(surface)
    await d.submit(LOOKUP)
    expect(h.asked.length, 'no response read yet: nothing to ask on').toBe(0)
    await d.step('t1')
    await d.complete('t1')

    await d.submit(LOOKUP)
    // Billing waits on the band for the turn to end.
    await d.step('t1b')
    await d.complete('t1b')
    await settle()
    expect(h.asked.map(a => a.header)).toEqual(['Billing'])
    expect(h.store.billing).toEqual({ value: 'api', by: 'answered' })
    await d.submit(LOOKUP)
    expect(h.asked.length, 'asked once').toBe(1)

    // A new session keeps the answer while the rate limits still say nothing.
    await d.start(surface)
    await d.step('t2')
    await d.complete('t2')
    await d.submit(LOOKUP)
    expect(h.asked.length).toBe(1)

    // Your answer stands: rate limits that show a subscription change nothing, and /rightsize says they disagree.
    h.rateLimits = [{ kind: 'five_hour', percentUsed: 1 }]
    await d.step('t3')
    await d.complete('t3')
    expect(h.store.billing, 'still your answer').toEqual({ value: 'api', by: 'answered' })
    const status = (await d.command('status')).text ?? ''
    expect(status).toContain('Reports: api')
    expect(status).toContain('Rate limits look like a subscription; Reports is set to api by you.')
    expect(h.stored.billing, 'the answer is the Reports row too').toBe('api')
  })

  test(`measures a turn's cost off the session's cost ledger, leaving out the rating (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    const runs = () =>
      (h.files[RUNS_FILE] ?? '')
        .trim()
        .split('\n')
        .map(l => JSON.parse(l) as { actual: number; measured: string; tokens: number })
    await d.start(surface)
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    await d.step('t1', 0)
    await d.step('t1', 1)
    await d.complete('t1')
    expect(last(runs())?.measured).toBe('ledger')
    expect(last(runs())?.actual, 'two requests at $0.01, the $0.50 rating left out').toBe(0.02)

    // No ledger: the token counts priced from prices.json.
    h.ledger = undefined
    await d.submit(LOOKUP)
    await d.step('t2')
    await d.complete('t2')
    const r = last(runs())
    expect(r?.measured).toBe('tokens')
    expect(r?.actual).toBe(r?.tokens)
  })

  test(`logs every rated turn with its change, overhead and windows, and /rightsize report adds them up (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    const runs = () =>
      (h.files[RUNS_FILE] ?? '')
        .trim()
        .split('\n')
        .map(l => JSON.parse(l) as { kind: string; session: string; change: string; offered: string; overhead: number; before?: Record<string, number>; after?: Record<string, number> })
    // The log's times are the wall clock's: the report's periods count from now.
    h.now = Date.now()
    h.rateLimits = [{ kind: 'five_hour', percentUsed: 10 }]
    h.windowStep = 1
    h.ratingUsage = { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')

    // A lookup on Opus: lowered, and logged.
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    await d.step('t1')
    await d.complete('t1')
    const first = last(runs())
    expect(first?.kind).toBe('run')
    expect(first?.session).toBe('sess-1')
    expect(first?.change, 'on Opus at medium a lookup is lowered to low (ADR 0021)').toBe('lower')
    expect(first?.overhead, '1000 in and 100 out on Sonnet, the rater').toBe(0.003)
    expect((first as { normal?: string; context?: number })?.normal, 'the session level, for the starting-point check').toBe('medium')
    expect(typeof (first as { context?: number })?.context).toBe('number')
    expect(first?.before).toEqual({ five_hour: 11 })
    expect(first?.after).toEqual({ five_hour: 12 })

    // Lowered on its own.
    h.rating = '{"level":"low","model":"same","size":"small","type":"lookup","read":2000,"write":3000,"steps":1}'
    await d.submit(LOOKUP)
    await d.step('t2')
    await d.complete('t2')
    expect(last(runs())?.change).toBe('lower')
    expect(last(runs())?.offered).toBe('lower')

    // A rating that comes to nothing, twice: the prompt is logged as unrated, with what both calls cost.
    h.rating = 'no json here'
    await d.submit(LOOKUP)
    expect(last(runs())?.kind).toBe('unrated')
    expect(last(runs())?.overhead, 'Sonnet\'s call and the Haiku fallback\'s, 1000 in and 100 out each').toBe(0.00315)

    const report = await d.report()
    expect(cellsOf(report, 'Prompts rated')).toEqual(['2'])
    expect(cellsOf(report, 'Effort lowered')).toEqual(['2 prompts'])
    expect(report).toContain('The saving is after the cost of rating prompts')
    expect(report, 'the row text is the plain report on every surface').not.toContain('```')
    // The row draws the Markdown form off the terminal: the tables in fences, so their columns line up.
    // The raw estimates (YOUR SAVINGS, 30-DAY SUMMARY) moved to the details view (ADR 0058): their fences are counted there.
    const drawnFor = async (args: string) => {
      const text = (await d.command(args)).text ?? ''
      const row = await ($ as unknown as { ui: { mount: (x: unknown) => Promise<{ find: (q: unknown) => Promise<{ props: unknown } | undefined>; unmount: () => Promise<void> }> } }).ui.mount({ plugin: 'rightsize', component: 'CommandOutput', surface, props: { command: 'rightsize', args, text, isErrored: false } })
      const drawn = ((await row.find({ type: 'Markdown', key: 'report' }))?.props as { text?: string } | undefined)?.text
      await row.unmount()
      return drawn
    }
    const fences = (t: string | undefined) => t?.split('\n').filter(l => l === '```').length
    const drawn = await drawnFor('report details')
    if (surface === 'desktop') {
      expect(fences(drawn), 'savings and summary fenced').toBeGreaterThanOrEqual(4)
      expect(fences(await drawnFor('report')), 'what rightsize did fenced').toBeGreaterThanOrEqual(2)
    } else expect(drawn, 'the terminal draws the plain row').toBeUndefined()
    expect(report).toContain('NOT COUNTED AS SAVINGS')
  })

  // Close calls. A Fable session at high effort, a feature that Sonnet, Opus and Fable all do at medium.
  // Opus is measured (20 runs) at 0.9x Sonnet's estimate, Sonnet not at all: the 25% band is open, so the
  // two are close and the task-type guide (feature: Sonnet) decides.
  // Close calls are never explored.
  const TIE_RATING = '{"fit":{"haiku":"no","sonnet":"medium","opus":"medium","fable":"medium"},"type":"feature","read":150000,"write":3000,"steps":30,"reason":"big feature"}'
  const tieRating: Rating = { level: 'medium', fit: { haiku: null, sonnet: 'medium', opus: 'medium', fable: 'medium' }, type: 'feature', read: 150_000, write: 3000, steps: 30, reason: '' }
  const fableHigh: Situation = { tier: 'fable', level: 'high', context: 20_000, prices: DEFAULT_PRICES, cal: {} }
  // Opus's key pinned to `x` times Sonnet's estimate, from the raw cost of each route.
  const opusAt = (x: number, raw: (t: 'sonnet' | 'opus') => number, keys: readonly string[]): Calibration => ({
    [keys[keys.length - 1] ?? '']: { n: CAL_FULL, ratio: (raw('sonnet') * x) / raw('opus') },
  })
  const tieCal = (x: number) => opusAt(x, t => delegateCost(tieRating, fableHigh, t, 'medium'), delegateKeys('feature', 'opus', 'medium'))

  test(`a close call decided by the guide is logged on the run (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const cal = { ...tieCal(0.9), ...FREE_SWITCHES }
    const p = plan(tieRating, { ...fableHigh, cal }, 'low')
    expect(p.kind === 'delegate' && p.tie, 'the setup is a close call').toEqual({ by: 'guide', over: 'opus' })
    const h = engine(on, { model: 'claude-fable-5-2', effort: 'high', store: { [CAL_STORE]: cal } })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')

    h.rating = TIE_RATING
    await d.submit(SEARCH)
    expect(last(h.submitted)?.context?.join('\n') ?? '', 'the guide\'s pick, not the cheaper Opus').toContain('model "sonnet"')
    h.subModel = 'claude-sonnet-5-5'
    await d.step('t1', 0)
    await d.agent('sonnet')
    await d.step('t1', 0, 'a1')
    await d.step('t1', 1)
    await d.complete('t1')
    const runs = (h.files[RUNS_FILE] ?? '').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
    expect(last(runs)?.route).toBe('delegate:sonnet')
    expect(last(runs)?.tie).toEqual({ by: 'guide', over: 'opus' })
    expect((h.files[LOG_PATH] ?? '').includes('tie guide over opus'), 'the log says so').toBe(true)

    // The next close call takes the guide's pick again: close calls are never explored.
    await d.submit(SEARCH)
    expect(last(h.submitted)?.context?.join('\n') ?? '', 'the guide again').toContain('model "sonnet"')
  })

  test(`a prompt with no close call logs no tie (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const cal = { ...tieCal(0.7), ...FREE_SWITCHES }
    const h = engine(on, { model: 'claude-fable-5-2', effort: 'high', store: { [CAL_STORE]: cal } })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = TIE_RATING
    await d.submit(SEARCH)
    expect(last(h.submitted)?.context?.join('\n') ?? '', 'the cheapest').toContain('model "opus"')
    h.subModel = 'claude-opus-5-5'
    await d.step('t1', 0)
    await d.agent('opus')
    await d.step('t1', 1)
    await d.complete('t1')
    const runs = (h.files[RUNS_FILE] ?? '').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
    expect('tie' in (last(runs) ?? {})).toBe(false)
  })

  test(`a close call in sizing Claude's subagent is logged on its resize (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const sub: Situation = { ...fableHigh, tier: 'fable' }
    // Both models carry the same rework factor under a Fable parent, so the raw estimates compare as the calibrated ones do.
    const raw = (t: 'sonnet' | 'opus') => subWork(tieRating, sub, t, 'medium')
    const cal = opusAt(0.9, raw, subagentKeys('feature', 'opus', 'medium'))
    const size = sizeSubagent(tieRating, { ...sub, cal }, 'fable', 'low')
    expect(size?.tie, 'the setup is a close call').toEqual({ by: 'guide', over: 'opus' })
    const h = engine(on, { model: 'claude-fable-5-2', effort: 'high', store: { [CAL_STORE]: cal } })
    const d = drive($, h)
    await d.start(surface)
    h.rating = NO_CHANGE
    await d.submit(SEARCH)
    await d.step('t1', 0)
    h.rating = TIE_RATING
    await d.spawn('lister')
    expect(h.spawned.map(x => x.model), 'sent to the guide\'s model').toEqual(['sonnet'])
    await d.step('t1', 1)
    await d.complete('t1')
    const runs = (h.files[RUNS_FILE] ?? '').trim().split('\n').map(l => JSON.parse(l) as { resized?: { tier: string; tie?: unknown }[] })
    expect(last(runs)?.resized?.map(r => [r.tier, r.tie])).toEqual([['sonnet', { by: 'guide', over: 'opus' }]])
  })

  // Rater check: Sonnet's second opinion on every 20th Haiku rating, in the background.
  const FIT_NO = '{"fit":{"haiku":"no","sonnet":"no","opus":"medium","fable":"medium"},"type":"feature","read":2000,"write":300,"steps":1,"reason":"plain change"}'
  const CHECK_NO = '{"fit":{"haiku":"no","sonnet":"no","opus":"no","fable":"high"},"type":"feature","read":2000,"write":300,"steps":1}'
  const runLines = (h: ReturnType<typeof engine>) =>
    (h.files[RUNS_FILE] ?? '')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l) as Record<string, unknown>)
  const SONNET_USAGE = { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

  test(`the 20th Haiku-rated prompt gets Sonnet's second opinion in the background, logged as a check line (${surface})`, { timeoutMs: 60000, options: { rater: 'haiku' } }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES }, stored: { rater: 'haiku' } })
    const d = drive($, h)
    h.now = Date.now()
    await d.start(surface)
    h.rating = FIT_NO
    h.checkRating = CHECK_NO
    for (let i = 1; i < 20; i++) await d.submit(LOOKUP)
    expect(h.completions.filter(m => m === 'sonnet'), 'none before the 20th (Balanced checks every 20)').toEqual([])
    expect(h.store.spotChecks).toBe(19)

    // The 20th: Sonnet is asked, and the prompt goes through while it is still thinking.
    let release = () => {}
    h.checkHold = new Promise<void>(resolve => {
      release = resolve
    })
    const sent = h.submitted.length
    await d.submit(LOOKUP)
    expect(h.submitted.length, 'the prompt was not held back').toBe(sent + 1)
    expect(h.completions.filter(m => m === 'sonnet'), 'asked once, after Haiku').toEqual(['sonnet'])
    expect(last(h.completions.slice(0, -1))).toBe('haiku')
    expect(h.store.spotChecks).toBe(20)
    expect(runLines(h).some(l => l.kind === 'check'), 'no line until it answers').toBe(false)

    release()
    await flush()
    const check = runLines(h).find(l => l.kind === 'check') as { kind: string; session: string; type: string; fit: unknown; check: unknown; overhead: number } | undefined
    expect(check?.session).toBe('sess-1')
    expect(check?.type).toBe('feature')
    expect(check?.fit, "Haiku's fit").toEqual({ haiku: null, sonnet: null, opus: 'medium', fable: 'medium' })
    expect(check?.check, "Sonnet's fit: Opus would struggle").toEqual({ by: 'sonnet', fit: { haiku: null, sonnet: null, opus: null, fable: 'high' } })
    expect(check?.overhead, 'its cost is logged').toBe(0)
    expect(runLines(h).filter(l => l.kind === 'run').length, 'a check line is not a rated run').toBe(0)

    // The 21st to 39th are not checked; the report counts the disagreement.
    await d.submit(LOOKUP)
    expect(h.completions.filter(m => m === 'sonnet').length).toBe(1)
    const report = await d.report()
    expect(report).toMatch(/Haiku's judgement +wrong on 1 of 2 checked prompts \(50%\)/)
    expect(report, 'a check line is not a prompt').toContain('Nothing rated yet.')
  })

  test(`a check that lands during a turn is left out of that turn's cost (${surface})`, { timeoutMs: 30000, options: { rater: 'haiku' } }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES, spotChecks: 19 }, stored: { rater: 'haiku' } })
    const d = drive($, h)
    h.now = Date.now()
    await d.start(surface)
    h.rating = FIT_NO
    h.checkRating = CHECK_NO
    h.checkUsage = SONNET_USAGE
    h.checkCost = 2
    let release = () => {}
    h.checkHold = new Promise<void>(resolve => {
      release = resolve
    })
    await d.submit(LOOKUP)
    await d.step('t1')
    release()
    await flush()
    await d.complete('t1')
    const lines = runLines(h)
    expect((lines.find(l => l.kind === 'check') as { overhead: number }).overhead, '1M Sonnet input tokens').toBe(2)
    expect((lines.find(l => l.kind === 'run') as { actual: number }).actual, "the turn's own cost: one step").toBe(0.01)
  })

  test(`a check that fails or cannot be read adds no check line, only its cost (${surface})`, { timeoutMs: 30000, options: { rater: 'haiku' } }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { spotChecks: 19 }, stored: { rater: 'haiku' } })
    const d = drive($, h)
    await d.start(surface)
    h.rating = FIT_NO
    h.checkRating = 'no json here'
    h.checkUsage = SONNET_USAGE
    await d.submit(LOOKUP)
    await flush()
    expect(runLines(h).map(l => l.kind)).toEqual(['overhead'])
    expect((runLines(h)[0] as { overhead: number }).overhead).toBe(2)
  })

  test(`Sonnet rates first; a Sonnet rating is not spot-checked and does not count toward the check (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { spotChecks: 49 } })
    const d = drive($, h)
    h.now = Date.now()
    await d.start(surface)
    h.rating = FIT_NO
    await d.submit(LOOKUP)
    await flush()
    expect(h.completions, 'one call, to Sonnet: no Haiku, and no check').toEqual(['sonnet'])
    expect(h.store.spotChecks, 'not counted').toBe(49)
    await d.step('t1')
    await d.complete('t1')
    expect(runLines(h).find(l => l.kind === 'run')?.rater, 'the run line says who rated').toBe('sonnet')
  })

  test(`a Sonnet rating that times out, is refused or is unreadable falls back to Haiku once; both failing logs the prompt unrated (${surface})`, { timeoutMs: 60000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    h.now = Date.now()
    // Sonnet and Haiku are priced apart: 1M input tokens each.
    h.ratingUsage = SONNET_USAGE
    await d.start(surface)
    h.rating = FIT_NO
    for (const [n, queue] of [['timeout', ['timeout']], ['refused', ['unavailable']], ['unreadable', ['no json']]] as const) {
      h.completions = []
      h.ratingQueue = [...queue]
      await d.submit(`${LOOKUP} ${n}`)
      expect(h.completions, `${n}: Sonnet, then Haiku once`).toEqual(['sonnet', 'haiku'])
      expect(h.ratingQueue).toEqual([])
      const t = `t-${n}`
      await d.step(t)
      await d.complete(t)
      const run = last(runLines(h).filter(l => l.kind === 'run')) as { rater: string; overhead: number }
      expect(run.rater, `${n}: Haiku rated`).toBe('haiku')
      // 1M input tokens on Sonnet ($2) plus 1M on Haiku; a Haiku prompt over 100K tokens pays $0.50 a million, not $0.10.
      expect(run.overhead, `${n}: each call priced with its own model`).toBe(2.5)
    }
    expect(runLines(h).some(l => l.kind === 'unrated')).toBe(false)

    // Both fail: unrated, the session as it was, no third call.
    h.completions = []
    h.ratingQueue = ['timeout', 'no json']
    await d.submit(`${LOOKUP} both`)
    expect(h.completions).toEqual(['sonnet', 'haiku'])
    const unrated = runLines(h).filter(l => l.kind === 'unrated')
    // An unrated prompt is part of the task in progress: the last rated run's.
    const task = (last(runLines(h).filter(l => l.kind === 'run')) as { task: string }).task
    expect(unrated).toEqual([{ at: expect.any(String), kind: 'unrated', session: 'sess-1', task, reason: 'rating unreadable', rater: 'haiku', overhead: 2.5, ratingMs: 0 }])
    expect(h.files[LOG_FILE] ?? '').toContain('prompt not rated (rating unreadable)')
    expect(h.files[LOG_FILE] ?? '').toContain('rating by sonnet failed (rating call timed out): trying haiku')
  })

  test(`all rating attempts for a prompt fit in 12 s: Sonnet gets 9, Haiku the rest, and run lines carry ratingMs and submittedAt (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    h.now = Date.now()
    await d.start(surface)
    h.rating = FIT_NO

    // A rating inside its time: Sonnet had 9 s, and the run says how long it took and when the prompt came in.
    h.ratingTakes = [1800]
    const t0 = h.now
    await d.submit(LOOKUP)
    expect(h.ratingTimeouts, 'Sonnet had at most 9 s').toEqual([9000])
    await d.step('t1')
    await d.complete('t1')
    const first = last(runLines(h).filter(l => l.kind === 'run')) as { ratingMs: number; submittedAt: string; rater: string }
    expect(first.ratingMs).toBe(1800)
    expect(first.submittedAt, 'when the prompt was submitted, before its rating').toBe(new Date(t0).toISOString())
    expect(first.rater).toBe('sonnet')

    // Sonnet used its 9 s: Haiku gets the 3 s that are left, and rates. The two attempts took 10 s.
    h.ratingTimeouts = []
    h.completions = []
    h.ratingQueue = ['timeout']
    h.ratingTakes = [9000, 1000]
    await d.submit(`${LOOKUP} slow`)
    expect(h.completions).toEqual(['sonnet', 'haiku'])
    expect(h.ratingTimeouts, 'Sonnet 9 s, then what is left of 12 s').toEqual([9000, 3000])
    await d.step('t2')
    await d.complete('t2')
    const second = last(runLines(h).filter(l => l.kind === 'run')) as { ratingMs: number; rater: string }
    expect(second.rater).toBe('haiku')
    expect(second.ratingMs).toBe(10_000)
  })

  test(`when Sonnet used nearly all the budget, Haiku is skipped: the prompt is unrated, runs unchanged, and the line says why (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    h.now = Date.now()
    await d.start(surface)
    h.rating = LOWER
    h.ratingQueue = ['timeout']
    // 10.5 s gone: 1.5 s is left, under the 2 s an attempt needs.
    h.ratingTakes = [10_500]
    await d.submit(LOOKUP)
    expect(h.completions, 'Sonnet only: no Haiku attempt').toEqual(['sonnet'])
    await d.step('t1')
    expect(last(h.sent)?.effort, 'no rating, no change').toBe('medium')
    expect(last(h.sent)?.model).toBe('claude-opus-5-5')
    await d.complete('t1')
    expect(runLines(h).filter(l => l.kind === 'unrated')).toEqual([{ at: expect.any(String), kind: 'unrated', session: 'sess-1', reason: 'rating budget used up', rater: 'sonnet', overhead: 0, ratingMs: 10_500 }])
    expect(h.files[LOG_FILE] ?? '').toContain('rating budget used up: not rated')
    expect(h.files[LOG_FILE] ?? '').toContain('prompt not rated (rating budget used up)')

    // Exactly 2 s left is enough for an attempt.
    h.completions = []
    h.ratingTimeouts = []
    h.ratingQueue = ['timeout']
    h.ratingTakes = [10_000]
    await d.submit(`${LOOKUP} again`)
    expect(h.completions).toEqual(['sonnet', 'haiku'])
    expect(h.ratingTimeouts).toEqual([9000, 2000])

    // The report counts the budget hit.
    const text = await d.report()
    expect(text).toMatch(/Rating budget used up +1 of \d+ prompts?/)
  })

  test(`Rater set to haiku: the first try leaves room for the retry, and a retry with under 2 s left is not made (${surface})`, { timeoutMs: 30000, options: { rater: 'haiku' } }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', stored: { rater: 'haiku' } })
    const d = drive($, h)
    h.now = Date.now()
    await d.start(surface)
    h.rating = FIT_NO
    h.ratingQueue = ['timeout']
    h.ratingTakes = [10_000, 500]
    await d.submit(LOOKUP)
    expect(h.completions).toEqual(['haiku', 'haiku'])
    expect(h.ratingTimeouts, 'the first try 10 s, the retry the 2 s that are left').toEqual([10_000, 2000])

    h.completions = []
    h.ratingTimeouts = []
    h.ratingQueue = ['timeout']
    h.ratingTakes = [10_500]
    await d.submit(`${LOOKUP} slow`)
    expect(h.completions, 'no retry: 1.5 s is left').toEqual(['haiku'])
    expect(runLines(h).filter(l => l.kind === 'unrated').at(-1)).toMatchObject({ reason: 'rating budget used up', rater: 'haiku', ratingMs: 10_500 })
  })

  test(`a Haiku rating after a Sonnet failure counts toward the spot-check, and one check is asked (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { spotChecks: 19 } })
    const d = drive($, h)
    h.now = Date.now()
    await d.start(surface)
    h.rating = FIT_NO
    h.checkRating = CHECK_NO
    h.ratingQueue = ['timeout']
    await d.submit(LOOKUP)
    await flush()
    expect(h.completions, 'Sonnet failed, Haiku rated, Sonnet checked').toEqual(['sonnet', 'haiku', 'sonnet'])
    expect(h.store.spotChecks).toBe(20)
    expect(runLines(h).some(l => l.kind === 'check')).toBe(true)
  })

  test(`Rater set to haiku rates with Haiku, retries a timeout once on Haiku, and never calls Sonnet to rate (${surface})`, { timeoutMs: 30000, options: { rater: 'haiku' } }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', stored: { rater: 'haiku' } })
    const d = drive($, h)
    await d.start(surface)
    h.rating = FIT_NO
    h.ratingQueue = ['timeout']
    await d.submit(LOOKUP)
    expect(h.completions).toEqual(['haiku', 'haiku'])
    h.completions = []
    h.ratingQueue = ['unavailable']
    await d.submit(LOOKUP)
    expect(h.completions, 'a refused rater is not asked again').toEqual(['haiku'])
    expect((await d.command('status')).text ?? '').toContain('Rater: haiku')
  })

  test(`on a Sonnet session a debug rating at high does not raise effort, and stuck detection still can (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-sonnet-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES, ...AUTO_RAISE } })
    const d = drive($, h)
    await d.start(surface)
    h.rating = '{"fit":{"haiku":"no","sonnet":"high","opus":"medium","fable":"medium"},"type":"debug","read":20000,"write":3000,"steps":8,"reason":"unknown cause"}'
    await d.submit(DEBUG)
    await d.step('t1', 0)
    expect(last(h.sent)?.effort, 'the rating alone does not raise').toBe('medium')
    await d.bash('fail npm test')
    await d.bash('fail npm test')
    await d.step('t1', 1)
    expect(last(h.sent)?.effort, 'the same call failing twice raises it').toBe('high')
  })

  // 👍 and 👎: a hand-off's result and an automatic lowering can be marked, on this machine only.
  const pressBandKey = async ($: unknown, key: string) => {
    const ui = await mount($, surface)
    await ui.press({ key })
    await ui.unmount()
  }
  const buttons = async ($: unknown) => {
    const ui = await mount($, surface)
    const keys = (await ui.findAll({ type: 'Button' })).map(b => b.key)
    await ui.unmount()
    return keys
  }

  /** Presses ⋯ and picks a mark from the menu (the marks are menu entries now): the menu is the first list asked, under "Options". */
  const markFromMenu = async ($: unknown, h: ReturnType<typeof engine>, label?: string) => {
    h.answers = label ? { Options: label } : {}
    const before = h.asked.length
    const ui = await mount($, surface)
    await ui.press({ key: 'mode' })
    await untilAsked(h, before)
    await ui.unmount()
    return h.asked.slice(before)
  }

  test(`👍 and 👎 in the ⋯ menu on a hand-off's result write a feedback line for that run, once (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-fable-5-2', effort: 'high', stored: NO_COLD })
    const d = drive($, h)
    h.now = Date.now()
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')

    h.rating = '{"level":"low","model":"haiku","size":"bulky","type":"search","read":150000,"write":3000,"steps":30,"reason":"repo-wide search"}'
    // Claude answers without the subagent: nothing to mark.
    await d.submit(SEARCH)
    await d.step('t1')
    await d.complete('t1')
    await settle()
    expect(await buttons($), 'no hand-off happened').toEqual(['mode', 'close'])
    expect((await markFromMenu($, h)).flatMap(a => a.options), 'no marks in the menu either').not.toContain('Mark this 👍 (right call)')

    await d.submit(SEARCH)
    await d.step('t2', 0)
    await d.agent('haiku')
    await d.step('t2', 0, 'a2')
    await d.step('t2', 1)
    await d.complete('t2')
    expect(await bandText($, surface)).toMatch(/^Sent to Haiku\./)
    expect(await buttons($), '👍 and 👎 are not buttons').toEqual(['mode', 'close'])

    const asks = await markFromMenu($, h, 'Mark this 👎 (wrong call)')
    expect(asks[0]?.options, 'the marks are menu entries').toEqual(expect.arrayContaining(['Mark this 👍 (right call)', 'Mark this 👎 (wrong call)']))
    expect(last(h.toasts)).toBe('Rightsize: thanks — this tunes its choices on this machine.')
    const lines = runLines(h)
    const handOff = lines.filter(l => l.kind === 'run').find(l => l.route === 'delegate:haiku') as { id: string } | undefined
    expect(handOff?.id, 'the run line carries an id').toBeTruthy()
    const feedback = lines.filter(l => l.kind === 'feedback')
    expect(feedback.length).toBe(1)
    expect(feedback[0]).toMatchObject({ kind: 'feedback', session: 'sess-1', ref: handOff?.id, value: 'down' })
    expect(typeof feedback[0]?.at).toBe('string')
    expect(await bandText($, surface), 'the band itself stays').toMatch(/^Sent to Haiku\./)
    expect((await markFromMenu($, h)).flatMap(a => a.options), 'the marks go once given').not.toContain('Mark this 👍 (right call)')
    // Nothing leaves the machine: no fetch beyond the price check, and the line is only in the run log.
    expect(h.fetches).toBeLessThanOrEqual(1)
    // One hit (no rework) and one 👎, both Haiku's.
    expect(await d.report()).toMatch(/Haiku's judgement +wrong on 1 of 2 checked prompts \(50%\)/)
  })

  test(`👍 and 👎 in the ⋯ menu on an automatic lowering write a feedback line for that run, and 👍 counts as a hit (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES }, stored: NO_COLD })
    const d = drive($, h)
    h.now = Date.now()
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')

    h.rating = LOWER
    await d.submit(LOOKUP)
    await d.step('t1')
    await d.complete('t1')
    await settle()
    expect(await buttons($), '👍 and 👎 are not buttons').toEqual(['retry', 'mode', 'close'])

    const asks = await markFromMenu($, h, 'Mark this 👍 (right call)')
    expect(asks[0]?.options, 'the marks are menu entries').toEqual(expect.arrayContaining(['Mark this 👍 (right call)', 'Mark this 👎 (wrong call)']))
    const run = runLines(h).find(l => l.kind === 'run') as { id: string; change: string }
    expect(run.change).toBe('lower')
    expect(runLines(h).filter(l => l.kind === 'feedback')).toMatchObject([{ ref: run.id, value: 'up', session: 'sess-1' }])
    expect(last(h.toasts)).toBe('Rightsize: thanks — this tunes its choices on this machine.')
    expect(await buttons($)).toEqual(['retry', 'mode', 'close'])
    expect(await bandText($, surface), 'one rated prompt: no session total yet').toMatch(/^Effort lowered: medium → low for this prompt \(automatically\)\. Why: .+ Confidence: low\./)
    // The next lowering has its own id.
    await d.submit(LOOKUP)
    await d.step('t2')
    await d.complete('t2')
    await markFromMenu($, h, 'Mark this 👎 (wrong call)')
    const ids = runLines(h).filter(l => l.kind === 'run').map(l => l.id)
    expect(new Set(ids).size, 'two runs, two ids').toBe(2)
    expect(runLines(h).filter(l => l.kind === 'feedback').map(l => [l.ref, l.value])).toEqual([[ids[0], 'up'], [ids[1], 'down']])
  })

  test(`a raise and a no-change band offer no 👍 or 👎 (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    // A review: the one task type whose rated raise is still taken at prompt time on Opus (ADR 0021).
    h.rating = '{"level":"high","model":"same","type":"review","read":20000,"write":3000,"steps":8,"reason":"unknown cause"}'
    await d.submit(DEBUG)
    expect(await bandText($, surface)).toContain('Effort raised')
    expect(await buttons($)).toEqual(['mode', 'close'])
  })

  // The band says why, and for a move to a cheaper model how confident rightsize is; a hand-off or a switch-run
  // also offers "Run on <current model>", which runs this prompt once as it would have run without rightsize.
  const SMALL_FEATURE = '{"fit":{"haiku":"high","sonnet":"high","opus":"high","fable":"medium"},"size":"small","type":"search","read":20000,"write":2000,"steps":6,"reason":"small helper with tests"}'

  test(`a hand-off down says why and its confidence, and Run on Opus runs the prompt once as normal (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = SMALL_FEATURE
    await d.submit(DEBUG)
    const text = await bandText($, surface)
    expect(text).toMatch(/^Sending this to a Haiku subagent at high effort/)
    expect(text).toContain('Why: Small helper with tests.')
    expect(text, 'a fresh log: the research alone').toContain('Confidence: low.')
    expect(await buttons($), 'the rule buttons are in the ⋯ menu').toEqual(['stay', 'mode', 'close'])

    const ui = await mount($, surface)
    expect((await ui.find({ type: 'Button', label: 'Run on Opus' }))?.text ?? 'none', 'named for the current model').not.toBe('none')
    await ui.press({ key: 'stay' })
    expect(h.filled.at(-1), 'the prompt is back in the box').toBe(DEBUG)
    expect(last(h.toasts) ?? '').toContain('run it on Opus at medium')
    await ui.unmount()
    expect(await bandText($, surface), 'the band closes').toBe('')

    // Sending it again: not rated, no hand-off note; the next prompt after it is rated again.
    const rated = h.ratings
    await d.submit(DEBUG)
    expect(h.ratings, 'not rated').toBe(rated)
    expect(last(h.submitted)?.context ?? [], 'no subagent note').toEqual([])
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    expect(h.ratings, 'rated again').toBe(rated + 1)
  })

  test(`a switch-run says why, offers Run on Sonnet, and has no confidence (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-sonnet-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = REVIEW
    await d.submit(DEBUG)
    const text = await bandText($, surface)
    expect(text).toContain('Running this review on Opus at high effort')
    expect(text).toContain('Why: Subtle bug hunt.')
    expect(text).not.toContain('Confidence')
    await d.step('t1')
    await d.complete('t1')
    expect(await buttons($)).toContain('stay')
    const ui = await mount($, surface)
    await ui.press({ key: 'stay' })
    expect(h.filled.at(-1)).toBe(DEBUG)
    expect(last(h.toasts) ?? '').toContain('run it on Sonnet at medium')
    await ui.unmount()
    const rated = h.ratings
    await d.submit(DEBUG)
    expect(h.ratings, 'not rated').toBe(rated)
    await d.step('t2')
    expect(last(h.sent)?.model, 'runs on the session model').not.toBe('opus')
  })

  test(`a raise says why but has no confidence, and offers no Run on (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    // A review: the one task type whose rated raise is still taken at prompt time on Opus (ADR 0021).
    h.rating = '{"level":"high","model":"same","type":"review","read":20000,"write":3000,"steps":8,"reason":"unknown cause"}'
    await d.submit(DEBUG)
    const text = await bandText($, surface)
    expect(text).toContain('Effort raised')
    expect(text).toContain('Why: Unknown cause.')
    expect(text).not.toContain('Confidence')
    expect(await buttons($)).not.toContain('stay')
  })

  test(`a band with no reason from the rater has no Why (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = LOWER.replace(',"reason":"one function lookup"', '')
    await d.submit(LOOKUP)
    expect(await bandText($, surface)).toBe('Effort lowered: medium → low for this prompt (automatically). Confidence: low. The default decided (Lowering); ⋯ changes it.')
  })

  test(`the band says only the confidence level; the ⋯ menu question carries the counts (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    h.files[RUNS] = Array.from({ length: 12 }, (_, i) =>
      JSON.stringify({ at: new Date(h.now - (12 - i) * 60_000).toISOString(), kind: 'run', type: 'lookup', route: 'main', tier: 'opus', change: 'lower', task: `k${i}`, steppedUp: false, session: 'old' }),
    ).join('\n') + '\n'
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = LOWER
    await d.submit(LOOKUP)
    const text = await bandText($, surface)
    expect(text).toMatch(/Why: One function lookup\. Confidence: (high|medium)\. The default decided \(Lowering\); ⋯ changes it\.$/)
    expect(text, 'no counts on the band').not.toMatch(/of your tasks|missed|How sure/)
    h.answers = {}
    const before = h.asked.length
    const ui = await mount($, surface)
    await ui.press({ key: 'mode' })
    await untilAsked(h, before)
    await ui.unmount()
    expect(h.asked.at(-1)?.question).toMatch(/^Confidence: (high|medium), 12 of your tasks, \d+% missed\. Options for this band\. /)
  })

  // The record steers the next decisions: a model the rater has often got wrong gets no lowering.
  test(`a task type the rater keeps getting wrong is not lowered, once the log shows it (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES }, stored: NO_COLD })
    const d = drive($, h)
    h.files[RUNS] = Array.from({ length: 6 }, (_, i) =>
      JSON.stringify({ at: new Date(h.now - (6 - i) * 60_000).toISOString(), kind: 'run', type: 'lookup', route: 'main', tier: 'opus', change: 'lower', steppedUp: i < 3 }),
    ).join('\n') + '\n'
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = LOWER
    await d.submit(LOOKUP)
    expect(h.asked.length, 'wrong on 3 of 6 lookups on Opus: lowering is paused, so nothing is asked').toBe(0)
    await d.step('t1')
    expect(last(h.sent)?.effort, 'stays at medium').toBe('medium')
    await d.complete('t1')
    expect(await bandText($, surface)).toBe('')
    // The report says what the record is and what it paused.
    const report = await d.report()
    expect(report).toMatch(/Haiku's judgement +wrong on 3 of 6 checked prompts \(50%\)/)
    expect(report).toMatch(/Hand-downs paused +lookup work to Opus, wrong on 50% of 6/)
    expect(report.replace(/\s+/g, ' ')).toContain('Paused: hand-downs of lookup work to Opus (wrong on 50% of 6). They resume by themselves')
  })

  test(`with a clean record the same lowering goes ahead (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    h.files[RUNS] = Array.from({ length: 6 }, (_, i) =>
      JSON.stringify({ at: new Date(h.now - (6 - i) * 60_000).toISOString(), kind: 'run', type: 'lookup', route: 'main', tier: 'opus', change: 'lower', steppedUp: i < 1 }),
    ).join('\n') + '\n'
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = LOWER
    await d.submit(LOOKUP)
    await d.step('t1')
    expect(last(h.sent)?.effort, 'wrong on 1 of 6: under the line').toBe('low')
    await d.complete('t1')
  })
  const noteOf = (h: ReturnType<typeof engine>) => last(h.submitted)?.context?.join('\n') ?? ''
  const handedTo = (h: ReturnType<typeof engine>) => /model "(\w+)"/.exec(noteOf(h))?.[1]

  type Scene = { h: ReturnType<typeof engine>; d: ReturnType<typeof drive>; $: unknown; surface: string; turn: () => string }

  // One prompt, with the questions it asked and the effort and hand-off it ended in.
  const prompt = async (c: Scene, text: string, rating: string, answers: Record<string, string> = {}) => {
    const asked = c.h.asked.length
    c.h.rating = rating
    c.h.answers = answers
    await c.d.submit(text)
    await c.d.step(c.turn())
    return { asked: c.h.asked.slice(asked).map(a => a.header), effort: last(c.h.sent)?.effort, to: handedTo(c.h) }
  }
  const handOff = async (c: Scene, text: string, rating: string, answers: Record<string, string> = {}) => {
    const { asked, to } = await prompt(c, text, rating, answers)
    return { asked, to }
  }
  const LOG_FILE = LOG_PATH
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
}
