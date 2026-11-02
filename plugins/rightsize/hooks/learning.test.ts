import { expect, test } from 'claude-code/testing'
import { DEFAULT_PRICES, plan, type Plan, type Rating, type Situation } from './cost'
import { learningNote, planLabel } from './learning'

const rating = (over: Partial<Rating>): Rating => ({ level: 'medium', fit: {}, type: 'feature', read: 10_000, write: 1000, steps: 40, reason: '', ...over })
// A hand-off that sits under the 70% line on Opus: about 0.63 of staying. Learning at g -0.2 shrinks the steps and takes it over the line.
const r = rating({ fit: { haiku: 'medium', sonnet: 'medium', opus: 'medium' } })
const s: Situation = { tier: 'opus', level: 'medium', context: 20_000, prices: DEFAULT_PRICES, cal: {} }

test('the same plan on both sides is not a difference', async () => {
  const p = plan(r, s, 'low')
  const same = learningNote(p, p, 0, false)
  expect(same.differs, 'same label on both sides').toBe(false)
  expect(same.plan).toBe(planLabel(p))
  expect(same.g).toBe(0)
  const none: Plan = { kind: 'none', why: 'x' }
  expect(learningNote(none, none, -0.2, false)).toEqual({ g: -0.2, plan: 'none', differs: false, applied: false })
})

test('a hand-down that the learned exponent drops differs, and is labelled none', async () => {
  const acting = plan(r, s, 'low')
  expect(acting, 'with no stepExp, the work is handed down to Haiku').toMatchObject({ kind: 'delegate', dir: 'down', tier: 'haiku' })
  const learning = plan(r, { ...s, stepExp: -0.2 }, 'low')
  expect(learning.kind, 'shrunk steps keep the work on Opus').toBe('none')
  const note = learningNote(acting, learning, -0.2, false)
  expect(note.plan).toBe('none')
  expect(note.differs).toBe(true)
  expect(note.g).toBe(-0.2)
  expect(note.delegateCost, 'no hand-off costs when the learning plan has none').toBeUndefined()
})

test('a stepExp changes a hand-down decision, and no stepExp or a zero one does not', async () => {
  const bare = plan(r, s, 'low')
  expect(plan(r, { ...s, stepExp: 0 }, 'low'), 'zero is the same as absent').toEqual(bare)
  expect(plan(r, { ...s, stepExp: -0.2 }, 'low').kind).not.toBe('delegate')
  expect(bare.kind).toBe('delegate')
})

test('labels: effort, switch, and hand-offs carry their direction and model', async () => {
  expect(planLabel({ kind: 'none', why: 'x' })).toBe('none')
  expect(planLabel({ kind: 'effort', dir: 'lower', level: 'low' })).toBe('effort-lower')
  expect(planLabel({ kind: 'effort', dir: 'raise', level: 'xhigh' })).toBe('effort-raise')
  expect(planLabel({ kind: 'switch', tier: 'opus', level: 'high', cost: 1, mainCost: 2, rule: 'review' })).toBe('switch:opus')
  expect(planLabel({ kind: 'delegate', dir: 'down', tier: 'haiku', level: 'low', delegateCost: 1, mainCost: 2 })).toBe('delegate-down:haiku')
  expect(planLabel({ kind: 'delegate', dir: 'up', tier: 'fable', level: 'high', delegateCost: 3, mainCost: 2 })).toBe('delegate-up:fable')
})

test('a hand-off note rounds its costs to five decimals, and a switch note carries none', async () => {
  const none: Plan = { kind: 'none', why: 'x' }
  const down: Plan = { kind: 'delegate', dir: 'down', tier: 'haiku', level: 'low', delegateCost: 0.1234567, mainCost: 0.7654321 }
  expect(learningNote(none, down, 0, false)).toEqual({ g: 0, plan: 'delegate-down:haiku', differs: true, applied: false, delegateCost: 0.12346, mainCost: 0.76543 })
  const sw: Plan = { kind: 'switch', tier: 'opus', level: 'high', cost: 1, mainCost: 2, rule: 'review' }
  expect(learningNote(none, sw, 0, true)).toEqual({ g: 0, plan: 'switch:opus', differs: true, applied: true })
})
