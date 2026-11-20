import { type TestBody, expect, test } from 'claude-code/testing'
import { BIG_TURN, NO_CHANGE, NO_COLD, RUNS_FILE, drive, engine, mount } from './testkit'

// P-85: each compact gets a 'compactSaved' line that grows with the later requests of the same session.

const EVENING = new Date(2027, 0, 15, 18, 0, 0, 0).getTime()
const turnOf = (tokens: number) => ({ ...BIG_TURN, cache_read_input_tokens: tokens - 500 })
const compactAs = (api: unknown, trigger: 'auto' | 'manual') =>
  (api as unknown as { session: { compact: (x: unknown) => Promise<unknown> } }).session.compact({ trigger, messages: [{ role: 'user', text: 'The conversation.', toolUses: [] }] })

const session = async ($: unknown, on: Parameters<TestBody>[1]) => {
  const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
  h.now = EVENING
  h.virtual = true
  h.stepUsage = turnOf(200_000)
  const d = drive($, h)
  await d.start('desktop')
  return { h, d }
}
const turn = async (d: ReturnType<typeof drive>, id: string) => {
  await d.step(id)
  await d.complete(id)
}
const compactLines = (h: ReturnType<typeof engine>) =>
  (h.files[RUNS_FILE] ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>).filter(l => l.kind === 'compactSaved')

test('a compact by the person: one line per compact, the cut from the first request after, and the later requests counted', { timeoutMs: 30000 }, async ($, on) => {
  const { h, d } = await session($, on)
  await turn(d, 't1')
  await compactAs($, 'manual')
  h.stepUsage = turnOf(50_000)
  await turn(d, 't2')
  await turn(d, 't3')
  const lines = compactLines(h)
  expect(lines.length, 'written at each turn end').toBeGreaterThan(0)
  const last = lines.at(-1)!
  expect(new Set(lines.map(l => l.compactId)).size, 'one compact').toBe(1)
  expect(last).toMatchObject({ compactSource: 'manual', ctxBefore: 200_000, ctxAfter: 50_000, cut: 150_000 })
  expect(Number(last.requests)).toBeGreaterThanOrEqual(2)
})

test('the next compact closes the first: its last line says next compact, and a new compact starts', { timeoutMs: 30000 }, async ($, on) => {
  const { h, d } = await session($, on)
  await turn(d, 't1')
  await compactAs($, 'manual')
  h.stepUsage = turnOf(50_000)
  await turn(d, 't2')
  await compactAs($, 'auto')
  const lines = compactLines(h)
  const ids = [...new Set(lines.map(l => l.compactId))]
  expect(ids.length).toBe(2)
  expect(lines.filter(l => l.compactId === ids[0]).at(-1)).toMatchObject({ stop: 'next compact', startedFresh: false })
  expect(lines.filter(l => l.compactId === ids[1]).at(-1)).toMatchObject({ compactSource: 'auto' })
})

// rightsize's own compacts are measured from the plugin side, so a login where the session.compact hook never runs still counts them.

test('Compact now on the context-size warning: a compactSaved line with source button, and later requests counted', { timeoutMs: 30000, options: { billing: 'api' } }, async ($, on) => {
  const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', stored: { ...NO_COLD, billing: 'api' } })
  h.rating = NO_CHANGE
  h.contextTokens = 120_000
  h.now = EVENING
  h.virtual = true
  h.stepUsage = turnOf(200_000)
  const d = drive($, h)
  await d.start('desktop')
  await d.submit('continue')
  await d.turnStart('t1', 'continue')
  await turn(d, 't1')
  const ui = await mount($, 'desktop')
  await ui.press({ key: 'cold-size-compact' })
  await ui.unmount()
  expect(h.compactions).toBe(1)
  h.stepUsage = turnOf(50_000)
  await turn(d, 't2')
  await turn(d, 't3')
  const lines = compactLines(h)
  expect(new Set(lines.map(l => l.compactId)).size, 'one compact').toBe(1)
  expect(lines.at(-1)).toMatchObject({ compactSource: 'button', ctxBefore: 200_000, ctxAfter: 50_000 })
  expect(Number(lines.at(-1)!.requests)).toBeGreaterThanOrEqual(2)
})

test('keep warm compact: one line with source keepwarm', { timeoutMs: 30000, options: { beforeCold: 'compact' } }, async ($, on) => {
  const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', stored: { beforeCold: 'compact' } })
  h.now = EVENING
  h.virtual = true
  h.stepUsage = BIG_TURN
  h.commands = []
  const d = drive($, h)
  await d.start('desktop')
  await turn(d, 't1')
  await h.advance(57 * 60_000)
  expect(h.compactions).toBe(1)
  const lines = compactLines(h)
  expect(new Set(lines.map(l => l.compactId)).size, 'one compact').toBe(1)
  expect(lines.at(-1)).toMatchObject({ compactSource: 'keepwarm' })
})

test('the hook also fires for the same compact: still one compactId', { timeoutMs: 30000, options: { billing: 'api' } }, async ($, on) => {
  const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', stored: { ...NO_COLD, billing: 'api' } })
  h.rating = NO_CHANGE
  h.contextTokens = 120_000
  h.now = EVENING
  h.virtual = true
  h.stepUsage = turnOf(200_000)
  const d = drive($, h)
  await d.start('desktop')
  await turn(d, 't1')
  const ui = await mount($, 'desktop')
  await ui.press({ key: 'cold-size-compact' })
  await ui.unmount()
  // The hook fires again for the same compact, a moment after rightsize started measuring it.
  await compactAs($, 'manual')
  h.stepUsage = turnOf(50_000)
  await turn(d, 't2')
  expect(new Set(compactLines(h).map(l => l.compactId)).size).toBe(1)
})

test('Compact Now on the Cache row: source button, not keepwarm', { timeoutMs: 30000 }, async ($, on) => {
  const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
  h.now = EVENING
  h.virtual = true
  h.stepUsage = turnOf(200_000)
  const d = drive($, h)
  await d.start('desktop')
  await turn(d, 't1')
  const ui = await mount($, 'desktop')
  await ui.press({ key: 'cold-compact' })
  await ui.unmount()
  expect(h.compactions).toBe(1)
  expect(compactLines(h).at(-1)).toMatchObject({ compactSource: 'button' })
})

// A /compact the person types while rightsize is advising a compact counts as rightsize's: source 'advised'. The plain Cache timer row does not.

test('the person types /compact while the size warning is up: source advised', { timeoutMs: 30000, options: { billing: 'api' } }, async ($, on) => {
  const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', stored: { ...NO_COLD, billing: 'api' } })
  h.rating = NO_CHANGE
  h.contextTokens = 120_000
  h.now = EVENING
  h.virtual = true
  h.stepUsage = turnOf(200_000)
  const d = drive($, h)
  await d.start('desktop')
  await d.submit('continue')
  await d.turnStart('t1', 'continue')
  await turn(d, 't1')
  const ui = await mount($, 'desktop')
  expect(await ui.find({ key: 'cold-size-compact' }), 'the size warning is on the band').toBeTruthy()
  await ui.unmount()
  await compactAs($, 'manual')
  h.stepUsage = turnOf(50_000)
  await turn(d, 't2')
  expect(compactLines(h).at(-1)).toMatchObject({ compactSource: 'advised' })
})

test('the person types /compact with only the Cache timer row up: source manual', { timeoutMs: 30000 }, async ($, on) => {
  const { h, d } = await session($, on)
  await turn(d, 't1')
  const ui = await mount($, 'desktop')
  expect(await ui.find({ key: 'cold-compact' }), 'the timer row is on the band').toBeTruthy()
  await ui.unmount()
  await compactAs($, 'manual')
  h.stepUsage = turnOf(50_000)
  await turn(d, 't2')
  expect(compactLines(h).at(-1)).toMatchObject({ compactSource: 'manual' })
})
