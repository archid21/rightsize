import { type TestBody, expect, test } from 'claude-code/testing'
import { CAL_STORE } from './cost'
import { LOG_PATH, LOOKUP, DEBUG, REVIEW, NO_CHANGE, NO_COLD, FREE_SWITCHES, engine, drive, settle, last, LOWER } from './testkit'

// The runtime asks (Effort, Stronger, Subagent, Stuck) each end in two answers (P-81 step 3, ADR 0094): the recommended one and keep.
// "For this session" and "Always" are gone from them: step 4 brings back "Always do this" on the third same answer.
// Raise when stuck says what a stuck turn does (follow Raising, ask me, raise automatically, off).

for (const surface of ['desktop', 'terminal'] as const) {
  const OPUS = { model: 'claude-opus-5-5', effort: 'medium' }
  const SONNET = { model: 'claude-sonnet-5-5', effort: 'medium' }
  const log = (h: ReturnType<typeof engine>) => h.files[LOG_PATH] ?? ''
  /** Writes that rightsize itself made to a row (the settings pane's and the config hook's carry an origin). */
  const written = (h: ReturnType<typeof engine>, row: string) => h.sets.filter(x => x.key === `rightsize.${row}` && x.origin === undefined)

  // ---- Prompt-time asks: Effort, Stronger, Subagent (their wording is in register.ask.test.ts) ----

  test(`the Haiku-start switch to Sonnet shows two options only: Use Sonnet or Stay on Haiku (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-haiku-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = '{"fit":{"haiku":"no","sonnet":"medium","opus":"medium","fable":"medium"},"type":"debug","read":8000,"write":1200,"steps":5,"continues":false,"reason":"rated"}'
    h.answers = { Stronger: 'Stay on Haiku' }
    await d.submit(DEBUG)
    expect(h.asked.map(x => x.header)).toEqual(['Stronger'])
    expect(h.asked[0]?.options).toEqual(['Use Sonnet', 'Stay on Haiku'])
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
    expect(h.asked[0]?.options).toEqual(['Use Opus', 'Stay on Sonnet'])
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

  test(`Stuck ask, Raise effort: raises that turn only, and asks again at the next sign (${surface})`, { timeoutMs: 30000, options: { raiseRule: 'ask me' } }, async ($, on) => {
    const { h, d } = await start($, on, { raiseRule: 'ask me' })
    expect(await stuckTurn(d, h, 't1', 'Raise effort')).toBe('high')
    await d.complete('t1')
    await stuckTurn(d, h, 't2', 'Keep going')
    expect(h.asked.map(x => x.header), 'asked again in the next turn').toEqual(['Stuck', 'Stuck'])
    expect(written(h, 'escalation')).toEqual([])
  })

  // ---- Raise when stuck: follow Raising, ask me, raise automatically, off ----

  const rows: { name: string; stored: Record<string, string>; answer: string | undefined; asked: string[]; effort: string }[] = [
    { name: 'a stored "on" (from an older release) reads as follow Raising: Raising "ask me" asks', stored: { escalation: 'on', raiseRule: 'ask me' }, answer: 'Keep going', asked: ['Stuck'], effort: 'medium' },
    { name: 'a stored "on" reads as follow Raising: Raising at its default (automatic) raises with no question', stored: { escalation: 'on' }, answer: undefined, asked: [], effort: 'high' },
    { name: 'follow Raising, Raising "never raise": no raise, no question', stored: { escalation: 'follow Raising', raiseRule: 'never raise' }, answer: undefined, asked: [], effort: 'medium' },
    { name: 'ask me asks on Stuck even when Raising is "raise automatically"', stored: { escalation: 'ask me', raiseRule: 'raise automatically' }, answer: 'Keep going', asked: ['Stuck'], effort: 'medium' },
    { name: 'ask me, answered Raise: raises', stored: { escalation: 'ask me', raiseRule: 'raise automatically' }, answer: 'Raise effort', asked: ['Stuck'], effort: 'high' },
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
