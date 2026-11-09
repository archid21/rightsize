import { type TestBody, expect, test } from 'claude-code/testing'
import { CAL_FULL, CAL_STORE, DEFAULT_PRICES, type Calibration, type Rating, type Situation, delegateCost, delegateKeys } from './cost'
import { KEYS, SETTINGS, type SettingKey, inOptions, plainTitle } from './settings'
import { RUNS_FILE, LOG_PATH, LEGACY_RUNS, LOOKUP, DEBUG, NO_ONE, SEARCH, REVIEW, NO_CHANGE, FREE_SWITCHES, NO_COLD, BIG_TURN, engine, drive, flush, settle, untilAsked, DAY, PAGE, OLD_PRICES, last, mount, bandText, LOWER, WHATSNEXT_CMDS, installWhatsnext } from './testkit'

for (const surface of ['desktop', 'terminal'] as const) {

  const rated = (type: string, continues: boolean) => `{"fit":{"haiku":"no","sonnet":"medium","opus":"medium","fable":"medium"},"type":"${type}","read":8000,"write":1200,"steps":5,"continues":${continues},"reason":"rated"}`

  const LISTING = '{"fit":{"haiku":"low","sonnet":"low","opus":"low","fable":"low"},"type":"search","read":8000,"write":500,"steps":5,"reason":"list call sites"}'

  // Hands off to Haiku at 78% of staying: over the 70% default, under the 85% a hot pace allows.
  const NEAR = '{"fit":{"haiku":"medium","sonnet":"medium","opus":"medium","fable":"medium"},"size":"small","type":"search","read":20000,"write":1000,"steps":14,"reason":"list call sites"}'
  const HOUR = 3600_000
  const at = (h: { now: number }, ms: number) => new Date(h.now + ms).toISOString()

  const AUTO_RAISE = { remember: true, choices: { raise: 'auto' } }

  const MIN = 60_000

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

  // Close calls. A Fable session at high effort, a feature that Sonnet, Opus and Fable all do at medium.
  // Opus is measured (20 runs) at 0.9x Sonnet's estimate, Sonnet not at all: the 25% band is open, so the
  // two are close and the task-type guide (feature: Sonnet) decides. The stored count says which close call this is:
  // the fourth (3 before it) goes to the guide, the fifth explores.
  const TIE_RATING = '{"fit":{"haiku":"no","sonnet":"medium","opus":"medium","fable":"medium"},"type":"feature","read":150000,"write":3000,"steps":30,"reason":"big feature"}'
  const tieRating: Rating = { level: 'medium', fit: { haiku: null, sonnet: 'medium', opus: 'medium', fable: 'medium' }, type: 'feature', read: 150_000, write: 3000, steps: 30, reason: '' }
  const fableHigh: Situation = { tier: 'fable', level: 'high', context: 20_000, prices: DEFAULT_PRICES, cal: {} }
  // Opus's key pinned to `x` times Sonnet's estimate, from the raw cost of each route.
  const opusAt = (x: number, raw: (t: 'sonnet' | 'opus') => number, keys: readonly string[]): Calibration => ({
    [keys[keys.length - 1] ?? '']: { n: CAL_FULL, ratio: (raw('sonnet') * x) / raw('opus') },
  })
  const tieCal = (x: number) => opusAt(x, t => delegateCost(tieRating, fableHigh, t, 'medium'), delegateKeys('feature', 'opus', 'medium'))

  // Rater check: Sonnet's second opinion on every 50th rating, in the background.
  const FIT_NO = '{"fit":{"haiku":"no","sonnet":"no","opus":"medium","fable":"medium"},"type":"feature","read":2000,"write":300,"steps":1,"reason":"plain change"}'
  const runLines = (h: ReturnType<typeof engine>) =>
    (h.files[RUNS_FILE] ?? '')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l) as Record<string, unknown>)

  // ---- Every setting, on this surface ----------------------------------------------------------------
  //
  // Each of rightsize's /config rows is checked three ways: it is a declared option of its row (plugin.json
  // and settings.ts agree: Claude Code drops a stored value that is not one of a row's options, and fills in
  // its default), it takes effect when /config changes it, with no restart, and it takes effect when given at
  // load. The scenario for each shows one thing the row changes, with the value and with the default.

  const LOG = LOG_PATH
  const disagree = (h: ReturnType<typeof engine>) => (h.files[LOG] ?? '').includes('plugin.json and the settings table disagree')
  const settingsText = async (d: ReturnType<typeof drive>) => (await d.command('status')).text ?? ''
  // A row in the "you changed" list: indented, with no (default) or (detected) mark after it.
  // Only the list of changed rows counts: the Now section below it has a Mode line of its own.
  const listed = (t: string, title: string) => new RegExp(`^  ${title}: [^(\\n]+$`, 'm').test(t.split('\nNow\n')[0] ?? t)
  const changedCount = (t: string) => Number(/You changed (\d+) setting/.exec(t)?.[1] ?? 0)
  const OPUS = { model: 'claude-opus-5-5', effort: 'medium' }
  const FABLE = { model: 'claude-fable-5-1', effort: 'high' }
  const noteOf = (h: ReturnType<typeof engine>) => last(h.submitted)?.context?.join('\n') ?? ''
  const handedTo = (h: ReturnType<typeof engine>) => /model "(\w+)"/.exec(noteOf(h))?.[1]
  const YES_REMEMBER = { Remember: 'This session' }
  const LOWER_300 = '{"level":"low","model":"same","size":"small","type":"lookup","read":2000,"write":300,"steps":1}'
  // A raise fixture: a review, the one task type whose rated raise is still taken at prompt time on Opus (ADR 0021).
  const RAISE_HIGH = '{"level":"high","model":"same","type":"review","read":20000,"write":3000,"steps":8,"reason":"unknown cause"}'
  const NEEDS_FABLE = '{"level":"high","model":"fable","size":"small","type":"debug","read":30000,"write":4000,"steps":12,"reason":"subtle concurrency bug"}'
  const HAIKU_SEARCH = '{"level":"low","model":"haiku","size":"bulky","type":"search","read":150000,"write":3000,"steps":30,"reason":"repo-wide search"}'
  const FIT_LOW = '{"fit":{"haiku":"low","sonnet":"low","fable":"low"},"size":"bulky","type":"search","read":150000,"write":3000,"steps":30,"reason":"repo-wide search"}'
  const lookupLog = (h: { now: number }, steppedUp: number) =>
    Array.from({ length: 6 }, (_, i) => JSON.stringify({ at: new Date(h.now - (6 - i) * 60_000).toISOString(), kind: 'run', type: 'lookup', route: 'main', tier: 'opus', change: 'lower', steppedUp: i < steppedUp })).join('\n') + '\n'

  type Scene = { h: ReturnType<typeof engine>; d: ReturnType<typeof drive>; $: unknown; surface: string; turn: () => string }
  type Case = {
    key: SettingKey
    /** A value other than the default. */
    value: string
    start: { model: string; effort: string; store?: Record<string, unknown>; stored?: Record<string, string> }
    /** One turn first, so rightsize has seen the model and level the session runs on. */
    warm?: boolean
    setup?: (h: ReturnType<typeof engine>) => void
    /** The change in /config comes before the session starts, for what happens at the start. */
    early?: boolean
    /** Runs the scenario on a started plugin and says what it showed. */
    see: (c: Scene) => Promise<unknown>
    /** What `see` shows with the value, and with the default. */
    set: unknown
    def: unknown
  }

  // One prompt, with the questions it asked and the effort and hand-off it ended in.
  const prompt = async (c: Scene, text: string, rating: string, answers: Record<string, string> = {}) => {
    const asked = c.h.asked.length
    c.h.rating = rating
    c.h.answers = answers
    await c.d.submit(text)
    await c.d.step(c.turn())
    return { asked: c.h.asked.slice(asked).map(a => a.header), effort: last(c.h.sent)?.effort, to: handedTo(c.h) }
  }
  const effortOf = async (c: Scene, text: string, rating: string, answers: Record<string, string> = {}) => (await prompt(c, text, rating, answers)).effort
  const asking = async (c: Scene, text: string, rating: string, answers: Record<string, string> = {}) => {
    const { asked, effort } = await prompt(c, text, rating, answers)
    return { asked, effort }
  }
  const handOff = async (c: Scene, text: string, rating: string, answers: Record<string, string> = {}) => {
    const { asked, to } = await prompt(c, text, rating, answers)
    return { asked, to }
  }
  const hotWindows = (h: { now: number }) => [
    { kind: 'five_hour', percentUsed: 80, resetsAt: at(h, 2 * HOUR) },
    { kind: 'seven_day', percentUsed: 20, resetsAt: at(h, 160 * HOUR) },
  ]

  const CASES: Case[] = [
    // Ask before changing on: the lowering asks in the Effort dialog (answered Keep as is); off: lowered with no question.
    { key: 'askFirst', value: 'on', start: { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES } }, see: c => asking(c, LOOKUP, LOWER, { Effort: 'Keep as is' }), set: { asked: ['Effort'], effort: 'medium' }, def: { asked: [], effort: 'low' } },
    {
      key: 'mode',
      value: 'watch only',
      start: { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES } },
      // Watch only plans the lowering and says so on the band, and applies nothing.
      see: async c => ({ effort: await effortOf(c, LOOKUP, LOWER), watching: (await bandText(c.$, c.surface)).startsWith('Watching: would lower effort to low') }),
      set: { effort: 'medium', watching: true },
      def: { effort: 'low', watching: false },
    },
    // Routing off: the lowering is not applied (the other effects, the review switch and the mid-turn raise, have scenarios of their own below).
    { key: 'routing', value: 'off', start: { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES } }, see: c => effortOf(c, LOOKUP, LOWER), set: 'medium', def: 'low' },
    // Hand-offs off, Routing on: the hand-off to Fable gives way to an effort-only plan.
    { key: 'handOffs', value: 'off', start: OPUS, see: async c => (await handOff(c, DEBUG, NEEDS_FABLE)).to, set: undefined, def: 'fable' },
    {
      key: 'cache',
      value: 'off',
      start: OPUS,
      see: async c => {
        c.h.stepUsage = BIG_TURN
        c.h.virtual = true
        const t = c.turn()
        await c.d.step(t)
        await c.d.complete(t)
        // Balanced keeps warm until the usual start from the end of a big turn; with Cache off there is no keep-warm line.
        return (await bandText(c.$, c.surface)).startsWith('Warm until ')
      },
      set: false,
      def: true,
    },
    { key: 'floor', value: 'medium', start: { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES } }, see: c => effortOf(c, LOOKUP, LOWER), set: 'medium', def: 'low' },
    {
      key: 'ceiling',
      value: 'high',
      start: OPUS,
      see: c => effortOf(c, DEBUG, '{"level":"xhigh","model":"same","type":"review"}'),
      set: 'high',
      def: 'xhigh',
    },
    // A rule row left at not set means the default decides (automatically), with nothing asked: the scenarios set the other value.
    { key: 'lowerRule', value: 'never lower', start: { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES } }, see: c => asking(c, LOOKUP, LOWER), set: { asked: [], effort: 'medium' }, def: { asked: [], effort: 'low' } },
    { key: 'raiseRule', value: 'never raise', start: OPUS, see: c => asking(c, DEBUG, RAISE_HIGH), set: { asked: [], effort: 'medium' }, def: { asked: [], effort: 'high' } },
    { key: 'upRule', value: 'stay, raise effort only', start: OPUS, see: c => handOff(c, DEBUG, NEEDS_FABLE), set: { asked: [], to: undefined }, def: { asked: [], to: 'fable' } },
    { key: 'downRule', value: 'stay, lower effort only', start: FABLE, warm: true, see: c => handOff(c, SEARCH, HAIKU_SEARCH), set: { asked: [], to: undefined }, def: { asked: [], to: 'haiku' } },
    {
      key: 'remember',
      value: 'this session',
      start: { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES }, stored: NO_COLD },
      see: async c => {
        // Nothing is asked for the default answers: Remember follows a rule the person sets, here from the band's ⋯ menu.
        c.h.rating = RAISE_HIGH
        await c.d.submit(DEBUG)
        const t = c.turn()
        await c.d.step(t)
        c.h.answers = { Options: 'Never raise', Remember: 'Every session' }
        const before = c.h.asked.length
        const ui = await mount(c.$, c.surface)
        await ui.press({ key: 'mode' })
        await untilAsked(c.h, before)
        await ui.unmount()
        // Remember waits on the band for the turn to end.
        await c.d.complete(t)
        await settle()
        return { asked: c.h.asked.slice(before).map(a => a.header).filter(x => x === 'Remember'), saved: c.h.store.choices, remembered: c.h.store.remember }
      },
      set: { asked: [], saved: undefined, remembered: undefined },
      def: { asked: ['Remember'], saved: { raise: 'never' }, remembered: true },
    },
    { key: 'useHaiku', value: 'off', start: FABLE, warm: true, see: async c => (await handOff(c, SEARCH, FIT_LOW)).to, set: 'sonnet', def: 'haiku' },
    { key: 'useFable', value: 'off', start: OPUS, see: async c => (await handOff(c, DEBUG, NEEDS_FABLE)).to, set: undefined, def: 'fable' },
    {
      key: 'subagents',
      value: 'off',
      start: OPUS,
      see: async c => {
        c.h.rating = NO_CHANGE
        await c.d.submit(SEARCH)
        await c.d.step(c.turn())
        c.h.rating = LISTING
        await c.d.spawn('lister')
        return c.h.spawned[0]?.model
      },
      set: undefined,
      def: 'haiku',
    },
    {
      key: 'workflows',
      value: 'follow my rules',
      start: OPUS,
      see: async c => {
        const asked = c.h.asked.length
        c.h.rating = NO_CHANGE
        c.h.answers = { Workflow: 'Pause rightsize for workflows (recommended)' }
        await c.d.submit(LOOKUP)
        const t = c.turn()
        await c.d.step(t)
        await c.d.workflow()
        await c.d.complete(t)
        c.h.rating = NEEDS_FABLE
        await c.d.submit(DEBUG)
        return { asked: c.h.asked.slice(asked).map(a => a.header).filter(x => x === 'Workflow'), to: handedTo(c.h) }
      },
      set: { asked: [], to: 'fable' },
      def: { asked: ['Workflow'], to: undefined },
    },
    { key: 'pacing', value: 'off', start: { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES } }, setup: h => void (h.rateLimits = hotWindows(h)), see: async c => (await handOff(c, SEARCH, NEAR)).to, set: undefined, def: 'haiku' },
    {
      key: 'escalation',
      value: 'off',
      start: { ...OPUS, store: AUTO_RAISE },
      see: async c => {
        c.h.rating = NO_CHANGE
        await c.d.submit(LOOKUP)
        const t = c.turn()
        await c.d.step(t, 0)
        await c.d.bash('fail npm test')
        await c.d.bash('fail npm test')
        await c.d.step(t, 1)
        return last(c.h.sent)?.effort
      },
      set: 'medium',
      def: 'high',
    },
    {
      key: 'rater',
      value: 'haiku',
      start: OPUS,
      see: async c => {
        c.h.rating = NO_CHANGE
        await c.d.submit(LOOKUP)
        return c.h.completions[0]
      },
      set: 'haiku',
      def: 'sonnet',
    },
    {
      key: 'startTips',
      value: 'monthly',
      start: { ...OPUS, store: { startCheckedAt: 1_800_000_000_000 - 10 * DAY } },
      setup: h => void (h.files[RUNS] = easyLog(h.now)),
      early: true,
      see: async c => {
        await c.d.start(c.surface)
        return (await bandText(c.$, c.surface)).startsWith('Starting on')
      },
      set: false,
      def: true,
    },
    {
      key: 'idleWarning',
      value: 'over $1',
      start: OPUS,
      see: async c => {
        // A conversation that costs $0.63 to write again: over the default bar of $0.50, under $1. The prompt is never held.
        c.h.stepUsage = BIG_TURN
        const t = c.turn()
        await c.d.step(t)
        await c.d.complete(t)
        c.h.now += 3 * 60 * MIN
        c.h.rating = NO_CHANGE
        await c.d.submit('continue')
        return (await bandText(c.$, c.surface)).includes('Idle 3 hours')
      },
      set: false,
      def: true,
    },
    {
      key: 'beforeCold',
      value: 'off',
      start: OPUS,
      see: async c => {
        c.h.stepUsage = BIG_TURN
        c.h.virtual = true
        const t = c.turn()
        await c.d.step(t)
        await c.d.complete(t)
        // Balanced keeps warm until the usual start with no question, from the end of a big turn.
        return (await bandText(c.$, c.surface)).startsWith('Warm until ')
      },
      set: false,
      def: true,
    },
    {
      key: 'billing',
      value: 'subscription',
      start: OPUS,
      see: async c => {
        await c.d.config('upRule', 'ask first')
        await prompt(c, DEBUG, NEEDS_FABLE, { Subagent: 'Send it to a Fable subagent' })
        const q = c.h.asked.find(a => a.header === 'Subagent')?.question ?? ''
        return /That uses/.test(q) ? 'usage' : /About \$/.test(q) ? 'dollars' : q
      },
      set: 'usage',
      def: 'dollars',
    },
    {
      key: 'band',
      value: 'always',
      start: { ...OPUS, effort: 'low' },
      see: async c => {
        await c.d.step('t0')
        await c.d.complete('t0')
        c.h.rating = NO_CHANGE
        await c.d.submit(LOOKUP)
        return bandText(c.$, c.surface)
      },
      set: 'No change: low on Opus fits this prompt.',
      def: '',
    },
    {
      key: 'questionWait',
      value: '2 minutes',
      start: { model: 'claude-opus-5-5', effort: 'medium', store: { remember: true, choices: { raise: 'ask' } } },
      see: async c => {
        c.h.rating = RAISE_HIGH
        c.h.answers = { Effort: NO_ONE }
        c.h.sleepEnds = true
        await c.d.submit(DEBUG)
        const t = c.turn()
        await c.d.step(t)
        await c.d.complete(t)
        // What the question says, and how long rightsize waited for it.
        return [c.h.asked.find(a => a.header === 'Effort')?.question.match(/No answer in ([^:]+):/)?.[1], c.h.sleeps.includes(120_000)]
      },
      set: ['2 minutes', true],
      def: ['30 seconds', false],
    },
    {
      key: 'priceCheck',
      value: 'off',
      start: { ...OPUS, store: { pricesCheckedAt: 1_800_000_000_000 - 31 * DAY } },
      setup: h => {
        h.page = PAGE
        h.pricesFile = OLD_PRICES
      },
      early: true,
      see: async c => {
        await c.d.start(c.surface)
        await flush()
        return c.h.fetches
      },
      set: 0,
      def: 1,
    },
  ]

  test(`every setting has a scenario here, and every scenario's value is one of its options (${surface})`, async () => {
    expect(CASES.map(c => c.key).sort()).toEqual([...KEYS].sort())
    for (const c of CASES) {
      expect(inOptions(c.key, c.value), `${c.key}: ${c.value}`).toBe(true)
      expect(c.value, `${c.key}: a value other than the default`).not.toBe(SETTINGS[c.key].default)
    }
  })

  const scene = async ($: unknown, h: ReturnType<typeof engine>, c: Case, begin = true): Promise<Scene> => {
    let n = 0
    const s: Scene = { h, d: drive($, h), $, surface, turn: () => `t${++n}` }
    if (begin && !c.early) {
      await s.d.start(surface)
      if (c.warm) {
        const t = s.turn()
        await s.d.step(t)
        await s.d.complete(t)
      }
    }
    return s
  }

  for (const c of CASES) {
    const title = SETTINGS[c.key].title
    test(`${title} (${c.key}): by default, the scenario shows ${JSON.stringify(c.def)} (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
      const h = engine(on, c.start)
      c.setup?.(h)
      const s = await scene($, h, c)
      expect(await c.see(s)).toEqual(c.def)
    })

    test(`${title} (${c.key}): changed in /config it takes effect without a restart (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
      const h = engine(on, c.start)
      c.setup?.(h)
      const s = await scene($, h, c)
      const result = await s.d.config(c.key, c.value)
      expect(result.deny, 'the row takes the value').toBeUndefined()
      expect(await c.see(s)).toEqual(c.set)
      // It is yours now, and /rightsize says so.
      expect(await settingsText(s.d)).toContain(`${plainTitle(title)}: ${c.value}`)
    })

    test(`${title} (${c.key}): given at load it takes effect (${surface})`, { timeoutMs: 30000, options: { [c.key]: c.value } }, async ($, on) => {
      const h = engine(on, { ...c.start, stored: { [c.key]: c.value } })
      c.setup?.(h)
      const s = await scene($, h, c)
      expect(await c.see(s)).toEqual(c.set)
      expect(await settingsText(s.d)).toContain(`${plainTitle(title)}: ${c.value}`)
    })
  }

  // ---- The three feature switches: Routing, Hand-offs, Cache ----------------------------------------------------------
  const switches = (more: Record<string, string>) => ({ options: more, stored: more })
  const ROUTING_OFF = switches({ routing: 'off' })
  const HANDOFFS_OFF = switches({ handOffs: 'off' })
  const BOTH_OFF = switches({ routing: 'off', handOffs: 'off' })
  const logOf = (h: ReturnType<typeof engine>) => h.files[LOG_PATH] ?? ''
  const KEEP8 = { beforeCold: 'keep warm 8 h' }

  test(`Routing off: a lowering is not applied, nothing is asked, the band says nothing, and the log says why (${surface})`, { timeoutMs: 30000, options: ROUTING_OFF.options }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES }, stored: { ...ROUTING_OFF.stored, ...NO_COLD } })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = LOWER
    await d.submit(LOOKUP)
    expect(h.asked, 'no Lowering question').toEqual([])
    await d.step('t1')
    expect(last(h.sent)?.effort, 'stays at medium').toBe('medium')
    await d.complete('t1')
    expect(await bandText($, surface), 'nothing to say about a feature that is off').toBe('')
    expect(logOf(h)).toContain('effort change skipped: Routing is off')
    expect(logOf(h), 'the default decided nothing').not.toContain('Lowering: no rule set')
    expect(h.ratings, 'the prompt is still rated: Hand-offs is on').toBe(1)
    expect(runLines(h).find(l => l.type === 'lookup')).toMatchObject({ change: 'none' })
  })

  test(`Routing off: a raise, a session switch and a review on Opus are not set either, and a stuck turn is not raised (${surface})`, { timeoutMs: 30000, options: ROUTING_OFF.options }, async ($, on) => {
    // Raising set to ask: the question would offer a session switch.
    const h = engine(on, { model: 'claude-sonnet-5-5', effort: 'medium', store: { ...AUTO_RAISE, choices: { raise: 'ask' }, [CAL_STORE]: FREE_SWITCHES }, stored: { ...ROUTING_OFF.stored, ...NO_COLD } })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.answers = { Effort: 'Raise for this session' }
    h.rating = RAISE_HIGH
    await d.submit(DEBUG)
    expect(h.asked, 'no Effort question').toEqual([])
    expect((await settingsText(d)), 'no session switch').toContain('Session switch: none')
    await d.step('t1')
    expect(last(h.sent)?.effort).toBe('medium')
    await d.complete('t1')
    // A review from a Sonnet session stays on Sonnet.
    h.rating = REVIEW
    await d.submit('review the auth changes on this branch for subtle bugs please')
    await d.step('t2', 0)
    expect(last(h.sent)?.model, 'no switch to Opus').toBe('claude-sonnet-5-5')
    expect(logOf(h)).toContain('review switch skipped: Routing is off')
    // Stuck: two failures of one command would raise effort with Raise when stuck on.
    await d.bash('fail npm test')
    await d.bash('fail npm test')
    await d.step('t2', 1)
    expect(last(h.sent)?.effort, 'not raised mid-turn').toBe('medium')
    await d.complete('t2')
    expect(await bandText($, surface)).toBe('')
  })

  test(`Routing on, Raise when stuck on: the same stuck turn is raised (the control for the test above) (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-sonnet-5-5', effort: 'medium', store: { ...AUTO_RAISE, [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    await d.start(surface)
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    await d.step('t1', 0)
    await d.bash('fail npm test')
    await d.bash('fail npm test')
    await d.step('t1', 1)
    expect(last(h.sent)?.effort).toBe('high')
  })

  test(`Routing off, a session switch made earlier is not applied while it is off (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: { remember: true, choices: { raise: 'ask' } } })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.answers = { Effort: 'Raise for this session' }
    h.rating = RAISE_HIGH
    await d.submit(DEBUG)
    await d.step('t1')
    expect(last(h.sent)?.effort, 'raised for the session').toBe('high')
    await d.complete('t1')
    await d.config('routing', 'off')
    await d.step('t2')
    expect(last(h.sent)?.effort, 'the switch is not applied while Routing is off').toBe('medium')
    await d.config('routing', 'on')
    await d.step('t3')
    expect(last(h.sent)?.effort, 'and applies again when Routing is on').toBe('high')
  })

  test(`Hand-offs off, Routing on: a hand-off gives way to the effort-only plan, no note goes to the main chat, and the log says why (${surface})`, { timeoutMs: 30000, options: HANDOFFS_OFF.options }, async ($, on) => {
    const h = engine(on, { ...OPUS, stored: HANDOFFS_OFF.stored })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = NEEDS_FABLE
    await d.submit(DEBUG)
    expect(h.asked, 'no Subagent question').toEqual([])
    expect(h.submitted.at(-1)?.context ?? [], 'no hand-off note').toEqual([])
    await d.step('t1')
    expect(last(h.sent)?.effort, 'the effort plan took its place: raised to high').toBe('high')
    await d.complete('t1')
    expect(logOf(h)).toContain('hand-off skipped: Hand-offs is off')
    expect(runLines(h).find(l => l.type === 'debug')).toMatchObject({ change: 'raise' })
    expect(await bandText($, surface), 'the band describes the raise, not a hand-off').toMatch(/^Effort raised: medium → high/)
  })

  test(`Hand-offs off: Claude's own subagents stay on their model (${surface})`, { timeoutMs: 30000, options: HANDOFFS_OFF.options }, async ($, on) => {
    const h = engine(on, { ...OPUS, stored: HANDOFFS_OFF.stored })
    const d = drive($, h)
    await d.start(surface)
    h.rating = NO_CHANGE
    await d.submit(SEARCH)
    await d.step('t1')
    const rated = h.ratings
    h.rating = LISTING
    await d.spawn('lister')
    expect(h.spawned[0]?.model, 'left alone').toBeUndefined()
    expect(h.ratings, 'its brief is not rated').toBe(rated)
  })

  test(`Hand-offs on, Routing off: the hand-off still goes, and a "stay" answer changes no effort (${surface})`, { timeoutMs: 30000, options: ROUTING_OFF.options }, async ($, on) => {
    const h = engine(on, { ...OPUS, stored: ROUTING_OFF.stored })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = NEEDS_FABLE
    await d.submit(DEBUG)
    expect(handedTo(h), 'sent to Fable').toBe('fable')
    await d.step('t1')
    await d.complete('t1')
    // With the rule on stay, raise effort only: Routing off means no raise.
    await d.config('upRule', 'stay, raise effort only')
    h.rating = NEEDS_FABLE
    await d.submit(DEBUG)
    expect(h.submitted.at(-1)?.context ?? [], 'no note').toEqual([])
    await d.step('t2')
    expect(last(h.sent)?.effort, 'effort unchanged').toBe('medium')
  })

  test(`Routing and Hand-offs both off: no prompt is rated, no run line, no task, and the prompt goes through as typed (${surface})`, { timeoutMs: 30000, options: BOTH_OFF.options }, async ($, on) => {
    const h = engine(on, { ...OPUS, stored: BOTH_OFF.stored })
    const d = drive($, h)
    await d.start(surface)
    h.rating = NEEDS_FABLE
    await d.submit(DEBUG)
    expect(h.ratings, 'no rating call').toBe(0)
    expect(h.completions, 'no model call at all').toEqual([])
    expect(h.statuses, 'no "Rating the prompt..."').not.toContain('Rating the prompt...')
    expect(h.submitted.at(-1)).toMatchObject({ text: DEBUG })
    expect(h.submitted.at(-1)?.context ?? [], 'nothing added to the prompt').toEqual([])
    expect(h.asked).toEqual([])
    await d.step('t1')
    expect(last(h.sent)?.effort, 'effort as it was').toBe('medium')
    await d.complete('t1')
    await d.submit(LOOKUP)
    await d.spawn('lister')
    expect(h.ratings, 'a subagent is not rated either').toBe(0)
    expect(h.files[RUNS_FILE], 'no run line').toBeUndefined()
    expect(logOf(h), 'no rating line').not.toMatch(/rated|prompt not rated/)
    expect(await bandText($, surface)).toBe('')
  })

  test(`Routing and Hand-offs both off, a workflow starts: nothing is asked (${surface})`, { timeoutMs: 30000, options: BOTH_OFF.options }, async ($, on) => {
    const h = engine(on, { ...OPUS, stored: BOTH_OFF.stored })
    const d = drive($, h)
    await d.start(surface)
    await d.submit(LOOKUP)
    await d.step('t1')
    await d.workflow()
    expect(h.asked.map(a => a.header)).not.toContain('Workflow')
  })

  test(`Routing and Hand-offs both off, Cache on: the cold check still reads the conversation's size, and keeps warm (${surface})`, { timeoutMs: 30000, options: { ...BOTH_OFF.options, ...KEEP8 } }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: { ...BOTH_OFF.stored, ...KEEP8 } })
    await d.submit(LOOKUP)
    await coldTurn(d, 't1')
    expect(h.ratings, 'nothing was rated').toBe(0)
    expect(await bandText($, surface)).toBe('Warm until 2:00 · $0.00 so far')
    await h.advance(57 * MIN)
    expect(h.forks.length, 'the first keep-warm request').toBe(1)
    expect(logOf(h)).toContain('keeping warm until 2:00')
  })

  test(`Routing and Hand-offs both off, Cache on: the idle warning still shows, on a band of its own, without a rating (${surface})`, { timeoutMs: 30000, options: BOTH_OFF.options }, async ($, on) => {
    const h = engine(on, { ...OPUS, stored: BOTH_OFF.stored })
    const d = drive($, h)
    await d.start(surface)
    h.stepUsage = BIG_TURN
    await d.step('t1')
    await d.complete('t1')
    h.now += 3 * 60 * MIN
    await d.submit('continue')
    expect(h.ratings, 'nothing was rated').toBe(0)
    expect(await bandText($, surface)).toMatch(/^Idle 3 hours: the cache went cold, so this prompt writes the conversation \(~81K tokens\) again/)
    expect(logOf(h)).toContain('idle 3 hours with 80500 tokens: noted on the band')
    // And it is said once: the next prompt carries no note.
    await d.submit('and again')
    expect(await bandText($, surface)).toBe('')
  })

  test(`Routing and Hand-offs both off, Cache off too: a prompt passes through and nothing runs (${surface})`, { timeoutMs: 30000, options: { ...BOTH_OFF.options, cache: 'off' } }, async ($, on) => {
    const h = engine(on, { ...OPUS, stored: { ...BOTH_OFF.stored, cache: 'off' } })
    const d = drive($, h)
    h.stepUsage = BIG_TURN
    await d.start(surface)
    await d.step('t1')
    await d.complete('t1')
    h.now += 3 * 60 * MIN
    await d.submit('continue')
    expect(h.ratings).toBe(0)
    expect(await bandText($, surface)).toBe('')
    expect(h.forks).toEqual([])
  })

  test(`Hand-offs off, watch only: the band says what the switched-on features would do, a raise and no hand-off (${surface})`, { timeoutMs: 30000, options: { ...HANDOFFS_OFF.options, mode: 'watch only' } }, async ($, on) => {
    const h = engine(on, { ...OPUS, stored: { ...HANDOFFS_OFF.stored, mode: 'watch only' } })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = NEEDS_FABLE
    await d.submit(DEBUG)
    expect(await bandText($, surface)).toMatch(/^Watching: would raise effort to high on Opus\./)
    expect(h.submitted.at(-1)?.context ?? [], 'nothing applied').toEqual([])
    await d.step('t1')
    expect(last(h.sent)?.effort).toBe('medium')
  })

  test(`/rightsize status lists the three switches after the Mode line (${surface})`, { timeoutMs: 30000, options: switches({ cache: 'off' }).options }, async ($, on) => {
    const h = engine(on, { ...OPUS, stored: switches({ cache: 'off' }).stored })
    const d = drive($, h)
    await d.start(surface)
    const lines = (await settingsText(d)).split('\n')
    const mode = lines.findIndex(l => l.startsWith('  Mode: '))
    expect(mode).toBeGreaterThan(-1)
    expect(lines[mode + 1]).toBe('  Features: Routing on · Hand-offs on · Cache off')
    await d.config('routing', 'off')
    await d.config('handOffs', 'off')
    await d.config('cache', 'on')
    expect((await settingsText(d)).split('\n')).toContain('  Features: Routing off · Hand-offs off · Cache on')
  })

  test(`a row that belongs to a switched-off feature keeps its value (${surface})`, { timeoutMs: 30000, options: { escalation: 'off', cache: 'off', beforeCold: 'compact' } }, async ($, on) => {
    const h = engine(on, { ...OPUS, stored: { escalation: 'off', cache: 'off', beforeCold: 'compact' } })
    const d = drive($, h)
    await d.start(surface)
    await d.config('cache', 'off')
    await d.config('routing', 'off')
    const text = await settingsText(d)
    expect(text).toContain('Raise when stuck: off')
    expect(text).toContain('Before the cache goes cold: compact')
    expect(text).toContain('Cache: off')
  })

  // The row exists as plugin.json declares it: its default, and each of its options. Claude Code fills the
  // default in and drops a stored value that is not an option, so rightsize reading a value back is the
  // proof that plugin.json declares it. (A test cannot read plugin.json; scripts/check-settings.mjs does.)
  for (const key of KEYS) {
    const row = SETTINGS[key]
    test(`${row.title} (${key}): a picker whose default is "${row.default}" (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
      const h = engine(on, { ...OPUS })
      const d = drive($, h)
      await d.start(surface)
      expect(listed(await settingsText(d), plainTitle(row.title))).toBe(false)
      expect(disagree(h), 'plugin.json declares this row with this default').toBe(false)
    })
    for (const option of row.options.filter(o => o !== row.default)) {
      test(`${row.title} (${key}): "${option}" is a declared option (${surface})`, { timeoutMs: 30000, options: { [key]: option } }, async ($, on) => {
        const h = engine(on, { ...OPUS, stored: { [key]: option } })
        const d = drive($, h)
        await d.start(surface)
        // "check now" is an action, not a state: it checks once and the row goes back to monthly.
        const shown = key === 'priceCheck' && option === 'check now' ? 'monthly' : option
        expect(await settingsText(d)).toContain(`${plainTitle(row.title)}: ${shown}`)
        expect(disagree(h)).toBe(false)
      })
    }
  }

  test(`every row at its default: plugin.json and the table agree, and nothing is yours (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS })
    const d = drive($, h)
    await d.start(surface)
    const text = await settingsText(d)
    for (const key of KEYS) expect(listed(text, plainTitle(SETTINGS[key].title)), key).toBe(false)
    expect(text).toContain('are at their defaults')
    expect(disagree(h)).toBe(false)
  })

  test(`a value that is not one of a row's options, or a stored value for a removed row, counts as unset: the default applies, and it is not yours (${surface})`, { timeoutMs: 30000, options: { ceiling: 'ultra', startTips: 'on' } }, async ($, on) => {
    const h = engine(on, { ...OPUS, stored: { ceiling: 'ultra', startTips: 'on', handOff: '60%', raterCheck: 'off', missPause: '35%' } })
    const d = drive($, h)
    await d.start(surface)
    const text = await settingsText(d)
    expect(text).not.toContain('Highest effort:')
    expect(text, 'a stored on, from before it became a list: the old on is the default').not.toContain('Start suggestions:')
    expect(text, 'removed rows are ignored').not.toContain('Hand-off threshold:')
    expect(text).not.toContain('Rater check:')
    expect(text).not.toContain('Pause after misses:')
    expect(disagree(h), 'and raise no warning').toBe(false)
    expect(text).toContain('are at their defaults')
  })

  const SOME = { floor: 'medium', ceiling: 'xhigh', lowerRule: 'never lower', billing: 'api', escalation: 'off', pacing: 'off' }
  test(`/rightsize lists every setting, with (yours) for those you set and (default) for the rest (${surface})`, { timeoutMs: 30000, options: SOME }, async ($, on) => {
    const set = SOME
    const h = engine(on, { ...OPUS, stored: set })
    const d = drive($, h)
    await d.start(surface)
    const text = await settingsText(d)
    for (const key of KEYS) {
      const row = SETTINGS[key]
      expect(listed(text, plainTitle(row.title)), key).toBe(key in set)
      if (key in set) expect(text, key).toContain(`${plainTitle(row.title)}: ${(set as Record<string, string>)[key]}\n`)
    }
    expect(changedCount(text)).toBe(6)
    expect(text).toContain(`The other ${KEYS.length - 6} are defaults`)
  })

  test(`on a subscription the hand-off question and its result say what the usage is compared with: "vs staying on" (${surface})`, { timeoutMs: 30000, options: { billing: 'subscription' } }, async ($, on) => {
    const h = engine(on, { ...FABLE, stored: { billing: 'subscription' } })
    h.rateLimits = [{ kind: 'five_hour', percentUsed: 12 }]
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = HAIKU_SEARCH
    await d.config('downRule', 'ask first')
    h.answers = { Subagent: 'Send it to a Haiku subagent' }
    await d.submit(SEARCH)
    expect(h.asked.find(a => a.header === 'Subagent')?.question ?? '').toMatch(/That uses about \d+% of the usage vs staying on Fable \(estimated\)\./)
    h.subModel = 'claude-haiku-5-5'
    await d.step('t1', 0)
    await d.agent('haiku')
    await d.step('t1', 0, 'a1')
    await d.step('t1', 1)
    await d.complete('t1')
    expect(await bandText($, surface)).toMatch(/^Sent to Haiku\. ~\d+% of Fable usage\.$/)
  })

  test(`answers saved by an earlier session show in /config at the next start, and a row you set wins over them (${surface})`, { timeoutMs: 30000, options: { raiseRule: 'never raise' } }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: { remember: true, choices: { lower: 'auto', raise: 'auto' } }, stored: { raiseRule: 'never raise' } })
    const d = drive($, h)
    await d.start(surface)
    expect(h.stored.lowerRule, 'the saved answer, now a row').toBe('lower automatically')
    expect(h.stored.raiseRule, 'the row you set is left alone').toBe('never raise')
    const text = await settingsText(d)
    expect(text).toContain('Lowering: lower automatically')
    expect(text).toContain('Raising: never raise')
  })

  // Where plugin.json files the options: `rightsize`, or `rightsize@<marketplace>`.
  for (const configKey of ['rightsize', 'rightsize@archid21', 'rightsize@inline']) {
    test(`options stored under ${configKey} are yours (${surface})`, { timeoutMs: 30000, options: { floor: 'high' } }, async ($, on) => {
      const h = engine(on, { ...OPUS, stored: { floor: 'high' }, configKey })
      const d = drive($, h)
      await d.start(surface)
      const text = await settingsText(d)
      expect(text).toContain('Lowest effort: high')
      expect(text, 'another plugin\'s entry is not ours').not.toContain('Highest effort: max (yours)')
    })
  }

  test(`settings that cannot be read: a value that differs from its default counts as yours (${surface})`, { timeoutMs: 30000, options: { ceiling: 'high', floor: 'low' } }, async ($, on) => {
    const h = engine(on, { ...OPUS })
    h.settingsFail = true
    const d = drive($, h)
    await d.start(surface)
    const text = await settingsText(d)
    expect(text).toContain('Highest effort: high')
    expect(text, 'at its default: nothing says it was set').not.toContain('Lowest effort:')
  })

  test(`another plugin's change to a row, and a change to another row of the menu, do not make a row yours (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS })
    const d = drive($, h)
    await d.start(surface)
    await d.config('pacing', 'off', 'plugin')
    expect(await settingsText(d), 'applied, but not yours').not.toContain('Budget pacing:')
    await ($ as unknown as { config: { set: (x: unknown) => Promise<unknown> } }).config.set({ key: 'theme', value: 'dark', origin: { kind: 'composer' } })
    expect(await settingsText(d), 'another row of the menu changes nothing here').toContain('are at their defaults')
    await d.config('pacing', 'on')
    expect(await settingsText(d), 'the person sets it back: now it is theirs').toContain('Budget pacing: on')
    await d.config('escalation', 'off', 'bridge')
    expect(await settingsText(d), "a /config key=value from the person's phone").toContain('Raise when stuck: off')
  })

  test(`a row changed in /config never reaches another row (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS })
    const d = drive($, h)
    await d.start(surface)
    await d.config('floor', 'high')
    await d.config('idleWarning', 'over $1')
    const text = await settingsText(d)
    expect(text).toContain('Lowest effort: high')
    expect(text).toContain('Idle warning: over $1')
    expect(text).not.toContain('Band:')
    expect(text).not.toContain('Highest effort:')
    expect(changedCount(text)).toBe(2)
  })


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
}
