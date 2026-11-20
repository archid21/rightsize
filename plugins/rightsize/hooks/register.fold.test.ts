import { type TestBody, expect, test } from 'claude-code/testing'
import { LOOKUP, LOWER, NO_CHANGE, NO_ONE, drive, engine, last, mount } from './testkit'
import { bandKindOf } from './register'

// The band's fold: one button, ▾ to fold and ▴ to unfold, remembered in the store. A folded band is one line: the
// summary, a marker for a waiting question, the question's own buttons, then ▴ ⋯ ×.

const COLD = 'Goes cold in 55 min ▰▰▰▰▰▰▰▰▰▱ (19:00) · coming back after costs about $0.63'
const COLD_TONE = { text: '55 min ▰▰▰▰▰▰▰▰▰▱', color: 'success' }

type Texts = { text: string; color?: string }[]
const texts = async (ui: Awaited<ReturnType<typeof mount>>): Promise<Texts> =>
  (await ui.findAll({ type: 'Text' })).map(t => ({ text: t.text ?? '', ...((t.props as { color?: string } | undefined)?.color ? { color: (t.props as { color: string }).color } : {}) }))
const buttons = async (ui: Awaited<ReturnType<typeof mount>>) => (await ui.findAll({ type: 'Button' })).map(b => b.props as { key?: string; label?: string; hotkey?: string })

for (const surface of ['desktop', 'terminal'] as const) {
  const session = async ($: unknown, on: Parameters<TestBody>[1], over: { folded?: boolean; virtual?: boolean; patch?: Record<string, Record<string, unknown>>; effort?: string } = {}) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: over.effort ?? 'low', ...(over.folded ? { store: { bandFolded: true } } : {}) })
    if (over.patch) h.patch = over.patch
    // The kit's repeating timer fires without end unless it runs on the virtual clock, where only `advance` ticks it.
    h.virtual = true
    h.ticks = true
    const d = drive($, h)
    await d.start(surface)
    return { h, d }
  }
  /** Claude looks stuck and Raising asks: the band holds a Stuck question (nobody answers yet). */
  const stuck = async ($: unknown, on: Parameters<TestBody>[1], over: { folded?: boolean; virtual?: boolean; patch?: Record<string, Record<string, unknown>> } = {}) => {
    const { h, d } = await session($, on, over)
    await d.step('t0')
    await d.complete('t0')
    await d.config('raiseRule', 'ask me')
    h.rating = NO_CHANGE
    h.answers = { Stuck: NO_ONE, Workflow: NO_ONE }
    await d.submit(LOOKUP)
    await d.step('t1', 0)
    await d.bash('fail make')
    await d.bash('fail make')
    await d.step('t1', 1)
    return { h, d }
  }
  /** A prompt lowered on Opus: the band has a Prompt row from a real run. `patch` adds fields to what the plugin writes. */
  const lowered = async ($: unknown, on: Parameters<TestBody>[1], over: { folded?: boolean; patch?: Record<string, Record<string, unknown>> } = {}) => {
    const { h, d } = await session($, on, { ...over, effort: 'high' })
    await d.step('t0')
    await d.complete('t0')
    h.rating = LOWER
    await d.submit(LOOKUP)
    await d.step('t1', 0)
    const text = String((last(h.stateWrites.filter(w => w.key === 'band' && w.value)) as { value: { text: string } }).value.text)
    return { h, d, text }
  }
  const view = async ($: unknown) => {
    const ui = await mount($, surface)
    const r = { texts: await texts(ui), buttons: await buttons(ui), ui }
    return r
  }

  test(`the fold button is ▾ when unfolded, has no number key, and folds with a press; ▴ unfolds (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h } = await lowered($, on)
    let v = await view($)
    const fold = v.buttons.find(b => b.key === 'fold')
    expect(fold?.label).toBe('▾')
    expect(fold?.hotkey, 'no number key').toBeUndefined()
    expect(v.buttons.map(b => b.key).slice(-3), 'before ⋯ and ×').toEqual(['fold', 'mode', 'close'])
    expect(v.buttons.filter(b => b.hotkey).map(b => b.hotkey), 'the numbers are as before').toEqual(v.buttons.filter(b => b.hotkey).map((_, i) => String(i + 1)))
    await v.ui.press({ key: 'fold' })
    await v.ui.unmount()
    expect(h.store.bandFolded, 'remembered in the store').toBe(true)
    expect(h.stateWrites.some(w => w.key === 'bandFolded' && w.value === true), 'and in plugin state').toBe(true)
    v = await view($)
    expect(v.buttons.find(b => b.key === 'fold')?.label).toBe('▴')
    await v.ui.press({ key: 'fold' })
    await v.ui.unmount()
    expect(h.store.bandFolded).toBe(false)
    v = await view($)
    expect(v.buttons.find(b => b.key === 'fold')?.label).toBe('▾')
    await v.ui.unmount()
  })

  test(`the fold lasts across sessions: a later session starts folded (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    await lowered($, on, { folded: true })
    const v = await view($)
    expect(v.buttons.find(b => b.key === 'fold')?.label).toBe('▴')
    await v.ui.unmount()
  })

  test(`a folded band is one line: the first sentence of the route, the cache countdown in its color, then ▴ ⋯ × (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { text } = await lowered($, on, { folded: true, patch: { band: { coldText: COLD, coldTone: COLD_TONE } } })
    const v = await view($)
    const t = v.texts
    const first = text.split(/(?<=[.!?])\s/)[0]!
    expect(t.map(x => x.text), 'the route: its first sentence').toContain(first)
    expect(t.some(x => x.text.length > 60 && !x.text.startsWith('Cache')), 'nothing longer than the summary').toBe(false)
    expect(t.some(x => x.text.includes('Cache') && x.text.includes('Goes cold in')), 'the cache part').toBe(true)
    expect(t.some(x => x.text.includes('coming back after')), 'without the offer text').toBe(false)
    expect(t.find(x => x.color === 'success')?.text, 'the countdown keeps its color').toBe('55 min ▰▰▰▰▰▰▰▰▰▱')
    expect(t.some(x => x.text === 'Prompt' || x.text === 'rightsize · Prompt'), 'no row labels').toBe(false)
    expect(v.buttons.map(b => b.label), 'the route row buttons are hidden').toEqual(['▴', '⋯', '×'])
    await v.ui.unmount()
  })

  test(`a long route sentence is cut short (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    await lowered($, on, { folded: true, patch: { band: { text: `Lowered to low on Opus ${'because '.repeat(30)}end.` } } })
    const v = await view($)
    const line = v.texts.find(x => x.text.startsWith('Lowered'))?.text ?? ''
    expect(line.length).toBeLessThanOrEqual(60)
    expect(line.endsWith('…')).toBe(true)
    await v.ui.unmount()
  })

  // The marker's word and color come from the question's kind.
  const LOOKS = [
    ['risk', 'Work at risk', 'error'],
    ['cost', 'Costs more', 'warning'],
    ['cache', 'Cache', 'suggestion'],
    ['setting', 'Setting', 'subtle'],
  ] as const
  for (const [kind, word, color] of LOOKS) {
    test(`a ${kind} question shows ● and "${word}" in ${color}, then its header (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
      await stuck($, on, { folded: true, patch: { question: { kind } } })
      const v = await view($)
      expect(v.texts.find(x => x.text === '●')?.color, 'the dot').toBe(color)
      const at = v.texts.findIndex(x => x.text === word)
      expect(v.texts[at]?.color, "the word's color").toBe(color)
      expect(v.texts[at + 1]?.text, 'then the header').toBe(': Stuck')
      await v.ui.unmount()
    })
  }

  test(`no question, no marker (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    await lowered($, on, { folded: true })
    const v = await view($)
    expect(v.texts.some(x => x.text === '●')).toBe(false)
    await v.ui.unmount()
  })

  test(`each question kind maps to a marker kind; an unlisted kind is a setting (${surface})`, async () => {
    const risk = ['stuck', 'helper', 'spend', 'bigDuring']
    const cost = ['billing', 'bigAmount', 'bigPick']
    const setting = ['workflow', 'output', 'watchTrial', 'watchSummary', 'bigOptIn', 'bigStop', 'somethingNew']
    for (const k of risk) expect(bandKindOf(k)).toBe('risk')
    for (const k of cost) expect(bandKindOf(k)).toBe('cost')
    expect(bandKindOf('cacheLife')).toBe('cache')
    for (const k of setting) expect(bandKindOf(k)).toBe('setting')
  })

  test(`a question put on the band carries its kind (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h } = await stuck($, on)
    expect((h.question as unknown as { kind?: string })?.kind).toBe('risk')
    expect((h.question as unknown as { blocks?: boolean })?.blocks, 'nothing blocks today').toBeUndefined()
  })

  test(`its buttons keep number keys while folded, and a press answers it (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await stuck($, on, { folded: true })
    const ui = await mount($, surface)
    const options = (await buttons(ui)).filter(b => String(b.key).startsWith('q-') && b.key !== 'q-close')
    expect(options.map(b => b.hotkey)).toEqual(['1', '2'])
    expect((await texts(ui)).some(x => x.text === '●')).toBe(true)
    await ui.press({ key: 'q-0' })
    await ui.unmount()
    await d.step('t1', 2)
    expect(last(h.sent)?.effort, 'the answer applies').toBe('medium')
    expect(h.question).toBeNull()
    await d.complete('t1')
  })

  test(`× on a folded band closes it, and a waiting question gets no answer (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await stuck($, on, { folded: true })
    const ui = await mount($, surface)
    await ui.press({ key: (await ui.find({ type: 'Button', key: 'q-close' })) ? 'q-close' : 'close' })
    await ui.unmount()
    await d.step('t1', 2)
    expect(h.question).toBeNull()
    expect(last(h.sent)?.effort).toBe('low')
    await d.complete('t1')
  })

  test(`a question that blocks shows unfolded, and the stored fold stays (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h } = await stuck($, on, { folded: true, patch: { question: { blocks: true } } })
    const v = await view($)
    expect(v.texts.some(x => x.text === '●'), 'no folded marker').toBe(false)
    expect(v.texts.some(x => x.text.includes('the same tool call failed twice')), 'the question row').toBe(true)
    expect(v.buttons.some(b => b.key === 'fold'), 'no fold button while it blocks').toBe(false)
    await v.ui.unmount()
    expect(h.store.bandFolded, 'the stored fold is unchanged').toBe(true)
  })

  // The dot blinks for 10 seconds from when the question first shows folded, then stays lit.
  const dot = async ($: unknown) => {
    const ui = await mount($, surface)
    const on = (await texts(ui)).some(x => x.text === '●')
    await ui.unmount()
    return on
  }

  test(`the dot blinks every 500 ms for 10 seconds, then stays lit, and the timer stops (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h } = await stuck($, on, { folded: true, virtual: true })
    expect(h.everies, 'a 500 ms timer').toContain(500)
    expect(await dot($), 'lit at first').toBe(true)
    await h.advance(500)
    expect(await dot($), 'off').toBe(false)
    await h.advance(500)
    expect(await dot($), 'on').toBe(true)
    await h.advance(500)
    expect(await dot($), 'off again').toBe(false)
    await h.advance(9_000)
    expect(await dot($), 'after 10 s: lit').toBe(true)
    const redraws = h.invalidations
    await h.advance(5_000)
    expect(h.invalidations, 'no more redraws: the timer is gone').toBe(redraws)
    expect(await dot($), 'and it stays lit').toBe(true)
  })

  test(`an answer stops the blinking (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h } = await stuck($, on, { folded: true, virtual: true })
    await h.advance(500)
    const ui = await mount($, surface)
    await ui.press({ key: 'q-1' })
    await ui.unmount()
    const redraws = h.invalidations
    await h.advance(3_000)
    expect(h.invalidations).toBe(redraws)
  })

  test(`unfolding stops the blinking (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h } = await stuck($, on, { folded: true, virtual: true })
    await h.advance(500)
    const ui = await mount($, surface)
    await ui.press({ key: 'fold' })
    await ui.unmount()
    const redraws = h.invalidations
    await h.advance(3_000)
    expect(h.invalidations).toBe(redraws)
  })

  test(`a question that shows on an unfolded band does not blink (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h } = await stuck($, on, { virtual: true })
    expect(h.everies.includes(500)).toBe(false)
  })
}
