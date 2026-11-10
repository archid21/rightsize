import type { RightsizeTier as Tier } from '../types'
import { NEWEST, TIERS, TIER_NAME, versionKey, versionName } from './cost'

// The price check: read Anthropic's pricing page, find the four models' rows,
// and say what differs from prices.json. Pure functions, no engine calls.

export const PRICING_URL = 'https://platform.claude.com/docs/en/about-claude/pricing.md'
/** Days between automatic checks. */
export const CHECK_DAYS = 30

export type PageRow = { input: number; cacheWrite5m: number; cacheWrite1h: number; cacheRead: number; output: number }
/** `versions`: older versions' rows by `versionKey` (ADR 0031). */
export type PageRows = Partial<Record<Tier, PageRow>> & { haikuOver100k?: PageRow; versions?: Record<string, PageRow> }

/** How many of the four families the page gave a row for. */
export const familiesFound = (page: PageRows) => TIERS.filter(t => page[t]).length

/** "Claude Opus 4.8", "Claude Opus 4 ([retired, …])": an older version's row name, as its family and version. */
const VERSION_ROW = /^Claude (Haiku|Sonnet|Opus|Fable) (\d{1,2})(?:\.(\d{1,2}))?(?:\s*\(.*)?$/

// The page's model table names each model like this. Haiku's first row is the
// up-to-100K-tokens price, the one the mod uses.
const ROW_NAME = Object.fromEntries(TIERS.map(t => [t, `Claude ${versionName(t, NEWEST[t])}`])) as Record<Tier, string>
const FIELDS = ['input', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead', 'output'] as const

const dollarsIn = (cell: string) => {
  const m = /\$\s*([\d.]+)/.exec(cell)
  return m ? Number(m[1]) : Number.NaN
}

// The first table row per model that holds all five prices (base input, 5m and
// 1h cache writes, cache hits, output). Later tables (batch, fast mode) hold fewer.
export function parsePricingPage(md: string): PageRows {
  const out: PageRows = {}
  for (const line of md.split('\n')) {
    if (!line.trim().startsWith('|')) continue
    const cells = line.split('|').slice(1, -1).map(c => c.trim())
    if (cells.length !== 6) continue
    const tier = TIERS.find(t => cells[0] === ROW_NAME[t] || cells[0]?.startsWith(`${ROW_NAME[t]} (`))
    const older = tier ? undefined : VERSION_ROW.exec(cells[0] ?? '')
    if (!tier && !older) continue
    const over = cells[0]?.includes('over 100,000') ?? false
    const values = cells.slice(1).map(dollarsIn)
    if (values.some(v => !Number.isFinite(v) || v <= 0)) continue
    const row = Object.fromEntries(FIELDS.map((f, i) => [f, values[i] as number])) as PageRow
    // Output always costs more than input and a cache hit less: anything else is a misread.
    if (row.output <= row.input || row.cacheRead >= row.input) continue
    if (tier) {
      if (over && tier !== 'haiku') continue
      if (over ? out.haikuOver100k : out[tier]) continue
      if (over) out.haikuOver100k = row
      else out[tier] = row
      continue
    }
    // An older version: its first row with all five prices; a second, long-prompt row is not read.
    if (over || !older) continue
    const t = (older[1] as string).toLowerCase() as Tier
    const key = versionKey(t, [Number(older[2]), Number(older[3] ?? 0)])
    out.versions ??= {}
    out.versions[key] ??= row
  }
  return out
}

type FileJson = { source?: unknown; models?: Record<string, Record<string, unknown> | undefined>; versions?: Record<string, Record<string, unknown> | undefined>; [k: string]: unknown }

/** "Opus 4.8" from `claude-opus-4-8`. */
const keyName = (key: string) => {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(key)
  const t = m?.[1] as Tier | undefined
  return m && t && TIERS.includes(t) ? `${TIER_NAME[t]} ${m[2]}${m[3] ? `.${m[3]}` : ''}` : key
}

const LABEL: Record<(typeof FIELDS)[number], string> = {
  input: 'input',
  cacheWrite5m: '5-minute cache write',
  cacheWrite1h: '1-hour cache write',
  cacheRead: 'cache read',
  output: 'output',
}
const NAME = Object.fromEntries(TIERS.map(t => [t, versionName(t, NEWEST[t])])) as Record<Tier, string>
const fmt = (v: unknown) => (typeof v === 'number' ? `$${v}` : 'unset')

/** "Sonnet 5.5 cache read: $0.2 → $0.1", one line per price that differs. */
export function diffPrices(fileText: string, page: PageRows): string[] {
  let json: FileJson = {}
  try {
    json = JSON.parse(fileText) as FileJson
  } catch {
    json = {}
  }
  const changes: string[] = []
  for (const t of TIERS) {
    const row = page[t]
    if (!row) continue
    const have = json.models?.[t] ?? {}
    for (const f of FIELDS) if (have[f] !== row[f]) changes.push(`${NAME[t]} ${LABEL[f]}: ${fmt(have[f])} → $${row[f]}`)
  }
  const long = page.haikuOver100k
  if (long) {
    const have = (json.models?.haiku?.over100k ?? {}) as Record<string, unknown>
    for (const f of FIELDS) if (have[f] !== long[f]) changes.push(`Haiku 5.5 ${LABEL[f]} over 100K tokens: ${fmt(have[f])} → $${long[f]}`)
  }
  // Older versions (ADR 0031): new ones in one line, changed prices one line each. A version the page no longer lists keeps its row.
  const added: string[] = []
  for (const [key, row] of Object.entries(page.versions ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const have = json.versions?.[key]
    if (!have) {
      added.push(keyName(key))
      continue
    }
    for (const f of FIELDS) if (have[f] !== row[f]) changes.push(`${keyName(key)} ${LABEL[f]}: ${fmt(have[f])} → $${row[f]}`)
  }
  if (added.length) changes.push(`prices for ${added.join(', ')} added`)
  return changes
}

/** prices.json with the page's prices written in, everything else kept. */
export function applyPrices(fileText: string, page: PageRows, date: string): string {
  let json: FileJson = {}
  try {
    json = JSON.parse(fileText) as FileJson
  } catch {
    json = {}
  }
  const models: Record<string, Record<string, unknown>> = { ...(json.models ?? {}) } as Record<string, Record<string, unknown>>
  for (const t of TIERS) {
    const row = page[t]
    if (row) models[t] = { ...(models[t] ?? {}), ...row }
  }
  if (page.haikuOver100k) models.haiku = { ...(models.haiku ?? {}), over100k: { ...((models.haiku?.over100k as object | undefined) ?? {}), ...page.haikuOver100k } }
  const merged: Record<string, Record<string, unknown>> = { ...((json.versions ?? {}) as Record<string, Record<string, unknown>>) }
  for (const [key, row] of Object.entries(page.versions ?? {})) merged[key] = { ...(merged[key] ?? {}), ...row }
  const versions = Object.fromEntries(Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)))
  const next: FileJson = {
    ...json,
    source: `Anthropic Claude API first-party prices, checked against ${PRICING_URL.replace(/^https:\/\//, '').replace(/\.md$/, '')} on ${date}. rightsize checks them every ${CHECK_DAYS} days; run /rightsize prices to check sooner.`,
    unit: json.unit ?? 'US dollars per 1 million tokens',
    ...(json.cacheTtl === undefined ? {} : { cacheTtl: json.cacheTtl }),
    models,
    ...(Object.keys(versions).length ? { versions } : {}),
  }
  return `${JSON.stringify(next, null, 2)}\n`
}

export const isDue = (lastCheckedMs: unknown, nowMs: number) =>
  typeof lastCheckedMs !== 'number' || nowMs - lastCheckedMs >= CHECK_DAYS * 24 * 60 * 60 * 1000
