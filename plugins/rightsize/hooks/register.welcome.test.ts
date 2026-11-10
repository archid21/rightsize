import { expect, test } from 'claude-code/testing'
import { DAY, RUNS_FILE, type Mounted, drive, engine, last, mount, rowText } from './testkit'
import { askText } from './star'
import { TIPS, nextTip, parseState } from './tips'
import { ROWS, welcomeMarkdown, welcomeText } from './welcome'

// The welcome, the tips and the star ask (ADR 0039).

const OPUS = { model: 'claude-opus-5-5', effort: 'medium' }
/** A fresh install: no welcome yet, tips on. */
const FRESH = { welcomed: undefined, tips: undefined }
/** Tips on, the welcome already seen. */
const TIPS_ON = { tips: undefined }
/** A run line of this session that saved money: the session's net is a saving. */
const SAVED = (now: number) => JSON.stringify({ at: new Date(now - 60_000).toISOString(), kind: 'run', session: 'sess-1', change: 'lower', offered: 'lower', actual: 0.5, stay: 1, taken: 0.5, overhead: 0.01 })
const RS = 'archid21/rightsize'
const WN = 'archid21/whatsnext'

test('the plain welcome fits 71 columns (a command row indents 5 of 80); both forms carry every row', async () => {
  const text = welcomeText()
  for (const line of text.split('\n')) expect(line.length, line).toBeLessThanOrEqual(71)
  for (const [what, how] of ROWS) {
    expect(text.replace(/\s+/g, ' ')).toContain(what)
    expect(welcomeMarkdown()).toContain(`| ${what} | ${how} |`)
  }
  expect(welcomeMarkdown().match(/^\|---\|---\|$/gm), 'two tables: the five to learn first, then the rest').toHaveLength(2)
})

test('tips: an old or damaged state reads as tips on, nothing seen; the walk skips seen and skipped tips and ends on the star', async () => {
  expect(parseState(undefined)).toEqual({ tipsOff: false, seen: [] })
  expect(parseState({ tipsOff: 'yes', seen: ['report', 'nope', 3, 'report'] })).toEqual({ tipsOff: false, seen: ['report'] })
  expect(nextTip([])?.id).toBe('report')
  expect(nextTip(['report'], 'report')?.id).toBe('retry')
  expect(nextTip([], 'watch')?.id).toBe('star')
  expect(nextTip([], 'watch', ['star'])).toBeUndefined()
  expect(last(TIPS)?.id, 'the star tip is last').toBe('star')
  expect(askText([RS, WN])).toBe('Finding rightsize and whatsnext useful? Star them on GitHub so other people can find them.')
})

for (const surface of ['desktop', 'terminal'] as const) {
  const tipRow = async ($: unknown) => {
    const ui = await mount($, surface)
    const text = await rowText(ui, 'Tip')
    await ui.unmount()
    return text
  }
  const press = async ($: unknown, key: string) => {
    const ui = await mount($, surface)
    await ui.press({ key })
    await ui.unmount()
  }
  const buttons = async ($: unknown) => {
    const ui = await mount($, surface)
    const keys = (await ui.findAll({ type: 'Button' })).map(b => b.key)
    await ui.unmount()
    return keys
  }
  const shared = (h: { stars?: string }) => JSON.parse(h.stars ?? '{}') as { installed?: Record<string, string>; starred?: Record<string, boolean>; answered?: string; claim?: { by: string } }

  const ui = (api: unknown) => api as { ui: { mount: (x: unknown) => Promise<Mounted> } }
  const markdownOf = async (m: Mounted) => {
    const md = await m.find({ type: 'Markdown', key: 'welcome' })
    await m.unmount()
    return (md?.props as { text?: string } | undefined)?.text
  }

  test(`welcome: once per install it opens a pane that draws the table as Markdown; not again (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: FRESH })
    h.virtual = true
    const d = drive($, h)
    await d.start(surface)
    expect(h.paneOpens, 'a pane opened while the session starts is not placed: it waits').toEqual([])
    await h.advance(1500)
    expect(h.paneOpens.map(p => p.id)).toEqual(['rightsize-welcome'])
    expect(h.paneOpens[0]).toMatchObject({ focus: true, closeOnEscape: true })
    expect(h.logs, 'no transcript line when the pane shows').toEqual([])
    expect(h.store.welcomed).toBe(true)
    const pane = await ui($).ui.mount({ plugin: 'rightsize', component: 'Pane', requestId: 'rightsize-welcome', surface, props: { title: 'Welcome to rightsize', isFocused: true, bodyColumns: 80, placement: 'inline', scroll: { offset: 0, bodyRows: 40 }, view: {} } })
    expect(await markdownOf(pane)).toBe(welcomeMarkdown())
    await d.start(surface)
    await h.advance(1500)
    expect(h.paneOpens, 'not again').toHaveLength(1)
  })

  test(`welcome: with no pane placed, one transcript line names /rightsize welcome (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: FRESH })
    h.panePlaced = false
    h.virtual = true
    await drive($, h).start(surface)
    await h.advance(1500)
    expect(h.paneCloses).toEqual(['rightsize-welcome'])
    expect(h.logs).toEqual(['rightsize is on: each prompt runs on the cheapest model and effort that does it well. See what it does: /rightsize welcome'])
  })

  test(`welcome: /rightsize welcome answers the plain table, and its row draws the Markdown one (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS })
    const d = drive($, h)
    await d.start(surface)
    expect((await d.command('welcome')).text).toBe(welcomeText())
    expect((await d.command('help')).text).toContain('/rightsize welcome')
    const row = await ui($).ui.mount({ plugin: 'rightsize', component: 'CommandOutput', surface, props: { command: 'rightsize', args: 'welcome', text: welcomeText(), isErrored: false } })
    expect(await markdownOf(row)).toBe(welcomeMarkdown())
  })

  test(`star file: rightsize says it is installed, once, and keeps what whatsnext wrote (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS })
    h.stars = JSON.stringify({ installed: { whatsnext: '2026-11-01T00:00:00.000Z' }, starred: {} })
    const d = drive($, h)
    await d.start(surface)
    const first = shared(h).installed?.rightsize
    expect(first).toBeDefined()
    expect(shared(h).installed?.whatsnext).toBe('2026-11-01T00:00:00.000Z')
    h.now += DAY
    await d.start(surface)
    expect(shared(h).installed?.rightsize, 'first-seen time stays').toBe(first)
  })

  test(`tips: after a saving, a quiet turn end shows the report tip; Next tip walks to the star; × and Stop tips (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: TIPS_ON })
    h.files[RUNS_FILE] = SAVED(h.now)
    const d = drive($, h)
    await d.start(surface)
    expect(await tipRow($), 'no tip at startup').toBe('')
    await d.complete('t0')
    expect(await tipRow($)).toBe(TIPS[0]!.text)
    expect(await buttons($)).toEqual(['tip-next', 'tip-stop', 'tip-close'])
    await press($, 'tip-next')
    expect(await tipRow($)).toBe(TIPS[1]!.text)
    await press($, 'tip-next')
    await press($, 'tip-next')
    await press($, 'tip-next')
    expect(await tipRow($), 'the walk ends on the star ask').toBe(askText([RS]))
    expect(await buttons($)).toEqual(['tip-star', 'tip-no', 'tip-close'])
    await press($, 'tip-close')
    expect(await tipRow($)).toBe('')
    expect((h.store.tips as { seen: string[] }).seen).toEqual(['report', 'retry', 'rate', 'watch', 'star'])
    expect(await d.command('tips')).toEqual({ text: 'Tips are on. The first one is on the band.' })
    expect(await tipRow($)).toBe(TIPS[0]!.text)
    await press($, 'tip-stop')
    expect(await tipRow($)).toBe('')
    expect(last(h.toasts)).toBe('Rightsize: tips are off. /rightsize tips turns them back on.')
    await d.complete('t1')
    expect(await tipRow($), 'off stays off').toBe('')
  })

  test(`tips: none while a question or a cache offer shows, none with Band set to Never (${surface})`, { timeoutMs: 30000, options: { band: 'off' } }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: TIPS_ON, stored: { band: 'off' } })
    h.files[RUNS_FILE] = SAVED(h.now)
    const d = drive($, h)
    await d.start(surface)
    await d.complete('t0')
    expect(await tipRow($)).toBe('')
    expect((h.store.tips as { seen: string[] } | undefined)?.seen ?? [], 'nothing spent').toEqual([])
  })

  test(`star: no gh means no ask, and nothing is saved (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: { ...TIPS_ON, tips: { tipsOff: false, seen: ['report'] } } })
    h.files[RUNS_FILE] = SAVED(h.now)
    const d = drive($, h)
    await d.start(surface)
    await d.complete('t0')
    expect(await tipRow($)).toBe('')
    expect(shared(h).answered).toBeUndefined()
    expect(shared(h).claim).toBeUndefined()
    expect(h.store.star).toEqual({ earned: true })
  })

  test(`star: with whatsnext installed, one ask names both; Star on GitHub stars both and thanks (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: { tips: { tipsOff: false, seen: ['report'] } } })
    h.files[RUNS_FILE] = SAVED(h.now)
    h.stars = JSON.stringify({ installed: { whatsnext: '2026-11-01T00:00:00.000Z' }, starred: {} })
    h.gh = { starred: {}, canStar: true }
    const d = drive($, h)
    await d.start(surface)
    await d.complete('t0')
    expect(await tipRow($)).toBe(askText([RS, WN]))
    expect(shared(h).claim?.by).toBe('rightsize')
    await press($, 'tip-star')
    expect(h.ran.filter(a => a[0] === 'gh' && a.includes('PUT')).map(a => last(a))).toEqual([`user/starred/${RS}`, `user/starred/${WN}`])
    expect(shared(h).starred).toEqual({ [RS]: true, [WN]: true })
    expect(shared(h).answered).toBeDefined()
    expect(last(h.toasts)).toBe('Rightsize: thanks for the star!')
    expect(await tipRow($)).toBe('')
  })

  test(`star: when starring fails, the first page opens and the toast gives both links (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: { tips: { tipsOff: false, seen: ['report'] } } })
    h.files[RUNS_FILE] = SAVED(h.now)
    h.stars = JSON.stringify({ installed: { whatsnext: '2026-11-01T00:00:00.000Z' }, starred: {} })
    h.gh = { starred: {}, canStar: false }
    const d = drive($, h)
    await d.start(surface)
    await d.complete('t0')
    await press($, 'tip-star')
    expect(h.ran.filter(a => a[0] === 'open')).toEqual([['open', `https://github.com/${RS}`]])
    expect(last(h.toasts)).toBe(`Rightsize: could not star from here. Star it on GitHub: https://github.com/${RS} https://github.com/${WN}`)
    expect(shared(h).answered, 'answered: no ask again').toBeDefined()
  })

  const SEEN = { tips: { tipsOff: false, seen: ['report'] } }

  test(`star: No thanks answers for both plugins and stars nothing (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: SEEN })
    h.files[RUNS_FILE] = SAVED(h.now)
    h.gh = { starred: {}, canStar: true }
    const d = drive($, h)
    await d.start(surface)
    await d.complete('t0')
    expect(await tipRow($)).toBe(askText([RS]))
    await press($, 'tip-no')
    expect(shared(h).answered).toBeDefined()
    expect(h.ran.some(a => a.includes('PUT')), 'nothing starred').toBe(false)
    expect(await tipRow($)).toBe('')
  })

  test(`star: a repo GitHub says is starred gets no ask, and the tip is spent (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: SEEN })
    h.files[RUNS_FILE] = SAVED(h.now)
    h.gh = { starred: { [RS]: 'starred' }, canStar: true }
    const d = drive($, h)
    await d.start(surface)
    await d.complete('t0')
    expect(await tipRow($)).toBe('')
    expect((h.store.tips as { seen: string[] }).seen).toContain('star')
    expect(shared(h).starred).toEqual({ [RS]: true })
  })

  test(`star: a whatsnext claim under 7 days old blocks the ask (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: SEEN })
    h.files[RUNS_FILE] = SAVED(h.now)
    h.stars = JSON.stringify({ installed: {}, starred: {}, claim: { by: 'whatsnext', at: new Date(h.now - 2 * DAY).toISOString() } })
    h.gh = { starred: {}, canStar: true }
    const d = drive($, h)
    await d.start(surface)
    await d.complete('t0')
    expect(await tipRow($)).toBe('')
    expect(shared(h).claim?.by).toBe('whatsnext')
  })

  test(`star: CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC stops the GitHub check, so no ask (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: SEEN })
    h.files[RUNS_FILE] = SAVED(h.now)
    h.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
    h.gh = { starred: {}, canStar: true }
    const d = drive($, h)
    await d.start(surface)
    await d.complete('t0')
    expect(await tipRow($)).toBe('')
    expect(h.ran.some(a => a[0] === 'gh'), 'GitHub is not asked').toBe(false)
  })

  test(`star: a stars file that cannot be written means no ask (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: SEEN })
    h.files[RUNS_FILE] = SAVED(h.now)
    h.starsUnwritable = true
    h.gh = { starred: {}, canStar: true }
    const d = drive($, h)
    await d.start(surface)
    await d.complete('t0')
    expect(await tipRow($)).toBe('')
  })
}
