import { expect, test } from 'claude-code/testing'
import { SESSION_TOTAL, accuracyRows, addTotals, foldLifetime, parseLifetime, type Lifetime, type RunLine, bandShareText, LARGE_FIXED, buildReport, costTag, counterfactual, fixedBlock, keepWarmLine, parseLines, problems, sessionTotal, shareMessage, shareText, span, taskActual, taskEstimated, taskExtra, taskStay, tieCounts, totals, usedTag, watchLine, wholeTaskRows, wholeTasks, windowCostText, windowRates } from './report'
import { DEFAULT_PRICES } from './cost'
import type { StartBlock } from './start'

const NOW = Date.parse('2026-10-23T18:00:00.000Z')
const ago = (days: number) => new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString()
const run = (x: Partial<RunLine>): RunLine => ({ at: ago(0), kind: 'run', session: 's1', change: 'none', offered: 'none', actual: 0.1, stay: 0.1, taken: 0.1, overhead: 0, ...x })
type Opts = { subscription?: boolean; switches?: { at: string; kept?: boolean }[]; start?: StartBlock; pause?: number | null; measureFrom?: string; markdown?: boolean; lifetime?: Lifetime }
/** /rightsize report alone. */
const summary = (lines: RunLine[], opts: Opts = {}, details = false) =>
  buildReport(lines, opts.switches ?? [], { now: NOW, session: 's1', subscription: opts.subscription ?? false, markdown: opts.markdown === true, details, ...(opts.start ? { start: opts.start } : {}), ...(opts.pause !== undefined ? { pause: opts.pause } : {}), ...(opts.measureFrom ? { measureFrom: opts.measureFrom } : {}), ...(opts.lifetime ? { lifetime: opts.lifetime } : {}) })
/** /rightsize report details alone. */
const details = (lines: RunLine[], opts: Opts = {}) => summary(lines, opts, true)
/** Both, the summary first: for checks that do not care which view a figure is in. */
const report = (lines: RunLine[], opts: Opts = {}) => `${summary(lines, opts)}\n${details(lines, opts)}`
/** A table row's cells (session, 7 days, 30 days), by its label. */
const cells = (text: string, label: string) => text.split('\n').find(l => l.startsWith(`  ${label}`))?.slice(2 + label.length).trim().split(/ {2,}/)
/** The report's section titles, in order. */
const titles = (text: string) => text.split('\n').filter(l => /^(?:[A-Z]{3}|30-DAY)/.test(l)).map(l => l.split('  ')[0])
/** The rows of one section, up to its blank line. */
const SUB_FOOT = 'Dollar figures are API prices: what the same use would cost on the API. You pay only your subscription.'
const SUB_FOOT_DETAILS = 'Dollar amounts are API-equivalent: what the same use would cost on the API. You only pay for your subscription.'
const sectionOf = (text: string, title: string) => {
  const out = text.split('\n')
  const at = out.findIndex(l => l.startsWith(title))
  return out.slice(at + 1, out.findIndex((l, i) => i > at && l === '')).map(l => l.trim())
}

/** A figure rounded to 6 decimals, so sums of cents compare. */
const r6 = (n: number) => Number(n.toFixed(6))

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
  expect(text.split('\n')[1]).toBe('Cost ~$0.10 more than it saved.')
  expect(cells(text, 'Saved')).toEqual(['-$0.10', '-$0.10', '-$0.10', '-$0.10'])
  expect(cells(text, 'Share of cost saved'), 'no share of a negative saving').toEqual(['–', '–', '–', '–'])
  expect(text, 'no doubled signs or a minus before words').not.toMatch(/-~|~-|--|-under/)
  // Small: under half a cent either way reads as even, never as "-under $0.01".
  expect(cells(report([run({ change: 'lower', offered: 'lower', actual: 0.101, stay: 0.1, taken: 0.05 })]), 'Saved')).toEqual(['even', 'even', 'even', 'even'])
  // A subscriber reads it in API-equivalent dollars.
  expect(report(lines, { subscription: true }).split('\n')[1]).toBe('Used more than it saved (~$0.10 more, API-equivalent).')
  // A raise that came out cheaper than its baseline adds no extra and does not take other raises' extra down.
  const cheap = run({ change: 'raise', offered: 'raise', actual: 0.05, stay: 0.1, taken: 0.2 })
  expect(totals([cheap]).extra, 'spent less than staying would have: nothing extra').toBe(0)
  expect(report([cheap]), 'no extra, no row').not.toContain('Extra on hard')
  const costly = run({ change: 'raise', offered: 'raise', actual: 0.3, stay: 0.1, taken: 0.2 })
  expect(Number(totals([costly, cheap, cheap, cheap]).extra.toFixed(5)), 'cheaper raises do not cancel a costlier one').toBe(0.2)
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
const fixed = { tokens: 40000, mcp: 25000, memory: 1000, agents: 2000, skills: 11000, startHooks: 0, cost: 0.03, servers: { Claude_Browser: 11000, 'claude-in-chrome': 7000, ccd_turn: 4000, vercel: 2000 } }
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

test('the report is laid out: title and headline, savings, summary, recommendations, footer; details hold the rest', async () => {
  const opts = { subscription: true, switches: [{ at: ago(0), kept: false }, { at: ago(0), kept: true }], measureFrom: ago(18) }
  const text = summary(month(), opts)
  const out = text.split('\n')
  expect(out[0]).toBe('rightsize report · last 30 days')
  expect(out[1]).toMatch(/^You got about \d+–\d+ more minutes of Claude's work from your plan\.$/)
  expect(out[2]).toMatch(/^That is ~[\d.]+–[\d.]+% of one 5-hour window, worth ~\$[\d.]+ at API prices\.$/)
  expect(out[3], 'the restart note is near the top').toMatch(/^Cost measurement restarted on 2026-10-0\d\.$/)
  expect(titles(text)).toEqual(['YOUR SAVINGS', '30-DAY SUMMARY', 'RECOMMENDATIONS'])
  expect(out.indexOf('Details: /rightsize report details'), 'the footer follows the last section').toBeGreaterThan(out.indexOf('RECOMMENDATIONS'))
  expect(out.slice(-2).join(' '), 'the footer is last').toBe(SUB_FOOT)
  const more = details(month(), opts)
  expect(more.split('\n')[0]).toBe('rightsize report details · last 30 days')
  expect(titles(more)).toEqual(['FIXED CONTEXT', 'ACCURACY', 'NOT COUNTED AS SAVINGS'])
  const foot = more.split('\n').indexOf('Estimated: actual cost vs staying at your own model and effort.')
  expect(more.split('\n').slice(foot + 1, foot + 3).join(' ')).toMatch(/^The saving is after the cost of rating prompts \(\$[\d.]+ API-equivalent in 30 days\)\./)
  for (const t of [text, more]) {
    expect(t.split('\n').filter(l => l.length > 80), 'no line past 80 characters').toEqual([])
    expect(t, 'plain text: no markdown table or emoji').not.toMatch(/\||\*\*|---|\p{Extended_Pictographic}/u)
    expect(t).not.toMatch(/Rightsize|Negative ROI|Rescue|Anomal/)
  }
})

test('the savings table lines up: right edges match and every row has a cell per period', async () => {
  const out = summary(month(), { subscription: true }).split('\n')
  const header = out.findIndex(l => l.trim().startsWith('Today'))
  expect(out[header]?.split(/ +/).filter(Boolean)).toEqual(['Today', '7', 'days', '30', 'days', 'Lifetime'])
  const table = out.slice(header, out.findIndex((l, i) => i > header && l === ''))
  expect(new Set(table.map(l => l.length)).size, 'all rows end in the same column').toBe(1)
  expect(table.length).toBeGreaterThan(4)
  for (const l of table.slice(1)) expect(l.trim().split(/ {2,}/).length, l).toBe(5)
  expect(cells(out.join('\n'), 'Prompts rated')).toEqual(['66'])
})

test('reports each period in columns, the window kept for a subscriber, and says when it cost more', async () => {
  const lines = [
    run({ change: 'lower', offered: 'lower', actual: 0.5, stay: 1, taken: 0.5, overhead: 0.01, durationMs: 60_000, before: { five_hour: 10 }, after: { five_hour: 11 } }),
    run({ change: 'none', actual: 0.5, durationMs: 60_000, before: { five_hour: 11 }, after: { five_hour: 12 } }),
    run({ at: ago(20), session: 'old', change: 'lower', actual: 0.1, stay: 0.1, taken: 0.1, overhead: 0.05 }),
  ]
  const sub = report(lines, { subscription: true })
  expect(cells(sub, 'Prompts rated')).toEqual(['3'])
  expect(cells(sub, 'Left as they were')).toEqual(['1 prompt'])
  expect(cells(sub, 'Effort lowered')).toEqual(['2 prompts'])
  expect(cells(sub, 'Cheaper model')).toEqual(['0 prompts'])
  // 2% of the window for $1 over 2 runs and 2 minutes, give or take sqrt(2) points of rounding: $0.49 saved is ~0.3–1.7% of one window; the old session's rating calls take it to $0.44 in 30 days.
  expect(cells(sub, '5-hour windows'), 'no roll-up yet: lifetime is every line in the logs').toEqual(['under 0.1', 'under 0.1', 'under 0.1', 'under 0.1'])
  expect(cells(sub, 'Extra work time')).toEqual(['under 2 min', 'under 2 min', 'under 2 min', 'under 2 min'])
  expect(cells(sub, 'Share of cost saved')).toEqual(['~33%', '~33%', '~27%', '~27%'])
  expect(sub.replace(/\s+/g, ' '), 'the rating cost is in the details footer').toContain('The saving is after the cost of rating prompts ($0.06 API-equivalent in 30 days).')
  expect(cells(sub, 'Value (API prices)'), 'dollars on a subscription are labelled').toEqual(['~$0.49', '~$0.49', '~$0.44', '~$0.44'])
  expect(sub.split('\n')[1], 'a subscriber reads work time first').toBe("You got up to 2 more minutes of Claude's work from your plan.")
  expect(sub.split('\n')[2]).toBe('That is ~0.3–1.5% of one 5-hour window, worth ~$0.44 at API prices.')
  const api = report(lines)
  expect(api.split('\n')[1], 'an API user reads dollars').toBe('You saved ~$0.44 (~27% of your cost).')
  expect(cells(api, 'Share of cost saved')).toEqual(['~33%', '~33%', '~27%', '~27%'])
  expect(api, 'no window rows and no API-equivalent note on the API').not.toMatch(/5-hour|API-equivalent|API prices/)
  const worse = report([run({ change: 'none', overhead: 0.03 })])
  expect(worse.split('\n')[1]).toBe('Cost ~$0.03 more than it saved.')
  expect(cells(worse, 'Saved')).toEqual(['-$0.03', '-$0.03', '-$0.03', '-$0.03'])
  expect(worse, 'on the API dollars are real: no label').not.toContain('API-equivalent')
  const worseSub = report([run({ change: 'none', overhead: 0.03 })], { subscription: true })
  expect(worseSub.split('\n')[1], 'no window measured yet: the share alone').toBe('Used more than it saved (~$0.03 more, API-equivalent).')
  expect(cells(worseSub, 'Share of cost saved')).toEqual(['–', '–', '–', '–'])
  expect(cells(worseSub, 'Value (API prices)')).toEqual(['-$0.03', '-$0.03', '-$0.03', '-$0.03'])
  expect(report([run({ change: 'none' })]).split('\n')[1]).toBe('About even: savings and rating calls cancel out.')
})

test('a window used more than staying would have shows as a negative share', async () => {
  const lines = [run({ change: 'raise', actual: 0.3, stay: 0.1, taken: 0.2, overhead: 0.5, durationMs: 60_000, before: { five_hour: 10 }, after: { five_hour: 12 } })]
  const text = summary(lines, { subscription: true })
  expect(text.split('\n').slice(1, 3).join(' ')).toBe('Used ~1.7–5.0% more of your 5-hour window than staying would have (~$0.50 more, API-equivalent).')
  expect(cells(text, '5-hour windows')?.[0]).toBe('0 to -0.1')
})

test('nothing rated yet: says so, with no table and no empty sections', async () => {
  const text = summary([])
  const out = text.split('\n')
  expect(out.slice(0, 2)).toEqual(['rightsize report · last 30 days', 'Nothing rated yet.'])
  expect(titles(text)).toEqual([])
  expect(text, 'no details pointer with nothing behind it').not.toContain('/rightsize report details')
  const more = details([])
  expect(titles(more)).toEqual(['NOT COUNTED AS SAVINGS'])
  expect(sectionOf(more, 'NOT COUNTED AS SAVINGS')).toEqual(['Nothing yet.'])
  expect(more).not.toMatch(/FIXED CONTEXT|ACCURACY|RECOMMENDATIONS/)
  expect(more.split('\n').slice(-1)).toEqual(['Estimated: actual cost vs staying at your own model and effort.'])
  // Work from another session counts the same: the report has no session column.
  const other = report([run({ session: 'old', change: 'lower', offered: 'lower', actual: 0.05, stay: 0.1, taken: 0.05 })])
  expect(cells(other, 'Prompts rated')).toEqual(['1'])
  expect(cells(other, 'Effort lowered')).toEqual(['1 prompt'])
  expect(cells(other, 'Saved')).toEqual(['~$0.05', '~$0.05', '~$0.05', '~$0.05'])
})

test('rows with nothing to say are left out', async () => {
  const text = report([run({})])
  for (const label of ['Effort raised', 'Stronger model', 'You declined', 'Subagents moved', 'Close calls', 'Extra on hard', '5-hour']) expect(text, label).not.toContain(label)
  expect(cells(text, 'Effort lowered'), 'effort and model changes always show').toEqual(['0 prompts'])
  expect(cells(text, 'Cheaper model')).toEqual(['0 prompts'])
  const busy = report([run({ change: 'raise', offered: 'raise', actual: 0.3, stay: 0.1, taken: 0.2 }), run({ change: 'none', offered: 'lower' }), run({ change: 'delegate-down', route: 'delegate:haiku' })])
  expect(cells(busy, 'Cheaper model')).toEqual(['1 prompt'])
  expect(cells(busy, 'Effort raised')).toEqual(['1 prompt'])
  expect(cells(busy, 'You declined')).toEqual(['1 suggestion'])
  expect(cells(busy, 'Extra on hard prompts')).toEqual(['$0.20', '$0.20', '$0.20', '$0.20'])
  expect(busy.replace(/\s+/g, ' '), 'the footer says what the extra is').toContain("It isn't taken off the saving.")
})

test('savings lead the table, before what rightsize did', async () => {
  const labels = (text: string) => text.split('\n').filter(l => /^ {2}\S/.test(l)).map(l => l.trim().split(/ {2,}/)[0])
  const all = labels(summary(month(), { subscription: true }))
  expect(all[0]).toBe('Extra work time')
  expect(all.indexOf('Prompts rated')).toBeGreaterThan(all.indexOf('Share of cost saved'))
  const windowed = [
    run({ change: 'lower', offered: 'lower', actual: 0.5, stay: 1, taken: 0.5, overhead: 0.01, durationMs: 60_000, before: { five_hour: 10 }, after: { five_hour: 11 } }),
    run({ change: 'none', actual: 0.5, durationMs: 60_000, before: { five_hour: 11 }, after: { five_hour: 12 } }),
  ]
  expect(labels(summary(windowed, { subscription: true })).slice(0, 3)).toEqual(['Extra work time', '5-hour windows', 'Value (API prices)'])
})

test('for the desktop app, the aligned blocks go in code fences and prose is not wrapped', async () => {
  const plain = report(month(), { subscription: true })
  const md = report(month(), { subscription: true, markdown: true })
  const fences = md.split('\n').filter(l => l === '```').length
  expect(fences % 2, 'every fence is closed').toBe(0)
  expect(fences, 'savings, summary, fixed context, accuracy and problems').toBeGreaterThanOrEqual(10)
  expect(md).toContain('  Value (API prices)')
  expect(md.split('\n').some(l => l.startsWith('1. ') && l.length > 80), 'recommendations are one line each').toBe(true)
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
  expect(text, 'no rated prompts: no summary rows for them').not.toContain('Prompts rated')
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
  expect(text).not.toContain('Prompts rated')
  expect(text, 'a report of only these is not "nothing rated"').not.toContain('Nothing rated')
  expect(problems([dropped, unbound], []), 'they are not problems of the rating').toEqual([])
})

test('a long problem wraps within 80 columns, and each sign of a stuck turn gets its own line', async () => {
  const stuck = (why: string) => run({ escalations: [{ step: 3, from: 'low', to: 'medium', why }] })
  const lines = [
    ...Array.from({ length: 15 }, () => stuck('the same tool call ran 3 times')),
    ...Array.from({ length: 11 }, () => stuck('4 tool calls failed')),
    ...Array.from({ length: 10 }, () => stuck('the turn passed 15 steps, 3x the estimate')),
    ...Array.from({ length: 9 }, () => ({ at: ago(0), kind: 'unrated' as const, session: 's1', reason: 'rating call timed out', overhead: 0.001 })),
  ]
  const text = details(lines)
  expect(text.split('\n').filter(l => l.length > 80), 'no line past 80 characters').toEqual([])
  const rows = sectionOf(text, 'NOT COUNTED AS SAVINGS')
  const at = rows.findIndex(l => l.includes('raised mid-turn because Claude looked stuck'))
  expect(rows.slice(at + 1, at + 4), 'one sign per line, most first, under the reason').toEqual(['the same tool call ran 3 times (15)', 'several tool calls failed (11)', 'the turn passed 15 steps, 3x the estimate (10)'])
  const plain = text.split('\n')
  const reasonCol = plain.find(l => l.includes('raised mid-turn'))?.indexOf('raised') ?? -1
  expect(plain.find(l => l.includes('the same tool call ran'))?.indexOf('the same'), 'signs start in the reason column').toBe(reasonCol)
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
    head: '~22K tokens sent with every request',
    notes: ['Fixed context adds to your cost in every session. Cutting it saves more.', 'At least ~$2.00 over 40 requests, ~100% of what those turns cost.', 'SessionStart hooks: not measured.'],
    tree: [
      ['├─ MCP tools', '18K', 'linear 20K'],
      ['└─ Memory', '4K'],
    ],
    fix: "rightsize can't trim fixed context. To cut it: disconnect MCP servers you don't use (/mcp), or trim CLAUDE.md and MEMORY.md (/memory).",
    rec: "Cut fixed context. ~22K tokens go with every request: at least ~$2.00 in 30 days, ~100% of what those turns cost. Largest: MCP tools 18K, Memory 4K. To cut it: disconnect MCP servers you don't use (/mcp), or trim CLAUDE.md and MEMORY.md (/memory).",
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

test('fixed context names the memory files on the Memory row, from the last run', async () => {
  const f = (files: Record<string, number> | undefined) => run({ requests: 5, actual: 1, fixed: { tokens: 12000, mcp: 3000, memory: 9000, agents: 0, skills: 0, startHooks: 0, cost: 0.5, ...(files ? { files } : {}) } })
  const block = fixedBlock([f({ 'CLAUDE.md': 1000 }), f({ 'MEMORY.md': 2000, 'CLAUDE.md': 6000 })])
  expect(block?.tree).toEqual([['├─ Memory', '9K', 'CLAUDE.md 6K, MEMORY.md 2K'], ['└─ MCP tools', '3K']])
  expect(block?.fix).toContain('trim CLAUDE.md and MEMORY.md (/memory)')
  // An old line has no files: the row is as before.
  expect(fixedBlock([f(undefined)])?.tree[0]).toEqual(['├─ Memory', '9K'])
  // The row fits in 80 columns, the rest counted.
  const wide = fixedBlock([f({ [`${'a'.repeat(40)}.md`]: 3000, [`${'b'.repeat(40)}.md`]: 2000 })])
  expect(wide?.tree[0]?.[2]).toBe(`${'a'.repeat(40)}.md 3K, +1 more`)
  const text = report([f({ 'CLAUDE.md': 6000, 'MEMORY.md (User)': 2000 })])
  expect(text).toMatch(/ {2}├─ Memory +9K +CLAUDE\.md 6K, MEMORY\.md \(User\) 2K\n/)
  expect(text.split('\n').filter(l => l.length > 80)).toEqual([])
})

test('fixed context counts SessionStart hooks over the turns that measured them, and advises on them when they are the biggest part', async () => {
  const f = (startHooks: number | undefined, requests: number, old?: number) =>
    run({ requests, actual: 1, fixed: { tokens: 6000 + (startHooks ?? 0), mcp: 0, memory: 3000, agents: 0, skills: 3000, ...(startHooks === undefined ? {} : { startHooks }), ...(old === undefined ? {} : { hooks: old }), cost: 0.5 } })
  // Request-weighted over the measured turns only: a turn that could not measure them is left out, not counted as 0.
  const block = fixedBlock([f(undefined, 10), f(6000, 10), f(8000, 30)])
  expect(block?.tree).toEqual([['├─ SessionStart hooks', '8K'], ['├─ Memory', '3K'], ['└─ Skills', '3K']])
  expect(block?.notes, 'some turns measured them: no "not measured"').not.toContain('SessionStart hooks: not measured.')
  expect(block?.fix).toBe("rightsize can't trim fixed context. To cut it: turn off plugins whose SessionStart hooks you don't use (/plugin), or trim your own hooks' output, or trim CLAUDE.md and MEMORY.md (/memory).")
  // Under 500 tokens a part is not listed; a measured 0 is not a "not measured".
  expect(fixedBlock([f(400, 10)])?.tree.map(r => r[0])).toEqual(['├─ Memory', '└─ Skills'])
  expect(fixedBlock([f(0, 10)])?.notes).not.toContain('SessionStart hooks: not measured.')
  // No turn measured them: said, never shown as 0. The old `hooks` key (always 0 from 0.9 to 0.11) is not a measurement.
  for (const lines of [[f(undefined, 10)], [f(undefined, 10, 0)], [f(undefined, 10, 5000)]]) {
    const b = fixedBlock(lines)
    expect(b?.tree.map(r => r[0])).toEqual(['├─ Memory', '└─ Skills'])
    expect(b?.notes.at(-1)).toBe('SessionStart hooks: not measured.')
  }
  const text = report([f(8000, 10)])
  expect(text).toMatch(/ {2}├─ SessionStart hooks +8K\n/)
  expect(text.split('\n').filter(l => l.length > 80)).toEqual([])
  expect(report([f(undefined, 10)])).toMatch(/ {2}SessionStart hooks: not measured\.\n {2}├─ Memory/)
})

test('fixed context flags a memory file or the SessionStart hooks of 10K tokens or more, largest first', async () => {
  const f = (over: { hooks?: number; files?: Record<string, number> }, requests = 5) => run({ requests, actual: 1, fixed: { tokens: 30000, mcp: 5000, memory: 12000, agents: 0, skills: 0, startHooks: over.hooks ?? 0, cost: 0.5, ...(over.files ? { files: over.files } : {}) } })
  const notes = (...lines: ReturnType<typeof f>[]) => fixedBlock(lines)?.notes ?? []
  expect(LARGE_FIXED).toBe(10000)
  expect(notes(f({ files: { 'CLAUDE.md': 12000 }, hooks: 24000 }))[2]).toBe('Large: SessionStart hooks 24K, CLAUDE.md 12K.')
  expect(notes(f({ files: { 'CLAUDE.md': 12000, 'MEMORY.md': 10000 } }))[2], 'files only, at the line').toBe('Large: CLAUDE.md 12K, MEMORY.md 10K.')
  expect(notes(f({ hooks: 10000 })), 'hooks at the line').toHaveLength(3)
  expect(notes(f({ hooks: 9999, files: { 'CLAUDE.md': 9999 } })), 'below the line: no note').toHaveLength(2)
  expect(notes(f({})), 'nothing large: no note').toHaveLength(2)
  // The hooks are request-weighted: one big run among many small ones does not flag them.
  expect(notes(f({ hooks: 40000 }, 1), f({ hooks: 0 }, 9))).toHaveLength(2)
  // A file is judged on the last run.
  expect(notes(f({ files: { 'CLAUDE.md': 12000 } }), f({ files: { 'CLAUDE.md': 3000 } }))).toHaveLength(2)
  const text = report([f({ files: { 'CLAUDE.md': 12000 }, hooks: 24000 })])
  expect(text).toMatch(/At least ~\$[\d.]+ over 5 requests[^\n]*\n {2}Large: SessionStart hooks 24K, CLAUDE\.md 12K\.\n/)
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
  const recs = sectionOf(text, 'RECOMMENDATIONS').join(' ')
  expect(recs).toMatch(/^1\. Cut fixed context\. ~40K tokens go with every request: at least ~\$[\d.]+ in 30 days, ~\d+% of what those turns cost\. Largest: MCP tools 25K, Skills 11K\./)
  expect(recs).toContain("To cut it: disconnect MCP servers you don't use (/mcp), or turn off plugins and skills you don't use (/plugin).")
})

test("Claude's subagents moved to a cheaper model: counted, and their saving added", async () => {
  const sub = (x: Partial<RunLine>): RunLine => ({ at: ago(0), kind: 'subagent', session: 's1', type: 'search', from: 'opus', tier: 'haiku', level: 'low', estimate: 0.01, parentEstimate: 0.2, actual: 0.02, ...x })
  const t = totals([run({ actual: 0.5 }), sub({}), sub({ aborted: true })])
  expect([t.rated, t.subagents]).toEqual([1, 2])
  // 0.02 on Haiku against an estimate 20x higher on Opus: 0.40 that way, 0.38 saved. The stopped one claims nothing.
  expect(Math.abs(t.saved - 0.38) < 1e-9).toBe(true)
  expect(t.spent, 'its cost is already in its turn').toBe(0.5)
  const text = report([run({ actual: 0.5 }), sub({})])
  expect(cells(text, 'Subagents moved')).toEqual(['1 to a cheaper model'])
  expect(cells(text, 'Prompts rated')).toEqual(['1'])
  expect(text).toContain('You saved ~$0.38')
  expect(cells(report([sub({})]), 'Subagents moved'), 'a month with only a subagent line').toEqual(['1 to a cheaper model'])
  expect(report([sub({})])).not.toContain('Prompts rated')
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
  // In the details' ACCURACY, for 30 days: the older one counts too.
  expect(cells(details(lines), 'Close calls')).toEqual(['4 guided, 1 explored'])
  expect(report([run({}), run({ resized: [{}] })]), 'nothing to say without ties').not.toContain('Close calls')
  expect(tieCounts([{ at: ago(0), kind: 'overhead', overhead: 0.1 }])).toEqual({ guided: 0, explored: 0 })
  expect(cells(details([run({ tie: { by: 'explore', over: 'opus' } })]), 'Close calls')).toEqual(['0 guided, 1 explored'])
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
  expect(cells(report(lines), 'Prompts rated')).toEqual(['1'])
  expect(report(lines), 'the check is counted with the rating calls').toContain('($0.01 in 30 days)')
})

const handDown = (rework: boolean, days = 0) => run({ at: ago(days), type: 'search', route: 'delegate:haiku', change: 'delegate-down', agentCalls: rework ? 2 : 1 })

test('the type "other" is named as unclassified work, not "other work"', async () => {
  const other = (rework: boolean) => run({ type: 'other', route: 'delegate:haiku', change: 'delegate-down', agentCalls: rework ? 2 : 1 })
  const out = accuracyRows([other(true), other(true), other(false), other(false), other(false)])
  expect(out.rows[1]).toEqual(['Hand-downs paused', 'unclassified work to Haiku, wrong on 40% of 5'])
  expect(out.paused).toBe('Hand-downs of unclassified work (work the rater could not place in a kind) to Haiku, and lowering effort on it, resume when its miss rate falls under the Pause after misses line (/config).')
})

test("says how often Haiku's judgement was wrong, how the Sonnet checks went, and which hand-downs are paused", async () => {
  expect(accuracyRows([run({}), run({ change: 'lower', steppedUp: false })]).rows, 'no misses: nothing to say').toEqual([])
  const lines = [handDown(true), handDown(true), handDown(false), handDown(false), handDown(false), run({ type: 'lookup', change: 'lower', tier: 'opus', steppedUp: true })]
  const out = accuracyRows(lines)
  expect(out.rows[0]).toEqual(["Haiku's judgement", 'wrong on 3 of 6 checked prompts (50%)'])
  expect(out.rows[1], 'Haiku was wrong on 2 of 5 search hand-downs: 40%, over the 30% line').toEqual(['Hand-downs paused', 'search work to Haiku, wrong on 40% of 5'])
  expect(out.paused, 'the full notice').toBe('Hand-downs of search work to Haiku, and lowering effort on it, resume when its miss rate falls under the Pause after misses line (/config).')
  const calm = accuracyRows([...lines.slice(2, 5), run({ type: 'lookup', change: 'lower', tier: 'opus', steppedUp: true })])
  expect(calm.rows.length, 'under 5 outcomes on any one key: nothing paused').toBe(1)
  expect(calm.paused).toBeUndefined()
  const text = report(lines)
  expect(sectionOf(text, 'ACCURACY').join('\n')).toMatch(/Haiku's judgement +wrong on 3 of 6 checked prompts \(50%\)\nHand-downs paused +search work to Haiku, wrong on 40% of 5/)
  expect(sectionOf(text, 'RECOMMENDATIONS').join(' ')).toBe('Paused: hand-downs of search work to Haiku (wrong on 40% of 5). They resume by themselves when the miss rate falls under Pause after misses (/config).')
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
  expect(text(null), 'no pause: no recommendation for it').not.toContain('RECOMMENDATIONS')
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
  expect(cells(text, 'Prompts rated'), 'periods still read every line').toEqual(['6'])
  expect(report(lines)).not.toContain('Cost measurement restarted')
})

test('recommendations collect the actions, then what needs none; the block is left out when there is nothing', async () => {
  const start: StartBlock = {
    head: 'Opus at medium, 60 rated prompts in 30 days',
    rows: [['Opus at medium (yours)', '~$12.00 per 100 prompts'], ['Sonnet at medium', '~$8.00 per 100 prompts, 4% to a stronger model']],
    note: 'Estimated from your log. A different start is suggested under RECOMMENDATIONS.',
    tip: 'Starting on Sonnet at medium would have cost ~33% less than Opus at medium on your last 60 rated prompts. Switch with /model.',
  }
  const lines = [...month(), handDown(true), handDown(true), handDown(false), handDown(false), handDown(false)]
  const text = summary(lines, { start })
  expect(titles(text)).toEqual(['YOUR SAVINGS', '30-DAY SUMMARY', 'RECOMMENDATIONS'])
  expect(titles(details(lines, { start }))).toEqual(['STARTING POINT', 'FIXED CONTEXT', 'ACCURACY', 'NOT COUNTED AS SAVINGS'])
  expect(sectionOf(details(lines, { start }), 'STARTING POINT')[0]).toMatch(/^Opus at medium \(yours\) +~\$12.00 per 100 prompts$/)
  const recs = sectionOf(text, 'RECOMMENDATIONS')
  // Fixed context, then the start, numbered; then the pause; long ones wrap under their text.
  expect(recs.filter(l => /^\d\. /.test(l)).map(l => l.slice(0, 23))).toEqual(['1. Cut fixed context. ~', '2. Starting on Sonnet a'])
  expect(recs.find(l => l.startsWith('Paused: '))).toMatch(/^Paused: hand-downs of search work to Haiku/)
  expect(text.split('\n').filter(l => l.length > 80)).toEqual([])
  const none = report([run({})], { start: { head: 'Needs 50 rated prompts to compare (has 1).', rows: [] } })
  expect(none).toContain('STARTING POINT  Needs 50 rated prompts to compare (has 1).')
  expect(none, 'no action: no block').not.toContain('RECOMMENDATIONS')
  const fits = report([run({})], { start: { head: 'Opus at medium, 60 rated prompts in 30 days', rows: [], note: 'Estimated from your log. Your start fits: no other start is clearly cheaper without sending more work to a stronger model.', fits: 'your start (Opus at medium) fits' } })
  expect(sectionOf(fits, 'RECOMMENDATIONS'), 'a start that fits is a checked note, not an action').toEqual(['Checked, no change needed: your start (Opus at medium) fits.'])
  expect(fits.split('\n').filter(l => l.length > 80), 'a long note wraps').toEqual([])
})

test('keep warm that cost more than it saved is a recommendation', async () => {
  const ping = (overhead: number): RunLine => ({ at: ago(0), kind: 'warm', session: 's1', warmRun: 'r1', overhead })
  const lose = summary([run({}), ping(0.5)])
  expect(sectionOf(lose, 'RECOMMENDATIONS').join(' ')).toBe('1. Keep warm cost more than it saved (~$0.50 more). Set Before the cache goes cold to a shorter keep warm, or to ask (/config).')
  expect(summary([run({}), ping(0.5)], { subscription: true }).replace(/\s+/g, ' ')).toContain('(~$0.50 more at API prices)')
  const win = summary([run({}), ping(0.1), { at: ago(0), kind: 'warmSaved', session: 's1', saved: 0.6 }])
  expect(win, 'it saved more than it cost: nothing to do').not.toContain('RECOMMENDATIONS')
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
  const lines = [...month(), ...timed()]
  const text = report(lines, { start: { head: 'Opus at medium, 60 rated prompts in 30 days', rows: [], tip: 'Switch with /model.' } })
  const order = titles(text)
  expect(order.indexOf('TIME')).toBe(order.indexOf('NOT COUNTED AS SAVINGS') + 1)
  expect(order.indexOf('RECOMMENDATIONS'), 'recommendations are in the summary, before the details').toBeLessThan(order.indexOf('TIME'))
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
  // The band's figure is the same as the report's: these lines are all from today and from this session.
  const lines = [saved, run({ change: 'lower', offered: 'lower', actual: 0.1, stay: 0.3, taken: 0.15, overhead: 0.02 })]
  const shown = cells(report(lines), 'Saved')?.[0]
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
  expect(text.split('\n').slice(1, 3)).toEqual(["You got about 1 more minute of Claude's work from your plan.", 'That is ~3.3–4.7% of one 5-hour window, worth ~$0.50 at API prices.'])
  expect(cells(text, '5-hour windows'), 'a count of windows: under a tenth of one').toEqual(['under 0.1', 'under 0.1', 'under 0.1', 'under 0.1'])
  expect(cells(text, 'Extra work time')).toEqual(['~1 min', '~1 min', '~1 min', '~1 min'])
  expect(sessionTotal(lines, 's1', true)).toBe('Session: ~3–5% saved')
  // The 7-day window gets its own range.
  const week = lines.map(l => ({ ...l, before: { ...l.before, seven_day: 20 }, after: { ...l.after, seven_day: 21 } }))
  expect(cells(report(week, { subscription: true }), 'Weekly limit')?.[0]).toBe('~0.3–2%')
  // The minutes are a range too: 4 points for $0.50 over 10 minutes, one run.
  const slow = (points: number) => [run({ change: 'lower', offered: 'lower', actual: 0.5, stay: 1, taken: 0.5, durationMs: 600_000, before: { five_hour: 10 }, after: { five_hour: 10 + points } })]
  expect(report(slow(4), { subscription: true }).split('\n')[1]).toBe("You got about 8–13 more minutes of Claude's work from your plan.")
  expect(report(slow(1), { subscription: true }).split('\n')[1]).toBe("You got up to 20 more minutes of Claude's work from your plan.")
  // Hours once it passes two hours: 100 points over 100 minutes for $1; $40 saved is about 40 windows, about 66 hours.
  const long = [run({ change: 'lower', offered: 'lower', actual: 1, stay: 41, taken: 1, durationMs: 6_000_000, before: { five_hour: 0 }, after: { five_hour: 100 } })]
  expect(report(long, { subscription: true }).split('\n').slice(1, 3).join(' ')).toMatch(/^You got about \d+–\d+ more hours of Claude's work from your plan\. That is ~\d+(–\d+)? extra 5-hour windows, worth ~\$40 at API prices\.$/)
  // 400 runs of 10 points for $0.10 each, and one that saved $0.02: 2.0 points give or take 0.01. No times: no minutes.
  const big = [
    ...Array.from({ length: 399 }, (_, i) => run({ id: `m${i}`, actual: 0.1, before: { five_hour: 0 }, after: { five_hour: 10 } })),
    run({ change: 'lower', offered: 'lower', actual: 0.1, stay: 0.12, taken: 0.1, before: { five_hour: 0 }, after: { five_hour: 10 } }),
  ]
  expect(report(big, { subscription: true }).split('\n')[1]).toBe('You saved ~2.0% of one 5-hour window, worth ~$0.02 at API prices.')
  expect(sessionTotal(big, 's1', true)).toBe('Session: ~2% saved')
  // One turn: the rounding error is as big as the reading, so the low end is 0.
  const one = [run({ change: 'lower', offered: 'lower', actual: 0.5, stay: 1, taken: 0.5, before: { five_hour: 10 }, after: { five_hour: 11 } })]
  expect(report(one, { subscription: true }).split('\n')[1]).toBe('You saved under 2.0% of one 5-hour window, worth ~$0.50 at API prices.')
})

// ---- Capacity, API-equivalent cost and real spending stay apart ----------------

test('on a subscription, every dollar figure in the report is labelled as API prices', async () => {
  const text = report(month(), { subscription: true, markdown: true, switches: [{ at: ago(0), kept: false }, { at: ago(0), kept: true }] })
  const lines = text.split('\n')
  // The savings table's dollar rows say it in their label, and the footer says it for the whole table.
  const table = new Set(lines.slice(lines.indexOf('YOUR SAVINGS'), lines.indexOf('30-DAY SUMMARY')))
  const dollars = lines.filter(l => l.includes('$') && !table.has(l))
  // The headline, the recommendation, the problems, the details' footer.
  expect(dollars.length).toBeGreaterThanOrEqual(4)
  for (const l of dollars) expect(l, 'a dollar line without the label').toMatch(/API-equivalent|API prices/)
  expect(text).toContain('Value (API prices)')
  expect(text).toContain('Dollar figures are API prices: what the same use would cost on the API. You pay only your subscription.')
  expect(text).not.toMatch(/Extra spent|\bsaved \$|spent/)
  const raised = [run({ change: 'raise', offered: 'raise', actual: 0.3, stay: 0.1, taken: 0.2 })]
  const extra = report(raised, { subscription: true })
  expect(cells(extra, 'Extra on hard prompts')).toEqual(['$0.20', '$0.20', '$0.20', '$0.20'])
  expect(extra.replace(/\s+/g, ' ')).toContain('Extra on hard prompts: what raising effort or using a stronger model would cost on the API, for better answers.')
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
  expect(cells(report(lines), 'Extra on hard prompts')).toBeDefined()
  expect(text, 'API prices are only for a subscription').not.toContain('API prices')
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
  expect(cells(report([saving]), 'Saved')).toEqual(['~$0.30', '~$0.30', '~$0.30', '~$0.30'])
  const text = report(lines)
  expect(cells(text, 'Saved'), 'the same saving, less the pings').toEqual(['~$0.20', '~$0.20', '~$0.20', '~$0.20'])
  expect(text.replace(/\s+/g, ' ')).toContain('The saving is after the cost of rating prompts and of keeping the cache warm ($0.10 in 30 days), and counts what keeping it warm saved when you came back to a warm cache.')
  expect(report([saving]).replace(/\s+/g, ' '), 'no pings, no mention').toContain('The saving is after the cost of rating prompts (under $0.01 in 30 days).')
  // The band's running total counts them too.
  expect(sessionTotal(lines, 's1', false)).toBe('Session: ~$0.20 saved')
  // Pings alone are a cost with nothing saved.
  expect(report([warm(0.04), warm(0.06)]).split('\n')[1]).toBe('Cost ~$0.10 more than it saved.')
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

test('the step estimates line counts scored runs while learning, then dates the applied streak in Pacific', async () => {
  const learn = (at: string, applied: boolean) => run({ at, learning: { g: -0.2, plan: 'none', differs: false, applied } })
  const hour = (h: number) => new Date(NOW - h * 60 * 60 * 1000).toISOString()
  const few = Array.from({ length: 3 }, (_, i) => learn(hour(10 + i), false))
  expect(report(few), 'learning until 50 scored runs').toContain('Step estimates: learning, 3 of 50 runs')
  expect(report([run({ at: hour(1) })]), 'a run without a learning note is not counted').toContain('Step estimates: learning, 0 of 50 runs')
  const many = Array.from({ length: 60 }, (_, i) => learn(hour(100 + i), false))
  expect(report(many)).toContain('Step estimates: learning, 50 of 50 runs')
  // Applied from Oct 20 (11:00 Pacific on the 20th, 18:00 UTC); a pause before it does not count.
  const applied = [learn('2026-10-20T18:00:00.000Z', true), learn('2026-10-21T18:00:00.000Z', true)]
  const streak = report([...many, ...applied])
  expect(streak).toContain('Step estimates: applied since Oct 20')
  expect(streak.split('\n').filter(l => l.length > 80), 'the line fits 80 columns').toEqual([])
  const paused = report([...applied, learn('2026-10-22T18:00:00.000Z', false), learn('2026-10-23T17:00:00.000Z', true)])
  expect(paused).toContain('Step estimates: applied since Oct 23')
})

// ---- Whole tasks -----------------------------------------------------------------

/**
 * One task's lines: two prompts (the first stopped, then redone), a helper's line, a keep-warm request, a rater check, a failed
 * rating, lines that cost nothing, and another task's run and keep-warm line that must stay out.
 */
const taskLines = (): RunLine[] => [
  run({ id: 'a1', task: 'a1', type: 'feature', taken: 0.4, stay: 0.5, actual: 0.3, overhead: 0.02, aborted: true }),
  run({ id: 'a2', task: 'a1', type: 'feature', taken: 0.4, stay: 0.5, actual: 0.6, overhead: 0.01, helpers: [{ agent: 'h1', kind: 'handoff', steps: 4, ms: 5000, errors: 0, blocked: 0 }] }),
  // The helper's cost is already in its run's: this line adds nothing to ACTUAL.
  { at: ago(0), kind: 'subagent', session: 's1', task: 'a1', run: 'a2', actual: 0.2, estimate: 0.1, parentEstimate: 0.3 },
  { at: ago(0), kind: 'warm', session: 's1', task: 'a1', tier: 'opus', context: 80_000, overhead: 0.04 },
  { at: ago(0), kind: 'check', session: 's1', task: 'a1', overhead: 0.01 },
  { at: ago(0), kind: 'unrated', session: 's1', task: 'a1', reason: 'timeout', overhead: 0.03 },
  // No cost: how an offer was answered, a thumbs-up, and a keep-warm return (its saving is in Total saved, not in the task's cost).
  { at: ago(0), kind: 'cold', session: 's1', task: 'a1', choice: '2h' },
  { at: ago(0), kind: 'feedback', session: 's1', task: 'a1', ref: 'a2', value: 'up' },
  { at: ago(0), kind: 'warmSaved', session: 's1', task: 'a1', tier: 'opus', context: 80_000, saved: 0.6 },
  // Another task, and a keep-warm line with no task: neither is a1's.
  run({ id: 'b1', task: 'b1', type: 'debug', taken: 2, stay: 3, actual: 9, overhead: 1 }),
  { at: ago(0), kind: 'warm', session: 's1', tier: 'opus', context: 80_000, overhead: 5 },
]

test('ESTIMATED is the sum of the route estimates (taken) of the prompts that ran to the end; a stopped one is left out; other tasks are ignored', async () => {
  const lines = taskLines()
  expect(taskEstimated(lines, 'a1'), 'the stopped first prompt was redone by the second, which has its own estimate').toBe(0.4)
  expect(taskEstimated(lines, 'b1')).toBe(2)
  expect(r6(taskEstimated([...lines, run({ id: 'a3', task: 'a1', taken: 0.25 })], 'a1')), 'a later prompt in the task adds its own').toBe(r6(0.65))
  expect(taskEstimated(lines, 'nope')).toBe(0)
  expect(taskEstimated(lines, ''), 'no task id').toBe(0)
  expect(taskEstimated([], 'a1')).toBe(0)
  expect(taskEstimated([...lines].reverse(), 'a1'), 'order does not matter').toBe(0.4)
  expect(taskEstimated(lines.filter(l => l.task !== 'b1'), 'a1'), 'other tasks do not change it').toBe(0.4)
})

test('STAY is the sum of each finished prompt\'s estimate of staying, from its own task only', async () => {
  const lines = taskLines()
  expect(taskStay(lines, 'a1')).toBe(0.5)
  expect(taskStay(lines, 'b1')).toBe(3)
  expect(taskStay(lines, 'nope')).toBe(0)
  expect(r6(taskStay([...lines, run({ id: 'a3', task: 'a1', stay: 0.25 })], 'a1'))).toBe(r6(0.75))
})

test('ACTUAL is everything the task cost: every run (stopped too), the rating calls, checks and keep-warm requests, and no helper twice', async () => {
  const lines = taskLines()
  // 0.3+0.02 stopped run, 0.6+0.01 its redo, 0.04 keep warm, 0.01 check, 0.03 failed rating.
  expect(Number(taskActual(lines, 'a1').toFixed(5))).toBe(1.01)
  expect(Number(taskActual(lines, 'b1').toFixed(5)), 'only its own run, and the keep-warm line with no task is not its').toBe(10)
  // The subagent line is already inside its run's cost: with or without it the total is the same.
  expect(taskActual(lines.filter(l => l.kind !== 'subagent'), 'a1')).toBe(taskActual(lines, 'a1'))
  // Neither the cold line, the thumbs-up nor the saving of a keep-warm return costs anything.
  expect(taskActual(lines.filter(l => !['cold', 'feedback', 'warmSaved'].includes(l.kind ?? '')), 'a1')).toBe(taskActual(lines, 'a1'))
  expect(taskActual(lines, 'nope')).toBe(0)
  expect(taskActual(lines, '')).toBe(0)
  expect(Number(taskActual([...lines].reverse(), 'a1').toFixed(5))).toBe(1.01)
  expect(Number(taskActual(lines.filter(l => l.task !== 'b1'), 'a1').toFixed(5))).toBe(1.01)
})

test('the extra over the estimate is split into retries and rework, helpers, keep warm and other, and adds up', async () => {
  // ACTUAL 1.01 against ESTIMATED 0.4: an extra of 0.61. Named: stopped run 0.3, helper line 0.2, keep warm 0.04; the rest is other.
  const x = taskExtra(taskLines(), 'a1')
  expect(r6(x.extra)).toBe(r6(0.61))
  expect(r6(x.retries), 'a stopped turn is rework').toBe(r6(0.3))
  expect(r6(x.helpers)).toBe(r6(0.2))
  expect(r6(x.warm)).toBe(r6(0.04))
  expect(r6(x.other), 'rating calls, the check and the redo above its estimate').toBe(r6(0.07))
  expect(r6(x.retries + x.helpers + x.warm + x.other)).toBe(r6(x.extra))
  // A turn raised mid-turn counts what it cost over its estimate as rework.
  const raised = [run({ id: 'r1', task: 'r1', taken: 0.1, stay: 0.1, actual: 0.35, escalations: [{ step: 3, from: 'low', to: 'high', why: 'x' }] })]
  expect(Object.values(taskExtra(raised, 'r1')).map(r6)).toEqual([0.25, 0.25, 0, 0, 0])
  // Named parts that come to more than the extra are scaled down to it (their cost is partly inside the estimate).
  const big = [run({ id: 'c1', task: 'c1', taken: 0.5, stay: 0.5, actual: 0.6 }), { at: ago(0), kind: 'subagent', session: 's1', task: 'c1', run: 'c1', actual: 0.4 } as RunLine]
  const scaled = taskExtra(big, 'c1')
  expect(r6(scaled.extra)).toBe(r6(0.1))
  expect(r6(scaled.helpers)).toBe(r6(0.1))
  expect(scaled.other).toBe(0)
  // A task at or under its estimate has no extra.
  expect(Object.values(taskExtra([run({ id: 'd1', task: 'd1', taken: 1, actual: 0.2 })], 'd1'))).toEqual([0, 0, 0, 0, 0])
})

/** `n` finished tasks of one session, each a task of its own that the next one replaced: a task `i` has `taken` 1, `stay` 1.2 and actual `ratios[i]`. */
const manyTasks = (ratios: number[], types: string[] = []): RunLine[] =>
  ratios.map((r, i) => run({ id: `t${i}`, task: `t${i}`, type: types[i] ?? 'feature', taken: 1, stay: 1.2, actual: r, at: ago(10 - i * 0.1), submittedAt: ago(10 - i * 0.1) }))

test('a task is finished when a later task began in its session, or after a day with no line; one with no estimate or from an old log is left out', async () => {
  const two = manyTasks([1, 1])
  expect(wholeTasks(two, NOW).map(t => t.task), 'the first was replaced, the second is old enough').toEqual(['t0', 't1'])
  // The latest task of a session, active in the last day, is not finished.
  const active = [...manyTasks([1]), run({ id: 'live', task: 'live', taken: 1, stay: 1, actual: 1 })]
  expect(wholeTasks(active, NOW).map(t => t.task), 'a task running now').toEqual(['t0'])
  expect(wholeTasks([run({ id: 'old', task: 'old', at: ago(40), submittedAt: ago(40) })], NOW), 'started over 30 days ago').toEqual([])
  expect(wholeTasks([...manyTasks([1]), run({ id: 'x', task: 'x', taken: 0, stay: 1, at: ago(9), submittedAt: ago(9) })], NOW).map(t => t.task), 'no estimate').toEqual(['t0'])
  expect(wholeTasks([run({ id: 'only', task: 'only', aborted: true, at: ago(5), submittedAt: ago(5) })], NOW), 'every prompt stopped: nothing to compare').toEqual([])
  expect(wholeTasks([run({ id: 'n1', task: undefined })], NOW), 'a run with no task id').toEqual([])
  // Another session's later task does not finish this one.
  const other = [run({ id: 'p1', task: 'p1', session: 'sA', at: ago(0.1), submittedAt: ago(0.1) }), run({ id: 'p2', task: 'p2', session: 'sB', at: ago(0.05), submittedAt: ago(0.05) })]
  expect(wholeTasks(other, NOW)).toEqual([])
})

test('Whole tasks shows with 5 finished tasks: the median ratio, the share over 1.5x and where its extra came from, tasks saved, and the median by type', async () => {
  // Ratios actual/estimated: 0.8, 1, 1.2, 2 (a keep-warm line of 0.5 and a helper inside), 3: median 1.2; two of five are over 1.5x.
  const lines = [
    ...manyTasks([0.8, 1, 1.2, 2, 3], ['feature', 'feature', 'debug', 'debug', 'review']),
    { at: ago(8), kind: 'warm', session: 's1', task: 't3', tier: 'opus', context: 80_000, overhead: 0.5 } as RunLine,
  ]
  const text = report(lines)
  const rows = sectionOf(text, 'WHOLE TASKS')
  expect(rows[0]).toMatch(/^Tasks finished +5$/)
  // The warm request makes t3's actual 2.5 and t4's stays 3: ratios 0.8, 1, 1.2, 2.5, 3.
  expect(rows[1]).toMatch(/^Cost vs estimate +median 1\.2x of the estimate$/)
  expect(rows[2]).toMatch(/^Over 1\.5x +2 of 5 tasks \(40%\)$/)
  // t3's extra is 1.5 (0.5 of it keep warm), t4's is 2 (all other): 0.5 / 3.5 = 14%, and 3 / 3.5 = 86%.
  expect(rows[3]).toMatch(/^Extra came from +retries\/rework 0%, helpers 0%, keep warm 14%, other 86%$/)
  // Staying would have cost 1.2 each (6 in all); the tasks cost 0.8+1+1.2+2.5+3 = 8.5: 2.5 more.
  expect(rows[4]).toMatch(/^Saved vs staying +-\$2\.50$/)
  expect(rows.slice(5).map(r => r.replace(/^Median by type +/, ''))).toEqual(['debug: 1.9x over 2 tasks', 'feature: 0.9x over 2 tasks', 'review: 3.0x over 1 task'])
  expect(titles(text)).toContain('WHOLE TASKS')
  expect(text.split('\n').filter(l => l.length > 80), 'no line past 80 characters').toEqual([])
  expect(rows.join('\n'), 'API billing carries no API-equivalent label here').not.toContain('API-equivalent')
})

test('Whole tasks on a subscription labels its dollar row API-equivalent, and the desktop app gets a code fence', async () => {
  const lines = manyTasks([0.5, 0.6, 0.7, 0.8, 0.9])
  const sub = sectionOf(report(lines, { subscription: true }), 'WHOLE TASKS')
  expect(sub[3], 'estimated 5, stay 6, actual 3.5').toMatch(/^Saved vs staying +~\$2\.50 \(API-equivalent\)$/)
  expect(sub[2], 'no task over 1.5x: no extra row').toMatch(/^Over 1\.5x +0 of 5 tasks \(0%\)$/)
  expect(sub.some(r => r.startsWith('Extra came from'))).toBe(false)
  const subOver = report(manyTasks([0.8, 1, 1.2, 2, 3], ['feature', 'feature', 'debug', 'debug', 'review']), { subscription: true })
  expect(sectionOf(subOver, 'WHOLE TASKS').some(r => r.startsWith('Extra came from')), 'an over-estimate task shows its extra').toBe(true)
  expect(subOver.split('\n').filter(l => l.length > 80), 'no line past 80 characters on a subscription either').toEqual([])
  const md = report(lines, { markdown: true }).split('\n')
  expect(md[md.indexOf('WHOLE TASKS') + 1]).toBe('```')
  // Only the five types with the most tasks show.
  const six = manyTasks([1, 1, 1, 1, 1, 1, 1], ['a', 'b', 'c', 'd', 'e', 'f', 'a'])
  const types = sectionOf(report(six), 'WHOLE TASKS').slice(4).map(r => r.replace(/^Median by type +/, '').split(':')[0])
  expect(types.length).toBe(5)
  expect(types[0], 'most tasks first').toBe('a')
})

test('with fewer than 5 finished tasks Whole tasks is one line saying how many more it needs, and nothing when nothing was rated', async () => {
  const text = report(manyTasks([1, 1, 1]))
  expect(text).not.toContain('WHOLE TASKS')
  expect(text.replace(/\s+/g, ' ')).toContain('Whole tasks: 3 finished tasks so far; this section needs 5, 2 more to go.')
  expect(report(manyTasks([1])).replace(/\s+/g, ' ')).toContain('Whole tasks: 1 finished task so far; this section needs 5, 4 more to go.')
  expect(report([]), 'an empty log has no such line').not.toContain('Whole tasks')
  expect(wholeTaskRows(manyTasks([1, 1, 1, 1]), NOW, false)).toEqual({ need: 'Whole tasks: 4 finished tasks so far; this section needs 5, 1 more to go.' })
})

// ---- Keep warm savings -------------------------------------------------------------

const ping = (x: Partial<RunLine> = {}): RunLine => ({ at: ago(0), kind: 'warm', session: 's1', task: 't1', tier: 'opus', context: 80_000, overhead: 0.3, warmRun: ago(1), ...x })
const kept = (saved: number, x: Partial<RunLine> = {}): RunLine => ({ at: ago(0), kind: 'warmSaved', session: 's1', task: 't1', tier: 'opus', context: 80_000, saved, ...x })

test('a keep-warm return counts its saving in totals, and a run never returned to stays pure cost', async () => {
  const t = totals([ping(), ping(), kept(0.63)])
  expect(t.returns).toBe(1)
  expect(Number(t.keptSaved.toFixed(5))).toBe(0.63)
  expect(Number((t.saved - t.overhead).toFixed(5)), '0.63 saved less two pings of 0.30').toBe(0.03)
  const never = totals([ping(), ping()])
  expect(never.returns).toBe(0)
  expect(Number((never.saved - never.overhead).toFixed(5)), 'no return: the pings are only cost').toBe(-0.6)
  // The saving is no run: it adds no rated prompt and no cost.
  expect(totals([kept(0.63)])).toMatchObject({ rated: 0, overhead: 0, spent: 0, returns: 1 })
})

test('the Keep warm line: runs, savings on returns, cost, and the net, in dollars with an API-equivalent label on a subscription', async () => {
  const lines = [ping({ warmRun: ago(3) }), ping({ warmRun: ago(3), overhead: 0.1 }), ping({ warmRun: ago(2), overhead: 0.2 }), ping({ warmRun: ago(1), overhead: 0.3 }), kept(1.2), kept(1), kept(1)]
  expect(keepWarmLine(lines, false), 'three runs (the pings share a run), cost 0.9, saved 3.2').toBe('Keep warm: 3 runs · saved ~$3.20 on 3 returns · cost ~$0.90 · net ~$2.30 saved')
  expect(keepWarmLine(lines, true)).toBe('Keep warm: 3 runs · saved ~$3.20 on 3 returns · cost ~$0.90 · net ~$2.30 saved (API-equivalent)')
  expect(keepWarmLine([ping({ overhead: 0.9 }), kept(0.5)], false)).toBe('Keep warm: 1 run · saved ~$0.50 on 1 return · cost ~$0.90 · net ~$0.40 more')
  expect(keepWarmLine([ping(), ping({ warmRun: ago(2) })], false), 'never returned to: no saving').toBe('Keep warm: 2 runs · saved nothing: no returns · cost ~$0.60 · net ~$0.60 more')
  expect(keepWarmLine([ping({ overhead: 0.5 }), kept(0.5)], false)).toBe('Keep warm: 1 run · saved ~$0.50 on 1 return · cost ~$0.50 · net about even')
  expect(keepWarmLine([run({})], false), 'no keep warm, no line').toBeUndefined()
  expect(keepWarmLine([ping({ warmRun: undefined, session: 'a' }), ping({ warmRun: undefined, session: 'a' }), ping({ warmRun: undefined, session: 'b' })], false)?.startsWith('Keep warm: 2 runs'), 'an older line with no run id counts by session').toBe(true)
})

test('the report shows the Keep warm row, and the saving and the session total include what it saved', async () => {
  const lines = [run({ change: 'lower', offered: 'lower', actual: 0.1, stay: 0.4, taken: 0.1 }), ping({ overhead: 0.1 }), kept(0.6)]
  const text = report(lines)
  expect(cells(text, 'Keep warm')).toEqual(['1 run: saved ~$0.60, cost ~$0.10, net ~$0.50 saved'])
  // 0.3 from the lowering, 0.6 from the return, less 0.1 of pings.
  expect(cells(text, 'Saved')).toEqual(['~$0.80', '~$0.80', '~$0.80', '~$0.80'])
  expect(text.split('\n')[1]).toBe('You saved ~$0.80 (~80% of your cost).')
  expect(sessionTotal(lines, 's1', false), 'the band\'s session total is the same figure').toBe('Session: ~$0.80 saved')
  expect(sessionTotal([ping({ overhead: 0.1 })], 's1', false), 'with no return it is only cost').toBe('Session: ~$0.10 more')
  expect(text.replace(/\s+/g, ' ')).toContain('The saving is after the cost of rating prompts and of keeping the cache warm ($0.10 in 30 days), and counts what keeping it warm saved when you came back to a warm cache.')
  expect(report([run({})]), 'no keep warm: no row and no note').not.toContain('Keep warm')
  expect(text.split('\n').filter(l => l.length > 80), 'no line past 80 characters').toEqual([])
  expect(cells(report(lines, { subscription: true }), 'Keep warm')).toEqual(['1 run: saved ~$0.60, cost ~$0.10, net ~$0.50 saved (API prices)'])
  expect(keepWarmLine(lines, false), 'the one-line form stays for other callers').toBe('Keep warm: 1 run · saved ~$0.60 on 1 return · cost ~$0.10 · net ~$0.50 saved')
})

test('the watch-only line sums what the planned routes would have saved against staying', async () => {
  const w = (would: RunLine['would'], stay: number, wouldTaken: number): RunLine => ({ at: new Date(NOW - 1000).toISOString(), kind: 'run', type: 'search', route: 'main', tier: 'opus', change: 'none', would, stay, wouldTaken })
  expect(watchLine([], false, false)).toBe('')
  expect(watchLine([], false, true)).toContain('Nothing to show yet')
  const line = watchLine([w('delegate-down', 1, 0.3), w('none', 0.5, 0.5), w('lower', 0.2, 0.1)], true, true)
  expect(line).toBe('Watch only: 3 prompts rated, 2 would have been changed, which would have saved ~$0.80 API-equivalent against staying (estimates; nothing was applied). Mode in /config turns rightsize on.')
})

// ---- Today and lifetime ------------------------------------------------------------------------------------------

const SAVER = (x: Partial<RunLine> = {}) => run({ change: 'lower', offered: 'lower', actual: 0.1, stay: 0.3, taken: 0.1, ...x })

test('today: runs since local midnight, in the same rows as the other periods', () => {
  const out = report([SAVER({ at: ago(0) }), SAVER({ at: ago(0) }), SAVER({ at: ago(2) })])
  expect(cells(out, 'Prompts rated'), 'the summary counts 30 days').toEqual(['3'])
  expect(cells(out, 'Saved'), 'today has two; the rest all three').toEqual(['~$0.40', '~$0.60', '~$0.60', '~$0.60'])
})

test('lifetime: the folded roll-up plus every line after it, and runs from before it are not counted twice', () => {
  const old = [SAVER({ at: ago(40) }), SAVER({ at: ago(35) })]
  const life = foldLifetime(undefined, old, NOW - 30 * 24 * 60 * 60 * 1000)
  expect(life?.t.rated).toBe(2)
  expect(life?.since).toBe(ago(40))
  // The logs still hold the old lines (not pruned yet): they are not added a second time.
  const out = report([...old, SAVER({ at: ago(1) })], { lifetime: life })
  expect(cells(out, 'Saved')?.at(-1)).toBe('~$0.60')
  // The logs are pruned: the figure keeps them.
  const pruned = report([SAVER({ at: ago(1) })], { lifetime: life })
  expect(cells(pruned, 'Saved')?.at(-1), 'two folded and one live').toBe('~$0.60')
  expect(cells(pruned, 'Saved')?.[2], 'the 30-day column holds only what the logs have').toBe('~$0.20')
})

test('lifetime: the footer gives the date it counts from', () => {
  const life = foldLifetime(undefined, [SAVER({ at: ago(50) })], NOW - 30 * 24 * 60 * 60 * 1000)
  const out = summary([SAVER({ at: ago(0) })], { lifetime: life }).replace(/\s+/g, ' ')
  expect(out).toMatch(/Lifetime counts from \d{4}-\d{2}-\d{2}\./)
})

test('lifetime with nothing in 30 days: the headline says so, and lifetime still shows', () => {
  const life = foldLifetime(undefined, [SAVER({ at: ago(50) })], NOW - 30 * 24 * 60 * 60 * 1000)
  const out = report([], { lifetime: life })
  expect(out.split('\n')[1]).toBe('Nothing rated in the last 30 days.')
  expect(cells(out, 'Saved')).toEqual(['–', '–', '–', '~$0.20'])
})

test('no lines and no roll-up: no Today or Lifetime table', () => {
  expect(report([])).not.toMatch(/Today\s+Lifetime/)
})

test('on a subscription the dollars are labelled API prices and window shares are not shown for lifetime', () => {
  const life = foldLifetime(undefined, [SAVER({ at: ago(40) })], NOW - 30 * 24 * 60 * 60 * 1000)
  const win = { before: { five_hour: 10 }, after: { five_hour: 12 }, durationMs: 60_000 }
  const out = report([SAVER({ at: ago(0), ...win })], { lifetime: life, subscription: true })
  expect(out).toContain('Value (API prices)')
  expect(cells(out, '5-hour windows')?.at(-1), 'no window figure for a roll-up').toBe('–')
})

test('on a subscription with no roll-up yet, lifetime window rows match 30 days: every lifetime line is still in the logs', () => {
  const win = { before: { five_hour: 10, seven_day: 4 }, after: { five_hour: 12, seven_day: 5 }, durationMs: 60_000 }
  const out = report([SAVER({ at: ago(0), ...win }), SAVER({ at: ago(3), ...win })], { subscription: true })
  const five = cells(out, '5-hour windows')
  expect(five?.at(-1), 'lifetime has a window figure').not.toBe('–')
  expect(five?.at(-1), 'and it is the 30-day one').toBe(five?.[2])
  expect(cells(out, 'Weekly limit')?.at(-1)).toBe(cells(out, 'Weekly limit')?.[2])
})

test('extra on hard prompts never shrinks over a longer period, even when older raises came out cheaper', () => {
  const costly = SAVER({ change: 'raise', offered: 'raise', actual: 0.3, stay: 0.1, taken: 0.2 })
  const cheap = SAVER({ change: 'raise', offered: 'raise', actual: 0.05, stay: 0.5, taken: 0.2 })
  const out = report([{ ...costly, at: ago(1) }, { ...cheap, at: ago(10) }, { ...cheap, at: ago(20) }])
  expect(cells(out, 'Extra on hard prompts')?.slice(1), '7 days, 30 days and lifetime').toEqual(['$0.20', '$0.20', '$0.20'])
})

test('folding: only lines at or before the cutoff and after the last fold, once; nothing to fold leaves it as it was', () => {
  const cutoff = NOW - 30 * 24 * 60 * 60 * 1000
  const a = foldLifetime(undefined, [SAVER({ at: ago(60) }), SAVER({ at: ago(5) })], cutoff)
  expect(a?.t.rated, 'the recent line waits').toBe(1)
  expect(foldLifetime(a, [SAVER({ at: ago(60) }), SAVER({ at: ago(5) })], cutoff), 'the same lines again fold nothing').toBe(a)
  const b = foldLifetime(a, [SAVER({ at: ago(60) }), SAVER({ at: ago(5) })], NOW)
  expect(b?.t.rated, 'the 5-day-old line is folded once the cutoff passes it').toBe(2)
  expect(foldLifetime(undefined, [], cutoff)).toBeUndefined()
})

test('a stored roll-up is read back as numbers only: a damaged one counts for nothing', () => {
  const life = foldLifetime(undefined, [SAVER({ at: ago(60) })], NOW)
  expect(parseLifetime(JSON.parse(JSON.stringify(life)))).toEqual(life)
  expect(parseLifetime(undefined)).toBeUndefined()
  expect(parseLifetime({ since: 'x', through: 'y', t: {} })).toBeUndefined()
  expect(parseLifetime({ since: ago(9), through: ago(1), t: { rated: 'many', saved: { a: 1 }, changed: { lower: 'x' } } })?.t.rated).toBe(0)
  expect(addTotals(life!.t, life!.t).rated).toBe(2)
})

test('trim section: tokens per feature, all time and 30 days, assumed marked; none without data', () => {
  const trim = { allTime: { tool_cleanup: { saves: 3, tokens: 12345, assumed: false }, browser_scale: { saves: 2, tokens: 1010, assumed: true } }, last30: { tool_cleanup: { saves: 1, tokens: 400, assumed: false } }, session: {} }
  const opts = { now: NOW, session: 's1', subscription: false, trim }
  const plain = buildReport([run({})], [], opts)
  expect(plain).toContain('TRIM SAVINGS (tokens, estimated)')
  expect(plain).toMatch(/Tool results cleaned\s+12\.3K\s+400/)
  expect(plain).toMatch(/Browser screenshots\s+1\.0K assumed\s+–/)
  expect(plain).toContain('"assumed" means a fixed estimate')
  const md = buildReport([run({})], [], { ...opts, markdown: true })
  expect(md).toContain('```')
  expect(md).toContain('12.3K')
  for (const none of [undefined, { allTime: {}, last30: {}, session: {} }]) expect(buildReport([run({})], [], { now: NOW, session: 's1', subscription: false, ...(none ? { trim: none } : {}) })).not.toContain('TRIM SAVINGS')
})
