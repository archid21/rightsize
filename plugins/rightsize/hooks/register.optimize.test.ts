import { type TestBody, expect, test } from 'claude-code/testing'
import { type Mounted, PANE, RUNS_FILE, drive, engine } from './testkit'

// /rightsize optimize (P-38, ADR 0084): suggestions with the last 30 days under the current setting and the new one, in a
// checklist pane; only what the person picks is applied, recorded for Did it work?; the rest hide for 30 days.

const DAY = 24 * 60 * 60_000
const NOW = Date.parse('2027-01-15T18:00:00Z')
const ago = (d: number) => new Date(NOW - d * DAY).toISOString()
/** 40 rated prompts over 20 days, a $5 turn, and keep warm that cost $20 and saved $5. */
const LOG = [
  ...Array.from({ length: 40 }, (_, k) => ({ at: ago(k / 2), kind: 'run', session: 'old', actual: 0.1 })),
  { at: ago(1), kind: 'run', session: 'old', actual: 5 },
  ...Array.from({ length: 10 }, (_, k) => ({ at: ago(k), kind: 'warm', session: 'old', overhead: 2 })),
  { at: ago(1), kind: 'warmSaved', session: 'old', saved: 5 },
]
  .map(l => JSON.stringify(l))
  .join('\n')
const OPT_PANE = { ...PANE, requestId: 'rightsize-optimize', props: { ...PANE.props, title: 'rightsize optimize' } }
const mountOpt = (api: unknown) => (api as { ui: { mount: (x: unknown) => Promise<Mounted> } }).ui.mount({ ...OPT_PANE, surface: 'terminal' })
const heads = async (ui: Mounted) => (await ui.findAll({ type: 'Button' })).map(b => b.text ?? b.props?.label)

const start = async ($: unknown, on: Parameters<TestBody>[1]) => {
  const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', stored: { bigTurn: 'off' } })
  h.now = NOW
  h.files[RUNS_FILE] = `${LOG}\n`
  const d = drive($, h)
  await d.start('terminal')
  return { h, d }
}
const changes = (h: ReturnType<typeof engine>) =>
  Object.entries(h.files)
    .filter(([path]) => path.endsWith('changes.jsonl'))
    .flatMap(([, text]) => text.trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as { key: string; from: string; to: string }))

test('optimize lists every suggestion with now and with, opens the checklist, and changes nothing yet', { timeoutMs: 30000, options: { bigTurn: 'off' } }, async ($, on) => {
  const { h, d } = await start($, on)
  const text = (await d.command('optimize')).text ?? ''
  expect(text.split('\n')[0]).toBe('Suggestions only: nothing changes until you apply them.')
  expect(text).toContain('☐ Before the cache goes cold: while it pays → off')
  expect(text).toContain('    Now:  keep warm cost $20.00, saved $5.00  →  net $15.00 more')
  expect(text).toContain('☐ Big-turn warning: off → auto')
  expect(h.paneOpens.at(-1)).toEqual({ id: 'rightsize-optimize', title: 'rightsize optimize', focus: true, closeOnEscape: true, holdToasts: true })
  expect(changes(h), 'nothing applied').toEqual([])
  const ui = await mountOpt($)
  expect(await heads(ui)).toEqual(['☐ Before the cache goes cold: while it pays → off', '☐ Big-turn warning: off → auto', 'Apply selected (0)', 'Apply all'])
  await ui.unmount()
})

test('tick one and Apply selected: only that row changes, recorded; the other hides from the next run', { timeoutMs: 30000, options: { bigTurn: 'off' } }, async ($, on) => {
  const { h, d } = await start($, on)
  await d.command('optimize')
  const ui = await mountOpt($)
  await ui.press({ key: 'pick-beforeCold' })
  expect(await heads(ui)).toContain('☑ Before the cache goes cold: while it pays → off')
  expect(await heads(ui)).toContain('Apply selected (1)')
  await ui.press({ key: 'opt-apply' })
  await ui.unmount()
  expect(changes(h).map(c => [c.key, c.to])).toEqual([['beforeCold', 'off']])
  expect(h.paneCloses).toContain('rightsize-optimize')
  expect(h.toasts.at(-1)).toBe('Changed: Before the cache goes cold → off. Did it work? in /rightsize report measures each once there are enough prompts.')
  // Big-turn warning was left unpicked: not suggested again for 30 days.
  expect((await d.command('optimize')).text).toBe('No changes to suggest. Your settings fit your last 30 days.')
})

test('Apply all applies every suggestion', { timeoutMs: 30000, options: { bigTurn: 'off' } }, async ($, on) => {
  const { h, d } = await start($, on)
  await d.command('optimize')
  const ui = await mountOpt($)
  await ui.press({ key: 'opt-all' })
  await ui.unmount()
  expect(changes(h).map(c => [c.key, c.to])).toEqual([
    ['beforeCold', 'off'],
    ['bigTurn', 'auto'],
  ])
})

test('too little use: says so, opens no pane', { timeoutMs: 30000 }, async ($, on) => {
  const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
  h.now = NOW
  const d = drive($, h)
  await d.start('terminal')
  expect((await d.command('optimize')).text).toContain('Not enough use to judge yet (0 rated prompts')
  expect(h.paneOpens).toEqual([])
})
