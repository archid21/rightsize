import { type TestBody, expect, test } from 'claude-code/testing'
import { KEYS, SETTINGS, type SettingKey, plainTitle } from './settings'
import { LOG_PATH, LOOKUP, NO_CHANGE, BIG_TURN, engine, drive, last, type Mounted, mountPane, bandText, setBand } from './testkit'


// ---- The settings pane: bare /rightsize ----------------------------------------------------------------------

for (const surface of ['desktop', 'terminal'] as const) {
  const PANE_ID = 'rightsize-menu'
  const MIN = 60_000
  const HOUR = 60 * MIN
  const start = async ($: unknown, on: Parameters<TestBody>[1], over: { stored?: Record<string, string>; effort?: string } = {}) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: over.effort ?? 'medium', ...(over.stored ? { stored: over.stored } : {}) })
    const d = drive($, h)
    await d.start(surface)
    return { h, d }
  }
  const selectOf = async (ui: Mounted, key: SettingKey) => (await ui.find({ type: 'Select', key: `row-${key}` }))?.props
  /** The Selects of the pane and the heading, in the order drawn. */
  const drawn = async (ui: Mounted) => {
    const root = (await ui.findAll({ type: 'Box' }))[0]
    return (root?.children ?? []).map(c => (typeof c === 'string' ? c : c.type === 'Select' ? c.props?.key : String(c.children?.[0])))
  }

  test(`bare /rightsize opens the pane and asks nothing; /rightsize status is the old summary (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await start($, on)
    const opened = (await d.command('')).text ?? ''
    expect(h.paneOpens, 'one pane, focused, Esc closes it, toasts held').toEqual([{ id: PANE_ID, title: 'Rightsize', focus: true, closeOnEscape: true, holdToasts: true }])
    expect(opened).toContain('settings are open in a pane')
    expect(opened, 'the summary moved').not.toContain('Ask before changing: off')
    expect(h.asked, 'no question').toEqual([])
    expect(h.paneCloses).toEqual([])
    const status = (await d.command('status')).text ?? ''
    expect(status.startsWith('Ask before changing: off')).toBe(true)
    expect(status).toContain(`All ${KEYS.length} settings are at their defaults`)
    expect(status.endsWith('Commands: /rightsize help')).toBe(true)
    expect(h.paneOpens.length, 'status opens no pane').toBe(1)
  })

  test(`the pane lists every row of the settings table in order, Profile, Mode, Routing, Hand-offs and Cache first, the Advanced ones under a heading, each with its value (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { d } = await start($, on)
    await d.command('')
    const ui = await mountPane($, surface)
    const selects = await ui.findAll({ type: 'Select' })
    expect(selects.map(x => x.key), 'every row, in the table\'s order').toEqual(KEYS.map(k => `row-${k}`))
    for (const key of KEYS) {
      const p = await selectOf(ui, key)
      expect(p?.value, key).toBe(SETTINGS[key].default)
      expect(p?.options?.map(o => o.value), key).toEqual([...SETTINGS[key].options])
      expect(p?.label, key).toBe(`${plainTitle(SETTINGS[key].title)} (default)`)
    }
    const order = await drawn(ui)
    expect(order[0], 'the keys, above the rows').toContain('Tab: next setting · ↑↓: choose a value · Enter: set · Esc: close.')
    expect(order.indexOf('row-mode'), 'Mode first, above the heading: it is not an Advanced row').toBe(1)
    expect(order.slice(2, 6), 'the three switches and Ask before changing follow, above the heading: they are not Advanced rows').toEqual(['row-routing', 'row-handOffs', 'row-askFirst', 'row-cache'])
    expect(order[6], 'the heading').toBe('Advanced')
    expect(order.filter(x => x === 'Advanced').length).toBe(1)
    expect(order.slice(7), 'the Advanced rows follow it, in order').toEqual(KEYS.slice(5).map(k => `row-${k}`))
    await ui.unmount()
  })

  const SET_TWO = { options: { floor: 'medium', band: 'always' }, stored: { floor: 'medium', band: 'always' } }
  test(`a row you set is marked yours; the rest are tagged default (${surface})`, { timeoutMs: 30000, options: SET_TWO.options }, async ($, on) => {
    const { d } = await start($, on, { stored: SET_TWO.stored })
    const ui = await mountPane($, surface)
    expect(await selectOf(ui, 'floor')).toMatchObject({ label: 'Lowest effort (yours)', value: 'medium' })
    expect(await selectOf(ui, 'band')).toMatchObject({ label: 'Band (yours)', value: 'always' })
    expect(await selectOf(ui, 'ceiling')).toMatchObject({ label: 'Highest effort (default)' })
    await ui.unmount()
    // A change in /config shows too.
    await d.config('idleWarning', 'over $1')
    const again = await mountPane($, surface)
    expect(await selectOf(again, 'idleWarning')).toMatchObject({ label: 'Idle warning (yours)', value: 'over $1' })
    await again.unmount()
  })

  test(`picking a value writes the /config row as yours, follows it, and draws the pane again: Band off hides the band (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await start($, on, { effort: 'low' })
    await d.step('t0')
    await d.complete('t0')
    h.rating = NO_CHANGE
    await setBand($, 'always')
    await d.submit(LOOKUP)
    expect(await bandText($, surface)).toBe('No change: low on Opus fits this prompt.')
    await d.command('')
    const ui = await mountPane($, surface)
    const before = h.sets.length
    await ui.select({ key: 'row-band', value: 'off' })
    expect(h.sets.slice(before).map(x => [x.key, x.value]), 'written once, to the /config row').toEqual([['rightsize.band', 'off']])
    expect(h.stored.band, 'as the person\'s own setting').toBe('off')
    expect(await bandText($, surface), 'the side effect ran: the band is hidden').toBe('')
    expect(await selectOf(ui, 'band'), 'the open pane drew again').toMatchObject({ label: 'Band (yours)', value: 'off' })
    expect(((await d.command('status')).text ?? '')).toContain('  Band: off')
    await ui.unmount()
  })

  test(`a change in the pane runs what /config does after a change, once: Before the cache goes cold off stops a keep-warm run (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await start($, on)
    h.now = Date.UTC(2027, 0, 15, 18)
    h.virtual = true
    h.stepUsage = BIG_TURN
    await d.config('beforeCold', 'keep warm 8 h')
    await d.step('t1')
    await d.complete('t1')
    await h.advance(57 * MIN)
    expect(h.forks.length).toBe(1)
    const ui = await mountPane($, surface)
    await ui.select({ key: 'row-beforeCold', value: 'off' })
    await ui.unmount()
    await h.advance(8 * HOUR)
    expect(h.forks.length, 'no more pings').toBe(1)
    const log = h.files[LOG_PATH] ?? ''
    expect(log.split('keep warm stopped (Before the cache goes cold changed)').length - 1, 'followRow ran once').toBe(1)
  })

  test(`picking Ask before changing draws every row again and changes what is in use (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await start($, on)
    const ui = await mountPane($, surface)
    await ui.select({ key: 'row-askFirst', value: 'on' })
    expect(await selectOf(ui, 'askFirst')).toMatchObject({ label: 'Ask before changing (yours)', value: 'on' })
    expect(last(h.sets)).toMatchObject({ key: 'rightsize.askFirst', value: 'on' })
    expect(((await d.command('status')).text ?? '').startsWith('Ask before changing: on')).toBe(true)
    // A rule row set to "not set" goes back to unset, not yours.
    await ui.select({ key: 'row-lowerRule', value: 'never lower' })
    expect(await selectOf(ui, 'lowerRule')).toMatchObject({ label: 'Lowering (yours)', value: 'never lower' })
    await ui.select({ key: 'row-lowerRule', value: 'not set' })
    expect(await selectOf(ui, 'lowerRule')).toMatchObject({ label: 'Lowering (default)', value: 'not set' })
    await ui.unmount()
  })

  test(`a change in /config while the pane is open draws it again (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { d } = await start($, on)
    const ui = await mountPane($, surface)
    await d.config('rater', 'haiku')
    expect(await selectOf(ui, 'rater')).toMatchObject({ label: 'Rater (yours)', value: 'haiku' })
    await ui.unmount()
  })

  const BAND_PAGE = [...Array<string>(6).fill('More…'), 'Band: when it acts']
  test(`with no pane placed it asks instead: pick a row shown as Row: value (paged), pick its value, back to the rows, until Done (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await start($, on)
    h.panePlaced = false
    h.answerQueue = { Setting: ['More…', 'Done'], 'More rows': BAND_PAGE, Value: ['off'] }
    const r = (await d.command('')).text ?? ''
    expect(h.paneCloses, 'the unplaced pane is closed, not left open').toEqual([PANE_ID])
    expect(h.asked[0]?.options, 'Done first, then the rows as Row: value, three to a page').toEqual(['Done', 'Mode: act', 'Routing: on', 'More…'])
    expect(h.asked[1]?.options, 'the switches and Ask before changing fill the second page').toEqual(['Hand-offs: on', 'Ask before changing: off', 'Cache: on', 'More…'])
    expect(h.asked[2]?.options).toEqual(['Lowest effort: low', 'Highest effort: max', 'Lowering: not set', 'More…'])
    const value = h.asked.find(a => a.options.includes('off (current)') || a.options.includes('when it acts (current)'))
    expect(value?.options, 'the values of the row, the current one marked').toEqual(['when it acts (current)', 'always', 'off'])
    expect(value?.question).toContain('Band: now when it acts (default)')
    expect(last(h.sets)).toMatchObject({ key: 'rightsize.band', value: 'off' })
    expect(h.stored.band).toBe('off')
    expect(h.asked.slice(-1)[0]?.options.slice(0, 1), 'back to the rows, which show the new value').toEqual(['Done'])
    expect(h.asked.slice(-1)[0]?.options.length).toBe(4)
    expect(r).toBe('Changed Band: off.')
    expect(((await d.command('status')).text ?? '')).toContain('  Band: off')
  })

  test(`the question loop ends on a dismissed question, and a dismissed value changes nothing (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await start($, on)
    h.panePlaced = false
    h.answers = {}
    expect((await d.command('')).text, 'dismissed at once').toBe('No setting changed.')
    h.answerQueue = { Setting: ['More…', 'Done'], 'More rows': ['Ask before changing: off'] }
    expect((await d.command('')).text, 'the value was dismissed: back to the rows').toBe('No setting changed.')
    h.answerQueue = { Setting: ['More…', 'Done'], 'More rows': ['Ask before changing: off'], Value: ['off (current)'] }
    expect((await d.command('')).text, 'the current value again: nothing to write').toBe('No setting changed.')
    expect(h.sets.filter(x => x.key === 'rightsize.askFirst')).toEqual([])
    h.answerQueue = { Setting: ['More…', 'Done'], 'More rows': ['Ask before changing: off'], Value: ['on'] }
    expect((await d.command('')).text).toBe('Changed Ask before changing: on.')
  })
}

test('on the mobile app, which has no picker, bare /rightsize asks at once, and the pane lists the rows with a button that asks', async ($, on) => {
  const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
  const d = drive($, h)
  await d.start('mobile')
  h.answerQueue = { Setting: ['More…', 'Done'], 'More rows': ['Ask before changing: off'], Value: ['on'] }
  expect((await d.command('')).text).toBe('Changed Ask before changing: on.')
  expect(h.paneOpens, 'no pane for a surface with no picker').toEqual([])
  const ui = await mountPane($, 'mobile')
  expect(await ui.findAll({ type: 'Select' })).toEqual([])
  expect((await ui.find({ type: 'Text', text: /^Ask before changing/ }))?.text).toBe('Ask before changing (yours): on')
  expect((await ui.find({ type: 'Text', text: /^Band/ }))?.text).toBe('Band (default): when it acts')
  h.answerQueue = { Setting: ['More…', 'Done'], 'More rows': ['Ask before changing: on'], Value: ['off'] }
  await ui.press({ key: 'change' })
  await ui.unmount()
  expect(last(h.sets)).toMatchObject({ key: 'rightsize.askFirst', value: 'off' })
})
