import { money } from './cost'
import type { RunLine } from './report'

// Saving check (rightsize ADR 0055). The report's saving is "staying would have cost `stay`" minus what the prompt
// cost. `stay` is a prediction. The prompts rightsize left alone show how good it is: what they really cost against
// what `stay` said. That ratio, per kind of work, corrects `stay` on the prompts rightsize changed.
// The declined prompts are a second check (ADR 0056): rightsize wanted to change them, so they are like the changed
// ones. Their rate gives the other end of a range, once there are enough of them.
// Pure: run lines in, rows out.

/** Untouched prompts a kind of work needs for its own factor, and all kinds together for any factor. */
export const TYPE_MIN = 10
export const ALL_MIN = 30
/** Changed prompts needed to show a saving. */
export const CHANGED_MIN = 10
/** Declined prompts needed for their rate to give the other end of the range. */
export const DECLINED_MIN = 30

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const SAVING = ['lower', 'delegate-down']

type Group = { n: number; stay: number; actual: number }
const empty = (): Group => ({ n: 0, stay: 0, actual: 0 })
const add = (g: Group, stay: number, actual: number) => {
  g.n += 1
  g.stay += stay
  g.actual += actual
}

export type Check =
  | { ok: false; untouched: number; changed: number; need: string }
  | {
      ok: true
      /** Prompts rightsize changed (lowered or handed to a helper), and what staying was predicted to cost, corrected, and what they cost. */
      changed: number
      predicted: number
      corrected: number
      actual: number
      /** Actual over predicted on the untouched prompts, all kinds together. */
      factor: number
      untouched: number
      /** Advice the person declined: the prompts, what rightsize predicted for them, and what they cost. */
      declined: { n: number; predicted: number; actual: number }
      /** Staying re-priced by the declined prompts' rate; absent under DECLINED_MIN. */
      byDeclined?: number
      /** All left-alone and declined prompts, as the 30-day summary counts them (finished or not). */
      untouchedAll: number
      declinedAll: number
      /** Kinds of work that used their own factor, and the changed prompts that fell back to the overall one. */
      own: number
      fellBack: number
    }

/** A prompt that ran to the end with a prediction and a real cost. */
const usable = (l: RunLine) => (l.kind ?? 'run') === 'run' && !l.aborted && num(l.stay) > 0 && num(l.actual) > 0
/** What `counterfactual` in report.ts leaves at the actual cost: no saving is claimed for these. */
const unclaimed = (l: RunLine) => l.steppedUp || (l.escalations?.length ?? 0) > 0 || l.afterWorkflow

export function savingCheck(lines: readonly RunLine[]): Check {
  const all = empty()
  const byType = new Map<string, Group>()
  const declined = empty()
  const changed: RunLine[] = []
  let untouchedAll = 0
  let declinedAll = 0
  for (const l of lines) {
    if ((l.kind ?? 'run') === 'run' && (l.change ?? 'none') === 'none') {
      untouchedAll += 1
      if (l.offered && l.offered !== 'none') declinedAll += 1
    }
    if (!usable(l) || unclaimed(l)) continue
    const c = l.change ?? 'none'
    if (c === 'none') {
      const g = byType.get(l.type ?? '') ?? empty()
      byType.set(l.type ?? '', g)
      add(g, num(l.stay), num(l.actual))
      add(all, num(l.stay), num(l.actual))
      if (l.offered && l.offered !== 'none') add(declined, num(l.stay), num(l.actual))
    } else if (SAVING.includes(c)) changed.push(l)
  }
  if (all.n < ALL_MIN) return { ok: false, untouched: all.n, changed: changed.length, need: `${all.n} of ${ALL_MIN} prompts left alone to compare against` }
  if (changed.length < CHANGED_MIN) return { ok: false, untouched: all.n, changed: changed.length, need: `${changed.length} of ${CHANGED_MIN} prompts rightsize changed` }
  const overall = all.actual / all.stay
  let predicted = 0
  let corrected = 0
  let actual = 0
  let fellBack = 0
  for (const l of changed) {
    const g = byType.get(l.type ?? '')
    const own = g && g.n >= TYPE_MIN
    if (!own) fellBack += 1
    const f = own ? g.actual / g.stay : overall
    predicted += num(l.stay)
    corrected += num(l.stay) * f
    actual += num(l.actual)
  }
  return {
    ok: true,
    changed: changed.length,
    predicted,
    corrected,
    actual,
    factor: overall,
    untouched: all.n,
    declined: { n: declined.n, predicted: declined.stay, actual: declined.actual },
    ...(declined.n >= DECLINED_MIN ? { byDeclined: predicted * (declined.actual / declined.stay) } : {}),
    untouchedAll,
    declinedAll,
    own: [...byType.values()].filter(g => g.n >= TYPE_MIN).length,
    fellBack,
  }
}

const tilde = (usd: number) => (money(usd).startsWith('under') ? money(usd) : `~${money(usd)}`)

const pct = (part: number, whole: number) => Math.round((part / whole) * 100)
const count = (n: number, all: number) => (all > n ? `${n.toLocaleString('en-US')} of ${all.toLocaleString('en-US')}` : n.toLocaleString('en-US'))
/** "~62–71%" or "~71%" when both ends round the same. */
const span = (lo: string, hi: string) => (lo === hi ? hi : `${lo.replace(/%$/, '')}–${hi.replace(/^~/, '')}`)

/**
 * The block: `lead` sentences under the title, aligned `table` rows and prose `notes` (plain text; the report indents
 * the table and wraps the lead and notes). All empty when there is nothing to say.
 */
export function checkRows(c: Check, subscription: boolean): { lead: string[]; table: string[]; notes: string[] } {
  if (!c.ok) return { lead: [], table: [], notes: c.changed === 0 && c.untouched === 0 ? [] : [`Not enough comparable prompts yet: ${c.need}.`] }
  const ends = [c.corrected, ...(c.byDeclined === undefined ? [] : [c.byDeclined])].sort((a, b) => a - b)
  const lo = ends[0]!
  const hi = ends[ends.length - 1]!
  const saved = c.predicted - c.actual
  const savedLo = lo - c.actual
  const savedHi = hi - c.actual
  const cell = (usd: number) => (usd >= 0.005 ? tilde(usd) : usd <= -0.005 ? `${tilde(-usd)} more` : 'about even')
  const share = (s: number, staying: number) => (s >= 0.005 ? `~${pct(s, staying)}%` : 'none')
  const estimated = `It estimated ${pct(saved, c.predicted)}% (${tilde(saved)}).`
  const head =
    savedLo >= 0.005
      ? `rightsize cut the cost of the prompts it changed by about ${span(`${pct(savedLo, lo)}%`, `${pct(savedHi, hi)}%`)} (${span(tilde(savedLo), tilde(savedHi))}). ${estimated}`
      : savedHi >= 0.005
        ? `rightsize cut the cost of the prompts it changed by up to ${pct(savedHi, hi)}% (${tilde(savedHi)}); at the low end it saved nothing. ${estimated}`
        : `After checking against real costs, rightsize did not save on the prompts it changed. ${estimated}`
  const lead = [head, `On the ${c.changed.toLocaleString('en-US')} prompts rightsize moved to a cheaper model or lower effort${subscription ? ' (API prices)' : ''}:`]
  const grid = [
    ['', 'Estimated', 'Checked'],
    ['Cost without rightsize', tilde(c.predicted), span(tilde(lo), tilde(hi))],
    ['Saved', cell(saved), span(cell(savedLo), cell(savedHi))],
    ['Saved (%)', share(saved, c.predicted), span(share(savedLo, lo), share(savedHi, hi))],
  ]
  const w = grid[0]!.map((_, i) => Math.max(...grid.map(r => r[i]!.length)))
  const table = [`Real cost with rightsize  ${tilde(c.actual)}`, '', ...grid.map(r => `${r[0]!.padEnd(w[0]!)}  ${r[1]!.padStart(w[1]!)}  ${r[2]!.padStart(w[2]!)}`.trimEnd())]
  const left = Math.round(c.factor * 100)
  const declinedRate = c.declined.n ? pct(c.declined.actual, c.declined.predicted) : 0
  const leftLow = c.byDeclined !== undefined && c.corrected <= c.byDeclined
  const kinds = `matched by kind of work, ${c.own} kind${c.own === 1 ? '' : 's'} with enough prompts${c.fellBack ? `; ${c.fellBack} changed prompt${c.fellBack === 1 ? '' : 's'} used the overall rate` : ''}`
  const notes = [
    `How "Checked" works: rightsize compares real costs with its estimates on prompts it did not change.`,
    `Prompts left alone (${count(c.untouched, c.untouchedAll)}): cost ${left}% of the estimate${c.byDeclined === undefined ? '' : leftLow ? ', the low end' : ', the high end'} (${kinds}).`,
    ...(c.declined.n
      ? [
          c.byDeclined === undefined
            ? `Prompts you declined (${count(c.declined.n, c.declinedAll)}): cost ${declinedRate}% of the estimate. A range needs ${DECLINED_MIN} of them.`
            : `Prompts you declined (${count(c.declined.n, c.declinedAll)}): cost ${declinedRate}% of the estimate, ${leftLow ? 'the high end' : 'the low end'}. rightsize wanted to change these, so they are most like the changed prompts.`,
        ]
      : []),
    `The counts are prompts that finished with both an estimate and a real cost.`,
  ]
  return { lead, table, notes }
}
