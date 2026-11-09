import { type TestBody, expect, test } from 'claude-code/testing'
import { BIG_TURN, LOG_PATH, RUNS_FILE, drive, engine, flush } from './testkit'

// In-turn keep warm (ADR 0029): on a cache under 1 hour, a main-chat tool call that outlasts the cache is covered by
// keep-warm requests, counted from the main chat's last request, and only when that request ended in a tool result.

const MIN = 60_000
const EVENING = new Date(2027, 0, 15, 18, 0, 0, 0).getTime()
const BIG = { ...BIG_TURN, cache_read_input_tokens: 150_000 }
const logOf = (h: ReturnType<typeof engine>) => h.files[LOG_PATH] ?? ''
const savedLines = (h: ReturnType<typeof engine>) => (h.files[RUNS_FILE] ?? '').split('\n').filter(l => l.includes('"warmSaved"')).length

type Over = { env?: Record<string, string>; usage?: typeof BIG_TURN; beforeCold?: string }
// API billing (the kit's spend limit): the first turn's end shows it, and the cache is 5 minutes from then.
const session = async ($: unknown, on: Parameters<TestBody>[1], over: Over = {}) => {
  const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', stored: { beforeCold: over.beforeCold ?? 'ask' } })
  h.env = over.env ?? {}
  h.now = EVENING
  h.virtual = true
  h.commands = []
  h.stepUsage = over.usage ?? BIG
  h.forkUsage = { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 150_000, cache_creation_input_tokens: 0 }
  const d = drive($, h)
  await d.start('terminal')
  await d.step('t1')
  await d.complete('t1')
  return { h, d }
}
/** Starts turn t2 with `requests` main requests, then a foreground Bash call that runs until `end()`. */
const slowCall = async (h: ReturnType<typeof engine>, d: ReturnType<typeof drive>, requests: number) => {
  let release = () => {}
  h.toolGate = new Promise<void>(resolve => {
    release = resolve
  })
  await d.turnStart('t2', '')
  for (let i = 0; i < requests; i++) await d.step('t2', i)
  const before = h.forks.length
  const call = d.bash('slow test run')
  await flush()
  return {
    sent: () => h.forks.length - before,
    end: async () => {
      release()
      await call
    },
  }
}

test('a tool call that outlasts a 5-minute cache is kept warm every 4 minutes, and the next request counts the saving', { timeoutMs: 30000 }, async ($, on) => {
  const { h, d } = await session($, on)
  const call = await slowCall(h, d, 2)
  await h.advance(3 * MIN)
  expect(call.sent(), 'nothing before 4 minutes').toBe(0)
  await h.advance(6 * MIN)
  expect(call.sent(), 'requests at 4 and 8 minutes').toBe(2)
  await call.end()
  await h.advance(10 * MIN)
  expect(call.sent(), 'none after the call ended').toBe(2)
  expect(logOf(h)).toContain('in-turn keep warm: a tool call has run 4 min; keeping 151K tokens warm')
  expect(logOf(h)).toContain('in-turn keep warm ended (the tool call ended): 2 pings')
  await d.step('t2', 2)
  expect(logOf(h)).toContain('keep warm: the cache held on return')
  expect(savedLines(h)).toBe(1)
})

test('the first tool call of a turn is not kept warm: the last user message is the person’s text', { timeoutMs: 30000 }, async ($, on) => {
  const { h, d } = await session($, on)
  const call = await slowCall(h, d, 1)
  await h.advance(12 * MIN)
  expect(call.sent()).toBe(0)
  await call.end()
})

test('a 1-hour cache is left alone', { timeoutMs: 30000 }, async ($, on) => {
  const { h, d } = await session($, on, { env: { CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' } })
  const call = await slowCall(h, d, 2)
  await h.advance(12 * MIN)
  expect(call.sent()).toBe(0)
  await call.end()
})

test('a conversation that costs less than the size bar to come back cold is left alone', { timeoutMs: 30000 }, async ($, on) => {
  const { h, d } = await session($, on, { usage: BIG_TURN })
  const call = await slowCall(h, d, 2)
  await h.advance(12 * MIN)
  expect(call.sent()).toBe(0)
  await call.end()
})

test('Before the cache goes cold = off: no in-turn requests', { timeoutMs: 30000, options: { beforeCold: 'off' } }, async ($, on) => {
  const { h, d } = await session($, on, { beforeCold: 'off' })
  const call = await slowCall(h, d, 2)
  await h.advance(12 * MIN)
  expect(call.sent()).toBe(0)
  await call.end()
})

test('a call that ends inside the cache’s first life counts no saving', { timeoutMs: 30000 }, async ($, on) => {
  const { h, d } = await session($, on)
  const call = await slowCall(h, d, 2)
  await h.advance(4 * MIN + 30_000)
  expect(call.sent()).toBe(1)
  await call.end()
  await d.step('t2', 2)
  expect(savedLines(h)).toBe(0)
})

test('the requests stop where they have cost as much as the cold request they avoid', { timeoutMs: 30000 }, async ($, on) => {
  const { h, d } = await session($, on)
  // A request that wrote the conversation again: the fork missed the cache.
  h.forkUsage = { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 150_000 }
  const call = await slowCall(h, d, 2)
  await h.advance(20 * MIN)
  expect(call.sent()).toBe(1)
  expect(logOf(h)).toContain('in-turn keep warm stopped:')
  await call.end()
})
