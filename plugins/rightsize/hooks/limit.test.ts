import { expect, test } from 'claude-code/testing'
import { COMPACT_BASE } from './whatsnext'
import { LIMIT_COMPACT, LIMIT_HIDE, LIMIT_MIN_CONTEXT, LIMIT_MORE, LIMIT_WHY, LIMIT_WHY_ID, isLimitId, limitDue, limitText } from './limit'
import { clockText } from './warm'

// ---- The usage-limit advice: the pure part -----------------------------------------------------------------

const NOW = 1_800_000_000_000
const HOUR = 3600_000
const win = (percentUsed: number, ms: number, kind = 'five_hour') => [{ kind, percentUsed, resetsAt: new Date(NOW + ms).toISOString() }]

test('due at 90% or more of the 5-hour window, with a big conversation and a reset further off than the cache lives', async () => {
  expect(limitDue(win(90, 3 * HOUR), 100_000, NOW, HOUR)).toEqual({ resetsAt: new Date(NOW + 3 * HOUR).toISOString(), resetAt: NOW + 3 * HOUR })
  expect(limitDue(win(99, 90 * 60_000), 31_000, NOW, HOUR), '31K and 90 minutes to wait').toBeDefined()
})

test('not due: under 90%, a reset within the cache life, 30K tokens or less, another window, or figures that are not there', async () => {
  expect(LIMIT_MIN_CONTEXT).toBe(30_000)
  expect(limitDue(win(89.9, 3 * HOUR), 100_000, NOW, HOUR), 'under 90%').toBeUndefined()
  expect(limitDue(win(95, HOUR), 100_000, NOW, HOUR), 'a wait of exactly the cache life keeps it warm').toBeUndefined()
  expect(limitDue(win(95, 20 * 60_000), 100_000, NOW, HOUR), 'a shorter wait').toBeUndefined()
  expect(limitDue(win(95, -60_000), 100_000, NOW, HOUR), 'a reset in the past').toBeUndefined()
  expect(limitDue(win(95, 3 * HOUR), 30_000, NOW, HOUR), 'exactly 30K').toBeUndefined()
  expect(limitDue(win(95, 3 * HOUR), 12_000, NOW, HOUR), 'a small context').toBeUndefined()
  expect(limitDue(win(95, 3 * HOUR), undefined, NOW, HOUR), 'no context').toBeUndefined()
  expect(limitDue(win(95, 3 * HOUR, 'seven_day'), 100_000, NOW, HOUR), 'the 7-day window is not this advice').toBeUndefined()
  expect(limitDue([{ kind: 'five_hour', percentUsed: 95 }], 100_000, NOW, HOUR), 'no reset time').toBeUndefined()
  expect(limitDue([{ kind: 'five_hour', percentUsed: 95, resetsAt: 'never' }], 100_000, NOW, HOUR), 'a reset time that is not a time').toBeUndefined()
  expect(limitDue([], 100_000, NOW, HOUR)).toBeUndefined()
})

test('the row says the reset time and the saving: dollars on the API, a share of the next window on a subscription', async () => {
  const at = NOW + 3 * HOUR
  const when = clockText(at)
  expect(limitText(at, 0.31, false, undefined)).toBe(`Near your 5-hour limit, resets ${when}. Compact now to save ~$0.31 after the reset.`)
  expect(limitText(at, 0.31, false, { low: 1, high: 3 }), 'the rate is for a subscription only').toBe(`Near your 5-hour limit, resets ${when}. Compact now to save ~$0.31 after the reset.`)
  expect(limitText(at, 0.12, true, { low: 16.5, high: 17.5 })).toBe(`Near your 5-hour limit, resets ${when}. Compact now to save ~2% of your next window.`)
  expect(limitText(at, 0.31, true, undefined)).toBe(`Near your 5-hour limit, resets ${when}. Compact now to save ~$0.31 API-equivalent after the reset.`)
  expect(limitText(at, 0.001, false, undefined)).toContain('save under $0.01 after')
  for (const saving of [0, -1, Number.NaN]) expect(limitText(at, saving, false, undefined), String(saving)).toBeUndefined()
})

test('the words and ids: Why? says what the compaction does, and the instructions keep the work and drop the noise', async () => {
  expect(LIMIT_WHY).toBe('After the reset the whole conversation is read again at full price. A compact now, while the cache is warm, leaves a short summary instead.')
  expect(LIMIT_MORE.map(m => [m.id, m.label])).toEqual([[LIMIT_WHY_ID, 'Why?'], [LIMIT_HIDE, "Don't show again"]])
  expect([LIMIT_COMPACT, LIMIT_WHY_ID, LIMIT_HIDE].every(isLimitId)).toBe(true)
  expect(isLimitId('compact')).toBe(false)
  for (const word of ['current task', 'decisions', 'open questions', 'file paths', 'next steps', 'tool output', 'dead ends']) expect(COMPACT_BASE).toContain(word)
})
