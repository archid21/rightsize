import { expect, test } from 'claude-code/testing'
import { readTrimSavings } from './trim'

const NOW = Date.parse('2026-11-11T18:00:00Z')
const line = (o: Record<string, unknown>) => JSON.stringify({ v: 1, ts: '2026-11-11T10:00:00Z', session: 's1', feature: 'tool_cleanup', before: 2700, after: 0, tokens_saved: 1000, assumed: false, full_copy: null, ...o })
const log = (...ls: string[]) => ls.join('\n') + '\n'

test('trim: sums the log per feature, all time, 30 days and this session', () => {
  const t = readTrimSavings(
    log(line({}), line({ tokens_saved: 500 }), line({ feature: 'output_cap', session: null, tokens_saved: 300 }), line({ ts: '2026-09-01T10:00:00Z', tokens_saved: 700, session: 'old' })),
    '', NOW, 's1')
  expect(t?.allTime.tool_cleanup).toEqual({ saves: 3, tokens: 2200, assumed: false })
  expect(t?.last30.tool_cleanup, 'the September line is older than 30 days').toEqual({ saves: 2, tokens: 1500, assumed: false })
  expect(t?.last30.output_cap?.tokens).toBe(300)
  expect(t?.session.tool_cleanup?.tokens, 'only this session').toBe(1500)
  expect(t?.session.output_cap, 'output_cap logs no session').toBeUndefined()
})

test('trim: totals and unfolded log lines add up; folded lines are not counted twice', () => {
  const totals = JSON.stringify({ v: 1, through: '2026-11-10T12:00:00Z', days: { '2026-08-01': { tool_cleanup: { saves: 4, tokens_saved: 4000, assumed: false } }, '2026-11-10': { tool_cleanup: { saves: 1, tokens_saved: 100, assumed: false } } } })
  const t = readTrimSavings(log(line({ ts: '2026-11-10T11:00:00Z', tokens_saved: 100 }), line({ ts: '2026-11-11T09:00:00Z', tokens_saved: 50 })), totals, NOW, 'x')
  expect(t?.allTime.tool_cleanup).toEqual({ saves: 6, tokens: 4150, assumed: false })
  expect(t?.last30.tool_cleanup, 'August is out, November 10 totals and the new line are in').toEqual({ saves: 2, tokens: 150, assumed: false })
})

test('trim: assumed figures are marked; other versions, bad lines and bad files are ignored', () => {
  const t = readTrimSavings(log(line({ feature: 'browser_scale', tokens_saved: 505, assumed: true }), line({ v: 2, tokens_saved: 9999 }), 'not json', '{"v":1}'), '{bad', NOW, 's1')
  expect(t?.allTime.browser_scale).toEqual({ saves: 1, tokens: 505, assumed: true })
  expect(t?.allTime.tool_cleanup).toBeUndefined()
  expect(readTrimSavings('', '', NOW, 's1'), 'no files: no section').toBeUndefined()
  expect(readTrimSavings('garbage', '[]', NOW, 's1')).toBeUndefined()
})
