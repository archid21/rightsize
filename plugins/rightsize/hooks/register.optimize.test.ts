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

const start = async ($: unknown, on: Parameters<TestBody>[1], log = LOG) => {
  const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
  h.now = NOW
  h.files[RUNS_FILE] = `${log}\n`
  const d = drive($, h)
  await d.start('terminal')
  return { h, d }
}
const changes = (h: ReturnType<typeof engine>) =>
  Object.entries(h.files)
    .filter(([path]) => path.endsWith('changes.jsonl'))
    .flatMap(([, text]) => text.trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as { key: string; from: string; to: string }))

test('optimize lists every suggestion with now and with, opens the checklist, and changes nothing yet', { timeoutMs: 30000 }, async ($, on) => {
  const { h, d } = await start($, on)
  const text = (await d.command('optimize')).text ?? ''
  expect(text.split('\n')[0]).toBe('Suggestions only: nothing changes until you apply them.')
  expect(text).toContain('☐ Before the cache goes cold: while it pays → off')
  expect(text).toContain('    Now:  keep warm cost $20.00, saved $5.00  →  net $15.00 more')
  expect(h.paneOpens.at(-1)).toEqual({ id: 'rightsize-optimize', title: 'rightsize optimize', focus: true, closeOnEscape: true, holdToasts: true })
  expect(changes(h), 'nothing applied').toEqual([])
  const ui = await mountOpt($)
  expect(await heads(ui)).toEqual(['☐ Before the cache goes cold: while it pays → off', 'Apply selected (0)', 'Apply all'])
  await ui.unmount()
})

test('tick one and Apply selected: only that row changes, recorded', { timeoutMs: 30000 }, async ($, on) => {
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
  // Applied: nothing is left to suggest.
  expect((await d.command('optimize')).text).toBe('No changes to suggest. Your settings fit your last 30 days.')
})

test('Apply selected with nothing ticked changes nothing, hides nothing, and keeps the checklist open', { timeoutMs: 30000 }, async ($, on) => {
  const { h, d } = await start($, on)
  await d.command('optimize')
  const ui = await mountOpt($)
  await ui.press({ key: 'opt-apply' })
  await ui.unmount()
  expect(changes(h)).toEqual([])
  expect(h.paneCloses).not.toContain('rightsize-optimize')
  expect(h.toasts.at(-1)).toBe('Nothing ticked: press Enter on a row to tick it, or use Apply all.')
  expect((await d.command('optimize')).text, 'still suggested').toContain('☐ Before the cache goes cold: while it pays → off')
})

test('Apply all applies every suggestion', { timeoutMs: 30000 }, async ($, on) => {
  const { h, d } = await start($, on)
  await d.command('optimize')
  const ui = await mountOpt($)
  await ui.press({ key: 'opt-all' })
  await ui.unmount()
  expect(changes(h).map(c => [c.key, c.to])).toEqual([
    ['beforeCold', 'off'],
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

// P-89 (ADR 0100): hand-downs that saved nothing. 40 rated prompts over 20 days, 40 Haiku hand-downs over 10 days that cost $1.05 each
// against $1.00 to stay, and 40 of Claude's subagents moved to a cheaper model that cost $1.00 where staying would have cost $0.95.
const HAND_LOG = [
  ...Array.from({ length: 40 }, (_, k) => ({ at: ago(k / 2), kind: 'run', session: 'old', actual: 0.1 })),
  ...Array.from({ length: 40 }, (_, k) => ({ at: ago(k % 10), kind: 'run', session: 'old', id: `h${k}`, change: 'delegate-down', route: 'delegate:haiku', stay: 1, actual: 1.05, agentCalls: 1 })),
  ...Array.from({ length: 40 }, (_, k) => ({ at: ago(k % 10), kind: 'subagent', session: 'old', run: `h${k}`, estimate: 1, parentEstimate: 0.95, actual: 1 })),
]
  .map(l => JSON.stringify(l))
  .join('\n')
const HAND_HEADS = ['☐ Use Haiku: on → off', "☐ Claude's subagents: cheaper when it fits → off", '☐ Cheaper model: not set → stay, lower effort only', 'Apply selected (0)', 'Apply all']

test('optimize lists the hand-down rows as estimated, with a quality note, and opens them in the checklist (P-89)', { timeoutMs: 30000 }, async ($, on) => {
  const { h, d } = await start($, on, HAND_LOG)
  const text = (await d.command('optimize')).text ?? ''
  expect(text).toContain('☐ Use Haiku: on → off')
  expect(text).toContain('    Now:  40 Haiku hand-down turns cost $2.00 more than staying')
  expect(text).toContain('    Estimated: what those turns cost against an estimate of staying on your own model.')
  expect(text).toContain('    Quality: none of the 40 turns showed a failure sign.')
  expect(text).toContain('    Now:  40 moved subagent runs cost $2.00 more than staying')
  expect(changes(h), 'nothing applied').toEqual([])
  const ui = await mountOpt($)
  expect(await heads(ui)).toEqual(HAND_HEADS)
  await ui.unmount()
})

test('tick Use Haiku and Apply selected: only that row changes, to off, recorded for Did it work? (P-89)', { timeoutMs: 30000 }, async ($, on) => {
  const { h, d } = await start($, on, HAND_LOG)
  await d.command('optimize')
  const ui = await mountOpt($)
  await ui.press({ key: 'pick-useHaiku' })
  await ui.press({ key: 'opt-apply' })
  await ui.unmount()
  expect(changes(h).map(c => [c.key, c.from, c.to])).toEqual([['useHaiku', 'on', 'off']])
  expect(h.toasts.at(-1)).toBe('Changed: Use Haiku → off. Did it work? in /rightsize report measures each once there are enough prompts.')
  const text = (await d.command('optimize')).text ?? ''
  expect(text).not.toContain('Use Haiku')
  expect(text, 'the others were left unpicked: hidden for 30 days, not applied').toBe('No changes to suggest. Your settings fit your last 30 days.')
})

test('Apply all sets Use Haiku and Claude\'s subagents to off and Cheaper model to stay, lower effort only (P-89)', { timeoutMs: 30000 }, async ($, on) => {
  const { h, d } = await start($, on, HAND_LOG)
  await d.command('optimize')
  const ui = await mountOpt($)
  await ui.press({ key: 'opt-all' })
  await ui.unmount()
  expect(changes(h).map(c => [c.key, c.to])).toEqual([
    ['useHaiku', 'off'],
    ['subagents', 'off'],
    ['downRule', 'stay, lower effort only'],
  ])
})

test('the Lowering suggestion says Estimated, not Measured (P-87)', { timeoutMs: 30000 }, async ($, on) => {
  const lowered = Array.from({ length: 40 }, (_, k) => ({ at: ago(k % 10), kind: 'run', session: 'old', change: 'lower', stay: 1, actual: 1.05 }))
  const log = [...LOG.split('\n'), ...lowered.map(l => JSON.stringify(l))].join('\n')
  const { d } = await start($, on, log)
  const text = (await d.command('optimize')).text ?? ''
  expect(text).toContain('☐ Lowering: not set → never lower')
  expect(text).toContain('    Estimated: what those turns cost against an estimate of staying at your own effort.')
})
