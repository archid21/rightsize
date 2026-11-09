import { expect, test } from 'claude-code/testing'
import { CAL_STORE } from './cost'
import { RUNS_FILE, LOG_PATH, LEGACY_RUNS, LOOKUP, DEBUG, SEARCH, NO_CHANGE, FREE_SWITCHES, NO_COLD, cellsOf, engine, drive, flush, settle, untilAsked, DAY, PAGE, OLD_PRICES, last, mount, bandText, LOWER } from './testkit'

for (const surface of ['desktop', 'terminal'] as const) {
  const readRuns = (h: ReturnType<typeof engine>) => (h.files[RUNS_FILE] ?? '').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)

  const LISTING = '{"fit":{"haiku":"low","sonnet":"low","opus":"low","fable":"low"},"type":"search","read":8000,"write":500,"steps":5,"reason":"list call sites"}'

  // Hands off to Haiku at 78% of staying: over the 70% default, under the 85% a hot pace allows.
  const NEAR = '{"fit":{"haiku":"medium","sonnet":"medium","opus":"medium","fable":"medium"},"size":"small","type":"search","read":20000,"write":1000,"steps":14,"reason":"list call sites"}'
  const HOUR = 3600_000
  const at = (h: { now: number }, ms: number) => new Date(h.now + ms).toISOString()

  const RUNS = LEGACY_RUNS
  const runLines = (h: ReturnType<typeof engine>) =>
    (h.files[RUNS_FILE] ?? '')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l) as Record<string, unknown>)
  const buttons = async ($: unknown) => {
    const ui = await mount($, surface)
    const keys = (await ui.findAll({ type: 'Button' })).map(b => b.key)
    await ui.unmount()
    return keys
  }

  // ---- Every setting, on this surface ----------------------------------------------------------------
  //
  // Each of rightsize's /config rows is checked three ways: it is a declared option of its row (plugin.json
  // and settings.ts agree: Claude Code drops a stored value that is not one of a row's options, and fills in
  // its default), it takes effect when /config changes it, with no restart, and it takes effect when given at
  // load. The scenario for each shows one thing the row changes, with the value and with the default.

  const LOG = LOG_PATH
  const settingsText = async (d: ReturnType<typeof drive>) => (await d.command('status')).text ?? ''
  const OPUS = { model: 'claude-opus-5-5', effort: 'medium' }
  const FABLE = { model: 'claude-fable-5-2', effort: 'high' }
  const noteOf = (h: ReturnType<typeof engine>) => last(h.submitted)?.context?.join('\n') ?? ''
  const handedTo = (h: ReturnType<typeof engine>) => /model "(\w+)"/.exec(noteOf(h))?.[1]
  const YES_REMEMBER = { Remember: 'This session' }
  // A raise fixture: a review, the one task type whose rated raise is still taken at prompt time on Opus (ADR 0021).
  const RAISE_HIGH = '{"level":"high","model":"same","type":"review","read":20000,"write":3000,"steps":8,"reason":"unknown cause"}'
  const NEEDS_FABLE = '{"level":"high","model":"fable","size":"small","type":"debug","read":30000,"write":4000,"steps":12,"reason":"subtle concurrency bug"}'
  const HAIKU_SEARCH = '{"level":"low","model":"haiku","size":"bulky","type":"search","read":150000,"write":3000,"steps":30,"reason":"repo-wide search"}'
  const lookupLog = (h: { now: number }, steppedUp: number) =>
    Array.from({ length: 6 }, (_, i) => JSON.stringify({ at: new Date(h.now - (6 - i) * 60_000).toISOString(), kind: 'run', type: 'lookup', route: 'main', tier: 'opus', change: 'lower', steppedUp: i < steppedUp })).join('\n') + '\n'
  const hotWindows = (h: { now: number }) => [
    { kind: 'five_hour', percentUsed: 80, resetsAt: at(h, 2 * HOUR) },
    { kind: 'seven_day', percentUsed: 20, resetsAt: at(h, 160 * HOUR) },
  ]

  // ---- Your setting wins ----------------------------------------------------------------------------

  const REPORTS_DOLLARS = /About \$[\d.]+ that way/
  const askAboutFable = { Subagent: 'Send it to a Fable subagent' }

  test(`Reports set in /config is yours: rate limits that show a subscription change nothing, and /rightsize says they disagree (${surface})`, { timeoutMs: 30000, options: { billing: 'api' } }, async ($, on) => {
    const h = engine(on, { ...OPUS, stored: { billing: 'api' } })
    h.rateLimits = [{ kind: 'five_hour', percentUsed: 12 }, { kind: 'seven_day', percentUsed: 3 }]
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = NEEDS_FABLE
    await d.config('upRule', 'ask first')
    h.answers = askAboutFable
    await d.submit(DEBUG)
    expect(h.store.billing, 'a reading was never saved over it').toBeUndefined()
    expect(h.asked.find(a => a.header === 'Subagent')?.question ?? '', 'dollars, as you set').toMatch(REPORTS_DOLLARS)
    const text = await settingsText(d)
    expect(text).toContain('Reports: api')
    expect(text).toContain('Rate limits look like a subscription; Reports is set to api by you.')
  })

  test(`Reports set to subscription stays one when the responses show a gateway's spend limit (${surface})`, { timeoutMs: 30000, options: { billing: 'subscription' } }, async ($, on) => {
    const h = engine(on, { ...OPUS, stored: { billing: 'subscription' } })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    const text = await settingsText(d)
    expect(text).toContain('Reports: subscription')
    expect(text).toContain('Rate limits look like API billing; Reports is set to subscription by you.')
    expect(h.store.billing).toBeUndefined()
  })

  test(`Reports left at its default is still read off the rate limits, even with other settings made (${surface})`, { timeoutMs: 30000, options: { floor: 'medium' } }, async ($, on) => {
    const h = engine(on, { ...OPUS, stored: { floor: 'medium' } })
    h.rateLimits = [{ kind: 'five_hour', percentUsed: 12 }]
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    expect(h.store.billing).toEqual({ value: 'subscription', by: 'detected' })
    const text = await settingsText(d)
    expect(text).toContain('Reports: subscription (detected)')
    expect(text).not.toContain('Rate limits look like')
  })

  test(`Reports set in /config after the rate limits were read changes the reports at once, and the limits no longer change it (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS })
    h.rateLimits = [{ kind: 'five_hour', percentUsed: 12 }]
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    expect(h.store.billing).toEqual({ value: 'subscription', by: 'detected' })
    await d.config('billing', 'api')
    expect(h.store.billing, 'your answer replaces the reading').toEqual({ value: 'api', by: 'answered' })
    await d.step('t1')
    await d.complete('t1')
    h.rateLimits = [{ kind: 'five_hour', percentUsed: 15 }]
    await d.step('t2')
    await d.complete('t2')
    expect(h.store.billing).toEqual({ value: 'api', by: 'answered' })
    expect(await settingsText(d)).toContain('Reports: api')
  })

  test(`Reports changed by another plugin is not yours: the rate limits still win (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS })
    h.rateLimits = [{ kind: 'five_hour', percentUsed: 12 }]
    const d = drive($, h)
    await d.start(surface)
    await d.config('billing', 'api', 'plugin')
    await d.step('t0')
    await d.complete('t0')
    expect(h.store.billing).toEqual({ value: 'subscription', by: 'detected' })
  })

  test(`a saved answer from an earlier session is yours too: the rate limits do not replace it (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: { billing: { value: 'api', by: 'answered' } } })
    h.rateLimits = [{ kind: 'five_hour', percentUsed: 12 }]
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    expect(h.store.billing).toEqual({ value: 'api', by: 'answered' })
    expect(await settingsText(d)).toContain('Reports: api')
  })

  test(`Reports asked again in /rightsize settings replaces a value you set, and writes the row (${surface})`, { timeoutMs: 30000, options: { billing: 'api' } }, async ($, on) => {
    const h = engine(on, { ...OPUS, stored: { billing: 'api' } })
    h.rateLimits = [{ kind: 'five_hour', percentUsed: 12 }]
    const d = drive($, h)
    await d.start(surface)
    h.answers = { Billing: 'Subscription (Pro, Max, Team or Enterprise)', ...YES_REMEMBER }
    await d.command('settings')
    expect(h.asked.some(a => a.header === 'Billing'), 'asked, though the rate limits could answer').toBe(true)
    expect(h.stored.billing).toBe('subscription')
    expect(await settingsText(d)).toContain('Reports: subscription')
  })

  // A hot window, with a rating that hands off to Haiku at 78% of staying: over the default threshold (70%), under
  // the 85% a hot pace allows. Each row is one session.
  const handedOffUnder = async (h: ReturnType<typeof engine>, d: ReturnType<typeof drive>, rating = NEAR) => {
    await d.start(surface)
    h.rating = rating
    await d.submit(SEARCH)
    return handedTo(h)
  }
  // Lowering saves 94% of staying: over the default 90%, under the 97% a hot window allows.
  const SMALL = '{"level":"low","model":"same","size":"small","type":"lookup","read":2000,"write":50,"steps":1}'
  // Hands off at 51% of staying: under the default 70%, and over a 50% bar. An underused window never moves the bar to 50%.
  const BIG = '{"fit":{"haiku":"medium","sonnet":"medium","opus":"medium","fable":"medium"},"size":"small","type":"search","read":40000,"write":1000,"steps":25,"reason":"list call sites"}'
  const hot = (h: { now: number; rateLimits: unknown }) => void (h.rateLimits = hotWindows(h))
  const cool = (h: { now: number; rateLimits: unknown }) => void (h.rateLimits = [{ kind: 'seven_day', percentUsed: 30, resetsAt: at(h, 6 * HOUR) }])
  const nearlyUsed = (h: { now: number; rateLimits: unknown }) => void (h.rateLimits = [{ kind: 'five_hour', percentUsed: 93, resetsAt: at(h, 4 * HOUR) }])

  const HAND_OFF_ROWS: { name: string; windows: (h: { now: number; rateLimits: unknown }) => void; stored: Record<string, string>; rating: string; to: string | undefined }[] = [
    { name: 'hot, default threshold: moved to 85%, and 78% is under it', windows: hot, stored: {}, rating: NEAR, to: 'haiku' },
    { name: 'hot, a stored Hand-off threshold of 80% is ignored: moved to 85%, and 78% is under it', windows: hot, stored: { handOff: '80%' }, rating: NEAR, to: 'haiku' },
    { name: 'cool, default threshold: not moved, and 51% is under 70%', windows: cool, stored: {}, rating: BIG, to: 'haiku' },
    { name: 'cool, a stored Hand-off threshold of 50% is ignored: 51% is under 70%', windows: cool, stored: { handOff: '50%' }, rating: BIG, to: 'haiku' },
    { name: 'nearly used up, default threshold: moved to 95%', windows: nearlyUsed, stored: {}, rating: NEAR, to: 'haiku' },
  ]
  for (const row of HAND_OFF_ROWS) {
    test(`pacing and the hand-off threshold: ${row.name} (${surface})`, { timeoutMs: 30000, options: row.stored }, async ($, on) => {
      const h = engine(on, { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES }, stored: row.stored })
      row.windows(h)
      expect(await handedOffUnder(h, drive($, h), row.rating)).toBe(row.to)
    })
  }

  const LOWERING_ROWS: { name: string; stored: Record<string, string>; effort: string }[] = [
    { name: 'default threshold: moved to 97%, and 94% is under it', stored: {}, effort: 'low' },
    { name: 'a stored Lowering threshold of 80% is ignored: moved to 97%, and 94% is under it', stored: { lowering: '80%' }, effort: 'low' },
  ]
  for (const row of LOWERING_ROWS) {
    test(`pacing and the lowering threshold, hot: ${row.name} (${surface})`, { timeoutMs: 30000, options: row.stored }, async ($, on) => {
      const h = engine(on, { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES }, stored: row.stored })
      hot(h)
      const d = drive($, h)
      await d.start(surface)
      h.rating = SMALL
      await d.submit(LOOKUP)
      await d.step('t1')
      expect(last(h.sent)?.effort).toBe(row.effort)
    })
  }

  // An underused window changes nothing: the same prompt gets the same plan and the same band at a cool pace as at an ordinary one.
  for (const [name, windows] of [['an ordinary pace', () => undefined], ['much of a window unused', cool]] as const) {
    test(`a hand-off to a cheaper model is planned the same with ${name} (${surface})`, { timeoutMs: 30000, options: { band: 'always' } }, async ($, on) => {
      const h = engine(on, { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES }, stored: { band: 'always' } })
      windows(h)
      expect(await handedOffUnder(h, drive($, h), BIG)).toBe('haiku')
      expect(await bandText($, surface), 'no pace note').not.toMatch(/window/)
    })
    test(`a lowering is planned the same with ${name} (${surface})`, { timeoutMs: 30000, options: { band: 'always' } }, async ($, on) => {
      const h = engine(on, { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES }, stored: { band: 'always' } })
      windows(h)
      const d = drive($, h)
      await d.start(surface)
      h.rating = SMALL
      await d.submit(LOOKUP)
      await d.step('t1')
      expect(last(h.sent)?.effort, '94% is over the default 90% bar: not lowered, and not at 80% either').toBe('medium')
      expect(await bandText($, surface), 'no pace note').not.toMatch(/window|unused/)
    })
  }

  const NOTE_ROWS: { name: string; stored: Record<string, string>; band: string | RegExp }[] = [
    { name: 'the fixed bars moved', stored: {}, band: /^Effort lowered: medium → low .*so rightsize saves harder\. \(hand-off bar 70% → 85%, lowering bar 90% → 97%\)/ },
    { name: 'stored threshold rows are ignored: the fixed bars moved', stored: { handOff: '70%', lowering: '90%' }, band: /^Effort lowered: medium → low .*so rightsize saves harder\. \(hand-off bar 70% → 85%, lowering bar 90% → 97%\)/ },
  ]
  for (const row of NOTE_ROWS) {
    test(`the band mentions pacing only when it moved something: ${row.name} (${surface})`, { timeoutMs: 30000, options: { band: 'always', ...row.stored } }, async ($, on) => {
      const h = engine(on, { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES }, stored: { band: 'always', ...row.stored } })
      hot(h)
      const d = drive($, h)
      await d.start(surface)
      h.rating = NO_CHANGE
      await d.submit(SEARCH)
      const band = await bandText($, surface)
      if (typeof row.band === 'string') expect(band).toBe(row.band)
      else expect(band).toMatch(row.band)
    })
  }

  const PACES: [string, (h: { now: number; rateLimits: unknown }) => void][] = [
    ['an ordinary pace', () => undefined],
    ['a window running hot', hot],
    ['much of a window unused', cool],
  ]
  for (const [name, windows] of PACES) {
    test(`"Ask" for a raise always asks, with ${name} (${surface})`, { timeoutMs: 30000, options: { raiseRule: 'ask me' } }, async ($, on) => {
      const h = engine(on, { ...OPUS, stored: { raiseRule: 'ask me' } })
      windows(h)
      const d = drive($, h)
      await d.start(surface)
      h.rating = RAISE_HIGH
      h.answers = { Effort: 'Keep medium' }
      await d.submit(DEBUG)
      expect(h.asked.map(a => a.header)).toEqual(['Effort'])
      await d.step('t1')
      expect(last(h.sent)?.effort, 'asking never raises on its own').toBe('medium')
    })
  }

  test(`a raise mid-turn when "Ask" is the rule asks, though much of the window will go unused (${surface})`, { timeoutMs: 30000, options: { raiseRule: 'ask me' } }, async ($, on) => {
    const h = engine(on, { ...OPUS, stored: { raiseRule: 'ask me' } })
    cool(h)
    const d = drive($, h)
    await d.start(surface)
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    await d.step('t1', 0)
    await d.bash('fail make')
    await d.bash('fail make')
    h.answers = { Stuck: 'Keep medium' }
    await d.step('t1', 1)
    expect(h.asked.map(a => a.header)).toEqual(['Stuck'])
    expect(last(h.sent)?.effort).toBe('medium')
  })

  // A window at 93% used: a raise or a stronger model is skipped unless you set its rule.
  type Raised = { effort: string | undefined; asked: string[]; band?: string }
  const RAISE_ROWS: { name: string; store?: Record<string, unknown>; stored: Record<string, string>; answers?: Record<string, string>; want: Raised | ((r: Raised) => void) }[] = [
    {
      name: 'Raising at its default: skipped, nothing asked',
      stored: {},
      want: { effort: 'medium', asked: [], band: 'Kept medium on Opus instead of raising to high. 93% of the 5-hour window is used, so rightsize saves all it can. (hand-off bar 70% → 95%, lowering bar 90% → 100%)' },
    },
    {
      name: 'Raising set in /config to automatic: followed, and the band says how full the window is and the bars that moved',
      stored: { raiseRule: 'raise automatically' },
      want: { effort: 'high', asked: [], band: 'Effort raised: medium → high for this prompt. Why: Unknown cause. 93% of the 5-hour window is used, so rightsize saves all it can. (hand-off bar 70% → 95%, lowering bar 90% → 100%)' },
    },
    {
      name: 'Raising answered in an earlier session and saved: yours too, and the default thresholds that moved are said',
      store: { remember: true, choices: { raise: 'auto' } },
      stored: {},
      want: r => {
        expect([r.effort, r.asked]).toEqual(['high', []])
        expect(r.band).toContain('Effort raised: medium → high for this prompt. Why: Unknown cause. 93% of the 5-hour window is used, so rightsize saves all it can.')
      },
    },
    { name: 'Raising set to "ask me": asked', stored: { raiseRule: 'ask me' }, answers: { Effort: 'Raise for this prompt' }, want: r => expect([r.effort, r.asked]).toEqual(['high', ['Effort']]) },
    { name: 'Raising set to never: no raise and no question', stored: { raiseRule: 'never raise' }, want: r => expect([r.effort, r.asked]).toEqual(['medium', []]) },
  ]
  for (const row of RAISE_ROWS) {
    test(`a window nearly used up and a raise: ${row.name} (${surface})`, { timeoutMs: 30000, options: row.stored }, async ($, on) => {
      const h = engine(on, { ...OPUS, ...(row.store ? { store: row.store } : {}), stored: row.stored })
      nearlyUsed(h)
      const d = drive($, h)
      await d.start(surface)
      h.rating = RAISE_HIGH
      h.answers = row.answers ?? {}
      await d.submit(DEBUG)
      await d.step('t1')
      const got: Raised = { effort: last(h.sent)?.effort, asked: h.asked.map(a => a.header), band: await bandText($, surface) }
      if (typeof row.want === 'function') row.want(got)
      else expect(got).toEqual(row.want)
    })
  }

  type Up = { to: string | undefined; asked: string[]; effort: string | undefined }
  const UP_ROWS: { name: string; stored: Record<string, string>; answers?: Record<string, string>; want: Up }[] = [
    { name: 'Stronger model at its default: skipped, nothing asked', stored: {}, want: { to: undefined, asked: [], effort: 'medium' } },
    { name: 'set to "always send": followed', stored: { upRule: 'always send' }, want: { to: 'fable', asked: [], effort: 'medium' } },
    { name: 'set to "ask first": asked', stored: { upRule: 'ask first' }, answers: { Subagent: 'Send it to a Fable subagent' }, want: { to: 'fable', asked: ['Subagent'], effort: 'medium' } },
    { name: 'set to "stay, raise effort only", Raising at its default: no hand-off, and the raise is skipped', stored: { upRule: 'stay, raise effort only' }, want: { to: undefined, asked: [], effort: 'medium' } },
    { name: 'set to "stay, raise effort only", Raising set to automatic: raised', stored: { upRule: 'stay, raise effort only', raiseRule: 'raise automatically' }, want: { to: undefined, asked: [], effort: 'high' } },
  ]
  for (const row of UP_ROWS) {
    test(`a window nearly used up and a stronger model: ${row.name} (${surface})`, { timeoutMs: 30000, options: row.stored }, async ($, on) => {
      const h = engine(on, { ...OPUS, stored: row.stored })
      nearlyUsed(h)
      const d = drive($, h)
      await d.start(surface)
      h.rating = NEEDS_FABLE
      h.answers = row.answers ?? {}
      await d.submit(DEBUG)
      await d.step('t1')
      expect({ to: handedTo(h), asked: h.asked.map(a => a.header), effort: last(h.sent)?.effort }).toEqual(row.want)
    })
  }

  for (const [name, stored, want] of [
    ['Raising at its default: skipped, and logged', {}, ['medium', []]],
    ['Raising set to automatic: followed', { raiseRule: 'raise automatically' }, ['high', []]],
  ] as const) {
    test(`a window nearly used up and a raise mid-turn: ${name} (${surface})`, { timeoutMs: 30000, options: stored }, async ($, on) => {
      const h = engine(on, { ...OPUS, stored })
      nearlyUsed(h)
      const d = drive($, h)
      await d.start(surface)
      h.rating = NO_CHANGE
      await d.submit(LOOKUP)
      await d.step('t1', 0)
      await d.bash('fail make')
      await d.bash('fail make')
      await d.step('t1', 1)
      expect([last(h.sent)?.effort, h.asked.map(a => a.header)]).toEqual(want)
      if (want[0] === 'medium') expect(h.files[LOG] ?? '').toContain('mid-turn raise to high skipped (the same tool call failed twice): the usage window is nearly used up')
    })
  }

  // The pause is fixed at 20% misses; the first miss on a route is forgiven.
  for (const row of [
    { name: 'the pause at 20%: 1 of 6 wrong (forgiven: 0 of 5) does not pause', steppedUp: 1, effort: 'low', paused: false },
    { name: 'the pause at 20%: 2 of 6 wrong (the first forgiven: 1 of 5, 20%) pauses, and the report says so', steppedUp: 2, effort: 'medium', paused: true },
  ]) {
    test(`${row.name} (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
      const h = engine(on, { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES } })
      h.now = Date.now()
      h.files[RUNS] = lookupLog(h, row.steppedUp)
      const d = drive($, h)
      await d.start(surface)
      h.rating = LOWER
      await d.submit(LOOKUP)
      await d.step('t1')
      expect(last(h.sent)?.effort).toBe(row.effort)
      const report = (await d.command('report')).text ?? ''
      expect(report.includes('Hand-downs paused')).toBe(row.paused)
      expect(report).toMatch(new RegExp(`Haiku's judgement +wrong on ${row.steppedUp} of 6 checked prompts`))
    })
  }

  test(`Use Haiku off: no hand-off and no resized subagent goes to Haiku, and the rater is not a worker (${surface})`, { timeoutMs: 30000, options: { useHaiku: 'off' } }, async ($, on) => {
    const h = engine(on, { ...OPUS, stored: { useHaiku: 'off' } })
    const d = drive($, h)
    await d.start(surface)
    h.rating = NO_CHANGE
    await d.submit(SEARCH)
    await d.step('t1', 0)
    expect(h.completions, 'the rater is Sonnet, not a worker').toEqual(['sonnet'])
    h.rating = LISTING
    await d.spawn('lister')
    expect(h.spawned[0]?.model, "Claude's subagent goes to Sonnet instead").toBe('sonnet')
  })

  const RULE_ROWS: { name: string; rule: string; store?: Record<string, unknown>; want: { asked: string[]; effort: string } }[] = [
    { name: 'lower automatically', rule: 'lower automatically', want: { asked: [], effort: 'low' } },
    { name: 'never lower', rule: 'never lower', want: { asked: [], effort: 'medium' } },
    { name: 'ask me: asks each time, with the effort question', rule: 'ask me', want: { asked: ['Effort'], effort: 'medium' } },
    { name: 'never lower, over the saved answers of an earlier session', rule: 'never lower', store: { remember: true, choices: { lower: 'auto' } }, want: { asked: [], effort: 'medium' } },
  ]
  for (const row of RULE_ROWS) {
    test(`Lowering set in /config to ${row.name} is used as it is (${surface})`, { timeoutMs: 30000, options: { lowerRule: row.rule } }, async ($, on) => {
      const h = engine(on, { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES, ...(row.store ?? {}) }, stored: { lowerRule: row.rule } })
      const d = drive($, h)
      await d.start(surface)
      h.rating = LOWER
      h.answers = { Effort: 'Keep medium' }
      await d.submit(LOOKUP)
      await d.step('t1')
      expect({ asked: h.asked.map(a => a.header), effort: last(h.sent)?.effort }).toEqual(row.want)
    })
  }

  test(`a rule row set back to "not set" clears the rule, in this session and in the saved copy: the profile decides again (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES, remember: true, choices: { lower: 'auto', raise: 'auto' } } })
    const d = drive($, h)
    await d.start(surface)
    expect(await settingsText(d), 'the saved answer is yours').toContain('Lowering: lower automatically')
    await d.config('lowerRule', 'not set')
    expect(await settingsText(d)).not.toContain('Lowering:')
    expect(h.store.choices, 'the saved copy keeps only the other rule').toEqual({ raise: 'auto' })
    h.rating = LOWER
    await d.submit(LOOKUP)
    expect(h.asked, 'nothing is asked: the profile decides').toEqual([])
    expect(h.files[LOG_PATH] ?? '', 'no rule is set, so the profile decides').toContain('Lowering: no rule set, the default decides (lower automatically)')
    expect(await bandText($, surface)).toMatch(/The default decided \(Lowering\); ⋯ changes it\.$/)
    // A new session keeps the other rule.
    await d.start(surface)
    expect(await settingsText(d)).toContain('Raising: raise automatically')
  })

  // Remember follows a rule the person sets, here from the band's ⋯ menu on a raise (the profile's own answers are not asked about).
  /** A prompt rated for a raise (Balanced raises on its own), and the person picks "Never raise" in the band's ⋯ menu. */
  const setRaiseFromBand = async ($: unknown, h: ReturnType<typeof engine>, d: ReturnType<typeof drive>, answers: Record<string, string> = {}) => {
    h.rating = RAISE_HIGH
    await d.submit(DEBUG)
    h.answers = { Options: 'Never raise', ...answers }
    const before = h.asked.length
    const ui = await mount($, surface)
    await ui.press({ key: 'mode' })
    await untilAsked(h, before)
    await ui.unmount()
  }

  const KEEP_ROWS: { name: string; mode?: string; remember: string; asked: string[]; kept: boolean; row: boolean; remembered?: boolean }[] = [
    { name: 'ask, yes: kept, and Remember choices becomes every session', remember: 'Every session', asked: ['Options', 'Remember'], kept: true, row: true, remembered: true },
    // The band button is the person's own choice: the row shows it at once, kept or not.
    { name: 'ask, just this session: kept for the session only', remember: 'This session', asked: ['Options', 'Remember'], kept: false, row: true },
    { name: 'every session: kept without asking', mode: 'every session', remember: 'This session', asked: ['Options'], kept: true, row: true },
    { name: 'this session: never asked, never kept', mode: 'this session', remember: 'Every session', asked: ['Options'], kept: false, row: false },
  ]
  for (const row of KEEP_ROWS) {
    test(`Remember choices, ${row.name} (${surface})`, { timeoutMs: 30000, ...(row.mode ? { options: { remember: row.mode } } : {}) }, async ($, on) => {
      const h = engine(on, { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES }, stored: { ...NO_COLD, ...(row.mode ? { remember: row.mode } : {}) } })
      const d = drive($, h)
      await d.start(surface)
      await setRaiseFromBand($, h, d, { Remember: row.remember })
      // Remember waits on the band for the turn to end.
      await d.step('t1')
      await d.complete('t1')
      await settle()
      expect(h.asked.map(a => a.header)).toEqual(row.asked)
      expect(h.store.choices, 'the store').toEqual(row.kept ? { raise: 'never' } : undefined)
      expect(h.stored.raiseRule, 'the Raising row').toBe(row.row ? 'never raise' : undefined)
      expect(h.store.remember).toBe(row.remembered ? true : undefined)
      if (row.remembered) expect(h.stored.remember, 'the Remember choices row').toBe('every session')
      expect(await settingsText(d), 'the rule is the person\'s either way').toContain('Raising: never raise')
    })
  }

  test(`Remember choices set live to every session keeps what was answered so far, and back to ask asks again (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    await d.start(surface)
    await setRaiseFromBand($, h, d)
    expect(h.store.choices, 'not kept yet').toBeUndefined()
    await d.config('remember', 'every session')
    expect(h.store.choices).toEqual({ raise: 'never' })
    expect(h.stored.raiseRule).toBe('never raise')
    await d.config('remember', 'ask')
    expect(h.store.remember, 'ask again').toBe(false)
  })

  test(`a band button sets the rule's /config row, and so does /rightsize settings (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    await d.start(surface)
    await setRaiseFromBand($, h, d)
    expect(h.stored.raiseRule).toBe('never raise')
    expect(h.sets.find(x => x.key === 'rightsize.raiseRule')?.value).toBe('never raise')

    // /rightsize settings asks the four questions again and writes every row.
    h.answers = { Lowering: 'Ask me each time', Raising: 'Raise automatically (Recommended)', Stronger: 'Use the stronger model automatically (Recommended)', Cheaper: 'Ask before sending it', ...YES_REMEMBER }
    const text = (await d.command('settings')).text ?? ''
    expect(h.asked.map(a => a.header).slice(-4), 'all four questions are asked, as before').toEqual(['Lowering', 'Raising', 'Stronger', 'Cheaper'])
    expect(h.stored).toMatchObject({ lowerRule: 'ask me', raiseRule: 'raise automatically', upRule: 'always send', downRule: 'ask first' })
    expect(text).toContain('Lowering: ask me')
    expect(text).toContain('Raising: raise automatically')
    expect(text).toContain('Cheaper model: ask first')
  })

  // ---- Mode: watch only rates and plans every prompt, applies nothing, and says what it would have done ----

  const WATCH = { options: { mode: 'watch only' }, stored: { mode: 'watch only' } }

  test(`watch only: a hand-off is planned and said, not applied: nothing is asked, no subagent note, and the run line carries what it would have done (${surface})`, { timeoutMs: 30000, options: WATCH.options }, async ($, on) => {
    const h = engine(on, { ...FABLE, store: { [CAL_STORE]: FREE_SWITCHES }, stored: WATCH.stored })
    h.now = Date.now()
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = HAIKU_SEARCH
    await d.submit(SEARCH)
    expect(await bandText($, surface)).toMatch(/^Watching: would send this to a Haiku subagent at low effort\. (\$[\d.]+ vs ~\$[\d.]+ on Fable|~\d+% of Fable usage)\. Mode in \/config turns it on\.$/)
    expect(h.asked, 'nothing is asked').toEqual([])
    expect(last(h.submitted)?.context ?? [], 'no hand-off note').toEqual([])
    expect(h.files[LOG_PATH] ?? '', 'the profile decided nothing: no rule was consulted').not.toContain('Cheaper model: no rule set')
    await d.step('t1')
    expect(last(h.sent)?.effort, 'the turn runs as it would have without rightsize').toBe('high')
    await d.complete('t1')
    const run = readRuns(h).filter(l => l.kind === 'run').at(-1) as { change?: string; route?: string; would?: string; wouldTaken?: number; stay?: number }
    expect(run).toMatchObject({ change: 'none', route: 'main', would: 'delegate-down' })
    expect(typeof run.wouldTaken, 'what the planned route was estimated to cost').toBe('number')
    expect(run.wouldTaken ?? 0, 'cheaper than staying, or it would not be planned').toBeLessThan(run.stay ?? 0)
    const status = (await d.command('status')).text ?? ''
    expect(status).toContain('Mode: watch only (rates and plans every prompt, changes nothing; Mode in /config turns it on)')
    const report = ((await d.command('report')).text ?? '').replace(/\s+/g, ' ')
    expect(report).toMatch(/Watch only: 1 prompt rated, 1 would have been changed, which would have saved ~\$[\d.]+ against staying \(estimates; nothing was applied\)\. Mode in \/config turns rightsize on\./)
  })

  test(`watch only: a lowering is said and not applied, and nothing asks even when a rule says ask (${surface})`, { timeoutMs: 30000, options: { ...WATCH.options, band: 'always', lowerRule: 'ask me' } }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES }, stored: { ...WATCH.stored, band: 'always', lowerRule: 'ask me' } })
    const d = drive($, h)
    await d.start(surface)
    h.rating = LOWER
    await d.submit(LOOKUP)
    expect(h.asked, 'the Lowering rule says ask, and watch only never asks').toEqual([])
    expect(await bandText($, surface)).toMatch(/^Watching: would lower effort to low on Opus\. (\$[\d.]+ vs ~\$[\d.]+ on Opus|~\d+% of Opus usage)\. Mode in \/config turns it on\.$/)
    await d.step('t1')
    expect(last(h.sent)?.effort, 'not lowered').toBe('medium')
    expect(await buttons($), 'no Retry: nothing was changed').toEqual(['mode', 'close'])
    await d.complete('t1')
    // A lookup rated medium on Opus at medium is lowered to low too (ADR 0021): watched, not applied.
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    expect(await bandText($, surface)).toMatch(/^Watching: would lower effort to low on Opus\./)
    const runs = readRuns(h).filter(l => l.kind === 'run') as { would?: string }[]
    expect(runs.map(r => r.would), 'the first would have lowered; the second is logged when its turn completes').toEqual(['lower'])
  })

  test(`watch only: Mode set to act in /config applies from the next prompt, with no restart (${surface})`, { timeoutMs: 30000, options: WATCH.options }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES }, stored: WATCH.stored })
    const d = drive($, h)
    await d.start(surface)
    h.rating = LOWER
    await d.submit(LOOKUP)
    await d.step('t1')
    expect(last(h.sent)?.effort, 'watching: not lowered').toBe('medium')
    await d.complete('t1')
    await d.config('mode', 'act')
    await d.submit(LOOKUP)
    await d.step('t2')
    expect(last(h.sent)?.effort, 'acting: lowered, the profile deciding').toBe('low')
    await d.complete('t2')
    expect(h.files[LOG_PATH] ?? '').toContain('Lowering: no rule set, the default decides (lower automatically)')
    await d.config('mode', 'watch only')
    await d.submit(LOOKUP)
    await d.step('t3')
    expect(last(h.sent)?.effort, 'watching again').toBe('medium')
  })

  // ---- Price check: monthly or off ----------------------------------------------------------------

  test(`a stored "check now" is not an option any more: it counts as unset, monthly applies, and nothing is checked at the start (${surface})`, { timeoutMs: 30000, options: { priceCheck: 'check now' } }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: { pricesCheckedAt: 1_800_000_000_000 - DAY }, stored: { priceCheck: 'check now' } })
    h.page = PAGE
    h.pricesFile = OLD_PRICES
    const d = drive($, h)
    await d.start(surface)
    await flush()
    const text = await settingsText(d)
    expect(text, 'monthly, and not yours').not.toContain('Price check:')
    expect(h.fetches, 'it used to check once at the start').toBe(0)
    expect(h.configSet, 'and to write the row back').toEqual([])
    // /rightsize prices is how to check now.
    expect((await d.command('prices')).text ?? '').toContain('Sonnet 5.5 cache read')
    expect(h.fetches).toBe(1)
  })

  test(`Price check off stops the monthly check, and /rightsize prices still checks (${surface})`, { timeoutMs: 30000, options: { priceCheck: 'off' } }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: { pricesCheckedAt: 1_800_000_000_000 - 31 * DAY }, stored: { priceCheck: 'off' } })
    h.page = PAGE
    h.pricesFile = OLD_PRICES
    const d = drive($, h)
    await d.start(surface)
    await flush()
    expect(h.fetches).toBe(0)
    await d.command('prices')
    expect(h.fetches).toBe(1)
    // Back to monthly in /config: once a month has passed, the next start checks.
    await d.config('priceCheck', 'monthly')
    h.now += 31 * DAY
    await d.start(surface)
    await flush()
    expect(h.fetches).toBe(2)
  })

  // ---- Workflows ------------------------------------------------------------------------------------

  const WORKFLOW_QUESTION =
    'Claude is starting a workflow. It may start many helper agents at once, often 10 or more, and each picks its own model. What should rightsize do during workflows? You can change this any time with Workflows in /config. No answer: rightsize stays paused for this workflow.'
  const WORKFLOW_ANSWERS: [string, string][] = [
    ['Pause rightsize for workflows (recommended)', 'pause rightsize'],
    ['Follow my rules for the main chat', 'follow my rules'],
    ['Also right-size every workflow agent (one Haiku rating per agent; many may run on cheaper models at once)', 'right-size every agent'],
  ]
  /** A turn that starts a workflow, with the Workflow question answered as `answer` (none: closed without an answer). */
  const startWorkflow = async (h: ReturnType<typeof engine>, d: ReturnType<typeof drive>, answer?: string, turn = 't1', id?: string) => {
    h.rating = NO_CHANGE
    h.answers = answer ? { Workflow: answer } : {}
    await d.submit(LOOKUP)
    await d.step(turn)
    await d.workflow(id)
    await settle()
  }

  test(`at ask, the Workflow question shows on the band as the workflow starts, with its three answers (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS })
    const d = drive($, h)
    await d.start(surface)
    await startWorkflow(h, d, 'Follow my rules for the main chat')
    expect(h.events.filter(x => x === 'workflow' || x === 'ask:Workflow'), 'asked first').toEqual(['ask:Workflow', 'workflow'])
    const q = h.asked.find(a => a.header === 'Workflow')
    expect(q?.question).toBe(WORKFLOW_QUESTION)
    expect(q?.options).toEqual(WORKFLOW_ANSWERS.map(a => a[0]))
  })

  for (const [label, value] of WORKFLOW_ANSWERS) {
    test(`the Workflow answer "${value}" is saved to Workflows, is yours, and is not asked again (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
      const h = engine(on, { ...OPUS })
      const d = drive($, h)
      await d.start(surface)
      await startWorkflow(h, d, label)
      expect(h.stored.workflows).toBe(value)
      expect(await settingsText(d)).toContain(`Workflows: ${value}`)
      await d.workflow()
      expect(h.events.filter(x => x === 'ask:Workflow').length, 'once').toBe(1)
      expect(h.events.filter(x => x === 'workflow').length).toBe(2)
      // A new session does not ask either: it is a setting now.
      await d.start(surface)
      await d.workflow()
      expect(h.events.filter(x => x === 'ask:Workflow').length).toBe(1)
    })
  }

  test(`closed without an answer: paused for this workflow, nothing saved, asked again at the next one (${surface})`, { timeoutMs: 30000, options: { upRule: 'always send' } }, async ($, on) => {
    const h = engine(on, { ...OPUS, stored: { upRule: 'always send' } })
    const d = drive($, h)
    await d.start(surface)
    await startWorkflow(h, d)
    expect(h.stored.workflows, 'nothing saved').toBeUndefined()
    expect(await settingsText(d)).not.toContain('Workflows:')
    // Paused: the hand-off waits, though the rule says always send.
    h.rating = NEEDS_FABLE
    await d.submit(DEBUG)
    expect(handedTo(h), 'paused').toBeUndefined()
    // The next workflow asks again.
    await d.workflow()
    expect(h.events.filter(x => x === 'ask:Workflow').length).toBe(2)
  })

  test(`a workflow call is asked about once, even when its hook runs again (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS })
    const d = drive($, h)
    await d.start(surface)
    await startWorkflow(h, d, undefined, 't1', 'toolu_1')
    await d.workflow('toolu_1')
    expect(h.events.filter(x => x === 'ask:Workflow').length, 'the same call').toBe(1)
    await d.workflow('toolu_2')
    expect(h.events.filter(x => x === 'ask:Workflow').length, 'another call').toBe(2)
  })

  test(`rightsize off in /mods: a workflow is not asked about (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS })
    h.files['/home/test/.claude/mods/switches.json'] = '{"rightsize": false}'
    const d = drive($, h)
    await d.start(surface)
    await d.workflow()
    expect(h.events).toEqual(['workflow'])
  })

  test(`a set Workflows value is never asked about (${surface})`, { timeoutMs: 30000, options: { workflows: 'pause rightsize' } }, async ($, on) => {
    const h = engine(on, { ...OPUS, stored: { workflows: 'pause rightsize' } })
    const d = drive($, h)
    await d.start(surface)
    await d.workflow()
    expect(h.events).toEqual(['workflow'])
  })

  // After a workflow, a hand-off goes ahead or waits as Workflows says; the rule here is "always send".
  const AFTER_ROWS: { mode: string; to: string | undefined }[] = [
    { mode: 'ask', to: undefined },
    { mode: 'pause rightsize', to: undefined },
    { mode: 'follow my rules', to: 'fable' },
    { mode: 'right-size every agent', to: 'fable' },
  ]
  for (const row of AFTER_ROWS) {
    test(`Workflows ${row.mode}: a hand-off after a workflow ${row.to ? 'follows your rules' : 'waits'} (${surface})`, { timeoutMs: 30000, options: { workflows: row.mode, upRule: 'always send' } }, async ($, on) => {
      const h = engine(on, { ...OPUS, stored: { workflows: row.mode, upRule: 'always send' } })
      const d = drive($, h)
      await d.start(surface)
      await startWorkflow(h, d)
      h.rating = NEEDS_FABLE
      await d.submit(DEBUG)
      expect(handedTo(h)).toBe(row.to)
      if (!row.to) expect(h.files[LOG] ?? '').toContain('hand-off to fable skipped: a workflow ran this session')
    })
  }

  // A workflow's agent, from the Workflow tool: `workflow` names the run. Only "right-size every agent" sizes it.
  const WORKFLOW_AGENT = { workflow: { runId: 'wf_1', agentIndex: 1 } }
  const SPAWN_ROWS: { name: string; options: Record<string, string>; model: string | undefined; rated: boolean }[] = [
    { name: 'ask (closed without an answer): the agent is left alone', options: {}, model: undefined, rated: false },
    { name: 'pause rightsize: left alone', options: { workflows: 'pause rightsize' }, model: undefined, rated: false },
    { name: 'follow my rules: left alone', options: { workflows: 'follow my rules' }, model: undefined, rated: false },
    { name: 'right-size every agent: sized, with one rating', options: { workflows: 'right-size every agent' }, model: 'haiku', rated: true },
    { name: "right-size every agent with Claude's subagents off: left alone, and no rating", options: { workflows: 'right-size every agent', subagents: 'off' }, model: undefined, rated: false },
    { name: 'right-size every agent with Use Haiku off: Sonnet instead', options: { workflows: 'right-size every agent', useHaiku: 'off' }, model: 'sonnet', rated: true },
  ]
  for (const row of SPAWN_ROWS) {
    test(`a workflow's agent, with Workflows at ${row.name} (${surface})`, { timeoutMs: 30000, options: row.options }, async ($, on) => {
      const h = engine(on, { ...OPUS, stored: row.options })
      const d = drive($, h)
      await d.start(surface)
      await startWorkflow(h, d)
      h.rating = LISTING
      const before = h.ratings
      await d.spawn('wf-agent', undefined, WORKFLOW_AGENT)
      expect(h.spawned[0]?.model).toBe(row.model)
      expect(h.ratings - before, 'one Haiku rating for the agent, or none').toBe(row.rated ? 1 : 0)
    })
  }

  test(`with Workflows at right-size every agent, a fork, a teammate, a resume and an agent started by an agent are still left alone (${surface})`, { timeoutMs: 30000, options: { workflows: 'right-size every agent' } }, async ($, on) => {
    const h = engine(on, { ...OPUS, stored: { workflows: 'right-size every agent' } })
    const d = drive($, h)
    await d.start(surface)
    await startWorkflow(h, d)
    h.rating = LISTING
    await d.spawn('forked', undefined, { ...WORKFLOW_AGENT, fork: true })
    await d.spawn('mate', undefined, { ...WORKFLOW_AGENT, isTeammate: true })
    await d.spawn('again', undefined, { ...WORKFLOW_AGENT, resume: true })
    await d.spawn('nested', undefined, { ...WORKFLOW_AGENT, parentAgentId: 'agent-x' })
    await d.spawn('named', 'opus', WORKFLOW_AGENT)
    await d.spawn('explorer', undefined, { ...WORKFLOW_AGENT, subagentType: 'Explore' })
    expect(h.spawned.map(x => x.model ?? null)).toEqual([null, null, null, null, 'opus', null])
    // And one that is not a workflow's is sized as before.
    await d.spawn('lister')
    expect(last(h.spawned)?.model).toBe('haiku')
  })

  const MODES = ['ask', 'pause rightsize', 'follow my rules', 'right-size every agent']
  for (const mode of MODES) {
    test(`Workflows ${mode}: measurement stays paused after a workflow: calibration learns nothing, and its turns are marked (${surface})`, { timeoutMs: 30000, options: { workflows: mode } }, async ($, on) => {
      const h = engine(on, { ...OPUS, stored: { workflows: mode } })
      const d = drive($, h)
      await d.start(surface)
      await d.step('t0')
      await d.complete('t0')
      const learned = () => Object.keys((h.store[CAL_STORE] as Record<string, unknown> | undefined) ?? {}).filter(k => k.startsWith('lookup:') || k.endsWith(':subagent') || k.includes(':subagent:'))
      h.rating = NO_CHANGE
      await d.submit(LOOKUP)
      await d.step('t1', 0)
      await d.workflow()
      if (mode === 'right-size every agent') {
        h.rating = LISTING
        await d.spawn('wf-agent', undefined, WORKFLOW_AGENT)
        expect(h.spawned[0]?.model, 'sized').toBe('haiku')
        await d.step('w1', 0, 'agent-wf-agent')
        await d.step('w1', 1, 'agent-wf-agent')
      }
      await d.complete('t1')
      if (mode === 'right-size every agent') await d.answer('agent-wf-agent')
      await d.submit(LOOKUP)
      await d.step('t2')
      await d.complete('t2')
      expect(learned(), 'nothing learned').toEqual([])
      const lines = runLines(h)
      expect(lines.filter(l => l.kind === 'run').map(l => l.afterWorkflow), 'both turns marked').toEqual([true, true])
      if (mode === 'right-size every agent') {
        const sub = lines.filter(l => l.kind === 'subagent')
        expect(sub.map(l => l.afterWorkflow), 'the agent is logged, and marked').toEqual([true])
        h.now = Date.now()
        expect(cellsOf((await d.command('report')).text ?? '', 'Subagents on cheaper model')?.at(-1)).toBe('1')
      }
    })
  }
}
