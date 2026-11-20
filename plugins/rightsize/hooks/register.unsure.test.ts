import { expect, test } from 'claude-code/testing'
import { CAL_STORE } from './cost'
import type { RunLine } from './report'
import { FREE_SWITCHES, LOG_PATH, LOOKUP, RUNS_FILE, SEARCH, drive, engine, last } from './testkit'

// P-83 (ADR 0096): Try lowering when unsure. When the rater is not sure and the plan is "lower effort", the prompt is lowered at most
// one level, with its own miss bucket (unsure:type:tier), a window of the last 10 unsure prompts and a pause over 20% misses.

const NOT_SURE_LOW = '{"fit":{"haiku":"no","sonnet":"medium","opus":"low","fable":"low"},"type":"lookup","read":2000,"write":3000,"steps":1,"continues":false,"sure":false,"reason":"unclear which config"}'
const NOT_SURE_LOW_FOLLOWS = NOT_SURE_LOW.replace('"continues":false', '"continues":true')
const SURE_LOW = '{"level":"low","model":"same","size":"small","type":"lookup","read":2000,"write":3000,"steps":1,"reason":"one function lookup"}'
const NOT_SURE_HAIKU_SEARCH = '{"level":"low","model":"haiku","size":"bulky","type":"search","read":150000,"write":3000,"steps":30,"sure":false,"reason":"repo-wide search"}'
const NOT_SURE_RAISE = '{"level":"high","model":"same","type":"review","read":20000,"write":3000,"steps":8,"sure":false,"reason":"unknown cause"}'
const LONG = (text: string) => `${text} ${'and also this part of the request is long '.repeat(160)} but only in src/`
const OPUS_ID = 'claude-opus-5-5'
const KEY = 'unsure:lookup:opus'

type H = ReturnType<typeof engine>
const lines = (h: H) => (h.files[RUNS_FILE] ?? '').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as RunLine & { unsureTry?: string; unsureKey?: string })
const runs = (h: H) => lines(h).filter(l => (l.kind ?? 'run') === 'run')
const log = (h: H) => h.files[LOG_PATH] ?? ''
/** Earlier unsure prompts on lookup/opus, oldest first: 'hit' and 'miss' were lowered, 'left' was paused. */
const seed = (h: H, kinds: ('hit' | 'miss' | 'left')[]) => {
  h.files[RUNS_FILE] = `${kinds
    .map((k, i) =>
      JSON.stringify({
        at: new Date(h.now - (kinds.length - i + 5) * 60_000).toISOString(),
        kind: 'run',
        id: `s${i}`,
        type: 'lookup',
        route: 'main',
        tier: 'opus',
        model: OPUS_ID,
        unsure: 'rater',
        change: k === 'left' ? 'none' : 'lower',
        unsureTry: k === 'left' ? 'paused' : 'lowered',
        unsureKey: KEY,
        ...(k === 'miss' ? { steppedUp: true, steppedUpBy: 'error' } : {}),
      }),
    )
    .join('\n')}\n`
}
const ten = (misses: number) => [...Array<'miss'>(misses).fill('miss'), ...Array<'hit'>(10 - misses).fill('hit')]

for (const surface of ['desktop', 'terminal'] as const) {
  const start = (over: { effort?: string; stored?: Record<string, string>; model?: string } = {}) => ({ model: over.model ?? OPUS_ID, effort: over.effort ?? 'medium', store: { [CAL_STORE]: FREE_SWITCHES }, ...(over.stored ? { stored: over.stored } : {}) })
  /** A session with one finished turn, so rightsize has seen the model and effort. */
  async function warm($: unknown, h: H) {
    h.now = Date.now()
    const d = drive($, h)
    return d
  }
  async function begin(d: ReturnType<typeof drive>) {
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
  }
  /** One prompt: its rating, then the level its first step carried; the turn is completed. */
  async function prompt(d: ReturnType<typeof drive>, h: H, turn: string, rating: string, text = LOOKUP) {
    h.rating = rating
    await d.submit(text)
    await d.step(turn, 0)
    const effort = last(h.sent)?.effort
    await d.complete(turn)
    return effort
  }

  test(`row off: an unsure prompt is left as it is, as before (${surface})`, { timeoutMs: 30000, options: { lowerUnsure: 'off' } }, async ($, on) => {
    const h = engine(on, start({ effort: 'high', stored: { lowerUnsure: 'off' } }))
    const d = await warm($, h)
    await begin(d)
    expect(await prompt(d, h, 't1', NOT_SURE_LOW)).toBe('high')
    expect(log(h)).toContain('rater not sure: prompt left alone (the plan was effort lower)')
    const line = runs(h).at(-1)
    expect([line?.unsure, line?.change, line?.unsureTry]).toEqual(['rater', 'none', undefined])
  })

  test(`row on (the default): an unsure lowering goes one level, never more, and the run line records it (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, start({ effort: 'high' }))
    const d = await warm($, h)
    await begin(d)
    expect(await prompt(d, h, 't1', SURE_LOW), 'a sure rating lowers all the way').toBe('low')
    expect(await prompt(d, h, 't2', NOT_SURE_LOW), 'an unsure one goes one level: high to medium').toBe('medium')
    const line = runs(h).at(-1)
    expect([line?.unsure, line?.change, line?.unsureTry, line?.unsureKey, line?.level]).toEqual(['rater', 'lower', 'lowered', KEY, 'medium'])
    expect(log(h)).not.toContain('rater not sure: prompt left alone')
    expect(runs(h).at(-2)?.unsureTry, 'a sure prompt carries no unsure fields').toBeUndefined()
  })

  test(`row on, one level from medium is low (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, start())
    const d = await warm($, h)
    await begin(d)
    expect(await prompt(d, h, 't1', NOT_SURE_LOW)).toBe('low')
  })

  test(`row on: unsure with any other plan stays as it is: hand-down and raise (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const f = engine(on, { model: 'claude-fable-5-2', effort: 'high', store: { [CAL_STORE]: FREE_SWITCHES } })
    f.now = Date.now()
    const d = drive($, f)
    await begin(d)
    f.rating = NOT_SURE_HAIKU_SEARCH
    await d.submit(SEARCH)
    expect(last(f.submitted)?.context ?? [], 'not handed down').toEqual([])
    await d.step('t1', 0)
    await d.complete('t1')
    expect(log(f)).toContain('rater not sure: prompt left alone (the plan was delegate down)')
    expect(runs(f).at(-1)?.unsureTry).toBeUndefined()
  })

  test(`row on: an unsure raise is still dropped (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, start())
    const d = await warm($, h)
    await begin(d)
    expect(await prompt(d, h, 't1', NOT_SURE_RAISE, SEARCH)).toBe('medium')
    expect(log(h)).toContain('rater not sure: prompt left alone (the plan was effort raise)')
  })

  test(`row on: a cut request, a missing last reply and a failing last test run still win: no lowering (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    // Cut.
    const c = engine(on, start())
    const dc = await warm($, c)
    await begin(dc)
    expect(await prompt(dc, c, 't1', NOT_SURE_LOW, LONG(LOOKUP))).toBe('medium')
    expect(runs(c).at(-1)?.unsureTry).toBeUndefined()
    expect(runs(c).at(-1)?.change).toBe('none')
  })

  test(`row on: a task whose last reply is missing is not lowered when the rater is unsure (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, start())
    const d = await warm($, h)
    await begin(d)
    h.messages = []
    expect(await prompt(d, h, 't1', SURE_LOW), 'a task starts: nothing is missing yet').toBe('low')
    expect(await prompt(d, h, 't2', NOT_SURE_LOW)).toBe('medium')
    expect(runs(h).at(-1)?.change).toBe('none')
    expect(runs(h).at(-1)?.unsureTry).toBeUndefined()
  })

  test(`row on: a task that ended on a failing test run is not lowered when the rater is unsure (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, start())
    const d = await warm($, h)
    await begin(d)
    h.rating = '{"level":"medium","model":"same","size":"small","type":"lookup","read":2000,"write":300,"steps":2,"continues":false}'
    await d.submit(LOOKUP)
    await d.step('t1', 0)
    await d.bash('npm test --red')
    await d.step('t1', 1)
    await d.complete('t1')
    expect(await prompt(d, h, 't2', NOT_SURE_LOW_FOLLOWS, 'ok now go ahead and make that change please')).toBe('medium')
    expect(runs(h).at(-1)?.change).toBe('none')
    expect(runs(h).at(-1)?.unsureTry).toBeUndefined()
  })

  test(`window of 10: 2 misses in the last 10 do not pause (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, start())
    h.now = Date.now()
    seed(h, ten(2))
    const d = drive($, h)
    await begin(d)
    expect(await prompt(d, h, 't1', NOT_SURE_LOW), '2 of 10 do not pause').toBe('low')
    expect(runs(h).at(-1)?.unsureTry).toBe('lowered')
  })

  test(`window of 10: 3 misses in the last 10 pause; the prompt is left, logged and marked (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, start())
    h.now = Date.now()
    seed(h, ten(3))
    const d = drive($, h)
    await begin(d)
    expect(await prompt(d, h, 't1', NOT_SURE_LOW), '3 of 10 pause').toBe('medium')
    const line = runs(h).at(-1)
    expect([line?.unsure, line?.change, line?.unsureTry, line?.unsureKey]).toEqual(['rater', 'none', 'paused', KEY])
    expect(log(h)).toContain('3 of the last 10')
    expect(log(h)).toContain(KEY)
  })

  test(`fewer than 10 unsure prompts: lowering is allowed, however many missed (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, start())
    h.now = Date.now()
    seed(h, ['miss', 'miss', 'miss', 'miss', 'miss'])
    const d = drive($, h)
    await begin(d)
    expect(await prompt(d, h, 't1', NOT_SURE_LOW)).toBe('low')
  })

  test(`cooldown: left unsure prompts enter the window as non-misses, and lowering resumes (${surface})`, { timeoutMs: 60000 }, async ($, on) => {
    const h = engine(on, start())
    h.now = Date.now()
    // 3 misses, the oldest, then 7 hits: paused. One left prompt pushes the oldest miss out of the window: 2 of 10.
    seed(h, ['miss', 'miss', 'miss', ...Array<'hit'>(7).fill('hit')])
    const d = drive($, h)
    await begin(d)
    expect(await prompt(d, h, 't1', NOT_SURE_LOW), 'paused').toBe('medium')
    expect(runs(h).at(-1)?.unsureTry).toBe('paused')
    expect(await prompt(d, h, 't2', NOT_SURE_LOW), 'the window is back at 20%: lowering resumes').toBe('low')
    expect(runs(h).at(-1)?.unsureTry).toBe('lowered')
  })

  test(`buckets are separate: a paused unsure bucket does not stop a sure lowering, and the unsure bucket ignores normal lowerings (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, start())
    h.now = Date.now()
    seed(h, ten(3))
    const d = drive($, h)
    await begin(d)
    expect(await prompt(d, h, 't1', SURE_LOW), 'the normal bucket has no misses').toBe('low')
    // Ten normal lowerings that all missed make no difference to the unsure bucket's state; a different task type is a different bucket.
    expect(await prompt(d, h, 't2', NOT_SURE_LOW.replace('"lookup"', '"debug"')), 'unsure debug has its own bucket: no history, so it lowers').toBe('low')
    expect(runs(h).at(-1)?.unsureKey).toBe('unsure:debug:opus')
  })

  test(`the report's Rater not sure row shows the lowered prompts, their misses and a paused bucket (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, start())
    h.now = Date.now()
    // 7 hits, 3 misses, 2 left: the last 10 hold 3 misses, so the bucket is paused.
    seed(h, [...Array<'hit'>(7).fill('hit'), 'miss', 'miss', 'miss', 'left', 'left'])
    const d = drive($, h)
    await begin(d)
    const text = await d.report()
    const row = text.split('\n').find(l => l.includes('Rater not sure')) ?? ''
    expect(row).toContain('10 lowered one level (3 missed)')
    expect(row).toContain('2 left as they were')
    expect(row).toContain('unsure lowering paused for lookup on Opus')
  })
}
