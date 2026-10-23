import { expect, test } from 'claude-code/testing'
import { CHECK_DAYS, applyPrices, diffPrices, isDue, parsePricingPage } from './prices'

// Rows as the pricing page wrote them on 2026-10-23: the model table, then the
// fast-mode and batch tables, which name the same models with fewer prices.
const PAGE = `## Model pricing

| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Claude Fable 5.1 | $10 / MTok | $12.50 / MTok | $20 / MTok | $0.25 / MTok<sup>1</sup> | $50 / MTok |
| Claude Opus 5.5 | $4 / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok<sup>2</sup> | $20 / MTok |
| Claude Sonnet 5.5 | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.10 / MTok<sup>2</sup> | $10 / MTok |
| Claude Haiku 5.5 (for prompts up to 100,000 tokens) | $0.10 / MTok | $0.125 / MTok | $0.20 / MTok | $0.01 / MTok | $0.50 / MTok |
| Claude Haiku 5.5 (for prompts over 100,000 tokens) | $0.50 / MTok | $0.625 / MTok | $1 / MTok | $0.05 / MTok | $2.50 / MTok |

| Claude Opus 5.5 | $8 USD / MTok | $40 USD / MTok |
| Claude Fable 5.1 | $5 / MTok | $25 / MTok |
`

const FILE = JSON.stringify({
  source: 'old',
  cacheTtl: '1h',
  models: {
    haiku: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite5m: 0.125, cacheWrite1h: 0.2 },
    sonnet: { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
    opus: { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 },
    fable: { input: 10, output: 50, cacheRead: 0.25, cacheWrite5m: 12.5, cacheWrite1h: 20 },
  },
  notes: ['kept'],
})

test('reads the four models from the model table only', async () => {
  const page = parsePricingPage(PAGE)
  expect(Object.keys(page).sort()).toEqual(['fable', 'haiku', 'opus', 'sonnet'])
  expect(page.sonnet).toEqual({ input: 2, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.1, output: 10 })
  expect(page.haiku?.input, 'the up-to-100K row').toBe(0.1)
  expect(page.opus?.output, 'not the fast-mode row').toBe(20)
})

test('refuses rows that cannot be prices', async () => {
  const bad = parsePricingPage('| Claude Opus 5.5 | $4 / MTok | $5 / MTok | $8 / MTok | $9 / MTok | $2 / MTok |')
  expect(bad.opus, 'cache hit above input and output below input').toBeUndefined()
  expect(Object.keys(parsePricingPage('<html>moved</html>')).length).toBe(0)
})

test('names each changed price, and writes them in keeping the rest', async () => {
  const page = parsePricingPage(PAGE)
  expect(diffPrices(FILE, page)).toEqual(['Sonnet 5.5 cache read: $0.2 → $0.1'])
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
