// Checks rightsize's classic PreCompact hook (plugins/rightsize/hooks/precompact.py, ADR 0077):
//
//   node scripts/check-precompact.mjs
//
//   - A bare /compact and an automatic compact print COMPACT_TEXT, exactly as whatsnext.ts has it.
//   - Instructions given, a subagent's compaction, rightsize switched off and bad input print nothing.
//   - It always exits 0.
// HOME points at a temporary folder, so the person's switches and logs are not touched.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'rightsize', 'hooks')
const script = join(root, 'precompact.py')
const src = readFileSync(join(root, 'whatsnext.ts'), 'utf8')
const literal = src.match(/export const COMPACT_TEXT =\s*("(?:[^"\\\n]|\\.)*")/)
if (!literal) {
  console.error('- COMPACT_TEXT not found in whatsnext.ts as one double-quoted string')
  process.exit(1)
}
const TEXT = JSON.parse(literal[1])

const home = mkdtempSync(join(tmpdir(), 'rightsize-precompact-'))
const run = (input, env = {}) => spawnSync('python3', [script], { input, encoding: 'utf8', env: { ...process.env, HOME: home, ...env } })
const ev = (extra = {}) => JSON.stringify({ hook_event_name: 'PreCompact', session_id: 'check', ...extra })

const cases = [
  ['bare /compact', ev({ trigger: 'manual', custom_instructions: '' }), TEXT],
  ['only spaces', ev({ trigger: 'manual', custom_instructions: '  \n' }), TEXT],
  ['automatic compact', ev({ trigger: 'auto', custom_instructions: null }), TEXT],
  ['instructions given', ev({ trigger: 'manual', custom_instructions: 'keep the API notes' }), ''],
  ["a subagent's", ev({ trigger: 'auto', agent_id: 'a1' }), ''],
  ['bad input', 'not json', ''],
]
const failed = []
for (const [name, input, want] of cases) {
  const r = run(input)
  if (r.status !== 0 || r.stdout !== want) failed.push(`${name}: exit ${r.status}, printed ${JSON.stringify(r.stdout.slice(0, 60))}`)
}
mkdirSync(join(home, '.claude', 'mods'), { recursive: true })
writeFileSync(join(home, '.claude', 'mods', 'switches.json'), '{"rightsize": false}')
const offRun = run(ev({ trigger: 'manual', custom_instructions: '' }))
if (offRun.status !== 0 || offRun.stdout !== '') failed.push(`rightsize off: printed ${JSON.stringify(offRun.stdout.slice(0, 60))}`)
const logged = readFileSync(join(home, '.claude', 'mods-logs', 'rightsize', 'check', 'rightsize.log'), 'utf8')
if (!logged.includes("compact (manual): no instructions given; rightsize's handoff-style text used")) failed.push('no log line for a bare /compact')
rmSync(home, { recursive: true, force: true })

if (failed.length) {
  for (const f of failed) console.error(`- ${f}`)
  process.exit(1)
}
console.log(`precompact.py ok (${cases.length + 1} cases).`)
