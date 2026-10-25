import { expect, test } from 'claude-code/testing'
import { type RunLine, buildReport, counterfactual, fixedLines, haikuLines, parseLines, shareMessage, tieCounts, totals, wentWrong } from './report'

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
  expect(text).toContain('This session and last 7 days\n  Prompts: 2 rated, 1 changed (1 lowered).')
  // 2% of the window for $1 over 2 minutes: $0.49 saved is ~1% and about 1 minute. The window leads; dollars follow as API-equivalent.
  expect(text).toContain(
    '  Kept ~1.0% of your 5-hour window, about 1 more minute at this pace.\n  Saved ~33% of the usage these turns would have taken, after rating calls (~$0.49 saved, $0.01 of rating calls).',
  )
  expect(text).toContain('Dollar amounts are API-equivalent')
  const api = buildReport(lines, [], { now: NOW, session: 's1', subscription: false })
  expect(api).toContain('Saved ~$0.49 (~33% of what these turns would have cost) after $0.01 of rating calls.')
  expect(api, 'no API-equivalent label on the API').not.toContain('API-equivalent')
  expect(text, 'the old session is in 30 days only').toContain('This session and last 7 days\n  Prompts: 2 rated')
  expect(text).toContain('Last 30 days\n  Prompts: 3 rated, 2 changed')
  expect(buildReport(lines, [], { now: NOW, session: 's1', subscription: false }), 'no window line on the API').not.toContain('5-hour')
  const worse = buildReport([run({ change: 'none', overhead: 0.03 })], [], { now: NOW, session: 's1', subscription: false })
  expect(worse).toContain('Cost ~$0.03 more than it saved, counting $0.03 of rating calls.')
  const worseSub = buildReport([run({ change: 'none', overhead: 0.03 })], [], { now: NOW, session: 's1', subscription: true })
  expect(worseSub, 'no window measured yet: the share line alone').toContain(
    'This session, last 7 days and last 30 days\n  Prompts: 1 rated, 0 changed.\n  Used more than it saved, counting rating calls (~$0.03 more, $0.03 of rating calls).',
  )
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

test('fixed context: request-weighted, the biggest parts first, nothing when it cost nothing', async () => {
  const f = (tokens: number, requests: number, cost: number) => run({ requests, actual: 1, fixed: { tokens, mcp: tokens - 4000, memory: 4000, agents: 0, skills: 0, cost, servers: { linear: tokens - 4000 } } })
  expect(fixedLines([f(14000, 10, 0.5), f(24000, 30, 1.5)])).toEqual([
    'Fixed context (last 30 days): ~22K tokens rode along on every request: MCP tools ~18K (linear 20K), CLAUDE.md and memory ~4K.',
    "  Re-reading it cost at least ~$2.00 over 40 requests (~100% of what those turns cost). rightsize can't trim it: disconnect MCP servers you don't use (/mcp), or trim CLAUDE.md and memory files.",
  ])
  const skills = run({ requests: 5, actual: 1, fixed: { tokens: 15000, mcp: 300, memory: 1000, agents: 2500, skills: 11200, cost: 0.03 } })
  expect(fixedLines([skills])[1], 'the advice follows the biggest parts').toContain("rightsize can't trim it: turn off plugins and skills you don't use (/plugin), or remove custom agents you don't use (/agents).")
  expect(fixedLines([f(14000, 10, 0.001)])).toEqual([])
  expect(fixedLines([run({})])).toEqual([])
})

test("Claude's subagents moved to a cheaper model: counted, and their saving added", async () => {
  const sub = (x: Partial<RunLine>): RunLine => ({ at: ago(0), kind: 'subagent', session: 's1', type: 'search', from: 'opus', tier: 'haiku', level: 'low', estimate: 0.01, parentEstimate: 0.2, actual: 0.02, ...x })
  const t = totals([run({ actual: 0.5 }), sub({}), sub({ aborted: true })])
  expect([t.rated, t.subagents]).toEqual([1, 2])
  // 0.02 on Haiku against an estimate 20x higher on Opus: 0.40 that way, 0.38 saved. The stopped one claims nothing.
  expect(Math.abs(t.saved - 0.38) < 1e-9).toBe(true)
  expect(t.spent, 'its cost is already in its turn').toBe(0.5)
  const text = buildReport([run({ actual: 0.5 }), sub({})], [], { now: NOW, session: 's1', subscription: false })
  expect(text).toContain('Prompts: 1 rated, 0 changed. 1 subagent Claude started ran on a cheaper model.')
  expect(text).toContain('Saved ~$0.38')
  expect(buildReport([sub({})], [], { now: NOW, session: 's1', subscription: false }), 'a session with only a subagent line').toContain('Prompts: 0 rated, 0 changed. 1 subagent Claude started ran on a cheaper model.')
})

test('close calls: how many the task-type guide decided and how many were explored, only when there were some', async () => {
  const lines = [
    run({ tie: { by: 'guide', over: 'opus' } }),
    run({ tie: { by: 'stronger', over: 'sonnet' } }),
    run({ tie: { by: 'explore', over: 'sonnet' } }),
    // A moved subagent's close call counts too; a line from 20 days ago is in 30 days only.
    run({ resized: [{ tie: { by: 'guide', over: 'opus' } }, {}] }),
    run({ at: ago(20), tie: { by: 'guide', over: 'opus' } }),
    run({}),
  ]
  expect(tieCounts(lines)).toEqual({ guided: 4, explored: 1 })
  const text = buildReport(lines, [], { now: NOW, session: 's1', subscription: false })
  const out = text.split('\n')
  const week = out.slice(out.findIndex(l => l.startsWith('Last 7 days')), out.findIndex(l => l.startsWith('Last 30 days')))
  expect(week.join('\n'), '7 days: three guided, one explored').toContain('3 close calls decided by the task-type guide, 1 explored.')
  expect(text, '30 days adds the older one').toContain('4 close calls decided by the task-type guide, 1 explored.')
  expect(text.match(/close calls? decided/g)?.length, 'not in the session section').toBe(2)
  const none = buildReport([run({}), run({ resized: [{}] })], [], { now: NOW, session: 's1', subscription: false })
  expect(none, 'nothing to say without ties').not.toContain('close call')
  expect(tieCounts([{ at: ago(0), kind: 'overhead', overhead: 0.1 }])).toEqual({ guided: 0, explored: 0 })
  expect(buildReport([run({ tie: { by: 'explore', over: 'opus' } })], [], { now: NOW, session: 's1', subscription: false })).toContain('0 close calls decided by the task-type guide, 1 explored.')
})

test("check and feedback lines are not rated runs, but a check's cost counts as overhead", async () => {
  const lines: RunLine[] = [
    run({ change: 'none', overhead: 0.001 }),
    { at: ago(0), kind: 'check', type: 'debug', fit: { sonnet: 'low' }, check: { by: 'sonnet', fit: { sonnet: null } }, overhead: 0.004 },
    { at: ago(0), kind: 'feedback', ref: 'a', value: 'down' },
  ]
  const t = totals(lines)
  expect(t.rated).toBe(1)
  expect(Number(t.overhead.toFixed(5))).toBe(0.005)
  expect(buildReport(lines, [], { now: NOW, session: 's1', subscription: false })).toContain('Prompts: 1 rated, 0 changed.')
})

test("says how often Haiku's judgement was wrong, and which hand-downs are paused", async () => {
  expect(haikuLines([run({}), run({ change: 'lower', steppedUp: false })]), 'no misses: nothing to say').toEqual([])
  const handDown = (rework: boolean) => run({ type: 'search', route: 'delegate:haiku', change: 'delegate-down', agentCalls: rework ? 2 : 1 })
  const lines = [handDown(true), handDown(true), handDown(false), handDown(false), handDown(false), run({ type: 'lookup', change: 'lower', tier: 'opus', steppedUp: true })]
  const out = haikuLines(lines)
  expect(out[0]).toBe("Haiku's judgement was wrong on 3 of 6 checked prompts (50%).")
  expect(out[1], 'Haiku was wrong on 2 of 5 search hand-downs: 40%, over the 30% line').toBe('Hand-downs of search work to Haiku (and lowering effort on it) are paused: wrong on 40% of 5.')
  const calm = haikuLines([...lines.slice(2, 5), run({ type: 'lookup', change: 'lower', tier: 'opus', steppedUp: true })])
  expect(calm.length, 'under 5 outcomes on any one key: nothing paused').toBe(1)
  expect(wentWrong(lines, []).some(w => w.startsWith("Haiku's judgement was wrong on 3 of 6")), 'in the report').toBe(true)
  expect(buildReport(lines, [], { now: NOW, session: 's1', subscription: false })).toContain("- Hand-downs of search work to Haiku")
})

test('the report names a pause only at the line Pause after misses sets, and not at all when it is off', async () => {
  const handDown = (rework: boolean) => run({ type: 'search', route: 'delegate:haiku', change: 'delegate-down', agentCalls: rework ? 2 : 1 })
  // Wrong on 2 of 5 search hand-downs to Haiku: 40%.
  const lines = [handDown(true), handDown(true), handDown(false), handDown(false), handDown(false)]
  const paused = (pause?: number | null) => haikuLines(lines, pause).some(l => l.includes('are paused'))
  expect(paused(), 'the default line, 30%').toBe(true)
  expect(paused(0.4), 'at the line').toBe(true)
  expect(paused(0.5), 'under a looser line').toBe(false)
  expect(paused(0.2)).toBe(true)
  expect(paused(null), 'off: nothing is paused').toBe(false)
  expect(haikuLines(lines, null)[0], 'the miss rate is still said').toContain("Haiku's judgement was wrong on 2 of 5")
  const report = (pause?: number | null) => buildReport(lines, [], { now: NOW, session: 's1', subscription: false, ...(pause === undefined ? {} : { pause }) })
  expect(report()).toContain('are paused')
  expect(report(null)).not.toContain('are paused')
  expect(report(0.5)).not.toContain('are paused')
})

test("a workflow's moved agents are counted but save nothing", async () => {
  const sub = (x: Partial<RunLine>): RunLine => ({ at: ago(0), kind: 'subagent', type: 'search', from: 'opus', tier: 'haiku', level: 'low', estimate: 0.01, parentEstimate: 0.1, actual: 0.01, aborted: false, ...x })
  const own = totals([sub({})])
  expect([own.subagents, Number(own.saved.toFixed(5))], "Claude's own subagent: the same work on the parent's model, less what it cost").toEqual([1, 0.09])
  const inWorkflow = totals([sub({ afterWorkflow: true })])
  expect([inWorkflow.subagents, inWorkflow.saved], 'a workflow agent: counted, no saving').toEqual([1, 0])
})

test('the report says when cost measurement restarted, and counts a pause only from then on', async () => {
  const handDown = (rework: boolean, days: number) => run({ at: ago(days), type: 'search', route: 'delegate:haiku', change: 'delegate-down', agentCalls: rework ? 2 : 1 })
  // Wrong on 3 of 6 hand-downs, all before the restart (a day ago).
  const lines = [handDown(true, 3), handDown(true, 3), handDown(true, 3), handDown(false, 3), handDown(false, 3), handDown(false, 3)]
  const from = NOW - 24 * 60 * 60 * 1000
  expect(haikuLines(lines)[0], 'the history counts all of it').toContain('wrong on 3 of 6')
  expect(haikuLines(lines).some(l => l.includes('are paused')), 'nothing was restarted: paused').toBe(true)
  expect(haikuLines(lines, 0.3, from)[0], 'still counted').toContain('wrong on 3 of 6')
  expect(haikuLines(lines, 0.3, from).some(l => l.includes('are paused')), 'but rightsize ignores it now: nothing paused').toBe(false)
  const report = buildReport(lines, [], { now: NOW, session: 's1', subscription: false, measureFrom: new Date(from).toISOString() })
  expect(report).toContain('Cost measurement restarted on 2026-10-22.')
  expect(report).not.toContain('are paused')
  expect(report, 'periods still read every line').toContain('This session, last 7 days and last 30 days\n  Prompts: 6 rated')
  expect(buildReport(lines, [], { now: NOW, session: 's1', subscription: false })).not.toContain('Cost measurement restarted')
})

const saver = (x: Partial<RunLine> = {}) => run({ change: 'lower', offered: 'lower', actual: 0.05, stay: 0.1, taken: 0.05, ...x })
const many = (n: number, x: Partial<RunLine> = {}) => Array.from({ length: n }, () => saver(x))

test('share: shows the estimated saving with API wording', async () => {
  // Staying costs 2x: net saving 50% of what the turns would have cost.
  const text = shareMessage(many(20), { now: NOW, subscription: false })
  const [head, , msg, , note] = text.split('\n')
  expect(head).toBe('Copy and paste this anywhere. rightsize sends nothing itself.')
  expect(msg).toBe('rightsize cut my Claude Code spend by about 50% over the last 30 days, by its own estimate. It matches each prompt to the right model and effort level. Free and open source: https://aivalue.blog/rightsize')
  expect(note).toBe("The number is rightsize's estimate from your last 30 days (20 rated prompts); /rightsize report shows the details. Edit the message as you like.")
})

test('share: subscription wording', async () => {
  const text = shareMessage(many(25), { now: NOW, subscription: true })
  expect(text).toContain('rightsize saved about 50% of my Claude Code usage over the last 30 days, by its own estimate.')
  expect(text).toContain('(25 rated prompts)')
})

test('share: under 20 rated prompts gives no number', async () => {
  const text = shareMessage(many(19), { now: NOW, subscription: false })
  expect(text).not.toContain('by its own estimate')
  expect(text).not.toContain('rated prompts)')
  expect(text).toContain("I'm using rightsize, a free Claude Code mod that matches each prompt to the right model and effort level, and shows what it changed. Open source: https://aivalue.blog/rightsize")
  expect(text).toContain('Once rightsize has 20 rated prompts and an estimated saving of 5% or more in the last 30 days, this message includes it.')
})

test('share: a saving under 5% gives no number and says so', async () => {
  // Saves 0.004 of 0.1 per prompt: about 4%.
  const text = shareMessage(many(20, { actual: 0.1, stay: 0.104, taken: 0.1 }), { now: NOW, subscription: false })
  expect(text).not.toContain('by its own estimate')
  expect(text).toContain("No saving is included: rightsize's estimate for your last 30 days is under 5%.")
  const none = shareMessage(many(20, { change: 'none', offered: 'none' }), { now: NOW, subscription: false })
  expect(none).toContain('under 5%')
})

test('share: lines older than 30 days or before measureFrom do not count', async () => {
  const old = many(20, { at: ago(40) })
  expect(shareMessage(old, { now: NOW, subscription: false })).toContain('Once rightsize has 20 rated prompts')
  const lines = [...many(15, { at: ago(10) }), ...many(5, { at: ago(1) })]
  expect(shareMessage(lines, { now: NOW, subscription: false })).toContain('about 50%')
  expect(shareMessage(lines, { now: NOW, subscription: false, measureFrom: ago(5) })).toContain('Once rightsize has 20 rated prompts')
})

test('share: always writes rightsize in lowercase, with the link, and no exclamation marks', async () => {
  for (const lines of [many(20), many(3)]) {
    for (const subscription of [false, true]) {
      const text = shareMessage(lines, { now: NOW, subscription })
      expect(text).not.toMatch(/Rightsize|RIGHTSIZE/)
      expect(text).toContain('https://aivalue.blog/rightsize')
      expect(text).not.toContain('!')
    }
  }
})
