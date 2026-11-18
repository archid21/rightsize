import { expect, test } from 'claude-code/testing'
import type { LifeAdvice } from './cachelife'
import { type OptInput, appliedText, optimize, optimizeText, suggestionBody, suggestionHead } from './optimize'
import type { RunLine } from './report'

const NOW = Date.parse('2026-11-16T22:00:00Z')
const DAY = 24 * 60 * 60_000
const ago = (d: number) => new Date(NOW - d * DAY).toISOString()
/** 40 rated prompts over 20 days, each costing `actual`. */
const runs = (actual = 0.1): RunLine[] => Array.from({ length: 40 }, (_, k) => ({ at: ago(k / 2), kind: 'run', session: 's', actual }))
const pings = (n: number, overhead: number): RunLine[] => Array.from({ length: n }, (_, k) => ({ at: ago(k), kind: 'warm', session: 's', overhead }))
const base = (x: Partial<OptInput> = {}): OptInput => ({ lines: runs(), now: NOW, subscription: true, beforeCold: 'while it pays', bigTurn: 'auto', lowerRule: 'not set', skipped: {}, ...x })
const ids = (x: Partial<OptInput>) => optimize(base(x)).suggestions.map(s => s.id)

test('not enough use: under 30 rated prompts or 7 days, no suggestions', () => {
  expect(optimize(base({ lines: runs().slice(0, 20) }))).toMatchObject({ enough: false, prompts: 20, suggestions: [] })
  const oneDay = runs().map(l => ({ ...l, at: ago(0) }))
  expect(optimize(base({ lines: oneDay })).enough).toBe(false)
  expect(optimizeText(optimize(base({ lines: runs().slice(0, 20) })), true, true)).toContain('Not enough use to judge yet (20 rated prompts')
})

test('keep warm that cost more than it saved: suggest off, measured, with now and after', () => {
  const lines = [...runs(), ...pings(10, 2.475), { at: ago(1), kind: 'warmSaved' as const, session: 's', saved: 18.07 }]
  const [s] = optimize(base({ lines })).suggestions
  expect(s).toMatchObject({ id: 'beforeCold', from: 'while it pays', to: 'off' })
  expect(Number(s?.saving?.toFixed(2))).toBe(6.68)
  expect(s?.now).toBe('keep warm cost $24.75, saved $18.07  →  net $6.68 more')
  expect(s?.after).toBe('$0.00 spent, $0.00 saved  →  $6.68 less')
  expect(s?.basis.startsWith('Measured')).toBe(true)
})

test('keep warm: no suggestion when it paid, with too few requests, or when already off', () => {
  const paid = [...runs(), ...pings(10, 0.1), { at: ago(1), kind: 'warmSaved' as const, session: 's', saved: 5 }]
  expect(ids({ lines: paid })).toEqual([])
  expect(ids({ lines: [...runs(), ...pings(3, 2)] })).toEqual([])
  expect(ids({ lines: [...runs(), ...pings(10, 2)], beforeCold: 'off' })).toEqual([])
})

test('big-turn warning off with turns at the auto amount: suggest auto, with no saving promised', () => {
  // Under 50 turns, auto warns at $2: three turns reach it.
  const lines = [...runs(), { at: ago(1), kind: 'run' as const, session: 's', actual: 2.5 }, { at: ago(2), kind: 'run' as const, session: 's', actual: 3 }, { at: ago(3), kind: 'run' as const, session: 's', actual: 2 }]
  const s = optimize(base({ lines, bigTurn: 'off' })).suggestions.find(x => x.id === 'bigTurn')
  expect(s).toMatchObject({ from: 'off', to: 'auto', now: 'no warning', after: 'would have warned before 3 turns of $2.00 or more, $7.50 in all' })
  expect(s?.saving).toBeUndefined()
  expect(ids({ bigTurn: 'off' }), 'no turn reached it').toEqual([])
  expect(ids({ lines, bigTurn: '$2' }), 'already on').toEqual([])
})

const advice = (fiveMin: number, oneHour: number): LifeAdvice => ({ ok: true, cost: { fiveMin, oneHour, turns: 80, days: 12 }, cheaper: fiveMin < oneHour ? '5m' : '1h', saving: Math.abs(fiveMin - oneHour) })

test('cache life: the cheaper life when it is not the current one, estimated, both priced', () => {
  const s = optimize(base({ life: { advice: advice(9.8, 12.1), current: '1h' } })).suggestions[0]
  expect(s).toMatchObject({ id: 'promptCacheTtl', title: 'Cache life', from: '1 hour', to: '5 minutes', now: '$12.10 in cache writes', after: '$9.80  →  $2.30 less' })
  expect(s?.basis).toBe('Estimated: your last 80 turns priced at each cache life.')
  expect(ids({ life: { advice: advice(9.8, 12.1), current: '5m' } }), 'already the cheaper one').toEqual([])
  expect(ids({ life: { advice: { ok: false, turns: 3, days: 1 }, current: '1h' } })).toEqual([])
  expect(ids({}), 'not eligible: no life input').toEqual([])
})

/** `n` automatic lowerings over `days` days: each would have cost `stay`, really cost `actual`, and its switch missing the cache cost `miss`. */
const lowerings = (n: number, days: number, stay: number, actual: number, miss = 0): RunLine[] =>
  Array.from({ length: n }, (_, k) => ({ at: ago(k % days), kind: 'run' as const, session: 's', change: 'lower' as const, stay, actual, ...(miss ? { missCost: miss } : {}) }))
const lowerIds = (x: Partial<OptInput>) => optimize(base(x)).suggestions.filter(s => s.id === 'lowerRule')

test('lowering that saved about nothing: suggest never lower, measured, with now and after (P-78)', () => {
  // 40 lowered turns over 10 days, each $1.00 to stay and $0.995 really: a 0.5% saving, $0.20 in all.
  const [s] = lowerIds({ lines: [...runs(), ...lowerings(40, 10, 1, 0.995, 0.01)] })
  expect(s).toMatchObject({ id: 'lowerRule', title: 'Lowering', from: 'not set', to: 'never lower' })
  expect(s?.now).toBe('40 lowered turns saved $0.20, 0.5% of the $40.00 they would have cost, including $0.40 on turns that stepped back up')
  expect(s?.after).toBe('$0.00 saved  →  $0.20 less saved')
  expect(s?.basis.startsWith('Measured')).toBe(true)
  expect(s?.saving, 'turning it off loses a little: no saving is promised').toBeUndefined()
  expect(suggestionHead(s!, false)).toBe('☐ Lowering: not set → never lower')
  expect(optimizeText(optimize(base({ lines: [...runs(), ...lowerings(40, 10, 1, 0.995)] })), true, true)).toContain('☐ Lowering: not set → never lower')
})

test('lowering that cost more than staying: suggest never lower, with the dollars it would save', () => {
  const [s] = lowerIds({ lines: [...runs(), ...lowerings(40, 10, 1, 1.05)] })
  expect(s?.now).toBe('40 lowered turns cost $2.00 more than staying')
  expect(s?.after).toBe('$0.00 more  →  $2.00 less spent')
  expect(Number(s?.saving?.toFixed(6))).toBe(2)
})

test('lowering that saved 1% or less of what staying cost counts, and over 1% does not', () => {
  expect(lowerIds({ lines: [...runs(), ...lowerings(40, 10, 1, 0.991)] }), 'just under 1%').toHaveLength(1)
  expect(lowerIds({ lines: [...runs(), ...lowerings(40, 10, 1, 0.98)] }), '2%: it pays, leave it').toEqual([])
  expect(lowerIds({ lines: [...runs(), ...lowerings(40, 10, 1, 0.7)] }), 'clearly positive').toEqual([])
})

test('lowering: not under 30 lowered turns, not under 7 days of them, only the last 30 days', () => {
  expect(lowerIds({ lines: [...runs(), ...lowerings(29, 10, 1, 1.05)] }), '29 turns').toEqual([])
  expect(lowerIds({ lines: [...runs(), ...lowerings(40, 6, 1, 1.05)] }), '6 days').toEqual([])
  expect(lowerIds({ lines: [...runs(), ...lowerings(40, 7, 1, 1.05)] }), '30 turns over 7 days is enough').toHaveLength(1)
  const old = lowerings(40, 10, 1, 1.05).map(l => ({ ...l, at: ago(40 + Math.random()) }))
  expect(lowerIds({ lines: [...runs(), ...old] }), 'older than 30 days').toEqual([])
})

test('lowering: a lowering the person made themselves, a turn they stopped and a turn that is not a lowering are not counted', () => {
  const mine = lowerings(40, 10, 1, 1.05).map(l => ({ ...l, loweredBy: 'you' as const }))
  expect(lowerIds({ lines: [...runs(), ...mine] })).toEqual([])
  const stopped = lowerings(40, 10, 1, 1.05).map(l => ({ ...l, aborted: true }))
  expect(lowerIds({ lines: [...runs(), ...stopped] })).toEqual([])
  const raised = lowerings(40, 10, 1, 1.05).map(l => ({ ...l, change: 'raise' as const }))
  expect(lowerIds({ lines: [...runs(), ...raised] })).toEqual([])
})

test('lowering: not suggested when the Lowering row is set (theirs), or when hidden for 30 days', () => {
  const lines = [...runs(), ...lowerings(40, 10, 1, 1.05)]
  for (const lowerRule of ['ask me', 'lower automatically', 'never lower']) expect(lowerIds({ lines, lowerRule }), lowerRule).toEqual([])
  expect(lowerIds({ lines, skipped: { lowerRule: NOW - 10 * DAY } }), 'hidden').toEqual([])
  expect(lowerIds({ lines, skipped: { lowerRule: NOW - 31 * DAY } }), 'hidden over 30 days ago').toHaveLength(1)
})

test('lowering: listed after the other rows it follows, and the pane and the apply path know the row key', () => {
  const lines = [...runs(), ...pings(10, 2), ...lowerings(40, 10, 1, 1.05)]
  const r = optimize(base({ lines, bigTurn: 'off', life: { advice: advice(9.8, 12.1), current: '1h' } }))
  expect(r.suggestions.map(s => s.id)).toEqual(['beforeCold', 'bigTurn', 'lowerRule', 'promptCacheTtl'])
  expect(appliedText([r.suggestions[2]!], [])).toBe('Changed: Lowering → never lower. Did it work? in /rightsize report measures each once there are enough prompts.')
})

test('a suggestion left unpicked hides for 30 days, then shows again', () => {
  const life = { advice: advice(9.8, 12.1), current: '1h' as const }
  expect(ids({ life, skipped: { promptCacheTtl: NOW - 10 * DAY } })).toEqual([])
  expect(ids({ life, skipped: { promptCacheTtl: NOW - 31 * DAY } })).toEqual(['promptCacheTtl'])
})

test('every suggestion is listed, with no cap, and the text says nothing changes until applied', () => {
  const lines = [...runs(), ...pings(10, 2), { at: ago(1), kind: 'run' as const, session: 's', actual: 5 }]
  const r = optimize(base({ lines, bigTurn: 'off', life: { advice: advice(9.8, 12.1), current: '1h' } }))
  expect(r.suggestions.map(s => s.id)).toEqual(['beforeCold', 'bigTurn', 'promptCacheTtl'])
  const text = optimizeText(r, true, true)
  expect(text.split('\n').slice(0, 2)).toEqual(['Suggestions only: nothing changes until you apply them.', 'Last 30 days, API-equivalent dollars (you pay only your subscription).'])
  expect(text).toContain('☐ Cache life: 1 hour → 5 minutes')
  expect(text).toContain('    With 5 minutes:  $9.80  →  $2.30 less')
  expect(optimizeText(r, false, false)).toContain('Nothing was changed.')
  expect(optimizeText({ enough: true, prompts: 40, days: 20, suggestions: [] }, false, true)).toBe('No changes to suggest. Your settings fit your last 30 days.')
})

test('head, body and the applied line', () => {
  const s = optimize(base({ life: { advice: advice(9.8, 12.1), current: '1h' } })).suggestions[0]!
  expect(suggestionHead(s, true)).toBe('☑ Cache life: 1 hour → 5 minutes')
  expect(suggestionBody(s)[0]).toBe('Now:  $12.10 in cache writes')
  expect(appliedText([s], [])).toBe('Changed: Cache life → 5 minutes. Did it work? in /rightsize report measures each once there are enough prompts.')
  expect(appliedText([], [s])).toBe('Not changed (Claude Code did not take it): Cache life → 5 minutes.')
  expect(appliedText([], [])).toBe('Nothing changed.')
})
