import { type TestBody, expect, test } from 'claude-code/testing'
import { LOG_PATH, NO_COLD, engine, drive, settle } from './testkit'

// ADR 0050: at a main turn's end, when output is at least 25% of the session's cost at list prices, after 20 main-chat requests and $1.00,
// rightsize asks once whether to use Claude Code's Concise output style. "This session" sets it and puts it back when the session ends;
// "This project" sets it and leaves it; "Not now" writes nothing. The settings row Output suggestion turns the question off.

for (const surface of ['desktop', 'terminal'] as const) {
  const OPUS = { model: 'claude-opus-5-5', effort: 'medium' }
  const RESTORE = 'outputRestore'
  /** Opus list prices: output $20 per million, cache write $8, cache read $0.20, input $4. About 38% of a request's cost is output. */
  const HEAVY = { input_tokens: 200, output_tokens: 5000, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 20_000 }
  /** About 11% output, and $0.18 a request: over $1 in 20 requests, under the share. */
  const LOW_SHARE = { input_tokens: 200, output_tokens: 1000, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 20_000 }
  /** All output, $0.02 a request: under $1 in 20 requests. */
  const CHEAP = { input_tokens: 10, output_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  const log = (h: ReturnType<typeof engine>) => h.files[LOG_PATH] ?? ''
  const outputWrites = (h: ReturnType<typeof engine>) => h.sets.filter(x => x.key === 'outputStyle')
  const asks = (h: ReturnType<typeof engine>) => h.asked.filter(a => a.header === 'Output')

  /** A started session; `n` main-chat requests in one turn with this usage, and the turn ends. */
  const begin = async ($: unknown, on: Parameters<TestBody>[1], over: { stored?: Record<string, string>; surface?: string } = {}) => {
    const h = engine(on, { ...OPUS, stored: { ...NO_COLD, ...(over.stored ?? {}) } })
    const d = drive($, h)
    await d.start(over.surface ?? surface)
    let n = 0
    const turn = async (requests: number, usage: typeof HEAVY, agentId?: string) => {
      h.stepUsage = usage
      const id = `t${++n}`
      for (let i = 0; i < requests; i++) await d.step(id, i, agentId)
      await d.complete(id)
      await settle()
    }
    return { h, d, turn }
  }

  test(`the ask: header Output, the measured share, the hint, and three answers (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, turn } = await begin($, on)
    h.answers = { Output: 'Not now' }
    await turn(20, HEAVY)
    expect(asks(h).length, 'asked once').toBe(1)
    const a = asks(h)[0]
    expect(a?.options).toEqual(['This session', 'This project', 'Not now'])
    const share = Number(/Output is about (\d+)% of this session's cost\./.exec(a?.question ?? '')?.[1])
    expect(share, 'the share comes from the measured cost').toBeGreaterThan(30)
    expect(share).toBeLessThan(45)
    expect(a?.question).toContain('To use it in every project, set Output style to Concise in your Claude settings.')
    expect(a?.question).toContain('Use the Concise output style?')
    expect(a?.question, 'no promised saving').not.toMatch(/sav/i)
  })

  test(`"This session" sets outputStyle to Concise, keeps the old value, and puts it back when the session ends (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d, turn } = await begin($, on)
    h.outputStyle = { value: 'Explanatory', options: ['default', 'Explanatory', 'Learning', 'Concise'], isLocked: false }
    h.answers = { Output: 'This session' }
    await turn(20, HEAVY)
    expect(outputWrites(h).map(x => x.value)).toEqual(['Concise'])
    expect(outputWrites(h)[0]?.key).toBe('outputStyle')
    expect(h.outputStyle?.value).toBe('Concise')
    expect(h.store[RESTORE], 'the old value waits in the store').toMatchObject({ previous: 'Explanatory' })
    await turn(20, HEAVY)
    expect(asks(h).length, 'not asked again').toBe(1)
    await d.end()
    expect(outputWrites(h).map(x => x.value), 'put back').toEqual(['Concise', 'Explanatory'])
    expect(h.outputStyle?.value).toBe('Explanatory')
    expect(h.store[RESTORE], 'the note is cleared').toBeNull()
  })

  test(`"This session": a style changed meanwhile is not overwritten at the end (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d, turn } = await begin($, on)
    h.answers = { Output: 'This session' }
    await turn(20, HEAVY)
    h.outputStyle!.value = 'Learning'
    await d.end()
    expect(outputWrites(h).map(x => x.value), 'no write at the end').toEqual(['Concise'])
    expect(h.outputStyle?.value).toBe('Learning')
    expect(h.store[RESTORE], 'cleared all the same').toBeNull()
    expect(log(h)).toContain('not put back')
  })

  test(`"This session": a session that never ended puts the style back at the next start, in the same project only (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d, turn } = await begin($, on)
    h.answers = { Output: 'This session' }
    await turn(20, HEAVY)
    expect(h.outputStyle?.value).toBe('Concise')
    // Another project's start leaves it alone.
    const here = h.cwd
    h.cwd = '/other/project'
    await d.start(surface)
    expect(outputWrites(h).map(x => x.value)).toEqual(['Concise'])
    expect(h.store[RESTORE], 'kept for its own project').not.toBeNull()
    // The crashed session's project starts again: put back.
    h.cwd = here
    await d.start(surface)
    expect(outputWrites(h).map(x => x.value)).toEqual(['Concise', 'default'])
    expect(h.outputStyle?.value).toBe('default')
    expect(h.store[RESTORE]).toBeNull()
  })

  test(`"This session": at the next start, a style changed meanwhile is not overwritten (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d, turn } = await begin($, on)
    h.answers = { Output: 'This session' }
    await turn(20, HEAVY)
    h.outputStyle!.value = 'Learning'
    await d.start(surface)
    expect(outputWrites(h).map(x => x.value)).toEqual(['Concise'])
    expect(h.outputStyle?.value).toBe('Learning')
    expect(h.store[RESTORE]).toBeNull()
  })

  test(`"This project" sets outputStyle to Concise and leaves it (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d, turn } = await begin($, on)
    h.answers = { Output: 'This project' }
    await turn(20, HEAVY)
    expect(outputWrites(h)).toMatchObject([{ key: 'outputStyle', value: 'Concise' }])
    expect(h.store[RESTORE], 'nothing to put back').toBeUndefined()
    await d.end()
    await d.start(surface)
    expect(outputWrites(h).length, 'still just the one write').toBe(1)
    expect(h.outputStyle?.value).toBe('Concise')
  })

  test(`"Not now" writes nothing and does not ask again this session (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, turn } = await begin($, on)
    h.answers = { Output: 'Not now' }
    await turn(20, HEAVY)
    await turn(20, HEAVY)
    expect(asks(h).length).toBe(1)
    expect(outputWrites(h)).toEqual([])
    expect(h.store[RESTORE]).toBeUndefined()
  })

  test(`a dismissed question writes nothing and is not asked again (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, turn } = await begin($, on)
    h.answers = {}
    await turn(20, HEAVY)
    await turn(20, HEAVY)
    expect(asks(h).length).toBe(1)
    expect(outputWrites(h)).toEqual([])
  })

  test(`a policy that overrides the style: the write is not claimed, and nothing is left to put back (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d, turn } = await begin($, on)
    h.outputPinned = 'default'
    h.answers = { Output: 'This session' }
    await turn(20, HEAVY)
    expect(log(h)).toContain('not applied (another source sets it)')
    expect(log(h)).not.toContain('Concise for this session')
    expect(h.store[RESTORE]).toBeNull()
    await d.end()
    expect(outputWrites(h).length, 'no restore write').toBe(1)
  })

  test(`new session after the ask: the totals and the ask start over (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d, turn } = await begin($, on)
    h.answers = { Output: 'Not now' }
    await turn(20, HEAVY)
    await d.start(surface)
    await turn(19, HEAVY)
    expect(asks(h).length, 'the new session has 19 requests: not yet').toBe(1)
    await turn(1, HEAVY)
    expect(asks(h).length, 'the 20th asks again, for the new session').toBe(2)
  })

  // ---- No ask ----

  const never = (name: string, usage: typeof HEAVY, requests: number, prep: (h: ReturnType<typeof engine>) => void = () => undefined, over: { stored?: Record<string, string> } = {}, options: Record<string, string> = {}) =>
    test(`no ask ${name} (${surface})`, { timeoutMs: 30000, options }, async ($, on) => {
      const { h, turn } = await begin($, on, over)
      prep(h)
      h.answers = { Output: 'This project' }
      await turn(requests, usage)
      await turn(requests, usage)
      expect(asks(h)).toEqual([])
      expect(outputWrites(h)).toEqual([])
    })
  never('below a 25% output share', LOW_SHARE, 25)
  never('under 20 main-chat requests', HEAVY, 9)
  never('under $1.00 at list prices', CHEAP, 20)
  never('when the style is already Concise', HEAVY, 20, h => void (h.outputStyle = { value: 'Concise', options: ['default', 'Concise'], isLocked: false }))
  never('when the row is missing', HEAVY, 20, h => void (h.outputStyle = undefined))
  never('when the row is locked', HEAVY, 20, h => void (h.outputStyle = { value: 'default', options: ['default', 'Concise'], isLocked: true }))
  never('when the row has no Concise option', HEAVY, 20, h => void (h.outputStyle = { value: 'default', options: ['default', 'Explanatory'], isLocked: false }))
  never('when Output suggestion is off', HEAVY, 20, undefined, { stored: { outputAdvice: 'off' } }, { outputAdvice: 'off' })

  test(`no ask from subagent requests: only the main chat counts (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, turn } = await begin($, on)
    h.answers = { Output: 'This project' }
    await turn(25, HEAVY, 'agent-helper')
    await turn(5, HEAVY)
    expect(asks(h)).toEqual([])
  })

  test(`the bars are exactly 20 requests: the 20th asks, the 19th does not (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, turn } = await begin($, on)
    h.answers = { Output: 'Not now' }
    await turn(10, HEAVY)
    await turn(9, HEAVY)
    expect(asks(h)).toEqual([])
    await turn(1, HEAVY)
    expect(asks(h).length).toBe(1)
  })

  test(`watch only: it logs what it would suggest and asks nothing (${surface})`, { timeoutMs: 30000, options: { mode: 'watch only' } }, async ($, on) => {
    const { h, turn } = await begin($, on, { stored: { mode: 'watch only' } })
    h.answers = { Output: 'This project' }
    await turn(20, HEAVY)
    expect(asks(h)).toEqual([])
    expect(outputWrites(h)).toEqual([])
    expect(log(h)).toContain('would suggest the Concise output style')
  })
}

test('on a surface with no band (the mobile app) the question comes in the dialog, and answers the same way', { timeoutMs: 30000 }, async ($, on) => {
  const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', stored: { ...NO_COLD } })
  const d = drive($, h)
  await d.start('mobile')
  h.stepUsage = { input_tokens: 200, output_tokens: 5000, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 20_000 }
  h.answers = { Output: 'This project' }
  for (let i = 0; i < 20; i++) await d.step('t1', i)
  await d.complete('t1')
  await settle()
  expect(h.asked.filter(a => a.header === 'Output').length).toBe(1)
  expect(h.asked.find(a => a.header === 'Output')?.question).toContain('No answer in 30 seconds: the output style is unchanged.')
  expect(h.sets.filter(x => x.key === 'outputStyle')).toMatchObject([{ value: 'Concise' }])
})
