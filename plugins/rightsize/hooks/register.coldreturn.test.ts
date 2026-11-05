import { expect, test } from 'claude-code/testing'
import { COMPACT_SUMMARY_TOKENS, DEFAULT_PRICES, coldCost, coldReturnSaving } from './cost'
import { RUNS_FILE, LOG_PATH, engine, drive } from './testkit'

// ---- Cold return log ---------------------------------------------------------------------------------------
//
// A session that starts by resuming with its prompt cache likely expired gets one `coldReturn` line in the run log:
// log only, whatever the cost, with nothing shown and nothing compacted.

type Classic = { classic: { SessionStart: (e: Record<string, unknown>) => Promise<unknown> } }
const classic = ($: unknown) => ($ as unknown as Classic).classic
const OPUS = { model: 'claude-opus-5-5', effort: 'medium' }
const HOUR = 3600
const runLines = (h: ReturnType<typeof engine>) =>
  (h.files[RUNS_FILE] ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>)
const coldLines = (h: ReturnType<typeof engine>) => runLines(h).filter(l => l.kind === 'coldReturn')
/** The classic SessionStart of a resume 2 hours on, as the host raises it. */
const resume = ($: unknown, over: Record<string, unknown> = {}) =>
  classic($).SessionStart({ session_id: 'sess-1', source: 'resume', model: 'claude-opus-5-5', seconds_since_last_response: 2 * HOUR, context_tokens: 61_000, prompt_cache_likely_expired: true, ...over })

test('a resume with an expired cache writes one coldReturn line: size, idle time, tier, cold cost and the saving a Haiku compaction would have made', async ($, on) => {
  const h = engine(on, OPUS)
  await drive($, h).start('terminal')
  await resume($)
  const lines = coldLines(h)
  expect(lines.length, 'one line').toBe(1)
  expect(lines[0]).toMatchObject({ kind: 'coldReturn', session: 'sess-1', resume: true, idleSeconds: 7200, tier: 'opus', context: 61_000 })
  expect(typeof lines[0]?.at, 'a timestamp').toBe('string')
  expect(lines[0]?.coldCost).toBe(Number(coldCost(DEFAULT_PRICES, 'opus', 61_000).toFixed(5)))
  expect(lines[0]?.compactSaving, 'about $0.42 on 61K of Opus at the repo prices').toBe(0.4199)
  expect(lines[0]?.compactSaving).toBe(Number(coldReturnSaving(DEFAULT_PRICES, 'opus', 61_000).toFixed(5)))
  expect(runLines(h).length, 'it is the only line the session wrote').toBe(1)
  expect(COMPACT_SUMMARY_TOKENS).toBe(6000)
})

test('it is logged below the $0.50 bar for Before the cache goes cold, with a saving of 0 when a compaction would not pay', async ($, on) => {
  const h = engine(on, OPUS)
  await drive($, h).start('terminal')
  await resume($, { context_tokens: 20_000 })
  await resume($, { context_tokens: 5000 })
  const lines = coldLines(h)
  expect(lines.length).toBe(2)
  expect(lines[0]?.coldCost, '20K on Opus is $0.156 to come back cold').toBe(0.156)
  expect(lines[0]?.compactSaving).toBeGreaterThan(0)
  expect(lines[1]?.compactSaving, 'a context smaller than its summary: clamped').toBe(0)
})

test('it writes nothing when the cache is not likely expired, or the event does not say', async ($, on) => {
  const h = engine(on, OPUS)
  await drive($, h).start('terminal')
  await resume($, { prompt_cache_likely_expired: false })
  await resume($, { prompt_cache_likely_expired: undefined })
  await classic($).SessionStart({ source: 'startup' })
  await classic($).SessionStart({ source: 'clear' })
  expect(runLines(h), 'no run line of any kind').toEqual([])
  expect(h.files[LOG_PATH] ?? '', 'and nothing in the text log').not.toContain('coldReturn')
})

test('a figure the event does not give is left out, not guessed; a fork is not a resume', async ($, on) => {
  const h = engine(on, OPUS)
  await drive($, h).start('terminal')
  await resume($, { seconds_since_last_response: undefined, context_tokens: undefined, source: 'fork' })
  const [line] = coldLines(h)
  expect(line).toMatchObject({ kind: 'coldReturn', resume: false, tier: 'opus' })
  expect(line, 'no idle time without the field').not.toHaveProperty('idleSeconds')
  expect(line, 'no size, so no cost').not.toHaveProperty('context')
  expect(line).not.toHaveProperty('coldCost')
  expect(line).not.toHaveProperty('compactSaving')
})

test('the tier comes from the event, else from the session model', async ($, on) => {
  const h = engine(on, { model: 'claude-sonnet-5-5', effort: 'medium' })
  await drive($, h).start('terminal')
  await resume($, { model: undefined })
  await resume($, { model: 'some-other-model' })
  await resume($, { model: 'claude-opus-5-5' })
  const [noModel, otherModel, named] = coldLines(h)
  expect(noModel?.tier, 'the live model is Sonnet').toBe('sonnet')
  expect(noModel?.coldCost).toBe(Number(coldCost(DEFAULT_PRICES, 'sonnet', 61_000).toFixed(5)))
  expect(otherModel?.tier, 'a name that is no tier: the live model answers').toBe('sonnet')
  expect(named?.tier, 'the event names it').toBe('opus')
})

test('no model known: the tier and the costs are left out, not guessed', async ($, on) => {
  const h = engine(on, { model: 'mystery-1', effort: 'medium' })
  await drive($, h).start('terminal')
  await resume($, { model: undefined })
  const [line] = coldLines(h)
  expect(line).toMatchObject({ kind: 'coldReturn', context: 61_000 })
  expect(line).not.toHaveProperty('tier')
  expect(line).not.toHaveProperty('coldCost')
  expect(line).not.toHaveProperty('compactSaving')
})

test('watch only still logs it', { options: { mode: 'watch only' } }, async ($, on) => {
  const h = engine(on, { ...OPUS, stored: { mode: 'watch only' } })
  await drive($, h).start('terminal')
  await resume($)
  expect(coldLines(h).length).toBe(1)
})

test('a SessionStart that comes before session.start finishes is written once, when it has finished', async ($, on) => {
  const h = engine(on, OPUS)
  await resume($)
  expect(coldLines(h), 'held until the prices and the log are loaded').toEqual([])
  await drive($, h).start('terminal')
  expect(coldLines(h).length, 'written once').toBe(1)
  expect(coldLines(h)[0]).toMatchObject({ session: 'sess-1', tier: 'opus', context: 61_000 })
})

test('the report and the log reader take the line without changing', async ($, on) => {
  const h = engine(on, OPUS)
  const d = drive($, h)
  await d.start('terminal')
  const before = (await d.command('report')).text
  await resume($)
  expect(coldLines(h).length).toBe(1)
  expect((await d.command('report')).text, 'the same report with the line in the log').toBe(before)
  expect((await d.command('status')).text ?? '').not.toBe('')
})
