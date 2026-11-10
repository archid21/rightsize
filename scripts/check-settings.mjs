// Checks that every setting in plugin.json (userConfig) is wired up everywhere it has to be:
//
//   node scripts/check-settings.mjs
//
// Plugin tests cannot read files (they run with no fs), so this is the check that can:
//   - plugin.json: each row is a string picker with a title, a description, a default and options. Mode is first, then Routing, Hand-offs, Ask before changing and Cache; the others are titled "Advanced · ...".
//   - hooks/settings.ts: each row has an entry with the same title, default and (when written out) options.
//   - hooks/register.tsx: each row has a `case '<key>'` in applyOption, the parse that applies it.
//   - docs/SETTINGS.md: each row has a `### <name>` heading (the title without "Advanced · ") whose first lines give its `Key:`. The root README.md links to this page and no longer lists the settings.
//     Every row but the five plain ones (Mode, Routing, Hand-offs, Ask before changing, Cache) is titled "Advanced · <name>" in /config; the page gives the name.
//   - plugins/rightsize/README.md: each row's title is in the `/config` list under "Commands and settings" (a bullet that opens with a bold title).
//   - hooks/register.*.test.ts: each row has a scenario that names its key.
//   - hooks/register.tsx: the web address written out at the $.http.fetch call (the directory wants a fixed address there) equal PRICING_URL (prices.ts), and is the only $.http.fetch call.
// It exits 1 and lists everything missing.

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const plugin = join(root, 'plugins', 'rightsize')
const read = path => readFileSync(path, 'utf8')

const manifest = JSON.parse(read(join(plugin, '.claude-plugin', 'plugin.json')))
const settings = read(join(plugin, 'hooks', 'settings.ts'))
const register = read(join(plugin, 'hooks', 'register.tsx'))
const test = readdirSync(join(plugin, 'hooks')).filter(f => /^register\..*\.test\.ts$/.test(f)).map(f => read(join(plugin, 'hooks', f))).join('\n')
const section = (text, from) => {
  const start = text.indexOf(from)
  if (start < 0) return ''
  const next = text.indexOf('\n## ', start + from.length)
  return text.slice(start, next < 0 ? undefined : next)
}
// The /config list: the bullets of that section that open with a bold title.
const configList = file =>
  section(read(file), '## Commands and settings')
    .split('\n')
    .filter(line => /^\s*- \*\*/.test(line))
    .join('\n')
// docs/SETTINGS.md: one `### <name>` section per row, which names its key.
const settingsDoc = read(join(root, 'docs', 'SETTINGS.md'))
const settingsDocRow = name => {
  const heading = `\n### ${name}\n`
  const start = settingsDoc.indexOf(heading)
  if (start < 0) return undefined
  const next = settingsDoc.indexOf('\n### ', start + heading.length)
  return settingsDoc.slice(start, next < 0 ? undefined : next)
}
const pluginConfig = configList(join(plugin, 'README.md'))

const problems = []
const fail = (key, what) => problems.push(`${key}: ${what}`)
const rows = Object.entries(manifest.userConfig ?? {})
if (rows.length === 0) problems.push('plugin.json declares no userConfig rows')
// /config has no row groups: the five plain rows come first, in this order (0.10.0 removed Profile and added Ask before
// changing), and every other row is titled "Advanced · ...".
const PLAIN = ['mode', 'routing', 'handOffs', 'askFirst', 'cache']
PLAIN.forEach((key, i) => {
  if (rows[i]?.[0] !== key) problems.push(`${key}: not row ${i + 1} of plugin.json (it is ${rows[i]?.[0]})`)
})
for (const [key, row] of rows) if (!PLAIN.includes(key) && !String(row.title).startsWith('Advanced · ')) fail(key, `title ${JSON.stringify(row.title)} does not start with "Advanced · "`)

// `  key: { title: 'T', options: ['a', 'b'], default: 'a' },` as written in settings.ts.
const entry = key => new RegExp(`^  ${key}: \\{(.*)\\},?$`, 'm').exec(settings)?.[1]

for (const [key, row] of rows) {
  if (row.type !== 'string') fail(key, `type is ${JSON.stringify(row.type)}, not "string"`)
  if (!row.title) fail(key, 'no title')
  if (!row.description) fail(key, 'no description')
  if (!Array.isArray(row.options) || row.options.length < 2) fail(key, 'no options to pick from')
  else if (!row.options.includes(row.default)) fail(key, `default ${JSON.stringify(row.default)} is not one of its options`)

  const line = entry(key)
  if (line === undefined) fail(key, 'no entry in hooks/settings.ts')
  else {
    const title = /title: ('[^']*'|"[^"]*")/.exec(line)?.[1]
    if (title?.slice(1, -1) !== row.title) fail(key, `title in settings.ts is ${title}, plugin.json says ${JSON.stringify(row.title)}`)
    const dflt = /default: ('[^']*'|"[^"]*"|NOT_SET)/.exec(line)?.[1]
    const written = dflt === 'NOT_SET' ? 'not set' : dflt?.slice(1, -1)
    if (written !== row.default) fail(key, `default in settings.ts is ${dflt}, plugin.json says ${JSON.stringify(row.default)}`)
    const options = /options: \[([^\]]*)\]/.exec(line)?.[1]
    if (options !== undefined) {
      const list = [...options.matchAll(/'([^']*)'|"([^"]*)"/g)].map(m => m[1] ?? m[2])
      if (JSON.stringify(list) !== JSON.stringify(row.options)) fail(key, `options in settings.ts are ${JSON.stringify(list)}, plugin.json says ${JSON.stringify(row.options)}`)
    }
  }
  if (!new RegExp(`case '${key}':`).test(register)) fail(key, "no `case '" + key + "':` in hooks/register.tsx (the parse)")
  const named = row.title.replace(/^Advanced · /, '')
  const docRow = settingsDocRow(named)
  if (docRow === undefined) fail(key, `no "### ${named}" section in docs/SETTINGS.md`)
  else if (!docRow.includes(`- Key: \`${key}\``)) fail(key, `the "### ${named}" section of docs/SETTINGS.md does not give \`Key: ${key}\``)
  if (!pluginConfig.includes(`**${named}**`)) fail(key, `no **${named}** in the /config list of plugins/rightsize/README.md`)
  if (!new RegExp(`key: '${key}'`).test(test)) fail(key, "no scenario with `key: '" + key + "'` in hooks/register.*.test.ts")
}

// The one address the directory reads at the $.http.fetch call must be the same text as the exported constant, and nothing else is fetched.
const priceUrl = /export const PRICING_URL = '([^']+)'/.exec(read(join(plugin, 'hooks', 'prices.ts')))?.[1]
if (!priceUrl) problems.push('PRICING_URL: not found in hooks/prices.ts')
else if (!register.includes(`$.http.fetch('${priceUrl}'`)) problems.push(`PRICING_URL: hooks/register.tsx has no $.http.fetch('${priceUrl}'...) with the address written out`)
const fetches = register.match(/\$\.http\.fetch\(/g)?.length ?? 0
if (fetches !== 1) problems.push(`hooks/register.tsx calls $.http.fetch ${fetches} times; rightsize fetches only the pricing page (docs/PRIVACY.md says nothing else is sent)`)

// The other direction: a row in settings.ts that plugin.json does not declare.
const from = settings.indexOf('export const SETTINGS = {')
const table = settings.slice(from, settings.indexOf('} as const satisfies', from))
for (const m of table.matchAll(/^  (\w+): \{/gm)) if (!(m[1] in (manifest.userConfig ?? {}))) fail(m[1], 'in hooks/settings.ts but not in plugin.json')

if (problems.length) {
  console.error(`${problems.length} problem(s) with the settings:\n${problems.map(p => `  - ${p}`).join('\n')}`)
  process.exit(1)
}
console.log(`ok: ${rows.length} settings, each in plugin.json, settings.ts, register.tsx, docs/SETTINGS.md, the plugin README and the tests`)
