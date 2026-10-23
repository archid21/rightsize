import { expect, test } from 'claude-code/testing'
import { type RunLine, buildReport, counterfactual, parseLines, totals, wentWrong } from './report'

const NOW = Date.parse('2026-10-23T18:00:00.000Z')
const ago = (days: number) => new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString()
const run = (x: Partial<RunLine>): RunLine => ({ at: ago(0), kind: 'run', session: 's1', change: 'none', offered: 'none', actual: 0.1, stay: 0.1, taken: 0.1, overhead: 0, ...x })

test('counts a saving against staying, scaled by what the turn really cost', async () => {
  expect(counterfactual(run({ change: 'lower', actual: 0.02, stay: 0.06, taken: 0.03 })), 'staying: 2x the route taken').toBe(0.04)
  expect(counterfactual(run({ change: 'none', actual: 0.05, stay: 0.09, taken: 0.03 })), 'unchanged: no saving').toBe(0.05)
  expect(counterfactual(run({ change: 'lower', steppedUp: true, actual: 0.05, stay: 0.1, taken: 0.02 })), 'stepped up: none claimed').toBe(0.05)
  expect(counterfactual({ at: ago(0), actual: 0.05 }), 'a line from before 0.5: none claimed').toBe(0.05)
  expect(counterfactual(run({ change: 'lower', escalations: [{ step: 3, from: 'low', to: 'medium', why: 'x' }], actual: 0.05, stay: 0.1, taken: 0.02 })), 'raised mid-turn: none claimed').toBe(0.05)
})

test('keeps raising apart from saving, takes off the rating calls, and skips stopped turns', async () => {
  const t = totals([
    run({ change: 'lower', offered: 'lower', actual: 0.02, stay: 0.06, taken: 0.03, overhead: 0.001 }),
    run({ change: 'raise', offered: 'raise', actual: 0.3, stay: 0.1, taken: 0.2, overhead: 0.001 }),
    run({ change: 'none', offered: 'lower', overhead: 0.001 }),
    run({ change: 'lower', aborted: true, actual: 0.5, stay: 1, taken: 0.5, overhead: 0.001 }),
    { at: ago(0), kind: 'overhead', overhead: 0.001 },
  ])
  expect(t.rated).toBe(4)
  expect(t.declined, 'kept the level once').toBe(1)
  expect(Number(t.saved.toFixed(5))).toBe(0.02)
  expect(Number(t.extra.toFixed(5)), 'raising spent half again').toBe(0.15)
  expect(Number(t.overhead.toFixed(5)), 'every rating call, the failed one too').toBe(0.005)
})

test('reports each period, the window kept for a subscriber, and says when it cost more', async () => {
  const lines = [
    run({ change: 'lower', offered: 'lower', actual: 0.5, stay: 1, taken: 0.5, overhead: 0.01, durationMs: 60_000, before: { five_hour: 10 }, after: { five_hour: 11 } }),
    run({ change: 'none', actual: 0.5, durationMs: 60_000, before: { five_hour: 11 }, after: { five_hour: 12 } }),
    run({ at: ago(20), session: 'old', change: 'lower', actual: 0.1, stay: 0.1, taken: 0.1, overhead: 0.05 }),
  ]
  const text = buildReport(lines, [], { now: NOW, session: 's1', subscription: true })
  expect(text).toContain('This session: 2 prompts rated, 1 changed (1 lowered).')
  expect(text).toContain('Saved ~$0.49 (~33% of what these turns would have cost) after $0.01 of rating calls.')
  // 2% of the window for $1 over 2 minutes: $0.49 saved is ~1% and about 1 minute.
  expect(text).toContain('Kept ~1.0% of your 5-hour window, about 1 more minute at this pace.')
  expect(text, 'the old session is in 30 days only').toContain('Last 7 days: 2 prompts rated')
  expect(text).toContain('Last 30 days: 3 prompts rated, 2 changed')
  expect(buildReport(lines, [], { now: NOW, session: 's1', subscription: false }), 'no window line on the API').not.toContain('5-hour')
  const worse = buildReport([run({ change: 'none', overhead: 0.03 })], [], { now: NOW, session: 's1', subscription: false })
  expect(worse).toContain('Cost ~$0.03 more than it saved, counting $0.03 of rating calls.')
})

test('lists what went wrong, and how far the estimates were off', async () => {
  const lines = [
    run({ change: 'lower', steppedUp: true }),
    run({ change: 'delegate-down', route: 'delegate:haiku', actual: 0.4, stay: 0.3, agentCalls: 3 }),
    run({ change: 'delegate-up', route: 'main' }),
    run({ aborted: true }),
    ...[3, 2, 1.5, 1.1, 1, 1].map(x => run({ actual: 0.1 * x, taken: 0.1 })),
  ]
  const out = wentWrong(lines, [{ at: ago(0), kept: false }, { at: ago(0), kept: true }])
  expect(out).toContain('1 lowered turn stepped back up: the task was harder than rated. No saving is counted for them.')
  expect(out).toContain('1 hand-off cost more than staying would have: $0.40 vs ~$0.30.')
  expect(out).toContain('1 hand-off needed rework (more than one subagent call).')
  expect(out).toContain('Claude skipped 1 hand-off you chose and did the work itself.')
  expect(out).toContain('1 of 2 effort switches missed the cache.')
  expect(out).toContain('1 turn you stopped: their rating cost counts, no saving does.')
  expect(out.some(l => l.endsWith('calibration is closing the gap.')), 'later runs closer').toBe(true)
  expect(buildReport([], [], { now: NOW, session: 's1', subscription: false })).toContain('- Nothing yet.')
})

test('turns during or after a workflow claim no saving and get their own line', async () => {
  const fanned = run({ change: 'lower', actual: 2, stay: 1, taken: 0.5, workflows: 1, afterWorkflow: true })
  expect(counterfactual(fanned), 'no saving claimed').toBe(2)
  const later = run({ change: 'none', actual: 0.4, afterWorkflow: true })
  const text = wentWrong([fanned, later, run({})], []).join('\n')
  expect(text).toContain('2 turns ran during or after a workflow (1 workflow, ultracode or asked for): $2.40.')
})

test('reads the log, skipping a torn first line', async () => {
  const lines = parseLines<RunLine>(`{"at":"x","actu\n${JSON.stringify(run({}))}\n\nnot json\n`)
  expect(lines.length).toBe(1)
})
