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
const base = (x: Partial<OptInput> = {}): OptInput => ({ lines: runs(), now: NOW, subscription: true, beforeCold: 'while it pays', lowerRule: 'not set', skipped: {}, ...x })
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
  expect(s?.basis, 'staying is an estimate (counterfactual), so the label says Estimated (P-87)').toBe('Estimated: what those turns cost against an estimate of staying at your own effort.')
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
  const r = optimize(base({ lines, life: { advice: advice(9.8, 12.1), current: '1h' } }))
  expect(r.suggestions.map(s => s.id)).toEqual(['beforeCold', 'lowerRule', 'promptCacheTtl'])
  expect(appliedText([r.suggestions[1]!], [])).toBe('Changed: Lowering → never lower. Did it work? in /rightsize report measures each once there are enough prompts.')
})

// ---- Hand-downs (P-89, ADR 0100) -------------------------------------------------

/** `n` hand-down turns over `days` days on `route`: each would have cost `stay`, really cost `actual`. */
const handDowns = (n: number, days: number, stay: number, actual: number, route = 'delegate:haiku', x: Partial<RunLine> = {}): RunLine[] =>
  Array.from({ length: n }, (_, k) => ({ at: ago(k % days), kind: 'run' as const, session: 's', id: `hd-${route}-${k}`, change: 'delegate-down' as const, route, stay, actual, agentCalls: 1, ...x }))
/** `n` subagent runs over `days` days: each cost `actual`, and the same work on the parent's model would have cost `actual` times `ratio`. */
const subs = (n: number, days: number, ratio: number, actual = 1, x: Partial<RunLine> = {}): RunLine[] =>
  Array.from({ length: n }, (_, k) => ({ at: ago(k % days), kind: 'subagent' as const, session: 's', run: `r-${k}`, estimate: 1, parentEstimate: ratio, actual, ...x }))
const only = (id: string, x: Partial<OptInput>) => optimize(base(x)).suggestions.filter(s => s.id === id)
const HAIKU_TO_OFF = 'Use Haiku'
const BASIS = 'Estimated: what those turns cost against an estimate of staying on your own model.'

test('Haiku hand-downs that saved about nothing: suggest Use Haiku off, estimated, with now, after and a quality note (P-89)', () => {
  // 40 hand-downs over 10 days, each $1.00 to stay and $0.995 really: a 0.5% saving, $0.20 in all. Two of them showed a failure sign.
  const lines = [...runs(), ...handDowns(40, 10, 1, 0.995, 'delegate:haiku', {}).map((l, k) => (k < 2 ? { ...l, tests: 'failed' as const } : l))]
  const [s] = only('useHaiku', { lines })
  expect(s).toMatchObject({ id: 'useHaiku', title: HAIKU_TO_OFF, from: 'on', to: 'off', basis: BASIS })
  expect(s?.now).toBe('40 Haiku hand-down turns saved $0.20, 0.5% of the $40.00 they would have cost')
  expect(s?.after).toBe('$0.00 saved  →  $0.20 less saved')
  expect(s?.saving, 'turning it off loses a little: no saving is promised').toBeUndefined()
  expect(s?.note).toBe('Quality: 2 of 40 turns (5%) showed a failure sign (a struggling or returned helper, rework, failed tests, or a 👎, correction or undo).')
  expect(suggestionHead(s!, false)).toBe('☐ Use Haiku: on → off')
  expect(suggestionBody(s!)).toEqual([`Now:  ${s?.now}`, `With off:  ${s?.after}`, BASIS, s?.note])
  expect(optimizeText(optimize(base({ lines })), true, true)).toContain('    Quality: 2 of 40 turns (5%)')
})

test('hand-downs that cost more than staying: suggest it off, with the dollars it would save (P-89)', () => {
  const [s] = only('useHaiku', { lines: [...runs(), ...handDowns(40, 10, 1, 1.05)] })
  expect(s?.now).toBe('40 Haiku hand-down turns cost $2.00 more than staying')
  expect(s?.after).toBe('$0.00 more  →  $2.00 less spent')
  expect(Number(s?.saving?.toFixed(6))).toBe(2)
  expect(s?.note).toBe('Quality: none of the 40 turns showed a failure sign.')
})

test('Claude\'s subagents: suggest off when the moved subagents saved 1% or less or cost more (P-89)', () => {
  // ratio 1.005: staying would have cost $1.005 against $1.00 really: $0.20 saved of $40.20.
  const [s] = only('subagents', { lines: [...runs(), ...subs(40, 10, 1.005)] })
  expect(s).toMatchObject({ id: 'subagents', title: "Claude's subagents", from: 'cheaper when it fits', to: 'off', basis: 'Estimated: what those runs cost against an estimate of the same work on your own model.' })
  expect(s?.now).toBe('40 moved subagent runs saved $0.20, 0.5% of the $40.20 they would have cost')
  const [lost] = only('subagents', { lines: [...runs(), ...subs(40, 10, 0.95)] })
  expect(lost?.now).toBe('40 moved subagent runs cost $2.00 more than staying')
  expect(Number(lost?.saving?.toFixed(6))).toBe(2)
})

test('Cheaper model: suggest "stay, lower effort only" on every hand-down, Haiku or not (P-89)', () => {
  const lines = [...runs(), ...handDowns(20, 10, 1, 1.05, 'delegate:haiku'), ...handDowns(20, 10, 1, 1.05, 'delegate:sonnet')]
  const [s] = only('downRule', { lines })
  expect(s).toMatchObject({ id: 'downRule', title: 'Cheaper model', from: 'not set', to: 'stay, lower effort only' })
  expect(s?.now).toBe('40 hand-down turns cost $2.00 more than staying')
  expect(only('useHaiku', { lines }), 'only 20 of them are Haiku').toEqual([])
})

test('hand-downs that pay (over 1% saved) are not suggested against (P-89)', () => {
  expect(ids({ lines: [...runs(), ...handDowns(40, 10, 1, 0.98), ...subs(40, 10, 1.02)] }), '2%').toEqual([])
  expect(ids({ lines: [...runs(), ...handDowns(40, 10, 1, 0.991), ...subs(40, 10, 1.009)] }).sort(), 'just under 1% counts').toEqual(['downRule', 'subagents', 'useHaiku'])
  expect(ids({ lines: [...runs(), ...handDowns(40, 10, 1, 0.5), ...subs(40, 10, 3)] }), 'clearly positive').toEqual([])
})

test('hand-downs: not under 30 turns, not under 7 days of them, only the last 30 days, no stopped turn and no hand-up (P-89)', () => {
  const some = (l: RunLine[]) => ids({ lines: [...runs(), ...l] })
  expect(some(handDowns(29, 10, 1, 1.05)), '29 turns').toEqual([])
  expect(some(handDowns(40, 6, 1, 1.05)), '6 days').toEqual([])
  expect(some(handDowns(30, 7, 1, 1.05)).sort(), '30 turns over 7 days is enough').toEqual(['downRule', 'useHaiku'])
  expect(some(handDowns(40, 10, 1, 1.05).map(l => ({ ...l, at: ago(40 + Math.random()) }))), 'older than 30 days').toEqual([])
  expect(some(handDowns(40, 10, 1, 1.05).map(l => ({ ...l, aborted: true }))), 'stopped').toEqual([])
  expect(some(handDowns(40, 10, 1, 1.05, 'delegate:fable').map(l => ({ ...l, change: 'delegate-up' as const }))), 'a hand-up').toEqual([])
  expect(some(subs(29, 10, 0.95)), '29 subagent runs').toEqual([])
  expect(some(subs(40, 6, 0.95)), 'subagents over 6 days').toEqual([])
})

test('hand-downs: not suggested when the row is the person\'s own, or already off (P-89)', () => {
  const lines = [...runs(), ...handDowns(40, 10, 1, 1.05), ...subs(40, 10, 0.95)]
  expect(ids({ lines }).sort(), 'defaults').toEqual(['downRule', 'subagents', 'useHaiku'])
  expect(ids({ lines, yours: new Set(['useHaiku', 'subagents'] as const) }), 'on and set by them: theirs').toEqual(['downRule'])
  for (const downRule of ['ask first', 'always send', 'stay, lower effort only', 'ask each time']) expect(only('downRule', { lines, downRule }), downRule).toEqual([])
  expect(ids({ lines, useHaiku: 'off', subagents: 'off' }), 'already off').toEqual(['downRule'])
})

test('hand-downs: each hides for 30 days when left unpicked (P-89)', () => {
  const lines = [...runs(), ...handDowns(40, 10, 1, 1.05), ...subs(40, 10, 0.95)]
  for (const id of ['useHaiku', 'subagents', 'downRule'] as const) {
    expect(ids({ lines, skipped: { [id]: NOW - 10 * DAY } }), id).not.toContain(id)
    expect(ids({ lines, skipped: { [id]: NOW - 10 * DAY } }), `${id} hides only itself`).toHaveLength(2)
    expect(ids({ lines, skipped: { [id]: NOW - 31 * DAY } }), `${id} after 30 days`).toContain(id)
  }
})

test('the quality note counts a failure sign once per turn, from the helper, the tests, the rework and the person; it never triggers a suggestion (P-89)', () => {
  const mark = (n: number, f: (l: RunLine, k: number) => RunLine) => handDowns(40, 10, 1, 1.05).map((l, k) => (k < n ? f(l, k) : l))
  const helper = (stall?: 'struggling' | 'blocked', returned?: true) => ({ steps: 3, ms: 1, errors: 0, blocked: 0, agent: 'a', kind: 'handoff' as const, ...(stall ? { stall } : {}), ...(returned ? { returned } : {}) })
  const lines = mark(8, (l, k) => (k === 0 ? { ...l, tests: 'failed' as const } : k === 1 ? { ...l, helpers: [helper('struggling')] } : k === 2 ? { ...l, helpers: [helper(undefined, true)] } : k === 3 ? { ...l, agentCalls: 2 } : k === 4 ? { ...l, helpers: [helper('blocked')] } : k === 5 ? { ...l, tests: 'failed' as const, agentCalls: 3 } : l))
  // k=4 is blocked (the environment's fault: no sign); k=5 shows two signs but counts once; k=6 and k=7 are told by the person.
  const told: RunLine[] = [
    { at: ago(0), kind: 'feedback', session: 's', ref: 'hd-delegate:haiku-6', value: 'down' },
    { at: ago(0), kind: 'corrected', session: 's', ref: 'hd-delegate:haiku-7' },
    { at: ago(0), kind: 'feedback', session: 's', ref: 'hd-delegate:haiku-8', value: 'up' },
  ]
  const [s] = only('useHaiku', { lines: [...runs(), ...lines, ...told] })
  expect(s?.note).toBe('Quality: 7 of 40 turns (18%) showed a failure sign (a struggling or returned helper, rework, failed tests, or a 👎, correction or undo).')
  // Failures alone suggest nothing: a hand-down that paid, with half its turns failing, is left alone.
  const paying = handDowns(40, 10, 1, 0.5, 'delegate:haiku', { tests: 'failed' })
  expect(ids({ lines: [...runs(), ...paying] })).toEqual([])
  // And a subagent run's own stall, or its parent run's 👎, counts for the subagents row.
  const ss = subs(40, 10, 0.95).map((l, k) => (k === 0 ? { ...l, stall: 'struggling' as const } : k === 1 ? { ...l, returned: true as const } : k === 2 ? { ...l, run: 'p' } : l))
  const [sub] = only('subagents', { lines: [...runs(), ...ss, { at: ago(0), kind: 'feedback' as const, session: 's', ref: 'p', value: 'down' as const }] })
  expect(sub?.note).toBe('Quality: 3 of 40 runs (8%) showed a failure sign (a struggling or returned subagent, or a 👎, correction or undo on the run it came from).')
})

test('hand-down suggestions come after Lowering and before Cache life, and the apply line names the row (P-89)', () => {
  const lines = [...runs(), ...pings(10, 2), ...lowerings(40, 10, 1, 1.05), ...handDowns(40, 10, 1, 1.05), ...subs(40, 10, 0.95)]
  const r = optimize(base({ lines, life: { advice: advice(9.8, 12.1), current: '1h' } }))
  expect(r.suggestions.map(s => s.id)).toEqual(['beforeCold', 'lowerRule', 'useHaiku', 'subagents', 'downRule', 'promptCacheTtl'])
  expect(appliedText(r.suggestions.slice(2, 5), [])).toBe("Changed: Use Haiku → off; Claude's subagents → off; Cheaper model → stay, lower effort only. Did it work? in /rightsize report measures each once there are enough prompts.")
})

// ---- Keep warm replay (P-90, ADR 0101) ---------------------------------------------

const HOUR_MS = 60 * 60_000
/** One idle stretch that closed `ago(d)`: away `gapMs`, back `ended`, on a 1-hour cache, with a cold return of $10. */
const idle = (d: number, gapMs: number, ended: 'warm' | 'cold' | 'never' = 'cold', x: Partial<RunLine> = {}): RunLine => ({ at: ago(d), kind: 'idle', session: 's', gapMs, ended, hour: 17, weekday: 2, billing: 'subscription', ttl: HOUR_MS, context: 100_000, cold: 10, ...x })
const stretches = (n: number, gapMs: number, ended: 'warm' | 'cold' | 'never' = 'cold') => Array.from({ length: n }, (_, k) => idle(k / 2, gapMs, ended))
/** One keep-warm request costs $0.50, so keeping warm pays up to 20 requests (a cold return costs $10). */
const ping = () => 0.5
const replay = (lines: RunLine[], beforeCold: string, x: Partial<OptInput> = {}) => optimize(base({ lines: [...runs(), ...lines], beforeCold, ping, ...x })).suggestions.filter(s => s.id === 'beforeCold')

test('a fixed keep-warm that costs more than while it pays on your own gaps: suggest while it pays, from each fixed value (P-90)', () => {
  // 30 stretches away 16 hours: nobody comes back inside any keep-warm window.
  const lines = stretches(30, 16 * HOUR_MS)
  const [two] = replay(lines, 'keep warm 2 h')
  expect(two).toMatchObject({ id: 'beforeCold', title: 'Before the cache goes cold', from: 'keep warm 2 h', to: 'while it pays' })
  // 2 h keeps warm 2 requests a stretch ($1.00): 60 requests, $30.00. While it pays has no record for the first 20 stretches (one request each), then none: 20 requests, $10.00.
  expect(two?.now).toBe('60 requests cost $30.00, saved $0.00  →  net $30.00 more')
  expect(two?.after).toBe('20 requests cost $10.00, saved $0.00  →  net $10.00 more')
  expect(two?.basis).toBe('Estimated: your last 30 idle gaps replayed under each setting.')
  expect(Number(two?.saving?.toFixed(6))).toBe(20)
  const [eight] = replay(lines, 'keep warm 8 h')
  expect(eight).toMatchObject({ from: 'keep warm 8 h', to: 'while it pays' })
  expect(eight?.now).toBe('240 requests cost $120.00, saved $0.00  →  net $120.00 more')
  expect(Number(eight?.saving?.toFixed(6))).toBe(110)
  expect(suggestionHead(eight!, false)).toBe('☐ Before the cache goes cold: keep warm 8 h → while it pays')
})

test('keep warm until my usual start is replayed to that start, not to 8 hours (P-90)', () => {
  // Local times, so the test does not depend on the time zone: 14 days of prompts at 9:00, and each night a stretch from 5:00 to 9:00 the same day... away 16 hours.
  const local = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).toISOString()
  const day = (d: number): RunLine[] => [0, 1, 2].map(k => ({ at: local(d, 9, 5 + k), kind: 'run' as const, session: 's', submittedAt: local(d, 9, k), actual: 0.1 }))
  const days = Array.from({ length: 14 }, (_, k) => k + 2)
  const mine = days.flatMap(day)
  const gaps = days.map(d => ({ ...idle(0, 16 * HOUR_MS), at: new Date(new Date(2026, 10, d, 5, 0).getTime() + 16 * HOUR_MS).toISOString() }))
  const [s] = optimize(base({ lines: [...mine, ...gaps], beforeCold: 'keep warm until my usual start', ping })).suggestions
  // From 5:00 to the usual 9:00 is 4 hours: 4 requests a stretch ($2.00), 14 stretches: 56 requests, $28.00. While it pays: 1 request each (no record yet).
  expect(s).toMatchObject({ from: 'keep warm until my usual start', to: 'while it pays' })
  expect(s?.now).toBe('56 requests cost $28.00, saved $0.00  →  net $28.00 more')
  expect(s?.after).toBe('14 requests cost $7.00, saved $0.00  →  net $7.00 more')
})

test('keep warm replay counts what its returns saved: both sides priced, net shown (P-90)', () => {
  // 10 stretches back after 100 minutes (cache expired at 60: one request earns the $10 cold return) and 10 away 16 hours.
  const lines = [...stretches(10, 100 * 60_000), ...Array.from({ length: 10 }, (_, k) => idle(k / 2 + 0.25, 16 * HOUR_MS))]
  const [s] = replay(lines, 'keep warm 8 h')
  // 8 h: 100-minute stretches send 1 request and save $10 each (10 requests, $5.00, saved $100); 16-hour ones send 8 ($4.00): 90 requests, $45.00, saved $100.00.
  expect(s?.now).toBe('90 requests cost $45.00, saved $100.00  →  net $55.00 saved')
  expect(s?.after).toBe('20 requests cost $10.00, saved $100.00  →  net $90.00 saved')
  expect(Number(s?.saving?.toFixed(6))).toBe(35)
})

test('no keep-warm replay suggestion when the current value is cheaper, or the same (P-90)', () => {
  // Back after 170 minutes: 2 h keeps the cache alive for them (2 requests, $10 saved); while it pays sends 1 (or none) and misses.
  expect(replay(stretches(30, 170 * 60_000), 'keep warm 2 h'), 'current earns more').toEqual([])
  // Back after 100 minutes: both send one request and save the same.
  expect(replay(stretches(30, 100 * 60_000), 'keep warm 2 h'), 'tie').toEqual([])
})

test('keep warm replay: only a fixed keep-warm value, with enough stretches and requests, and not hidden (P-90)', () => {
  const lines = stretches(30, 16 * HOUR_MS)
  for (const beforeCold of ['while it pays', 'ask', 'save a handoff', 'compact', 'off']) expect(replay(lines, beforeCold), beforeCold).toEqual([])
  expect(replay(stretches(9, 16 * HOUR_MS), 'keep warm 8 h'), '9 stretches').toEqual([])
  expect(replay(stretches(10, 16 * HOUR_MS), 'keep warm 8 h'), '10 stretches').toHaveLength(1)
  expect(replay(lines, 'keep warm 8 h', { ping: undefined }), 'no price: no replay').toEqual([])
  expect(replay(lines, 'keep warm 8 h', { skipped: { beforeCold: NOW - 10 * DAY } }), 'hidden').toEqual([])
  const old = lines.map(l => ({ ...l, at: ago(40) }))
  expect(replay(old, 'keep warm 8 h'), 'older than 30 days').toEqual([])
  expect(replay(lines.map(l => ({ ...l, history: true as const })), 'keep warm 8 h'), 'backfilled lines carry no price or cost: skipped').toEqual([])
  expect(replay(lines.map(l => ({ ...l, billing: 'api' as const })), 'keep warm 8 h'), 'another billing').toEqual([])
})

test('never both off and while it pays for the same row: the cheaper one (P-90)', () => {
  // Keep warm cost more than it saved in the log (off applies): 10 requests of $2 and $5 saved.
  const loss = [...pings(10, 2), { at: ago(1), kind: 'warmSaved' as const, session: 's', saved: 5 }]
  // Every stretch is 16 hours: while it pays still costs $10 a month; off costs nothing: off wins.
  const long = replay([...stretches(30, 16 * HOUR_MS), ...loss], 'keep warm 8 h')
  expect(long.map(s => s.to)).toEqual(['off'])
  expect(long[0]?.basis.startsWith('Measured')).toBe(true)
  // Half the stretches come back after 100 minutes: while it pays nets $90 saved, which beats off.
  const mixed = replay([...stretches(10, 100 * 60_000), ...Array.from({ length: 10 }, (_, k) => idle(k / 2 + 0.25, 16 * HOUR_MS)), ...loss], 'keep warm 8 h')
  expect(mixed.map(s => s.to)).toEqual(['while it pays'])
  // The existing off suggestion still comes from a plain log, and still reads Measured.
  expect(replay(loss, 'keep warm 8 h').map(s => s.to)).toEqual(['off'])
})

test('a suggestion left unpicked hides for 30 days, then shows again', () => {
  const life = { advice: advice(9.8, 12.1), current: '1h' as const }
  expect(ids({ life, skipped: { promptCacheTtl: NOW - 10 * DAY } })).toEqual([])
  expect(ids({ life, skipped: { promptCacheTtl: NOW - 31 * DAY } })).toEqual(['promptCacheTtl'])
})

test('every suggestion is listed, with no cap, and the text says nothing changes until applied', () => {
  const lines = [...runs(), ...pings(10, 2), { at: ago(1), kind: 'run' as const, session: 's', actual: 5 }]
  const r = optimize(base({ lines, life: { advice: advice(9.8, 12.1), current: '1h' } }))
  expect(r.suggestions.map(s => s.id)).toEqual(['beforeCold', 'promptCacheTtl'])
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
