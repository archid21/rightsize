import { money } from './cost'
import type { RunLine } from './report'

// Saving check (rightsize ADR 0055). The report's saving is "staying would have cost `stay`" minus what the prompt
// cost. `stay` is a prediction. The prompts rightsize left alone show how good it is: what they really cost against
// what `stay` said. That ratio, per kind of work, corrects `stay` on the prompts rightsize changed.
// Pure: run lines in, rows out.

/** Untouched prompts a kind of work needs for its own factor, and all kinds together for any factor. */
export const TYPE_MIN = 10
export const ALL_MIN = 30
/** Changed prompts needed to show a saving. */
export const CHANGED_MIN = 10

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
  for (const l of lines) {
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
    own: [...byType.values()].filter(g => g.n >= TYPE_MIN).length,
    fellBack,
  }
}

const tilde = (usd: number) => (money(usd).startsWith('under') ? money(usd) : `~${money(usd)}`)

/** The block: aligned `table` rows and prose `notes` (plain text; the report indents the table and wraps the notes). Both empty when there is nothing to say. */
export function checkRows(c: Check, subscription: boolean): { table: string[]; notes: string[] } {
  if (!c.ok) return { table: [], notes: c.changed === 0 && c.untouched === 0 ? [] : [`Not enough comparable prompts yet: ${c.need}.`] }
  const saved = c.predicted - c.actual
  const savedCorrected = c.corrected - c.actual
  const cell = (usd: number) => (usd >= 0.005 ? tilde(usd) : usd <= -0.005 ? `${tilde(-usd)} more` : 'about even')
  const grid = [
    [`Staying, as rightsize predicted`, tilde(c.predicted)],
    [`Staying, corrected`, tilde(c.corrected)],
    [`With rightsize`, tilde(c.actual)],
    [`Saving, as predicted`, cell(saved)],
    [`Saving, corrected`, cell(savedCorrected)],
  ]
  const w = Math.max(...grid.map(r => r[0]!.length))
  const table = grid.map(r => `${r[0]!.padEnd(w)}  ${r[1]}`)
  const pctOf = Math.round(c.factor * 100)
  const gap = Math.abs(pctOf - 100) < 5 ? 'close to what was predicted' : `${pctOf}% of what was predicted`
  const end =
    savedCorrected >= 0.005 ? `rightsize still saved ${tilde(savedCorrected)}, against ${tilde(saved)} as predicted.` : savedCorrected <= -0.005 ? 'after that correction rightsize cost more than staying.' : 'after that correction the saving is about even.'
  const notes = [
    `On the ${c.changed} prompts rightsize lowered or handed off${subscription ? ' (API prices)' : ''}. The ${c.untouched} it left alone cost ${gap}, so ${end}`,
    ...(c.declined.n ? [`You declined ${c.declined.n} suggestion${c.declined.n === 1 ? '' : 's'}: they cost ${tilde(c.declined.actual)}, predicted ${tilde(c.declined.predicted)}.`] : []),
    `Matched by kind of work (${c.own} kind${c.own === 1 ? '' : 's'} with enough prompts${c.fellBack ? `; ${c.fellBack} changed prompt${c.fellBack === 1 ? '' : 's'} used the overall rate` : ''}). Prompts left alone may be easier than the ones rightsize acts on.`,
  ]
  return { table, notes }
}
