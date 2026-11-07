import { type TestBody, expect, test } from 'claude-code/testing'
import { LOG_PATH, BIG_TURN, NO_CHANGE, OLD_PRICES, bandText, drive, engine, installWhatsnext, WHATSNEXT_CMDS } from './testkit'

// Claude Code's idle auto-compact (ADR 0019): above its threshold rightsize sends no pings, makes no offer and compacts nothing,
// and it notices the compact when it has happened. Runs on a virtual clock, as the keep-warm tests do.

for (const surface of ['desktop', 'terminal'] as const) {
  const MIN = 60_000
  const HOUR = 60 * MIN
  /** 18:00 local. */
  const EVENING = new Date(2027, 0, 15, 18, 0, 0, 0).getTime()
  /** The keep-warm row, set by the person: the profile's own choice is not in play. */
  const KEEP_WARM = { options: { profile: 'Balanced', beforeCold: 'keep warm 8 h' }, stored: { profile: 'Balanced', beforeCold: 'keep warm 8 h' } }
  /** A turn that leaves the conversation at exactly `tokens` (BIG_TURN's 500 other tokens counted). */
  const turnOf = (tokens: number) => ({ ...BIG_TURN, cache_read_input_tokens: tokens - 500 })
  const AFTER = { input_tokens: 500, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 18_000 }

  type Over = { tokens?: number; env?: Record<string, string>; settings?: Record<string, unknown>; whatsnext?: boolean; prices?: string; stored?: Record<string, string> }
  const session = async ($: unknown, on: Parameters<TestBody>[1], over: Over = {}) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', stored: over.stored ?? KEEP_WARM.stored })
    if (over.prices) h.pricesFile = over.prices
    h.now = EVENING
    h.virtual = true
    h.stepUsage = turnOf(over.tokens ?? 200_000)
    h.commands = []
    Object.assign(h.env, over.env ?? {})
    Object.assign(h.settings, over.settings ?? {})
    if (over.whatsnext) installWhatsnext(h)
    const d = drive($, h)
    await d.start(surface)
    return { h, d }
  }
  const turn = async (d: ReturnType<typeof drive>, id: string) => {
    await d.step(id)
    await d.complete(id)
  }
  const logOf = (h: ReturnType<typeof engine>) => h.files[LOG_PATH] ?? ''
  const nothingDone = (h: ReturnType<typeof engine>) => ({ forks: h.forks.length, submitted: h.submitted.length, compactions: h.compactions })
  const NONE = { forks: 0, submitted: 0, compactions: 0 }
  /** What the plugin kept in $.state for the idle-compact state, last write. */
  const stateOf = (h: ReturnType<typeof engine>, key: string) => h.stateWrites.filter(w => w.plugin === 'rightsize' && w.key === key).map(w => w.value).at(-1)
  const kept = (h: ReturnType<typeof engine>) => stateOf(h, 'idleCompact')
  const contextKept = (h: ReturnType<typeof engine>) => stateOf(h, 'context')
  /** The engine's own compaction: trigger `auto`, between turns. */
  const compactAs = (api: unknown, trigger: 'auto' | 'manual') =>
    (api as unknown as { session: { compact: (x: unknown) => Promise<unknown> } }).session.compact({ trigger, messages: [{ role: 'user', text: 'The conversation.', toolUses: [] }] })
  const autoCompact = (api: unknown) => compactAs(api, 'auto')

  test(`at or above the threshold with idle compaction on: no pings, no offer, no compact, and the state is kept (${surface})`, { timeoutMs: 30000, options: KEEP_WARM.options }, async ($, on) => {
    const { h, d } = await session($, on)
    await turn(d, 't1')
    await h.advance(8 * HOUR)
    expect(nothingDone(h)).toEqual(NONE)
    expect(await bandText($, surface)).toBe('')
    expect(logOf(h)).toContain('Claude Code compacts this session by itself 54 minutes after the last request')
    expect(kept(h)).toMatchObject({ on: true, context: 200_000 })
  })

  for (const row of ['compact', 'save a handoff', 'ask']) {
    test(`Before the cache goes cold = ${row}: nothing is done in that state (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
      const { h, d } = await session($, on, { tokens: 250_000, stored: { beforeCold: row }, whatsnext: true })
      await turn(d, 't1')
      await h.advance(2 * HOUR)
      expect(nothingDone(h)).toEqual(NONE)
      expect(await bandText($, surface)).toBe('')
    })
  }

  test(`just under the threshold keep warm is as before, and the state says off (${surface})`, { timeoutMs: 30000, options: KEEP_WARM.options }, async ($, on) => {
    const { h, d } = await session($, on, { tokens: 199_999 })
    await turn(d, 't1')
    await h.advance(57 * MIN)
    expect(h.forks.length, 'the first ping').toBe(1)
    expect(kept(h)).toMatchObject({ on: false })
    expect(logOf(h)).not.toContain('Claude Code compacts this session by itself')
  })

  test(`a CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS under the 100,000 floor is the floor: 120K is over it (${surface})`, { timeoutMs: 30000, options: KEEP_WARM.options }, async ($, on) => {
    const { h, d } = await session($, on, { tokens: 120_000, env: { CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: '50000' } })
    await turn(d, 't1')
    await h.advance(2 * HOUR)
    expect(nothingDone(h)).toEqual(NONE)
  })

  test(`a threshold of 300K leaves 120K tokens to keep warm (${surface})`, { timeoutMs: 30000, options: KEEP_WARM.options }, async ($, on) => {
    const { h, d } = await session($, on, { tokens: 120_000, env: { CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: '300000' } })
    await turn(d, 't1')
    await h.advance(57 * MIN)
    expect(h.forks.length).toBe(1)
    expect(kept(h)).toMatchObject({ on: false })
  })

  test(`one token under the floor is under the threshold (${surface})`, { timeoutMs: 30000, options: KEEP_WARM.options }, async ($, on) => {
    const { h, d } = await session($, on, { tokens: 99_999, env: { CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: '100000' } })
    await turn(d, 't1')
    await h.advance(57 * MIN)
    expect(h.forks.length).toBe(1)
  })

  for (const [what, over] of [
    ['idleCompaction is false', { settings: { idleCompaction: false } }],
    ['autoCompactEnabled is false', { settings: { autoCompactEnabled: false } }],
    ['DISABLE_AUTO_COMPACT is set', { env: { DISABLE_AUTO_COMPACT: '1' } }],
  ] as const) {
    test(`${what}: keep warm runs as before at 250K tokens (${surface})`, { timeoutMs: 30000, options: KEEP_WARM.options }, async ($, on) => {
      const { h, d } = await session($, on, { ...over, tokens: 250_000 })
      await turn(d, 't1')
      await h.advance(57 * MIN)
      expect(h.forks.length).toBe(1)
      expect(kept(h)).toMatchObject({ on: false })
    })
  }

  test(`settings that are not false, and an empty DISABLE_AUTO_COMPACT, leave the state on (${surface})`, { timeoutMs: 30000, options: KEEP_WARM.options }, async ($, on) => {
    const { h, d } = await session($, on, { settings: { idleCompaction: true, autoCompactEnabled: true }, env: { DISABLE_AUTO_COMPACT: '' } })
    await turn(d, 't1')
    await h.advance(2 * HOUR)
    expect(nothingDone(h)).toEqual(NONE)
  })

  test(`a 5-minute cache is not in the state: keep warm is as before (${surface})`, { timeoutMs: 30000, options: KEEP_WARM.options }, async ($, on) => {
    const { h, d } = await session($, on, { prices: OLD_PRICES })
    await turn(d, 't1')
    await h.advance(5 * MIN)
    expect(kept(h)).toMatchObject({ on: false })
  })

  test(`the compact event after an idle gap: pings stop, the size is replaced, and the return says what Claude did (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on)
    await turn(d, 't1')
    await h.advance(54 * MIN)
    h.compactTokens = { before: 200_000, after: 18_000 }
    await autoCompact($)
    expect(contextKept(h), 'the stored size is the summary\'s').toBe(18_000)
    expect(logOf(h)).toContain('idle compact: Claude compacted this session while it was idle (200000 to 18000 tokens)')
    await h.advance(4 * HOUR)
    expect(nothingDone(h).forks, 'no pings').toBe(0)
    h.rating = NO_CHANGE
    h.stepUsage = AFTER
    await d.submit('continue')
    expect(await bandText($, surface)).toContain('Claude compacted this while you were away (200K to 18K tokens).')
    expect(await bandText($, surface)).not.toContain('the cache went cold')
    await turn(d, 't2')
    expect(logOf(h)).not.toContain('cache missed on return')
  })

  test(`the return note carries the handoff path when whatsnext reports one (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on, { whatsnext: true })
    expect(h.commands).toEqual(WHATSNEXT_CMDS)
    await turn(d, 't1')
    await h.advance(54 * MIN)
    h.compactTokens = { before: 200_000, after: 18_000 }
    await autoCompact($)
    h.rating = NO_CHANGE
    h.stepUsage = AFTER
    await d.submit('continue')
    expect(await bandText($, surface)).toContain('Claude compacted this while you were away (200K to 18K tokens). Handoff: docs/project/HANDOFF.md')
  })

  test(`a drop in context after 50 minutes with no event is a boundary, found at the prompt from the live context (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on)
    await turn(d, 't1')
    await h.advance(55 * MIN)
    h.contextTokens = 17_000
    h.rating = NO_CHANGE
    h.stepUsage = AFTER
    await d.submit('continue')
    expect(await bandText($, surface)).toContain('Claude compacted this while you were away (200K to 17K tokens).')
    await turn(d, 't2')
    expect(logOf(h)).not.toContain('cache missed on return')
    expect(contextKept(h), 'the stored size follows the returning turn').toBe(18_500)
  })

  test(`with no live context and no event, the returning turn's first request finds the boundary and says it (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on)
    await turn(d, 't1')
    await h.advance(55 * MIN)
    h.rating = NO_CHANGE
    h.stepUsage = AFTER
    await d.submit('continue')
    expect(await bandText($, surface)).not.toContain('Claude compacted')
    await d.step('t2')
    expect(await bandText($, surface)).toContain('Claude compacted this while you were away (200K to 19K tokens).')
    await d.complete('t2')
    expect(logOf(h)).toContain('idle compact: Claude compacted this session while it was idle (200000 to 18500 tokens)')
  })

  test(`not a boundary: a gap under 50 minutes (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on)
    await turn(d, 't1')
    await h.advance(49 * MIN)
    h.contextTokens = 17_000
    h.rating = NO_CHANGE
    h.stepUsage = AFTER
    await d.submit('continue')
    await d.step('t2')
    expect(await bandText($, surface)).not.toContain('Claude compacted')
    expect(logOf(h)).not.toContain('idle compact:')
  })

  test(`not a boundary: the person ran /compact after the gap (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on)
    await turn(d, 't1')
    await h.advance(2 * HOUR)
    h.compactTokens = { before: 200_000, after: 18_000 }
    await compactAs($, 'manual')
    h.contextTokens = 18_000
    h.rating = NO_CHANGE
    h.stepUsage = AFTER
    await d.submit('continue')
    await d.step('t2')
    expect(await bandText($, surface)).not.toContain('Claude compacted')
    expect(logOf(h)).not.toContain('idle compact:')
  })

  test(`not a boundary: an auto-compact event under 50 minutes after the turn, and a long gap with no drop (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on)
    await turn(d, 't1')
    await h.advance(10 * MIN)
    await autoCompact($)
    expect(logOf(h)).not.toContain('idle compact:')
    await h.advance(2 * HOUR)
    h.contextTokens = 200_000
    h.rating = NO_CHANGE
    await d.submit('continue')
    await d.step('t2')
    expect(await bandText($, surface)).not.toContain('Claude compacted')
  })
}
