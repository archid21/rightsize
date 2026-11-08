// Offline eval of the rater's step guesses for hand-offs: real step counts, and agentpace's public data as a sanity range.
//
//   node scripts/eval-steps.mjs [--logs <dir>] [--json]
//
// Reads rightsize's own run logs (default ~/.claude/mods-logs: <dir>/rightsize/<session>/runs.jsonl, and the older
// <dir>/rightsize-runs.jsonl). It prints its report to stdout and writes no file: run logs are private and stay out of the repo.
// For each hand-off (a `run` line with route "delegate:<tier>" and at least one helper of kind "handoff") it takes
//   rated  = the rater's `steps` guess for the prompt (rate.ts clamps it to 1..200),
//   actual = the sum over the line's handoff helpers of their `calls` (tool calls, from 0.8), when every one of them has
//            `calls`; otherwise the sum of their `steps` (model requests) for the whole hand-off. Lines from before 0.8
//            have no `calls`, so they fall back to requests. The header says how many hand-offs used each.
// Skipped: lines that do not parse, aborted runs, runs with no handoff helper, a route that names no known tier, and repeats of one run id.
// Moved helpers (`subagent` lines, and helpers of kind "moved") are skipped too: their `steps` is actual, but the rater's guess
// is for the whole prompt, which the helper does only a slice of, and the subagent line does not carry it (register.tsx finishSubagent).
// Per tier (haiku, sonnet, opus, fable) and overall it reports:
//   - n, median rated, median actual;
//   - |ln(actual / rated)| median and p90, and the bias, the median of ln(actual / rated) (positive: the rater guesses too low);
//     both numbers are floored at 1 first. Also for rated ** (1 + g * 0.8) with g in 0, -0.1 ... -0.4 (steps.ts: hand-offs take 0.8 of g), so the best g shows;
//   - the share of actual step counts above agentpace's p90 for the tier, and below its p25 (scripts/data/agentpace-steps.json; no haiku cell);
//   - median rated against agentpace's median for the tier.
// Quantile method: upper nearest-rank, sorted[floor(p * n)] capped at the last value, for every median and percentile here.
// It is the method that gives agentpace's figures in the table (scripts/build-agentpace-steps.mjs).
// With no hand-offs it says so and exits 0. --json prints the same numbers as JSON.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const TIERS = ['haiku', 'sonnet', 'opus', 'fable']
export const GS = [0, -0.1, -0.2, -0.3, -0.4]
/** The share of g a hand-off's own steps take (HANDOFF_SHARE in plugins/rightsize/hooks/steps.ts). */
export const HANDOFF_SHARE = 0.8

/** Upper nearest-rank: sorted[floor(p * n)], capped at the last value. Undefined for no values. */
export function quantile(values, p) {
  if (!values.length) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
}
export const median = values => quantile(values, 0.5)

/** ln(actual / rated), both floored at 1. Positive: the guess was too low. */
export const lnRatio = (actual, rated) => Math.log(Math.max(actual, 1) / Math.max(rated, 1))

/** The guess shrunk the way a hand-off's estimate shrinks it: rated ** (1 + g * 0.8). */
export const shrink = (rated, g) => rated ** (1 + g * HANDOFF_SHARE)

/** Error of the rows' guesses shrunk with g: median and p90 of |ln|, and the bias (median of ln). */
export function errorStats(rows, g = 0) {
  const ln = rows.map(r => lnRatio(r.actual, shrink(r.rated, g)))
  return {
    g,
    medianAbs: median(ln.map(Math.abs)),
    p90Abs: quantile(ln.map(Math.abs), 0.9),
    bias: median(ln),
  }
}

/** The g (of the list) with the lowest median |ln| error; the first wins a tie. */
export const bestG = (stats) => stats.length ? stats.reduce((best, s) => (s.medianAbs < best.medianAbs ? s : best)).g : undefined

/** The share of rows with actual above the reference p90, and below its p25. Undefined with no reference. */
export function shares(rows, ref) {
  if (!ref || !rows.length) return undefined
  return {
    aboveP90: rows.filter(r => r.actual > ref.p90).length / rows.length,
    belowP25: rows.filter(r => r.actual < ref.p25).length / rows.length,
  }
}

const isCount = x => typeof x === 'number' && Number.isFinite(x)
const isCallCount = x => Number.isInteger(x) && x >= 0

/**
 * One hand-off from one parsed line: { tier, rated, actual, key }, or undefined when the line is not a usable hand-off
 * (not a run line, aborted, no handoff helper, no known tier in the route, no usable step guess).
 */
export function extractHandoff(line) {
  if (!line || typeof line !== 'object' || line.kind !== 'run' || line.aborted === true) return undefined
  const helpers = Array.isArray(line.helpers) ? line.helpers.filter(h => h && h.kind === 'handoff') : []
  if (!helpers.length) return undefined
  const route = typeof line.route === 'string' ? line.route : ''
  if (!route.startsWith('delegate:')) return undefined
  const tier = TIERS.find(t => route.slice('delegate:'.length).toLowerCase().includes(t))
  if (!tier || !isCount(line.steps) || line.steps <= 0) return undefined
  // Tool calls only when every handoff helper has them; mixing calls and requests in one sum would skew the error.
  const byCalls = helpers.every(h => isCallCount(h.calls))
  const actual = helpers.reduce((n, h) => {
    const v = byCalls ? h.calls : h.steps
    return n + (isCount(v) && v > 0 ? v : 0)
  }, 0)
  const key = typeof line.id === 'string' ? `${line.session ?? ''}|${line.id}` : undefined
  return { tier, rated: line.steps, actual, measure: byCalls ? 'calls' : 'steps', key }
}

/** How many hand-offs had their actual counted in tool calls, and how many fell back to model requests. */
export function countMeasures(rows) {
  return {
    calls: rows.filter(r => r.measure === 'calls').length,
    requests: rows.filter(r => r.measure === 'steps').length,
  }
}

/** Parse JSONL text; a line that does not parse is counted, not thrown. */
export function parseLines(text) {
  const lines = []
  let bad = 0
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue
    try { lines.push(JSON.parse(raw)) } catch { bad += 1 }
  }
  return { lines, bad }
}

/** Hand-offs from parsed lines, each run id once. Also counts the moved-helper lines that were skipped. */
export function collectHandoffs(lines) {
  const seen = new Set()
  const rows = []
  let moved = 0
  for (const line of lines) {
    if (line?.kind === 'subagent') moved += 1
    const row = extractHandoff(line)
    if (!row) continue
    if (row.key) {
      if (seen.has(row.key)) continue
      seen.add(row.key)
    }
    rows.push(row)
  }
  return { rows, moved }
}

/** Everything the report says about one group of hand-offs; ref is the agentpace cell for the tier (none for all tiers). */
export function summarize(rows, ref) {
  const byG = GS.map(g => errorStats(rows, g))
  return {
    n: rows.length,
    medianRated: median(rows.map(r => r.rated)),
    medianActual: median(rows.map(r => r.actual)),
    errors: byG,
    bestG: bestG(byG),
    reference: ref ? { n: ref.n, p25: ref.p25, p50: ref.p50, p75: ref.p75, p90: ref.p90 } : null,
    vsReference: shares(rows, ref) ?? null,
    medianRatedMinusReference: ref && rows.length ? median(rows.map(r => r.rated)) - ref.p50 : null,
  }
}

export function evaluate(rows, table) {
  const out = { tiers: {}, overall: undefined }
  for (const tier of TIERS) {
    const mine = rows.filter(r => r.tier === tier)
    if (mine.length) out.tiers[tier] = summarize(mine, table?.models?.[tier])
  }
  out.overall = summarize(rows, undefined)
  // Overall: each hand-off is held against the reference of its own tier, where there is one.
  const covered = rows.filter(r => table?.models?.[r.tier])
  const above = covered.filter(r => r.actual > table.models[r.tier].p90).length
  const below = covered.filter(r => r.actual < table.models[r.tier].p25).length
  out.overall.vsReference = covered.length ? { aboveP90: above / covered.length, belowP25: below / covered.length, covered: covered.length } : null
  return out
}

/** Every runs.jsonl under <dir>/rightsize/<session>/, then the older <dir>/rightsize-runs.jsonl. */
export function logFiles(dir) {
  const files = []
  const sessions = join(dir, 'rightsize')
  if (existsSync(sessions)) {
    for (const entry of readdirSync(sessions, { withFileTypes: true })) {
      const file = join(sessions, entry.name, 'runs.jsonl')
      if (entry.isDirectory() && existsSync(file)) files.push(file)
    }
  }
  const legacy = join(dir, 'rightsize-runs.jsonl')
  if (existsSync(legacy)) files.push(legacy)
  return files
}

const CAVEAT = 'Caveat: agentpace is one person\'s subagent runs, labeled with task kinds that are not rightsize\'s types, and a subagent run is not the same unit as a whole hand-off. Read its quantiles as a sanity range for how many tool calls a model\'s runs take, not as ground truth. The bias and error numbers against the real step counts are the evidence; the agentpace shares only show whether the real counts, or the guesses, fall outside what another workflow sees.'

const f2 = x => (x === undefined || x === null ? '-' : Number(x).toFixed(2))
const pct = x => (x === undefined || x === null ? '-' : `${(x * 100).toFixed(0)}%`)

function section(name, s) {
  const lines = [`${name}: n=${s.n}   median rated ${s.medianRated}   median actual ${s.medianActual}`]
  lines.push('  g       median |ln|   p90 |ln|   bias (median ln)')
  for (const e of s.errors) lines.push(`  ${String(e.g.toFixed(1)).padEnd(6)}  ${f2(e.medianAbs).padStart(11)}   ${f2(e.p90Abs).padStart(8)}   ${f2(e.bias).padStart(16)}${e.g === s.bestG ? '   <- best' : ''}`)
  if (s.reference) {
    const r = s.reference
    lines.push(`  agentpace ${name} (n=${r.n}): p25 ${r.p25}, median ${r.p50}, p90 ${r.p90}`)
    lines.push(`  actual above p90: ${pct(s.vsReference?.aboveP90)}   actual below p25: ${pct(s.vsReference?.belowP25)}   median rated ${s.medianRated} vs agentpace median ${r.p50}`)
  } else if (name === 'overall') {
    const v = s.vsReference
    lines.push(v ? `  against each tier's own agentpace cell (n=${v.covered}): actual above p90 ${pct(v.aboveP90)}, below p25 ${pct(v.belowP25)}` : '  agentpace: no reference')
  } else {
    lines.push('  agentpace: no reference')
  }
  return lines.join('\n')
}

export function render(result, info) {
  const m = info.measured
  const parts = [`Hand-offs: ${result.overall.n} (from ${info.files} log files; skipped ${info.bad} unparseable lines and ${info.moved} moved-helper lines); actual = tool calls for ${m.calls}, requests for ${m.requests}`, '']
  for (const tier of TIERS) if (result.tiers[tier]) parts.push(section(tier, result.tiers[tier]), '')
  parts.push(section('overall', result.overall), '', CAVEAT)
  return parts.join('\n')
}

function main(argv) {
  let logs = join(homedir(), '.claude', 'mods-logs')
  let json = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') json = true
    else if (argv[i] === '--logs' && argv[i + 1]) logs = argv[++i]
    else { console.error('usage: node scripts/eval-steps.mjs [--logs <dir>] [--json]'); return 2 }
  }
  const here = dirname(fileURLToPath(import.meta.url))
  const table = JSON.parse(readFileSync(join(here, 'data', 'agentpace-steps.json'), 'utf8'))
  const files = logFiles(logs)
  let bad = 0
  const lines = []
  for (const file of files) {
    const parsed = parseLines(readFileSync(file, 'utf8'))
    bad += parsed.bad
    lines.push(...parsed.lines)
  }
  const { rows, moved } = collectHandoffs(lines)
  const info = { files: files.length, bad, moved, measured: countMeasures(rows) }
  if (!rows.length) {
    const message = `No hand-offs found in ${logs} (${files.length} log files read).`
    console.log(json ? JSON.stringify({ handoffs: 0, message }) : message)
    return 0
  }
  const result = evaluate(rows, table)
  console.log(json
    ? JSON.stringify({ ...info, handoffs: rows.length, ...result, quantile: table.quantile, agentpace: { source: table.source, commit: table.commit, license: table.license }, caveat: CAVEAT }, null, 2)
    : render(result, info))
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main(process.argv.slice(2))
