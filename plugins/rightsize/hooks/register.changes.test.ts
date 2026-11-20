import { expect, test } from 'claude-code/testing'
import { CAL_STORE } from './cost'
import { LOG_PATH, LOOKUP, FREE_SWITCHES, engine, drive, last, LOWER } from './testkit'

// P-81 step 1 (ADR 0094): the Changes row and the Prompt, Cache and Compact override rows. The prompt cases (Lowering,
// Raising, Stronger model, Cheaper model) read the Prompt area: a rule row you set wins, else the Prompt row, else Changes.

for (const surface of ['desktop', 'terminal'] as const) {
  const OPUS = { model: 'claude-opus-5-5', effort: 'medium' }
  const withRows = (rows: Record<string, string>) => ({ options: rows, stored: rows })
  const settingsText = async (d: ReturnType<typeof drive>) => (await d.command('status')).text ?? ''

  // One lowerable prompt on Opus, after a first turn so the session's model is known. Returns the Effort questions asked and the effort sent.
  async function lowerable(rows: Record<string, string>, $: never, on: never, run?: (d: ReturnType<typeof drive>, h: ReturnType<typeof engine>) => Promise<void>) {
    const h = engine(on, { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES }, stored: withRows(rows).stored })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    await run?.(d, h)
    h.rating = LOWER
    h.answers = { Effort: 'Lower for this prompt' }
    await d.submit(LOOKUP)
    await d.step('t1')
    return { h, d, asked: h.asked.map(a => a.header), effort: last(h.sent)?.effort }
  }

  const CASES: { name: string; rows: Record<string, string>; asks: boolean }[] = [
    { name: 'default settings: Changes Auto, nothing asks', rows: {}, asks: false },
    { name: 'Changes Ask: the prompt case asks', rows: { changes: 'Ask' }, asks: true },
    { name: 'Changes Ask, Prompt Same as Changes: asks', rows: { changes: 'Ask', promptMode: 'Same as Changes' }, asks: true },
    { name: 'Changes Ask, Prompt Auto: the Prompt row wins, no question', rows: { changes: 'Ask', promptMode: 'Auto' }, asks: false },
    { name: 'Changes Auto, Prompt Ask: the Prompt row wins, asks', rows: { changes: 'Auto', promptMode: 'Ask' }, asks: true },
    { name: 'Changes Ask, Cache Auto and Compact Auto: they are other areas, the prompt still asks', rows: { changes: 'Ask', cacheMode: 'Auto', compactMode: 'Auto' }, asks: true },
    { name: 'Changes Auto, Cache Ask and Compact Ask: other areas, the prompt does not ask', rows: { changes: 'Auto', cacheMode: 'Ask', compactMode: 'Ask' }, asks: false },
    { name: 'a rule row you set (never lower) beats Prompt Ask and Changes Ask: the prompt is not lowered or asked', rows: { changes: 'Ask', promptMode: 'Ask', lowerRule: 'never lower' }, asks: false },
    { name: 'a rule row you set (lower automatically) beats Prompt Ask and Changes Ask: lowers with no question', rows: { changes: 'Ask', promptMode: 'Ask', lowerRule: 'lower automatically' }, asks: false },
    { name: 'a rule row you set (ask me) beats Prompt Auto and Changes Auto: asks', rows: { changes: 'Auto', promptMode: 'Auto', lowerRule: 'ask me' }, asks: true },
  ]
  for (const c of CASES) {
    test(`${c.name} (${surface})`, { timeoutMs: 30000, options: withRows(c.rows).options }, async ($, on) => {
      const { h, asked, effort } = await lowerable(c.rows, $ as never, on as never)
      expect(asked, 'the Effort dialog').toEqual(c.asks ? ['Effort'] : [])
      if (c.rows.lowerRule === 'never lower') expect(effort, 'never lower: kept').toBe('medium')
      else expect(effort, 'answered or acted: lowered').toBe('low')
      if (!c.rows.lowerRule && c.asks) expect(h.files[LOG_PATH] ?? '').toContain('Lowering: no rule set, Changes: Ask decides (ask me)')
      if (!c.rows.lowerRule && !c.asks) expect(h.files[LOG_PATH] ?? '').toContain('Lowering: no rule set, the default decides (lower automatically)')
    })
  }

  test(`Changes switched in /config applies at once, and Prompt switched after it wins (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = LOWER
    await d.submit(LOOKUP)
    expect(h.asked, 'Auto: lowered with no question').toEqual([])
    await d.step('t1')
    await d.complete('t1')
    expect((await d.config('changes', 'Ask')).deny).toBeUndefined()
    expect(await settingsText(d), 'listed as yours').toMatch(/^ {2}Changes: Ask$/m)
    h.answers = { Effort: 'Keep as is' }
    await d.submit(LOOKUP)
    expect(h.asked.map(a => a.header), 'Ask: the Effort dialog').toEqual(['Effort'])
    await d.step('t2')
    await d.complete('t2')
    await d.config('promptMode', 'Auto')
    const asked = h.asked.length
    await d.submit(LOOKUP)
    expect(h.asked.length, 'Prompt Auto: no question').toBe(asked)
    await d.config('promptMode', 'Same as Changes')
    await d.submit(LOOKUP)
    expect(h.asked.length, 'Same as Changes: Ask again').toBe(asked + 1)
  })

  // ---- Migration: a stored Ask before changing value maps to Changes once ----

  for (const [old, mapped] of [['on', 'Ask'], ['off', 'Auto']] as const) {
    test(`a stored Ask before changing ${old} becomes Changes ${mapped}, written once and yours (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
      const h = engine(on, { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES }, stored: { askFirst: old } })
      const d = drive($, h)
      await d.start(surface)
      expect(h.sets.filter(s => s.key === 'rightsize.changes')).toEqual([expect.objectContaining({ key: 'rightsize.changes', value: mapped })])
      expect(h.stored.changes).toBe(mapped)
      expect(await settingsText(d), 'yours: the person had set it').toMatch(new RegExp(`^ {2}Changes: ${mapped}$`, 'm'))
      await d.step('t0')
      await d.complete('t0')
      h.rating = LOWER
      h.answers = { Effort: 'Lower for this prompt' }
      await d.submit(LOOKUP)
      expect(h.asked.map(a => a.header), 'behaves as before').toEqual(old === 'on' ? ['Effort'] : [])
    })
  }

  test(`nothing stored for Ask before changing: nothing is written, and Changes is not yours (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS })
    const d = drive($, h)
    await d.start(surface)
    expect(h.sets.filter(s => s.key === 'rightsize.changes')).toEqual([])
    expect(await settingsText(d)).not.toMatch(/^ {2}Changes: /m)
  })

  test(`a Changes value you set is never overwritten by an old Ask before changing value, in any session (${surface})`, { timeoutMs: 30000, options: { changes: 'Auto' } }, async ($, on) => {
    const h = engine(on, { ...OPUS, stored: { askFirst: 'on', changes: 'Auto' } })
    const d = drive($, h)
    await d.start(surface)
    expect(h.sets.filter(s => s.key === 'rightsize.changes'), 'not written').toEqual([])
    expect(h.stored.changes).toBe('Auto')
    expect(await settingsText(d), 'listed as yours, Auto').toMatch(/^ {2}Changes: Auto$/m)
  })

  test(`the migration runs once: a Changes value set after it stays, even with the old value still stored (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS, stored: { askFirst: 'on' } })
    const d = drive($, h)
    await d.start(surface)
    expect(h.stored.changes).toBe('Ask')
    await d.config('changes', 'Auto')
    await d.start(surface)
    expect(h.stored.changes, 'a new session does not bring the old value back').toBe('Auto')
    expect(h.sets.filter(s => s.key === 'rightsize.changes').map(s => s.value)).toEqual(['Ask', 'Auto'])
  })

  test(`a Quality profile an older release stored still reads as Ask until Changes is set (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES }, stored: { profile: 'Quality' } })
    const d = drive($, h)
    await d.start(surface)
    expect(h.sets.filter(s => s.key === 'rightsize.changes'), 'the profile is read, not copied into a row').toEqual([])
    await d.step('t0')
    await d.complete('t0')
    h.rating = LOWER
    h.answers = { Effort: 'Lower for this prompt' }
    await d.submit(LOOKUP)
    expect(h.asked.map(a => a.header), 'asks, as Quality did').toEqual(['Effort'])
    await d.config('changes', 'Auto')
    const asked = h.asked.length
    await d.step('t1')
    await d.complete('t1')
    await d.submit(LOOKUP)
    expect(h.asked.length, 'the row you set wins').toBe(asked)
  })
}
