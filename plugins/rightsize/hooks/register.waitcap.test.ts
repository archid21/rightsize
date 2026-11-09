import { type TestBody, expect, test } from 'claude-code/testing'
import { LOG_PATH, drive, engine } from './testkit'

// The helper wait cap (ADR 0030): a helper's foreground Bash call with a timeout over 270,000 ms is refused while the helper's
// cache lives under 1 hour, because rightsize cannot keep a helper's cache warm. The main chat has in-turn keep warm instead.

const logOf = (h: ReturnType<typeof engine>) => h.files[LOG_PATH] ?? ''
const WAIT = 'a foreground wait over 4.5 minutes'
type Reply = { deny?: string }

// A session whose helpers' cache lives 5 minutes (the kit's default env says 1 hour, so it is cleared), or what `env` says.
const session = async ($: unknown, on: Parameters<TestBody>[1], env: Record<string, string> = {}) => {
  const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
  h.env = env
  const d = drive($, h)
  await d.start('terminal')
  await d.step('t1')
  await d.complete('t1')
  return { h, d }
}
const helperBash = async (d: ReturnType<typeof drive>, extra: Record<string, unknown>) => (await d.bash('npm run slow-build', 'agent-helper', extra)) as Reply

test('a helper\'s foreground Bash call with a timeout over 270 s is refused on a 5-minute cache', { timeoutMs: 30000 }, async ($, on) => {
  const { h, d } = await session($, on)
  const r = await helperBash(d, { timeout: 300_000 })
  expect(r.deny).toContain(WAIT)
  expect(r.deny).toContain('run_in_background')
  expect(r.deny).toContain('270000 ms or less')
  expect(logOf(h)).toContain("capped a helper's wait: Bash timeout 300 s is over 270 s on a 5-min cache")
  expect((await helperBash(d, { timeout: 270_001, run_in_background: false })).deny, 'an explicit false is still foreground').toContain(WAIT)
})

test('a helper\'s background call is allowed, whatever its timeout', { timeoutMs: 30000 }, async ($, on) => {
  const { h, d } = await session($, on)
  expect((await helperBash(d, { timeout: 600_000, run_in_background: true })).deny).toBeUndefined()
  expect(logOf(h)).not.toContain('capped a helper')
})

test('a helper\'s call at exactly 270 s, with no timeout, or with a timeout that is not a number is allowed', { timeoutMs: 30000 }, async ($, on) => {
  const { h, d } = await session($, on)
  expect((await helperBash(d, { timeout: 270_000 })).deny, 'exactly 270,000 ms').toBeUndefined()
  expect((await helperBash(d, {})).deny, 'no timeout: Claude Code\'s 120 s default').toBeUndefined()
  expect((await helperBash(d, { timeout: 120_000 })).deny).toBeUndefined()
  expect((await helperBash(d, { timeout: '600000' })).deny, 'not a number: left alone').toBeUndefined()
  expect(logOf(h)).not.toContain('capped a helper')
})

test('the main chat is not capped', { timeoutMs: 30000 }, async ($, on) => {
  const { h, d } = await session($, on)
  const r = (await d.bash('npm run slow-build', undefined, { timeout: 600_000 })) as Reply
  expect(r.deny).toBeUndefined()
  expect(logOf(h)).not.toContain('capped a helper')
})

test('a helper on a 1-hour cache is not capped', { timeoutMs: 30000 }, async ($, on) => {
  const { h, d } = await session($, on, { CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '1h' })
  expect((await helperBash(d, { timeout: 600_000 })).deny).toBeUndefined()
  expect(logOf(h)).toContain('helpers and forks 1 hour')
  expect(logOf(h)).not.toContain('capped a helper')
})

test('a helper is not capped while rightsize is off', { timeoutMs: 30000 }, async ($, on) => {
  const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
  h.env = {}
  h.files['/home/test/.claude/mods/switches.json'] = '{"rightsize": false}'
  const d = drive($, h)
  await d.start('terminal')
  expect((await helperBash(d, { timeout: 600_000 })).deny).toBeUndefined()
  expect(logOf(h)).not.toContain('capped a helper')
})
