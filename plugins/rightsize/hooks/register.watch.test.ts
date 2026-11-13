import { expect, test } from 'claude-code/testing'
import { RUNS_FILE, LOG_PATH, LOOKUP, NO_COLD, NO_ONE, engine, drive, settle, DAY, last, mount, rowText } from './testkit'

// ADR 0058, items 5 to 7 (P-18). Rightsize saves when a watch-only period starts. Seven days later, at a turn end, one band row
// shows what the Saving check says rightsize would have saved, with three answers. When watch only is turned off, one summary row
// shows the same range at the next turn end, unless the person chose Turn on in the trial-end row. Neither row holds a prompt.

for (const surface of ['desktop', 'terminal'] as const) {
  const OPUS = { model: 'claude-opus-5-5', effort: 'medium' }
  const WATCH = { mode: 'watch only' }
  const PERIOD = 'watchPeriod'
  const HEADER = 'Watch only'

  type H = ReturnType<typeof engine>
  const period = (h: H) => h.store[PERIOD] as { since?: string; until?: string; trialShown?: boolean; answer?: string; summaryShown?: boolean } | undefined
  const rows = (h: H) => h.asked.filter(a => a.header === HEADER)

  /**
   * `n` watch-only prompts in the log, one minute apart after now: each predicted $1 and costing $0.80. Half would have been lowered to a
   * route estimated at $0.50: saved 10 x 0.5 x 0.8 = $4 of 20 x 0.8 = $16, which is 25%.
   */
  const seed = (h: H, n: number) => {
    h.files[RUNS_FILE] = Array.from({ length: n }, (_, i) =>
      JSON.stringify({
        at: new Date(h.now + (i + 1) * 60_000).toISOString(),
        kind: 'run',
        session: 'earlier',
        type: 'feature',
        change: 'none',
        offered: i % 2 ? 'lower' : 'none',
        stay: 1,
        taken: 1,
        actual: 0.8,
        ...(i % 2 ? { would: 'lower', wouldTaken: 0.5 } : {}),
      }),
    ).join('\n')
  }

  /** A session in watch only (or act, with `mode`), with the log seeded. Ends with a turn that wrote no run line. */
  async function begin($: unknown, on: Parameters<typeof engine>[0], over: { mode?: 'watch only' | 'act'; lines?: number } = {}) {
    const mode = over.mode ?? 'watch only'
    const h = engine(on, { ...OPUS, stored: { ...NO_COLD, mode } })
    h.now = 1_800_000_000_000
    seed(h, over.lines ?? 20)
    h.answers = { [HEADER]: NO_ONE }
    const d = drive($, h)
    await d.start(surface)
    let n = 0
    // A turn that ends: no prompt of its own, so no run line is added to the seeded ones.
    const turnEnd = async () => {
      const id = `e${++n}`
      await d.step(id)
      await d.complete(id)
      await settle()
    }
    return { h, d, turnEnd }
  }

  const OPTIONS = { options: WATCH }

  test(`the start is stored when watch only is turned on, in UTC (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await begin($, on, { mode: 'act' })
    expect(period(h), 'act is the default: no period').toBeUndefined()
    h.now += 3 * DAY
    await d.config('mode', 'watch only')
    expect(period(h)).toEqual({ since: new Date(h.now).toISOString() })
    expect(h.files[LOG_PATH] ?? '').toContain('watch only: a new period starts')
  })

  test(`on the first load with watch only already on and no start stored, the start is that time (${surface})`, { timeoutMs: 30000, ...OPTIONS }, async ($, on) => {
    const { h } = await begin($, on)
    expect(period(h)).toEqual({ since: new Date(h.now).toISOString() })
  })

  test(`a stored start is kept on a later load (${surface})`, { timeoutMs: 30000, ...OPTIONS }, async ($, on) => {
    const since = new Date(1_800_000_000_000 - 2 * DAY).toISOString()
    const h = engine(on, { ...OPUS, store: { [PERIOD]: { since } }, stored: { ...NO_COLD, ...WATCH } })
    const d = drive($, h)
    await d.start(surface)
    expect(period(h)).toEqual({ since })
  })

  test(`the trial-end row shows after 7 full days at a turn end, and not before (${surface})`, { timeoutMs: 30000, ...OPTIONS }, async ($, on) => {
    const { h, turnEnd } = await begin($, on)
    h.now += 7 * DAY - 60_000
    await turnEnd()
    expect(rows(h), 'a minute short of 7 days').toEqual([])
    h.now += 60_000
    await turnEnd()
    expect(rows(h).length).toBe(1)
    const row = rows(h)[0]!
    expect(row.options).toEqual(['Turn on', 'Ask before changing', 'Keep watching'])
    expect(row.question).toContain('Watch only has run for 7 days. rightsize would have cut your cost by about 25%. Turn rightsize on?')
    expect(row.question, 'what no answer does').toContain('No answer: watch only stays on.')
    expect(period(h)?.trialShown).toBe(true)
  })

  test(`the trial-end row with under 20 rated prompts says there are too few, and still offers the three answers (${surface})`, { timeoutMs: 30000, ...OPTIONS }, async ($, on) => {
    const { h, turnEnd } = await begin($, on, { lines: 19 })
    h.now += 7 * DAY
    await turnEnd()
    expect(rows(h).length).toBe(1)
    expect(rows(h)[0]!.question).toContain('Not enough turns yet to estimate.')
    expect(rows(h)[0]!.question).not.toMatch(/\d%/)
    expect(rows(h)[0]!.options).toEqual(['Turn on', 'Ask before changing', 'Keep watching'])
  })

  test(`the trial-end row shows once per period, whatever the answer or none (${surface})`, { timeoutMs: 30000, ...OPTIONS }, async ($, on) => {
    const { h, turnEnd } = await begin($, on)
    h.now += 8 * DAY
    await turnEnd()
    expect(rows(h).length).toBe(1)
    await turnEnd()
    h.now += 5 * DAY
    await turnEnd()
    expect(rows(h).length, 'not again at later turn ends').toBe(1)
    // Not in a later session either.
    const d2 = drive($, h)
    await d2.start(surface)
    await turnEnd()
    expect(rows(h).length, 'not in the next session').toBe(1)
  })

  test(`a new watch-only period restarts the count and shows its own row (${surface})`, { timeoutMs: 30000, ...OPTIONS }, async ($, on) => {
    const { h, d, turnEnd } = await begin($, on)
    h.answers = { [HEADER]: 'Keep watching' }
    h.now += 7 * DAY
    await turnEnd()
    expect(rows(h).length).toBe(1)
    h.answers = { [HEADER]: NO_ONE }
    await d.config('mode', 'act')
    h.now += DAY
    await d.config('mode', 'watch only')
    expect(period(h), 'a new start, nothing shown yet').toEqual({ since: new Date(h.now).toISOString() })
    h.now += 6 * DAY
    await turnEnd()
    expect(rows(h).filter(r => r.question.startsWith('Watch only has run')).length, 'day 6 of the new period').toBe(1)
    h.now += DAY
    await turnEnd()
    expect(rows(h).filter(r => r.question.startsWith('Watch only has run')).length, 'day 7 of the new period').toBe(2)
  })

  test(`Turn on: Mode becomes act, nothing else changes, and watch only is over (${surface})`, { timeoutMs: 30000, ...OPTIONS }, async ($, on) => {
    const { h, d, turnEnd } = await begin($, on)
    h.answers = { [HEADER]: 'Turn on' }
    h.now += 7 * DAY
    await turnEnd()
    expect(h.sets.map(s => [s.key, s.value])).toEqual([['rightsize.mode', 'act']])
    expect(period(h)).toMatchObject({ answer: 'on', trialShown: true })
    expect(period(h)?.until).toBeDefined()
    // The next prompt is rated and acts.
    h.rating = '{"level":"low","model":"same","size":"small","type":"lookup","read":2000,"write":3000,"steps":1,"reason":"one function lookup"}'
    await d.submit(LOOKUP)
    await d.step('t9')
    expect(last(h.sent)?.effort, 'acting: lowered').toBe('low')
  })

  test(`Ask before changing: Mode becomes act and Ask before changing goes on (${surface})`, { timeoutMs: 30000, ...OPTIONS }, async ($, on) => {
    const { h, turnEnd } = await begin($, on)
    h.answers = { [HEADER]: 'Ask before changing' }
    h.now += 7 * DAY
    await turnEnd()
    expect(h.sets.map(s => [s.key, s.value]).sort()).toEqual([['rightsize.askFirst', 'on'], ['rightsize.mode', 'act']])
    expect(period(h)).toMatchObject({ answer: 'ask' })
    expect(period(h)?.until).toBeDefined()
  })

  test(`Keep watching: nothing changes, watch only goes on, and the row does not come back (${surface})`, { timeoutMs: 30000, ...OPTIONS }, async ($, on) => {
    const { h, d, turnEnd } = await begin($, on)
    h.answers = { [HEADER]: 'Keep watching' }
    h.now += 7 * DAY
    await turnEnd()
    expect(h.sets, 'no setting written').toEqual([])
    expect(period(h)).toMatchObject({ answer: 'keep', trialShown: true })
    expect(period(h)?.until, 'the period goes on').toBeUndefined()
    await turnEnd()
    h.now += 3 * DAY
    await turnEnd()
    expect(rows(h).length).toBe(1)
    expect(((await d.command('status')).text ?? '')).toContain('Mode: watch only')
  })

  test(`the row never holds a prompt: the next prompt goes through and the row is gone (${surface})`, { timeoutMs: 30000, ...OPTIONS }, async ($, on) => {
    const { h, d, turnEnd } = await begin($, on)
    h.now += 7 * DAY
    await turnEnd()
    expect(h.question?.header, 'the row waits on the band').toBe(HEADER)
    const ui = await mount($, surface)
    expect(await rowText(ui, HEADER)).toContain('Turn rightsize on?')
    await ui.unmount()
    h.rating = '{"level":"medium","model":"same","size":"small","type":"lookup","read":2000,"write":300,"steps":1}'
    await d.submit(LOOKUP)
    expect(last(h.submitted)?.text, 'the prompt was sent on, not held').toBe(LOOKUP)
    expect(h.question, 'the unanswered row went with it').toBeNull()
    expect(h.sets, 'unanswered: nothing changed').toEqual([])
    expect(h.files[LOG_PATH] ?? '').toContain('no answer on the band to Watch only: watch only stays on')
  })

  test(`turning watch only off: the next turn end shows one summary row with the range (${surface})`, { timeoutMs: 30000, ...OPTIONS }, async ($, on) => {
    const { h, d, turnEnd } = await begin($, on)
    h.now += 3 * DAY
    await d.config('mode', 'act')
    expect(rows(h), 'not shown until a turn ends').toEqual([])
    await turnEnd()
    expect(rows(h).length).toBe(1)
    expect(rows(h)[0]!.question).toBe('In 3 days of watch only, rightsize would have saved about 25%.')
    expect(rows(h)[0]!.options).toEqual(['OK'])
    await turnEnd()
    expect(rows(h).length, 'once').toBe(1)
    expect(period(h)).toMatchObject({ summaryShown: true })
  })

  test(`the summary also shows when watch only is turned off by editing the setting some other way (${surface})`, { timeoutMs: 30000, ...OPTIONS }, async ($, on) => {
    const { h, d, turnEnd } = await begin($, on)
    h.now += 2 * DAY
    await d.config('mode', 'act', 'bridge')
    await turnEnd()
    expect(rows(h)[0]!.question).toContain('In 2 days of watch only')
  })

  test(`the summary with under 20 rated prompts says there are too few, and gives no range (${surface})`, { timeoutMs: 30000, ...OPTIONS }, async ($, on) => {
    const { h, d, turnEnd } = await begin($, on, { lines: 12 })
    h.now += DAY
    await d.config('mode', 'act')
    await turnEnd()
    const q = rows(h)[0]!.question
    expect(q).toBe('In 1 day of watch only, rightsize rated 12 prompts. Not enough turns yet to estimate.')
    expect(q).not.toMatch(/\d%/)
  })

  test(`the summary is skipped when Turn on was chosen in the trial-end row, but not after Keep watching and a later turn-off (${surface})`, { timeoutMs: 30000, ...OPTIONS }, async ($, on) => {
    const a = await begin($, on)
    a.h.answers = { [HEADER]: 'Turn on' }
    a.h.now += 7 * DAY
    await a.turnEnd()
    expect(rows(a.h).length, 'the trial-end row').toBe(1)
    await a.turnEnd()
    await a.turnEnd()
    expect(rows(a.h).length, 'no summary after Turn on').toBe(1)
    expect(period(a.h)?.summaryShown).toBeUndefined()
  })

  test(`the summary shows after Keep watching and a later turn-off (${surface})`, { timeoutMs: 30000, ...OPTIONS }, async ($, on) => {
    const { h, d, turnEnd } = await begin($, on)
    h.answers = { [HEADER]: 'Keep watching' }
    h.now += 7 * DAY
    await turnEnd()
    h.answers = { [HEADER]: NO_ONE }
    h.now += 2 * DAY
    await d.config('mode', 'act')
    await turnEnd()
    expect(rows(h).length).toBe(2)
    expect(rows(h)[1]!.question).toContain('In 9 days of watch only, rightsize would have saved about 25%.')
  })

  test(`with act on and no watch-only period, no row ever shows (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, turnEnd } = await begin($, on, { mode: 'act' })
    h.now += 30 * DAY
    await turnEnd()
    await turnEnd()
    expect(rows(h)).toEqual([])
    expect(period(h)).toBeUndefined()
  })
}
