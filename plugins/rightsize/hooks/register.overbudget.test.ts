import { type TestBody, expect, test } from 'claude-code/testing'
import { REESTIMATE_AFTER } from './cost'
import { LOG_PATH, NO_COLD, NO_ONE, RUNS_FILE, bandText, drive, engine, mount, settle } from './testkit'

// Over budget (P-82, ADR 0094): Finish up on the during-turn Big-turn row acts. rightsize refuses every tool call of that turn with
// "Budget reached: stop here and report what is done and what is left.", so Claude ends with a report. The mark ends with the turn or the
// next prompt. The Advanced row "Over budget, no answer" (overBudget) says what no answer to that row does: Keep going (default) or Finish
// up, which arms after the Question wait (a timer; the band row never holds the turn).

const REASON = 'Budget reached: stop here and report what is done and what is left.'
/** A small job by estimate, but rated for 40 steps: each request that costs $0.03 projects to about $1.30, over a $1 amount. */
const LONG = '{"level":"high","model":"same","size":"small","type":"feature","read":5000,"write":2000,"steps":40,"reason":"long but light"}'
const PROMPT = 'implement the whole thing across the app'
const COSTLY_STEP = { input_tokens: 200, output_tokens: 3000, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 300 }
const DURING = 'Big turn now'
const HELPER = 'agent-helper'
const WAIT = 30_000

const logOf = (h: ReturnType<typeof engine>) => h.files[LOG_PATH] ?? ''
const runLine = (h: ReturnType<typeof engine>) =>
  (h.files[RUNS_FILE] ?? '')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as { kind?: string; overBudget?: { how: string; denied: number } })
    .find(l => (l.kind ?? 'run') === 'run')
const asked = (h: ReturnType<typeof engine>, header: string) => h.asked.filter(x => x.header === header)
const denied = (r: unknown) => (r as { deny?: string }).deny

for (const surface of ['desktop', 'terminal'] as const) {
  /** A session with the Big-turn warning at $1 and, optionally, the Over budget row set the way the person sets it in /config. */
  const session = async ($: unknown, on: Parameters<TestBody>[1], row?: string, virtual = false) => {
    const h = engine(on, { model: 'claude-sonnet-5-5', effort: 'high', stored: { ...NO_COLD } })
    h.stepUsage = COSTLY_STEP
    h.virtual = virtual
    const d = drive($, h)
    await d.start(surface)
    await d.config('bigTurn', '$1')
    if (row) await d.config('overBudget', row)
    return { h, d }
  }
  /** One main-chat request of turn `id` after another, the band's answers getting a moment after each. */
  const steps = async (d: ReturnType<typeof drive>, id: string, to: number, from = 0) => {
    for (let i = from; i < to; i++) {
      await d.step(id, i)
      await settle()
    }
  }
  /** The prompt, and requests until the during-turn row has shown (and been answered, if an answer is set). */
  const toRow = async (h: ReturnType<typeof engine>, d: ReturnType<typeof drive>, answer: string) => {
    h.answers[DURING] = answer
    h.rating = LONG
    await d.submit(PROMPT)
    await steps(d, 't1', REESTIMATE_AFTER)
    expect(asked(h, DURING).length, 'the row showed').toBe(1)
  }

  test(`Finish up refuses the next main-chat tool call with the report reason, and a helper's calls after it (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on)
    h.rating = LONG
    await d.submit(PROMPT)
    await steps(d, 't1', REESTIMATE_AFTER - 1)
    expect(denied(await d.bash('echo before')), 'before the row nothing is refused').toBeUndefined()
    h.answers[DURING] = 'Finish up'
    await steps(d, 't1', REESTIMATE_AFTER, REESTIMATE_AFTER - 1)
    expect(denied(await d.bash('echo one'))).toBe(REASON)
    expect(denied(await d.bash('echo two'))).toBe(REASON)
    expect(denied(await d.agent('sonnet')), 'every tool, not only Bash').toBe(REASON)
    expect(denied(await d.bash('echo helper', HELPER)), 'a helper is refused on its next call').toBe(REASON)
    expect(denied(await d.handback(HELPER)), 'its report still gets through').toBeUndefined()
    // Requests still go out: Claude's own turn goes on, to write its report.
    await steps(d, 't1', REESTIMATE_AFTER + 2, REESTIMATE_AFTER)
    expect(h.sent.length).toBe(REESTIMATE_AFTER + 2)
    await d.complete('t1')
    await settle()
    const lines = logOf(h).split('\n').filter(l => l.includes('over budget:'))
    expect(lines.length, 'one line when it arms').toBe(1)
    expect(lines[0]).toContain('you pressed Finish up')
    expect(runLine(h)?.overBudget).toEqual({ how: 'finish', denied: 4 })
  })

  test(`Finish up no longer puts a message in the prompt box (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on)
    h.draft = 'and also the docs'
    await toRow(h, d, 'Finish up')
    expect(h.fills, 'nothing drafted').toEqual([])
    expect(h.draft).toBe('and also the docs')
    expect(await bandText($, surface)).not.toContain('prompt box')
    expect(h.submitted.length, 'nothing sent').toBe(1)
    expect(asked(h, DURING)[0]?.question).toContain('Finish up ends this turn with a report')
    expect(logOf(h)).not.toContain('the message is in the prompt box')
    await d.complete('t1')
  })

  test(`the mark ends with the turn: the next turn's tool calls go through (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on)
    await toRow(h, d, 'Finish up')
    expect(denied(await d.bash('echo in the turn'))).toBe(REASON)
    await d.complete('t1')
    await settle()
    h.rating = '{"level":"high","model":"same","size":"small","type":"lookup","read":2000,"write":300,"steps":2,"reason":"small"}'
    await d.submit('next thing')
    await d.step('t2', 0)
    expect(denied(await d.bash('echo next turn'))).toBeUndefined()
    await d.complete('t2')
  })

  test(`the mark ends when the next prompt is sent, even into the running turn (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on)
    await toRow(h, d, 'Finish up')
    expect(denied(await d.bash('echo one'))).toBe(REASON)
    await d.submit('go on with the docs too', 't1')
    expect(denied(await d.bash('echo two')), 'the person spoke: the turn works again').toBeUndefined()
    await d.complete('t1')
  })

  test(`no answer with the row at its default (Keep going): nothing is refused, however long it waits (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on, undefined, true)
    await toRow(h, d, NO_ONE)
    expect(asked(h, DURING)[0]?.question, 'no sentence about finishing up by itself').not.toContain('No answer:')
    await h.advance(10 * 60_000)
    expect(denied(await d.bash('echo late'))).toBeUndefined()
    expect(logOf(h)).not.toContain('over budget:')
    await d.complete('t1')
    await settle()
    expect(runLine(h)?.overBudget).toBeUndefined()
  })

  test(`no answer with the row at Finish up: nothing before the Question wait, a refusal after it, from a timer (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on, 'Finish up', true)
    await toRow(h, d, NO_ONE)
    expect(asked(h, DURING)[0]?.question, 'the band says what no answer does').toContain('No answer: Finish up after 30 seconds.')
    expect(h.afters, 'a timer, not a block').toContain(WAIT)
    expect(h.sleeps).not.toContain(WAIT)
    await h.advance(WAIT - 5000)
    expect(denied(await d.bash('echo early')), 'not before the wait is out').toBeUndefined()
    await h.advance(6000)
    expect(denied(await d.bash('echo after'))).toBe(REASON)
    expect(denied(await d.bash('echo helper', HELPER))).toBe(REASON)
    expect(logOf(h)).toMatch(/over budget: no answer in 30 seconds/)
    await d.complete('t1')
    await settle()
    expect(runLine(h)?.overBudget).toEqual({ how: 'no answer', denied: 2 })
  })

  test(`with the row at Finish up, an answer of Keep going before the wait is out arms nothing (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on, 'Finish up', true)
    await toRow(h, d, 'Keep going')
    await h.advance(2 * WAIT)
    expect(denied(await d.bash('echo late'))).toBeUndefined()
    expect(logOf(h)).not.toContain('over budget:')
    await d.complete('t1')
  })

  test(`with the row at Finish up, a turn that ends before the wait is out arms nothing for the next one (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on, 'Finish up', true)
    await toRow(h, d, NO_ONE)
    await d.complete('t1')
    await settle()
    h.rating = '{"level":"high","model":"same","size":"small","type":"lookup","read":2000,"write":300,"steps":2,"reason":"small"}'
    await d.submit('next thing')
    await d.step('t2', 0)
    await h.advance(2 * WAIT)
    expect(denied(await d.bash('echo next turn'))).toBeUndefined()
    expect(logOf(h)).not.toContain('over budget:')
    await d.complete('t2')
  })

  test(`Keep going pressed after the no-answer Finish up armed lifts the refusal (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on, 'Finish up', true)
    await toRow(h, d, NO_ONE)
    await h.advance(WAIT + 1000)
    expect(denied(await d.bash('echo armed'))).toBe(REASON)
    h.answers[DURING] = 'Keep going'
    const ui = await mount($, surface)
    await ui.press({ key: 'q-0' })
    await ui.unmount()
    await settle()
    expect(denied(await d.bash('echo lifted'))).toBeUndefined()
    await d.complete('t1')
  })

  for (const row of [undefined, 'Finish up']) {
    test(`Keep going (pressed${row ? ', row at Finish up' : ''}): no second over-budget row in the same turn (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
      const { h, d } = await session($, on, row)
      await toRow(h, d, 'Keep going')
      await steps(d, 't1', REESTIMATE_AFTER + 12, REESTIMATE_AFTER)
      expect(asked(h, DURING).length, 'still one row').toBe(1)
      expect(denied(await d.bash('echo on'))).toBeUndefined()
      await d.complete('t1')
    })
  }

  test(`Keep going by default: no second over-budget row in the same turn (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on)
    await toRow(h, d, NO_ONE)
    await steps(d, 't1', REESTIMATE_AFTER + 12, REESTIMATE_AFTER)
    expect(asked(h, DURING).length, 'still one row').toBe(1)
    await d.complete('t1')
  })

  test(`a turn that never reaches the amount is never refused anything, with the row at Finish up (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on, 'Finish up', true)
    h.rating = '{"level":"high","model":"same","size":"small","type":"lookup","read":2000,"write":300,"steps":2,"reason":"small"}'
    await d.submit(PROMPT)
    await steps(d, 't1', REESTIMATE_AFTER + 2)
    await h.advance(2 * WAIT)
    expect(denied(await d.bash('echo fine'))).toBeUndefined()
    expect(asked(h, DURING)).toEqual([])
    await d.complete('t1')
  })
}
