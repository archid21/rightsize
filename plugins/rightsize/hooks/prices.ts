import type { RightsizeTier as Tier } from '../types'
import { TIERS } from './cost'

// The price check: read Anthropic's pricing page, find the four models' rows,
// and say what differs from prices.json. Pure functions, no engine calls.

export const PRICING_URL = 'https://platform.claude.com/docs/en/about-claude/pricing.md'
/** Days between automatic checks. */
export const CHECK_DAYS = 30

export type PageRow = { input: number; cacheWrite5m: number; cacheWrite1h: number; cacheRead: number; output: number }
export type PageRows = Partial<Record<Tier, PageRow>>

// The page's model table names each model like this. Haiku's first row is the
// up-to-100K-tokens price, the one the mod uses.
const ROW_NAME: Record<Tier, string> = {
  haiku: 'Claude Haiku 5.5',
  sonnet: 'Claude Sonnet 5.5',
  opus: 'Claude Opus 5.5',
  fable: 'Claude Fable 5.1',
}
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
    if (!tier || out[tier]) continue
    const values = cells.slice(1).map(dollarsIn)
    if (values.some(v => !Number.isFinite(v) || v <= 0)) continue
    const row = Object.fromEntries(FIELDS.map((f, i) => [f, values[i] as number])) as PageRow
    // Output always costs more than input and a cache hit less: anything else is a misread.
    if (row.output <= row.input || row.cacheRead >= row.input) continue
    out[tier] = row
  }
  return out
}

type FileJson = { source?: unknown; models?: Record<string, Record<string, unknown> | undefined>; [k: string]: unknown }

const LABEL: Record<(typeof FIELDS)[number], string> = {
  input: 'input',
  cacheWrite5m: '5-minute cache write',
  cacheWrite1h: '1-hour cache write',
  cacheRead: 'cache read',
  output: 'output',
}
const NAME: Record<Tier, string> = { haiku: 'Haiku 5.5', sonnet: 'Sonnet 5.5', opus: 'Opus 5.5', fable: 'Fable 5.1' }
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
  const next: FileJson = {
    ...json,
    source: `Anthropic Claude API first-party prices, checked against ${PRICING_URL.replace(/^https:\/\//, '').replace(/\.md$/, '')} on ${date}. rightsize checks them every ${CHECK_DAYS} days; pick "check now" for Price check in /config to check sooner.`,
    unit: json.unit ?? 'US dollars per 1 million tokens',
    cacheTtl: json.cacheTtl ?? '5m',
    models,
  }
  return `${JSON.stringify(next, null, 2)}\n`
}

export const isDue = (lastCheckedMs: unknown, nowMs: number) =>
  typeof lastCheckedMs !== 'number' || nowMs - lastCheckedMs >= CHECK_DAYS * 24 * 60 * 60 * 1000
