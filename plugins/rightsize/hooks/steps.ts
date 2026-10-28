// The step exponent: how the rater's tool-call guess is shrunk before it is priced.
// A run's cost grows slower than its step count (long runs reuse the same cache and
// repeat themselves), so the estimate prices `steps ** (1 + g)` steps, g under 0.
// Calibration keeps one ratio per key, which fixes a level but not a slope, so g is
// learned from the runs themselves. Each run is also scored: would the estimate have
// been closer with g applied? Only then does g reach the decisions (applied). Pure
// functions; register.tsx keeps the state.

/** Where g starts (no shrink), and what it is pulled toward until FULL runs are in. */
export const STEP_PRIOR = 0
/** g never leaves this range, whatever the runs say. */
export const STEP_MIN = -0.4
export const STEP_MAX = 0
/** Runs before the fitted g fully replaces the prior. */
export const STEP_FULL = 50
/** The newest runs the fit looks at. */
export const STEP_WINDOW = 100
/** New runs between refits. */
export const STEP_REFIT = 25
/** The share of g a hand-off's own steps take: fit on hand-off runs alone, their exponent came out at about 0.8 of the main chat's. */
export const HANDOFF_SHARE = 0.8
/** Scored runs before g can be applied, or stop being applied. */
export const STEP_PROVE = 50
/** Applied when the median error with g is at most this share of the median error without it. */
export const PROMOTE_GAIN = 0.9
/** Stopped being applied when the median error with g is more than this share of the median error without it. */
export const DEMOTE_GAIN = 0.95
/** g must have moved by at most this much over the last refits (G_RUNS of them) to be applied. */
export const G_STABLE = 0.1
/** The share of stopped hand-offs that were still under the savings bar on their real cost, above which g is not applied. */
export const UNJUST_MAX = 0.25
/** Refits kept for the stability check. */
export const G_RUNS = 3
/** Scores kept, newest last. */
export const SCORE_WINDOW = 100

/** One run: ln of its step guess, and ln of actual / the estimate it would have had with no step shrink. */
export type StepSample = { ls: number; lr: number }
/**
 * One scored run. inc: |ln| error of the plain estimate; cand: |ln| error with g applied. flip: a hand-off that
 * the learned g would have stopped. unjust: a flip whose real cost was still under the savings bar.
 */
export type StepScore = { inc: number; cand: number; flip: boolean; unjust: boolean }
export type StepState = {
  g: number
  since: number
  samples: StepSample[]
  scores: StepScore[]
  /** g after each of the last G_RUNS refits. */
  gs: number[]
  /** True while g is used by the decisions. */
  applied: boolean
  appliedAt?: number
}

export const NO_STEPS: StepState = { g: STEP_PRIOR, since: 0, samples: [], scores: [], gs: [], applied: false }

/** The exponent the decisions price with: g while it is applied, nothing (no shrink) otherwise. */
export const actingExp = (s: StepState) => (s.applied ? s.g : undefined)

/** A hand-off that the learned g would have stopped, and the saving bar it was held to: the share and the stay estimate without the step shrink. */
export type HandedOff = { actingStay: number; ruleShare: number }
/**
 * One finished run to learn from. `estimated` (the calibrated estimate with no step shrink) is set for main-chat runs,
 * which teach g. `taken` is the calibrated estimate of the route taken, priced with `stepExpUsed`; `g` is the learner's
 * exponent when the plan was made. `handedOff` is set only for a hand-off that the learned g would have stopped.
 */
export type StepRun = { steps: number; actual: number; taken: number; stepExpUsed: number; g: number; handedOff?: HandedOff }
export type FreshRun = StepRun & { estimated?: number }

const clamp = (g: number) => Math.min(STEP_MAX, Math.max(STEP_MIN, g))
const clampRatio = (x: number) => Math.min(10, Math.max(0.1, x))
const median = (xs: readonly number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2
}

/** The steps priced for a guess of `steps` under exponent `g`. A guess of one or none is left as it is, and g of 0 leaves every guess as it is. */
export const pricedSteps = (steps: number, g: number) => (steps <= 1 ? steps : steps ** (1 + g))

/** The g that leaves the least median error over the samples: ln(actual / estimate) = g * ln(steps). */
export function fitExponent(samples: readonly StepSample[]) {
  let best = 0
  let least = Infinity
  for (let i = 0; i <= 40; i++) {
    const g = -0.6 + i * 0.02
    const err = median(samples.map(s => Math.abs(s.lr - g * s.ls)))
    if (err < least) {
      least = err
      best = g
    }
  }
  return best
}

/** Adds one run. Every STEP_REFIT runs the exponent is refit on the newest STEP_WINDOW, blended with the prior until STEP_FULL runs are in. */
export function learnStep(state: StepState, steps: number, actual: number, estimated: number): StepState {
  if (!(actual > 0) || !(estimated > 0)) return state
  const sample = { ls: Math.log(Math.max(1, steps)), lr: Math.log(clampRatio(actual / estimated)) }
  const samples = [...state.samples, sample].slice(-STEP_WINDOW)
  const since = state.since + 1
  if (since < STEP_REFIT) return { ...state, samples, since }
  const w = Math.min(samples.length, STEP_FULL) / STEP_FULL
  const g = clamp(STEP_PRIOR + (fitExponent(samples) - STEP_PRIOR) * w)
  return { ...state, g, since: 0, samples, gs: [...state.gs, g].slice(-G_RUNS) }
}

/**
 * Scores one finished run: the error of the plain estimate (inc) and of the estimate with g applied (cand), both
 * against actual. base0 is the calibrated estimate with no step shrink, recovered from `taken` by `stepExpUsed`.
 * A flipped hand-off is scored the same way, against its real cost, and is flagged; unjust when that cost was still
 * under the savings bar with the shrink. A run with no cost or no estimate is not scored.
 */
export function scoreRun(state: StepState, run: StepRun): StepState {
  if (!(run.actual > 0) || !(run.taken > 0)) return state
  const n = Math.max(1, run.steps)
  const base0 = run.taken / n ** run.stepExpUsed
  const inc = Math.abs(Math.log(clampRatio(run.actual / base0)))
  const cand = Math.abs(Math.log(clampRatio(run.actual / (base0 * n ** run.g))))
  const h = run.handedOff
  const flip = h !== undefined
  const unjust = h !== undefined && run.actual < h.ruleShare * (h.actingStay * n ** run.g)
  return { ...state, scores: [...state.scores, { inc, cand, flip, unjust }].slice(-SCORE_WINDOW) }
}

/** The median errors over the scores: without g (inc) and with g (cand). Zero with no scores. */
export function medians(state: StepState) {
  if (!state.scores.length) return { inc: 0, cand: 0 }
  return { inc: median(state.scores.map(s => s.inc)), cand: median(state.scores.map(s => s.cand)) }
}

/**
 * Promotes g to the decisions, or demotes it, once the scores allow. Nothing changes under STEP_PROVE scores.
 * Promotion needs g stable over the last refits and few unjust flips; demotion needs g to stop beating the plain estimate.
 */
export function decide(state: StepState, now: number): StepState {
  if (state.scores.length < STEP_PROVE) return state
  const { inc, cand } = medians(state)
  if (!state.applied) {
    const flips = state.scores.filter(s => s.flip).length
    const unjust = state.scores.filter(s => s.unjust).length
    const stable = state.gs.length === G_RUNS && Math.max(...state.gs) - Math.min(...state.gs) <= G_STABLE
    const safe = flips === 0 || unjust / flips <= UNJUST_MAX
    return cand <= PROMOTE_GAIN * inc && stable && safe ? { ...state, applied: true, appliedAt: now } : state
  }
  return cand > DEMOTE_GAIN * inc ? { ...state, applied: false } : state
}

/** The median shrink the estimates carry under this state's g: the factor their calibration ratios were learned without. 1 with no samples. */
export function typicalShrink(state: StepState) {
  if (!state.samples.length) return 1
  return median(state.samples.map(s => Math.exp(state.g * s.ls)))
}

export function parseStepState(v: unknown): StepState {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return NO_STEPS
  const { g, since, samples, scores, gs, applied, appliedAt } = v as Record<string, unknown>
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
  const score = (s: unknown): s is StepScore => {
    const o = s as Partial<StepScore> | null
    return !!o && ok(o.inc) && ok(o.cand) && typeof o.flip === 'boolean' && typeof o.unjust === 'boolean'
  }
  return {
    g: ok(g) ? clamp(g) : STEP_PRIOR,
    since: ok(since) && since >= 0 ? since : 0,
    samples: Array.isArray(samples)
      ? samples.filter((s): s is StepSample => !!s && ok((s as StepSample).ls) && ok((s as StepSample).lr)).slice(-STEP_WINDOW)
      : [],
    scores: Array.isArray(scores) ? scores.filter(score).slice(-SCORE_WINDOW) : [],
    gs: Array.isArray(gs) ? gs.filter(ok).map(clamp).slice(-G_RUNS) : [],
    applied: applied === true,
    ...(ok(appliedAt) ? { appliedAt } : {}),
  }
}

/** Another session saves too: this session's unsaved runs go on top of the stored copy, not over it. Each run is learned from, scored, then decided. */
export function mergeSteps(stored: StepState, fresh: readonly FreshRun[], now: number) {
  return fresh.reduce((s, f) => {
    const learned = f.estimated === undefined ? s : learnStep(s, f.steps, f.actual, f.estimated)
    return decide(scoreRun(learned, f), now)
  }, stored)
}
