import { expect, test } from 'claude-code/testing'
import { DEFAULT_RULES, SAVING_RULE } from './cost'
import { FIXED } from './settings'

// P-74 (ADR 0090): a replay of the run logs found hand-downs near the bar rarely missed and cost about a third of staying,
// so a helper route is taken when it is estimated under 90% of staying (was 70%).
test('the hand-off bar is 90% of staying', () => {
  expect(SAVING_RULE).toBe(0.9)
  expect(DEFAULT_RULES.handOff).toBe(0.9)
  expect(FIXED.handOff).toBe(0.9)
})
