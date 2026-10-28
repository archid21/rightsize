import { expect, test } from 'claude-code/testing'
import { SESSION_TOTAL, accuracyRows, type RunLine, bandShareText, buildReport, costTag, counterfactual, fixedBlock, parseLines, problems, sessionTotal, shareMessage, shareText, span, tieCounts, totals, usedTag, windowCostText, windowRates } from './report'
import type { StartBlock } from './start'

const NOW = Date.parse('2026-10-23T18:00:00.000Z')
const ago = (days: number) => new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString()
const run = (x: Partial<RunLine>): RunLine => ({ at: ago(0), kind: 'run', session: 's1', change: 'none', offered: 'none', actual: 0.1, stay: 0.1, taken: 0.1, overhead: 0, ...x })
const report = (lines: RunLine[], opts: { subscription?: boolean; switches?: { at: string; kept?: boolean }[]; start?: StartBlock; pause?: number | null; measureFrom?: string; markdown?: boolean } = {}) =>
  buildReport(lines, opts.switches ?? [], { now: NOW, session: 's1', subscription: opts.subscription ?? false, markdown: opts.markdown === true, ...(opts.start ? { start: opts.start } : {}), ...(opts.pause !== undefined ? { pause: opts.pause } : {}), ...(opts.measureFrom ? { measureFrom: opts.measureFrom } : {}) })
/** A table row's cells (session, 7 days, 30 days), by its label. */
const cells = (text: string, label: string) => text.split('\n').find(l => l.startsWith(`  ${label}`))?.slice(2 + label.length).trim().split(/ {2,}/)
/** The report's section titles, in order. */
const titles = (text: string) => text.split('\n').filter(l => /^[A-Z]{3}/.test(l)).map(l => l.split('  ')[0])
/** The rows of one section, up to its blank line. */
const SUB_FOOT = 'Dollar amounts are API-equivalent: what the same use would cost on the API. You only pay for your subscription.'
const sectionOf = (text: string, title: string) => {
  const out = text.split('\n')
  const at = out.findIndex(l => l.startsWith(title))
  return out.slice(at + 1, out.findIndex((l, i) => i > at && l === '')).map(l => l.trim())
}

test('counts a saving against the frozen baseline, not one rescaled by what the turn really cost', async () => {
  expect(counterfactual(run({ change: 'lower', actual: 0.02, stay: 0.06, taken: 0.03 })), 'the baseline as it was recorded').toBe(0.06)
  expect(counterfactual(run({ change: 'lower', actual: 0.2, stay: 0.06, taken: 0.03 })), 'a turn that cost far more than estimated leaves the baseline alone').toBe(0.06)
  expect(counterfactual(run({ change: 'lower', actual: 0.002, stay: 0.06, taken: 0.03 })), 'and so does one that cost far less').toBe(0.06)
  expect(counterfactual(run({ change: 'delegate-down', route: 'delegate:haiku', actual: 0.4, stay: 0.3, taken: 0.1 })), 'a hand-off that cost more than staying').toBe(0.3)
  expect(counterfactual(run({ change: 'none', actual: 0.05, stay: 0.09, taken: 0.03 })), 'unchanged: no saving').toBe(0.05)
  expect(counterfactual(run({ change: 'lower', steppedUp: true, actual: 0.05, stay: 0.1, taken: 0.02 })), 'stepped up: none claimed').toBe(0.05)
  expect(counterfactual({ at: ago(0), actual: 0.05 }), 'a line from before 0.5: none claimed').toBe(0.05)
  expect(counterfactual(run({ change: 'lower', escalations: [{ step: 3, from: 'low', to: 'medium', why: 'x' }], actual: 0.05, stay: 0.1, taken: 0.02 })), 'raised mid-turn: none claimed').toBe(0.05)
})

test('a task that cost more than its baseline is a negative saving, printed as a plain negative amount', async () => {
  const lines = [run({ change: 'lower', offered: 'lower', actual: 0.5, stay: 0.2, taken: 0.1 }), run({ change: 'lower', offered: 'lower', actual: 0.1, stay: 0.3, taken: 0.15 })]
  const t = totals(lines)
  expect(Number(t.saved.toFixed(5)), 'the baseline minus the cost, per task: -0.3 and +0.2').toBe(-0.1)
  const text = report(lines)
  expect(text.split('\n')[1]).toBe('Cost ~$0.10 more than it saved in the last 30 days.')
  expect(cells(text, 'Total saved')).toEqual(['-$0.10', '-$0.10', '-$0.10'])
  expect(cells(text, 'Share of cost saved'), 'no share of a negative saving').toEqual(['–', '–', '–'])
  expect(text, 'no doubled signs or a minus before words').not.toMatch(/-~|~-|--|-under/)
  // Small: under half a cent either way reads as even, never as "-under $0.01".
  expect(cells(report([run({ change: 'lower', offered: 'lower', actual: 0.101, stay: 0.1, taken: 0.05 })]), 'Total saved')).toEqual(['even', 'even', 'even'])
  // A subscriber reads it in API-equivalent dollars.
  expect(report(lines, { subscription: true }).split('\n')[1]).toBe('Used more than it saved in the last 30 days (~$0.10 more, API-equivalent).')
  // A raise that came out cheaper than its baseline takes the extra down, and a lowering's negative saving counts against savings.
  const raised = totals([run({ change: 'raise', offered: 'raise', actual: 0.05, stay: 0.1, taken: 0.2 })])
  expect(Number(raised.extra.toFixed(5)), 'spent less than staying would have').toBe(-0.05)
  expect(report([run({ change: 'raise', offered: 'raise', actual: 0.05, stay: 0.1, taken: 0.2 })]), 'a negative extra is not shown as a row').not.toContain('Extra spent')
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
  expect(Number(t.saved.toFixed(5)), 'the baseline 0.06 minus the 0.02 it cost').toBe(0.04)
  expect(Number(t.extra.toFixed(5)), 'raising cost 0.3 against a baseline of 0.1').toBe(0.2)
  expect(Number(t.overhead.toFixed(5)), 'every rating call, the failed one too').toBe(0.005)
})

// A realistic month: 60 rated prompts over 28 days (a third lowered), a stepped-up turn, a hand-off that cost more and needed
// rework, a skipped hand-off, a stopped turn, a raise mid-turn, workflow turns, and fixed context on every run.
const fixed = { tokens: 40000, mcp: 25000, memory: 1000, agents: 2000, skills: 11000, cost: 0.03, servers: { Claude_Browser: 11000, 'claude-in-chrome': 7000, ccd_turn: 4000, vercel: 2000 } }
function month(): RunLine[] {
  const base = (i: number) => run({ at: ago(1 + (i % 28)), session: 'old', overhead: 0.001, requests: 4, durationMs: 60_000, fixed, type: 'search', tier: 'opus' })
  const lines = Array.from({ length: 60 }, (_, i) =>
    i % 3 === 0
      ? { ...base(i), change: 'lower' as const, offered: 'lower' as const, actual: 0.08, stay: 0.2, taken: 0.1, before: { five_hour: 10 + i * 0.1, seven_day: 5 }, after: { five_hour: 10.5 + i * 0.1, seven_day: 5.2 }, ...(i % 9 === 0 ? { tie: { by: 'guide', over: 'opus' } } : {}) }
      : { ...base(i), actual: 0.15, stay: 0.15, taken: 0.15 },
  )
  return [
    ...lines,
    run({ change: 'lower', steppedUp: true }),
    run({ change: 'delegate-down', route: 'delegate:haiku', actual: 0.4, stay: 0.3, agentCalls: 3, type: 'search' }),
    run({ change: 'delegate-up', route: 'main' }),
    run({ aborted: true }),
    run({ afterWorkflow: true, workflows: 2, actual: 3 }),
    run({ escalations: [{ step: 2, from: 'low', to: 'medium', why: 'the same tool call failed twice' }] }),
  ]
}

test('the report is laid out: title and headline, period table, sections in order, notes, footer', async () => {
  const text = report(month(), { subscription: true, switches: [{ at: ago(0), kept: false }, { at: ago(0), kept: true }], measureFrom: ago(18) })
  const out = text.split('\n')
  expect(out[0]).toBe('rightsize report')
  expect(out[1]).toMatch(/^Saved ~[\d.]+–[\d.]+% of your 5-hour window \(~\d+–\d+ min\) in the last 30 days\.$/)
  expect(out[2], 'the restart note is near the top').toMatch(/^Cost measurement restarted on 2026-10-0\d\.$/)
  expect(titles(text)).toEqual(['FIXED CONTEXT', 'ACCURACY', 'NOT COUNTED AS SAVINGS', 'NEXT STEPS'])
  const foot = out.indexOf('Estimated: actual cost vs staying at your own model and effort.')
  expect(foot, 'the footer follows the last section').toBeGreaterThan(out.indexOf('NEXT STEPS'))
  expect(out.slice(foot + 1, foot + 3).join(' ')).toMatch(/^Total saved is after the cost of rating prompts \(\$[\d.]+ API-equivalent in 30 days\)\./)
  expect(out.slice(-2).join(' '), 'the footer is last').toBe(SUB_FOOT)
  expect(out.filter(l => l.length > 80), 'no line past 80 characters').toEqual([])
  expect(text, 'plain text: no markdown table or emoji').not.toMatch(/\||\*\*|---|\p{Extended_Pictographic}/u)
  expect(text).not.toMatch(/Rightsize|Negative ROI|Rescue|Anomal/)
})

test('the period table lines up: right edges match and every row has a cell per period', async () => {
  const out = report(month(), { subscription: true }).split('\n')
  const header = out.findIndex(l => l.trim().startsWith('Session'))
  expect(out[header]?.split(/ +/).filter(Boolean)).toEqual(['Session', '7', 'days', '30', 'days'])
  const table = out.slice(header, out.findIndex((l, i) => i > header && l === ''))
  expect(new Set(table.map(l => l.length)).size, 'all rows end in the same column').toBe(1)
  expect(table.length).toBeGreaterThan(5)
  for (const l of table.slice(1)) expect(l.trim().split(/ {2,}/).length, l).toBe(4)
  // Counts sit right-aligned under their headings.
  const col = (l: string) => l.indexOf('30 days')
  expect(out[header]?.indexOf('30 days')).toBe(col(out[header] ?? ''))
  expect(cells(out.join('\n'), 'Prompts rated')).toEqual(['6', '24', '66'])
})

test('reports each period in columns, the window kept for a subscriber, and says when it cost more', async () => {
  const lines = [
    run({ change: 'lower', offered: 'lower', actual: 0.5, stay: 1, taken: 0.5, overhead: 0.01, durationMs: 60_000, before: { five_hour: 10 }, after: { five_hour: 11 } }),
    run({ change: 'none', actual: 0.5, durationMs: 60_000, before: { five_hour: 11 }, after: { five_hour: 12 } }),
    run({ at: ago(20), session: 'old', change: 'lower', actual: 0.1, stay: 0.1, taken: 0.1, overhead: 0.05 }),
  ]
  const sub = report(lines, { subscription: true })
  expect(cells(sub, 'Prompts rated')).toEqual(['2', '2', '3'])
  expect(cells(sub, 'Kept / lowered / raised')).toEqual(['1/1/0', '1/1/0', '1/2/0'])
  // 2% of the window for $1 over 2 runs and 2 minutes, give or take sqrt(2) points of rounding: $0.49 saved is ~0.3–1.7%; the old session's rating calls take it to $0.44 in 30 days.
  expect(cells(sub, '5-hour window saved')).toEqual(['~0.3–1.7%', '~0.3–1.7%', '~0.3–1.5%'])
  expect(cells(sub, 'Share of cost saved')).toEqual(['~33%', '~33%', '~27%'])
  expect(sub.replace(/\s+/g, ' '), 'the rating cost is in the footer').toContain('Total saved is after the cost of rating prompts ($0.06 API-equivalent in 30 days).')
  expect(cells(sub, 'Total saved (API-equivalent)'), 'dollars on a subscription are labelled').toEqual(['~$0.49', '~$0.49', '~$0.44'])
  expect(sub.split('\n')[1], 'a subscriber reads the window first, as a range').toBe('Saved ~0.3–1.5% of your 5-hour window (under 2 min) in the last 30 days.')
  expect(sub.split('\n').slice(-2).join(' ')).toBe(SUB_FOOT)
  const api = report(lines)
  expect(api.split('\n')[1], 'an API user reads dollars').toBe('Saved ~$0.44 (~27%) in the last 30 days.')
  expect(cells(api, 'Share of cost saved')).toEqual(['~33%', '~33%', '~27%'])
  expect(api, 'no window rows and no API-equivalent note on the API').not.toMatch(/5-hour|API-equivalent/)
  const worse = report([run({ change: 'none', overhead: 0.03 })])
  expect(worse.split('\n')[1]).toBe('Cost ~$0.03 more than it saved in the last 30 days.')
  expect(cells(worse, 'Total saved')).toEqual(['-$0.03', '-$0.03', '-$0.03'])
  expect(worse, 'on the API dollars are real: no label').not.toContain('API-equivalent')
  const worseSub = report([run({ change: 'none', overhead: 0.03 })], { subscription: true })
  expect(worseSub.split('\n')[1], 'no window measured yet: the share alone').toBe('Used more than it saved in the last 30 days (~$0.03 more, API-equivalent).')
  expect(cells(worseSub, 'Share of cost saved')).toEqual(['–', '–', '–'])
  expect(cells(worseSub, 'Total saved (API-equivalent)')).toEqual(['-$0.03', '-$0.03', '-$0.03'])
  expect(report([run({ change: 'none' })]).split('\n')[1]).toBe('About even in the last 30 days: savings and rating calls cancel out.')
})

test('a window used more than staying would have shows as a negative share', async () => {
  const lines = [run({ change: 'raise', actual: 0.3, stay: 0.1, taken: 0.2, overhead: 0.5, durationMs: 60_000, before: { five_hour: 10 }, after: { five_hour: 12 } })]
  const text = report(lines, { subscription: true })
  expect(text.split('\n')[1]).toBe('Used ~1.7–5.0% more of your 5-hour window than staying would have in the last 30 days.')
  expect(cells(text, '5-hour window saved')?.[0]).toBe('-1.7 to -5.0%')
})

test('nothing rated yet: says so, with no table and no empty sections', async () => {
  const text = report([])
  const out = text.split('\n')
  expect(out.slice(0, 2)).toEqual(['rightsize report', 'Nothing rated yet.'])
  expect(text).not.toContain('Session')
  expect(titles(text)).toEqual(['NOT COUNTED AS SAVINGS'])
  expect(sectionOf(text, 'NOT COUNTED AS SAVINGS')).toEqual(['Nothing yet.'])
  expect(text).not.toMatch(/FIXED CONTEXT|ACCURACY|NEXT STEPS/)
  expect(out.slice(-1)).toEqual(['Estimated: actual cost vs staying at your own model and effort.'])
  // Another session's work: this session's column is empty, dashes where there is nothing to say.
  const other = report([run({ session: 'old', change: 'lower', offered: 'lower', actual: 0.05, stay: 0.1, taken: 0.05 })])
  expect(cells(other, 'Prompts rated')).toEqual(['0', '1', '1'])
  expect(cells(other, 'Kept / lowered / raised')).toEqual(['0/0/0', '0/1/0', '0/1/0'])
  expect(cells(other, 'Total saved')?.[0]).toBe('–')
})

test('rows with nothing to say are left out of the table', async () => {
  const text = report([run({})])
  for (const label of ['Sent to cheaper', 'Suggestions declined', 'Subagents on cheaper', 'Close calls', 'Extra spent', '5-hour']) expect(text, label).not.toContain(label)
  const busy = report([run({ change: 'raise', offered: 'raise', actual: 0.3, stay: 0.1, taken: 0.2 }), run({ change: 'none', offered: 'lower' }), run({ change: 'delegate-down', route: 'delegate:haiku' })])
  expect(cells(busy, 'Sent to cheaper / stronger model')).toEqual(['1/0', '1/0', '1/0'])
  expect(cells(busy, 'Suggestions declined')).toEqual(['1', '1', '1'])
  expect(cells(busy, 'Extra spent on harder prompts')).toEqual(['$0.20', '$0.20', '$0.20'])
  expect(busy, 'the footer says what the extra is').toContain("It isn't taken off Total saved.")
  expect(text, 'no extra: no footer line for it').not.toContain('Extra spent')
})

test('savings lead the table, before what rightsize did', async () => {
  const labels = report(month(), { subscription: true }).split('\n').filter(l => /^ {2}\S/.test(l)).map(l => l.trim().split(/ {2,}/)[0])
  expect(labels[0]).toBe('Total saved (API-equivalent)')
  expect(labels.indexOf('Prompts rated')).toBeGreaterThan(labels.indexOf('Share of cost saved'))
  const windowed = [
    run({ change: 'lower', offered: 'lower', actual: 0.5, stay: 1, taken: 0.5, overhead: 0.01, durationMs: 60_000, before: { five_hour: 10 }, after: { five_hour: 11 } }),
    run({ change: 'none', actual: 0.5, durationMs: 60_000, before: { five_hour: 11 }, after: { five_hour: 12 } }),
  ]
  expect(report(windowed, { subscription: true }).split('\n').filter(l => /^ {2}\S/.test(l)).map(l => l.trim().split(/ {2,}/)[0]).slice(0, 2)).toEqual(['Total saved (API-equivalent)', '5-hour window saved'])
})

test('for the desktop app, the aligned blocks go in code fences and prose is not wrapped', async () => {
  const plain = report(month(), { subscription: true })
  const md = report(month(), { subscription: true, markdown: true })
  const fences = md.split('\n').filter(l => l === '```').length
  expect(fences % 2, 'every fence is closed').toBe(0)
  expect(fences, 'table, fixed context, accuracy and problems').toBeGreaterThanOrEqual(8)
  expect(md.split('\n').filter(l => l !== '```').join('\n').replace(/\n- .*/g, '')).toContain('  Total saved')
  expect(md.split('\n').some(l => l.startsWith('- ') && l.length > 80), 'next steps are one line each').toBe(true)
  expect(plain, 'the terminal gets no fences').not.toContain('```')
  expect(report([], { markdown: true }), 'no empty fences').not.toMatch(/```\n```/)
})

test('problems: what was not counted as saving, each with a plain reason, the biggest first', async () => {
  const lines = [
    run({ change: 'lower', steppedUp: true }),
    run({ change: 'delegate-down', route: 'delegate:haiku', actual: 0.4, stay: 0.3, agentCalls: 3 }),
    run({ change: 'delegate-up', route: 'main' }),
    run({ aborted: true }),
    run({ aborted: true }),
    ...[3, 2, 1.5, 1.1, 1, 1].map(x => run({ actual: 0.1 * x, taken: 0.1 })),
  ]
  const out = problems(lines, [{ at: ago(0), kept: false }, { at: ago(0), kept: true }])
  const find = (reason: string) => out.find(p => p.reason.startsWith(reason))
  expect(find('you stopped'), 'the biggest first').toBe(out[0])
  expect(find('you stopped')?.n).toBe(2)
  expect(find('lowered, then stepped back up')?.n).toBe(1)
  expect(find('hand-off cost more than staying')?.reason).toBe('hand-off cost more than staying ($0.40 vs ~$0.30)')
  expect(find('hand-off needed rework')?.n).toBe(1)
  expect(find('Claude skipped the hand-off you chose')?.n).toBe(1)
  expect(find('missed the cache')).toMatchObject({ n: 1, unit: ['switch', 'switches'], reason: 'missed the cache, of 2 effort switches' })
  expect(report(lines, { switches: [{ at: ago(0), kept: false }] })).toMatch(/\n {2}2 turns +you stopped \(their rating cost still counts\)\n {2}1 turn +/)
  const approved = problems([run({ change: 'delegate-down', route: 'main', approvalSteps: 2 })], [])
  expect(approved.some(p => p.reason.includes('skipped')), 'kept in the main chat for steps only you can approve: not a skip').toBe(false)
  const plain = report(lines, { measureFrom: ago(60) })
  expect(plain, 'the old jargon is gone').not.toMatch(/Negative ROI|Rescue|Anomal/)
})

test('unrated prompts are counted under Not counted as savings, with their rating cost as overhead and no saving', async () => {
  const unrated = (x: Partial<RunLine> = {}): RunLine => ({ at: ago(0), kind: 'unrated', session: 's1', reason: 'rating unreadable', overhead: 0.002, ...x })
  const t = totals([unrated(), unrated({ overhead: 0.001 }), run({ change: 'lower', offered: 'lower', actual: 0.02, stay: 0.06, taken: 0.03 })])
  expect(t.unrated).toBe(2)
  expect(t.rated, 'an unrated prompt is not a rated one').toBe(1)
  expect(Number(t.overhead.toFixed(5)), 'what the failed rating calls cost still counts').toBe(0.003)
  expect(Number(t.saved.toFixed(5))).toBe(0.04)
  const one = problems([unrated()], [])
  expect(one).toEqual([{ n: 1, unit: ['prompt', 'prompts'], reason: 'not rated (the rating failed), so nothing was changed' }])
  const text = report([unrated(), unrated({ reason: 'rating call timed out' })])
  expect(sectionOf(text, 'NOT COUNTED AS SAVINGS')[0]).toMatch(/^2 prompts +not rated \(the rating failed\), so nothing was changed$/)
  expect(text, 'a report of only unrated prompts is not "nothing rated"').not.toContain('Nothing rated')
  expect(cells(text, 'Prompts rated')).toEqual(['0', '0', '0'])
})

test('dropped and unbound prompts are not rated runs: only their rating cost counts, as overhead', async () => {
  const dropped: RunLine = { at: ago(0), kind: 'dropped', id: 'a', session: 's1', reason: 'held by a hook', overhead: 0.004 }
  const unbound: RunLine = { at: ago(0), kind: 'unbound', id: 'b', session: 's1', reason: 'delivered into the running turn', overhead: 0.003 }
  const t = totals([dropped, unbound, run({ change: 'lower', offered: 'lower', actual: 0.02, stay: 0.06, taken: 0.03 })])
  expect(t.rated, 'neither is a rated run').toBe(1)
  expect(t.unrated, 'and neither is an unrated prompt').toBe(0)
  expect(Number(t.overhead.toFixed(5)), 'their rating calls cost what they cost').toBe(0.007)
  expect(Number(t.saved.toFixed(5)), 'no saving from them').toBe(0.04)
  expect(Number(t.spent.toFixed(5)), 'no turn cost from them').toBe(0.02)
  const text = report([dropped, unbound])
  expect(cells(text, 'Prompts rated')).toEqual(['0', '0', '0'])
  expect(text, 'a report of only these is not "nothing rated"').not.toContain('Nothing rated')
  expect(problems([dropped, unbound], []), 'they are not problems of the rating').toEqual([])
})

test('problems line up: counts right-aligned, units padded, detail under the reason', async () => {
  const flow = (n: number) => Array.from({ length: n }, () => run({ afterWorkflow: true, workflows: 1, actual: 0.5 }))
  const text = report([...flow(13), ...Array.from({ length: 4 }, () => run({ aborted: true })), run({ change: 'lower', steppedUp: true })])
  const lines = text.split('\n')
  const at = lines.findIndex(l => l.includes('ran during or after a workflow'))
  expect(lines[at]).toBe('  13 turns   ran during or after a workflow ($6.50)')
  expect(lines[at + 1], 'detail lines sit under the reason').toBe('             13 workflows, from ultracode or asked for')
  expect(lines[at + 2]).toBe('             hand-offs paused in those sessions; nothing learned from them')
  expect(lines[at + 3], 'the digit lines up under the tens, the reasons in one column').toBe('   4 turns   you stopped (their rating cost still counts)')
  expect(lines[at + 4], 'a singular unit pads to the same width').toBe('   1 turn    lowered, then stepped back up: the task was harder than rated')
})

test('turns during or after a workflow claim no saving and get their own row', async () => {
  const fanned = run({ change: 'lower', actual: 2, stay: 1, taken: 0.5, workflows: 1, afterWorkflow: true })
  expect(counterfactual(fanned), 'no saving claimed').toBe(2)
  const later = run({ change: 'none', actual: 0.4, afterWorkflow: true })
  const out = problems([fanned, later, run({})], [])
  expect(out).toEqual([{ n: 2, unit: ['turn', 'turns'], reason: 'ran during or after a workflow ($2.40)', detail: ['1 workflow, from ultracode or asked for', 'hand-offs paused in those sessions; nothing learned from them'] }])
})

test('reads the log, skipping a torn first line', async () => {
  const lines = parseLines<RunLine>(`{"at":"x","actu\n${JSON.stringify(run({}))}\n\nnot json\n`)
  expect(lines.length).toBe(1)
})

test('fixed context: request-weighted, the biggest parts first, nothing when it cost nothing', async () => {
  const f = (tokens: number, requests: number, cost: number) => run({ requests, actual: 1, fixed: { tokens, mcp: tokens - 4000, memory: 4000, agents: 0, skills: 0, cost, servers: { linear: tokens - 4000 } } })
  expect(fixedBlock([f(14000, 10, 0.5), f(24000, 30, 1.5)])).toEqual({
    head: '~22K tokens sent with every request', notes: ['Fixed context adds to your cost in every session. Cutting it saves more.', 'At least ~$2.00 over 40 requests, ~100% of what those turns cost.'],
    tree: [
      ['├─ MCP tools', '18K', 'linear 20K'],
      ['└─ Memory', '4K'],
    ],
    fix: "rightsize can't trim fixed context. To cut it: disconnect MCP servers you don't use (/mcp), or trim CLAUDE.md and memory files.",
  })
  const skills = run({ requests: 5, actual: 1, fixed: { tokens: 15000, mcp: 300, memory: 1000, agents: 2500, skills: 11200, cost: 0.03 } })
  const block = fixedBlock([skills])
  expect(block?.tree.map(r => r[0]), 'largest first, the last part closes the tree').toEqual(['├─ Skills', '├─ Agents', '└─ Memory'])
  expect(block?.fix, 'the advice follows the biggest parts').toContain("To cut it: turn off plugins and skills you don't use (/plugin), or remove custom agents you don't use (/agents).")
  expect(fixedBlock([f(14000, 10, 0.001)])).toBeUndefined()
  expect(fixedBlock([run({})])).toBeUndefined()
  const many = run({ requests: 5, actual: 1, fixed: { tokens: 30000, mcp: 20000, memory: 0, agents: 0, skills: 0, cost: 0.5, servers: { a: 1000, b: 9000, c: 2000, d: 8000, e: 500 } } })
  expect(fixedBlock([many])?.tree[0]?.[2], 'short names all fit, largest first').toBe('b 9K, d 8K, c 2K, a 1K, e 500')
})

test('fixed context names servers only while the row fits in 80 columns, ending with how many are left', async () => {
  const servers = { Claude_Browser: 11000, ccd_turn: 4000, Claude_Code_iOS_Simulator: 3000, vercel_plugin_deploy: 2000, other: 1000 }
  const long = run({ requests: 5, actual: 1, fixed: { tokens: 30000, mcp: 25000, memory: 1000, agents: 0, skills: 0, cost: 0.5, servers } })
  const row = report([long]).split('\n').find(l => l.includes('├─ MCP tools')) ?? ''
  expect(row.length).toBeLessThanOrEqual(80)
  expect(row).toMatch(/^ {2}├─ MCP tools +25K +Claude_Browser 11K, ccd_turn 4K, .*\+\d+ more$/)
  expect(row).not.toContain('Claude_Code_iOS_Simulator')
  // The largest is named even when it alone runs long.
  const huge = run({ requests: 5, actual: 1, fixed: { tokens: 30000, mcp: 25000, memory: 1000, agents: 0, skills: 0, cost: 0.5, servers: { [`${'x'.repeat(70)}`]: 9000, small: 1000 } } })
  expect(fixedBlock([huge])?.tree[0]?.[2]).toBe(`${'x'.repeat(70)} 9K, +1 more`)
})

test('the fixed context tree and its tip in the report', async () => {
  const text = report(month())
  const [, , head, ...tree] = sectionOf(text, 'FIXED CONTEXT')
  expect(text).toMatch(/^FIXED CONTEXT {2}~40K tokens sent with every request\n {2}Fixed context adds to your cost in every session\. Cutting it saves more\.\n {2}At least ~\$[\d.]+ over \d+ requests, ~\d+% of what those turns cost\.\n {2}├─ MCP tools/m)
  expect(text.split('\n').filter(l => l.length > 80)).toEqual([])
  const md = report(month(), { markdown: true })
  expect(md).toMatch(/\nFIXED CONTEXT {2}~40K tokens sent with every request\nFixed context adds to your cost in every session\. Cutting it saves more\.\nAt least ~\$[\d.]+ over \d+ requests, ~\d+% of what those turns cost\.\n```\n {2}├─ MCP tools[^`]*└─ Memory +1K\n```\n/)
  expect(md, 'no empty fence').not.toMatch(/```\n```/)
  expect(head).toMatch(/^├─ MCP tools +25K +Claude_Browser 11K, claude-in-chrome 7K, \+2 more$/)
  expect(tree).toEqual([expect.stringMatching(/^├─ Skills +11K$/), expect.stringMatching(/^├─ Agents +2K$/), expect.stringMatching(/^└─ Memory +1K$/)])
  expect(sectionOf(text, 'NEXT STEPS').join(' ')).toContain("rightsize can't trim fixed context. To cut it: disconnect MCP servers you don't use (/mcp), or turn off plugins and skills you don't use (/plugin).")
})

test("Claude's subagents moved to a cheaper model: counted, and their saving added", async () => {
  const sub = (x: Partial<RunLine>): RunLine => ({ at: ago(0), kind: 'subagent', session: 's1', type: 'search', from: 'opus', tier: 'haiku', level: 'low', estimate: 0.01, parentEstimate: 0.2, actual: 0.02, ...x })
  const t = totals([run({ actual: 0.5 }), sub({}), sub({ aborted: true })])
  expect([t.rated, t.subagents]).toEqual([1, 2])
  // 0.02 on Haiku against an estimate 20x higher on Opus: 0.40 that way, 0.38 saved. The stopped one claims nothing.
  expect(Math.abs(t.saved - 0.38) < 1e-9).toBe(true)
  expect(t.spent, 'its cost is already in its turn').toBe(0.5)
  const text = report([run({ actual: 0.5 }), sub({})])
  expect(cells(text, 'Subagents on cheaper model')).toEqual(['1', '1', '1'])
  expect(cells(text, 'Prompts rated')).toEqual(['1', '1', '1'])
  expect(text).toContain('Saved ~$0.38')
  expect(cells(report([sub({})]), 'Subagents on cheaper model'), 'a session with only a subagent line').toEqual(['1', '1', '1'])
  expect(cells(report([sub({})]), 'Prompts rated')).toEqual(['0', '0', '0'])
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
  // Guide / explored: the session is not counted (a dash); 7 days three and one; 30 days adds the older one.
  expect(cells(report(lines), 'Close calls: guide / explored')).toEqual(['–', '3/1', '4/1'])
  expect(report([run({}), run({ resized: [{}] })]), 'nothing to say without ties').not.toContain('Close calls')
  expect(tieCounts([{ at: ago(0), kind: 'overhead', overhead: 0.1 }])).toEqual({ guided: 0, explored: 0 })
  expect(cells(report([run({ tie: { by: 'explore', over: 'opus' } })]), 'Close calls: guide / explored')).toEqual(['–', '0/1', '0/1'])
})

test("check and feedback lines are not rated runs, but a check's cost counts as overhead", async () => {
  const lines: RunLine[] = [
    run({ change: 'none', overhead: 0.002 }),
    { at: ago(0), kind: 'check', session: 's1', type: 'debug', fit: { sonnet: 'low' }, check: { by: 'sonnet', fit: { sonnet: null } }, overhead: 0.004 },
    { at: ago(0), kind: 'feedback', ref: 'a', value: 'down' },
  ]
  const t = totals(lines)
  expect(t.rated).toBe(1)
  expect(Number(t.overhead.toFixed(5))).toBe(0.006)
  expect(cells(report(lines), 'Prompts rated')).toEqual(['1', '1', '1'])
  expect(report(lines), 'the check is counted with the rating calls').toContain('($0.01 in 30 days)')
})

const handDown = (rework: boolean, days = 0) => run({ at: ago(days), type: 'search', route: 'delegate:haiku', change: 'delegate-down', agentCalls: rework ? 2 : 1 })

test("says how often Haiku's judgement was wrong, how the Sonnet checks went, and which hand-downs are paused", async () => {
  expect(accuracyRows([run({}), run({ change: 'lower', steppedUp: false })]).rows, 'no misses: nothing to say').toEqual([])
  const lines = [handDown(true), handDown(true), handDown(false), handDown(false), handDown(false), run({ type: 'lookup', change: 'lower', tier: 'opus', steppedUp: true })]
  const out = accuracyRows(lines)
  expect(out.rows[0]).toEqual(["Haiku's judgement", 'wrong on 3 of 6 checked prompts (50%)'])
  expect(out.rows[1], 'Haiku was wrong on 2 of 5 search hand-downs: 40%, over the 30% line').toEqual(['Hand-downs paused', 'search work to Haiku, wrong on 40% of 5'])
  expect(out.paused, 'the action goes to NEXT STEPS').toBe('Hand-downs of search work to Haiku, and lowering effort on it, resume when its miss rate falls under the Pause after misses line (/config).')
  const calm = accuracyRows([...lines.slice(2, 5), run({ type: 'lookup', change: 'lower', tier: 'opus', steppedUp: true })])
  expect(calm.rows.length, 'under 5 outcomes on any one key: nothing paused').toBe(1)
  expect(calm.paused).toBeUndefined()
  const text = report(lines)
  expect(sectionOf(text, 'ACCURACY').join('\n')).toMatch(/Haiku's judgement +wrong on 3 of 6 checked prompts \(50%\)\nHand-downs paused +search work to Haiku, wrong on 40% of 5/)
  expect(sectionOf(text, 'NEXT STEPS').join(' ')).toContain('Hand-downs of search work to Haiku, and lowering effort on it, resume when')
  const check = (agree: boolean): RunLine => ({ at: ago(0), kind: 'check', type: 'debug', fit: { sonnet: 'low' }, check: { by: 'sonnet', fit: { sonnet: agree ? 'low' : null } } })
  expect(accuracyRows([...lines, check(true), check(true), check(false)]).rows[1], 'the checks, worded as agreement').toEqual(['Haiku vs Sonnet checks', 'agreed on 2 of 3'])
  expect(accuracyRows([...lines, check(true)]).rows.map(r => r[0])).toEqual(["Haiku's judgement", 'Haiku vs Sonnet checks', 'Hand-downs paused', 'Estimates'])
})

test('estimate error: early against late, and nothing until there are enough measured runs', async () => {
  const lines = [3, 2, 1.5, 1.1, 1, 1].map(x => run({ actual: 0.1 * x, taken: 0.1 }))
  // The first 3 runs are 2.2x off on average, the last 3 about 1.0x.
  expect(accuracyRows(lines).rows).toEqual([['Estimates', '1.0x off, down from 2.2x in the first 3 runs']])
  expect(accuracyRows(lines.slice(0, 5)).rows, 'under 6 measured runs').toEqual([])
  expect(accuracyRows([...[1, 1, 1].map(x => run({ actual: 0.1 * x, taken: 0.1 })), ...[1.5, 2, 3].map(x => run({ actual: 0.1 * x, taken: 0.1 }))]).rows[0]?.[1]).toBe('2.2x off, up from 1.0x in the first 3 runs')
  expect(accuracyRows(Array.from({ length: 6 }, () => run({}))).rows[0]?.[1]).toBe('1.0x off, same as 1.0x in the first 3 runs')
})

test('the report names a pause only at the line Pause after misses sets, and not at all when it is off', async () => {
  // Wrong on 2 of 5 search hand-downs to Haiku: 40%.
  const lines = [handDown(true), handDown(true), handDown(false), handDown(false), handDown(false)]
  const paused = (pause?: number | null) => accuracyRows(lines, pause).paused !== undefined
  expect(paused(), 'the default line, 30%').toBe(true)
  expect(paused(0.4), 'at the line').toBe(true)
  expect(paused(0.5), 'under a looser line').toBe(false)
  expect(paused(0.2)).toBe(true)
  expect(paused(null), 'off: nothing is paused').toBe(false)
  expect(accuracyRows(lines, null).rows[0]?.[1], 'the miss rate is still said').toContain('wrong on 2 of 5')
  const text = (pause?: number | null) => report(lines, pause === undefined ? {} : { pause })
  expect(text()).toContain('Hand-downs paused')
  expect(text(null)).not.toContain('Hand-downs paused')
  expect(text(0.5)).not.toContain('Hand-downs paused')
  expect(text(null), 'no pause: no next step for it').not.toContain('NEXT STEPS')
})

test("a workflow's moved agents are counted but save nothing", async () => {
  const sub = (x: Partial<RunLine>): RunLine => ({ at: ago(0), kind: 'subagent', type: 'search', from: 'opus', tier: 'haiku', level: 'low', estimate: 0.01, parentEstimate: 0.1, actual: 0.01, aborted: false, ...x })
  const own = totals([sub({})])
  expect([own.subagents, Number(own.saved.toFixed(5))], "Claude's own subagent: the same work on the parent's model, less what it cost").toEqual([1, 0.09])
  const inWorkflow = totals([sub({ afterWorkflow: true })])
  expect([inWorkflow.subagents, inWorkflow.saved], 'a workflow agent: counted, no saving').toEqual([1, 0])
})

test('the report says when cost measurement restarted, and counts a pause only from then on', async () => {
  // Wrong on 3 of 6 hand-downs, all before the restart (a day ago).
  const lines = [handDown(true, 3), handDown(true, 3), handDown(true, 3), handDown(false, 3), handDown(false, 3), handDown(false, 3)]
  const from = NOW - 24 * 60 * 60 * 1000
  expect(accuracyRows(lines).rows[0]?.[1], 'the history counts all of it').toContain('wrong on 3 of 6')
  expect(accuracyRows(lines).paused, 'nothing was restarted: paused').toBeDefined()
  expect(accuracyRows(lines, 0.3, from).rows[0]?.[1], 'still counted').toContain('wrong on 3 of 6')
  expect(accuracyRows(lines, 0.3, from).paused, 'but rightsize ignores it now: nothing paused').toBeUndefined()
  const text = report(lines, { measureFrom: new Date(from).toISOString() })
  expect(text.split('\n')[2]).toBe('Cost measurement restarted on 2026-10-22.')
  expect(text).not.toContain('Hand-downs paused')
  expect(cells(text, 'Prompts rated'), 'periods still read every line').toEqual(['6', '6', '6'])
  expect(report(lines)).not.toContain('Cost measurement restarted')
})

test('next steps collect the actions, and the block is left out when there are none', async () => {
  const start: StartBlock = {
    head: 'Opus at medium, 60 rated prompts in 30 days',
    rows: [['Opus at medium (yours)', '~$12.00 per 100 prompts'], ['Sonnet at medium', '~$8.00 per 100 prompts, 4% to a stronger model']],
    note: 'Estimated from your log. A different start is suggested under NEXT STEPS.',
    tip: 'Starting on Sonnet at medium would have cost ~33% less than Opus at medium on your last 60 rated prompts. Switch with /model.',
  }
  const lines = [...month(), handDown(true), handDown(true), handDown(false), handDown(false), handDown(false)]
  const text = report(lines, { start })
  expect(titles(text)).toEqual(['STARTING POINT', 'FIXED CONTEXT', 'ACCURACY', 'NOT COUNTED AS SAVINGS', 'NEXT STEPS'])
  expect(sectionOf(text, 'STARTING POINT')[0]).toMatch(/^Opus at medium \(yours\) +~\$12.00 per 100 prompts$/)
  const steps = sectionOf(text, 'NEXT STEPS')
  // Fixed context, then the start, then the pause; long steps wrap under their dash.
  expect(steps.filter(l => l.startsWith('- ')).map(l => l.slice(2, 22))).toEqual(["rightsize can't trim", 'Starting on Sonnet a', 'Hand-downs of search'])
  expect(text.split('\n').filter(l => l.length > 80)).toEqual([])
  const none = report([run({})], { start: { head: 'Needs 50 rated prompts to compare (has 1).', rows: [] } })
  expect(none).toContain('STARTING POINT  Needs 50 rated prompts to compare (has 1).')
  expect(none, 'no action: no block').not.toContain('NEXT STEPS')
  const fits = report([run({})], { start: { head: 'Opus at medium, 60 rated prompts in 30 days', rows: [], note: 'Estimated from your log. Your start fits: no other start is clearly cheaper without sending more work to a stronger model.' } })
  expect(fits).not.toContain('NEXT STEPS')
  expect(fits.split('\n').filter(l => l.length > 80), 'a long note wraps').toEqual([])
})

// ---- Time ----

const mins = (m: number) => new Date(NOW - m * 60_000).toISOString()
// Task a stays (two prompts), task b hands off to Haiku (one), task c stays and has no submit time (a log without it). One line is from before 0.8.
const timed = (): RunLine[] => [
  run({ id: 'a1', task: 'a', submittedAt: mins(40), at: mins(38), ratingMs: 2000, durationMs: 100_000 }),
  run({ id: 'a2', task: 'a', submittedAt: mins(30), at: mins(28), ratingMs: 1000, durationMs: 59_000 }),
  run({ id: 'b1', task: 'b', submittedAt: mins(20), at: mins(15), ratingMs: 4000, durationMs: 296_000, route: 'delegate:haiku', change: 'delegate-down', offered: 'delegate-down' }),
  run({ id: 'c1', ratingMs: 500, durationMs: 61_500 }),
  run({ id: 'old1', durationMs: 999_000 }),
  { at: mins(10), kind: 'unrated', session: 's1', task: 'a', reason: 'rating budget used up', rater: 'sonnet', overhead: 0, ratingMs: 12_000 },
  { at: mins(9), kind: 'unrated', session: 's1', reason: 'rating call timed out', rater: 'haiku', overhead: 0, ratingMs: 3000 },
]

test('durations read as seconds, minutes and seconds, or hours and minutes', async () => {
  expect([0, 400, 1800, 9949, 12_000, 59_600, 60_000, 162_000, 3_599_000, 3_900_000].map(span)).toEqual(['0.0 s', '0.4 s', '1.8 s', '9.9 s', '12 s', '1 min 00 s', '1 min 00 s', '2 min 42 s', '59 min 59 s', '1 h 05 min'])
})

test('the Time section: Claude\'s time per task, time to done, the rating delay, budget hits, and cheaper routes against staying', async () => {
  const text = report(timed())
  const rows = sectionOf(text, 'TIME')
  const cell = (label: string) => rows.find(l => l.startsWith(label))?.slice(label.length).trim()
  expect(cell('Tasks finished'), 'tasks a, b and c; the pre-0.8 line is left out').toBe('3')
  // a: 3 s + 159 s = 2 min 42 s; b: 300 s; c: 62 s. The 90th percentile of three is the largest.
  expect(cell("Claude's time per task")).toBe('median 2 min 42 s, 90th percentile 5 min 00 s')
  // a: 12 min from its first submit to its last turn's end; b: 5 min; c has no submit time, so it is left out.
  expect(cell('Time to done, with your time')).toBe('median 8 min 30 s over 2 tasks')
  // Six prompts: four rated and two unrated, 0.5 s to 12 s.
  expect(cell('Rating delay per prompt')).toBe('median 2.5 s, 90th percentile 12 s')
  expect(cell('Rating budget used up'), 'only the unrated prompt with the budget reason').toBe('1 of 6 prompts')
  expect(cell("Claude's time, cheaper route")).toBe('median 5 min 00 s over 1 task')
  expect(cell("Claude's time, stayed")).toBe('median 1 min 52 s over 2 tasks')
})

test('the Time section sits after the cost sections and before the notes, within 80 columns, and is fenced for the desktop app', async () => {
  // Without the unrated lines: their existing Not counted row is wider than 80 columns, which is not this test's business.
  const lines = [...month(), ...timed().filter(l => l.kind !== 'unrated')]
  const text = report(lines, { start: { head: 'Opus at medium, 60 rated prompts in 30 days', rows: [], tip: 'Switch with /model.' } })
  const order = titles(text)
  expect(order.indexOf('TIME')).toBe(order.indexOf('NOT COUNTED AS SAVINGS') + 1)
  expect(order.indexOf('NEXT STEPS')).toBe(order.indexOf('TIME') + 1)
  expect(text.split('\n').filter(l => l.length > 80)).toEqual([])
  const md = report(lines, { markdown: true })
  const out = md.split('\n')
  const at = out.indexOf('TIME')
  expect(out[at + 1], 'the block opens a code fence').toBe('```')
  expect(out.slice(at + 1, at + 12).filter(l => l === '```').length).toBe(2)
})

test('the Time section leaves out a group with no tasks, and takes tasks without a task id by their own id', async () => {
  const text = report([run({ id: 'x', ratingMs: 1000, durationMs: 9000, submittedAt: mins(5), at: mins(4) }), run({ id: 'y', ratingMs: 3000, durationMs: 7000 })])
  const rows = sectionOf(text, 'TIME')
  expect(rows.find(l => l.startsWith('Tasks finished'))).toMatch(/2$/)
  expect(rows.find(l => l.startsWith("Claude's time, cheaper route"))).toMatch(/none yet$/)
  expect(rows.find(l => l.startsWith('Rating budget used up'))).toMatch(/0 of 2 prompts$/)
})

test('no line carries the new time fields: one line says so', async () => {
  for (const lines of [[], month(), [run({ durationMs: 5000 })]]) {
    const text = report(lines)
    expect(text.split('\n')).toContain('Time: not measured yet (needs prompts from rightsize 0.8).')
    expect(titles(text)).not.toContain('TIME')
  }
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

test('sessionTotal puts the session net in plain words, from the same figure as the report', async () => {
  const win = { before: { five_hour: 10 }, after: { five_hour: 11 } }
  const saved = run({ change: 'lower', offered: 'lower', actual: 0.5, stay: 1, taken: 0.5, overhead: 0.01 })
  const cost = run({ change: 'raise', offered: 'raise', actual: 0.3, stay: 0.1, taken: 0.2, overhead: 0.5 })
  expect(sessionTotal([], 's1', false), 'no lines').toBeUndefined()
  expect(sessionTotal([saved], '', false), 'no session id').toBeUndefined()
  expect(sessionTotal([run({ session: 's2' })], 's1', false), 'only other sessions have lines').toBeUndefined()
  expect(sessionTotal([run({ change: 'lower', offered: 'lower', actual: 0.101, stay: 0.1, taken: 0.05 })], 's1', false)).toBe('Session: about even')
  expect(sessionTotal([saved], 's1', false)).toBe('Session: ~$0.49 saved')
  expect(sessionTotal([cost], 's1', false)).toBe('Session: ~$0.50 more')
  expect(sessionTotal([saved, run({ session: 's2', change: 'lower', offered: 'lower', actual: 0.1, stay: 5, taken: 0.1 })], 's1', false), 'another session adds nothing').toBe('Session: ~$0.49 saved')
  expect(sessionTotal([{ ...saved, ...win }], 's1', true), 'subscription with a window').toBe('Session: under 2% saved')
  expect(sessionTotal([{ ...cost, before: { five_hour: 10 }, after: { five_hour: 12 } }], 's1', true)).toBe('Session: ~2–5% more')
  expect(sessionTotal([saved], 's1', true), 'subscription without window data').toBe('Session: ~$0.49 saved')
  expect(sessionTotal([cost], 's1', true)).toBe('Session: ~$0.50 more')
  // The band's figure is the report's Session "Total saved".
  const lines = [saved, run({ change: 'lower', offered: 'lower', actual: 0.1, stay: 0.3, taken: 0.15, overhead: 0.02 })]
  const shown = cells(report(lines), 'Total saved')?.[0]
  expect(sessionTotal(lines, 's1', false)).toBe(`Session: ${shown} saved`)
})

// ---- Window shares as ranges ------------------------------------------------

/** `n` runs that each cost `each` dollars and moved the 5-hour window by the given points. */
const near = (a: number | undefined, b: number) => a !== undefined && Math.abs(a - b) < 1e-9
const windowRuns = (points: readonly number[], each = 0.5) => points.map((p, i) => run({ at: ago(0), actual: each, id: `w${i}`, before: { five_hour: 10 }, after: { five_hour: 10 + p } }))

test('windowRates: the share per dollar as a range from the rounding error, sqrt(n) points either way', async () => {
  // One run: 5 points for $1. Each endpoint is a whole percent, so the total is 5 give or take 1.
  const one = windowRates(windowRuns([5], 1), 'five_hour')
  expect([one?.low, one?.perDollar, one?.high]).toEqual([4, 5, 6])
  // Nine runs: 9 points for $4.50 over 9 runs, give or take sqrt(9) = 3 points.
  const nine = windowRates(windowRuns([1, 1, 1, 1, 1, 1, 1, 1, 1]), 'five_hour')
  expect(near(nine?.perDollar, 2)).toBe(true)
  expect(near(nine?.low, 6 / 4.5)).toBe(true)
  expect(near(nine?.high, 12 / 4.5)).toBe(true)
  // A total smaller than the rounding error: the low end stops at 0, it does not go negative.
  const clamped = windowRates(windowRuns([1, 1, 0, 0, 0, 0, 0, 0, 0]), 'five_hour')
  expect(clamped?.low).toBe(0)
  expect(near(clamped?.perDollar, 2 / 4.5)).toBe(true)
  expect(near(clamped?.high, 5 / 4.5)).toBe(true)
  // Runs that count are the runs that measured: a window that reset, an aborted turn, a line with no window and a stopped turn add nothing.
  const mixed = windowRates([...windowRuns([5], 1), run({ actual: 1, before: { five_hour: 50 }, after: { five_hour: 3 } }), run({ actual: 1, aborted: true, before: { five_hour: 1 }, after: { five_hour: 9 } }), run({ actual: 1 })], 'five_hour')
  expect([mixed?.low, mixed?.high], 'n is 1').toEqual([4, 6])
  expect(windowRates([], 'five_hour')).toBeUndefined()
  expect(windowRates(windowRuns([0]), 'five_hour'), 'no movement: no rate').toBeUndefined()
})

test('a window share is written as a range: one decimal, an en dash, a single value when both ends agree, "under" when the low end is 0.0', async () => {
  expect(shareText({ lo: 0.8, hi: 1.6 })).toBe('~0.8–1.6%')
  expect(shareText({ lo: 0.84, hi: 1.55 })).toBe('~0.8–1.6%')
  expect(shareText({ lo: 0.96, hi: 1.04 }), 'both ends read 1.0').toBe('~1.0%')
  expect(shareText({ lo: 0, hi: 1.6 })).toBe('under 1.6%')
  expect(shareText({ lo: 0.04, hi: 1.6 }), 'a low end that reads 0.0').toBe('under 1.6%')
  expect(shareText({ lo: 0.01, hi: 0.04 }), 'both ends read 0.0').toBe('under 0.1%')
  expect(shareText({ lo: -1.6, hi: -0.8 }), 'a loss is written as its size').toBe('~0.8–1.6%')
  expect(shareText({ lo: -1.6, hi: -0 }), 'a loss with a low end of 0').toBe('under 1.6%')
  expect(windowCostText(0.16, { low: 4, high: 6 })).toBe('~0.6–1.0% of your 5-hour window ($0.16 API-equivalent)')
  expect(windowCostText(0.16, { low: 0, high: 6 })).toBe('under 1.0% of your 5-hour window ($0.16 API-equivalent)')
  expect(windowCostText(0.16, undefined), 'no rate yet: dollars alone, labelled').toBe('about $0.16 API-equivalent')
})

test('the band writes a window share short: whole percent, one decimal only under 1%, one number when both ends agree', async () => {
  expect(bandShareText({ lo: 9.9, hi: 17.4 })).toBe('~10–17%')
  expect(bandShareText({ lo: 1.9, hi: 2.2 }), 'both ends round to 2').toBe('~2%')
  expect(bandShareText({ lo: 0.3, hi: 0.8 }), 'under 1%: one decimal').toBe('~0.3–0.8%')
  expect(bandShareText({ lo: 0.3, hi: 17.4 }), 'only the value under 1% gets a decimal').toBe('~0.3–17%')
  expect(bandShareText({ lo: 0.97, hi: 1.2 }), 'a value that would read 1.0 reads 1').toBe('~1%')
  expect(bandShareText({ lo: 0, hi: 17.4 })).toBe('under 17%')
  expect(bandShareText({ lo: 0.01, hi: 0.04 })).toBe('under 0.1%')
  expect(bandShareText({ lo: -17.4, hi: -9.9 }), 'a loss is written as its size').toBe('~10–17%')
  // The /rightsize report keeps its one decimal.
  expect(shareText({ lo: 9.9, hi: 17.4 })).toBe('~9.9–17.4%')
})

test('the session total on the band: a share, or dollars with no API-equivalent label; SESSION_TOTAL strips every form it writes', async () => {
  // 400 runs of 10 points for $0.10 each, and 3 that saved $0.28 each: about $0.84 saved.
  const base = Array.from({ length: 400 }, (_, i) => run({ id: `m${i}`, actual: 0.1, before: { five_hour: 0 }, after: { five_hour: 10 } }))
  const saves = [1, 2, 3].map(i => run({ id: `s${i}`, change: 'lower', offered: 'lower', actual: 0.1, stay: 0.38, taken: 0.1 }))
  const share = sessionTotal([...base, ...saves], 's1', true)
  expect(share, 'ends rounded to whole percent').toMatch(/^Session: ~\d+(–\d+)?% saved$/)
  const dollars = sessionTotal(saves, 's1', true)
  expect(dollars, 'dollars on a subscription: no label').toBe('Session: ~$0.84 saved')
  const forms = [
    'Session: ~10–17% saved',
    'Session: ~2% saved',
    'Session: ~0.3–0.8% more',
    'Session: under 17% saved',
    'Session: ~$0.84 saved',
    'Session: ~$0.84 more',
    'Session: about even',
    ...(share ? [share] : []),
    // The older wording, in a band saved by an earlier version.
    'Session: ~1.7–5.0% more of the 5-hour window',
    'Session: ~$0.49 saved (API-equivalent)',
  ]
  for (const f of forms) {
    expect(`Sent to Sonnet. ~28% of Opus usage ($0.45 vs $1.61). ${f}`.replace(SESSION_TOTAL, ''), f).toBe('Sent to Sonnet. ~28% of Opus usage ($0.45 vs $1.61).')
    expect(`Cache goes cold in ~55 min. ${f} Ran 2 subagents.`.replace(SESSION_TOTAL, ''), f).toBe('Cache goes cold in ~55 min. Ran 2 subagents.')
  }
})

test('the headline, the table and the band show the window share as a range, the minutes too, and a single value once the data is enough', async () => {
  const lines = [
    run({ change: 'lower', offered: 'lower', actual: 0.5, stay: 1, taken: 0.5, durationMs: 60_000, before: { five_hour: 10 }, after: { five_hour: 14 } }),
    run({ change: 'none', actual: 0.5, durationMs: 60_000, before: { five_hour: 14 }, after: { five_hour: 18 } }),
  ]
  // 8 points for $1 over 2 runs and 2 minutes, give or take sqrt(2) points; $0.50 saved is 3.3–4.7 points of the window, about 1 minute.
  const text = report(lines, { subscription: true })
  expect(text.split('\n')[1]).toBe('Saved ~3.3–4.7% of your 5-hour window (~1 min) in the last 30 days.')
  expect(cells(text, '5-hour window saved')).toEqual(['~3.3–4.7%', '~3.3–4.7%', '~3.3–4.7%'])
  expect(sessionTotal(lines, 's1', true)).toBe('Session: ~3–5% saved')
  // The 7-day window gets its own range.
  const week = lines.map(l => ({ ...l, before: { ...l.before, seven_day: 20 }, after: { ...l.after, seven_day: 21 } }))
  expect(cells(report(week, { subscription: true }), '7-day window saved')?.[0]).toBe('~0.3–1.7%')
  // The minutes are a range too: 4 points for $0.50 over 10 minutes, one run.
  const slow = (points: number) => [run({ change: 'lower', offered: 'lower', actual: 0.5, stay: 1, taken: 0.5, durationMs: 600_000, before: { five_hour: 10 }, after: { five_hour: 10 + points } })]
  expect(report(slow(4), { subscription: true }).split('\n')[1]).toBe('Saved ~3.0–5.0% of your 5-hour window (~8–13 min) in the last 30 days.')
  expect(report(slow(1), { subscription: true }).split('\n')[1]).toBe('Saved under 2.0% of your 5-hour window (under 20 min) in the last 30 days.')
  // 400 runs of 10 points for $0.10 each, and one that saved $0.02: 2.0 points give or take 0.01.
  const big = [
    ...Array.from({ length: 399 }, (_, i) => run({ id: `m${i}`, actual: 0.1, before: { five_hour: 0 }, after: { five_hour: 10 } })),
    run({ change: 'lower', offered: 'lower', actual: 0.1, stay: 0.12, taken: 0.1, before: { five_hour: 0 }, after: { five_hour: 10 } }),
  ]
  expect(report(big, { subscription: true }).split('\n')[1]).toBe('Saved ~2.0% of your 5-hour window in the last 30 days.')
  expect(sessionTotal(big, 's1', true)).toBe('Session: ~2% saved')
  // One turn: the rounding error is as big as the reading, so the low end is 0.
  const one = [run({ change: 'lower', offered: 'lower', actual: 0.5, stay: 1, taken: 0.5, before: { five_hour: 10 }, after: { five_hour: 11 } })]
  expect(report(one, { subscription: true }).split('\n')[1]).toBe('Saved under 2.0% of your 5-hour window in the last 30 days.')
})

// ---- Capacity, API-equivalent cost and real spending stay apart ----------------

test('on a subscription, every dollar figure in the report is labelled API-equivalent', async () => {
  const text = report(month(), { subscription: true, markdown: true, switches: [{ at: ago(0), kept: false }, { at: ago(0), kept: true }] })
  const dollars = text.split('\n').filter(l => l.includes('$'))
  // The table's two dollar rows, the hand-off and workflow problems, the fixed context and the footer.
  expect(dollars.length).toBeGreaterThanOrEqual(5)
  for (const l of dollars) expect(l, 'a dollar line without the label').toContain('API-equivalent')
  expect(text).not.toMatch(/Extra spent|\bsaved \$|spent/)
  const raised = [run({ change: 'raise', offered: 'raise', actual: 0.3, stay: 0.1, taken: 0.2 })]
  const extra = report(raised, { subscription: true })
  expect(cells(extra, 'Extra on harder prompts (API-equivalent)'), 'the row says what the dollars are').toEqual(['$0.20', '$0.20', '$0.20'])
  expect(extra.replace(/\s+/g, ' ')).toContain('Extra on harder prompts: what raising effort or using a stronger model would cost on the API, for better answers.')
  expect(extra).not.toMatch(/Extra spent|spent/)
})

test('on a subscription, the problems and the fixed context label their dollars; on the API they stay plain', async () => {
  const lines = month()
  const switches = [{ at: ago(0), kept: false }]
  const sub = problems(lines, switches, true).map(p => p.reason).filter(r => r.includes('$'))
  expect(sub.length).toBeGreaterThanOrEqual(2)
  for (const r of sub) expect(r).toContain('API-equivalent')
  expect(problems(lines, switches).map(p => p.reason).join(' ')).not.toContain('API-equivalent')
  expect(fixedBlock(lines, true)?.notes.join(' ')).toMatch(/^Fixed context adds to your usage in every session\. Cutting it saves more\. At least ~\$[\d.]+ API-equivalent over \d+ requests/)
  expect(fixedBlock(lines)?.notes.join(' ')).toMatch(/^Fixed context adds to your cost in every session\. Cutting it saves more\. At least ~\$[\d.]+ over \d+ requests/)
})

test('on the API, dollars are real spending: no label, no window share', async () => {
  const win = { before: { five_hour: 10 }, after: { five_hour: 12 }, durationMs: 60_000 }
  const lines = [run({ change: 'lower', offered: 'lower', actual: 0.5, stay: 1, taken: 0.5, ...win }), run({ change: 'raise', offered: 'raise', actual: 0.3, stay: 0.1, taken: 0.2, ...win })]
  const text = report(lines, { markdown: true })
  expect(text).not.toMatch(/API-equivalent|window|usage/)
  expect(cells(report(lines), 'Extra spent on harder prompts')).toBeDefined()
  expect(sessionTotal(lines, 's1', false)).toMatch(/^Session: ~\$[\d.]+ saved$/)
  expect(shareMessage(many(20), { now: NOW, subscription: false })).not.toMatch(/API-equivalent|usage|window/)
})

test('share: on a subscription the number is said to be a share of API-equivalent cost, not money', async () => {
  const text = shareMessage(many(20), { now: NOW, subscription: true })
  expect(text).toContain('as a share of API-equivalent cost, not money')
  expect(text).not.toMatch(/\$/)
  expect(shareMessage(many(20), { now: NOW, subscription: false })).not.toContain('API-equivalent')
})

test('a keep-warm ping is rightsize\'s own cost: its overhead lowers Total saved, and the footer says so', async () => {
  const saving = run({ change: 'lower', offered: 'lower', actual: 0.1, stay: 0.4, taken: 0.1 })
  const warm = (cost: number): RunLine => ({ at: ago(0), kind: 'warm', session: 's1', tier: 'opus', context: 80_000, overhead: cost })
  const lines = [saving, warm(0.04), warm(0.06)]
  const t = totals(lines)
  expect(Number(t.overhead.toFixed(5)), 'the pings are overhead').toBe(0.1)
  expect(Number(t.saved.toFixed(5)), 'and no saving of their own').toBe(0.3)
  expect(t.rated, 'a ping is no rated prompt').toBe(1)
  expect(cells(report([saving]), 'Total saved')).toEqual(['~$0.30', '~$0.30', '~$0.30'])
  const text = report(lines)
  expect(cells(text, 'Total saved'), 'the same saving, less the pings').toEqual(['~$0.20', '~$0.20', '~$0.20'])
  expect(text.replace(/\s+/g, ' ')).toContain('Total saved is after the cost of rating prompts and of keeping the cache warm ($0.10 in 30 days).')
  expect(report([saving]).replace(/\s+/g, ' '), 'no pings, no mention').toContain('Total saved is after the cost of rating prompts (under $0.01 in 30 days).')
  // The band's running total counts them too.
  expect(sessionTotal(lines, 's1', false)).toBe('Session: ~$0.20 saved')
  // Pings alone are a cost with nothing saved.
  expect(report([warm(0.04), warm(0.06)]).split('\n')[1]).toBe('Cost ~$0.10 more than it saved in the last 30 days.')
  expect(sessionTotal([warm(0.04)], 's1', false)).toBe('Session: ~$0.04 more')
})

test('a cost on a button, in one unit: dollars on the API; on a subscription the window share, or ~dollars before the rate is known', async () => {
  expect(costTag(0.1288, false, undefined)).toBe('$0.13')
  expect(costTag(0.1288, true, undefined), 'before runs show the rate').toBe('~$0.13')
  expect(costTag(1, true, { low: 0.8, high: 1.6 }), 'no dollars next to the share').toBe('~0.8–2% usage')
  expect(costTag(0.06, true, { low: 1.5, high: 2 })).toBe('~0.1% usage')
  expect(costTag(0.001, false, undefined)).toBe('under $0.01')
  expect(costTag(0.001, true, undefined)).toBe('under $0.01')
})

test('what a keep-warm run has used, in the same unit', async () => {
  expect(usedTag(0.04, false, undefined)).toBe('$0.04')
  expect(usedTag(0.04, true, undefined)).toBe('~$0.04')
  expect(usedTag(0.06, true, { low: 1.5, high: 2 })).toBe('~0.1% used')
})

test('a cold line (how an offer was answered) is no run: it is parsed, and changes no total, report or session figure', async () => {
  const lines = [run({ change: 'lower', offered: 'lower', actual: 0.1, stay: 0.4, taken: 0.1 })]
  const cold: RunLine[] = [
    { at: ago(0), kind: 'cold', session: 's1', choice: '2h' },
    { at: ago(0), kind: 'cold', session: 's1', choice: 'ignored' },
  ]
  const text = `${JSON.stringify(cold[0])}\n{"torn\n${JSON.stringify(cold[1])}\n`
  expect(parseLines<RunLine>(text), 'read back whole').toEqual(cold)
  expect(totals([...lines, ...cold])).toEqual(totals(lines))
  for (const subscription of [false, true]) {
    expect(report([...lines, ...cold], { subscription })).toBe(report(lines, { subscription }))
    expect(report([...lines, ...cold], { subscription, markdown: true })).toBe(report(lines, { subscription, markdown: true }))
    expect(sessionTotal([...lines, ...cold], 's1', subscription)).toBe(sessionTotal(lines, 's1', subscription))
  }
  expect(shareMessage([...lines, ...cold], { now: NOW, subscription: false })).toBe(shareMessage(lines, { now: NOW, subscription: false }))
  // Cold lines alone are nothing to report.
  expect(report(cold).split('\n')[1]).toBe(report([]).split('\n')[1])
  expect(sessionTotal(cold, 's1', false)).toBeUndefined()
})
