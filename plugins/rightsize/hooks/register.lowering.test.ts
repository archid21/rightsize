import { expect, test } from 'claude-code/testing'
import { CAL_STORE } from './cost'
import { type RunLine, loweringRows } from './report'
import { errorKind } from './struggle'
import { FREE_SWITCHES, LOG_PATH, LOOKUP, RUNS_FILE, drive, engine, last } from './testkit'

// Lowering evidence (P-39, ADR 0070): what stepped a lowered turn back up, and per route how close lowering is to its pause.
// When rightsize lowers or steps up is unchanged.

test('a counted tool error has a rough kind: a test run, a missing file, an edit tool, any other Bash error, else other', () => {
  expect(errorKind('Bash', { command: 'npm test' }, 'boom')).toBe('test failed')
  expect(errorKind('Bash', { command: 'cat src/x.ts' }, 'cat: src/x.ts: No such file or directory')).toBe('file not found')
  expect(errorKind('Read', { file_path: '/x' }, 'File does not exist.')).toBe('file not found')
  expect(errorKind('Edit', { file_path: '/x' }, 'String to replace not found in file.')).toBe('edit failed')
  expect(errorKind('Bash', { command: 'make build' }, 'error: boom')).toBe('command failed')
  expect(errorKind('WebFetch', { url: 'x' }, '500')).toBe('other')
})

const at = '2026-11-14T20:00:00Z'
const lowered = (over: Partial<RunLine> = {}): RunLine => ({ at, id: `r${Math.random()}`, type: 'lookup', tier: 'opus', change: 'lower', ...over })

test('the LOWERING table: per route, lowered turns, step-ups with the most common cause, real failures, the pause rate and status', () => {
  const corrected = lowered({ id: 'c1' })
  const lines: RunLine[] = [
    lowered(),
    lowered({ steppedUp: true, steppedUpBy: 'error', stepUpCause: { tool: 'Bash', kind: 'file not found' } }),
    lowered({ steppedUp: true, steppedUpBy: 'error', stepUpCause: { tool: 'Bash', kind: 'file not found' } }),
    lowered({ steppedUp: true, steppedUpBy: 'error', stepUpCause: { tool: 'Edit', kind: 'edit failed' } }),
    lowered({ steppedUp: true, steppedUpBy: 'steps' }),
    lowered({ tests: 'failed' }),
    corrected,
    { at, kind: 'corrected', ref: 'c1' },
    lowered({ type: 'debug', tier: 'sonnet', steppedUp: true }),
    lowered({ type: 'debug', aborted: true }),
    { at, type: 'lookup', tier: 'opus', change: 'none' },
  ]
  const rows = loweringRows(lines, { misses: { 'lookup:opus': 0.25, 'debug:sonnet': 0.1 }, pause: 0.2, minTasks: 0, counts: {} })
  expect(rows[0]).toEqual(['Work on model', 'Lowered', 'Stepped up (most common cause)', 'Failed', 'Miss rate', 'Lowering'])
  expect(rows[1], 'the 5-step rule alone is not a step-up after an error').toEqual(['lookup on Opus', '7', '3 (Bash file not found)', '2', '25%', 'paused (line 20%)'])
  expect(rows[2], 'an older line has no cause').toEqual(['debug on Sonnet', '1', '1 (not logged)', '0', '10%', 'on (pauses at 20%)'])
  expect(rows.length, 'an aborted turn and an unchanged one are left out').toBe(3)
  expect(loweringRows(lines, { misses: {}, pause: null, minTasks: 5, counts: { 'lookup:opus': 2 } })[1]?.[5]).toBe('waits: 2 of 5 tasks logged')
  expect(loweringRows(lines, { misses: {}, pause: null, minTasks: 0, counts: {} })[1]?.[5]).toBe('on (never pauses)')
  expect(loweringRows([{ at, change: 'none', type: 'lookup', tier: 'opus' }], { misses: {}, pause: 0.2, minTasks: 0, counts: {} }), 'nothing lowered: no table').toEqual([])
})

const LOW_LOOKUP = '{"level":"low","model":"same","size":"small","type":"lookup","read":2000,"write":3000,"steps":1,"reason":"one function lookup"}'

for (const surface of ['desktop', 'terminal'] as const) {
  test(`a lowered turn that steps back up logs the tool and kind of error, its run line carries it, and the report's LOWERING table shows it (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES } })
    // Run lines are stamped with the real time; the report's 30 days count back from the kit's clock.
    h.now = Date.now()
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = LOW_LOOKUP
    await d.submit(LOOKUP)
    await d.step('t1', 0)
    expect(last(h.sent)?.effort, 'runs low').toBe('low')
    await d.bash('fail build')
    await d.step('t1', 1)
    expect(last(h.sent)?.effort, 'a tool error steps it back up, as before').toBe('medium')
    await d.complete('t1')
    expect(h.files[LOG_PATH] ?? '').toContain('effort back to medium on a lowered lookup turn: Bash error (command failed)')
    const run = (h.files[RUNS_FILE] ?? '')
      .trim()
      .split('\n')
      .map(l => JSON.parse(l) as RunLine)
      .find(l => l.steppedUp)
    expect(run?.stepUpCause).toEqual({ tool: 'Bash', kind: 'command failed' })
    const text = await d.report()
    const details = text.slice(text.indexOf('rightsize report details'))
    expect(details).toContain('LOWERING (last 30 days)')
    expect(details).toMatch(/lookup on Opus\s+1\s+1 \(Bash command failed\)/)
  })
}
