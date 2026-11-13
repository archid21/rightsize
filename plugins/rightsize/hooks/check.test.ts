import { expect, test } from 'claude-code/testing'
import { checkRows, overallCheck, savingCheck, watchCheck, watchRange, WATCH_MIN } from './check'
import type { RunLine } from './report'

const at = '2026-11-10T12:00:00.000Z'
const run = (x: Partial<RunLine>): RunLine => ({ at, kind: 'run', session: 's', type: 'feature', change: 'none', offered: 'none', stay: 1, taken: 1, actual: 1, ...x })
const many = (n: number, x: Partial<RunLine>) => Array.from({ length: n }, () => run(x))
/** 40 left-alone prompts that cost 80% of their prediction, and 12 handed-off ones predicted at $1 and costing $0.30. */
const base = () => [...many(40, { actual: 0.8 }), ...many(12, { change: 'delegate-down', offered: 'delegate-down', stay: 1, actual: 0.3 })]

test('check: left-alone prompts correct the prediction of the changed ones', () => {
  const c = savingCheck(base())
  expect(c.ok).toBe(true)
  if (!c.ok) return
  expect(Math.round((c.predicted) * 1000) / 1000).toBe(Math.round((12) * 1000) / 1000)
  expect(Math.round((c.corrected) * 1000) / 1000).toBe(Math.round((9.6) * 1000) / 1000)
  expect(Math.round((c.actual) * 1000) / 1000).toBe(Math.round((3.6) * 1000) / 1000)
  expect(Math.round((c.factor) * 1000) / 1000).toBe(Math.round((0.8) * 1000) / 1000)
  const rows = checkRows(c, false)
  // The headline is the overall saving: $6.00 of the 12 changed prompts' corrected $9.60 plus the 40 left-alone prompts' real $32.00.
  expect(rows.lead[0]).toBe('Overall, rightsize cut the cost of your prompts by about 14% (~$6.00). It estimated 19% (~$8.40).')
  expect(rows.lead[1]).toBe('That is out of all 52 prompts: the 12 rightsize moved to a cheaper model or lower effort and the 40 it left as they were.')
  expect(rows.table[0]).toBe('Real cost with rightsize  ~$36')
  expect(rows.table.join('\n')).toMatch(/Cost without rightsize\s+~\$44\s+~\$42/)
  expect(rows.table.join('\n')).toMatch(/Saved\s+~\$8\.40\s+~\$6\.00/)
  expect(rows.table.join('\n')).toMatch(/Saved \(%\)\s+~19%\s+~14%/)
  // The changed prompts alone, for the details view.
  expect(rows.changed.lead[0]).toBe('rightsize cut the cost of the prompts it changed by about 63% (~$6.00). It estimated 70% (~$8.40).')
  expect(rows.changed.lead[1]).toContain('On the 12 prompts rightsize moved')
  expect(rows.changed.table[0]).toBe('Real cost with rightsize  ~$3.60')
  expect(rows.changed.table.join('\n')).toMatch(/Cost without rightsize\s+~\$12\s+~\$9\.60/)
  expect(rows.changed.table.join('\n')).toMatch(/Saved \(%\)\s+~70%\s+~63%/)
  expect(rows.notes[1]).toContain('Prompts left alone (40): cost 80% of the estimate')
  expect(rows.notes.join(' '), 'retries from before 0.13 are not known').toContain('a retry from before that is not known')
})

test('overall check: left-alone prompts lower the percentage, overridden prompts are left out', () => {
  const only = (n: number) => [...many(n, { actual: 0.8 }), ...many(12, { change: 'delegate-down', offered: 'delegate-down', stay: 1, actual: 0.3 })]
  const share = (lines: RunLine[]) => {
    const c = savingCheck(lines)
    if (!c.ok) throw new Error('not ok')
    return overallCheck(c)
  }
  // 12 changed prompts alone: saved $6 of $9.60 corrected. 30 left alone add $24 of cost and no saving; 40 add $32.
  const thirty = share(only(30))
  const forty = share(only(40))
  expect(Math.round(thirty.lo * 1000) / 1000).toBe(Math.round((6 / 33.6) * 1000) / 1000)
  expect(Math.round(forty.lo * 1000) / 1000).toBe(Math.round((6 / 41.6) * 1000) / 1000)
  expect(forty.lo, 'more prompts left alone, a lower share').toBeLessThan(thirty.lo)
  expect(thirty.lo, 'below the changed prompts own 63%').toBeLessThan(0.63)
  expect(forty.prompts).toBe(52)
  // Declined prompts (here 5 that cost $3.00) and undone ones are left out of the total and the changed set, and counted.
  const declined = many(5, { offered: 'delegate-down', actual: 0.6 })
  const undone = [run({ id: 'r1', change: 'lower', stay: 1, actual: 0.2 }), run({ id: 'r2', change: 'delegate-down', stay: 1, actual: 0.2 })]
  const undoneLines: RunLine[] = [{ at, kind: 'undone', session: 's', ref: 'r1', undone: 'lower' }, { at, kind: 'undone', session: 's', ref: 'r2', undone: 'route' }]
  const out = savingCheck([...only(40), ...declined, ...undone, ...undoneLines])
  expect(out.ok).toBe(true)
  if (!out.ok) return
  expect(out.changed, 'the undone changes are not changed prompts').toBe(12)
  expect(out.undone).toBe(2)
  expect(out.declinedAll).toBe(5)
  expect(out.rest.n).toBe(40)
  expect(Math.abs(out.rest.cost - 32)).toBeLessThan(1e-6)
  const o = overallCheck(out)
  // (The declined prompts still teach the left-alone rate, so the share can move a little; their cost is not in the total.)
  expect(o.lo).toBeGreaterThan(0)
  expect(o.prompts).toBe(52)
  const rows = checkRows(out, false)
  expect(rows.lead[1]).toContain('Left out: the 7 you overrode (5 declined, 2 undone with Retry or Run on your model).')
  expect(rows.notes.join(' ')).toContain('Prompts you declined (5)')
  // An undone line for a run that is not in the period changes nothing; so does the same run without one.
  const same = savingCheck([...only(40), ...undone])
  expect(same.ok && same.changed, 'without the undone lines they are changed prompts').toBe(14)
})

test('overall check: raised and stepped-up prompts add their real cost to the total and claim no saving', () => {
  const extra = [run({ change: 'raise', offered: 'raise', stay: 1, actual: 2 }), run({ change: 'lower', steppedUp: true, stay: 1, actual: 1 })]
  const c = savingCheck([...base(), ...extra])
  expect(c.ok && c.rest.n).toBe(42)
  expect(c.ok && Math.abs(c.rest.cost - 35) < 1e-6).toBe(true)
  expect(c.ok && c.changed, 'a stepped-up prompt claims no saving').toBe(12)
})

test('check: a kind of work with 10 prompts uses its own rate; a thin one uses the overall rate', () => {
  const lines = [...many(30, { type: 'feature', actual: 0.5 }), ...many(10, { type: 'search', actual: 1.0 }), ...many(10, { type: 'search', change: 'delegate-down', actual: 0.2 }), ...many(2, { type: 'extract', change: 'lower', actual: 0.2 })]
  const c = savingCheck(lines)
  expect(c.ok).toBe(true)
  if (!c.ok) return
  // search: own rate 1.0 (corrected stay stays $1); extract: no own rate, falls back to overall 0.625.
  expect(Math.round((c.corrected) * 1000) / 1000).toBe(Math.round((10 * 1.0 + 2 * 0.625) * 1000) / 1000)
  expect(c.own).toBe(2)
  expect(c.fellBack).toBe(2)
})

test('check: too few left-alone or changed prompts says what is missing, never a figure', () => {
  const few = savingCheck(many(20, { actual: 0.8 }))
  expect(few.ok).toBe(false)
  expect(checkRows(few, false).notes[0]).toContain('20 of 30 prompts left alone')
  const noChange = savingCheck([...many(40, { actual: 0.8 }), ...many(3, { change: 'lower' })])
  expect(noChange.ok).toBe(false)
  expect(checkRows(noChange, false).notes[0]).toContain('3 of 10 prompts rightsize changed')
  expect(checkRows(savingCheck([]), false)).toEqual({ lead: [], table: [], notes: [], changed: { lead: [], table: [] } })
})

test('check: stepped-up, raised, aborted and workflow prompts and ones without a prediction are left out', () => {
  const odd = [run({ steppedUp: true }), run({ escalations: [{ step: 1, from: 'low', to: 'medium', why: 'x' }] }), run({ aborted: true }), run({ afterWorkflow: true }), run({ stay: 0 }), run({ actual: 0 }), run({ kind: 'subagent' })]
  const c = savingCheck([...base(), ...odd])
  expect(c.ok && c.untouched).toBe(40)
})

test('check: declined advice is counted with its cost and prediction', () => {
  const c = savingCheck([...base(), ...many(5, { offered: 'delegate-down', actual: 0.6 })])
  expect(c.ok && c.declined.n).toBe(5)
  if (!c.ok) return
  expect(Math.round((c.declined.actual) * 1000) / 1000).toBe(Math.round((3) * 1000) / 1000)
  expect(c.byDeclined).toBeUndefined()
  expect(checkRows(c, false).notes.join(' ')).toContain('Prompts you declined (5): cost 60% of the estimate. A range needs 30 of them.')
})

test('check: 30 declined prompts give the other end of a range, low end first', () => {
  // Declined cost 50% of the estimate; left alone overall (40 at 80%, 30 at 50%) about 68%.
  const c = savingCheck([...base(), ...many(30, { offered: 'lower', actual: 0.5 }), run({ change: 'none', aborted: true })])
  expect(c.ok).toBe(true)
  if (!c.ok) return
  expect(Math.round(c.byDeclined! * 1000) / 1000).toBe(6)
  expect(c.untouchedAll).toBe(71)
  const rows = checkRows(c, true)
  // The 30 declined prompts are left out of the overall total; the 40 left alone are in it ($32).
  expect(rows.lead[0]).toMatch(/^Overall, rightsize cut the cost of your prompts by about 6–11% \(~\$2\.40–\$4\.46\)\. It estimated 19% \(~\$8\.40\)\.$/)
  expect(rows.lead[1]).toContain('(API prices)')
  expect(rows.lead[1]).toContain('Left out: the 30 you overrode (30 declined)')
  expect(rows.table.join('\n')).toMatch(/Cost without rightsize\s+~\$44\s+~\$38–\$40/)
  expect(rows.changed.lead[0]).toMatch(/^rightsize cut the cost of the prompts it changed by about 40–\d\d% \(~\$2\.40–\$\d\.\d\d\)\. It estimated 70% \(~\$8\.40\)\.$/)
  expect(rows.changed.lead[1]).toContain('(API prices)')
  expect(rows.changed.table.join('\n')).toMatch(/Cost without rightsize\s+~\$12\s+~\$6\.00–\$8\.06/)
  expect(rows.notes.join(' ')).toContain('Prompts left alone (70 of 71)')
  expect(rows.notes.join(' ')).toContain('cost 50% of the estimate, the low end')
})

test('check: when the correction removes the saving, it says so', () => {
  const c = savingCheck([...many(40, { actual: 0.3 }), ...many(12, { change: 'delegate-down', actual: 0.5 })])
  expect(c.ok).toBe(true)
  if (!c.ok) return
  const rows = checkRows(c, true)
  expect(rows.table.join('\n')).toMatch(/Saved\s+~\$\S+\s+(~\$.* more|about even)/)
  expect(rows.lead[0]).toMatch(/^After checking against real costs, rightsize did not save/)
  expect(rows.lead[1]).toContain('API prices')
})

// ---- Watch only: the same method on a period where nothing was applied (ADR 0058) ----

test('watchCheck: the saving is the would-have-saved share of what all the prompts cost, matched by kind of work', () => {
  // 30 prompts predicted $1 and costing $0.80; 10 of them would have gone to a route estimated at $0.40.
  const lines = [...many(20, { actual: 0.8 }), ...many(10, { actual: 0.8, would: 'lower', wouldTaken: 0.4 })]
  const c = watchCheck(lines)
  expect(c.ok).toBe(true)
  if (!c.ok) return
  expect(c.rated).toBe(30)
  expect(c.changed).toBe(10)
  // Saved 10 x (1 - 0.4) x 0.8 = 4.8 of 30 x 0.8 = 24: 20%.
  expect(Math.round(c.lo * 1000) / 1000).toBe(0.2)
  expect(Math.round(c.hi * 1000) / 1000).toBe(0.2)
  expect(watchRange(c)).toBe('20%')
})

test('watchCheck: the range runs between the per-kind rates and the overall rate', () => {
  // feature: 20 prompts cost what was predicted. search: 10 prompts cost half. 5 of the search prompts would have gone to a $0.50 route.
  const lines = [...many(20, { type: 'feature', actual: 1 }), ...many(5, { type: 'search', actual: 0.5 }), ...many(5, { type: 'search', actual: 0.5, would: 'delegate-down', wouldTaken: 0.5 })]
  const c = watchCheck(lines)
  expect(c.ok).toBe(true)
  if (!c.ok) return
  // Per kind: saved 5 x 0.5 x 0.5 = 1.25 of 20 + 5 = 25: 5%. Overall (0.8333): saved 2.083 of 25: 8.33%.
  expect(Math.round(c.lo * 10000) / 10000).toBe(0.05)
  expect(Math.round(c.hi * 10000) / 10000).toBe(0.0833)
  expect(watchRange(c)).toBe('5–8%')
})

test('watchCheck: under 20 rated prompts gives no range; aborted and unpriced prompts are not rated', () => {
  expect(WATCH_MIN).toBe(20)
  const c = watchCheck([...many(19, { would: 'lower', wouldTaken: 0.4 }), run({ aborted: true }), run({ stay: 0 }), run({ actual: 0 }), run({ kind: 'subagent' })])
  expect(c).toEqual({ ok: false, rated: 19 })
  expect(watchCheck(many(20, { would: 'lower', wouldTaken: 0.4 })).ok).toBe(true)
  expect(watchCheck([])).toEqual({ ok: false, rated: 0 })
})

test('watchCheck: prompts that stepped up claim no saving, a raise is no saving', () => {
  const lines = [...many(20, { actual: 1 }), ...many(5, { steppedUp: true, would: 'lower', wouldTaken: 0.1 }), ...many(5, { would: 'raise', wouldTaken: 2 })]
  const c = watchCheck(lines)
  expect(c.ok).toBe(true)
  if (!c.ok) return
  expect(c.changed).toBe(0)
  expect(c.lo).toBe(0)
  expect(watchRange(c), 'nothing to say').toBeUndefined()
})
