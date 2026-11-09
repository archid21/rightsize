import { type TestBody, expect, test } from 'claude-code/testing'
import { BIG_TURN, LOG_PATH, drive, engine } from './testkit'

// The cache's life (its TTL) is read the way Claude Code decides it: FORCE_PROMPT_CACHING_5M, the bucket's variable, the
// bucket's setting, ENABLE_PROMPT_CACHING_1H, prices.json, then the billing (1 hour on a subscription within its plan, 5
// minutes on API billing or usage credits). Helpers, Claude's subagents and forks are their own bucket: 5 minutes by default.

const MIN = 60_000
const EVENING = new Date(2027, 0, 15, 18, 0, 0, 0).getTime()
const KEEP_WARM = { beforeCold: 'keep warm 2 h' }
const SUB = [{ kind: 'five_hour', percentUsed: 10 }]
const logOf = (h: ReturnType<typeof engine>) => h.files[LOG_PATH] ?? ''
const statusOf = async (d: ReturnType<typeof drive>) => (await d.command('status')).text ?? ''

type Over = { env?: Record<string, string>; settings?: Record<string, unknown>; rateLimits?: { kind: string; percentUsed: number }[]; prices?: string; usage?: typeof BIG_TURN }
const session = async ($: unknown, on: Parameters<TestBody>[1], over: Over = {}) => {
  const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', stored: KEEP_WARM })
  h.env = over.env ?? {}
  h.settings = over.settings ?? {}
  if (over.rateLimits) h.rateLimits = over.rateLimits
  if (over.prices !== undefined) h.pricesFile = over.prices
  h.now = EVENING
  h.virtual = true
  h.commands = []
  h.stepUsage = over.usage ?? BIG_TURN
  const d = drive($, h)
  await d.start('terminal')
  return { h, d }
}
const turn = async (d: ReturnType<typeof drive>, id: string) => {
  await d.step(id)
  await d.complete(id)
}

test('API billing: 5 minutes for the main conversation and for helpers, so keep warm pings every 4 minutes', { timeoutMs: 30000, options: KEEP_WARM }, async ($, on) => {
  // 150,500 tokens: on a 5-minute cache BIG_TURN's 80,500 cost less to come back cold than the row's size bar.
  const { h, d } = await session($, on, { usage: { ...BIG_TURN, cache_read_input_tokens: 150_000 } })
  await turn(d, 't1')
  expect(logOf(h), 'logged once the first response shows the gateway spend limit').toContain('cache life: 5 minutes (API billing); helpers and forks 5 minutes (default)')
  expect(await statusOf(d)).toContain('Cache life: 5 minutes (API billing) · helpers and forks 5 minutes (default)')
  await h.advance(10 * MIN)
  expect(h.forks.length, 'pings at 4 and 8 minutes').toBe(2)
})

test('a subscription within its plan: 1 hour for the main conversation, 5 minutes for helpers', { timeoutMs: 30000, options: KEEP_WARM }, async ($, on) => {
  const { h, d } = await session($, on, { rateLimits: SUB })
  await turn(d, 't1')
  expect(logOf(h)).toContain('cache life: 1 hour (a subscription within its plan); helpers and forks 5 minutes (default)')
  await h.advance(10 * MIN)
  expect(h.forks.length, 'no ping before 57 minutes').toBe(0)
  await h.advance(50 * MIN)
  expect(h.forks.length).toBe(1)
})

test('a subscription past its window is on usage credits: 5 minutes from the next turn', { timeoutMs: 30000 }, async ($, on) => {
  const { h, d } = await session($, on, { rateLimits: SUB })
  await turn(d, 't1')
  expect(logOf(h)).toContain('cache life: 1 hour (a subscription within its plan)')
  h.rateLimits = [{ kind: 'five_hour', percentUsed: 100 }]
  await turn(d, 't2')
  expect(logOf(h)).toContain('cache life: 5 minutes (a subscription on usage credits); helpers and forks 5 minutes (default)')
})

test('FORCE_PROMPT_CACHING_5M beats the variable and the billing, for both buckets', { timeoutMs: 30000 }, async ($, on) => {
  const { h, d } = await session($, on, { rateLimits: SUB, env: { FORCE_PROMPT_CACHING_5M: '1', CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' } })
  await turn(d, 't1')
  expect(logOf(h)).toContain('cache life: 5 minutes (FORCE_PROMPT_CACHING_5M); helpers and forks 5 minutes (FORCE_PROMPT_CACHING_5M)')
})

test('the settings give an API key the hour, for both buckets', { timeoutMs: 30000 }, async ($, on) => {
  const { h, d } = await session($, on, { settings: { promptCacheTtl: '1h', subagentPromptCacheTtl: '1h' } })
  await turn(d, 't1')
  expect(logOf(h)).not.toContain('cache life: 5 minutes')
  expect(await statusOf(d)).toContain('Cache life: 1 hour (the promptCacheTtl setting) · helpers and forks 1 hour (the subagentPromptCacheTtl setting)')
})

test('ENABLE_PROMPT_CACHING_1H gives both buckets the hour', { timeoutMs: 30000 }, async ($, on) => {
  const { d } = await session($, on, { env: { ENABLE_PROMPT_CACHING_1H: '1' } })
  expect(await statusOf(d)).toContain('Cache life: 1 hour (ENABLE_PROMPT_CACHING_1H) · helpers and forks 1 hour (ENABLE_PROMPT_CACHING_1H)')
})

test('prices.json speaks for a gateway rightsize cannot read; helpers stay at 5 minutes', { timeoutMs: 30000 }, async ($, on) => {
  const { d } = await session($, on, { prices: '{"cacheTtl":"1h"}' })
  expect(await statusOf(d)).toContain('Cache life: 1 hour (prices.json) · helpers and forks 5 minutes (default)')
})
