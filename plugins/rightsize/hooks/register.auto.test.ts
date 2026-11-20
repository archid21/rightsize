import { expect, test } from 'claude-code/testing'
import { CAL_STORE } from './cost'
import { DEBUG, FREE_SWITCHES, LOOKUP, NO_CHANGE, REVIEW, SEARCH, engine, drive, last, mount, rowText, bandText, LOWER } from './testkit'

// P-81 step 2 (ADR 0094, Group 1 and general rules 2 and 6): when the Prompt area resolves to Auto the band's Prompt row is
// one line saying what was done and at most one undo button that names the level or model ("Redo at high", "Redo on Opus").
// It stays until the next prompt. The rule buttons are in the ⋯ menu only. Prompt Off makes no prompt change and has no row.

for (const surface of ['desktop', 'terminal'] as const) {
  const buttons = async ($: unknown) => {
    const ui = await mount($, surface)
    const found = (await ui.findAll({ type: 'Button' })).map(b => ({ key: String(b.props?.key), label: String(b.props?.label ?? '') }))
    await ui.unmount()
    return found
  }
  const keys = async ($: unknown) => (await buttons($)).map(b => b.key)
  const labelOf = async ($: unknown, key: string) => (await buttons($)).find(b => b.key === key)?.label
  const promptRows = async ($: unknown) => {
    const ui = await mount($, surface)
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text ?? '')
    await ui.unmount()
    return texts.filter(t => t === 'Prompt' || t === 'rightsize · Prompt')
  }

  const HIGH_OPUS = { model: 'claude-opus-5-5', effort: 'high', store: { [CAL_STORE]: FREE_SWITCHES } }
  const HAND_OFF = '{"level":"low","model":"haiku","size":"bulky","type":"search","read":150000,"write":3000,"steps":30,"reason":"repo-wide search"}'
  const RULE_LABELS = ['Ask me each time', 'Ask first', 'Never lower', 'Lower automatically', 'Always send', 'Stay, lower effort only', 'Stay, raise effort only']

  test(`Auto, a lowering: "Effort lowered: high → low", and one undo that names the level (${surface})`, { timeoutMs: 30000, options: { cacheTimer: 'off' } }, async ($, on) => {
    const h = engine(on, HIGH_OPUS)
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = LOWER
    await d.submit(LOOKUP)
    expect(await bandText($, surface)).toMatch(/^Effort lowered: high → low\. Why: One function lookup\./)
    expect(await bandText($, surface), 'no "for this prompt (automatically)"').not.toContain('automatically')
    expect(await keys($), 'one undo, then the band controls: no rule buttons').toEqual(['retry', 'fold', 'mode', 'close'])
    expect(await labelOf($, 'retry'), 'names the level; the first time it says it runs again').toBe('Redo at high (runs again)')
  })

  test(`Auto, a hand-off to a cheaper helper: "Sent to Haiku · …", and Redo on Opus (${surface})`, { timeoutMs: 30000, options: { cacheTimer: 'off' } }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = HAND_OFF
    await d.submit(SEARCH)
    expect(await bandText($, surface)).toMatch(/^Sent to Haiku · (\$[\d.]+ vs ~\$[\d.]+ on Opus|~\d+% of the Opus usage)\./)
    expect(await keys($), 'one undo; Ask first and Stay are not on the row').toEqual(['stay', 'fold', 'mode', 'close'])
    expect(await labelOf($, 'stay')).toBe('Redo on Opus (runs again)')
  })

  test(`Auto, a review from a Sonnet start: "Review ran on Opus for this turn", and Redo on Sonnet (${surface})`, { timeoutMs: 30000, options: { cacheTimer: 'off' } }, async ($, on) => {
    const h = engine(on, { model: 'claude-sonnet-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = REVIEW
    await d.submit(DEBUG)
    expect(await bandText($, surface)).toMatch(/^Review ran on Opus for this turn\./)
    expect(await keys($)).toEqual(['stay', 'fold', 'mode', 'close'])
    expect(await labelOf($, 'stay')).toBe('Redo on Sonnet (runs again)')
  })

  test(`an Auto row has none of the rule buttons: they are in the ⋯ menu only (${surface})`, { timeoutMs: 30000, options: { cacheTimer: 'off' } }, async ($, on) => {
    const h = engine(on, HIGH_OPUS)
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = LOWER
    await d.submit(LOOKUP)
    const labels = (await buttons($)).map(b => b.label)
    for (const rule of RULE_LABELS) expect(labels.join(' | ')).not.toContain(rule)
    h.answers = { Options: 'When the band shows…' }
    const ui = await mount($, surface)
    const before = h.asked.length
    await ui.press({ key: 'mode' })
    for (let i = 0; i < 100 && h.asked.length === before; i++) await new Promise(r => setTimeout(r, 10))
    await ui.unmount()
    expect(h.asked.at(-1)?.options, 'the ⋯ menu still lists the Lowering rules').toContain('Lower automatically')
  })

  test(`the undo of a hand-off stays after the turn's result row replaces the line, and is gone at the next prompt (${surface})`, { timeoutMs: 30000, options: { cacheTimer: 'off' } }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = HAND_OFF
    await d.submit(SEARCH)
    await d.step('t1', 0)
    await d.agent('haiku')
    await d.step('t1', 0, 'a2')
    await d.step('t1', 1)
    await d.complete('t1')
    expect(await bandText($, surface), 'the result row is the newer band row').toMatch(/^Sent to Haiku\./)
    expect(await keys($), 'the undo is still there').toEqual(['stay', 'fold', 'mode', 'close'])
    expect(await labelOf($, 'stay')).toBe('Redo on Opus (runs again)')

    // Nothing to change on the next prompt: Lowering never.
    await d.config('lowerRule', 'never lower')
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    expect(await keys($), 'the next prompt takes it away').not.toContain('stay')
    expect(await bandText($, surface)).toBe('')
    await d.step('t2')
    await d.complete('t2')
    expect(await keys($), 'and it does not come back').not.toContain('stay')
  })

  test(`the undo of a lowering stays through a newer row of the same turn, until the next prompt (${surface})`, { timeoutMs: 30000, options: { cacheTimer: 'off' } }, async ($, on) => {
    const h = engine(on, HIGH_OPUS)
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = LOWER
    await d.submit(LOOKUP)
    await d.step('t1', 0)
    // Claude looks stuck: a newer row ("Effort back to ...") replaces the lowering's line.
    await d.bash('fail make')
    await d.bash('fail make')
    await d.step('t1', 1)
    await d.step('t1', 2)
    await d.complete('t1')
    expect(await keys($), 'still one undo').toContain('retry')
    expect((await keys($)).filter(k => k === 'retry' || k === 'stay').length).toBe(1)
    await d.config('lowerRule', 'never lower')
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    expect(await keys($)).not.toContain('retry')
    expect(await bandText($, surface)).toBe('')
  })

  test(`only the first undo says it runs again and costs again (${surface})`, { timeoutMs: 30000, options: { cacheTimer: 'off' } }, async ($, on) => {
    const h = engine(on, HIGH_OPUS)
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = LOWER
    await d.submit(LOOKUP)
    expect(await labelOf($, 'retry')).toBe('Redo at high (runs again)')
    await d.step('t1')
    await d.complete('t1')
    expect(await labelOf($, 'retry'), 'the same offer keeps its note').toBe('Redo at high (runs again)')
    await d.submit(LOOKUP)
    expect(await labelOf($, 'retry'), 'a second undo is plain').toBe('Redo at high')
    expect(h.store.undoSeen, 'remembered in the store').toBe(true)
  })

  test(`Redo at high puts the prompt back in the box and closes the row, as Retry did (${surface})`, { timeoutMs: 30000, options: { cacheTimer: 'off' } }, async ($, on) => {
    const h = engine(on, HIGH_OPUS)
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = LOWER
    await d.submit(LOOKUP)
    const ui = await mount($, surface)
    await ui.press({ key: 'retry' })
    await ui.unmount()
    expect(h.filled.at(-1)).toBe(LOOKUP)
    expect(last(h.toasts) ?? '').toContain('run it at high')
    expect(await bandText($, surface)).toBe('')
  })

  // ---- Prompt Off ----

  const OFF = { promptMode: 'Off' }

  test(`Prompt Off: a lowerable prompt is not rated or lowered, and the band has no Prompt row (${surface})`, { timeoutMs: 30000, options: OFF }, async ($, on) => {
    const h = engine(on, { ...HIGH_OPUS, stored: OFF })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    const rated = h.ratings
    h.rating = LOWER
    await d.submit(LOOKUP)
    await d.step('t1')
    expect(h.ratings, 'no rating call').toBe(rated)
    expect(last(h.sent)?.effort, 'effort is the session\'s own').toBe('high')
    expect(h.asked, 'no question').toEqual([])
    expect(await promptRows($), 'no Prompt row').toEqual([])
    expect(await keys($)).not.toContain('retry')
    await d.complete('t1')
    expect(await promptRows($)).toEqual([])
  })

  test(`Prompt Off: no hand-off (${surface})`, { timeoutMs: 30000, options: OFF }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', stored: OFF })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = HAND_OFF
    await d.submit(SEARCH)
    expect(last(h.submitted)?.context ?? [], 'no subagent note').toEqual([])
    expect(await promptRows($)).toEqual([])
    await d.step('t1')
    await d.complete('t1')
    expect(await promptRows($)).toEqual([])
  })

  test(`Prompt Off: no review switch (${surface})`, { timeoutMs: 30000, options: OFF }, async ($, on) => {
    const h = engine(on, { model: 'claude-sonnet-5-5', effort: 'medium', stored: OFF, store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = REVIEW
    await d.submit(DEBUG)
    await d.step('t1')
    expect(last(h.sent)?.model, 'the review stays on the session model').not.toBe('opus')
    expect(await promptRows($)).toEqual([])
  })

  test(`Prompt Off: no mid-turn raise, even with Raising automatic (${surface})`, { timeoutMs: 30000, options: OFF }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { remember: true, choices: { raise: 'auto' } }, stored: OFF })
    const d = drive($, h)
    await d.start(surface)
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    await d.step('t1', 0)
    await d.bash('fail npm test')
    await d.bash('fail npm test')
    await d.step('t1', 1)
    await d.step('t1', 2)
    expect(last(h.sent)?.effort, 'no raise').toBe('medium')
    expect(h.question, 'no question').toBeNull()
    expect(await promptRows($)).toEqual([])
  })

  test(`Prompt Off leaves the Cache row alone: the timer still shows (${surface})`, { timeoutMs: 30000, options: OFF }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', stored: OFF })
    h.now = new Date(2027, 0, 15, 18, 0, 0, 0).getTime()
    h.virtual = true
    h.rating = NO_CHANGE
    h.stepUsage = { input_tokens: 200, output_tokens: 400, cache_read_input_tokens: 19_500, cache_creation_input_tokens: 300 }
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    const ui = await mount($, surface)
    const cache = await rowText(ui, 'Cache')
    await ui.unmount()
    expect(cache).toContain('until 7:00 PM')
    expect(await promptRows($)).toEqual([])
  })
}
