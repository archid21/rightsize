import { expect, test } from 'claude-code/testing'
import { forModel, olderModel, parsePrices, priceOf, unpricedOlder, usageCost } from './cost'
import { LOG_PATH, LOOKUP, REVIEW, engine, drive, mount, rowText } from './testkit'

// ADR 0032: rightsize prices only the newest version of each family, so on an older main-chat model it is off.

test('olderModel reads the version in a model ID', () => {
  expect(olderModel('claude-opus-4-8')).toBe('Opus 4.8')
  expect(olderModel('claude-opus-4-20250514')).toBe('Opus 4')
  expect(olderModel('claude-3-5-sonnet-20241022')).toBe('Sonnet 3.5')
  expect(olderModel('anthropic.claude-haiku-4-5-20251001-v1:0')).toBe('Haiku 4.5')
  expect(olderModel('claude-opus-4-8@20260101')).toBe('Opus 4.8')
  expect(olderModel('claude-fable-5-1')).toBe('Fable 5.1')
  expect(olderModel('claude-fable-5')).toBe('Fable 5')
  // The newest, a newer one, and IDs with no version are not older.
  for (const id of ['claude-opus-5-5', 'claude-sonnet-5-5[1m]', 'claude-fable-5-2', 'claude-opus-6', 'opus', 'sonnet[1m]', 'gpt-5', '', undefined]) expect(olderModel(id), String(id)).toBeUndefined()
})

// ADR 0031: an older version with its own row in prices.json is priced by it, and rightsize runs there.
const WITH_OPUS_48 = JSON.stringify({
  models: { opus: { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 } },
  versions: { 'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 } },
})

test('a version row prices that version wherever its name sits in the ID; the family prices the rest', () => {
  const p = parsePrices(WITH_OPUS_48, '1h')
  for (const id of ['claude-opus-4-8', 'claude-opus-4-8-20260101', 'anthropic.claude-opus-4-8-v1:0', 'claude-opus-4-8@20260101']) expect(priceOf(p, id)?.input, id).toBe(5)
  expect(priceOf(p, 'claude-opus-5-5')?.input, 'the newest').toBe(4)
  expect(priceOf(p, 'opus')?.input, 'no version').toBe(4)
  expect(priceOf(p, 'claude-opus-4-7')?.input, 'an older version with no row borrows the family').toBe(4)
  expect(priceOf(p, 'gpt-5'), 'no family').toBeUndefined()
  expect(unpricedOlder(p, 'claude-opus-4-8')).toBe(false)
  expect(unpricedOlder(p, 'claude-opus-4-7')).toBe(true)
  expect(unpricedOlder(p, 'claude-opus-5-5')).toBe(false)
  const u = { input_tokens: 1e6, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  expect(usageCost(p, 'claude-opus-4-8', u)).toBe(5)
  expect(usageCost(p, 'claude-opus-5-5', u)).toBe(4)
  // The main chat on Opus 4.8 plans with its row; a request on the newest Opus is still priced as the newest.
  const main = forModel(p, 'claude-opus-4-8')
  expect(main.opus.input).toBe(5)
  expect(usageCost(main, 'claude-opus-5-5', u)).toBe(4)
  expect(forModel(main, 'claude-opus-5-5').opus.input, 'back on the newest').toBe(4)
  expect(parsePrices(JSON.stringify({ versions: { 'claude-opus-4-8': { input: 5 } } }), '1h').versions, 'a row missing a price is not read').toBeUndefined()
})

for (const surface of ['desktop', 'terminal'] as const) {
  const bandText = async ($: unknown) => {
    const ui = await mount($, surface)
    const text = (await rowText(ui, 'Prompt')) || (await rowText(ui, 'Cache'))
    await ui.unmount()
    return text
  }

  test(`an Opus 4.8 session is paused: no rating, the prompt goes as typed, one band line (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-4-8', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    expect(await bandText($)).toContain('rightsize is paused: prices.json has no price for Opus 4.8. Run /rightsize prices to fetch it')
    expect(h.statuses.at(-1)).toBe('rightsize paused: Opus 4.8 is an older model')
    h.rating = REVIEW
    const rated = h.completions.length
    await d.submit(LOOKUP)
    expect(h.completions.length, 'no rating call').toBe(rated)
    expect(h.submitted.at(-1)).toMatchObject({ text: LOOKUP })
    expect(h.files[LOG_PATH] ?? '').toContain('paused: Opus 4.8 is an older model')
  })

  test(`an Opus 4.8 session with its own price row runs, priced by it (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-4-8', effort: 'medium' })
    h.pricesFile = WITH_OPUS_48
    const d = drive($, h)
    await d.start(surface)
    h.rating = REVIEW
    const rated = h.completions.length
    await d.submit(LOOKUP)
    expect(h.completions.length, 'rated').toBeGreaterThan(rated)
    expect(h.files[LOG_PATH] ?? '').toContain('Opus 4.8: priced by its own row in prices.json')
    expect(h.files[LOG_PATH] ?? '').not.toContain('paused: Opus 4.8')
  })

  test(`switching to the newest model turns rightsize back on (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-4-8', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    h.model = 'claude-opus-5-5'
    h.liveModel = 'claude-opus-5-5'
    h.rating = REVIEW
    const rated = h.completions.length
    await d.submit(LOOKUP)
    expect(h.completions.length, 'rated again').toBeGreaterThan(rated)
    expect(h.files[LOG_PATH] ?? '').toContain('resumed: the main chat left Opus 4.8')
  })
}
