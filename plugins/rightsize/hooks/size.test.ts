import { expect, test } from 'claude-code/testing'
import { SIZE_STEPS, isSizeId, sizeStep, sizeText } from './size'

test('the steps are 40, 50, 60, 70, 80 and 90 percent', async () => {
  expect([...SIZE_STEPS]).toEqual([40, 50, 60, 70, 80, 90])
})

test('the step is the highest one reached and not yet said', async () => {
  expect(sizeStep(79_999, 200_000, undefined, 0), 'under 40%').toBeUndefined()
  expect(sizeStep(80_000, 200_000, undefined, 0), 'exactly 40%').toBe(40)
  expect(sizeStep(125_000, 200_000, undefined, 0), 'jumped past 50 and 60: one warning, the highest').toBe(60)
  expect(sizeStep(125_000, 200_000, undefined, 60), 'already said').toBeUndefined()
  expect(sizeStep(145_000, 200_000, undefined, 60)).toBe(70)
  expect(sizeStep(199_000, 200_000, undefined, 80)).toBe(90)
})

test('steps at or above the auto-compact point are skipped', async () => {
  // Auto-compaction at 160K of 200K (80%): steps 40 to 70 stay; 80 (160K) is at it and 90 is above it.
  expect(sizeStep(150_000, 200_000, 160_000, 0)).toBe(70)
  expect(sizeStep(170_000, 200_000, 160_000, 70), 'the 80 step is at the threshold: skipped').toBeUndefined()
  expect(sizeStep(190_000, 200_000, 160_000, 70)).toBeUndefined()
  expect(sizeStep(170_000, 200_000, undefined, 70), 'auto-compact off: nothing skipped').toBe(80)
  expect(sizeStep(100_000, 200_000, 0, 0), 'a threshold of 0 is no threshold').toBe(50)
})

test('unusable figures give no step', async () => {
  for (const [t, w] of [[undefined, 200_000], [100_000, undefined], [0, 200_000], [100_000, 0], [Number.NaN, 200_000]] as const) expect(sizeStep(t, w, undefined, 0)).toBeUndefined()
})

test('the words and ids', async () => {
  expect(sizeText(60, 120_000, 200_000)).toBe('Context is 60% full (120K of 200K tokens). A compact now makes every later turn cheaper.')
  expect(['size-compact', 'size-why', 'size-hide'].every(isSizeId)).toBe(true)
  expect(isSizeId('limit-compact')).toBe(false)
})
