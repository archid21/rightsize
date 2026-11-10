import { expect, test } from 'claude-code/testing'
import { CHECK_DAYS, applyPrices, diffPrices, isDue, parsePricingPage } from './prices'

// Rows as the pricing page wrote them on 2026-10-23: the model table, then the
// fast-mode and batch tables, which name the same models with fewer prices.
const PAGE = `## Model pricing

| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Claude Fable 5.2 | $8 / MTok | $10 / MTok | $16 / MTok | $0.20 / MTok<sup>1</sup> | $40 / MTok |
| Claude Fable 5.1 | $10 / MTok | $12.50 / MTok | $20 / MTok | $0.25 / MTok<sup>1</sup> | $50 / MTok |
| Claude Mythos 5.1 ([limited availability](https://support.claude.com/en/articles/14604842)) | $10 / MTok | $12.50 / MTok | $20 / MTok | $0.25 / MTok<sup>1</sup> | $50 / MTok |
| Claude Opus 5.5 | $4 / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok<sup>2</sup> | $20 / MTok |
| Claude Opus 4.8 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |
| Claude Opus 4 ([retired, except on Claude Models on Google Cloud (Google managed)](https://platform.claude.com/docs/en/about-claude/model-deprecations)) | $15 / MTok | $18.75 / MTok | $30 / MTok | $1.50 / MTok | $75 / MTok |
| Claude Sonnet 5.5 | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.10 / MTok<sup>2</sup> | $10 / MTok |
| Claude Haiku 5.5 (for prompts up to 100,000 tokens) | $0.10 / MTok | $0.125 / MTok | $0.20 / MTok | $0.01 / MTok | $0.50 / MTok |
| Claude Haiku 5.5 (for prompts over 100,000 tokens) | $0.50 / MTok | $0.625 / MTok | $1 / MTok | $0.05 / MTok | $2.50 / MTok |

| Claude Opus 5.5 | $8 USD / MTok | $40 USD / MTok |
| Claude Opus 5 / Claude Opus 4.8 | $10 USD / MTok | $50 USD / MTok |
| Claude Opus 4.8 | $2.50 / MTok | $12.50 / MTok |
| Claude Fable 5.2 | $4 / MTok | $20 / MTok |
`

const FILE = JSON.stringify({
  source: 'old',
  cacheTtl: '1h',
  models: {
    haiku: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite5m: 0.125, cacheWrite1h: 0.2, over100k: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite5m: 0.625, cacheWrite1h: 1 } },
    sonnet: { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
    opus: { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 },
    fable: { input: 8, output: 40, cacheRead: 0.2, cacheWrite5m: 10, cacheWrite1h: 16 },
  },
  notes: ['kept'],
})

test('reads the four models from the model table only', async () => {
  const page = parsePricingPage(PAGE)
  expect(Object.keys(page).sort()).toEqual(['fable', 'haiku', 'haikuOver100k', 'opus', 'sonnet', 'versions'])
  expect(page.sonnet).toEqual({ input: 2, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.1, output: 10 })
  expect(page.haiku?.input, 'the up-to-100K row').toBe(0.1)
  expect(page.opus?.output, 'not the fast-mode row').toBe(20)
})

test('reads every older version\'s first full row, by its key, and no other family (ADR 0031)', async () => {
  const page = parsePricingPage(PAGE)
  expect(Object.keys(page.versions ?? {}).sort()).toEqual(['claude-fable-5-1', 'claude-opus-4', 'claude-opus-4-8'])
  expect(page.versions?.['claude-opus-4-8'], 'the model table, not the batch or fast-mode rows').toEqual({ input: 5, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5, output: 25 })
  expect(page.versions?.['claude-opus-4']?.input, 'a retired row with a note').toBe(15)
})

test('adds older versions in one line, names a changed one, and keeps one the page dropped (ADR 0031)', async () => {
  const page = parsePricingPage(PAGE)
  const withOld = JSON.stringify({ ...JSON.parse(FILE), versions: { 'claude-opus-4-8': { input: 5, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.4, output: 25 }, 'claude-sonnet-3-7': { input: 3, output: 15, cacheRead: 0.3 } } })
  expect(diffPrices(withOld, page)).toEqual(['Sonnet 5.5 cache read: $0.2 → $0.1', 'Opus 4.8 cache read: $0.4 → $0.5', 'prices for Fable 5.1, Opus 4 added'])
  const next = JSON.parse(applyPrices(withOld, page, '2026-11-09')) as { versions: Record<string, Record<string, number>> }
  expect(Object.keys(next.versions)).toEqual(['claude-fable-5-1', 'claude-opus-4', 'claude-opus-4-8', 'claude-sonnet-3-7'])
  expect(next.versions['claude-opus-4-8']?.cacheRead).toBe(0.5)
  expect(next.versions['claude-sonnet-3-7'], 'not on the page: kept').toEqual({ input: 3, output: 15, cacheRead: 0.3 })
})

test('reads Haiku\'s over-100K row and checks it against prices.json', async () => {
  const page = parsePricingPage(PAGE)
  expect(page.haikuOver100k).toEqual({ input: 0.5, cacheWrite5m: 0.625, cacheWrite1h: 1, cacheRead: 0.05, output: 2.5 })
  const stale = JSON.stringify({ models: { haiku: { input: 0.1, output: 0.5, over100k: { input: 0.4, output: 2.5, cacheRead: 0.01 } } } })
  expect(diffPrices(stale, { haikuOver100k: page.haikuOver100k })).toEqual([
    'Haiku 5.5 input over 100K tokens: $0.4 → $0.5',
    'Haiku 5.5 5-minute cache write over 100K tokens: unset → $0.625',
    'Haiku 5.5 1-hour cache write over 100K tokens: unset → $1',
    'Haiku 5.5 cache read over 100K tokens: $0.01 → $0.05',
  ])
  const next = JSON.parse(applyPrices(stale, page, '2026-11-04')) as { models: { haiku: { over100k: Record<string, number> } } }
  expect(next.models.haiku.over100k).toEqual({ input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite5m: 0.625, cacheWrite1h: 1 })
})

test('refuses rows that cannot be prices', async () => {
  const bad = parsePricingPage('| Claude Opus 5.5 | $4 / MTok | $5 / MTok | $8 / MTok | $9 / MTok | $2 / MTok |')
  expect(bad.opus, 'cache hit above input and output below input').toBeUndefined()
  expect(Object.keys(parsePricingPage('<html>moved</html>')).length).toBe(0)
})

test('names each changed price, and writes them in keeping the rest', async () => {
  const page = parsePricingPage(PAGE)
  expect(diffPrices(FILE, page)).toEqual(['Sonnet 5.5 cache read: $0.2 → $0.1', 'prices for Fable 5.1, Opus 4, Opus 4.8 added'])
  const next = JSON.parse(applyPrices(FILE, page, '2026-11-01')) as {
    source: string
    cacheTtl: string
    notes: string[]
    models: Record<string, Record<string, number>>
  }
  expect(next.models.sonnet?.cacheRead).toBe(0.1)
  expect(next.cacheTtl, 'the person’s TTL kept').toBe('1h')
  expect(next.notes).toEqual(['kept'])
  expect(next.source).toContain('2026-11-01')
  expect(diffPrices(JSON.stringify(next), page), 'nothing left to change').toEqual([])
})

test('is due after 30 days or when never checked', async () => {
  const day = 24 * 60 * 60 * 1000
  expect(isDue(undefined, 1000)).toBe(true)
  expect(isDue(0, (CHECK_DAYS - 1) * day)).toBe(false)
  expect(isDue(0, CHECK_DAYS * day)).toBe(true)
})
