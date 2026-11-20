import { type TestBody, expect, test } from 'claude-code/testing'
import { RUNS_FILE, LOG_PATH, LEGACY_RUNS, NO_CHANGE, BIG_TURN, engine, drive, last, mount, bandText, OLD_PRICES, WHATSNEXT_CMDS, installWhatsnext } from './testkit'

// P-40 (ADR 0072): keep warm while it pays, the default of Before the cache goes cold, and the log of every idle stretch it reads.

for (const surface of ['desktop', 'terminal'] as const) {
  const MIN = 60_000
  const HOUR = 60 * MIN
  /** 18:00 local on Friday 2027-01-15. */
  const EVENING = new Date(2027, 0, 15, 18, 0, 0, 0).getTime()
  const FRIDAY = 5
  const runLines = (h: ReturnType<typeof engine>) => (h.files[RUNS_FILE] ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>)
  const idleLines = (h: ReturnType<typeof engine>) => runLines(h).filter(l => l.kind === 'idle')
  const warmLines = (h: ReturnType<typeof engine>) => runLines(h).filter(l => l.kind === 'warm')
  const coldLog = (h: ReturnType<typeof engine>) => h.files[LOG_PATH] ?? ''
  const ASK = { beforeCold: 'ask' }

  type Over = {
    /** Rows the person set (settings.json). Left out, Before the cache goes cold is not set: the default applies. */
    stored?: Record<string, string>
    commands?: typeof WHATSNEXT_CMDS
    prices?: string
    usage?: typeof BIG_TURN
    fork?: Record<string, number>
    store?: Record<string, unknown>
    /** Stretches already in the run log: how long, and how each ended. */
    stretches?: { gapMin: number; ended: 'warm' | 'cold' | 'never' }[]
    /** Lines already in the run log. */
    lines?: object[]
  }
  // Opus: 80,500 tokens in the conversation, $0.63 to come back cold, $0.016 a request, $0.14 to compact.
  const session = async ($: unknown, on: Parameters<TestBody>[1], over: Over = {}) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', ...(over.stored ? { stored: over.stored } : {}), ...(over.store ? { store: over.store } : {}) })
    h.now = EVENING
    h.virtual = true
    h.stepUsage = over.usage ?? BIG_TURN
    h.commands = over.commands ?? []
    if (over.commands?.length) installWhatsnext(h)
    if (over.fork) h.forkUsage = over.fork
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
  const comeBack = async (d: ReturnType<typeof drive>, h: ReturnType<typeof engine>) => {
    h.rating = NO_CHANGE
    await d.submit('continue')
  }
  /** 20 stretches that make a chance: `n` of each shape. */
  const rep = (n: number, gapMin: number, ended: 'warm' | 'cold' | 'never' = 'cold') => Array.from({ length: n }, () => ({ gapMin, ended }))
  /** Before the cache goes cold left unset. */
  const UNSET = { options: {} }
  const SHORT = rep(20, 30, 'warm')

  // ---- The log of every idle stretch ---------------------------------------------------------------------------

  test(`idle line: a return while the cache is warm is one idle line, ended warm, with the hour and weekday the turn ended (${surface})`, { timeoutMs: 30000, options: ASK }, async ($, on) => {
    const { h, d } = await session($, on, { stored: ASK })
    await turn(d, 't1')
    await h.advance(10 * MIN)
    await comeBack(d, h)
    expect(idleLines(h).map(l => ({ ...l, at: undefined }))).toEqual([
      { at: undefined, kind: 'idle', session: 'sess-1', gapMs: 10 * MIN, ended: 'warm', hour: 18, weekday: FRIDAY, billing: 'api', ttl: HOUR, context: 80_500, cold: 0.6279 },
    ])
    expect(await d.command('status').then(r => r.text ?? ''), 'the line is no run').not.toContain('1 run')
  })

  test(`idle line: a return after the cache went cold is ended cold (${surface})`, { timeoutMs: 30000, options: ASK }, async ($, on) => {
    const { h, d } = await session($, on, { stored: ASK })
    await turn(d, 't1')
    await h.advance(90 * MIN)
    await comeBack(d, h)
    expect(idleLines(h).map(l => [l.gapMs, l.ended])).toEqual([[90 * MIN, 'cold']])
  })

  test(`idle line: a return that keep-warm requests kept warm is ended warm, counted from the last answered request (${surface})`, { timeoutMs: 30000, options: UNSET.options }, async ($, on) => {
    const { h, d } = await session($, on)
    await turn(d, 't1')
    await h.advance(90 * MIN)
    expect(h.forks.length, 'the first request, at 57 minutes').toBe(1)
    await comeBack(d, h)
    expect(idleLines(h).map(l => [l.gapMs, l.ended]), '33 minutes after the request: inside the hour it bought').toEqual([[90 * MIN, 'warm']])
    // The next stretch: the request at 57 minutes, then a return 130 minutes in, past its hour (117).
    await turn(d, 't2')
    await h.advance(130 * MIN)
    await comeBack(d, h)
    expect(idleLines(h).map(l => l.ended)).toEqual(['warm', 'cold'])
  })

  test(`idle line: a gap under 5 minutes is a pause: no line, and the open stretch is gone (${surface})`, { timeoutMs: 30000, options: ASK }, async ($, on) => {
    const { h, d } = await session($, on, { stored: ASK })
    await turn(d, 't1')
    await h.advance(3 * MIN)
    await comeBack(d, h)
    expect(idleLines(h)).toEqual([])
    await h.advance(2 * HOUR)
    await d.end()
    expect(idleLines(h), 'nothing left open to close as never').toEqual([])
  })

  test(`idle line: the session ending with no return is a line ended never, as long as the stretch (${surface})`, { timeoutMs: 30000, options: ASK }, async ($, on) => {
    const { h, d } = await session($, on, { stored: ASK })
    await turn(d, 't1')
    await h.advance(20 * MIN)
    await d.end()
    expect(idleLines(h).map(l => [l.session, l.gapMs, l.ended])).toEqual([['sess-1', 20 * MIN, 'never']])
  })

  test(`idle line: a stretch is logged whatever the row does: Idle warning's size bar and an idle-compact-size session still open one (${surface})`, { timeoutMs: 30000, options: { beforeCold: 'compact' } }, async ($, on) => {
    const { h, d } = await session($, on, { stored: { beforeCold: 'compact' }, usage: { ...BIG_TURN, cache_read_input_tokens: 250_000 } })
    await turn(d, 't1')
    expect(coldLog(h)).toContain('Claude Code compacts this session by itself')
    await h.advance(30 * MIN)
    await d.end()
    expect(idleLines(h).map(l => [l.ended, l.context])).toEqual([['never', 250_500]])
  })

  test(`idle line: a killed session's stretch is closed as never at the next session start; this session's own and a young one stay (${surface})`, { timeoutMs: 30000, options: ASK }, async ($, on) => {
    const entry = (hoursAgo: number) => ({ endedAt: EVENING - hoursAgo * HOUR, hour: 9, weekday: 2, billing: 'api', ttl: HOUR, context: 120_000, cold: 0.9 })
    const { h } = await session($, on, { stored: ASK, store: { openIdle: { 'sess-dead': entry(9), 'sess-young': entry(2), 'sess-1': entry(12) } } })
    expect(idleLines(h).map(l => [l.session, l.gapMs, l.ended, l.context])).toEqual([['sess-dead', 9 * HOUR, 'never', 120_000]])
    expect(Object.keys((h.store.openIdle ?? {}) as object).sort(), 'a resume may still return to its own').toEqual(['sess-1', 'sess-young'])
  })

  // ---- The new default -----------------------------------------------------------------------------------------

  test(`default: with no stored row a session keeps warm while it pays: nothing at the turn's end, the countdown row with Extend 1 hour from 5 minutes on (${surface})`, { timeoutMs: 30000, options: { ...UNSET.options, cacheTimer: 'off' } }, async ($, on) => {
    const { h, d } = await session($, on)
    expect(h.stored.beforeCold, 'nothing stored').toBeUndefined()
    await turn(d, 't1')
    expect(await bandText($, surface)).toBe('')
    await h.advance(5 * MIN)
    expect(await bandText($, surface)).toBe('Goes cold in 55 min ▰▰▰▰▰▰▰▰▰▱ (19:00) · coming back after costs about $0.63')
    expect(await buttons($)).toEqual([['cold-extend', 'Extend 1 hour'], ['cold-wrap', 'Wrap up'], ['mode', '⋯'], ['close', '×']])
    expect(coldLog(h)).toContain('keep warm while it pays: 0 idle stretches on record (api)')
  })

  test(`default: before 20 stretches are on record, one request at the first expiry on a 1-hour cache, then the compaction gate with a 25% chance (${surface})`, { timeoutMs: 30000, options: UNSET.options }, async ($, on) => {
    // 70K tokens: with a compaction priced as a cache read plus the summary (P-85) the 25% chance pays only above about 75K, so a chat under it (and over the $0.50 Idle warning bar) is the one that gets a note.
    const { h, d } = await session($, on, { stretches: rep(19, 30, 'warm'), commands: WHATSNEXT_CMDS, usage: { ...BIG_TURN, cache_read_input_tokens: 69_500 }, fork: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 69_500, cache_creation_input_tokens: 0 } })
    await turn(d, 't1')
    await h.advance(56 * MIN)
    expect(h.forks.length).toBe(0)
    await h.advance(MIN)
    expect(h.forks.length, 'at 57 minutes').toBe(1)
    expect(warmLines(h).map(l => l.pays), 'its line carries pays').toEqual([true])
    await h.advance(56 * MIN)
    expect(h.submitted, 'no second request; the gate runs at 114 minutes').toEqual([])
    await h.advance(MIN)
    expect(h.forks.length).toBe(1)
    expect(h.compactions, '25% of the $0.50 a compaction saves is under its $0.13').toBe(0)
    expect(h.submitted.map(s => s.text), 'a handoff note instead (whatsnext)').toEqual(['wrap up'])
    expect(coldLog(h)).toContain('not compacting, a handoff note instead: chance of a later return 25% (starting value, 19 stretches on record)')
  })

  test(`default: before 20 stretches are on record a 5-minute cache gets no request (${surface})`, { timeoutMs: 30000, options: { ...UNSET.options, cacheTimer: 'off' } }, async ($, on) => {
    const { h, d } = await session($, on, { prices: OLD_PRICES, stretches: rep(19, 30, 'warm'), usage: { ...BIG_TURN, cache_read_input_tokens: 150_000 }, fork: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 150_000, cache_creation_input_tokens: 0 } })
    await turn(d, 't1')
    expect(await bandText($, surface), 'a short cache has no countdown row').toBe('')
    await h.advance(3 * HOUR)
    expect(h.forks.length).toBe(0)
    expect(coldLog(h)).toContain('keep warm while it pays: no request at point 1 (19 stretches on record, fewer than 20)')
  })

  test(`default: with 20 stretches a request goes out only when chance x cold return is at least twice its cost: here it does not (${surface})`, { timeoutMs: 30000, options: UNSET.options }, async ($, on) => {
    const { h, d } = await session($, on, { stretches: SHORT })
    await turn(d, 't1')
    await h.advance(5 * HOUR)
    expect(h.forks.length, 'nobody was still away at 57 minutes: no chance, no request').toBe(0)
    expect(coldLog(h)).toContain('no request at point 1 (0% of 0 stretches still going came back within the next cache life, under $0.01 expected against $0.02 a request)')
    expect(h.compactions + h.submitted.length, 'and with no whatsnext nothing else').toBe(0)
    expect(coldLog(h)).toContain('nothing to do before the expiry, compacting does not pay and whatsnext is not here')
  })

  test(`default: with 20 stretches a request goes out when it pays, never more than 2 from the rule (${surface})`, { timeoutMs: 30000, options: UNSET.options }, async ($, on) => {
    // Half come back at 116 minutes and half at 175: at 57, 114 and 171 minutes half of those still going return within the hour.
    const { h, d } = await session($, on, { stretches: [...rep(10, 116), ...rep(10, 175)] })
    await turn(d, 't1')
    await h.advance(57 * MIN)
    expect(h.forks.length, 'request 1 at 57 minutes').toBe(1)
    await h.advance(57 * MIN)
    expect(h.forks.length, 'request 2 at 114').toBe(2)
    await h.advance(5 * HOUR)
    expect(h.forks.length, 'the rule would pay at 171 too, but 2 is the most').toBe(2)
    expect(coldLog(h)).toContain("no request at point 3 (the rule's 2 requests are used)")
    expect(warmLines(h).every(l => l.pays === true)).toBe(true)
  })

  test(`default: Extend 1 hour adds a request beyond the rule's two, and the row reads like keep warm (${surface})`, { timeoutMs: 30000, options: UNSET.options }, async ($, on) => {
    const { h, d } = await session($, on, { stretches: [...rep(10, 116), ...rep(10, 175)] })
    await turn(d, 't1')
    await h.advance(5 * MIN)
    await press($, 'cold-extend')
    // The cache is warm to 19:00; one extra request is 57 minutes more.
    expect(await bandText($, surface)).toBe('Warm until 19:57 · $0.00')
    expect(await buttons($)).toEqual([['cold-extend', 'Extend 1 hour'], ['cold-wrap', 'Wrap up'], ['cold-stop', 'Stop keeping warm'], ['mode', '⋯'], ['close', '×']])
    await h.advance(5 * HOUR)
    expect(h.forks.length, 'two from the rule and one from the press').toBe(3)
    expect(coldLog(h)).toContain('request 3 at point 3 (Extend 1 hour)')
    expect(coldLog(h)).toContain('keep warm while it pays: Extend 1 hour pressed')
  })

  test(`default: Stop keeping warm after Extend stops the run, with no compaction or handoff (${surface})`, { timeoutMs: 30000, options: UNSET.options }, async ($, on) => {
    const { h, d } = await session($, on, { stretches: [...rep(10, 116), ...rep(10, 175)], commands: WHATSNEXT_CMDS })
    await turn(d, 't1')
    await h.advance(5 * MIN)
    await press($, 'cold-extend')
    await h.advance(53 * MIN)
    expect(h.forks.length).toBe(1)
    await press($, 'cold-stop')
    expect(await bandText($, surface)).toBe('Stopped keeping warm · $0.02.')
    await h.advance(6 * HOUR)
    expect(h.forks.length + h.submitted.length + h.compactions).toBe(1)
  })

  test(`default: a cache miss on a request stops the run (P-28 stays) (${surface})`, { timeoutMs: 30000, options: UNSET.options }, async ($, on) => {
    const { h, d } = await session($, on, { stretches: [...rep(10, 116), ...rep(10, 175)], fork: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 80_500 } })
    await turn(d, 't1')
    await h.advance(5 * HOUR)
    expect(h.forks.length, 'the first request missed: no second').toBe(1)
    expect(coldLog(h)).toContain('keep warm stopped: the cache missed')
  })

  test(`default: no Extend on a 5-minute cache: no row at all (${surface})`, { timeoutMs: 30000, options: { ...UNSET.options, cacheTimer: 'off' } }, async ($, on) => {
    const { h, d } = await session($, on, { prices: OLD_PRICES, usage: { ...BIG_TURN, cache_read_input_tokens: 150_000 } })
    await turn(d, 't1')
    await h.advance(3 * MIN)
    expect(await bandText($, surface)).toBe('')
    expect(await buttons($)).toEqual([])
  })

  test(`default: a prompt cancels the run: no request and no compaction after it (${surface})`, { timeoutMs: 30000, options: UNSET.options }, async ($, on) => {
    const { h, d } = await session($, on, { stretches: [...rep(10, 116), ...rep(10, 175)] })
    await turn(d, 't1')
    await h.advance(30 * MIN)
    await comeBack(d, h)
    await h.advance(6 * HOUR)
    expect({ forks: h.forks.length, compactions: h.compactions, submitted: h.submitted.map(x => x.text) }, 'only the person\'s own prompt').toEqual({ forks: 0, compactions: 0, submitted: ['continue'] })
  })

  // ---- The compaction gate -------------------------------------------------------------------------------------

  test(`gate: when the person usually comes back after the expiry, it compacts 3 minutes before it (${surface})`, { timeoutMs: 30000, options: UNSET.options }, async ($, on) => {
    // 20 stretches all back at 5 hours: nobody returns in the next hour, so no request; but every one that is still going comes back later: 1 x $0.58 over the $0.14 to compact.
    const { h, d } = await session($, on, { stretches: rep(20, 300) })
    await turn(d, 't1')
    await h.advance(56 * MIN)
    expect(h.compactions).toBe(0)
    await h.advance(MIN)
    expect(h.compactions).toBe(1)
    expect(h.forks.length).toBe(0)
    expect(coldLog(h)).toContain('compacting 3 min before the expiry: 100% of 20 stretches still going at the expiry came back later; it would save $0.58 on average against $0.14 to compact')
    expect(await bandText($, surface)).toBe('Compacted while the cache was warm.')
  })

  test(`gate: when it does not pay, with whatsnext it saves a handoff note and does not compact (${surface})`, { timeoutMs: 30000, options: UNSET.options }, async ($, on) => {
    const { h, d } = await session($, on, { stretches: SHORT, commands: WHATSNEXT_CMDS })
    await turn(d, 't1')
    await h.advance(57 * MIN)
    expect(h.submitted.map(s => s.text)).toEqual(['wrap up'])
    expect(h.compactions).toBe(0)
    expect(coldLog(h)).toContain('not compacting, a handoff note instead: 0% of 0 stretches still going at the expiry came back later; it would save under $0.01 on average against $0.14 to compact')
    // The wrap-up's own turn does not start another round.
    await d.turnStart('t2', 'wrap up')
    await turn(d, 't2')
    await h.advance(5 * HOUR)
    expect(h.submitted.length).toBe(1)
  })

  test(`gate: with whatsnext and no compaction that pays, the handoff is saved and the cold-compact tip is still offered once the cache is cold (${surface})`, { timeoutMs: 30000, options: UNSET.options }, async ($, on) => {
    // 180K tokens: big enough that compacting on Sonnet saves the Idle warning amount, under Claude Code's idle-compact size.
    const { h, d } = await session($, on, { stretches: SHORT, commands: WHATSNEXT_CMDS, usage: { ...BIG_TURN, cache_read_input_tokens: 180_000 } })
    await turn(d, 't1')
    await h.advance(57 * MIN)
    expect(h.submitted.map(s => s.text)).toEqual(['wrap up'])
    // whatsnext answers the wrap-up as its own turn, which ends before the expiry.
    await d.turnStart('t2', 'wrap up')
    await turn(d, 't2')
    // The wrap-up turn warmed the cache again: no tip while it lives, the tip once it has gone cold.
    await h.advance(30 * MIN)
    expect(coldLog(h)).not.toContain('cold-compact tip: offered')
    await h.advance(31 * MIN)
    expect(h.compactions, 'no compaction: the handoff is the action').toBe(0)
    expect(coldLog(h)).toContain('cold-compact tip: offered')
    expect(await bandText($, surface)).toContain('Cache is cold. Compact on Sonnet first to save')
  })

  test(`gate: when it does not pay and there is no whatsnext, nothing is done (${surface})`, { timeoutMs: 30000, options: UNSET.options }, async ($, on) => {
    const { h, d } = await session($, on, { stretches: SHORT })
    await turn(d, 't1')
    await h.advance(5 * HOUR)
    expect(h.forks.length + h.compactions + h.submitted.length).toBe(0)
    expect(await bandText($, surface), 'the countdown row is gone; the cold row says it went cold').toMatch(/^Went cold at 7:00 PM/)
  })

  // ---- Stored rows keep their own behaviour --------------------------------------------------------------------

  test(`a stored "keep warm 2 h" still keeps warm at once, two requests, with no rule and no Extend (${surface})`, { timeoutMs: 30000, options: { beforeCold: 'keep warm 2 h' } }, async ($, on) => {
    const { h, d } = await session($, on, { stored: { beforeCold: 'keep warm 2 h' }, stretches: SHORT })
    await turn(d, 't1')
    expect(await bandText($, surface)).toBe('Warm until 20:00 · $0.00')
    expect(await buttons($)).toEqual([['cold-stop', 'Stop keeping warm'], ['mode', '⋯'], ['close', '×']])
    await h.advance(5 * HOUR)
    expect(h.forks.length).toBe(2)
    expect(warmLines(h).some(l => l.pays), 'not the rule\'s lines').toBe(false)
    expect(coldLog(h)).not.toContain('keep warm while it pays')
  })

  test(`a stored "off" does nothing, and the stored "ask" offers as before (${surface})`, { timeoutMs: 30000, options: { beforeCold: 'off', cacheTimer: 'off' } }, async ($, on) => {
    const { h, d } = await session($, on, { stored: { beforeCold: 'off' } })
    await turn(d, 't1')
    await h.advance(5 * HOUR)
    expect(h.forks.length + h.compactions + h.submitted.length).toBe(0)
    expect(await bandText($, surface)).toBe('')
  })

  // ---- The self-check ------------------------------------------------------------------------------------------

  const losingRuns = (n: number) => Array.from({ length: n }, (_, i) => ({ at: new Date(EVENING - (i + 1) * 24 * HOUR).toISOString(), kind: 'warm', session: 'earlier', warmRun: `run-${i}`, tier: 'opus', context: 80_500, overhead: 0.1, pays: true }))
  const PAUSED = 'Keep warm is paused: it cost more than it saved over its last 10 runs. In-turn keep warm still runs.'

  test(`self-check: 10 runs of the rule that cost more than they saved pause idle requests, and the band says so once (${surface})`, { timeoutMs: 30000, options: UNSET.options }, async ($, on) => {
    const { h, d } = await session($, on, { lines: losingRuns(10), stretches: [...rep(10, 116), ...rep(10, 175)], commands: WHATSNEXT_CMDS })
    await turn(d, 't1')
    expect(await bandText($, surface)).toBe(PAUSED)
    expect(coldLog(h)).toContain('keep warm while it pays: paused, its last 10 runs cost $1.00 more than they saved')
    await h.advance(5 * MIN)
    expect(await bandText($, surface), 'no countdown row, no Extend').toBe(PAUSED)
    await h.advance(57 * MIN)
    expect(h.forks.length, 'no request, though the rule would pay').toBe(0)
    expect(coldLog(h), 'the compaction gate still runs: everyone still going came back later, so it compacts').toContain('compacting 3 min before the expiry')
    // The next turn: paused still, but the band does not say it again.
    await turn(d, 't2')
    await comeBack(d, h)
    await turn(d, 't3')
    expect(await bandText($, surface)).not.toBe(PAUSED)
    expect(last(coldLog(h).split('\n').filter(l => l.includes('paused')))).toContain('paused')
  })

  test(`self-check: fewer than 10 runs do not pause it (${surface})`, { timeoutMs: 30000, options: UNSET.options }, async ($, on) => {
    const { h, d } = await session($, on, { lines: losingRuns(9), stretches: [...rep(10, 116), ...rep(10, 175)] })
    await turn(d, 't1')
    await h.advance(5 * MIN)
    expect(await bandText($, surface)).toContain('Goes cold in')
    await h.advance(52 * MIN)
    expect(h.forks.length).toBe(1)
  })

  test(`self-check: runs that saved enough, or older than 30 days, or not the rule's, do not pause it (${surface})`, { timeoutMs: 30000, options: UNSET.options }, async ($, on) => {
    const saved = Array.from({ length: 5 }, (_, i) => ({ at: new Date(EVENING - (i + 1) * 24 * HOUR).toISOString(), kind: 'warmSaved', session: 'earlier', pays: true, saved: 0.5 }))
    const old = losingRuns(10).map(l => ({ ...l, at: new Date(EVENING - 40 * 24 * HOUR).toISOString() }))
    const other = losingRuns(10).map(({ pays: _p, ...l }) => l)
    const { h, d } = await session($, on, { lines: [...losingRuns(10), ...saved, ...old, ...other], stretches: [...rep(10, 116), ...rep(10, 175)] })
    await turn(d, 't1')
    await h.advance(57 * MIN)
    expect(h.forks.length, 'net +$1.50 over the last 30 days').toBe(1)
  })

  test(`a pays run's warmSaved line carries pays, and the idle line follows the return (${surface})`, { timeoutMs: 30000, options: UNSET.options }, async ($, on) => {
    const { h, d } = await session($, on, { stretches: [...rep(10, 116), ...rep(10, 175)] })
    await turn(d, 't1')
    await h.advance(90 * MIN)
    h.rating = NO_CHANGE
    await d.submit('continue')
    await d.step('t2')
    await d.complete('t2')
    const saved = runLines(h).filter(l => l.kind === 'warmSaved')
    expect(saved.map(l => l.pays)).toEqual([true])
    expect(idleLines(h).map(l => l.ended)).toEqual(['warm'])
  })
}
