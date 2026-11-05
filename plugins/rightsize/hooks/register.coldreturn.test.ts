import { expect, test } from 'claude-code/testing'
import { COMPACT_SUMMARY_TOKENS, DEFAULT_PRICES, coldCost, coldReturnSaving } from './cost'
import { RUNS_FILE, LOG_PATH, engine, drive } from './testkit'

// ---- Cold return log ---------------------------------------------------------------------------------------
//
// A session that starts with history (a resume) and sat longer than its cache lives gets one `coldReturn` line in the
// run log: log only, whatever the cost, with nothing shown and nothing compacted. rightsize reads the session in its own
// `session.start`: the history and the size from `$.session`, the time of the last response from the transcript's tail.

const OPUS = { model: 'claude-opus-5-5', effort: 'medium' }
const MIN = 60_000
const HOUR = 3600
const runLines = (h: ReturnType<typeof engine>) =>
  (h.files[RUNS_FILE] ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>)
const coldLines = (h: ReturnType<typeof engine>) => runLines(h).filter(l => l.kind === 'coldReturn')
/** One assistant row of a transcript as the file keeps it, its response ended `agoMs` before the harness clock. */
const reply = (h: ReturnType<typeof engine>, agoMs: number, over: Record<string, unknown> = {}, usage: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: new Date(h.now - agoMs).toISOString(),
    message: { model: 'claude-opus-5-5', usage: { input_tokens: 1000, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 10_000, output_tokens: 300, ...usage } },
    ...over,
  })
/** A transcript's tail: a cut-off first row, the last response, then rows that are not responses. */
const tail = (h: ReturnType<typeof engine>, agoMs: number, over: Record<string, unknown> = {}, usage: Record<string, unknown> = {}) =>
  ['{"type":"assistant","timest', reply(h, agoMs, over, usage), JSON.stringify({ type: 'system', timestamp: new Date(h.now).toISOString() }), JSON.stringify({ type: 'user', timestamp: new Date(h.now).toISOString() })].join('\n')
const resumed = (h: ReturnType<typeof engine>, agoMs = 2 * HOUR * 1000, over: Record<string, unknown> = {}, usage: Record<string, unknown> = {}) => {
  h.transcript = tail(h, agoMs, over, usage)
}

test('a resume past the cache life writes one coldReturn line: idle time, size, tier, cold cost and the saving a Haiku compaction would have made', async ($, on) => {
  const h = engine(on, OPUS)
  resumed(h)
  await drive($, h).start('terminal')
  const lines = coldLines(h)
  expect(lines.length, 'one line').toBe(1)
  expect(lines[0]).toMatchObject({ kind: 'coldReturn', session: 'sess-1', resume: true, idleSeconds: 7200, tier: 'opus', context: 61_000 })
  expect(typeof lines[0]?.at, 'a timestamp').toBe('string')
  expect(lines[0]?.coldCost).toBe(Number(coldCost(DEFAULT_PRICES, 'opus', 61_000).toFixed(5)))
  expect(lines[0]?.compactSaving, 'about $0.42 on 61K of Opus at the repo prices').toBe(0.4199)
  expect(lines[0]?.compactSaving).toBe(Number(coldReturnSaving(DEFAULT_PRICES, 'opus', 61_000).toFixed(5)))
  expect(runLines(h).length, 'it is the only line the session wrote').toBe(1)
  expect(h.lookups, 'the transcript was looked for once').toBe(1)
  expect(COMPACT_SUMMARY_TOKENS).toBe(6000)
})

test('the size is the live window of $.session.usage() when it has one; else the last response of the transcript', async ($, on) => {
  const h = engine(on, OPUS)
  resumed(h)
  h.contextTokens = 75_000
  await drive($, h).start('terminal')
  expect(coldLines(h)[0], 'the host figure wins over the tail').toMatchObject({ context: 75_000, tier: 'opus' })
})

test('it is logged for a small conversation too (the old $0.50 bar for Before the cache goes cold is gone)', async ($, on) => {
  const h = engine(on, OPUS)
  resumed(h, 2 * HOUR * 1000, {}, { input_tokens: 0, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 0 })
  await drive($, h).start('terminal')
  expect(coldLines(h)[0]?.coldCost, '20K on Opus is $0.156 to come back cold').toBe(0.156)
  expect(coldLines(h)[0]?.compactSaving).toBeGreaterThan(0)
})

test('a context smaller than its summary: the saving is clamped to 0', async ($, on) => {
  const h = engine(on, OPUS)
  resumed(h, 2 * HOUR * 1000, {}, { input_tokens: 0, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 })
  await drive($, h).start('terminal')
  expect(coldLines(h)[0]?.compactSaving).toBe(0)
})

test('a warm resume (back inside the cache life) writes nothing', async ($, on) => {
  const h = engine(on, OPUS)
  resumed(h, 10 * MIN)
  await drive($, h).start('terminal')
  expect(runLines(h), 'no run line of any kind').toEqual([])
  expect(h.files[LOG_PATH] ?? '', 'and nothing in the text log').not.toContain('coldReturn')
})

test('exactly one cache life of idle time is still warm: the line needs the time to be past it', async ($, on) => {
  const h = engine(on, OPUS)
  resumed(h, 60 * MIN)
  await drive($, h).start('terminal')
  expect(coldLines(h)).toEqual([])
})

test('a fresh session writes nothing, and does not look for a transcript', async ($, on) => {
  const h = engine(on, OPUS)
  h.messages = []
  resumed(h)
  await drive($, h).start('terminal')
  expect(runLines(h), 'no history, no line').toEqual([])
  expect(h.lookups).toBe(0)
})

test('a prompt with no response yet is still a fresh session', async ($, on) => {
  const h = engine(on, OPUS)
  h.messages = [{ role: 'user', text: 'hello' }]
  resumed(h)
  await drive($, h).start('terminal')
  expect(runLines(h)).toEqual([])
  expect(h.lookups).toBe(0)
})

test('history but no transcript file: nothing is written, nothing is guessed', async ($, on) => {
  const h = engine(on, OPUS)
  await drive($, h).start('terminal')
  expect(h.lookups, 'it looked').toBe(1)
  expect(runLines(h)).toEqual([])
})

test('a transcript with no response row writes nothing', async ($, on) => {
  const h = engine(on, OPUS)
  h.transcript = JSON.stringify({ type: 'user', timestamp: new Date(h.now - 5 * HOUR * 1000).toISOString() })
  await drive($, h).start('terminal')
  expect(runLines(h)).toEqual([])
})

test("rows that are not the session's own answer are passed over: a subagent's, an API error, a synthetic one", async ($, on) => {
  const h = engine(on, OPUS)
  h.transcript = [
    reply(h, 3 * HOUR * 1000),
    reply(h, 1 * MIN, { isSidechain: true }),
    reply(h, 1 * MIN, { isApiErrorMessage: true }),
    JSON.stringify({ type: 'assistant', timestamp: new Date(h.now).toISOString(), message: { model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 } } }),
  ].join('\n')
  await drive($, h).start('terminal')
  expect(coldLines(h)[0]).toMatchObject({ idleSeconds: 3 * HOUR, context: 61_000 })
})

test('the tier comes from the session model when the transcript row names none', async ($, on) => {
  const h = engine(on, { model: 'claude-sonnet-5-5', effort: 'medium' })
  h.transcript = JSON.stringify({ type: 'assistant', timestamp: new Date(h.now - 2 * HOUR * 1000).toISOString(), message: { usage: { input_tokens: 61_000 } } })
  await drive($, h).start('terminal')
  expect(coldLines(h)[0]?.tier, 'the live model is Sonnet').toBe('sonnet')
  expect(coldLines(h)[0]?.coldCost).toBe(Number(coldCost(DEFAULT_PRICES, 'sonnet', 61_000).toFixed(5)))
})

test('a model name that is no tier: the live model answers', async ($, on) => {
  const h = engine(on, { model: 'claude-sonnet-5-5', effort: 'medium' })
  resumed(h, 2 * HOUR * 1000, { message: { model: 'some-other-model', usage: { input_tokens: 61_000 } } })
  await drive($, h).start('terminal')
  expect(coldLines(h)[0]?.tier).toBe('sonnet')
})

test('no model known: the tier and the costs are left out, not guessed', async ($, on) => {
  const h = engine(on, { model: 'mystery-1', effort: 'medium' })
  h.transcript = JSON.stringify({ type: 'assistant', timestamp: new Date(h.now - 2 * HOUR * 1000).toISOString(), message: { usage: { input_tokens: 61_000 } } })
  await drive($, h).start('terminal')
  const [line] = coldLines(h)
  expect(line).toMatchObject({ kind: 'coldReturn', context: 61_000 })
  expect(line).not.toHaveProperty('tier')
  expect(line).not.toHaveProperty('coldCost')
  expect(line).not.toHaveProperty('compactSaving')
})

test('no size anywhere: the line has the idle time and tier, and no context or cost', async ($, on) => {
  const h = engine(on, OPUS)
  resumed(h, 2 * HOUR * 1000, {}, { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
  await drive($, h).start('terminal')
  const [line] = coldLines(h)
  expect(line).toMatchObject({ kind: 'coldReturn', idleSeconds: 7200, tier: 'opus' })
  expect(line).not.toHaveProperty('context')
  expect(line).not.toHaveProperty('coldCost')
  expect(line).not.toHaveProperty('compactSaving')
})

test('watch only still logs it', { options: { mode: 'watch only' } }, async ($, on) => {
  const h = engine(on, { ...OPUS, stored: { mode: 'watch only' } })
  resumed(h)
  await drive($, h).start('terminal')
  expect(coldLines(h).length).toBe(1)
})

test('off: nothing is written, and the transcript is not looked for', async ($, on) => {
  const h = engine(on, OPUS)
  resumed(h)
  h.files['/home/test/.claude/mods/switches.json'] = '{"rightsize": false}'
  await drive($, h).start('terminal')
  expect(coldLines(h)).toEqual([])
  expect(h.lookups).toBe(0)
})

test('error: the history cannot be read, and the session still starts', async ($, on) => {
  const h = engine(on, OPUS)
  resumed(h)
  h.messagesFail = true
  const d = drive($, h)
  await d.start('terminal')
  expect(runLines(h)).toEqual([])
  expect((await d.command('status')).text ?? '', 'the session works after').not.toBe('')
})

test('error: the lookup cannot start, and the session still starts', async ($, on) => {
  const h = engine(on, OPUS)
  resumed(h)
  h.transcriptFails = true
  const d = drive($, h)
  await d.start('terminal')
  expect(runLines(h)).toEqual([])
  expect((await d.command('status')).text ?? '').not.toBe('')
})

test('error: a transcript of junk rows writes nothing', async ($, on) => {
  const h = engine(on, OPUS)
  h.transcript = '\u0000not json\n{"type":"assistant"}\n[1,2]\nnull\n{"type":"assistant","timestamp":"never","message":{"usage":{}}}'
  const d = drive($, h)
  await d.start('terminal')
  expect(runLines(h)).toEqual([])
  expect((await d.command('status')).text ?? '').not.toBe('')
})

test('the report and the log reader take the line: only the Cold returns line shows it, and nothing else in the report changes', async ($, on) => {
  const h = engine(on, OPUS)
  const d = drive($, h)
  await d.start('terminal')
  const before = (await d.command('report')).text
  expect(before, 'no cold return yet, no line').not.toContain('Cold returns')
  // A second start in the same process, now with a transcript to find: the line is written into the log the report reads.
  resumed(h)
  await d.start('terminal')
  expect(coldLines(h).length).toBe(1)
  const after = (await d.command('report')).text ?? ''
  expect(after, 'the line reads the log: 1 return, what the compaction would have saved').toContain('Cold returns: 1 · whatsnext could have saved $0.42')
  expect(after.replace(/\n\nCold returns:[^\n]*/, ''), 'the rest is the same report').toBe(before)
  expect((await d.command('status')).text ?? '').not.toBe('')
})
