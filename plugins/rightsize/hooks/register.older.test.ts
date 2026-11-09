import { expect, test } from 'claude-code/testing'
import { olderModel } from './cost'
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
    expect(await bandText($)).toContain('rightsize is paused: it is built for Opus 5.5, and prices Opus 4.8 wrongly.')
    expect(h.statuses.at(-1)).toBe('rightsize paused: Opus 4.8 is an older model')
    h.rating = REVIEW
    const rated = h.completions.length
    await d.submit(LOOKUP)
    expect(h.completions.length, 'no rating call').toBe(rated)
    expect(h.submitted.at(-1)).toMatchObject({ text: LOOKUP })
    expect(h.files[LOG_PATH] ?? '').toContain('paused: Opus 4.8 is an older model')
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
