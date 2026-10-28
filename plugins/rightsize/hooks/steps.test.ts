import { expect, test } from 'claude-code/testing'
import { DEFAULT_PRICES, SWITCH_KEY, rawDelegateCost, rawMainCost, rebaseCal, subWork, type Calibration, type Rating, type Situation } from './cost'
import { DEMOTE_GAIN, G_RUNS, G_STABLE, HANDOFF_SHARE, NO_STEPS, PROMOTE_GAIN, STEP_MAX, STEP_MIN, STEP_PRIOR, STEP_PROVE, STEP_REFIT, UNJUST_MAX, actingExp, decide, fitExponent, learnStep, mergeSteps, parseStepState, pricedSteps, scoreRun, typicalShrink, type StepScore, type StepState } from './steps'

const rating = (steps: number): Rating => ({ level: 'medium', fit: {}, type: 'feature', read: 20_000, write: 2_000, steps, reason: '' })
const sit = (stepExp?: number): Situation => ({ tier: 'opus', level: 'medium', context: 100_000, prices: DEFAULT_PRICES, cal: {}, ...(stepExp === undefined ? {} : { stepExp }) })

// Runs whose cost really grows as steps ** (1 + g): ln(actual / estimate) = g * ln(steps), with a little noise.
const runs = (g: number, n: number) =>
  Array.from({ length: n }, (_, i) => {
    const steps = [1, 2, 4, 8, 16, 32][i % 6]!
    const noise = Math.exp(((i * 37) % 11) / 11 * 0.2 - 0.1)
    return { steps, estimated: 1, actual: steps ** g * noise }
  })

test('a guess is priced as it is under no exponent, for one step or none, and shrinks above one', () => {
  expect(pricedSteps(0, -0.2)).toBe(0)
  expect(pricedSteps(1, -0.2)).toBe(1)
  expect(pricedSteps(12, 0)).toBe(12)
  expect(Math.abs(pricedSteps(32, -0.2) - 16)).toBeLessThan(1e-9)
})

test('with no exponent set, estimates are what they were before the exponent existed', () => {
  expect(rawMainCost(rating(20), sit(), 'medium')).toBe(rawMainCost(rating(20), sit(0), 'medium'))
  expect(rawDelegateCost(rating(20), sit(), 'haiku', 'medium')).toBe(rawDelegateCost(rating(20), sit(0), 'haiku', 'medium'))
})

test('a negative exponent lowers long runs and leaves a one-step run alone', () => {
  expect(rawMainCost(rating(30), sit(-0.2), 'medium')).toBeLessThan(rawMainCost(rating(30), sit(0), 'medium'))
  expect(rawMainCost(rating(1), sit(-0.2), 'medium')).toBe(rawMainCost(rating(1), sit(0), 'medium'))
})

test("a hand-off's own steps take only part of the exponent", () => {
  const none = subWork(rating(30), sit(0), 'haiku', 'medium')
  const part = subWork(rating(30), sit(-0.2), 'haiku', 'medium')
  const whole = subWork({ ...rating(30), steps: pricedSteps(30, -0.2) }, sit(0), 'haiku', 'medium')
  expect(part).toBeLessThan(none)
  expect(part).toBeGreaterThan(whole)
  expect(HANDOFF_SHARE).toBeGreaterThan(0)
  expect(HANDOFF_SHARE).toBeLessThan(1)
})

test('the fit finds the exponent that the runs follow', () => {
  const state = runs(-0.25, 100).reduce((s, r) => learnStep(s, r.steps, r.actual, r.estimated), NO_STEPS)
  expect(Math.abs(state.g + 0.25)).toBeLessThan(0.05)
})

test('the exponent stays at the prior between refits, and refits every STEP_REFIT runs', () => {
  const some = runs(-0.3, STEP_REFIT - 1).reduce((s, r) => learnStep(s, r.steps, r.actual, r.estimated), NO_STEPS)
  expect(some.g).toBe(STEP_PRIOR)
  const r = runs(-0.3, STEP_REFIT)[STEP_REFIT - 1]!
  const refit = learnStep(some, r.steps, r.actual, r.estimated)
  expect(refit.g).not.toBe(STEP_PRIOR)
  expect(refit.since).toBe(0)
})

test('with few runs the exponent stays near the prior, with many it follows the runs', () => {
  const few = runs(-0.35, STEP_REFIT).reduce((s, r) => learnStep(s, r.steps, r.actual, r.estimated), NO_STEPS)
  const many = runs(-0.35, 150).reduce((s, r) => learnStep(s, r.steps, r.actual, r.estimated), NO_STEPS)
  expect(Math.abs(few.g - STEP_PRIOR)).toBeLessThan(Math.abs(many.g - STEP_PRIOR))
})

test('the exponent never leaves its range', () => {
  const low = runs(-0.9, 200).reduce((s, r) => learnStep(s, r.steps, r.actual, r.estimated), NO_STEPS)
  const high = runs(0.5, 200).reduce((s, r) => learnStep(s, r.steps, r.actual, r.estimated), NO_STEPS)
  expect(low.g).toBeGreaterThanOrEqual(STEP_MIN)
  expect(high.g).toBeLessThanOrEqual(STEP_MAX)
})

test('only the newest runs are kept', () => {
  const state = runs(-0.2, 300).reduce((s, r) => learnStep(s, r.steps, r.actual, r.estimated), NO_STEPS)
  expect(state.samples.length).toBe(100)
})

test('a run with no cost or no estimate teaches nothing', () => {
  expect(learnStep(NO_STEPS, 10, 0, 1)).toBe(NO_STEPS)
  expect(learnStep(NO_STEPS, 10, 1, 0)).toBe(NO_STEPS)
})

test('the fit of a single run returns a value in range', () => {
  const g = fitExponent([{ ls: 0, lr: 0 }])
  expect(g).toBeGreaterThanOrEqual(-0.6)
  expect(g).toBeLessThanOrEqual(0.2)
})

test('stored state that is damaged falls back to the prior', () => {
  expect(parseStepState(null)).toBe(NO_STEPS)
  expect(parseStepState([])).toBe(NO_STEPS)
  expect(parseStepState({ g: 'x', since: -1, samples: [{ ls: 1 }, 3, { ls: 1, lr: 2 }] })).toEqual({ g: STEP_PRIOR, since: 0, samples: [{ ls: 1, lr: 2 }], scores: [], gs: [], applied: false })
  expect(parseStepState({ g: -5, since: 3, samples: [] }).g).toBe(STEP_MIN)
})

test("another session's runs and this session's add up in one stored copy", () => {
  const stored = runs(-0.2, 30).reduce((s, r) => learnStep(s, r.steps, r.actual, r.estimated), NO_STEPS)
  const merged = mergeSteps(stored, runs(-0.2, 5).map(r => ({ ...r, taken: 1, stepExpUsed: 0, g: STEP_PRIOR })), 0)
  expect(merged.samples.length).toBe(35)
})

// ---- Scoring, promotion and demotion --------------------------------------

const score = (inc: number, cand: number, flip = false, unjust = false): StepScore => ({ inc, cand, flip, unjust })
const withScores = (scores: StepScore[], over: Partial<StepState> = {}): StepState => ({ ...NO_STEPS, scores, gs: [-0.2, -0.2, -0.2], ...over })
const near = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) < tol
const NOW_MS = 1_800_000_000_000

test('a scored run gets the plain error and the error with g, against the actual cost', async () => {
  // 16 steps, a calibrated estimate of 2 with no shrink, actual 1: plain error ln 2; with g -0.25 the estimate is 2 * 0.5 = 1, error 0.
  const s = scoreRun(NO_STEPS, { steps: 16, actual: 1, taken: 2, stepExpUsed: 0, g: -0.25 })
  expect(s.scores.length).toBe(1)
  expect(near(s.scores[0]!.inc, Math.log(2))).toBe(true)
  expect(near(s.scores[0]!.cand, 0)).toBe(true)
  expect(s.scores[0]!.flip).toBe(false)
  expect(s.scores[0]!.unjust).toBe(false)
})

test('the plain estimate is recovered from a taken estimate that was priced with the applied exponent', async () => {
  const applied = scoreRun(NO_STEPS, { steps: 16, actual: 1, taken: 2 * 16 ** -0.25, stepExpUsed: -0.25, g: -0.25 })
  const plain = scoreRun(NO_STEPS, { steps: 16, actual: 1, taken: 2, stepExpUsed: 0, g: -0.25 })
  expect(near(applied.scores[0]!.inc, plain.scores[0]!.inc)).toBe(true)
  expect(near(applied.scores[0]!.cand, plain.scores[0]!.cand)).toBe(true)
})

test('errors are clamped to a factor of ten, and a run with no cost or no estimate is not scored', async () => {
  const far = scoreRun(NO_STEPS, { steps: 1, actual: 1000, taken: 1, stepExpUsed: 0, g: 0 })
  expect(near(far.scores[0]!.inc, Math.log(10))).toBe(true)
  expect(scoreRun(NO_STEPS, { steps: 4, actual: 0, taken: 1, stepExpUsed: 0, g: 0 })).toBe(NO_STEPS)
  expect(scoreRun(NO_STEPS, { steps: 4, actual: 1, taken: 0, stepExpUsed: 0, g: 0 })).toBe(NO_STEPS)
})

test('a flipped hand-off is flagged, and unjust when its real cost was still under the savings bar', async () => {
  // Stay 1 (no shrink), steps 16, g -0.25: the shrunk stay is 0.5, the bar 0.7 of it is 0.35.
  const hand = (actual: number) => scoreRun(NO_STEPS, { steps: 16, actual, taken: 0.3, stepExpUsed: 0, g: -0.25, handedOff: { actingStay: 1, ruleShare: 0.7 } }).scores[0]!
  expect(hand(0.3)).toMatchObject({ flip: true, unjust: true })
  expect(hand(0.4)).toMatchObject({ flip: true, unjust: false })
})

test('nothing changes under STEP_PROVE scores, however good they look', async () => {
  const good = withScores(Array.from({ length: STEP_PROVE - 1 }, () => score(0.5, 0.1)))
  expect(decide(good, NOW_MS)).toBe(good)
})

test('g is promoted when it cuts the error by a tenth, its refits agree and few stopped hand-offs were unjust', async () => {
  const promoted = decide(withScores(Array.from({ length: STEP_PROVE }, () => score(0.5, 0.2))), NOW_MS)
  expect(promoted.applied).toBe(true)
  expect(promoted.appliedAt).toBe(NOW_MS)
  // Promotion keeps the scores and refits it was decided on.
  expect(promoted.scores.length).toBe(STEP_PROVE)
  expect(PROMOTE_GAIN).toBe(0.9)
})

test('g is not promoted with unstable refits, too many unjust flips, or too small a gain', async () => {
  const good = Array.from({ length: STEP_PROVE }, () => score(0.5, 0.2))
  expect(decide(withScores(good, { gs: [-0.1, -0.3, -0.2] }), NOW_MS).applied, 'refits move by more than G_STABLE').toBe(false)
  expect(decide(withScores(good, { gs: [-0.2, -0.2] }), NOW_MS).applied, 'fewer than G_RUNS refits').toBe(false)
  expect(G_STABLE).toBe(0.1)
  expect(G_RUNS).toBe(3)
  // 20 stopped hand-offs, 6 unjust: 30% is over the 25% line.
  const flips = [...Array.from({ length: 20 }, (_, i) => score(0.5, 0.2, true, i < 6)), ...Array.from({ length: 30 }, () => score(0.5, 0.2))]
  expect(decide(withScores(flips), NOW_MS).applied, 'unjust flips over the share').toBe(false)
  // 5 of 20 is exactly the share: allowed.
  const edge = [...Array.from({ length: 20 }, (_, i) => score(0.5, 0.2, true, i < 5)), ...Array.from({ length: 30 }, () => score(0.5, 0.2))]
  expect(decide(withScores(edge), NOW_MS).applied, 'unjust flips at the share').toBe(true)
  expect(UNJUST_MAX).toBe(0.25)
  // A gain of only 5%: 0.475 is over 0.9 of 0.5 (0.45).
  expect(decide(withScores(Array.from({ length: STEP_PROVE }, () => score(0.5, 0.475))), NOW_MS).applied).toBe(false)
})

test('an applied g is demoted when it stops beating the plain estimate by the demotion gain, and kept while it does', async () => {
  const at = (cand: number) => withScores(Array.from({ length: STEP_PROVE }, () => score(0.5, cand)), { applied: true, appliedAt: 5 })
  const stopped = decide(at(0.5), NOW_MS)
  expect(stopped.applied).toBe(false)
  expect(stopped.appliedAt, 'demotion clears nothing else').toBe(5)
  expect(decide(at(0.46), NOW_MS).applied).toBe(true)
  expect(DEMOTE_GAIN).toBe(0.95)
})

test('refits are kept, newest three, and each refit adds one', async () => {
  const at = (n: number) => Array.from({ length: n * STEP_REFIT }, (_, i) => ({ steps: [1, 4, 16, 32][i % 4]!, actual: 1, estimated: 1 }))
  const two = at(2).reduce((s, r) => learnStep(s, r.steps, r.actual, r.estimated), NO_STEPS)
  expect(two.gs.length).toBe(2)
  const five = at(5).reduce((s, r) => learnStep(s, r.steps, r.actual, r.estimated), NO_STEPS)
  expect(five.gs.length).toBe(G_RUNS)
  expect(five.gs[G_RUNS - 1]).toBe(five.g)
})

test('the typical shrink is the median step factor under g, and 1 with no samples', async () => {
  expect(typicalShrink(NO_STEPS)).toBe(1)
  const state = withScores([], { g: -0.25, samples: [{ ls: Math.log(16), lr: 0 }, { ls: Math.log(4), lr: 0 }, { ls: 0, lr: 0 }] })
  // The factors are 0.5, 4 ** -0.25 and 1: the median is the middle one.
  expect(near(typicalShrink(state), 4 ** -0.25)).toBe(true)
})

test('applied exponent is the learned g only while applied', async () => {
  expect(actingExp(NO_STEPS)).toBeUndefined()
  expect(actingExp({ ...NO_STEPS, g: -0.2, applied: true })).toBe(-0.2)
})

test('rebasing scales every ratio but the switch key, keeps the counts, and clamps like a sample', async () => {
  const cal: Calibration = { 'feature:main': { n: 5, ratio: 1.2 }, 'feature:main:opus': { n: 30, ratio: 0.5 }, [SWITCH_KEY]: { n: 9, ratio: 0.3 }, big: { n: 1, ratio: 9 } }
  const out = rebaseCal(cal, 2)
  expect(out['feature:main']).toEqual({ n: 5, ratio: 2.4 })
  expect(out['feature:main:opus']).toEqual({ n: 30, ratio: 1 })
  expect(out[SWITCH_KEY]).toEqual({ n: 9, ratio: 0.3 })
  expect(out.big!.ratio).toBe(10)
  expect(rebaseCal(cal, 1)).toEqual(cal)
  expect(Object.keys(rebaseCal({}, 3))).toEqual([])
})
