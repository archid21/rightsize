// Checks that docs/FEATURES.md is current with the release:
//
//   node scripts/check-features.mjs
//
//   - Its `Current release:` line equals the version in plugins/rightsize/.claude-plugin/plugin.json.
//   - Every feature table row has four filled cells: Feature, How it works, Value, Since.
//   - Some row's Since names the current minor release (for example 0.10 for 0.10.1).
//   - No Since says `Unreleased` once the release is out: the first `## ` heading of CHANGELOG.md
//     must say "(unreleased)" while any row does.
// It exits 1 and lists everything wrong.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = path => readFileSync(join(root, path), 'utf8')

const version = JSON.parse(read('plugins/rightsize/.claude-plugin/plugin.json')).version
const text = read('docs/FEATURES.md')
const changelogTop = read('CHANGELOG.md').split('\n').find(line => line.startsWith('## ')) ?? ''
const problems = []

const current = text.match(/^Current release: (\S+)$/m)
if (!current) problems.push("docs/FEATURES.md needs a 'Current release: X.Y.Z' line")
else if (current[1] !== version)
  problems.push(`docs/FEATURES.md says Current release: ${current[1]}, but plugin.json says ${version}`)

const rows = text
  .split('\n')
  .filter(line => line.startsWith('|') && !line.startsWith('|---') && !line.startsWith('| Feature |'))
  .map(line => line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim()))

for (const cells of rows)
  if (cells.length !== 4 || cells.some(cell => !cell))
    problems.push(`row needs four filled cells: | ${cells.join(' | ')} |`)

const since = rows.map(cells => cells[3] ?? '')
const minor = version.split('.').slice(0, 2).join('.')
if (!since.some(s => s === minor || s.startsWith(`${minor} `) || s.startsWith(`${minor}.`)))
  problems.push(`no row has Since ${minor}: give this release's features Since ${minor}`)

const unreleased = rows.filter(cells => /Unreleased/.test(cells[3] ?? ''))
if (unreleased.length && !/\(unreleased\)/i.test(changelogTop))
  problems.push(
    `CHANGELOG.md's latest release is out (${changelogTop.replace('## ', '')}), but these rows still say Unreleased: ` +
      unreleased.map(cells => cells[0]).join(', '),
  )

if (problems.length) {
  console.log(problems.map(p => `- ${p}`).join('\n'))
  process.exit(1)
}
console.log(`docs/FEATURES.md is current with ${version} (${rows.length} features).`)
