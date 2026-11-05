import { type TestBody, expect, test } from 'claude-code/testing'
import { type RunLine, sessionTotal } from './report'
import { RUNS_FILE, LOG_PATH, LEGACY_RUNS, LOOKUP, NO_CHANGE, BIG_TURN, cellsOf, engine, drive, flush, untilAsked, DAY, OLD_PRICES, last, mount, rowText, bandText, WHATSNEXT_ARGS, WHATSNEXT_CMDS, WHATSNEXT_SCRIPT, installWhatsnext, wnAnswer } from './testkit'

for (const surface of ['desktop', 'terminal'] as const) {
  const readRuns = (h: ReturnType<typeof engine>) => (h.files[RUNS_FILE] ?? '').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
  const HOUR = 3600_000

  const MIN = 60_000
  const buttons = async ($: unknown) => {
    const ui = await mount($, surface)
    const keys = (await ui.findAll({ type: 'Button' })).map(b => b.key)
    await ui.unmount()
    return keys
  }
  const settingsText = async (d: ReturnType<typeof drive>) => (await d.command('status')).text ?? ''
  const OPUS = { model: 'claude-opus-5-5', effort: 'medium' }
  const logOf = (h: ReturnType<typeof engine>) => h.files[LOG_PATH] ?? ''
  /** Opts a session into a profile the way /config does: declared at load, and stored. */
  const inProfile = (profile: string, more: Record<string, string> = {}) => ({ options: { profile, ...more }, stored: { profile, ...more } })


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
    /** True: leave Before the cache goes cold unset, so the profile decides. */
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

  const WARM8 = inProfile('Balanced', { beforeCold: 'keep warm 8 h' })

  // ---- Keep warm savings: a `warmSaved` line, only for a return the pings earned and the first request's cache read proved ----
  const savedLines = (h: ReturnType<typeof engine>) =>
    (h.files[RUNS_FILE] ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l) as { kind?: string; saved?: number; task?: string; tier?: string; context?: number; session?: string; overhead?: number }).filter(l => l.kind === 'warmSaved')
  /** The person comes back and the first request of their prompt is made: `t2`. */
  const comeBack = async (d: ReturnType<typeof drive>, h: ReturnType<typeof engine>) => {
    h.rating = NO_CHANGE
    await d.submit('continue')
    await d.step('t2')
    await d.complete('t2')
  }

  const SHOWN = inProfile('Balanced', { beforeCold: 'keep warm 8 h', band: 'always' })
  test(`keep warm saving: a return during the run, after the cache would have gone cold, whose first request read the cache, is a warmSaved line with what a cold return would have cost (${surface})`, { timeoutMs: 30000, options: SHOWN.options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: SHOWN.stored })
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    await coldTurn(d, 't1')
    await h.advance(57 * MIN)
    expect(h.forks.length, 'one ping so far').toBe(1)
    await h.advance(5 * MIN)
    h.rating = NO_CHANGE
    await d.submit('continue')
    await d.step('t2')
    // The first request showed the cache held: the session total counts the saving at once (0.6279 less the ping's 0.01613).
    // The band shows that total only from the 3rd rated prompt, so it is read from the log here.
    expect(sessionTotal(readRuns(h) as unknown as RunLine[], 'sess-1', false), 'the session total counts it').toBe('Session: ~$0.61 saved')
    await d.complete('t2')
    // 62 minutes after the turn ended: past its 60 minutes, kept warm by the ping at 57.
    const taskId = (readRuns(h).find(l => l.kind === 'run') as { id?: string } | undefined)?.id
    expect(taskId, 'the task is the first prompt\'s run').toBeTruthy()
    expect(savedLines(h).map(l => ({ ...l, at: undefined }))).toEqual([{ kind: 'warmSaved', session: 'sess-1', task: taskId, tier: 'opus', context: 80_500, saved: 0.6279 }])
    expect(warmLines(h)[0], 'the keep-warm request carries the same task').toMatchObject({ task: taskId })
    expect(coldLog(h)).toContain('keep warm: the cache held on return (read 80000 of 80500 tokens); coming back cold would have cost $0.63')
    // The ping stays its own cost line; the saving is a separate line, never in a cost.
    expect(warmLines(h).length).toBe(1)
    expect(warmLines(h)[0]?.overhead).toBe(0.01613)
    // The saving is in the totals: 0.6279 saved less 0.01613 of pings, and the band's session total says so.
    h.now = Date.now()
    const text = (await d.command('report')).text ?? ''
    expect(text.replace(/\s+/g, ' ')).toContain('Keep warm: 1 run · saved ~$0.63 on 1 return · cost ~$0.02 · net ~$0.61 saved')
    expect(cellsOf(text, 'Total saved')?.[2]).toBe('~$0.61')
  })

  test(`keep warm saving: a run the person never returned to has no saving line, and its requests are pure cost in the report (${surface})`, { timeoutMs: 30000, options: WARM8.options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: WARM8.stored })
    await coldTurn(d, 't1')
    await h.advance(8 * HOUR)
    expect(warmLines(h).length).toBe(8)
    expect(savedLines(h)).toEqual([])
    h.now = Date.now()
    const text = (await d.command('report')).text ?? ''
    expect(text.replace(/\s+/g, ' ')).toContain('Keep warm: 1 run · saved nothing: no returns · cost ~$0.13 · net ~$0.13 more')
    expect(text.split('\n')[1]).toBe('Cost ~$0.13 more than it saved in the last 30 days.')
  })

  test(`keep warm saving: a return before the cache would have gone cold saves nothing, even if its first request read the cache (${surface})`, { timeoutMs: 30000, options: WARM8.options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: WARM8.stored })
    await coldTurn(d, 't1')
    await h.advance(57 * MIN)
    await h.advance(2 * MIN)
    await comeBack(d, h)
    expect(h.forks.length).toBe(1)
    expect(savedLines(h), '59 minutes: the cache was warm without the ping').toEqual([])
    expect(coldLog(h)).not.toContain('the cache held on return')
    expect(coldLog(h)).not.toContain('missed on return')
  })

  test(`keep warm saving: a return that was not first to the pings (no request answered yet) saves nothing (${surface})`, { timeoutMs: 30000, options: WARM8.options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: WARM8.stored })
    await coldTurn(d, 't1')
    await h.advance(40 * MIN)
    await comeBack(d, h)
    expect(h.forks.length, 'no ping yet').toBe(0)
    expect(savedLines(h)).toEqual([])
  })

  test(`keep warm saving: a cache miss on the return is logged, and no saving is recorded (${surface})`, { timeoutMs: 30000, options: WARM8.options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: WARM8.stored })
    await coldTurn(d, 't1')
    await h.advance(62 * MIN)
    expect(h.forks.length).toBe(1)
    // The first request wrote the whole conversation again: the cache was not there.
    h.stepUsage = { input_tokens: 200, output_tokens: 400, cache_read_input_tokens: 0, cache_creation_input_tokens: 80_300 }
    await comeBack(d, h)
    expect(savedLines(h)).toEqual([])
    expect(coldLog(h)).toContain('keep warm: the cache missed on return (the first request read 0 of 80500 tokens), so no saving is counted')
    // Under 80% is a miss too; the check is the first request's only.
    expect(coldLog(h)).not.toContain('the cache held on return')
  })

  const WARM2_SAVING = inProfile('Balanced', { beforeCold: 'keep warm 2 h' })
  test(`keep warm saving: a return after the run ended counts while the last request still kept the cache (${surface})`, { timeoutMs: 30000, options: WARM2_SAVING.options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: WARM2_SAVING.stored })
    await coldTurn(d, 't1')
    await h.advance(2 * HOUR + 30 * MIN)
    expect(h.forks.length, 'two pings, at 57 and 114 minutes').toBe(2)
    await comeBack(d, h)
    expect(savedLines(h).length, '150 minutes after the turn, 36 after the last ping').toBe(1)
  })

  test(`keep warm saving: a return after the last request's life, with the run over, saves nothing (${surface})`, { timeoutMs: 30000, options: WARM2_SAVING.options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: WARM2_SAVING.stored })
    await coldTurn(d, 't1')
    await h.advance(3 * HOUR)
    expect(h.forks.length).toBe(2)
    await comeBack(d, h)
    expect(savedLines(h), '180 minutes after the turn, 66 after the last ping: cold anyway').toEqual([])
  })

  test(`keep warm stops at Stop, and the band says how much it cost (${surface})`, { timeoutMs: 30000, options: WARM8.options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: WARM8.stored })
    await coldTurn(d, 't1')
    await h.advance(57 * MIN)
    await pressBand($, 'cold-stop')
    expect(await bandText($, surface)).toBe('Stopped keeping warm · $0.02.')
    expect((await bandButtons($)).map(b => b[0]), 'no Stop once stopped').toEqual(['mode', 'close'])
    await h.advance(4 * HOUR)
    expect(h.forks.length).toBe(1)
    expect(coldLog(h)).toContain('keep warm stopped (Stop pressed): 1 ping')
  })

  test(`keep warm stops when a fork fails, and logs the reason (${surface})`, { timeoutMs: 30000, options: WARM8.options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: WARM8.stored })
    await coldTurn(d, 't1')
    h.forkReplies = [{ isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: ZERO }]
    await h.advance(57 * MIN)
    expect(h.forks.length).toBe(1)
    expect(coldLog(h)).toContain('keep warm stopped: the request failed (api-error 529, overloaded)')
    expect(await bandText($, surface)).toBe('Stopped keeping warm: a request failed · nothing used.')
    await h.advance(4 * HOUR)
    expect(h.forks.length, 'no retry').toBe(1)
    expect(warmLines(h), 'a request that cost nothing is no line').toEqual([])
  })

  test(`keep warm stops when there is nothing to fork, and prices a ping with no usage as a cache read of the conversation (${surface})`, { timeoutMs: 30000, options: WARM8.options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: WARM8.stored, fork: undefined })
    await coldTurn(d, 't1')
    await h.advance(57 * MIN)
    expect(warmLines(h).map(l => l.overhead), '80,500 tokens read at $0.20 per million').toEqual([0.01610])
    h.forkReplies = [{ isAnswered: false, reason: 'nothing-to-fork' }]
    await h.advance(57 * MIN)
    expect(h.forks.length).toBe(2)
    expect(coldLog(h)).toContain('keep warm stopped: the request failed (nothing-to-fork)')
    await h.advance(4 * HOUR)
    expect(h.forks.length).toBe(2)
  })

  test(`keep warm stops when its row changes in /config (${surface})`, { timeoutMs: 30000, options: WARM8.options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: WARM8.stored })
    await coldTurn(d, 't1')
    await h.advance(57 * MIN)
    await d.config('beforeCold', 'off')
    await h.advance(4 * HOUR)
    expect(h.forks.length).toBe(1)
  })

  test(`Cache off: no offer, no keep-warm request, no handoff and no compaction, whatever Before the cache goes cold says (${surface})`, { timeoutMs: 30000, options: { ...WARM8.options, cache: 'off' } }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: { ...WARM8.stored, cache: 'off' } })
    await coldTurn(d, 't1')
    expect(await bandText($, surface)).toBe('')
    expect(h.afters, 'no timer').toEqual([])
    await h.advance(8 * HOUR)
    expect(NOTHING_DONE(h)).toEqual(NONE)
    expect(coldLog(h)).not.toContain('keep warm')
    expect(h.files[RUNS_FILE], 'no warm line').toBeUndefined()
  })

  test(`Cache off: a compaction row does nothing before the cache goes cold (${surface})`, { timeoutMs: 30000, options: { cache: 'off', beforeCold: 'compact' } }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: { cache: 'off', beforeCold: 'compact' } })
    await coldTurn(d, 't1')
    await h.advance(3 * HOUR)
    expect(NOTHING_DONE(h)).toEqual(NONE)
    expect(h.afters).toEqual([])
  })

  test(`Cache off: no offer on a 1-hour cache, with Before the cache goes cold on ask (${surface})`, { timeoutMs: 30000, options: { cache: 'off' } }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: { cache: 'off' } })
    await coldTurn(d, 't1')
    await h.advance(5 * MIN)
    expect(await bandText($, surface)).toBe('')
    expect(h.afters).toEqual([])
  })

  test(`Cache off: the idle warning adds no note (${surface})`, { timeoutMs: 30000, options: { cache: 'off' } }, async ($, on) => {
    const h = engine(on, { ...OPUS, stored: { cache: 'off' } })
    const d = drive($, h)
    await d.start(surface)
    h.stepUsage = BIG_TURN
    await d.step('t1')
    await d.complete('t1')
    h.now += 3 * 60 * MIN
    h.rating = NO_CHANGE
    await d.submit('continue')
    expect(await bandText($, surface)).toBe('')
    expect(logOf(h)).not.toContain('idle 3 hours')
  })

  test(`Cache turned off while keep warm runs: it stops at once, the Cache row goes, and its value is the only thing that changed (${surface})`, { timeoutMs: 30000, options: WARM8.options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: WARM8.stored })
    await coldTurn(d, 't1')
    await h.advance(57 * MIN)
    expect(h.forks.length).toBe(1)
    expect(await bandText($, surface)).toBe('Warm until 2:00 · $0.02 so far')
    const result = await d.config('cache', 'off')
    expect(result.deny).toBeUndefined()
    await flush()
    expect(await bandText($, surface), 'the Cache row is gone').toBe('')
    expect(await bandButtons($), 'and its buttons').toEqual([])
    expect(coldLog(h)).toContain('keep warm stopped (Cache turned off): 1 ping')
    await h.advance(4 * HOUR)
    expect(h.forks.length, 'no more requests').toBe(1)
    expect(await settingsText(d), 'Before the cache goes cold keeps its value').toContain('Before the cache goes cold: keep warm 8 h')
    // Back on: the next big turn's end follows the row again.
    await d.config('cache', 'on')
    await coldTurn(d, 't2')
    expect(await bandText($, surface), 'a new keep-warm run').toMatch(/^Warm until \d+:\d\d · \$0\.00 so far$/)
  })

  test(`Cache turned off with the offer showing: the offer goes and is not logged as ignored (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await coldSession($, on)
    await coldTurn(d, 't1')
    await h.advance(5 * MIN)
    expect(await coldRow($)).toContain('Goes cold in 55 min')
    await d.config('cache', 'off')
    await flush()
    expect(await coldRow($)).toBe('')
    await h.advance(3 * HOUR)
    expect((h.files[RUNS_FILE] ?? '').includes('"kind":"cold"'), 'nobody answered it').toBe(false)
    expect(NOTHING_DONE(h)).toEqual(NONE)
  })

  const WARM2 = inProfile('Balanced', { beforeCold: 'keep warm 2 h' })
  test(`keep warm 2 h ends at its end time (${surface})`, { timeoutMs: 30000, options: WARM2.options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: WARM2.stored })
    await coldTurn(d, 't1')
    expect(await bandText($, surface)).toBe('Warm until 20:00 · $0.00 so far')
    await h.advance(5 * HOUR)
    expect(h.forks.length, 'at 57 and 114 minutes; the next would be past 2 hours').toBe(2)
    expect(await bandText($, surface)).toBe('Kept the cache warm until 20:00 · $0.03.')
    expect(coldLog(h)).toContain('keep warm ended at 20:00: 2 pings')
  })

  test(`a newer turn end replaces the timer: one keep-warm run at a time (${surface})`, { timeoutMs: 30000, options: WARM2.options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: WARM2.stored })
    await coldTurn(d, 't1')
    await h.advance(30 * MIN)
    // A turn the person did not start (a background task reporting back) ends 30 minutes later.
    await d.turnStart('t2', '')
    await coldTurn(d, 't2')
    await h.advance(HOUR)
    expect(h.forks.length, 'the old run is gone: the first ping of the new one is at 57 minutes after t2').toBe(1)
    await h.advance(5 * HOUR)
    expect(h.forks.length, 'the new run sends its second and last at 144 minutes; the old one sent none').toBe(2)
  })

  const FIVE = { prices: OLD_PRICES, usage: { ...BIG_TURN, cache_read_input_tokens: 150_000 }, fork: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 150_000, cache_creation_input_tokens: 0 } }
  test(`break-even on a 5-minute cache: only times under it are offered, and the offer says where keeping warm stops paying (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await coldSession($, on, FIVE)
    await coldTurn(d, 't1')
    expect(h.afters, 'a cache under 1 hour shows the offer at the turn\'s end: the one timer is for the cache going cold, 5 minutes on').toEqual([5 * MIN])
    expect(await bandText($, surface)).toBe(
      'Goes cold in 5 min (18:05) · coming back after costs about $0.72. Keeping warm past 19:36 costs more.',
    )
    expect((await bandButtons($)).map(b => b[1]), 'one button').toEqual(['Keep warm to 18:30 ($0.21)', '⋯', '×'])
    const asks = await openMenu($, h, { Options: 'More…' }, 2)
    expect(asks.map(a => a.options), 'four choices and the band setting: three to a page, then the rest').toEqual([['Keep warm to 19:00 ($0.42)', 'Compact now', 'Let it go cold', 'More…'], ["Don't offer again", 'When the band shows…']])
  })

  const WARM8_5M = inProfile('Balanced', { beforeCold: 'keep warm 8 h' })
  test(`break-even: keep warm 8 h on a 5-minute cache is capped at 24 pings, and the cap is logged (${surface})`, { timeoutMs: 30000, options: WARM8_5M.options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { ...FIVE, stored: WARM8_5M.stored })
    await coldTurn(d, 't1')
    expect(coldLog(h)).toContain('keep warm capped at 24 pings: more would cost more than coming back cold ($0.72)')
    await h.advance(3 * HOUR)
    expect(h.forks.length, 'every 4 minutes for 96 minutes').toBe(24)
    await h.advance(5 * HOUR)
    expect(h.forks.length).toBe(24)
    expect(await bandText($, surface)).toMatch(/^Kept the cache warm until 19:41 · \$0\.72\./)
  })

  test(`break-even: pings that cost more than planned stop the run before the cap (${surface})`, { timeoutMs: 30000, options: WARM8_5M.options }, async ($, on) => {
    // Each ping really cost a third of a cold return (it wrote the conversation again).
    const { h, d } = await coldSession($, on, { ...FIVE, stored: WARM8_5M.stored, fork: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 50_000 } })
    await coldTurn(d, 't1')
    await h.advance(HOUR)
    expect(h.forks.length, 'three pings of $0.25 pass $0.72').toBe(3)
    expect(coldLog(h)).toContain('keep warm stopped: $0.75 spent, as much as coming back cold')
  })

  const HANDOFF = inProfile('Balanced', { beforeCold: 'save a handoff' })
  test(`save a handoff: with whatsnext it submits "wrap up" once, 3 minutes before expiry, unrated (${surface})`, { timeoutMs: 30000, options: HANDOFF.options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: HANDOFF.stored, commands: WHATSNEXT })
    await coldTurn(d, 't1')
    expect(await bandText($, surface), 'nothing to show yet').toBe('')
    expect(h.afters, 'one timer, 3 minutes before the cache expires').toEqual([57 * MIN])
    await h.advance(56 * MIN)
    expect(NOTHING_DONE(h)).toEqual(NONE)
    await h.advance(MIN)
    expect(h.submitted.map(s => s.text)).toEqual(['wrap up'])
    expect(h.compactions).toBe(0)
    expect(h.ratings, 'not rated').toBe(0)
    expect(h.completions, 'no rating call at all').toEqual([])
    expect(await bandText($, surface)).toBe('Saved a handoff with whatsnext before the cache went cold.')
    expect(coldLog(h)).toContain('handoff: submitted "wrap up" to whatsnext before the cache went cold')
    // whatsnext's turn ends: no second round.
    await d.turnStart('t2', 'wrap up')
    await coldTurn(d, 't2')
    await h.advance(5 * HOUR)
    expect(h.submitted.length, 'once').toBe(1)
  })

  test(`save a handoff: with no whatsnext it compacts instead (${surface})`, { timeoutMs: 30000, options: HANDOFF.options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: HANDOFF.stored })
    await coldTurn(d, 't1')
    await h.advance(56 * MIN)
    expect(h.compactions).toBe(0)
    await h.advance(MIN)
    expect(h.compactions).toBe(1)
    expect(h.submitted, 'no wrap-up prompt').toEqual([])
    expect(await bandText($, surface)).toBe('Compacted while the cache was warm.')
    await h.advance(5 * HOUR)
    expect(h.compactions, 'once').toBe(1)
    // The conversation is small now: coming back is not asked about as an idle return of the old size.
    h.rating = NO_CHANGE
    await d.submit('continue')
    expect(h.asked.length).toBe(0)
  })

  const COMPACT = inProfile('Balanced', { beforeCold: 'compact' })
  test(`compact: with no whatsnext it calls $.session.compact() once before expiry, and logs a skip with its reason (${surface})`, { timeoutMs: 30000, options: COMPACT.options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: COMPACT.stored })
    await coldTurn(d, 't1')
    await h.advance(57 * MIN)
    expect(h.compactions).toBe(1)
    expect(h.submitted, 'compact is not a handoff').toEqual([])
    expect(coldLog(h)).toContain('compact: compacted before the cache went cold')
    await h.advance(5 * HOUR)
    expect(h.compactions).toBe(1)
  })

  test(`compact: a compaction a hook vetoes is logged with its reason and shows nothing (${surface})`, { timeoutMs: 30000, options: COMPACT.options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: COMPACT.stored })
    h.compactSkip = 'a PreCompact hook blocked it'
    await coldTurn(d, 't1')
    await h.advance(57 * MIN)
    expect(h.compactions).toBe(1)
    expect(coldLog(h)).toContain('compact skipped: a PreCompact hook blocked it')
    expect(await bandText($, surface)).toBe('')
  })

  test(`save a handoff: whatsnext installed but the project not through whatsnext init compacts instead, and says why (${surface})`, { timeoutMs: 30000, options: HANDOFF.options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: HANDOFF.stored })
    installWhatsnext(h, { initialized: false })
    await coldTurn(d, 't1')
    await h.advance(57 * MIN)
    expect(h.submitted, 'no wrap-up prompt: whatsnext would not answer it here').toEqual([])
    expect(h.compactions).toBe(1)
    expect(h.wnRuns.length, 'whatsnext is asked, twice, and says it is not a project: at the turn end and by the compaction').toBe(2)
    expect(coldLog(h)).toContain('whatsnext is installed but this project has not been through "whatsnext init"')
    expect(await bandText($, surface)).toBe('Compacted while the cache was warm.')
  })

  test(`ask: whatsnext installed but the project not through whatsnext init offers Compact now, not Save a handoff (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await coldSession($, on)
    installWhatsnext(h, { initialized: false })
    await coldOffer(h, d, 't1')
    const keys = (await bandButtons($)).map(b => b[0])
    const more = await openMenu($, h, {}, 1)
    expect([...keys, ...more.flatMap(q => q.options)].join(' ')).not.toContain('handoff')
    expect(more[0]?.options.join(' ')).toContain('Compact now')
  })

  // ---- Compact now with whatsnext: its instructions, its wrap-up first when it asks for one ----
  const CMD = { command: 'compact', args: WHATSNEXT_ARGS }
  const wnWithCompact = async ($: unknown, on: Parameters<TestBody>[1]) => {
    const { h, d } = await coldSession($, on, { stored: COMPACT.stored, commands: WHATSNEXT })
    await coldTurn(d, 't1')
    h.wnRuns.length = 0 // the turn end's own check of whether this is a whatsnext project is not what these tests count
    return { h, d }
  }

  test(`compact: with whatsnext it asks for the instructions and runs its compact prompt before expiry, and does not compact itself (${surface})`, { timeoutMs: 30000, options: COMPACT.options }, async ($, on) => {
    const { h } = await wnWithCompact($, on)
    await h.advance(56 * MIN)
    expect(h.wnRuns).toEqual([])
    await h.advance(MIN)
    expect(h.wnRuns).toEqual([['python3', WHATSNEXT_SCRIPT, 'compact-instructions', '--session', 'sess-1', '--json']])
    expect(h.commandRuns).toEqual([CMD])
    expect(h.compactions).toBe(0)
    expect(h.submitted, 'no wrap-up').toEqual([])
    expect(coldLog(h)).toContain('compact: compacted with whatsnext before the cache went cold')
    expect(await bandText($, surface)).toBe('Compacted while the cache was warm.')
    await h.advance(5 * HOUR)
    expect(h.commandRuns.length, 'once').toBe(1)
  })

  test(`compact: wrap_up_first submits "wrap up", then runs the compact prompt when that turn ends, once (${surface})`, { timeoutMs: 30000, options: COMPACT.options }, async ($, on) => {
    const { h, d } = await wnWithCompact($, on)
    // The first answer asks for the wrap-up; after its turn the handoff is written, so whatsnext stops asking.
    h.wnReplies = [{ exitCode: 0, stdout: wnAnswer(true) }, { exitCode: 0, stdout: wnAnswer(false) }, { exitCode: 0, stdout: wnAnswer(false) }]
    await h.advance(57 * MIN)
    expect(h.submitted.map(s => s.text)).toEqual(['wrap up'])
    expect(h.commandRuns, 'not yet').toEqual([])
    expect(h.compactions).toBe(0)
    expect(h.ratings, 'the wrap-up is not rated').toBe(0)
    await h.advance(HOUR)
    expect(h.commandRuns, 'still waiting for the wrap-up turn to end').toEqual([])
    await d.turnStart('t2', 'wrap up')
    await coldTurn(d, 't2')
    await h.advance(0)
    expect(h.wnRuns.length, 'asked again after the turn').toBeGreaterThanOrEqual(2)
    expect(h.commandRuns).toEqual([CMD])
    expect(h.submitted.map(s => s.text), 'one wrap-up').toEqual(['wrap up'])
    expect(h.compactions).toBe(0)
    await h.advance(5 * HOUR)
    expect(h.commandRuns.length).toBe(1)
    expect(h.submitted.length).toBe(1)
  })

  const WN_FAILS: { name: string; over?: { initialized?: boolean; listed?: boolean }; reply?: { exitCode: number; stdout: string; stderr?: string }; run?: string; why: string }[] = [
    { name: 'there is no plugin folder for whatsnext', over: { listed: false }, why: "whatsnext's plugin folder was not found" },
    { name: 'the project is not through whatsnext init', over: { initialized: false }, why: 'this project has not been through "whatsnext init"' },
    { name: 'compact-instructions exits with an error', reply: { exitCode: 2, stdout: '' }, why: 'compact-instructions exited 2' },
    { name: 'its answer is not JSON', reply: { exitCode: 0, stdout: '<html>' }, why: 'did not answer in JSON' },
    { name: 'the /compact cannot run', run: 'no such command', why: '"/compact" could not run:' },
  ]
  for (const f of WN_FAILS) {
    test(`compact: with whatsnext, when ${f.name}, it compacts with $.session.compact() and logs why (${surface})`, { timeoutMs: 30000, options: COMPACT.options }, async ($, on) => {
      const { h } = await wnWithCompact($, on)
      installWhatsnext(h, f.over)
      if (f.reply) h.wnReply = f.reply
      if (f.run) h.commandRunFails = f.run
      await h.advance(57 * MIN)
      expect(h.compactions).toBe(1)
      expect(h.commandRuns).toEqual([])
      expect(h.submitted).toEqual([])
      expect(coldLog(h)).toContain('compact: whatsnext could not compact (')
      expect(coldLog(h)).toContain(f.why)
      expect(coldLog(h)).toContain('compact: compacted before the cache went cold')
      expect(await bandText($, surface)).toBe('Compacted while the cache was warm.')
    })
  }

  test(`a prompt before expiry cancels the waiting handoff (${surface})`, { timeoutMs: 30000, options: HANDOFF.options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: HANDOFF.stored, commands: WHATSNEXT })
    await coldTurn(d, 't1')
    await h.advance(30 * MIN)
    h.rating = NO_CHANGE
    await d.submit('continue')
    await h.advance(5 * HOUR)
    expect(NOTHING_DONE(h)).toEqual({ forks: 0, submitted: 1, compactions: 0 })
    expect(h.submitted.map(s => s.text), 'only the person\'s own prompt').toEqual(['continue'])
  })

  test(`nothing fires while a turn is active (${surface})`, { timeoutMs: 30000, options: HANDOFF.options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: HANDOFF.stored, commands: WHATSNEXT })
    await coldTurn(d, 't1')
    await h.advance(30 * MIN)
    // A turn the person did not start runs when the timer is due.
    await d.turnStart('t2', '')
    await h.advance(HOUR)
    expect(NOTHING_DONE(h), 'skipped: the turn keeps the cache warm itself').toEqual(NONE)
    expect(coldLog(h)).toContain('handoff skipped: a turn is running')
    // Its end starts a round of its own.
    await d.step('t2')
    await d.complete('t2')
    await h.advance(57 * MIN)
    expect(h.submitted.map(s => s.text)).toEqual(['wrap up'])
  })

  test(`keep warm skips a ping while a turn is active (${surface})`, { timeoutMs: 30000, options: WARM8.options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: WARM8.stored })
    await coldTurn(d, 't1')
    await h.advance(30 * MIN)
    await d.turnStart('t2', '')
    await h.advance(HOUR)
    expect(h.forks.length).toBe(0)
    expect(coldLog(h)).toContain('keep warm skipped: a turn is running')
  })

  test(`a command list that fails: the offer shows, and the log says what happened (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await coldSession($, on)
    h.commandsFail = true
    await coldOffer(h, d, 't1')
    expect(await bandText($, surface)).toContain('Goes cold in 55 min (19:00)')
    expect(coldLog(h)).toContain('could not list the commands')
  })

  test(`rightsize off: nothing at the end of a turn (${surface})`, { timeoutMs: 30000, options: WARM8.options }, async ($, on) => {
    const h = engine(on, { ...OPUS, stored: WARM8.stored })
    h.files['/home/test/.claude/mods/switches.json'] = '{"rightsize": false}'
    h.now = EVENING
    h.virtual = true
    h.stepUsage = BIG_TURN
    const d = drive($, h)
    await d.start(surface)
    await coldTurn(d, 't1')
    await h.advance(3 * HOUR)
    expect(NOTHING_DONE(h)).toEqual(NONE)
    expect(await bandText($, surface)).toBe('')
  })

  const PROFILE_COLD = (profile: string) => ({ options: inProfile(profile).options, over: { stored: inProfile(profile).stored, unset: true } })

  test(`profiles: Quality keeps warm for 8 hours when the row is not set (${surface})`, { timeoutMs: 30000, options: PROFILE_COLD('Quality').options }, async ($, on) => {
    const { h, d } = await coldSession($, on, PROFILE_COLD('Quality').over)
    await coldTurn(d, 't1')
    expect(await bandText($, surface)).toBe('Warm until 2:00 · $0.00 so far')
    await h.advance(57 * MIN)
    expect(NOTHING_DONE(h)).toEqual({ forks: 1, submitted: 0, compactions: 0 })
  })

  test(`profiles: Balanced keeps warm until your usual start when the row is not set: at once, with no question, at most 8 hours (${surface})`, { timeoutMs: 30000, options: PROFILE_COLD('Balanced').options }, async ($, on) => {
    const { h, d } = await coldSession($, on, PROFILE_COLD('Balanced').over)
    await coldTurn(d, 't1')
    // 18:00: the usual start (9:00 with nothing in the log) is 15 hours away, so the 8-hour cap ends it.
    expect(await bandText($, surface), 'no offer, no wait: it starts at the turn\'s end').toBe('Warm until 2:00 · $0.00 so far')
    expect(await bandButtons($)).toEqual([['cold-stop', 'Stop keeping warm'], ['mode', '⋯'], ['close', '×']])
    expect(h.asked, 'no question').toEqual([])
    await h.advance(57 * MIN)
    expect(NOTHING_DONE(h)).toEqual({ forks: 1, submitted: 0, compactions: 0 })
    await h.advance(8 * HOUR)
    expect(h.forks.length, 'eight in eight hours, none after the end').toBe(8)
    expect(await bandText($, surface)).toBe('Kept the cache warm until 2:00 · $0.13.')
    expect(coldLog(h)).toContain('keep warm ended at 2:00: 8 pings')
  })

  test(`profiles: Balanced keeps warm until your usual start when that is under 8 hours away, and the usual start comes from the run log (${surface})`, { timeoutMs: 30000, options: PROFILE_COLD('Balanced').options }, async ($, on) => {
    const { h, d } = await coldSession($, on, PROFILE_COLD('Balanced').over)
    // Six days whose first prompt was at 8:21, 8:22 ... 8:26: the median, 8:23.5, rounds to 8:30.
    const day = (n: number) => JSON.stringify({ at: new Date(2027, 0, 15 - n, 9, 30).toISOString(), submittedAt: new Date(2027, 0, 15 - n, 8, 20 + n).toISOString(), kind: 'run' })
    h.files[LEGACY_RUNS] = `${[1, 2, 3, 4, 5, 6].map(day).join('\n')}\n`
    await d.start(surface)
    h.now = new Date(2027, 0, 16, 4, 0, 0, 0).getTime()
    await coldTurn(d, 't1')
    expect(await bandText($, surface), '4:00: 4.5 hours to 8:30, under the 8-hour cap').toBe('Warm until 8:30 · $0.00 so far')
    await h.advance(57 * MIN)
    expect(h.forks.length).toBe(1)
    await h.advance(6 * HOUR)
    expect(h.forks.length, 'pings at 57-minute steps while the end time is ahead').toBe(4)
    expect(coldLog(h)).toContain('keep warm ended at 8:30')
  })

  test(`profiles: Balanced's Stop keeping warm stops it, and Don't keep warm again in ⋯ turns the row off as yours (${surface})`, { timeoutMs: 30000, options: PROFILE_COLD('Balanced').options }, async ($, on) => {
    const { h, d } = await coldSession($, on, PROFILE_COLD('Balanced').over)
    await coldTurn(d, 't1')
    await h.advance(57 * MIN)
    await pressBand($, 'cold-stop')
    expect(await bandText($, surface)).toBe('Stopped keeping warm · $0.02.')
    await h.advance(4 * HOUR)
    expect(h.forks.length, 'no more').toBe(1)
    // Next turn: keeping warm starts again; Don't keep warm again is in the ⋯ menu.
    await coldTurn(d, 't2')
    expect(await bandText($, surface), 'it is 22:57: the 8-hour cap ends it at 6:57').toBe('Warm until 6:57 · $0.00 so far')
    const asks = await openMenu($, h, { Options: "Don't keep warm again" })
    expect(asks[0]?.options, 'the menu: the cache choice, and the band setting').toEqual(["Don't keep warm again", 'When the band shows…'])
    expect(last(h.sets)).toMatchObject({ key: 'rightsize.beforeCold', value: 'off' })
    expect(h.stored.beforeCold, 'the person\'s own now').toBe('off')
    await h.advance(4 * HOUR)
    expect(h.forks.length, 'and it stopped').toBe(1)
  })

  test(`profiles: Economy lets the cache go cold when the row is not set: no offer, no pings (${surface})`, { timeoutMs: 30000, options: PROFILE_COLD('Economy').options }, async ($, on) => {
    const { h, d } = await coldSession($, on, PROFILE_COLD('Economy').over)
    await coldTurn(d, 't1')
    await h.advance(5 * MIN)
    expect(await bandText($, surface)).toBe('')
    expect(h.asked, 'no question').toEqual([])
    await h.advance(9 * HOUR)
    expect(NOTHING_DONE(h)).toEqual(NONE)
    expect(h.afters, 'no timer was armed').toEqual([])
  })

  test(`profiles: the ask value still offers, for Balanced and Economy too, when the row is set to it (${surface})`, { timeoutMs: 30000, options: inProfile('Economy', { beforeCold: 'ask' }).options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: inProfile('Economy', { beforeCold: 'ask' }).stored })
    await coldOffer(h, d, 't1')
    expect(await bandText($, surface)).toContain('Goes cold in 55 min (19:00)')
    expect((await bandButtons($)).map(b => b[1])[0], 'the keep-warm offer').toMatch(/^Keep warm to /)
    await h.advance(3 * HOUR)
    expect(NOTHING_DONE(h)).toEqual(NONE)
  })

  test(`your setting wins: Quality compacts when you say compact (${surface})`, { timeoutMs: 30000, options: inProfile('Quality', { beforeCold: 'compact' }).options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: inProfile('Quality', { beforeCold: 'compact' }).stored })
    await coldTurn(d, 't1')
    await h.advance(57 * MIN)
    expect(NOTHING_DONE(h), 'not Quality\'s keep warm').toEqual({ forks: 0, submitted: 0, compactions: 1 })
  })

  test(`your setting wins: Economy keeps warm when you say keep warm 2 h (${surface})`, { timeoutMs: 30000, options: inProfile('Economy', { beforeCold: 'keep warm 2 h' }).options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: inProfile('Economy', { beforeCold: 'keep warm 2 h' }).stored, commands: WHATSNEXT })
    await coldTurn(d, 't1')
    await h.advance(5 * HOUR)
    expect(NOTHING_DONE(h), 'keep warm 2 h, not the profile\'s ask').toEqual({ forks: 2, submitted: 0, compactions: 0 })
  })

  test(`your setting wins: Balanced stays quiet when you say off, and Quality asks when you say ask (${surface})`, { timeoutMs: 30000, options: inProfile('Balanced', { beforeCold: 'off' }).options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: inProfile('Balanced', { beforeCold: 'off' }).stored })
    await coldTurn(d, 't1')
    await h.advance(9 * HOUR)
    expect(NOTHING_DONE(h)).toEqual(NONE)
    expect(await bandText($, surface)).toBe('')
    // The same row, set to ask (the default value, but yours), under Quality: it asks.
    await d.config('profile', 'Quality')
    await d.config('beforeCold', 'ask')
    await coldOffer(h, d, 't2')
    expect(await bandText($, surface)).toContain('Goes cold in ')
    await h.advance(9 * HOUR)
    expect(NOTHING_DONE(h)).toEqual(NONE)
  })

  const SUB = { rateLimits: [{ kind: 'five_hour', percentUsed: 10 }] }
  test(`on a subscription the costs are window shares as ranges, with API-equivalent dollars (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await coldSession($, on, { rateLimits: SUB.rateLimits })
    await coldOffer(h, d, 't1')
    // No run has shown the window rate yet: dollars, said to be API-equivalent.
    expect(await bandText($, surface)).toBe('Goes cold in 55 min (19:00) · coming back after costs about $0.63 API-equivalent')
    expect((await bandButtons($)).map(b => b[1]).slice(0, 1)).toEqual(['Keep warm to 20:00 (~$0.03)'])
    expect((await openMenu($, h))[0]?.options.slice(0, 2)).toEqual(['Keep warm to 2:00 tomorrow (~$0.13)', 'Keep warm to 9:00 tomorrow (~$0.24)'])
    // 5% of the window for $1 of one turn, give or take a point: $0.63 is 2.5–3.8%, written in whole percent.
    h.files[LEGACY_RUNS] = `${JSON.stringify({ at: new Date(h.now).toISOString(), kind: 'run', actual: 1, before: { five_hour: 10 }, after: { five_hour: 15 } })}\n`
    await coldOffer(h, d, 't2')
    expect(await bandText($, surface)).toBe('Goes cold in 55 min (19:05) · coming back after costs ~3–4%')
    expect((await bandButtons($)).map(b => b[1]).slice(0, 1)).toEqual(['Keep warm to 20:05 (~0.1–0.2%)'])
    expect((await openMenu($, h))[0]?.options.slice(0, 2)).toEqual(['Keep warm to 2:05 tomorrow (~0.5–0.8%)', 'Keep warm to 9:00 tomorrow (~1%)'])
    // Keeping warm says what it cost in the window too.
    await pressBand($, 'cold-2h')
    await h.advance(57 * MIN)
    expect(await bandText($, surface)).toMatch(/^Warm until 20:05 · ~0\.1% used so far/)
    expect((await bandText($, surface)).split(' Session:')[0], 'no ping count, no dollars next to the share').not.toMatch(/\bpings?\b|\$/)
    await pressBand($, 'cold-stop')
    expect(await bandText($, surface)).toMatch(/^Stopped keeping warm · ~0\.1% used\./)
  })

  test(`on a subscription before the rate is known the keep-warm line says ~dollars, and no percentage (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await coldSession($, on, { rateLimits: SUB.rateLimits })
    await coldOffer(h, d, 't1')
    await pressBand($, 'cold-2h')
    expect(await bandText($, surface)).toBe('Warm until 20:00 · ~0% used so far')
    await h.advance(57 * MIN)
    expect(await bandText($, surface)).toMatch(/^Warm until 20:00 · ~\$0\.02 so far/)
    await pressBand($, 'cold-stop')
    expect(await bandText($, surface)).toMatch(/^Stopped keeping warm · ~\$0\.02\./)
  })

  test(`the usual start time is 9:00 until the run log shows five days of first prompts (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await coldSession($, on)
    const day = (n: number) => JSON.stringify({ at: new Date(2027, 0, 15 - n, 9, 30).toISOString(), submittedAt: new Date(2027, 0, 15 - n, 6, 0).toISOString(), kind: 'run' })
    h.files[LEGACY_RUNS] = `${[1, 2, 3, 4].map(day).join('\n')}\n`
    await d.start(surface)
    await coldOffer(h, d, 't1')
    expect((await openMenu($, h))[0]?.options, 'four days: 9:00, not 6:00').toContain('Keep warm to 9:00 tomorrow ($0.24)')
    expect(coldLog(h)).toContain('usual start 9:00 by default, 4 days of runs')
  })

  // ---- What the person answers: logged, learned, and asked about -----------------------------------------------

  /** Offers answered before, oldest first, in the old shared log (read at a session's start): one `cold` line each, a day apart. */
  const history = async (h: ReturnType<typeof engine>, d: ReturnType<typeof drive>, choices: string[]) => {
    h.files[LEGACY_RUNS] = `${choices.map((c, i) => JSON.stringify({ at: new Date(EVENING - (choices.length - i) * DAY).toISOString(), kind: 'cold', session: 'earlier', choice: c })).join('\n')}\n`
    await d.start(surface)
  }
  const coldChoices = (h: ReturnType<typeof engine>) =>
    (h.files[RUNS_FILE] ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l) as { kind?: string; choice?: string; session?: string }).filter(l => l.kind === 'cold').map(l => l.choice)

  test(`each answer to an offer is one cold line in the run log: the button or menu choice pressed (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await coldSession($, on, { commands: WHATSNEXT })
    await coldOffer(h, d, 't1')
    await pressBand($, 'cold-2h')
    expect(coldChoices(h)).toEqual(['2h'])
    const line = (h.files[RUNS_FILE] ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>).find(l => l.kind === 'cold')
    expect(line, 'a cold line names the session and the choice, and nothing else but its time').toEqual({ at: expect.any(String), kind: 'cold', session: 'sess-1', choice: '2h' })
    // Keep warm until 2:00 tomorrow and Until the usual start, then the handoff, Let it go cold and Don't offer again, from the ⋯ menu.
    await coldOffer(h, d, 't2')
    await openMenu($, h, { Options: 'Keep warm to 2:05 tomorrow ($0.13)' }, 1)
    await coldOffer(h, d, 't3')
    await openMenu($, h, { Options: 'Save a handoff' }, 1)
    h.rating = NO_CHANGE
    await d.submit('continue')
    await coldOffer(h, d, 't4')
    await openMenu($, h, { ...CACHE_MENU, 'More options': 'Let it go cold' }, 2)
    expect(coldChoices(h)).toEqual(['2h', '8h', 'handoff', 'let-go'])
  })

  test(`an offer nobody answers is logged ignored: when a prompt is sent, when a turn ends, or when the cache goes cold; once each (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await coldSession($, on)
    await coldOffer(h, d, 't1')
    h.rating = NO_CHANGE
    await d.submit('continue')
    expect(coldChoices(h), 'a prompt').toEqual(['ignored'])
    await coldTurn(d, 't2')
    expect(coldChoices(h), 'no offer was showing: the turn ending logs nothing more').toEqual(['ignored'])
    await h.advance(5 * MIN)
    expect(await bandText($, surface)).toContain('Goes cold')
    // Another turn ends with this offer still showing.
    await coldTurn(d, 't3')
    expect(coldChoices(h), 'a newer turn ended').toEqual(['ignored', 'ignored'])
    await h.advance(5 * MIN)
    expect(await bandText($, surface)).toContain('Goes cold')
    await h.advance(2 * HOUR)
    expect(coldChoices(h), 'the cache went cold').toEqual(['ignored', 'ignored', 'ignored'])
    // A press after that is no second outcome for the same offer.
    await pressBand($, 'cold-2h')
    expect(coldChoices(h)).toEqual(['ignored', 'ignored', 'ignored'])
    expect(NOTHING_DONE(h).forks, 'and keeps nothing warm').toBe(0)
  })

  test(`a cold line is no run: it is not shared, and it changes no report total (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await coldSession($, on)
    const saving = { at: new Date().toISOString(), kind: 'run', session: 'sess-1', change: 'lower', offered: 'lower', stay: 0.4, taken: 0.1, actual: 0.1, overhead: 0 }
    h.files[LEGACY_RUNS] = `${JSON.stringify(saving)}\n`
    h.now = Date.now()
    const before = (await d.command('report')).text
    await d.start(surface)
    await coldOffer(h, d, 't1')
    await pressBand($, 'cold-2h')
    expect(coldChoices(h)).toEqual(['2h'])
    const after = (await d.command('report')).text
    expect(after).toBe(before)
  })

  test(`the cache row's one button is the choice picked most in the last 10 answered offers; the rest are in the ⋯ menu in the usual order (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await coldSession($, on)
    // 8 hours three times, 2 hours once, and ignored offers, which are no answer.
    await history(h, d, ['8h', 'ignored', '8h', '2h', 'ignored', '8h'])
    await coldOffer(h, d, 't1')
    expect(await bandButtons($), 'the one picked most').toEqual([['cold-8h', 'Keep warm to 2:00 tomorrow ($0.13)'], ['mode', '⋯'], ['close', '×']])
    expect(await bandText($, surface), 'the line is the same').toBe('Goes cold in 55 min (19:00) · coming back after costs about $0.63')
    const asks = await openMenu($, h, CACHE_MENU, 2)
    expect(asks.map(a => a.options), 'the others, in the fixed order, without the one on the row').toEqual([
      ['Keep warm to 20:00 ($0.03)', 'Keep warm to 9:00 tomorrow ($0.24)', 'Compact now', 'More…'],
      ['Let it go cold', "Don't offer again", 'When the band shows…'],
    ])
    await pressBand($, 'cold-8h')
    expect(await bandText($, surface)).toBe('Warm until 2:00 · $0.00 so far')
  })

  test(`the one button looks back over 10 answers only, and a tie goes to the most recent (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await coldSession($, on)
    // Seven answers of 8 hours, 4 of them before the last 10; in the last 10: 2 hours five times, 8 hours three times, Let it go cold twice.
    await history(h, d, ['8h', '8h', '8h', '8h', '2h', '8h', '2h', '8h', '2h', 'let-go', '2h', '8h', '2h', 'let-go'])
    await coldOffer(h, d, 't1')
    expect((await bandButtons($))[0]).toEqual(['cold-2h', 'Keep warm to 20:00 ($0.03)'])
    await h.advance(2 * HOUR)
    // A tie: 8 hours and 2 hours twice each; the 8 hours was picked last.
    await history(h, d, ['let-go', '2h', '8h', '2h', '8h'])
    await coldOffer(h, d, 't2')
    expect((await bandButtons($))[0], 'the tie goes to the most recent').toEqual(['cold-8h', 'Keep warm to 4:05 tomorrow ($0.13)'])
  })

  test(`a learned choice this offer does not have is passed over: the default button stands (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    // whatsnext was installed, and a handoff picked twice; now it is not, so the offer has Compact now and no handoff.
    const { h, d } = await coldSession($, on)
    await history(h, d, ['handoff', 'handoff'])
    await coldOffer(h, d, 't1')
    expect((await bandButtons($))[0], 'today\'s default: the first priced keep-warm choice').toEqual(['cold-2h', 'Keep warm to 20:00 ($0.03)'])
    // With whatsnext the handoff is the button; with nothing priced, the handoff or the compaction is the default.
    installWhatsnext(h)
    await history(h, d, ['handoff', '2h', 'handoff'])
    await coldOffer(h, d, 't2')
    expect((await bandButtons($))[0]).toEqual(['cold-handoff', 'Save a handoff'])
  })

  test(`the one button can be a choice with no price: Let it go cold (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await coldSession($, on)
    await history(h, d, ['let-go', '2h', 'let-go'])
    await coldOffer(h, d, 't1')
    expect((await bandButtons($))[0]).toEqual(['cold-let-go', 'Let it go cold'])
    await pressBand($, 'cold-let-go')
    expect(await bandText($, surface)).toBe('')
    expect(coldChoices(h)).toEqual(['let-go'])
  })

  const ALWAYS = [
    { choice: '2h', question: 'Always keep warm 2 hours?', value: 'keep warm 2 h', commands: [] as typeof WHATSNEXT },
    { choice: '8h', question: 'Always keep warm 8 hours?', value: 'keep warm 8 h', commands: [] as typeof WHATSNEXT },
    { choice: 'handoff', question: 'Always save a handoff?', value: 'save a handoff', commands: WHATSNEXT },
    { choice: 'compact', question: 'Always compact?', value: 'compact', commands: [] as typeof WHATSNEXT },
  ]
  for (const a of ALWAYS) {
    test(`after 3 answers of ${a.choice} the next offer asks "${a.question}" once; Yes sets the /config row and does it now (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
      const { h, d } = await coldSession($, on, { commands: a.commands })
      await history(h, d, ['let-go', a.choice, a.choice, a.choice])
      await coldOffer(h, d, 't1')
      expect(await bandText($, surface)).toBe(a.question)
      const buttons = await bandButtons($)
      expect(buttons.slice(0, 2), 'Yes and No, then the usual button').toEqual([['cold-ask-yes', 'Yes'], ['cold-ask-no', 'No']])
      expect(buttons[2]?.[0]).toBe(`cold-${a.choice}`)
      await pressBand($, 'cold-ask-yes')
      expect(h.sets.filter(x => x.key === 'rightsize.beforeCold').map(x => x.value)).toEqual([a.value])
      expect(h.stored.beforeCold, 'written to settings.json as the person\'s own').toBe(a.value)
      expect(last(h.toasts)).toBe(`Rightsize: Before the cache goes cold is now "${a.value}". It is the row in /config; set it back any time.`)
      expect(await settingsText(d), 'the row shows it').toContain(`Before the cache goes cold: ${a.value}`)
      expect(coldChoices(h), 'the answer is the choice').toEqual([a.choice])
      // This offer's choice is done now, as its button would have done it.
      if (a.choice === 'handoff') expect(h.submitted.map(x => x.text)).toEqual(['wrap up'])
      else if (a.choice === 'compact') expect(h.compactions).toBe(1)
      else expect(await bandText($, surface)).toBe('Warm until ' + (a.choice === '2h' ? '20:00' : '2:00') + ' · $0.00 so far')
      // The row now decides: no more offers.
      await d.step('t2')
      await d.complete('t2')
      await h.advance(10 * MIN)
      expect(await bandText($, surface)).not.toContain('Always')
    })
  }

  test(`No to "Always …?" keeps the offer and the question is never asked again, in this session or the next (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await coldSession($, on)
    await history(h, d, ['2h', '2h', '2h'])
    await coldOffer(h, d, 't1')
    await pressBand($, 'cold-ask-no')
    expect(await bandText($, surface), 'the offer, as it was').toBe('Goes cold in 55 min (19:00) · coming back after costs about $0.63')
    expect((await bandButtons($))[0]).toEqual(['cold-2h', 'Keep warm to 20:00 ($0.03)'])
    expect(h.sets.filter(x => x.key === 'rightsize.beforeCold')).toEqual([])
    await coldOffer(h, d, 't2')
    expect(await bandText($, surface), 'not asked twice').toContain('Goes cold')
    await d.start(surface)
    await coldOffer(h, d, 't3')
    expect(await bandText($, surface), 'not in the next session').toContain('Goes cold')
  })

  test(`"Always …?" is asked once whatever happens to it: an ignored question is not asked again (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await coldSession($, on)
    await history(h, d, ['8h', '8h', '8h'])
    await coldOffer(h, d, 't1')
    expect(await bandText($, surface)).toBe('Always keep warm 8 hours?')
    await coldOffer(h, d, 't2')
    expect(await bandText($, surface)).toContain('Goes cold')
    expect(coldChoices(h), 'the question went unanswered: that offer was ignored').toEqual(['ignored'])
  })

  test(`3 different answers, or a choice with no row value, make no "Always …?" (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await coldSession($, on)
    await history(h, d, ['2h', '8h', '2h'])
    await coldOffer(h, d, 't1')
    expect(await bandText($, surface)).toContain('Goes cold')
    await history(h, d, ['let-go', 'let-go', 'let-go'])
    await coldOffer(h, d, 't2')
    expect(await bandText($, surface), 'Let it go cold has no row value').toContain('Goes cold')
    await history(h, d, ['2h', '2h', 'ignored', '2h'])
    await coldOffer(h, d, 't3')
    expect(await bandText($, surface), 'ignored offers are no answers: the last 3 answers were 2 hours').toBe('Always keep warm 2 hours?')
  })

  test(`after 5 ignored offers the next one asks "Stop offering to keep the cache warm?" once; Yes is Don't offer again (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await coldSession($, on)
    for (let i = 1; i <= 5; i++) {
      await coldOffer(h, d, `t${i}`)
      expect(await bandText($, surface), `offer ${i}`).toContain('Goes cold')
      await h.advance(2 * HOUR)
    }
    expect(coldChoices(h), 'the cache went cold on every one').toEqual(['ignored', 'ignored', 'ignored', 'ignored', 'ignored'])
    expect(h.sets.filter(x => x.key === 'rightsize.beforeCold'), 'rightsize never turns the offer off by itself').toEqual([])
    await coldOffer(h, d, 't6')
    expect(await bandText($, surface)).toBe('Stop offering to keep the cache warm?')
    expect((await bandButtons($)).map(b => b[1])).toEqual(['Yes', 'No', '⋯', '×'])
    // The menu still has every choice, the one that would have been the button too.
    const asks = await openMenu($, h, CACHE_MENU, 2)
    expect(asks[0]?.options.slice(0, 2)).toEqual(['Keep warm to 6:25 ($0.03)', 'Keep warm to 12:25 ($0.13)'])
    await pressBand($, 'cold-ask-yes')
    expect(last(h.sets)).toMatchObject({ key: 'rightsize.beforeCold', value: 'off' })
    expect(h.stored.beforeCold).toBe('off')
    expect(last(h.toasts)).toBe('Rightsize: Before the cache goes cold is now "off". It is the row in /config; set it back any time.')
    expect(await bandText($, surface), 'the offer closes').toBe('')
    expect(coldChoices(h).slice(-1), 'the same as Don\'t offer again').toEqual(['off'])
  })

  test(`No to stopping keeps the offer, and it is never asked again (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await coldSession($, on)
    await history(h, d, ['ignored', 'ignored', 'ignored', 'ignored', 'ignored'])
    await coldOffer(h, d, 't1')
    expect(await bandText($, surface)).toBe('Stop offering to keep the cache warm?')
    await pressBand($, 'cold-ask-no')
    expect(await bandText($, surface)).toContain('Goes cold')
    expect(h.sets.filter(x => x.key === 'rightsize.beforeCold')).toEqual([])
    // Still ignoring: no second question, and the offer keeps coming.
    await h.advance(2 * HOUR)
    await coldOffer(h, d, 't2')
    await h.advance(2 * HOUR)
    await coldOffer(h, d, 't3')
    expect(await bandText($, surface)).toContain('Goes cold')
    expect(h.stored.beforeCold, 'still the person\'s ask').toBe('ask')
  })

  test(`4 ignored offers, or 5 with an answer among them, ask nothing (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await coldSession($, on)
    await history(h, d, ['ignored', 'ignored', 'ignored', 'ignored'])
    await coldOffer(h, d, 't1')
    expect(await bandText($, surface)).toContain('Goes cold')
    await history(h, d, ['ignored', 'ignored', 'let-go', 'ignored', 'ignored'])
    await coldOffer(h, d, 't2')
    expect(await bandText($, surface)).toContain('Goes cold')
  })
}
