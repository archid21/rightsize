import { expect, test } from 'claude-code/testing'
import { NO_CHANGE, RUNS_FILE, LOOKUP, NO_COLD, engine, drive } from './testkit'

// P-22 (ADR 0060): each run line stores what the turn's output was made of: output, thinking and tool-input (code written) tokens,
// their cost at prices.json prices, and the output's share of what the requests cost. /rightsize report reads them.

for (const surface of ['desktop', 'terminal'] as const) {
  const OPUS = { model: 'claude-opus-5-5', effort: 'medium', stored: NO_COLD }
  const USAGE = { input_tokens: 200, output_tokens: 1000, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 300 }
  /** 400 characters of text = 100 tokens. One tool call whose name and input come to 400 characters = 100 tokens. */
  const TOOL = [{ name: 'Write', input: { c: 'x'.repeat(387) } }]
  const near = (a: unknown, b: number) => Math.abs(Number(a) - b) < 1e-5
  type Line = Record<string, number | string | undefined>
  const runs = (h: ReturnType<typeof engine>) =>
    (h.files[RUNS_FILE] ?? '').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as Line).filter(l => l.kind === 'run')

  test(`a run line stores output, thinking and tool-input tokens, their cost and the output share (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, OPUS)
    const d = drive($, h)
    await d.start(surface)
    h.rating = NO_CHANGE
    h.stepUsage = USAGE
    h.stepAnswer = 'y'.repeat(400)
    h.stepToolUses = TOOL
    await d.submit(LOOKUP)
    await d.step('t1', 0)
    await d.step('t1', 1)
    await d.complete('t1')
    const line = runs(h)[0]
    expect(line, 'one run line').toBeDefined()
    // Two requests of 1000 output tokens each: 2000 in all, 200 text, 200 code written, 1600 thinking.
    expect(line).toMatchObject({ outputTokens: 2000, thinkingTokens: 1600, toolInputTokens: 200 })
    // Opus output is $20 per million: $0.04 for 2000 tokens, shared out by tokens.
    expect(near(line?.outputCost, 0.04), 'outputCost').toBe(true)
    expect(near(line?.thinkingCost, 0.032), 'thinkingCost').toBe(true)
    expect(near(line?.toolInputCost, 0.004), 'toolInputCost').toBe(true)
    expect(Number(line?.requestCost), 'the requests cost more than their output alone').toBeGreaterThan(Number(line?.outputCost))
    expect(near(line?.outputShare, Number(line?.outputCost) / Number(line?.requestCost)), 'outputShare').toBe(true)
    expect(Number(line?.outputShare)).toBeGreaterThan(0)
    expect(Number(line?.outputShare)).toBeLessThan(1)
  })

  test(`a helper's responses in the turn are counted too (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, OPUS)
    const d = drive($, h)
    await d.start(surface)
    h.rating = NO_CHANGE
    h.stepUsage = USAGE
    await d.submit(LOOKUP)
    await d.step('t1', 0)
    await d.spawn('lister')
    await d.step('l1', 0, 'agent-lister')
    await d.answer('agent-lister')
    await d.complete('t1')
    const line = runs(h)[0]
    // One main request and one helper request, no text and no tool calls: all thinking.
    expect(line).toMatchObject({ outputTokens: 2000, thinkingTokens: 2000, toolInputTokens: 0 })
  })

  test(`the report shows the output line from those run lines (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, OPUS)
    // The run line is stamped with the real time, so the report's period must be the real one.
    h.now = Date.now()
    const d = drive($, h)
    await d.start(surface)
    h.rating = NO_CHANGE
    h.stepUsage = USAGE
    h.stepAnswer = 'y'.repeat(400)
    h.stepToolUses = TOOL
    await d.submit(LOOKUP)
    await d.step('t1', 0)
    await d.complete('t1')
    const text = await d.report()
    expect(text).toMatch(/Output was (\d+)% of cost: (\d+)% thinking, (\d+)% text, (\d+)% code written\.\s+Thinking\s+leads: the Lowest effort and Highest effort rows control it\./)
    const [, whole, ...parts] = /Output was (\d+)% of cost: (\d+)% thinking, (\d+)% text, (\d+)% code written/.exec(text) ?? []
    expect(Number(whole), 'the total is the sum of the parts').toBe(parts.reduce((n, p) => n + Number(p), 0))
    // Of the output, 80% is thinking and 10% each text and code written.
    expect(Number(parts[0])).toBeGreaterThan(Number(parts[1]) * 4)
    expect(text, 'every turn was measured: no count').not.toContain('turns measured')
  })

  test(`a log from before the split shows no output line (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, OPUS)
    h.now = Date.now()
    const d = drive($, h)
    await d.start(surface)
    h.files[RUNS_FILE] = `${JSON.stringify({ at: new Date(h.now - 3600_000).toISOString(), kind: 'run', session: 'old', type: 'lookup', route: 'main', change: 'none', actual: 0.05, stay: 0.05, taken: 0.05, overhead: 0 })}\n`
    const text = await d.report()
    expect(text, 'the old run is counted').toContain('WHAT RIGHTSIZE DID')
    expect(text).not.toContain('Output was')
  })
}
