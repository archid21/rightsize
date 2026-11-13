import { type TestBody, expect, test } from 'claude-code/testing'
import { LOG_PATH, LOOKUP, NO_CHANGE, NO_COLD, RUNS_FILE, DAY, bandText, drive, engine, settle } from './testkit'

// P-16: once a month, at a main turn's end, the last 30 days are priced on a 5-minute cache with keep warm and on a 1-hour cache. When
// the cheaper one is not the life Claude Code reads now, the band asks once whether to set promptCacheTtl to it. It shows only on an
// API key, a cloud provider or a gateway, or usage credits; never holds a prompt; writes only on the answer; and Did it work? measures it.
// Behind a cloud provider or gateway, a switch to 1 hour is checked against the next responses' cache writes, and set back when they are not 1-hour writes.

const MIN = 60_000
const NOW = 1_800_000_000_000
const HEADER = 'Cache life'
const CHECKED = 'cacheLifeCheckedAt'
const PROBE = 'cacheLifeProbe'
const CHANGES = '/home/test/.claude/mods-logs/rightsize/changes.jsonl'
const OPUS = { model: 'claude-opus-5-5', effort: 'medium' }
const SUB = [{ kind: 'five_hour', percentUsed: 10 }]
const CREDITS = [{ kind: 'five_hour', percentUsed: 100 }]

type H = ReturnType<typeof engine>
type Kind = 'long-gaps' | 'quick' | 'flat'
/** What each turn adds to a conversation of 100K tokens, and the idle gap before the next one. Opus: 5 minutes writes at $5 per million, 1 hour at $8. */
const KINDS: Record<Kind, { gap: number; added: number }> = {
  /** 24-minute gaps: keep warm pings on 5 minutes, nothing on 1 hour: 1 hour is cheaper. */
  'long-gaps': { gap: 24 * MIN, added: 2_000 },
  /** One-minute gaps and 20K tokens added a turn: 5 minutes is cheaper. */
  quick: { gap: MIN, added: 20_000 },
  /** Nothing added, no gap: a tie. */
  flat: { gap: MIN, added: 0 },
}

/** Ten days of four turns, one session a day, ending before `h.now`: each costing $1.00 (the Did it work? baseline). */
const seed = (h: H, kind: Kind, over: { days?: number; perDay?: number } = {}) => {
  const { gap, added } = KINDS[kind]
  const lines: string[] = []
  for (let d = 0; d < (over.days ?? 10); d++) {
    for (let i = 0; i < (over.perDay ?? 4); i++) {
      const start = 100_000 + i * added
      const ended = (d + 1) * DAY - i * (gap + MIN)
      lines.push(
        JSON.stringify({ kind: 'run', session: `s${d}`, tier: 'opus', at: new Date(h.now - ended).toISOString(), submittedAt: new Date(h.now - ended - MIN).toISOString(), context: start, contextEnd: start + added, actual: 1 }),
      )
    }
  }
  h.files[RUNS_FILE] = lines.join('\n')
}

type Over = { kind?: Kind; env?: Record<string, string>; settings?: Record<string, unknown>; rateLimits?: { kind: string; percentUsed: number }[]; stored?: Record<string, string>; store?: Record<string, unknown>; surface?: string; lines?: { days?: number; perDay?: number } }
const begin = async ($: unknown, on: Parameters<TestBody>[1], over: Over = {}) => {
  const h = engine(on, { ...OPUS, stored: { ...NO_COLD, ...(over.stored ?? {}) }, ...(over.store ? { store: over.store } : {}) })
  h.env = over.env ?? {}
  h.settings = over.settings ?? {}
  if (over.rateLimits) h.rateLimits = over.rateLimits
  h.now = NOW
  seed(h, over.kind ?? 'long-gaps', over.lines)
  h.answers = { [HEADER]: 'Not now' }
  const d = drive($, h)
  const surface = over.surface ?? 'terminal'
  await d.start(surface)
  let n = 0
  /** A main-chat request and the turn's end: no prompt of its own, so no run line is added to the seeded ones. */
  const turnEnd = async () => {
    const id = `e${++n}`
    await d.step(id)
    await d.complete(id)
    await settle()
  }
  return { h, d, turnEnd, surface }
}
const asks = (h: H) => h.asked.filter(a => a.header === HEADER)
const logOf = (h: H) => h.files[LOG_PATH] ?? ''
const writes = (h: H) => h.sets.filter(x => x.key === 'promptCacheTtl').map(x => x.value)
const changes = (h: H) => (h.files[CHANGES] ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l) as { key: string; from: string; to: string })

for (const surface of ['desktop', 'terminal'] as const) {
  test(`API key on a 5-minute cache, 1 hour cheaper: asks once on the band, writes nothing until the answer (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, turnEnd } = await begin($, on, { surface })
    await turnEnd()
    expect(asks(h).length, 'asked once').toBe(1)
    expect(asks(h)[0]?.options).toEqual(['Use 1 hour', 'Not now'])
    const q = asks(h)[0]?.question ?? ''
    expect(q).toContain('Over your last 30 days (40 prompts), a 1-hour prompt cache would have cost about $')
    expect(q).toContain('less than a 5-minute prompt cache with keep warm.')
    expect(q).toContain("Set Claude Code's cache life to 1 hour for this project?")
    expect(writes(h), 'Not now writes nothing').toEqual([])
    expect(h.store[CHECKED], 'the month is claimed whatever the answer').toBe(h.now)
    expect(logOf(h)).toContain('cache-life check: 5 minutes with keep warm')
    expect(logOf(h)).toContain('asked about 1h')
    expect(logOf(h)).toContain('cache life: not now; the cache life is unchanged')
    await turnEnd()
    expect(asks(h).length, 'not asked again').toBe(1)
  })

  test(`the answer Use 1 hour writes promptCacheTtl, logs the change for Did it work?, and the report measures it (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d, turnEnd } = await begin($, on, { surface })
    h.answers = { [HEADER]: 'Use 1 hour' }
    await turnEnd()
    expect(writes(h)).toEqual(['1h'])
    expect(changes(h)).toEqual([{ at: expect.any(String), key: 'promptCacheTtl', from: '5m', to: '1h' }])
    expect(logOf(h)).toContain('cache life: set to 1h (was 5m)')
    // rightsize reads the new life at once.
    expect(logOf(h)).toContain('cache life: 1 hour (the promptCacheTtl setting)')
    expect(await bandText($, surface)).toContain('Cache life set to 1 hour.')
    // Four days on, 36 prompts at $0.50 against the $1.00 before: Did it work? sees the change and measures it.
    const at = h.now
    h.files[RUNS_FILE] += `\n${Array.from({ length: 36 }, (_, i) => JSON.stringify({ kind: 'run', session: 'later', tier: 'opus', at: new Date(at + (i / 9 + 0.1) * DAY).toISOString(), actual: 0.5, requests: 1 })).join('\n')}`
    h.now = at + 5 * DAY
    const report = (await d.command('report')).text ?? ''
    expect(report).toContain('DID IT WORK?')
    expect(report).toContain('Cache life: 5 minutes to 1 hour,')
    expect(report).toContain('Cheaper: 50% less per prompt than the days before')
  })

  test(`1 hour is read already and 5 minutes is cheaper: asks to set 5 minutes (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, turnEnd } = await begin($, on, { surface, kind: 'quick', settings: { promptCacheTtl: '1h' } })
    h.answers = { [HEADER]: 'Use 5 minutes' }
    await turnEnd()
    expect(asks(h)[0]?.options).toEqual(['Use 5 minutes', 'Not now'])
    expect(asks(h)[0]?.question).toContain('a 5-minute prompt cache with keep warm would have cost about $')
    expect(asks(h)[0]?.question).toContain('less than a 1-hour prompt cache.')
    expect(writes(h)).toEqual(['5m'])
    expect(changes(h)).toEqual([{ at: expect.any(String), key: 'promptCacheTtl', from: '1h', to: '5m' }])
  })

  test(`a tie asks nothing and the month is still claimed (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, turnEnd } = await begin($, on, { surface, kind: 'flat' })
    await turnEnd()
    expect(asks(h)).toEqual([])
    expect(h.store[CHECKED]).toBe(h.now)
    expect(logOf(h)).toContain('a tie, nothing asked')
  })

  test(`the cheaper life is the one already read: nothing asked, 1 hour (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, turnEnd } = await begin($, on, { surface, kind: 'long-gaps', settings: { promptCacheTtl: '1h' } })
    await turnEnd()
    expect(asks(h)).toEqual([])
    expect(logOf(h)).toContain('already the cheaper one')
  })

  test(`the cheaper life is the one already read: nothing asked, 5 minutes (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, turnEnd } = await begin($, on, { surface, kind: 'quick', settings: { promptCacheTtl: '5m' } })
    await turnEnd()
    expect(asks(h)).toEqual([])
    expect(logOf(h)).toContain('already the cheaper one')
  })
}

// ---- The run line ---------------------------------------------------------------------------------------------------

test('a run line carries the conversation\'s size at the turn\'s end, beside the size it began at, for this check to price', { timeoutMs: 30000 }, async ($, on) => {
  const h = engine(on, { ...OPUS, stored: NO_COLD })
  h.env = {}
  const d = drive($, h)
  await d.start('terminal')
  h.rating = NO_CHANGE
  // 200 + 20,000 + 300 tokens: the conversation after the turn's last request.
  await d.submit(LOOKUP)
  await d.step('t1', 0)
  await d.step('t1', 1)
  await d.complete('t1')
  const line = (h.files[RUNS_FILE] ?? '').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>).find(l => l.kind === 'run')
  expect(line).toMatchObject({ contextEnd: 20_500, session: 'sess-1', tier: 'opus' })
  expect(typeof line?.context, 'the size it began at').toBe('number')
  expect(typeof line?.submittedAt).toBe('string')
})

// ---- Who sees it ---------------------------------------------------------------------------------------------------

test('a subscription inside its plan is silent on the default 1-hour read life', { timeoutMs: 30000 }, async ($, on) => {
  const { h, turnEnd } = await begin($, on, { rateLimits: SUB })
  await turnEnd()
  expect(asks(h)).toEqual([])
  expect(h.store[CHECKED], 'nothing was checked').toBeUndefined()
})

test('a subscription inside its plan is silent on a 5-minute life the person set', { timeoutMs: 30000 }, async ($, on) => {
  const { h, turnEnd } = await begin($, on, { rateLimits: SUB, settings: { promptCacheTtl: '5m' }, kind: 'quick' })
  await turnEnd()
  expect(asks(h)).toEqual([])
  expect(h.store[CHECKED]).toBeUndefined()
})

test('a subscription on usage credits sees it', { timeoutMs: 30000 }, async ($, on) => {
  const { h, turnEnd } = await begin($, on, { rateLimits: CREDITS })
  await turnEnd()
  expect(asks(h).length).toBe(1)
  expect(logOf(h)).toContain('cache life: 5 minutes (a subscription on usage credits)')
})

const CLOUD: Record<string, string>[] = [{ CLAUDE_CODE_USE_BEDROCK: '1' }, { CLAUDE_CODE_USE_VERTEX: '1' }, { ANTHROPIC_BASE_URL: 'https://llm.example.com' }]
for (const env of CLOUD) {
  test(`a cloud provider or a gateway sees it, whatever the billing read, on the 5-minute life Claude Code gives it (${Object.keys(env)[0]})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, turnEnd } = await begin($, on, { env, rateLimits: [] })
    await turnEnd()
    expect(asks(h).length).toBe(1)
    expect(logOf(h)).toContain('cache life: 5 minutes (a cloud provider or gateway)')
  })
}

test('a base URL on Anthropic\'s own host is not a gateway: the billing is not known, so nothing is asked', { timeoutMs: 30000 }, async ($, on) => {
  const { h, turnEnd } = await begin($, on, { env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }, rateLimits: [] })
  await turnEnd()
  expect(asks(h)).toEqual([])
})

const FIXED: Record<string, string>[] = [{ CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' }, { FORCE_PROMPT_CACHING_5M: '1' }]
for (const env of FIXED) {
  test(`${Object.keys(env)[0]} decides the life: a write would change nothing, so nothing is asked`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, turnEnd } = await begin($, on, { env })
    await turnEnd()
    expect(asks(h)).toEqual([])
    expect(h.store[CHECKED]).toBeUndefined()
  })
}

// ---- The month ------------------------------------------------------------------------------------------------------

test('monthly: not again 29 days after a check', { timeoutMs: 30000 }, async ($, on) => {
  const { h, turnEnd } = await begin($, on, { store: { [CHECKED]: NOW - 29 * DAY } })
  await turnEnd()
  expect(asks(h)).toEqual([])
  expect(h.store[CHECKED]).toBe(NOW - 29 * DAY)
})

test('monthly: due again 30 days after a check', { timeoutMs: 30000 }, async ($, on) => {
  const { h, turnEnd } = await begin($, on, { store: { [CHECKED]: NOW - 30 * DAY } })
  await turnEnd()
  expect(asks(h).length).toBe(1)
  expect(h.store[CHECKED]).toBe(NOW)
})

test('once a session: three turn ends ask once', { timeoutMs: 30000 }, async ($, on) => {
  const { h, turnEnd } = await begin($, on)
  await turnEnd()
  await turnEnd()
  await turnEnd()
  expect(asks(h).length).toBe(1)
})

test('too few turns: not a check, not claimed, tried again later', { timeoutMs: 30000 }, async ($, on) => {
  const { h, turnEnd } = await begin($, on, { lines: { days: 10, perDay: 2 } })
  await turnEnd()
  expect(asks(h)).toEqual([])
  expect(h.store[CHECKED]).toBeUndefined()
  expect(logOf(h)).toContain('cache-life check: not enough turns yet (20 turns in 10 days)')
})

test('turns of too few days: not a check, not claimed', { timeoutMs: 30000 }, async ($, on) => {
  const { h, turnEnd } = await begin($, on, { lines: { days: 5, perDay: 12 } })
  await turnEnd()
  expect(asks(h)).toEqual([])
  expect(h.store[CHECKED]).toBeUndefined()
})

test('run lines from before 0.13 carry no size at the turn\'s end and are not priced', { timeoutMs: 30000 }, async ($, on) => {
  const h = engine(on, { ...OPUS, stored: NO_COLD })
  h.env = {}
  h.now = NOW
  seed(h, 'long-gaps')
  h.files[RUNS_FILE] = (h.files[RUNS_FILE] ?? '').split('\n').map(l => JSON.stringify({ ...JSON.parse(l), contextEnd: undefined })).join('\n')
  const d = drive($, h)
  await d.start('terminal')
  await d.step('e1')
  await d.complete('e1')
  await settle()
  expect(asks(h)).toEqual([])
  expect(logOf(h)).toContain('not enough turns yet (0 turns in 0 days)')
})

// ---- Never holds a prompt ---------------------------------------------------------------------------------------------

test('Band never: nothing is asked, in the band or in a dialog, and the month is not claimed', { timeoutMs: 30000, options: { band: 'off' } }, async ($, on) => {
  const { h, turnEnd } = await begin($, on, { stored: { band: 'off' } })
  await turnEnd()
  expect(h.asked).toEqual([])
  expect(h.store[CHECKED]).toBeUndefined()
})

test('the mobile app draws no band: nothing is asked and the month is not claimed', { timeoutMs: 30000 }, async ($, on) => {
  const { h, turnEnd } = await begin($, on, { surface: 'mobile' })
  await turnEnd()
  expect(h.asked).toEqual([])
  expect(h.store[CHECKED]).toBeUndefined()
})

test('the question goes on the band, so the prompt that follows is not held, and unanswered it changes nothing', { timeoutMs: 30000 }, async ($, on) => {
  const { h, d, turnEnd } = await begin($, on)
  h.answers = { [HEADER]: '(no one answers)' }
  await turnEnd()
  expect(h.events).toContain(`ask:${HEADER}`)
  await d.submit('what does the parseConfig function in src/config.ts return exactly')
  await settle()
  expect(h.submitted.length, 'the prompt went on').toBe(1)
  expect(writes(h)).toEqual([])
  expect(logOf(h)).toContain('no answer on the band to Cache life: the cache life is unchanged')
})

test('watch only checks nothing', { timeoutMs: 30000, options: { mode: 'watch only' } }, async ($, on) => {
  const { h, turnEnd } = await begin($, on, { stored: { mode: 'watch only' } })
  await turnEnd()
  expect(asks(h)).toEqual([])
  expect(logOf(h)).toContain('watch only: would check the cache life')
})

// ---- The write, checked ---------------------------------------------------------------------------------------------

for (const how of ['refuse', 'pinned'] as const) {
  test(`a write ${how === 'refuse' ? 'Claude Code refuses' : 'another source overrides'} is said on the band and not recorded`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, turnEnd } = await begin($, on)
    h.answers = { [HEADER]: 'Use 1 hour' }
    if (how === 'refuse') h.cacheTtlRefuse = 'managed settings own it'
    else h.cacheTtlPinned = true
    await turnEnd()
    expect(changes(h)).toEqual([])
    expect(logOf(h)).toContain(how === 'refuse' ? 'Claude Code refused to write promptCacheTtl: managed settings own it' : 'cache life 1h: not applied (another source sets it)')
    expect(await bandText($, 'terminal')).toContain('Cache life stays as it was: Claude Code did not take 1 hour.')
  })
}

// ---- Bedrock, Vertex and gateways: the next cache writes must be 1-hour writes ------------------------------------------

const SHORT = { input_tokens: 200, output_tokens: 400, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 300, cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 0 } }
const HOUR = { ...SHORT, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 300 } }
const NO_FIELD = { input_tokens: 200, output_tokens: 400, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 300 }
const NO_WRITES = { ...SHORT, cache_creation_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } }

for (const [name, env] of [['Bedrock', { CLAUDE_CODE_USE_BEDROCK: '1' }], ['a gateway', { ANTHROPIC_BASE_URL: 'https://llm.example.com' }]] as const) {
  const accepted = async ($: unknown, on: Parameters<TestBody>[1]) => {
    const s = await begin($, on, { env })
    s.h.answers = { [HEADER]: 'Use 1 hour' }
    await s.turnEnd()
    expect(writes(s.h)).toEqual(['1h'])
    expect(s.h.store[PROBE], 'the check is kept in the store').toMatchObject({ from: '5m', seen: 0 })
    return s
  }
  const response = async (s: Awaited<ReturnType<typeof begin>>, usage: Record<string, unknown>) => {
    s.h.stepUsage = usage as typeof s.h.stepUsage
    await s.turnEnd()
  }

  test(`${name}: three responses that wrote no 1-hour entries set the cache life back and say so on the band`, { timeoutMs: 30000 }, async ($, on) => {
    const s = await accepted($, on)
    // The turn end that asked ran its own request at the default usage; writes with no 1-hour field do not count as short either.
    await response(s, NO_WRITES)
    await response(s, SHORT)
    await response(s, SHORT)
    expect(writes(s.h), 'two short responses: still checking').toEqual(['1h'])
    await response(s, SHORT)
    expect(writes(s.h)).toEqual(['1h', '5m'])
    expect(s.h.settings.promptCacheTtl).toBe('5m')
    expect(changes(s.h).map(c => `${c.from}>${c.to}`)).toEqual(['5m>1h', '1h>5m'])
    expect(logOf(s.h)).toContain('cache life: 3 responses with cache writes wrote no 1-hour entries')
    expect(logOf(s.h)).toContain('cache life: 5 minutes (the promptCacheTtl setting)')
    expect(s.h.store[PROBE]).toBeNull()
    expect(await bandText($, 'terminal')).toContain(`Cache life set back to 5 minutes: your ${name === 'Bedrock' ? 'Amazon Bedrock' : 'gateway'} did not write 1-hour cache entries`)
    await response(s, SHORT)
    expect(writes(s.h), 'checked once').toEqual(['1h', '5m'])
  })

  test(`${name}: one response with 1-hour writes ends the check and the setting stays`, { timeoutMs: 30000 }, async ($, on) => {
    const s = await accepted($, on)
    await response(s, SHORT)
    await response(s, HOUR)
    await response(s, SHORT)
    await response(s, SHORT)
    await response(s, SHORT)
    expect(writes(s.h)).toEqual(['1h'])
    expect(logOf(s.h)).toContain('cache life: the cache writes are 1-hour writes; the setting stays')
    expect(s.h.store[PROBE]).toBeNull()
  })

  test(`${name}: a usage with no 1-hour field cannot be checked, so the setting stays and the log says so`, { timeoutMs: 30000 }, async ($, on) => {
    const s = await accepted($, on)
    await response(s, NO_FIELD)
    expect(writes(s.h)).toEqual(['1h'])
    expect(logOf(s.h)).toContain('cache life: the usage has no 1-hour field, so the writes cannot be checked; the setting stays')
  })

  test(`${name}: a refused write back is said on the band`, { timeoutMs: 30000 }, async ($, on) => {
    const s = await accepted($, on)
    s.h.cacheTtlRefuse = 'managed settings own it'
    await response(s, SHORT)
    await response(s, SHORT)
    await response(s, SHORT)
    expect(await bandText($, 'terminal')).toContain('Claude Code would not set the cache life back. Set promptCacheTtl to 5m in your Claude settings.')
  })

  test(`${name}: a check that was not finished goes on in the next session, while the setting reads 1 hour`, { timeoutMs: 30000 }, async ($, on) => {
    const s = await begin($, on, { env, settings: { promptCacheTtl: '1h' }, store: { [CHECKED]: NOW, [PROBE]: { from: '5m', provider: 'bedrock', seen: 1 } } })
    await response(s, SHORT)
    expect(writes(s.h), 'one seen before the restart, one now: still checking').toEqual([])
    await response(s, SHORT)
    expect(writes(s.h)).toEqual(['5m'])
  })

  test(`${name}: the check is dropped when the person changed the setting meanwhile`, { timeoutMs: 30000 }, async ($, on) => {
    const s = await begin($, on, { env, settings: { promptCacheTtl: '5m' }, store: { [CHECKED]: NOW, [PROBE]: { from: '5m', provider: 'bedrock', seen: 0 } } })
    expect(s.h.store[PROBE]).toBeNull()
    await response(s, SHORT)
    await response(s, SHORT)
    await response(s, SHORT)
    expect(writes(s.h)).toEqual([])
  })
}

test('on Anthropic\'s own endpoint no check of the writes follows, whatever the usage says', { timeoutMs: 30000 }, async ($, on) => {
  const s = await begin($, on)
  s.h.answers = { [HEADER]: 'Use 1 hour' }
  await s.turnEnd()
  expect(s.h.store[PROBE]).toBeUndefined()
  s.h.stepUsage = SHORT as typeof s.h.stepUsage
  for (let i = 0; i < 4; i++) await s.turnEnd()
  expect(writes(s.h)).toEqual(['1h'])
})

test('an answer of 5 minutes behind a cloud provider starts no check of the writes', { timeoutMs: 30000 }, async ($, on) => {
  const s = await begin($, on, { env: { CLAUDE_CODE_USE_BEDROCK: '1' }, kind: 'quick', settings: { promptCacheTtl: '1h' } })
  s.h.answers = { [HEADER]: 'Use 5 minutes' }
  await s.turnEnd()
  expect(writes(s.h)).toEqual(['5m'])
  expect(s.h.store[PROBE]).toBeUndefined()
})
