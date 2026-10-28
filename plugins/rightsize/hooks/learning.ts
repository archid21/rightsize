// Learning mode: the learned step exponent (steps.ts) is priced beside each real decision,
// and the decision it would have made is logged. The note also says whether the exponent is
// applied, so a logged plan that matches the real one is the decision itself. Pure functions;
// register.tsx plans the learning route and writes the note.

import type { Plan } from './cost'

/** What the learned step exponent would have decided for one prompt, logged beside the real decision. `applied`: g is used by the real decision. */
export type LearningNote = { g: number; plan: string; differs: boolean; applied: boolean; delegateCost?: number; mainCost?: number }

/** A short label for a plan: its kind, its direction and its model, enough to tell two decisions apart. */
export function planLabel(p: Plan): string {
  if (p.kind === 'none') return 'none'
  if (p.kind === 'effort') return `effort-${p.dir}`
  if (p.kind === 'switch') return `switch:${p.tier}`
  return `delegate-${p.dir}:${p.tier}`
}

const round5 = (n: number) => Math.round(n * 1e5) / 1e5

/** The learning plan's label, and whether it differs from the acting plan's. Hand-off costs are logged when the plan has them. */
export function learningNote(acting: Plan, learning: Plan, g: number, applied: boolean): LearningNote {
  const plan = planLabel(learning)
  const note: LearningNote = { g: round5(g), plan, differs: planLabel(acting) !== plan, applied }
  if (learning.kind === 'delegate') {
    note.delegateCost = round5(learning.delegateCost)
    note.mainCost = round5(learning.mainCost)
  }
  return note
}
