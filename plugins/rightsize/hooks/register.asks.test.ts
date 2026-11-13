import { type TestBody, expect, test } from 'claude-code/testing'
import { CAL_STORE } from './cost'
import { LOG_PATH, LOOKUP, DEBUG, SEARCH, REVIEW, NO_CHANGE, NO_COLD, FREE_SWITCHES, engine, drive, settle, last, LOWER } from './testkit'

// The runtime asks (Effort, Stronger, Subagent, Stuck) each end in four answers: once, for this session, keep, always.
// "Always" writes the rule's /config row the way the settings pane does and the session follows it. "For this session" writes
// nothing: not a /config row, not the store. Raise when stuck says what a stuck turn does (follow Raising, ask me, raise automatically, off).

for (const surface of ['desktop', 'terminal'] as const) {
  const OPUS = { model: 'claude-opus-5-5', effort: 'medium' }
  const SONNET = { model: 'claude-sonnet-5-5', effort: 'medium' }
  const FABLE = { model: 'claude-fable-5-2', effort: 'high' }
  const RAISE_HIGH = '{"level":"high","model":"same","type":"review","read":20000,"write":3000,"steps":8,"reason":"unknown cause"}'
  const NEEDS_FABLE = '{"level":"high","model":"fable","size":"small","type":"debug","read":30000,"write":4000,"steps":12,"reason":"subtle concurrency bug"}'
  const HAIKU_SEARCH = '{"level":"low","model":"haiku","size":"bulky","type":"search","read":150000,"write":3000,"steps":30,"reason":"repo-wide search"}'
  const log = (h: ReturnType<typeof engine>) => h.files[LOG_PATH] ?? ''
  const handedTo = (h: ReturnType<typeof engine>) => /model "(\w+)"/.exec(last(h.submitted)?.context?.join('\n') ?? '')?.[1]
  /** Writes that rightsize itself made to a row (the settings pane's and the config hook's carry an origin). */
  const written = (h: ReturnType<typeof engine>, row: string) => h.sets.filter(x => x.key === `rightsize.${row}` && x.origin === undefined)

  // ---- Prompt-time asks: Effort, Stronger, Subagent ----

  type Ask = {
    name: string
    start: { model: string; effort: string; store?: Record<string, unknown> }
    /** The rule row that makes the situation ask. */
    row: 'lowerRule' | 'raiseRule' | 'upRule' | 'downRule'
    asking: string
    rating: string
    text: string
    header: string
    /** The option labels for this session and for always, and the row value "always" writes. */
    session: string
    always: string
    value: string
    /** What the situation ends in once it acts: the effort or hand-off the turn was sent with. */
    acts: (h: ReturnType<typeof engine>) => unknown
    want: unknown
  }
  const ASKS: Ask[] = [
    { name: 'Effort (lower)', start: { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES } }, row: 'lowerRule', asking: 'ask me', rating: LOWER, text: LOOKUP, header: 'Effort', session: 'Lower for this session', always: 'Always lower', value: 'lower automatically', acts: h => last(h.sent)?.effort, want: 'low' },
    { name: 'Effort (raise)', start: OPUS, row: 'raiseRule', asking: 'ask me', rating: RAISE_HIGH, text: DEBUG, header: 'Effort', session: 'Raise for this session', always: 'Always raise', value: 'raise automatically', acts: h => last(h.sent)?.effort, want: 'high' },
    { name: 'Stronger (a review switch)', start: { ...SONNET, store: { [CAL_STORE]: FREE_SWITCHES } }, row: 'upRule', asking: 'ask first', rating: REVIEW, text: DEBUG, header: 'Stronger', session: 'Use the stronger model for this session', always: 'Always use the stronger model', value: 'always send', acts: h => last(h.sent)?.model, want: 'opus' },
    { name: 'Subagent (stronger)', start: OPUS, row: 'upRule', asking: 'ask first', rating: NEEDS_FABLE, text: DEBUG, header: 'Subagent', session: 'Send to Fable subagents for this session', always: 'Always send', value: 'always send', acts: handedTo, want: 'fable' },
    { name: 'Subagent (cheaper)', start: FABLE, row: 'downRule', asking: 'ask first', rating: HAIKU_SEARCH, text: SEARCH, header: 'Subagent', session: 'Send to Haiku subagents for this session', always: 'Always send', value: 'always send', acts: handedTo, want: 'haiku' },
  ]

  /** A started session on the ask's situation, with its row set to ask; one prompt through, answered as `answers` says. */
  const setup = async ($: unknown, on: Parameters<TestBody>[1], a: Ask) => {
    const h = engine(on, { ...a.start, stored: { ...NO_COLD } })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    await d.config(a.row, a.asking)
    const prompt = async (turn: string, answer: string) => {
      h.rating = a.rating
      h.answers = { [a.header]: answer }
      await d.submit(a.text)
      await d.step(turn)
      const out = a.acts(h)
      await d.complete(turn)
      return out
    }
    return { h, d, prompt }
  }

  for (const a of ASKS) {
    test(`${a.name} ask, ${a.always}: writes the row as the settings pane does, and the session follows it (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
      const { h, d, prompt } = await setup($, on, a)
      expect(await prompt('t1', a.always)).toBe(a.want)
      expect(h.asked.map(x => x.header)).toEqual([a.header])
      expect(h.asked[0]?.options, 'four options, the last one is always').toContain(a.always)
      const wrote = written(h, a.row)
      expect(wrote.map(x => x.value), 'one write to the row').toEqual([a.value])
      expect(h.stored[a.row]).toBe(a.value)
      // The same key and value the settings pane writes for that row.
      await d.config(a.row, a.asking)
      await d.config(a.row, a.value)
      const pane = last(h.sets)
      expect({ key: wrote[0]?.key, value: wrote[0]?.value }).toEqual({ key: pane?.key, value: pane?.value })
      expect(h.store.choices, 'nothing goes to the store').toBeUndefined()
      expect(h.store.remember).toBeUndefined()
      // Asked no more: the rule is automatic now.
      expect(await prompt('t2', 'Keep as is')).toBe(a.want)
      expect(h.asked.length, 'not asked again').toBe(1)
    })

    test(`${a.name} ask, ${a.session}: writes no row and nothing to the store, and the next one acts without asking (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
      const { h, prompt } = await setup($, on, a)
      const before = h.sets.length
      expect(await prompt('t1', a.session)).toBe(a.want)
      expect(h.asked.map(x => x.header)).toEqual([a.header])
      expect(h.asked[0]?.options).toContain(a.session)
      expect(h.sets.length, 'no /config write at all').toBe(before)
      expect(h.store.choices, 'nothing in the store').toBeUndefined()
      expect(h.store.remember).toBeUndefined()
      // The same situation again: it acts, with no question. Keep as the answer would stay if it were asked.
      expect(await prompt('t2', 'Keep as is')).toBe(a.want)
      expect(h.asked.length, 'not asked again this session').toBe(1)
      expect(h.sets.length, 'still no /config write').toBe(before)
    })
  }

  test(`the Haiku-start switch to Sonnet shows two options only: Run it on Sonnet or Stay on Haiku (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-haiku-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = '{"fit":{"haiku":"no","sonnet":"medium","opus":"medium","fable":"medium"},"type":"debug","read":8000,"write":1200,"steps":5,"continues":false,"reason":"rated"}'
    h.answers = { Stronger: 'Stay on Haiku' }
    await d.submit(DEBUG)
    expect(h.asked.map(x => x.header)).toEqual(['Stronger'])
    expect(h.asked[0]?.options).toEqual(['Run it on Sonnet', 'Stay on Haiku'])
  })

  test(`the Stronger ask under "ask each time" shows two options only: an each-time answer never becomes a rule (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...SONNET, store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    await d.config('upRule', 'ask each time')
    h.rating = REVIEW
    h.answers = { Stronger: 'Stay on Sonnet' }
    await d.submit(DEBUG)
    expect(h.asked.map(x => x.header)).toEqual(['Stronger'])
    expect(h.asked[0]?.options).toEqual(['Run it on Opus', 'Stay on Sonnet'])
  })

  // ---- Stuck: the main chat ----

  /** A turn that fails the same call twice at its first step: the first sign of being stuck. */
  const stuckTurn = async (d: ReturnType<typeof drive>, h: ReturnType<typeof engine>, turn: string, answer?: string) => {
    h.rating = NO_CHANGE
    if (answer) h.answers = { Stuck: answer }
    await d.submit(LOOKUP)
    await d.step(turn, 0)
    await d.bash('fail make')
    await d.bash('fail make')
    await d.step(turn, 1)
    await settle()
    await d.step(turn, 2)
    return last(h.sent)?.effort
  }
  /** A second sign in the same turn: a third failure among the last 10 calls. */
  const secondSign = async (d: ReturnType<typeof drive>, turn: string, from: number) => {
    await d.bash('fail make test')
    for (let i = 1; i <= 7; i++) await d.bash(`cat f${i}`)
    await d.step(turn, from)
    await settle()
    await d.step(turn, from + 1)
  }
  const start = async ($: unknown, on: Parameters<TestBody>[1], stored: Record<string, string> = {}) => {
    const h = engine(on, { ...OPUS, stored: { ...NO_COLD, ...stored } })
    const d = drive($, h)
    await d.start(surface)
    return { h, d }
  }

  test(`Stuck ask, Always raise when stuck: writes Raise when stuck as the settings pane does (raise automatically), and raises (${surface})`, { timeoutMs: 30000, options: { raiseRule: 'ask me' } }, async ($, on) => {
    const { h, d } = await start($, on, { raiseRule: 'ask me' })
    expect(await stuckTurn(d, h, 't1', 'Always raise when stuck')).toBe('high')
    expect(h.asked[0]?.options).toEqual(['Raise to high for this turn', 'Raise when stuck for this session', 'Keep medium', 'Always raise when stuck'])
    const wrote = written(h, 'escalation')
    expect(wrote.map(x => x.value)).toEqual(['raise automatically'])
    expect(h.stored.escalation).toBe('raise automatically')
    await d.config('escalation', 'follow Raising')
    await d.config('escalation', 'raise automatically')
    const pane = last(h.sets)
    expect({ key: wrote[0]?.key, value: wrote[0]?.value }).toEqual({ key: pane?.key, value: pane?.value })
    expect(h.store.choices, 'nothing goes to the store').toBeUndefined()
    // A new sign in the same turn raises again with no question; Raising itself is untouched.
    await secondSign(d, 't1', 3)
    expect(last(h.sent)?.effort).toBe('xhigh')
    expect(h.asked.length, 'asked once').toBe(1)
    expect(written(h, 'raiseRule')).toEqual([])
    await d.complete('t1')
    // The next turn raises with no question too.
    expect(await stuckTurn(d, h, 't2')).toBe('high')
    expect(h.asked.length).toBe(1)
  })

  test(`Stuck ask, Raise when stuck for this session: writes no row and nothing to the store, and the next sign raises without asking (${surface})`, { timeoutMs: 30000, options: { raiseRule: 'ask me' } }, async ($, on) => {
    const { h, d } = await start($, on, { raiseRule: 'ask me' })
    const before = h.sets.length
    expect(await stuckTurn(d, h, 't1', 'Raise when stuck for this session')).toBe('high')
    expect(h.asked.map(x => x.header)).toEqual(['Stuck'])
    expect(h.sets.length, 'no /config write').toBe(before)
    expect(h.store.choices, 'nothing in the store').toBeUndefined()
    await secondSign(d, 't1', 3)
    expect(last(h.sent)?.effort, 'a new sign, no question').toBe('xhigh')
    expect(h.asked.length).toBe(1)
    await d.complete('t1')
    expect(await stuckTurn(d, h, 't2')).toBe('high')
    expect(h.asked.length, 'the next turn too').toBe(1)
    expect(h.sets.length, 'still no /config write').toBe(before)
  })

  test(`Stuck ask, Raise to high for this turn: raises that turn only, and asks again at the next sign (${surface})`, { timeoutMs: 30000, options: { raiseRule: 'ask me' } }, async ($, on) => {
    const { h, d } = await start($, on, { raiseRule: 'ask me' })
    expect(await stuckTurn(d, h, 't1', 'Raise to high for this turn')).toBe('high')
    await d.complete('t1')
    await stuckTurn(d, h, 't2', 'Keep medium')
    expect(h.asked.map(x => x.header), 'asked again in the next turn').toEqual(['Stuck', 'Stuck'])
    expect(written(h, 'escalation')).toEqual([])
  })

  // ---- Stuck: a helper ----

  test(`Stuck ask for a helper, Always raise when stuck: writes the same row and raises the helper (${surface})`, { timeoutMs: 30000, options: { raiseRule: 'ask me', band: 'off' } }, async ($, on) => {
    const h = engine(on, { model: 'claude-fable-5-2', effort: 'high', stored: { ...NO_COLD, raiseRule: 'ask me', band: 'off' }, store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    await d.start(surface)
    h.subModel = 'claude-haiku-5-5'
    await d.step('t0')
    await d.complete('t0')
    h.rating = '{"fit":{"haiku":"low","sonnet":"low","opus":"low","fable":"low"},"type":"search","read":150000,"write":3000,"steps":30,"continues":false,"reason":"repo-wide search"}'
    await d.submit(SEARCH)
    await d.step('t1', 0)
    await d.agent('haiku')
    await d.spawn('helper', 'haiku')
    await d.step('t1', 0, 'agent-helper')
    h.answers = { Stuck: 'Always raise when stuck' }
    await d.bash('fail make', 'agent-helper')
    await d.bash('fail make', 'agent-helper')
    await d.step('t1', 1, 'agent-helper')
    expect(h.asked[0]?.options).toEqual(['Raise to medium', 'Raise when stuck for this session', 'Keep low', 'Always raise when stuck'])
    expect(written(h, 'escalation').map(x => ({ key: x.key, value: x.value }))).toEqual([{ key: 'rightsize.escalation', value: 'raise automatically' }])
    expect(log(h)).toContain('raised helper agent-helper low → medium')
  })

  // ---- Raise when stuck: follow Raising, ask me, raise automatically, off ----

  const rows: { name: string; stored: Record<string, string>; answer: string | undefined; asked: string[]; effort: string }[] = [
    { name: 'a stored "on" (from an older release) reads as follow Raising: Raising "ask me" asks', stored: { escalation: 'on', raiseRule: 'ask me' }, answer: 'Keep medium', asked: ['Stuck'], effort: 'medium' },
    { name: 'a stored "on" reads as follow Raising: Raising at its default (automatic) raises with no question', stored: { escalation: 'on' }, answer: undefined, asked: [], effort: 'high' },
    { name: 'follow Raising, Raising "never raise": no raise, no question', stored: { escalation: 'follow Raising', raiseRule: 'never raise' }, answer: undefined, asked: [], effort: 'medium' },
    { name: 'ask me asks on Stuck even when Raising is "raise automatically"', stored: { escalation: 'ask me', raiseRule: 'raise automatically' }, answer: 'Keep medium', asked: ['Stuck'], effort: 'medium' },
    { name: 'ask me, answered Raise: raises', stored: { escalation: 'ask me', raiseRule: 'raise automatically' }, answer: 'Raise to high for this turn', asked: ['Stuck'], effort: 'high' },
    { name: 'raise automatically raises with no question even when Raising is "ask me"', stored: { escalation: 'raise automatically', raiseRule: 'ask me' }, answer: undefined, asked: [], effort: 'high' },
    { name: 'raise automatically raises even when Raising is "never raise"', stored: { escalation: 'raise automatically', raiseRule: 'never raise' }, answer: undefined, asked: [], effort: 'high' },
    { name: 'off never raises, whatever Raising says', stored: { escalation: 'off', raiseRule: 'raise automatically' }, answer: undefined, asked: [], effort: 'medium' },
  ]
  for (const row of rows) {
    test(`Raise when stuck: ${row.name} (${surface})`, { timeoutMs: 30000, options: row.stored }, async ($, on) => {
      const { h, d } = await start($, on, row.stored)
      expect(await stuckTurn(d, h, 't1', row.answer)).toBe(row.effort)
      expect(h.asked.map(x => x.header)).toEqual(row.asked)
    })
  }

  test(`setting Raise when stuck in /config clears a "for this session" answer: the row is the person's word (${surface})`, { timeoutMs: 30000, options: { raiseRule: 'ask me' } }, async ($, on) => {
    const { h, d } = await start($, on, { raiseRule: 'ask me' })
    expect(await stuckTurn(d, h, 't1', 'Raise when stuck for this session')).toBe('high')
    await d.complete('t1')
    await d.config('escalation', 'follow Raising')
    h.answers = { Stuck: 'Keep medium' }
    expect(await stuckTurn(d, h, 't2')).toBe('medium')
    expect(h.asked.map(x => x.header), 'asked again').toEqual(['Stuck', 'Stuck'])
  })

  // ---- The retired Remember choices: what an older release kept moves to the rows, once ----

  test(`saved rules of an older release move to their rows where the row is "not set", and the store keys are cleared (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: { remember: true, choices: { lower: 'auto' } } })
    const d = drive($, h)
    await d.start(surface)
    expect(h.sets.filter(x => x.key === 'rightsize.lowerRule').map(x => x.value)).toEqual(['lower automatically'])
    expect(h.stored.lowerRule).toBe('lower automatically')
    expect(h.stored.raiseRule, 'a rule that was not kept stays not set').toBeUndefined()
    expect(h.store.remember, 'cleared').toBeNull()
    expect(h.store.choices, 'cleared').toBeNull()
    expect(log(h)).toContain('saved rules moved to their /config rows: Lowering: lower automatically')
    // The session follows the moved rule: lowering is automatic.
    h.rating = LOWER
    await d.submit(LOOKUP)
    await d.step('t1')
    expect(last(h.sent)?.effort).toBe('low')
    expect(h.asked).toEqual([])
  })

  test(`saved rules of an older release leave a row that is already set alone, and move the rest (${surface})`, { timeoutMs: 30000, options: { raiseRule: 'never raise' } }, async ($, on) => {
    const h = engine(on, { ...OPUS, stored: { raiseRule: 'never raise' }, store: { remember: true, choices: { lower: 'auto', raise: 'auto', up: 'ask' } } })
    const d = drive($, h)
    await d.start(surface)
    expect(h.stored.raiseRule, 'the row you set stays').toBe('never raise')
    expect(h.sets.filter(x => x.key === 'rightsize.raiseRule')).toEqual([])
    expect(h.stored.lowerRule).toBe('lower automatically')
    expect(h.stored.upRule).toBe('ask first')
    expect(h.store.remember).toBeNull()
    expect(h.store.choices).toBeNull()
  })

  test(`saved rules without the old yes are not moved, but the store keys are still cleared (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: { remember: false, choices: { lower: 'auto' } } })
    const d = drive($, h)
    await d.start(surface)
    expect(h.sets.filter(x => x.key === 'rightsize.lowerRule')).toEqual([])
    expect(h.stored.lowerRule).toBeUndefined()
    expect(h.store.remember).toBeNull()
    expect(h.store.choices).toBeNull()
  })
}
