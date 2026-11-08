// Builds scripts/data/agentpace-steps.json from a local clone of agentpace's public data:
//
//   node scripts/build-agentpace-steps.mjs <path-to-agentpace-clone> [commit]   (writes the table to stdout)
//   node scripts/build-agentpace-steps.mjs <clone> > scripts/data/agentpace-steps.json
//
// Reads only <clone>/data/runs/*.jsonl, as data. It does not run anything from the clone. Keeps rows with
// harness "claude-code" and outcome "completed"; the model is matched case-insensitively by substring
// (sonnet, opus, fable, haiku). Per model, and per (model, task_kind), it keeps n and the 25th, 50th,
// 75th and 90th percentile of tool_calls, and drops cells under 20 runs.
// Percentile: the upper nearest-rank, sorted[floor(p * n)] (capped at the last value). It is the same
// function eval-steps.mjs uses, and it gives the figures agentpace's own report shows.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { quantile } from './eval-steps.mjs'

const COMMIT = '1fa53286ae9b4c09f2e8732420d2e9a07747e95e'
const MODELS = ['sonnet', 'opus', 'fable', 'haiku']
const MIN_N = 20

const clone = process.argv[2]
if (!clone) {
  console.error('usage: node scripts/build-agentpace-steps.mjs <path-to-agentpace-clone> [commit]')
  process.exit(2)
}
const dir = join(clone, 'data', 'runs')
const rows = []
for (const file of readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort()) {
  for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
    if (!line.trim()) continue
    try { rows.push(JSON.parse(line)) } catch { /* skip a broken line */ }
  }
}

const groups = new Map()
for (const r of rows) {
  if (r?.harness !== 'claude-code' || r.outcome !== 'completed' || !Number.isFinite(r.tool_calls)) continue
  const model = MODELS.find(m => String(r.model).toLowerCase().includes(m))
  if (!model) continue
  for (const key of [model, `${model}/${r.task_kind}`]) {
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(r.tool_calls)
  }
}

const cell = values => ({ n: values.length, p25: quantile(values, 0.25), p50: quantile(values, 0.5), p75: quantile(values, 0.75), p90: quantile(values, 0.9) })
const models = {}
const cells = {}
for (const key of [...groups.keys()].sort()) {
  const values = groups.get(key)
  if (values.length < MIN_N) continue
  ;(key.includes('/') ? cells : models)[key] = cell(values)
}

console.log(JSON.stringify({
  source: 'https://github.com/mohamedzhioua/agentpace',
  commit: process.argv[3] ?? COMMIT,
  license: { data: 'CC0-1.0', code: 'MIT' },
  credit: 'Subagent run data from agentpace by Mohamed Zhioua (https://github.com/mohamedzhioua/agentpace), released under CC0-1.0. This file holds only percentiles of tool_calls computed from it.',
  filter: 'harness=claude-code, outcome=completed; model matched by substring; cells with n < 20 dropped',
  quantile: 'upper nearest-rank: sorted[floor(p * n)], capped at the last value',
  models,
  cells,
}, null, 2))
