import { money } from './cost'
import type { RunLine } from './report'

// Saving check (rightsize ADR 0055). The report's saving is "staying would have cost `stay`" minus what the prompt
// cost. `stay` is a prediction. The prompts rightsize left alone show how good it is: what they really cost against
// what `stay` said. That ratio, per kind of work, corrects `stay` on the prompts rightsize changed.
// The declined prompts are a second check (ADR 0056): rightsize wanted to change them, so they are like the changed
// ones. Their rate gives the other end of a range, once there are enough of them.
// The headline is the overall saving (P-20): the checked saving over the checked cost of all the prompts in the period, the ones
// rightsize left alone included, so they add cost and no saving. Prompts the person overrode are left out: declined advice, and a
// change undone with Retry or Run on the current model (an `undone` line names the run). The changed prompts alone are the details view.
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
/** A saving as a share (0 to 1) of a total cost; 0 when there is no cost. Shared by the report's headline and the watch-only range. */
const shareOf = (saved: number, total: number) => (total > 0 ? saved / total : 0)

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
      /** Changes the person undid (Retry at original effort, Run on the current model): left out of everything above. */
      undone: number
      /** The other prompts of the period that finished with a real cost and were not overridden (raised, stepped up, after a workflow, and left alone but not declined), at what they cost. */
      rest: { n: number; cost: number }
      /** Kinds of work that used their own factor, and the changed prompts that fell back to the overall one. */
      own: number
      fellBack: number
    }

/** A prompt that ran to the end with a prediction and a real cost. */
const usable = (l: RunLine) => (l.kind ?? 'run') === 'run' && !l.aborted && num(l.stay) > 0 && num(l.actual) > 0
/** What `counterfactual` in report.ts leaves at the actual cost: no saving is claimed for these. */
const unclaimed = (l: RunLine) => l.steppedUp || (l.escalations?.length ?? 0) > 0 || l.afterWorkflow

export function savingCheck(lines: readonly RunLine[]): Check {
  const undoneRuns = new Set(lines.filter(l => l.kind === 'undone' && l.ref).map(l => l.ref))
  let undone = 0
  const rest = empty()
  const all = empty()
  const byType = new Map<string, Group>()
  const declined = empty()
  const changed: RunLine[] = []
  let untouchedAll = 0
  let declinedAll = 0
  for (const l of lines) {
    // The person undid the change: the prompt is overridden, so it counts nowhere.
    if ((l.kind ?? 'run') === 'run' && l.id && undoneRuns.has(l.id)) {
      undone += 1
      continue
    }
    if ((l.kind ?? 'run') === 'run' && (l.change ?? 'none') === 'none') {
      untouchedAll += 1
      if (l.offered && l.offered !== 'none') declinedAll += 1
    }
    if (!usable(l)) continue
    const c = l.change ?? 'none'
    const wasDeclined = c === 'none' && !!l.offered && l.offered !== 'none'
    if (unclaimed(l) || (c !== 'none' && !SAVING.includes(c))) {
      // No saving is claimed for it, but it cost real money in the period.
      if (!wasDeclined) add(rest, num(l.stay), num(l.actual))
      continue
    }
    if (c === 'none') {
      const g = byType.get(l.type ?? '') ?? empty()
      byType.set(l.type ?? '', g)
      add(g, num(l.stay), num(l.actual))
      add(all, num(l.stay), num(l.actual))
      if (wasDeclined) add(declined, num(l.stay), num(l.actual))
      else add(rest, num(l.stay), num(l.actual))
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
    undone,
    rest: { n: rest.n, cost: rest.actual },
    own: [...byType.values()].filter(g => g.n >= TYPE_MIN).length,
    fellBack,
  }
}

/** Rated prompts a watch-only period needs before the Saving check gives a range (starting value, tunable). */
export const WATCH_MIN = 20

export type WatchCheck =
  | { ok: false; rated: number }
  | {
      ok: true
      /** Rated prompts in the period, and how many of them rightsize would have lowered or handed to a cheaper model. */
      rated: number
      changed: number
      /** The saving as a share (0 to 1) of what all the period's prompts cost: the smaller and the larger end of the range. */
      lo: number
      hi: number
    }

/**
 * The Saving check for a watch-only period (ADR 0058). Nothing was applied there, so every prompt ran as staying, and its real cost
 * against its `stay` prediction gives the factor, per kind of work (overall for a kind under TYPE_MIN prompts), as savingCheck does.
 * A prompt rightsize would have lowered or handed down is re-priced: corrected `stay` minus corrected `wouldTaken`. The saving is
 * taken once with the per-kind factors and once with the overall one: the range runs between them. The share is of all the period's
 * prompts, corrected the same way. Pass the period's run lines.
 */
export function watchCheck(lines: readonly RunLine[]): WatchCheck {
  const runs = lines.filter(l => usable(l) && (l.change ?? 'none') === 'none')
  if (runs.length < WATCH_MIN) return { ok: false, rated: runs.length }
  const all = empty()
  const byType = new Map<string, Group>()
  for (const l of runs) {
    if (unclaimed(l)) continue
    const g = byType.get(l.type ?? '') ?? empty()
    byType.set(l.type ?? '', g)
    add(g, num(l.stay), num(l.actual))
    add(all, num(l.stay), num(l.actual))
  }
  const overall = all.n ? all.actual / all.stay : 1
  const share = (perKind: boolean) => {
    let total = 0
    let saved = 0
    for (const l of runs) {
      // A prompt that stepped up or ran after a workflow claims no saving, and counts at what it cost.
      if (unclaimed(l)) {
        total += num(l.actual)
        continue
      }
      const g = byType.get(l.type ?? '')
      const f = perKind && g && g.n >= TYPE_MIN ? g.actual / g.stay : overall
      total += num(l.stay) * f
      if (l.would && SAVING.includes(l.would)) saved += (num(l.stay) - num(l.wouldTaken)) * f
    }
    return shareOf(saved, total)
  }
  const a = share(true)
  const b = share(false)
  return { ok: true, rated: runs.length, changed: runs.filter(l => !unclaimed(l) && l.would && SAVING.includes(l.would)).length, lo: Math.min(a, b), hi: Math.max(a, b) }
}

/** "12–18%", or "15%" when both ends round the same; undefined when the saving rounds to nothing. */
export function watchRange(c: Extract<WatchCheck, { ok: true }>): string | undefined {
  const lo = Math.max(0, Math.round(c.lo * 100))
  const hi = Math.max(0, Math.round(c.hi * 100))
  if (hi === 0) return undefined
  return lo === hi ? `${hi}%` : `${lo}–${hi}%`
}

const tilde = (usd: number) => (money(usd).startsWith('under') ? money(usd) : `~${money(usd)}`)

const pct = (part: number, whole: number) => Math.round((part / whole) * 100)
const count = (n: number, all: number) => (all > n ? `${n.toLocaleString('en-US')} of ${all.toLocaleString('en-US')}` : n.toLocaleString('en-US'))
/** "~62–71%" or "~71%" when both ends round the same. */
const span = (lo: string, hi: string) => (lo === hi ? hi : `${lo.replace(/%$/, '')}–${hi.replace(/^~/, '')}`)

type Ok = Extract<Check, { ok: true }>

/**
 * The checked saving of the changed prompts: the low and high end of what staying would have cost (the range runs between the
 * kind-of-work correction and, with enough declined prompts, the declined prompts' rate) and the saving at each end.
 */
function ends(c: Ok) {
  const e = [c.corrected, ...(c.byDeclined === undefined ? [] : [c.byDeclined])].sort((a, b) => a - b)
  const lo = e[0]!
  const hi = e[e.length - 1]!
  return { lo, hi, savedLo: lo - c.actual, savedHi: hi - c.actual }
}

/**
 * The overall saving (P-20): the same saving over the checked cost of all the period's prompts that were not overridden. A prompt
 * left alone adds its real cost to the total and nothing to the saving, so the share is lower than the changed prompts' own.
 * `lo` and `hi` are shares (0 to 1); `savedLo` and `savedHi` the dollars; `total` the prompts counted.
 */
export function overallCheck(c: Ok) {
  const e = ends(c)
  const rest = c.rest.cost
  return {
    savedLo: e.savedLo,
    savedHi: e.savedHi,
    lo: shareOf(e.savedLo, e.lo + rest),
    hi: shareOf(e.savedHi, e.hi + rest),
    estimated: shareOf(c.predicted - c.actual, c.predicted + rest),
    prompts: c.changed + c.rest.n,
  }
}

/**
 * The blocks: `lead` sentences under the title, aligned `table` rows and prose `notes` (plain text; the report indents
 * the table and wraps the lead and notes) for the overall saving, and `changed`, the same for the prompts rightsize changed
 * alone, which the details view shows. All empty when there is nothing to say.
 */
export function checkRows(c: Check, subscription: boolean): { lead: string[]; table: string[]; notes: string[]; changed: { lead: string[]; table: string[] } } {
  const none = { lead: [], table: [], changed: { lead: [], table: [] } }
  if (!c.ok) return { ...none, notes: c.changed === 0 && c.untouched === 0 ? [] : [`Not enough comparable prompts yet: ${c.need}.`] }
  const { lo, hi, savedLo, savedHi } = ends(c)
  const rest = c.rest.cost
  const saved = c.predicted - c.actual
  const cell = (usd: number) => (usd >= 0.005 ? tilde(usd) : usd <= -0.005 ? `${tilde(-usd)} more` : 'about even')
  const share = (s: number, staying: number) => (s >= 0.005 ? `~${pct(s, staying)}%` : 'none')
  const estimated = (part: number, whole: number) => `It estimated ${pct(part, whole)}% (${tilde(part)}).`
  /** Estimated and Checked columns for `extra` of cost added to both (the prompts left alone, for the overall block). */
  const block = (extra: number) => {
    const grid = [
      ['', 'Estimated', 'Checked'],
      ['Cost without rightsize', tilde(c.predicted + extra), span(tilde(lo + extra), tilde(hi + extra))],
      ['Saved', cell(saved), span(cell(savedLo), cell(savedHi))],
      ['Saved (%)', share(saved, c.predicted + extra), span(share(savedLo, lo + extra), share(savedHi, hi + extra))],
    ]
    const w = grid[0]!.map((_, i) => Math.max(...grid.map(r => r[i]!.length)))
    return [`Real cost with rightsize  ${tilde(c.actual + extra)}`, '', ...grid.map(r => `${r[0]!.padEnd(w[0]!)}  ${r[1]!.padStart(w[1]!)}  ${r[2]!.padStart(w[2]!)}`.trimEnd())]
  }
  /** The headline sentence: `what` is cut, `extra` the cost of the prompts around the changed ones, `nothing` what did not get cheaper. */
  const head = (what: string, extra: number, nothing: string) =>
    savedLo >= 0.005
      ? `${what} by about ${span(`${pct(savedLo, lo + extra)}%`, `${pct(savedHi, hi + extra)}%`)} (${span(tilde(savedLo), tilde(savedHi))}). ${estimated(saved, c.predicted + extra)}`
      : savedHi >= 0.005
        ? `${what} by up to ${pct(savedHi, hi + extra)}% (${tilde(savedHi)}); at the low end it saved nothing. ${estimated(saved, c.predicted + extra)}`
        : `After checking against real costs, rightsize did not save ${nothing}. ${estimated(saved, c.predicted + extra)}`
  const o = overallCheck(c)
  const overrode = c.declinedAll + c.undone
  const parts = [c.declinedAll ? `${c.declinedAll.toLocaleString('en-US')} declined` : '', c.undone ? `${c.undone.toLocaleString('en-US')} undone with Retry or Run on your model` : ''].filter(Boolean).join(', ')
  const lead = [
    head('Overall, rightsize cut the cost of your prompts', rest, 'overall'),
    `That is out of all ${o.prompts.toLocaleString('en-US')} prompts${subscription ? ' (API prices)' : ''}: the ${c.changed.toLocaleString('en-US')} rightsize moved to a cheaper model or lower effort and the ${c.rest.n.toLocaleString('en-US')} it left as they were.${overrode ? ` Left out: the ${overrode.toLocaleString('en-US')} you overrode (${parts}).` : ''}`,
  ]
  const changedLead = [
    head('rightsize cut the cost of the prompts it changed', 0, 'on the prompts it changed'),
    `On the ${c.changed.toLocaleString('en-US')} prompts rightsize moved to a cheaper model or lower effort${subscription ? ' (API prices)' : ''}, leaving out any you undid:`,
  ]
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
    `Retry at original effort and Run on your model are logged from rightsize 0.13, so a retry from before that is not known and that prompt still counts as changed.`,
    `The counts are prompts that finished with both an estimate and a real cost.`,
  ]
  return { lead, table: block(rest), notes, changed: { lead: changedLead, table: block(0) } }
}
