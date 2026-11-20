import { type TestBody, expect, test } from 'claude-code/testing'
import { RUNS_FILE, LOG_PATH, LEGACY_RUNS, BIG_TURN, NO_CHANGE, NO_COLD, WHATSNEXT_CMDS, engine, drive, installWhatsnext, mount, rowText, untilAsked } from './testkit'
import { clockText } from './warm'

// The four "hide" rows in /config: Cold-compact tip, Context-size warning, Usage-limit advice and Tips. For each: the row set to off
// means the item never shows, the item's own "Don't show again" (or "Stop tips") button writes the row as off, with a toast that names
// the row, and on shows it again. A hide flag an older release kept in the store moves to its row once, at the session start.

const OPUS = { model: 'claude-opus-5-5', effort: 'medium' }
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const API = { billing: 'api' }

/** Both places a row's value lives in a test: the options the module is started with, and settings.json (`stored`). */
const row = (key: string, value: string, more: Record<string, string> = {}) => ({ options: { ...more, [key]: value }, stored: { ...more, [key]: value } })

for (const surface of ['desktop', 'terminal'] as const) {
  const log = (h: ReturnType<typeof engine>) => h.files[LOG_PATH] ?? ''
  const press = async ($: unknown, key: string) => {
    const ui = await mount($, surface)
    await ui.press({ key })
    await ui.unmount()
  }
  /** The ⋯ menu: answers with `choice` and says what the menu offered. */
  const menu = async ($: unknown, h: ReturnType<typeof engine>, choice: string) => {
    h.answers = { Options: choice }
    const before = h.asked.length
    const ui = await mount($, surface)
    await ui.press({ key: 'mode' })
    await untilAsked(h, before)
    await ui.unmount()
    return h.asked.slice(before)
  }
  const cacheRow = async ($: unknown) => {
    const ui = await mount($, surface)
    const text = await rowText(ui, 'Cache')
    const buttons = (await ui.findAll({ type: 'Button' })).map(b => b.key)
    await ui.unmount()
    return { text, buttons }
  }
  const tipRow = async ($: unknown) => {
    const ui = await mount($, surface)
    const text = await rowText(ui, 'Tip')
    await ui.unmount()
    return text
  }

  // ---- Cold-compact tip (coldTip) ----------------------------------------------------------------------------------

  /** 18:00 local on Friday 2027-01-15. */
  const EVENING = new Date(2027, 0, 15, 18, 0, 0, 0).getTime()
  const TIP = 'Cache is cold. Compact on Sonnet first to save'
  const BIG = 180_000
  const coldSession = async ($: unknown, on: Parameters<TestBody>[1], stored: Record<string, string>, store: Record<string, unknown> = {}) => {
    const h = engine(on, { ...OPUS, stored: { beforeCold: 'ask', ...stored }, store })
    h.now = EVENING
    h.virtual = true
    h.rating = NO_CHANGE
    h.stepUsage = { ...BIG_TURN, cache_read_input_tokens: BIG - 500 }
    h.commands = WHATSNEXT_CMDS
    installWhatsnext(h)
    const d = drive($, h)
    await d.start(surface)
    return { h, d }
  }
  const coldTurn = async (d: ReturnType<typeof drive>, h: ReturnType<typeof engine>) => {
    await d.step('t1')
    await d.complete('t1')
    await h.advance(59 * MIN)
    await h.advance(2 * MIN)
  }

  test(`Cold-compact tip off: the tip is never offered, even after the cache goes cold on a big chat (${surface})`, { timeoutMs: 30000, ...row('coldTip', 'off', { beforeCold: 'ask' }) }, async ($, on) => {
    const { h, d } = await coldSession($, on, { coldTip: 'off' })
    await coldTurn(d, h)
    expect(log(h)).not.toContain('cold-compact tip: offered')
    expect((await cacheRow($)).text).not.toContain(TIP)
  })

  test(`Cold-compact tip on: the tip is offered once the cache goes cold on a big chat (${surface})`, { timeoutMs: 30000, ...row('coldTip', 'on', { beforeCold: 'ask' }) }, async ($, on) => {
    const { h, d } = await coldSession($, on, { coldTip: 'on' })
    await coldTurn(d, h)
    expect(log(h)).toContain('cold-compact tip: offered')
    expect((await cacheRow($)).text).toContain(TIP)
  })

  test(`Cold-compact tip: Don't show again sets the row to off, toasts the row's name, and the tip stays away (${surface})`, { timeoutMs: 30000, options: {} }, async ($, on) => {
    const { h, d } = await coldSession($, on, { beforeCold: 'off' }, { lastTurns: { 'sess-1': { at: EVENING - 3 * HOUR, context: BIG } } })
    expect((await cacheRow($)).text, 'a reopened cold chat gets the tip at the start').toContain(TIP)
    const asked = await menu($, h, "Don't show again")
    expect(asked[0]?.options).toContain("Don't show again")
    expect(h.stored.coldTip).toBe('off')
    expect(h.configSet).toContain('off')
    expect(h.toasts[h.toasts.length - 1]).toBe('Rightsize: the cold-compact tip is hidden. Turn it back on with Cold-compact tip in /config.')
    expect((await cacheRow($)).text).not.toContain(TIP)
    expect(h.store.coldTipHidden, 'no flag in the store: the row is the record').toBeUndefined()
    await d.start(surface)
    expect(log(h).split('cold-compact tip: offered').length - 1, 'not offered again at the next start').toBe(1)
  })

  // ---- Context-size warning (sizeWarning) --------------------------------------------------------------------------

  const sizeSession = (on: Parameters<TestBody>[1], tokens: number, stored: Record<string, string>, store: Record<string, unknown> = {}) => {
    // Low effort: nothing to lower, so the band has no route row and ⋯ is the cache row's menu alone.
    const h = engine(on, { ...OPUS, effort: 'low', stored: { ...NO_COLD, ...API, cacheTimer: 'off', ...stored }, store })
    h.rating = NO_CHANGE
    h.contextTokens = tokens
    return h
  }
  const turn = async (d: ReturnType<typeof drive>, id: string) => {
    await d.submit('continue')
    await d.turnStart(id, 'continue')
    await d.step(id)
    await d.complete(id)
  }

  test(`Context-size warning off: no warning at 60% (${surface})`, { timeoutMs: 30000, ...row('sizeWarning', 'off', { ...API, cacheTimer: 'off' }) }, async ($, on) => {
    const h = sizeSession(on, 120_000, { sizeWarning: 'off' })
    const d = drive($, h)
    await d.start(surface)
    await turn(d, 't1')
    expect((await cacheRow($)).text).toBe('')
    expect(log(h)).not.toContain('context warning: shown')
  })

  test(`Context-size warning on: the warning shows at 60% (${surface})`, { timeoutMs: 30000, ...row('sizeWarning', 'on', { ...API, cacheTimer: 'off' }) }, async ($, on) => {
    const h = sizeSession(on, 120_000, { sizeWarning: 'on' })
    const d = drive($, h)
    await d.start(surface)
    await turn(d, 't1')
    expect((await cacheRow($)).text).toContain('Context is 60% full')
    expect(log(h)).toContain('context warning: shown at 60%')
  })

  test(`Context-size warning: Don't show again sets the row to off, toasts the row's name, and later steps stay quiet (${surface})`, { timeoutMs: 30000, options: { ...API, cacheTimer: 'off' } }, async ($, on) => {
    const h = sizeSession(on, 120_000, {})
    const d = drive($, h)
    await d.start(surface)
    await turn(d, 't1')
    expect((await cacheRow($)).text).toContain('Context is 60% full')
    await menu($, h, "Don't show again")
    expect(h.stored.sizeWarning).toBe('off')
    expect(h.toasts[h.toasts.length - 1]).toBe('Rightsize: the context-size warning is hidden. Turn it back on with Context-size warning in /config.')
    expect((await cacheRow($)).text).toBe('')
    expect(h.store.sizeWarningHidden, 'no flag in the store').toBeUndefined()
    h.contextTokens = 190_000
    await turn(d, 't2')
    expect((await cacheRow($)).text).toBe('')
  })

  // ---- Usage-limit advice (limitAdvice) ----------------------------------------------------------------------------

  /** A main request that read 100,000 tokens in all: on Opus a compaction now saves $0.59 after the reset. */
  const LIMIT_USAGE = { input_tokens: 200, output_tokens: 400, cache_read_input_tokens: 99_500, cache_creation_input_tokens: 300 }
  const limitSession = (on: Parameters<TestBody>[1], stored: Record<string, string>) => {
    const h = engine(on, { ...OPUS, effort: 'low', stored: { ...NO_COLD, ...API, ...stored } })
    h.rating = NO_CHANGE
    h.stepUsage = LIMIT_USAGE
    h.commands = []
    h.rateLimits = [{ kind: 'five_hour', percentUsed: 92, resetsAt: new Date(h.now + 3 * HOUR).toISOString() }]
    return h
  }
  const SHOWN = (h: ReturnType<typeof engine>) => `Near your 5-hour limit, resets ${clockText(h.now + 3 * HOUR)}. Compact now to save ~$0.59 after the reset.`
  /** A warm-up turn at a low-use moment, so the once-a-window advice is not spent on it. */
  const warmUp = async (d: ReturnType<typeof drive>, h: ReturnType<typeof engine>) => {
    const rl = h.rateLimits
    h.rateLimits = []
    await d.step('t0')
    await d.complete('t0')
    h.rateLimits = rl
  }

  test(`Usage-limit advice off: no advice near the limit (${surface})`, { timeoutMs: 30000, ...row('limitAdvice', 'off', { ...API, cacheTimer: 'off' }) }, async ($, on) => {
    const h = limitSession(on, { limitAdvice: 'off', cacheTimer: 'off' })
    const d = drive($, h)
    await d.start(surface)
    await turn(d, 't1')
    expect((await cacheRow($)).text).toBe('')
    expect(log(h)).not.toContain('usage-limit advice: shown')
    expect(h.store.limitAdviceWindow, 'the window is not spent').toBeUndefined()
  })

  test(`Usage-limit advice on: the advice shows near the limit (${surface})`, { timeoutMs: 30000, ...row('limitAdvice', 'on', { ...API, cacheTimer: 'off' }) }, async ($, on) => {
    const h = limitSession(on, { limitAdvice: 'on', cacheTimer: 'off' })
    const d = drive($, h)
    await d.start(surface)
    await turn(d, 't1')
    expect((await cacheRow($)).text).toBe(SHOWN(h))
  })

  test(`Usage-limit advice: Don't show again sets the row to off, toasts the row's name, and a later window stays quiet (${surface})`, { timeoutMs: 30000, options: { ...API, cacheTimer: 'off' } }, async ($, on) => {
    const h = limitSession(on, { cacheTimer: 'off' })
    const d = drive($, h)
    await d.start(surface)
    await warmUp(d, h)
    await turn(d, 't1')
    expect((await cacheRow($)).text).toBe(SHOWN(h))
    await menu($, h, "Don't show again")
    expect(h.stored.limitAdvice).toBe('off')
    expect(h.toasts[h.toasts.length - 1]).toBe('Rightsize: the usage-limit advice is hidden. Turn it back on with Usage-limit advice in /config.')
    expect((await cacheRow($)).text).toBe('')
    expect(h.store.limitAdviceHidden, 'no flag in the store').toBeUndefined()
    h.rateLimits = [{ kind: 'five_hour', percentUsed: 95, resetsAt: new Date(h.now + 8 * HOUR).toISOString() }]
    await turn(d, 't2')
    expect((await cacheRow($)).text, 'a new window').toBe('')
  })

  // ---- Tips (tips): the band Tip row, the Star on GitHub ask, the whatsnext install hint ---------------------------

  /** A run line of this session that saved money: the session's net is a saving, so the report tip is due. */
  const SAVED = (now: number) => JSON.stringify({ at: new Date(now - 60_000).toISOString(), kind: 'run', session: 'sess-1', change: 'lower', offered: 'lower', actual: 0.5, stay: 1, taken: 0.5, overhead: 0.01 })
  const tipSession = (on: Parameters<TestBody>[1], stored: Record<string, string>, store: Record<string, unknown> = { tips: undefined }) => {
    const h = engine(on, { ...OPUS, stored, store })
    h.files[RUNS_FILE] = SAVED(h.now)
    return h
  }

  test(`Tips off: no band tip after a saving, and nothing is spent (${surface})`, { timeoutMs: 30000, ...row('tips', 'off') }, async ($, on) => {
    const h = tipSession(on, { tips: 'off' })
    const d = drive($, h)
    await d.start(surface)
    await d.complete('t0')
    expect(await tipRow($)).toBe('')
    expect((h.store.tips as { seen: string[] } | undefined)?.seen ?? [], 'nothing spent').toEqual([])
  })

  test(`Tips on: the band tip shows after a saving (${surface})`, { timeoutMs: 30000, ...row('tips', 'on') }, async ($, on) => {
    const h = tipSession(on, { tips: 'on' })
    const d = drive($, h)
    await d.start(surface)
    await d.complete('t0')
    expect(await tipRow($)).not.toBe('')
  })

  test(`Tips off: no Star on GitHub ask, and GitHub is not asked (${surface})`, { timeoutMs: 30000, ...row('tips', 'off') }, async ($, on) => {
    const h = tipSession(on, { tips: 'off' }, { tips: { tipsOff: false, seen: ['report'] } })
    h.gh = { starred: {}, canStar: true }
    const d = drive($, h)
    await d.start(surface)
    await d.complete('t0')
    expect(await tipRow($)).toBe('')
    expect(h.ran.some(a => a[0] === 'gh'), 'GitHub is not asked').toBe(false)
    expect((JSON.parse(h.stars ?? '{}') as { claim?: unknown }).claim, 'no claim on the ask').toBeUndefined()
  })

  test(`Tips on: the Star on GitHub ask shows (${surface})`, { timeoutMs: 30000, ...row('tips', 'on') }, async ($, on) => {
    const h = tipSession(on, { tips: 'on' }, { tips: { tipsOff: false, seen: ['report'] } })
    h.gh = { starred: {}, canStar: true }
    const d = drive($, h)
    await d.start(surface)
    await d.complete('t0')
    expect(await tipRow($)).toContain('Star')
  })

  test(`Tips: Stop tips sets the row to off and toasts the row's name; /rightsize tips sets it back to on (${surface})`, { timeoutMs: 30000, options: {} }, async ($, on) => {
    const h = tipSession(on, {})
    const d = drive($, h)
    await d.start(surface)
    await d.complete('t0')
    expect(await tipRow($)).not.toBe('')
    await press($, 'tip-stop')
    expect(h.stored.tips).toBe('off')
    expect(h.toasts[h.toasts.length - 1]).toBe('Rightsize: tips are off. Turn them back on with Tips in /config, or /rightsize tips.')
    expect(await tipRow($)).toBe('')
    await d.complete('t1')
    expect(await tipRow($), 'off stays off').toBe('')
    expect(await d.command('tips')).toEqual({ text: 'Tips are on. The first one is on the band.' })
    expect(h.stored.tips).toBe('on')
    expect(await tipRow($)).not.toBe('')
  })

  const rep = (n: number, gapMin: number) => Array.from({ length: n }, () => ({ gapMin, ended: 'cold' }))
  /** The install-hint scenario: 20 stretches that all come back at 5 hours, so the compaction gate compacts at 57 minutes with no note to save. */
  const hintSession = async ($: unknown, on: Parameters<TestBody>[1], stored: Record<string, string>, store: Record<string, unknown> = {}) => {
    const h = engine(on, { ...OPUS, stored, store: { installHintAt: undefined, initHinted: [], ...store } })
    h.now = EVENING
    h.virtual = true
    h.stepUsage = BIG_TURN
    h.commands = []
    h.inGit = true
    h.files[LEGACY_RUNS] = `${rep(20, 300).map((s, i) => JSON.stringify({ at: new Date(EVENING - (i + 1) * HOUR).toISOString(), kind: 'idle', session: 'earlier', gapMs: s.gapMin * MIN, ended: s.ended, hour: 9, weekday: 2, billing: 'api', ttl: HOUR, context: 80_500, cold: 0.6279 })).join('\n')}\n`
    // Three past compacts with 20K-token summaries: estimates use that size (P-85), so a note would save over the hint's $0.25 here.
    h.files[LEGACY_RUNS] += [1, 2, 3].map(i => JSON.stringify({ at: new Date(EVENING - i * 24 * HOUR).toISOString(), kind: 'compactSaved', session: 'earlier', compactId: `earlier-${i}`, compactSource: 'button', tier: 'opus', ctxBefore: 150_000, ctxAfter: 20_000, cut: 130_000, compactCost: 0.3, saved: 0.1, requests: 5, stop: 'session end' })).join('\n') + '\n'
    const d = drive($, h)
    await d.start(surface)
    return { h, d }
  }
  const hintTurn = async (d: ReturnType<typeof drive>, h: ReturnType<typeof engine>) => {
    await d.step('t1')
    await d.complete('t1')
    await h.advance(57 * MIN)
  }

  test(`Tips off: the whatsnext install hint stays off the row after a compaction (${surface})`, { timeoutMs: 30000, ...row('tips', 'off') }, async ($, on) => {
    const { h, d } = await hintSession($, on, { tips: 'off' })
    await hintTurn(d, h)
    expect(h.compactions).toBe(1)
    expect((await cacheRow($)).text).toBe('Compacted while the cache was warm.')
    expect(h.store.installHintAt, 'no time kept').toBeUndefined()
  })

  test(`Tips on: the whatsnext install hint shows after a compaction (${surface})`, { timeoutMs: 30000, ...row('tips', 'on') }, async ($, on) => {
    const { h, d } = await hintSession($, on, { tips: 'on' })
    await hintTurn(d, h)
    expect((await cacheRow($)).text).toContain('A whatsnext handoff note')
  })

  test(`Tips: Don't show again on the install hint sets the row to off and toasts the row's name (${surface})`, { timeoutMs: 30000, options: {} }, async ($, on) => {
    const { h, d } = await hintSession($, on, {})
    await hintTurn(d, h)
    expect((await cacheRow($)).text).toContain('A whatsnext handoff note')
    await menu($, h, "Don't show again")
    expect(h.stored.tips).toBe('off')
    expect(h.toasts[h.toasts.length - 1]).toBe('Rightsize: the whatsnext hint is hidden. Turn it back on with Tips in /config.')
    expect((await cacheRow($)).text).toBe('')
    expect(h.store.installHintHidden, 'no flag kept as true').not.toBe(true)
  })

  // ---- Old hide flags move to their rows once ----------------------------------------------------------------------

  test(`a hide flag an older release kept moves to its row at the start, and the flag is cleared (${surface})`, { timeoutMs: 30000, options: {} }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: { coldTipHidden: true, sizeWarningHidden: true, limitAdviceHidden: true, installHintHidden: true, tips: { tipsOff: true, seen: ['report'] } } })
    const d = drive($, h)
    await d.start(surface)
    expect(h.stored.coldTip).toBe('off')
    expect(h.stored.sizeWarning).toBe('off')
    expect(h.stored.limitAdvice).toBe('off')
    expect(h.stored.tips).toBe('off')
    expect(h.store.coldTipHidden).toBeNull()
    expect(h.store.sizeWarningHidden).toBeNull()
    expect(h.store.limitAdviceHidden).toBeNull()
    expect(h.store.installHintHidden).toBeNull()
    expect(h.store.tips, 'the seen list stays; the off flag is cleared').toEqual({ tipsOff: false, seen: ['report'] })
    expect(log(h)).toContain('hide flags moved to their /config rows')
  })

  test(`each old flag moves only its own row (${surface})`, { timeoutMs: 30000, options: {} }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: { sizeWarningHidden: true } })
    const d = drive($, h)
    await d.start(surface)
    expect(h.stored.sizeWarning).toBe('off')
    expect(h.stored.coldTip).toBeUndefined()
    expect(h.stored.limitAdvice).toBeUndefined()
    expect(h.stored.tips).toBeUndefined()
  })

  test(`a flag that is not set, or false, writes nothing (${surface})`, { timeoutMs: 30000, options: {} }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: { coldTipHidden: false, installHintHidden: false, tips: { tipsOff: false, seen: [] } } })
    const d = drive($, h)
    await d.start(surface)
    expect(h.configSet.filter(v => v === 'off')).toEqual([])
    expect(h.stored.coldTip).toBeUndefined()
    expect(h.stored.tips).toBeUndefined()
  })

  test(`a moved flag keeps the item hidden: the migrated tip stays away, and the row can be turned back on (${surface})`, { timeoutMs: 30000, options: { beforeCold: 'ask' } }, async ($, on) => {
    const { h, d } = await coldSession($, on, {}, { coldTipHidden: true })
    await coldTurn(d, h)
    expect(h.stored.coldTip).toBe('off')
    expect(log(h)).not.toContain('cold-compact tip: offered')
    await d.config('coldTip', 'on')
    await d.step('t2')
    await d.complete('t2')
    await h.advance(61 * MIN)
    expect(log(h)).toContain('cold-compact tip: offered')
  })
}
