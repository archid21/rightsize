import { expect, test } from 'claude-code/testing'
import { accuracyRows, type RunLine, buildReport, counterfactual, fixedBlock, parseLines, problems, shareMessage, tieCounts, totals } from './report'
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
const SUB_FOOT = 'Dollar amounts are what the same use would cost on the API. You only pay for your subscription.'
const sectionOf = (text: string, title: string) => {
  const out = text.split('\n')
  const at = out.findIndex(l => l.startsWith(title))
  return out.slice(at + 1, out.findIndex((l, i) => i > at && l === '')).map(l => l.trim())
}

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
  expect(out[1]).toMatch(/^Saved ~[\d.]+% of your 5-hour window \(~\d+ min\) in the last 30 days\.$/)
  expect(out[2], 'the restart note is near the top').toMatch(/^Cost measurement restarted on 2026-10-0\d\.$/)
  expect(titles(text)).toEqual(['FIXED CONTEXT', 'ACCURACY', 'NOT COUNTED AS SAVINGS', 'NEXT STEPS'])
  const foot = out.indexOf('Estimated: actual cost vs staying at your own model and effort.')
  expect(foot, 'the footer follows the last section').toBeGreaterThan(out.indexOf('NEXT STEPS'))
  expect(out[foot + 1]).toMatch(/^Total saved is after the cost of rating prompts with Haiku \(\$[\d.]+ in 30 days\)\.$/)
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
  // 2% of the window for $1 over 2 minutes: $0.49 saved is ~1% and about 1 minute; the old session's rating calls take it to $0.44 in 30 days.
  expect(cells(sub, '5-hour window saved')).toEqual(['~1.0%', '~1.0%', '~0.9%'])
  expect(cells(sub, 'Share of cost saved')).toEqual(['~33%', '~33%', '~27%'])
  expect(sub, 'the rating cost is in the footer').toContain('Total saved is after the cost of rating prompts with Haiku ($0.06 in 30 days).')
  expect(cells(sub, 'Total saved')).toEqual(['~$0.49', '~$0.49', '~$0.44'])
  expect(sub.split('\n')[1], 'a subscriber reads the window first').toBe('Saved ~0.9% of your 5-hour window (~1 min) in the last 30 days.')
  expect(sub.split('\n').slice(-2).join(' ')).toBe(SUB_FOOT)
  const api = report(lines)
  expect(api.split('\n')[1], 'an API user reads dollars').toBe('Saved ~$0.44 (~27%) in the last 30 days.')
  expect(cells(api, 'Share of cost saved')).toEqual(['~33%', '~33%', '~27%'])
  expect(api, 'no window rows and no API-equivalent note on the API').not.toMatch(/5-hour|API-equivalent/)
  const worse = report([run({ change: 'none', overhead: 0.03 })])
  expect(worse.split('\n')[1]).toBe('Cost ~$0.03 more than it saved in the last 30 days.')
  expect(cells(worse, 'Total saved')).toEqual(['-$0.03', '-$0.03', '-$0.03'])
  const worseSub = report([run({ change: 'none', overhead: 0.03 })], { subscription: true })
  expect(worseSub.split('\n')[1], 'no window measured yet: the share alone').toBe('Used more than it saved in the last 30 days (~$0.03 more, API-equivalent).')
  expect(cells(worseSub, 'Share of cost saved')).toEqual(['–', '–', '–'])
  expect(report([run({ change: 'none' })]).split('\n')[1]).toBe('About even in the last 30 days: savings and rating calls cancel out.')
})

test('a window used more than staying would have shows as a negative share', async () => {
  const lines = [run({ change: 'raise', actual: 0.3, stay: 0.1, taken: 0.2, overhead: 0.5, durationMs: 60_000, before: { five_hour: 10 }, after: { five_hour: 12 } })]
  const text = report(lines, { subscription: true })
  expect(text.split('\n')[1]).toMatch(/^Used ~[\d.]+% more of your 5-hour window than staying would have in the last 30 days\.$/)
  expect(cells(text, '5-hour window saved')?.[0]).toMatch(/^-[\d.]+%$/)
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
  expect(cells(busy, 'Extra spent on harder prompts')).toEqual(['$0.15', '$0.15', '$0.15'])
  expect(busy, 'the footer says what the extra is').toContain("It isn't taken off Total saved.")
  expect(text, 'no extra: no footer line for it').not.toContain('Extra spent')
})

test('savings lead the table, before what rightsize did', async () => {
  const labels = report(month(), { subscription: true }).split('\n').filter(l => /^ {2}\S/.test(l)).map(l => l.trim().split(/ {2,}/)[0])
  expect(labels[0]).toBe('Total saved')
  expect(labels.indexOf('Prompts rated')).toBeGreaterThan(labels.indexOf('Share of cost saved'))
  const windowed = [
    run({ change: 'lower', offered: 'lower', actual: 0.5, stay: 1, taken: 0.5, overhead: 0.01, durationMs: 60_000, before: { five_hour: 10 }, after: { five_hour: 11 } }),
    run({ change: 'none', actual: 0.5, durationMs: 60_000, before: { five_hour: 11 }, after: { five_hour: 12 } }),
  ]
  expect(report(windowed, { subscription: true }).split('\n').filter(l => /^ {2}\S/.test(l)).map(l => l.trim().split(/ {2,}/)[0]).slice(0, 2)).toEqual(['Total saved', '5-hour window saved'])
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
