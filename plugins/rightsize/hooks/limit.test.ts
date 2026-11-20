import { expect, test } from 'claude-code/testing'
import { COMPACT_TEXT } from './whatsnext'
import { LIMIT_COMPACT, LIMIT_HIDE, LIMIT_MIN_CONTEXT, LIMIT_MORE, LIMIT_WHY, LIMIT_WHY_ID, clock12, effortTag, isLimitId, limitDue, limitHit, limitText, modelTag, statusLine } from './limit'
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
  expect(COMPACT_TEXT.startsWith('Write the summary as a handoff')).toBe(true)
  const headings = ['Goal:', 'Next action:', 'State:', 'Files:', 'Decisions:', 'Instructions:', 'Open questions:', 'Dead ends:']
  headings.slice(1).forEach((h, i) => expect(COMPACT_TEXT.indexOf(h), h).toBeGreaterThan(COMPACT_TEXT.indexOf(headings[i] as string)))
  expect(COMPACT_TEXT.indexOf('Goal:')).toBeGreaterThan(0)
  expect(COMPACT_TEXT).toContain("Quote the user's words when they are unclear or are text to reuse, and do not turn an unclear phrase into a rule.")
  expect(COMPACT_TEXT).not.toContain('\n')
})

// ---- The status line (P-9) ---------------------------------------------------------------------------------

test('effort letters after the model name', async () => {
  expect(modelTag('sonnet', effortTag('medium'))).toBe('Sonnet (M)')
  expect(modelTag('opus', effortTag('high', 'raised'))).toBe('Opus (H↑)')
  expect(modelTag('sonnet', effortTag('low', 'auto'))).toBe('Sonnet (L auto)')
  expect(modelTag(undefined, effortTag('xhigh'))).toBe('(XH)')
  expect(effortTag('max')).toBe('Max')
})

test('limit hit: the average rate since the window started, rounded to 15 minutes, only well before the reset', async () => {
  // 5-hour window, 2.5 hours gone (resets in 2.5 hours), 62% used: hit at 2.5h × 100/62 ≈ 4.03h in, about 1.47h before reset.
  const hit = limitHit(win(62, 2.5 * HOUR), NOW)
  const start = NOW - 2.5 * HOUR
  expect(hit).toBe(Math.round((start + (2.5 * HOUR * 100) / 62) / (15 * 60_000)) * 15 * 60_000)
  expect(limitHit(win(40, 2.5 * HOUR), NOW), 'under pace').toBeUndefined()
  expect(limitHit(win(52, 2.5 * HOUR), NOW), 'hits within 15 minutes of the reset: hidden').toBeUndefined()
  expect(limitHit(win(10, 4.6 * HOUR), NOW), 'too early in the window to judge').toBeUndefined()
  expect(limitHit(win(92, 2.5 * HOUR), NOW), 'nearly used up: the band says so').toBeUndefined()
  expect(limitHit([{ kind: 'spend_limit', percentUsed: 80 }], NOW), 'a spend limit has no reset').toBeUndefined()
})

test('limit hit: the window that runs out first wins', async () => {
  // 7-day: 4 days gone, 80% used: hit 5 days in, a day from now. 5-hour: about 1.5 hours from now.
  const seven = win(80, 3 * 24 * HOUR, 'seven_day')
  const sevenOnly = limitHit(seven, NOW)
  expect(sevenOnly, 'the 7-day window alone is on pace to run out').toBe(Math.round((NOW + 24 * HOUR) / (15 * 60_000)) * 15 * 60_000)
  const fiveOnly = limitHit(win(62, 2.5 * HOUR), NOW)!
  expect(limitHit([...win(62, 2.5 * HOUR), ...seven], NOW)).toBe(fiveOnly)
  expect(limitHit([...win(40, 2.5 * HOUR), ...seven], NOW), 'the 5-hour window under pace: the 7-day one shows').toBe(sevenOnly)
})

test('the status line: limit part when due, else the session cost on API billing, never both', async () => {
  const at = new Date(2026, 10, 16, 15, 45).getTime()
  expect(clock12(at)).toBe('3:45 PM')
  expect(clock12(new Date(2026, 10, 16, 0, 5).getTime())).toBe('12:05 AM')
  expect(statusLine('Sonnet (M)', { limits: win(62, 2.5 * HOUR), now: NOW, api: false })).toBe(`Sonnet (M) · limit ~${clock12(limitHit(win(62, 2.5 * HOUR), NOW)!)}`)
  expect(statusLine('Sonnet (M)', { limits: [], now: NOW, api: true, cost: 1.844 })).toBe('Sonnet (M) · $1.84 session')
  expect(statusLine('Sonnet (M)', { limits: [], now: NOW, api: false, cost: 1.84 }), 'no cost on a subscription').toBe('Sonnet (M)')
  expect(statusLine('Sonnet (M)', { limits: [], now: NOW, api: true, cost: 0.001 }), 'nothing spent yet').toBe('Sonnet (M)')
  expect(statusLine('Sonnet (M)', { limits: win(40, 2.5 * HOUR), now: NOW, api: false })).toBe('Sonnet (M)')
  expect(statusLine('Sonnet (M)', { limits: [], now: NOW, api: false, total: 'rightsize saved ~0.3%' }), 'the total after the model').toBe('Sonnet (M) · rightsize saved ~0.3%')
  expect(statusLine('Sonnet (M)', { limits: win(62, 2.5 * HOUR), now: NOW, api: false, total: 'rightsize about even' }), 'and after the limit').toBe(`Sonnet (M) · limit ~${clock12(limitHit(win(62, 2.5 * HOUR), NOW)!)} · rightsize about even`)
  expect(statusLine('Sonnet (M)', { limits: [], now: NOW, api: true, cost: 1.844, total: 'rightsize saved ~$0.12' })).toBe('Sonnet (M) · $1.84 session · rightsize saved ~$0.12')
})
