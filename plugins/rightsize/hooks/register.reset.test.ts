import { expect, test } from 'claude-code/testing'
import { CAL_STORE } from './cost'
import { KEYS, SETTINGS, type SettingKey, plainTitle } from './settings'
import { RUNS_FILE, LOG_PATH, LEGACY_RUNS, LOOKUP, DEBUG, NO_ONE, SEARCH, NO_CHANGE, FREE_SWITCHES, cellsOf, engine, drive, settle, untilAsked, DAY, last, mount, bandText, LOWER } from './testkit'

declare const setTimeout: (fn: (...a: unknown[]) => void, ms: number) => unknown

for (const surface of ['desktop', 'terminal'] as const) {
  const readRuns = (h: ReturnType<typeof engine>) => (h.files[RUNS_FILE] ?? '').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)

  const RUNS = LEGACY_RUNS
  /** 60 rated prompts on Opus at medium that Sonnet could do at medium: a cheaper start. */
  const easyLog = (now: number) =>
    Array.from({ length: 60 }, (_, i) =>
      JSON.stringify({
        at: new Date(now - (60 - i) * 60_000).toISOString(),
        kind: 'run',
        type: 'feature',
        route: 'main',
        tier: 'opus',
        level: 'medium',
        normal: 'medium',
        fit: { haiku: null, sonnet: 'medium', opus: 'low', fable: 'low' },
        read: 8000,
        write: 2000,
        steps: 8,
        context: 60_000,
      }),
    ).join('\n')
  const runLines = (h: ReturnType<typeof engine>) =>
    (h.files[RUNS_FILE] ?? '')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l) as Record<string, unknown>)
  const settingsText = async (d: ReturnType<typeof drive>) => (await d.command('status')).text ?? ''
  // A row in the "you changed" list: indented, with no (default) or (detected) mark after it.
  // Only the list of changed rows counts: the Now section below it has a Mode line of its own.
  const listed = (t: string, title: string) => new RegExp(`^  ${title}: [^(\\n]+$`, 'm').test(t.split('\nNow\n')[0] ?? t)
  const changedCount = (t: string) => Number(/You changed (\d+) setting/.exec(t)?.[1] ?? 0)
  const OPUS = { model: 'claude-opus-5-5', effort: 'medium' }
  const noteOf = (h: ReturnType<typeof engine>) => last(h.submitted)?.context?.join('\n') ?? ''
  const handedTo = (h: ReturnType<typeof engine>) => /model "(\w+)"/.exec(noteOf(h))?.[1]
  // A raise fixture: a review, the one task type whose rated raise is still taken at prompt time on Opus (ADR 0021).
  const RAISE_HIGH = '{"level":"high","model":"same","type":"review","read":20000,"write":3000,"steps":8,"reason":"unknown cause"}'
  const lookupLog = (h: { now: number }, steppedUp: number) =>
    Array.from({ length: 6 }, (_, i) => JSON.stringify({ at: new Date(h.now - (6 - i) * 60_000).toISOString(), kind: 'run', type: 'lookup', route: 'main', tier: 'opus', change: 'lower', steppedUp: i < steppedUp })).join('\n') + '\n'

  // Remember follows a rule the person sets, here from the band's ⋯ menu on a raise (the default answers are not asked about).
  /** A prompt rated for a raise (the default raises on its own), and the person picks "Never raise" in the band's ⋯ menu. */
  const setRaiseFromBand = async ($: unknown, h: ReturnType<typeof engine>, d: ReturnType<typeof drive>, answers: Record<string, string> = {}) => {
    h.rating = RAISE_HIGH
    await d.submit(DEBUG)
    h.answers = { Options: 'Never raise', ...answers }
    const before = h.asked.length
    const ui = await mount($, surface)
    await ui.press({ key: 'mode' })
    await untilAsked(h, before)
    await ui.unmount()
  }

  // ---- /rightsize reset ------------------------------------------------------------------------------------

  const SETTINGS_GO = "Every rightsize setting in /config goes back to its default, and your saved answers to the four questions are forgotten. This can't be undone."
  const MEASURE_GO = "rightsize goes back to its starting estimates and relearns from your next prompts. This can't be undone."
  const SOME_SET = { floor: 'medium', idleWarning: 'over $1', lowerRule: 'never lower', remember: 'every session', billing: 'api', band: 'always', pacing: 'off' }

  // A session with settings made, answers saved, and a cost measurement behind it.
  const measured = (h: ReturnType<typeof engine>) => {
    h.now = Date.now()
    h.store.pricesCheckedAt = h.now
    h.files[RUNS] = lookupLog(h, 3) + easyLog(h.now) + '\n'
  }
  const MEASURE_STORE = {
    [CAL_STORE]: { ...FREE_SWITCHES, 'lookup:main': { n: 5, ratio: 1.5 } },
    ties: 7,
    spotChecks: 3,
    startCheckedAt: 1_800_000_000_000 - DAY,
    startSnooze: { key: 'sonnet:high', until: 1_900_000_000_000 },
    remember: true,
    choices: { raise: 'auto' },
  }

  test(`/rightsize reset asks what to reset, with four choices, then confirms with what goes (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS })
    const d = drive($, h)
    await d.start(surface)
    h.answers = { Reset: 'Cancel' }
    const out = await d.command('reset')
    expect(h.asked.map(a => a.header)).toEqual(['Reset'])
    expect(h.asked[0]?.question).toBe('What should I reset?')
    expect(h.asked[0]?.options).toEqual(['Settings', 'Cost measurement', 'Both', 'Cancel'])
    expect(out.text).toBe('Nothing was reset.')
    for (const [choice, text] of [
      ['Settings', `Reset settings? ${SETTINGS_GO}`],
      ['Cost measurement', `Reset cost measurement? ${MEASURE_GO}`],
      ['Both', `Reset settings and cost measurement? ${SETTINGS_GO.replace(" This can't be undone.", '')} ${MEASURE_GO}`],
    ] as const) {
      h.asked.length = 0
      h.answers = { Reset: choice, Confirm: 'No' }
      expect((await d.command('reset')).text, choice).toBe('Nothing was reset.')
      expect(h.asked.map(a => a.header), choice).toEqual(['Reset', 'Confirm'])
      expect(h.asked[1]?.question, choice).toBe(text)
      expect(h.asked[1]?.options, choice).toEqual(['Yes', 'No'])
    }
  })

  for (const choice of ['Settings', 'Cost measurement', 'Both', 'Cancel']) {
    for (const confirm of ['No', 'closed']) {
      if (choice === 'Cancel' && confirm === 'closed') continue
      test(`/rightsize reset ${choice}${choice === 'Cancel' ? '' : `, ${confirm === 'No' ? 'confirmed with No' : 'confirmation closed'}`}: nothing changes (${surface})`, { timeoutMs: 30000, options: SOME_SET }, async ($, on) => {
        const h = engine(on, { ...OPUS, store: MEASURE_STORE, stored: SOME_SET })
        measured(h)
        const d = drive($, h)
        await d.start(surface)
        const store = JSON.stringify(h.store)
        const stored = JSON.stringify(h.stored)
        const sets = h.sets.length
        const before = await settingsText(d)
        h.answers = { Reset: choice, ...(confirm === 'No' ? { Confirm: 'No' } : {}) }
        expect((await d.command('reset')).text).toBe('Nothing was reset.')
        expect(JSON.stringify(h.store), 'the store').toBe(store)
        expect(JSON.stringify(h.stored), 'the settings file').toBe(stored)
        expect(await settingsText(d)).toBe(before)
        expect(h.sets.length, 'nothing was written').toBe(sets)
      })
    }
  }

  const ROWS_RESET = Object.keys(SOME_SET)
  const resetSettingsRun = async ($: unknown, h: ReturnType<typeof engine>, choice: string) => {
    const d = drive($, h)
    await d.start(surface)
    h.rating = LOWER
    h.answers = { Reset: choice, Confirm: 'Yes' }
    const before = h.sets.length
    return { d, before, out: (await d.command('reset')).text ?? '' }
  }
  for (const choice of ['Settings', 'Both']) {
    test(`/rightsize reset ${choice}: every row is back to its default, and shows (default) though the stored value equals the default (${surface})`, { timeoutMs: 30000, options: SOME_SET }, async ($, on) => {
      const h = engine(on, { ...OPUS, store: MEASURE_STORE, stored: SOME_SET })
      measured(h)
      const { d, out, before } = await resetSettingsRun($, h, choice)
      expect(out).toContain('Every setting is back to its default, and the saved answers are forgotten.')
      const text = await settingsText(d)
      expect(text).toContain('are at their defaults')
      for (const key of KEYS) expect(listed(text, plainTitle(SETTINGS[key].title)), key).toBe(false)
      // The defaults were written, through the config API (plugin origin), where the value was not already the default.
      for (const key of ROWS_RESET) expect(h.stored[key], `${key} stored as its default`).toBe(SETTINGS[key as SettingKey].default)
      // Raising was the saved answer, shown in its row at the start: the reset writes it back to not set.
      expect(h.sets.slice(before).map(x => x.key.replace('rightsize.', '')).sort(), 'only the rows that were not default').toEqual(['band', 'floor', 'idleWarning', 'lowerRule', 'pacing', 'raiseRule', 'remember'])
      // billing was stored as api, which is the default: reset without a write.
      expect(h.stored.billing).toBe('api')
      expect(h.store.choices, 'saved answers cleared').toBeNull()
      for (const key of ROWS_RESET) expect(h.store.resetFields, `${key} is on the list`).toContain(key)
      // The saved answers are gone from this session too: Raising (saved as automatic) is no rule now, so the default decides again.
      h.rating = RAISE_HIGH
      const asked = h.asked.length
      await d.submit(DEBUG)
      expect(h.asked.slice(asked), 'nothing is asked').toEqual([])
      expect(h.files[LOG_PATH] ?? '').toContain('Raising: no rule set, the default decides (raise automatically)')
      // A new session still shows defaults: the stored values equal them, and no answer was given since.
      await d.start(surface)
      const again = await settingsText(d)
      expect(changedCount(again), 'nothing is yours').toBe(0)
      expect(again).toContain('are at their defaults')
      // Reports is read off the rate limits once a prompt went through, and saved: not yours either.
      for (const key of ROWS_RESET.filter(k => k !== 'billing')) expect(listed(again, plainTitle(SETTINGS[key as SettingKey].title)), key).toBe(false)
      expect(again).toContain('Reports: api (saved)')
    })
  }

  test(`a row reset then set again in /config is yours again, whatever its value, and leaves the list (${surface})`, { timeoutMs: 30000, options: SOME_SET }, async ($, on) => {
    const h = engine(on, { ...OPUS, stored: SOME_SET })
    const { d } = await resetSettingsRun($, h, 'Settings')
    expect(await settingsText(d)).not.toContain('Lowest effort:')
    await d.config('floor', 'high')
    expect(await settingsText(d)).toContain('Lowest effort: high')
    expect(h.store.resetFields).not.toContain('floor')
    expect(h.store.resetFields, 'the others stay on it').toContain('idleWarning')
    // Set to the default value itself: yours too.
    await d.config('idleWarning', 'over $0.50', 'bridge')
    expect(await settingsText(d)).toContain('Idle warning: over $0.50')
    expect(h.store.resetFields).not.toContain('idleWarning')
    // A new session keeps all of that: floor and idleWarning are yours, the rest default.
    await d.start(surface)
    const text = await settingsText(d)
    expect(text).toContain('Lowest effort: high')
    expect(text).toContain('Idle warning: over $0.50')
    expect(text).not.toContain('Band:')
    expect(changedCount(text)).toBe(2)
  })

  test(`a reset row changed by hand in the settings file is yours at the next start (${surface})`, { timeoutMs: 30000, options: SOME_SET }, async ($, on) => {
    const h = engine(on, { ...OPUS, stored: SOME_SET })
    const { d } = await resetSettingsRun($, h, 'Settings')
    h.stored.floor = 'high'
    await d.start(surface)
    const text = await settingsText(d)
    expect(text).toMatch(/Lowest effort: \w+\n/)
    expect(text).not.toContain('Idle warning:')
    expect(h.store.resetFields, 'floor left the list').not.toContain('floor')
  })

  // One setting, by key or by title, in any case.
  for (const name of ['idleWarning', 'IDLEWARNING', 'idle warning', 'Idle Warning']) {
    test(`/rightsize reset ${name} resets that one setting and confirms first (${surface})`, { timeoutMs: 30000, options: SOME_SET }, async ($, on) => {
      const h = engine(on, { ...OPUS, store: MEASURE_STORE, stored: SOME_SET })
      const d = drive($, h)
      await d.start(surface)
      h.answers = { Confirm: 'Yes' }
      const out = await d.command(`reset ${name}`)
      expect(h.asked.map(a => a.header), 'no menu: it names the setting').toEqual(['Confirm'])
      expect(h.asked[0]?.question).toBe("Reset Idle warning? It goes back to its default, over $0.50. This can't be undone.")
      expect(out.text).toBe('Idle warning is back to its default, over $0.50.')
      const text = await settingsText(d)
      expect(text).not.toContain('Idle warning:')
      expect(text, 'the others are as they were').toContain('Lowest effort: medium')
      expect(text).toContain('Budget pacing: off')
      expect(h.stored.idleWarning).toBe('over $0.50')
      expect(h.store.resetFields).toEqual(['idleWarning'])
      expect(h.store.choices, 'the saved answers stay').toEqual({ raise: 'auto' })
      // The other six rows, and the saved answer for Raising: seven.
      expect(changedCount(text)).toBe(7)
    })
  }

  test(`/rightsize reset when Claude Code refuses the write: says so, gives the terminal command, logs the reason (${surface})`, { timeoutMs: 30000, options: SOME_SET }, async ($, on) => {
    const h = engine(on, { ...OPUS, stored: SOME_SET })
    h.refuse = ['idleWarning']
    const d = drive($, h)
    await d.start(surface)
    h.answers = { Confirm: 'Yes' }
    const out = (await d.command('reset idleWarning')).text ?? ''
    expect(out).toBe(`Idle warning could not be changed from here. To reset it, run this in a terminal, then restart Claude Code: claude plugin configure rightsize@archid21 --values-stdin <<< '{"idleWarning":"over $0.50"}'`)
    expect(out).not.toContain('back to its default')
    expect(h.stored.idleWarning, 'unchanged').toBe('over $1')
    expect(await settingsText(d)).toContain('Idle warning: over $1')
    expect(h.files[LOG_PATH] ?? '').toContain('reset idleWarning: Claude Code refused to write it: only its dialog changes it')
    expect(h.store.resetFields, 'listed, so the default counts as a default once set from a terminal').toEqual(['idleWarning'])
  })

  test(`/rightsize reset on one setting declined: nothing changes (${surface})`, { timeoutMs: 30000, options: SOME_SET }, async ($, on) => {
    const h = engine(on, { ...OPUS, stored: SOME_SET })
    const d = drive($, h)
    await d.start(surface)
    h.answers = { Confirm: 'No' }
    expect((await d.command('reset idleWarning')).text).toBe('Nothing was reset.')
    expect(await settingsText(d)).toContain('Idle warning: over $1')
    expect(h.stored.idleWarning).toBe('over $1')
  })

  test(`/rightsize reset on a rule row forgets that answer, and the default decides that case again; the other answers stay (${surface})`, { timeoutMs: 30000, options: { lowerRule: 'never lower', raiseRule: 'never raise' } }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES }, stored: { lowerRule: 'never lower', raiseRule: 'never raise' } })
    const d = drive($, h)
    await d.start(surface)
    h.answers = { Confirm: 'Yes' }
    const out = await d.command('reset Lowering')
    expect(h.asked[0]?.question).toBe("Reset Lowering? It goes back to its default, not set. The default decides that case again. This can't be undone.")
    expect(out.text).toContain('Lowering is back to its default, not set.')
    const text = await settingsText(d)
    expect(text).not.toContain('Lowering:')
    expect(text).toContain('Raising: never raise')
    h.rating = LOWER
    const asked = h.asked.length
    await d.submit(LOOKUP)
    expect(h.asked.slice(asked), 'the default decides: nothing is asked').toEqual([])
    expect(h.files[LOG_PATH] ?? '').toContain('Lowering: no rule set, the default decides (lower automatically)')
    await d.step('t1')
    expect(last(h.sent)?.effort, 'lowered, as the default does').toBe('low')
  })

  test(`/rightsize reset on Reports forgets the answer, and the rate limits read the billing again (${surface})`, { timeoutMs: 30000, options: { billing: 'api' } }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: { billing: { value: 'api', by: 'answered' } }, stored: { billing: 'api' } })
    h.rateLimits = [{ kind: 'five_hour', percentUsed: 12 }]
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    expect(h.store.billing, 'your answer stands').toEqual({ value: 'api', by: 'answered' })
    h.answers = { Confirm: 'Yes' }
    await d.command('reset billing')
    expect(h.store.billing, 'your answer is gone').toBeNull()
    expect(await settingsText(d)).not.toMatch(/Reports: \w+\n/)
    // The next response's rate limits read the billing again.
    await d.step('t1')
    await d.complete('t1')
    expect(h.store.billing).toEqual({ value: 'subscription', by: 'detected' })
    expect(await settingsText(d)).toContain('Reports: subscription (detected)')
  })

  test(`/rightsize reset on Remember choices asks about keeping answers again (${surface})`, { timeoutMs: 30000, options: { remember: 'every session' } }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES, remember: true }, stored: { remember: 'every session' } })
    const d = drive($, h)
    await d.start(surface)
    h.answers = { Confirm: 'Yes' }
    await d.command('reset remember')
    expect(h.store.remember, 'the old yes is forgotten').toBe(false)
    h.asked.length = 0
    // A rule the person sets (here from the band) is followed by the Remember question again.
    await setRaiseFromBand($, h, d, { Remember: 'This session' })
    await d.step('t1')
    await d.complete('t1')
    await settle()
    expect(h.asked.map(a => a.header)).toEqual(['Options', 'Remember'])
  })

  test(`/rightsize reset with a name it does not know says so and lists the keys, and asks nothing (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS })
    const d = drive($, h)
    await d.start(surface)
    const out = (await d.command('reset hand off threshhold')).text ?? ''
    expect(out).toContain('No setting called "hand off threshhold".')
    for (const key of KEYS) expect(out, key).toContain(key)
    expect(h.asked).toEqual([])
  })

  for (const choice of ['Cost measurement', 'Both']) {
    test(`/rightsize reset ${choice}: the calibration and counts go, measureFrom is set, and the log and report history stay (${surface})`, { timeoutMs: 30000, options: { lowerRule: 'lower automatically' } }, async ($, on) => {
      const h = engine(on, { ...OPUS, store: MEASURE_STORE, stored: { lowerRule: 'lower automatically' } })
      measured(h)
      const log = h.files[RUNS] ?? ''
      const d = drive($, h)
      await d.start(surface)
      expect(await settingsText(d), 'the calibration was loaded').toContain('Measured runs: 5')
      h.answers = { Reset: choice, Confirm: 'Yes' }
      const out = (await d.command('reset')).text ?? ''
      expect(out).toContain('Cost measurement restarted: rightsize is back to its starting estimates and relearns from your next prompts.')
      for (const key of [CAL_STORE, 'ties', 'spotChecks', 'startCheckedAt', 'startSnooze']) expect(h.store[key], key).toBeNull()
      expect(h.store.measureFrom).toBe(new Date(h.now).toISOString())
      expect(await settingsText(d), 'in memory too').toContain('Measured runs: 0')
      expect(h.files[RUNS], 'the run log is kept, line for line').toBe(log)
      // The report still counts all of it, and says when measurement restarted.
      const report = (await d.command('report')).text ?? ''
      expect(report).toContain(`Cost measurement restarted on ${new Date(h.now).toISOString().slice(0, 10)}.`)
      expect(cellsOf(report, 'Prompts rated')?.slice(1)).toEqual(['66', '66'])
      expect(report, 'what went wrong reads the whole history').toMatch(/Haiku's judgement +wrong on 3 of 6 checked prompts \(50%\)/)
      expect(report, 'but nothing is paused any more').not.toContain('Hand-downs paused')
      // Settings stay unless Both.
      expect(await settingsText(d)).toContain(choice === 'Both' ? `All ${KEYS.length} settings are at their defaults` : 'Lowering: lower automatically')
    })
  }

  test(`live miss rates ignore the run log from before Cost measurement restarted (${surface})`, { timeoutMs: 30000, options: { lowerRule: 'lower automatically' } }, async ($, on) => {
    const h = engine(on, { ...OPUS, stored: { lowerRule: 'lower automatically' } })
    h.now = Date.now()
    // Wrong on 3 of 6 lookups on Opus: lowering is paused.
    h.files[RUNS] = lookupLog(h, 3)
    const d = drive($, h)
    await d.start(surface)
    // Lowering saves enough to pay even without evidence about the cache.
    h.rating = '{"level":"low","model":"same","size":"small","type":"lookup","read":2000,"write":40000,"steps":1}'
    await d.submit(LOOKUP)
    await d.step('t1')
    expect(last(h.sent)?.effort, 'paused: stays at medium').toBe('medium')
    await d.complete('t1')
    h.answers = { Reset: 'Cost measurement', Confirm: 'Yes' }
    await d.command('reset')
    await d.submit(LOOKUP)
    await d.step('t2')
    expect(last(h.sent)?.effort, 'those lines teach nothing now: lowered').toBe('low')
    await d.complete('t2')
    // The calibration restarted too: it learns again from this turn.
    expect(Object.keys((h.store[CAL_STORE] as Record<string, unknown> | null) ?? {}).length).toBeGreaterThan(0)
    // And a restart keeps it: measureFrom is read back from the store.
    await d.start(surface)
    await d.submit(LOOKUP)
    await d.step('t3')
    expect(last(h.sent)?.effort).toBe('low')
  })

  test(`the starting-point check and the report's comparison ignore the run log from before Cost measurement restarted (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: { startCheckedAt: 1_800_000_000_000 - 30 * DAY } })
    h.files[RUNS] = easyLog(h.now)
    const d = drive($, h)
    await d.start(surface)
    expect(await bandText($, surface), 'before: a cheaper start is suggested').toContain('Starting on Sonnet')
    expect(String((await d.command('report')).text)).toContain('STARTING POINT  Opus at medium, 60 rated prompts in 30 days')
    h.answers = { Reset: 'Cost measurement', Confirm: 'Yes' }
    await d.command('reset')
    // The report's block waits for rated prompts from now on, though its history still counts the 60.
    const report = String((await d.command('report')).text)
    expect(report).toContain('STARTING POINT  Needs 50 rated prompts to compare (has 0).')
    expect(cellsOf(report, 'Prompts rated')?.slice(1)).toEqual(['60', '60'])
    // The next start does not suggest anything either: startCheckedAt is clear, so it checks, and finds nothing to go on.
    await d.start(surface)
    expect(await bandText($, surface)).toBe('')
    expect(h.store.startCheckedAt, 'the check ran and was counted').toBe(h.now)
  })

  test(`/rightsize reset Both does both after one confirmation (${surface})`, { timeoutMs: 30000, options: SOME_SET }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: MEASURE_STORE, stored: SOME_SET })
    measured(h)
    const { d, out } = await resetSettingsRun($, h, 'Both')
    expect(h.asked.filter(a => a.header === 'Confirm').length, 'one confirmation').toBe(1)
    expect(out).toContain('Every setting is back to its default')
    expect(out).toContain('Cost measurement restarted')
    expect(h.store[CAL_STORE]).toBeNull()
    expect(h.store.choices).toBeNull()
    expect(await settingsText(d)).toContain('are at their defaults')
  })


  test(`/rightsize help lists every command and what it does (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS })
    const d = drive($, h)
    await d.start(surface)
    const text = (await d.command('help')).text ?? ''
    for (const c of ['', 'status', 'settings', 'report', 'retry', 'clear', 'prices', 'share', 'reset', 'help']) expect(text, c).toMatch(new RegExp(`^  /rightsize${c ? ` ${c}` : ''} +\\S`, 'm'))
    expect(text).toContain('reset <setting> resets one')
    expect(text).toContain('message you can paste to tell others')
    expect(h.asked, 'no question').toEqual([])
  })

  test(`an unknown /rightsize command says so and lists the commands (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS })
    const d = drive($, h)
    await d.start(surface)
    const text = (await d.command('foo')).text ?? ''
    expect(text.startsWith('Unknown command "foo".')).toBe(true)
    expect(text).toContain('rightsize commands')
  })

  test(`/rightsize ends with a pointer to help, and no long command list (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS })
    const d = drive($, h)
    await d.start(surface)
    const text = await settingsText(d)
    expect(text.endsWith('Commands: /rightsize help')).toBe(true)
    expect(text).not.toContain('undo re-runs')
  })

  test(`the status bar never repeats the name Claude Code already shows (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    expect(h.statuses).toContain('Rating the prompt...')
    expect(h.statuses.filter(t => t?.toLowerCase().startsWith('rightsize')), 'no status starts with the name').toEqual([])
  })

  test(`/rightsize starts with "On." (Claude Code already shows the name) and points to claude plugin configure (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS })
    const d = drive($, h)
    await d.start(surface)
    const text = await settingsText(d)
    expect(text.startsWith('Ask before changing: off\nOn.\n'), 'Ask before changing on the first line').toBe(true)
    expect(text).not.toContain('Rightsize is')
    expect(text).toContain('(list them with claude plugin configure rightsize@archid21)')
  })

  test(`/rightsize share prints the framed message, sends nothing and asks nothing (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS })
    const d = drive($, h)
    await d.start(surface)
    const posts = h.posts.length
    const fetches = h.fetches
    const text = (await d.command('share')).text ?? ''
    expect(text.startsWith('Copy and paste this anywhere. rightsize sends nothing itself.\n\n')).toBe(true)
    expect(text).toContain("I'm using rightsize, a free Claude Code mod")
    expect(text).toContain('https://aivalue.blog/rightsize')
    expect(h.posts.length, 'no POST').toBe(posts)
    expect(h.fetches, 'no fetch').toBe(fetches)
    expect(h.asked, 'no question').toEqual([])
  })


  // The first prompt of a session: nothing has run a step yet, so the model and the window come from the engine.
  const PLAIN = '{"level":"medium","model":"same","size":"small","type":"lookup","read":2000,"write":300,"steps":1}'
  const LOG_FILE = LOG_PATH
  const firstPrompt = async (h: ReturnType<typeof engine>, d: ReturnType<typeof drive>, turn: string) => {
    h.rating = PLAIN
    await d.submit(LOOKUP)
    await d.step(turn)
    await d.complete(turn)
    return runLines(h).filter(l => l.kind === 'run').at(-1) as { tier: string; context: number } | undefined
  }

  test(`the first prompt of a session started on Sonnet, with no model setting, is planned on Sonnet (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-sonnet-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    const run = await firstPrompt(h, d, 't1')
    expect(run?.tier, 'the run was planned on the live model, not the Opus fallback').toBe('sonnet')
    const log = h.files[LOG_FILE] ?? ''
    expect(log).toContain('lookup on sonnet/')
    expect(log).not.toContain('on opus/')
    expect(log, 'the model was known: nothing to say about it').not.toContain('session model unknown')
  })

  test(`a /model change before the next prompt is planned on the new model, ahead of the one last seen (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-sonnet-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    await firstPrompt(h, d, 't1')
    h.liveModel = 'claude-haiku-5-5'
    h.model = 'claude-haiku-5-5'
    h.rating = PLAIN
    await d.submit(LOOKUP)
    expect(h.files[LOG_FILE] ?? '', 'the second prompt, planned on Haiku').toContain('lookup on haiku/')
  })

  test(`a model nobody can name is planned as Opus, and the log says it was unknown (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'mystery-1', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    h.rating = PLAIN
    await d.submit(LOOKUP)
    const log = h.files[LOG_FILE] ?? ''
    expect(log).toContain('session model unknown')
    expect(log, 'a fallback, not a guess made silently').toContain('lookup on opus/')
  })

  test(`the first prompt is planned at the live context size when the engine reports one (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    h.contextTokens = 150_000
    await d.start(surface)
    expect((await firstPrompt(h, d, 't1'))?.context, 'a resumed session of 150K').toBe(150_000)

  })

  test(`the first prompt keeps the 20K start size when the engine has no reading yet (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    expect((await firstPrompt(h, d, 't1'))?.context, 'a fresh session').toBe(20_000)
  })

  test(`a rating that times out falls back to Haiku; if that fails too the prompt is logged as unrated and the session is left as it was (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    h.ratingUsage = { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    // The log's times are the wall clock's: the report's periods count from now.
    h.now = Date.now()
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')

    // One timeout, then an answer: the retry rates the prompt, and nothing is logged as unrated.
    h.ratingQueue = ['timeout']
    h.rating = LOWER
    const before = h.ratings
    await d.submit(LOOKUP)
    expect(h.ratings - before, 'two calls').toBe(2)
    expect(runLines(h).some(l => l.kind === 'unrated')).toBe(false)
    await d.step('t1')
    expect(last(h.sent)?.effort, 'the rating counted: lowered').toBe('low')
    await d.complete('t1')

    // Two timeouts: no route, the session as it is, one unrated line carrying both calls' cost.
    h.ratingQueue = ['timeout', 'timeout']
    const calls = h.ratings
    await d.submit(LOOKUP)
    expect(h.ratings - calls, 'one retry, no more').toBe(2)
    await d.step('t2')
    expect(last(h.sent)?.effort, 'effort as the session has it').toBe('medium')
    expect(last(h.sent)?.model, 'model as the session has it').toBe('claude-opus-5-5')
    await d.complete('t2')
    const unrated = runLines(h).filter(l => l.kind === 'unrated')
    // An unrated prompt is part of the task in progress: the last rated run's.
    const task = (last(runLines(h).filter(l => l.kind === 'run')) as { task: string }).task
    expect(unrated).toEqual([{ at: expect.any(String), kind: 'unrated', session: 'sess-1', task, reason: 'rating call timed out', rater: 'haiku', overhead: 0.00315, ratingMs: 0 }])
    expect(h.files[LOG_FILE] ?? '').toContain('prompt not rated (rating call timed out)')

    // An answer that cannot be read is tried again the same way.
    h.ratingQueue = ['no json', 'still no json']
    const reads = h.ratings
    await d.submit(LOOKUP)
    expect(h.ratings - reads).toBe(2)
    expect(runLines(h).filter(l => l.kind === 'unrated').at(-1)?.reason).toBe('rating unreadable')
    await d.step('t3')
    await d.complete('t3')

    // A rater that is not available is not asked again by itself; Sonnet's refusal still tries Haiku once.
    h.ratingQueue = ['unavailable', 'unavailable']
    const asked = h.ratings
    await d.submit(LOOKUP)
    expect(h.ratings - asked, 'Sonnet, then Haiku').toBe(2)
    expect(runLines(h).filter(l => l.kind === 'unrated').at(-1)?.reason).toBe('rating call failed (status 401)')

    // The report counts them as not counted, with a plain reason.
    const report = (await d.command('report')).text ?? ''
    expect(report).toMatch(/3 prompts +not rated \(the rating failed\), so nothing was changed/)
  })


  // ---- Watching the cheaper helpers, with one retry budget per task ----

  const HELPERS = { remember: true, choices: { raise: 'auto', down: 'auto' } }
  const HAND_OFF = (continues = false) => `{"fit":{"haiku":"low","sonnet":"low","opus":"low","fable":"low"},"type":"search","read":150000,"write":3000,"steps":30,"continues":${continues},"reason":"repo-wide search"}`
  const HELPER_LOG = LOG_PATH
  const helperLog = (h: ReturnType<typeof engine>) => h.files[HELPER_LOG] ?? ''
  type Drive = ReturnType<typeof drive>
  // The main chat hands the work to a Haiku subagent called `helper`, which takes its first step (at low effort).
  async function startHelper(d: Drive, h: ReturnType<typeof engine>, turn: string, helper: string, text = SEARCH) {
    await d.submit(text)
    await d.step(turn, 0)
    await d.agent('haiku')
    await d.spawn(helper, 'haiku')
    await d.step(turn, 0, `agent-${helper}`)
    expect(last(h.sent)?.effort).toBe('low')
  }
  async function warm(d: Drive, h: ReturnType<typeof engine>) {
    h.subModel = 'claude-haiku-5-5'
    await d.step('t0')
    await d.complete('t0')
  }
  type HelperEntry = { agent: string; kind: string; steps: number; ms: number; errors: number; blocked: number; stall?: string; raises?: { step: number; from: string; to: string; why: string }[]; returned?: boolean }

  test(`a struggling hand-off helper is raised one level, and its later steps go out at it (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-fable-5-1', effort: 'high', store: HELPERS })
    const d = drive($, h)
    await d.start(surface)
    await warm(d, h)
    h.rating = HAND_OFF()
    await startHelper(d, h, 't1', 'helper')
    await d.bash('fail make', 'agent-helper')
    await d.step('t1', 1, 'agent-helper')
    expect(last(h.sent)?.effort, 'one failure is ordinary').toBe('low')
    await d.bash('fail make', 'agent-helper')
    await d.step('t1', 2, 'agent-helper')
    expect(last(h.sent)?.effort, 'the same call failed twice: one level up').toBe('medium')
    expect(helperLog(h)).toContain('raised helper agent-helper low → medium at step 3: the same tool call failed twice')
    await d.step('t1', 3, 'agent-helper')
    expect(last(h.sent)?.effort, 'and it stays there').toBe('medium')
    expect(h.asked.length, 'nobody is asked mid-helper').toBe(0)
    expect(await bandText($, surface)).toBe('Helper effort raised: low → medium (the same tool call failed twice).')
    await d.step('t1', 1)
    await d.complete('t1')
    const run = readRuns(h).find(l => l.kind === 'run') as { helpers?: HelperEntry[]; retries?: number }
    expect(run.retries, 'one chance used').toBe(1)
    expect(run.helpers).toEqual([
      { agent: 'agent-helper', kind: 'handoff', steps: 4, calls: 2, ms: 0, errors: 2, blocked: 0, stall: 'struggling', raises: [{ step: 3, from: 'low', to: 'medium', why: 'the same tool call failed twice' }] },
    ])
  })

  test(`a blocked helper is not raised, and a sign with only blocked errors behind it is not either (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-fable-5-1', effort: 'high', store: HELPERS })
    const d = drive($, h)
    await d.start(surface)
    await warm(d, h)
    h.rating = HAND_OFF()
    await startHelper(d, h, 't1', 'helper')
    for (let i = 0; i < 3; i++) await d.bash('env:fatal: unable to access registry.example.com: Could not resolve host: registry.example.com', 'agent-helper')
    await d.step('t1', 1, 'agent-helper')
    expect(last(h.sent)?.effort, 'the network is down: effort would not help').toBe('low')
    // The person saying no at the permission prompt is not the work failing: the same refused call three times raises nothing.
    for (let i = 0; i < 3; i++) await d.bash('rejected git reset --hard', 'agent-helper')
    await d.step('t1', 2, 'agent-helper')
    expect(last(h.sent)?.effort, 'the person said no: the task is no harder').toBe('low')
    // The same successful call three times is a loop, but only blocked errors stand behind it: can't tell.
    for (let i = 0; i < 3; i++) await d.bash('ls', 'agent-helper')
    await d.step('t1', 2, 'agent-helper')
    expect(last(h.sent)?.effort).toBe('low')
    expect(helperLog(h).match(/helper agent-helper blocked by the environment: more effort will not help/g)?.length, 'logged once').toBe(1)
    expect(helperLog(h)).toContain("can't tell, no raise")
    const after = (await d.bash('ls', 'agent-helper')) as { deny?: string }
    expect(after.deny, 'not returned either').toBeUndefined()
    await d.complete('t1')
    const run = readRuns(h).find(l => l.kind === 'run') as { helpers?: HelperEntry[]; retries?: number }
    expect(run.helpers?.map(x => [x.stall, x.blocked, x.returned, x.raises])).toEqual([['blocked', 3, undefined, undefined]])
    expect('retries' in run, 'no chance used').toBe(false)
  })

  test(`the third struggle of a task with two chances used sends the helper back: every tool call after is refused (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-fable-5-1', effort: 'high', store: HELPERS })
    const d = drive($, h)
    await d.start(surface)
    await warm(d, h)
    h.rating = HAND_OFF()
    await startHelper(d, h, 't1', 'helper')
    await d.bash('fail a', 'agent-helper')
    await d.bash('fail a', 'agent-helper')
    await d.step('t1', 1, 'agent-helper')
    expect(last(h.sent)?.effort, 'first chance').toBe('medium')
    await d.bash('fail b', 'agent-helper')
    await d.step('t1', 2, 'agent-helper')
    expect(last(h.sent)?.effort, 'second chance').toBe('high')
    for (let i = 0; i < 3; i++) await d.bash('ls', 'agent-helper')
    await d.step('t1', 3, 'agent-helper')
    expect(last(h.sent)?.effort, 'no third raise').toBe('high')
    expect(helperLog(h)).toContain('returned helper agent-helper to the main chat at step 4: the same tool call ran 3 times, and the task has no retry left')
    for (let i = 0; i < 2; i++) {
      const denied = (await d.bash('ls', 'agent-helper')) as { deny?: string }
      expect(denied.deny, 'stopped: report back').toContain('stuck')
      expect(denied.deny).toContain('retry budget is used up')
    }
    expect(((await d.bash('ls')) as { deny?: string }).deny, 'the main chat is not stopped').toBeUndefined()
    await d.answer('agent-helper')
    await d.complete('t1')
    const run = readRuns(h).find(l => l.kind === 'run') as { helpers?: HelperEntry[]; retries?: number }
    expect(run.retries).toBe(2)
    expect(run.helpers?.map(x => [x.stall, x.returned, x.raises?.map(r => `${r.from}>${r.to}`)])).toEqual([['struggling', true, ['low>medium', 'medium>high']]])
  })

  test(`a struggling helper is asked about when Raising is not automatic: raised on yes, left alone on keep (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-fable-5-1', effort: 'high', store: { remember: true, choices: { down: 'auto' } } })
    const d = drive($, h)
    await d.start(surface)
    // Raising set to ask: the default answer (auto) would raise without a question.
    await d.config('raiseRule', 'ask me')
    await warm(d, h)
    h.rating = HAND_OFF()
    h.answers = { Stuck: 'Raise to medium' }
    await startHelper(d, h, 't1', 'helper')
    await d.bash('fail a', 'agent-helper')
    await d.bash('fail a', 'agent-helper')
    await d.step('t1', 1, 'agent-helper')
    expect(h.asked.map(a => a.header), 'asked, as for the main chat').toEqual(['Stuck'])
    expect(h.asked[0]?.question).toContain('It uses one of this task\'s 2 retries. No answer: it goes on at low.')
    await settle()
    await d.step('t1', 2, 'agent-helper')
    expect(last(h.sent)?.effort, 'raised on yes, from its next request').toBe('medium')
    await d.complete('t1')

    // A new task, and a keep: not raised, not sent back.
    h.asked = []
    h.answers = { Stuck: 'Keep low' }
    h.rating = HAND_OFF()
    await startHelper(d, h, 't2', 'second')
    await d.bash('fail b', 'agent-second')
    await d.bash('fail b', 'agent-second')
    await d.step('t2', 1, 'agent-second')
    expect(h.asked.map(a => a.header)).toEqual(['Stuck'])
    await settle()
    await d.step('t2', 2, 'agent-second')
    expect(last(h.sent)?.effort, 'kept').toBe('low')
    expect(((await d.bash('ls', 'agent-second')) as { deny?: string }).deny, 'not sent back').toBeUndefined()
    expect(helperLog(h)).toContain('kept at low, as you chose')
    await d.complete('t2')
  })

  test(`a struggling helper with nobody to answer goes on at its effort, and is not sent back (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-fable-5-1', effort: 'high', store: { remember: true, choices: { down: 'auto' } } })
    const d = drive($, h)
    await d.start(surface)
    // Raising set to ask: the default answer (auto) would raise without a question.
    await d.config('raiseRule', 'ask me')
    await warm(d, h)
    h.rating = HAND_OFF()
    h.answers = { Stuck: NO_ONE }
    await startHelper(d, h, 't1', 'helper')
    await d.bash('fail a', 'agent-helper')
    await d.bash('fail a', 'agent-helper')
    await d.step('t1', 1, 'agent-helper')
    expect(h.asked.map(a => a.header)).toEqual(['Stuck'])
    await d.step('t1', 2, 'agent-helper')
    expect(last(h.sent)?.effort, 'not raised').toBe('low')
    expect(((await d.bash('ls', 'agent-helper')) as { deny?: string }).deny, 'not sent back').toBeUndefined()
    await d.complete('t1')
    expect(h.question, 'the turn ended: the question went').toBeNull()
    expect(helperLog(h)).toContain('no answer on the band to Stuck: helper agent-helper kept at low')
  })

  test(`a stuck helper whose Stuck dialog gets no answer (Band set to Never) goes on at its effort: the text says so, and it is not sent back (${surface})`, { timeoutMs: 30000, options: { band: 'off' } }, async ($, on) => {
    const h = engine(on, { model: 'claude-fable-5-1', effort: 'high', store: { remember: true, choices: { down: 'auto' } } })
    const d = drive($, h)
    await d.start(surface)
    // Raising set to ask: the default answer (auto) would raise without a question.
    await d.config('raiseRule', 'ask me')
    await warm(d, h)
    h.rating = HAND_OFF()
    h.answers = { Stuck: NO_ONE }
    h.sleepEnds = true
    await startHelper(d, h, 't1', 'helper')
    await d.bash('fail a', 'agent-helper')
    await d.bash('fail a', 'agent-helper')
    await d.step('t1', 1, 'agent-helper')
    expect(h.asked.map(a => a.header), 'the dialog: the band is off').toEqual(['Stuck'])
    expect(h.asked[0]?.question).toContain("It uses one of this task's 2 retries. With no answer in 30 seconds it goes on at low.")
    expect(h.question, 'not on the band').toBeNull()
    await d.step('t1', 2, 'agent-helper')
    expect(last(h.sent)?.effort, 'not raised').toBe('low')
    expect(((await d.bash('ls', 'agent-helper')) as { deny?: string }).deny, 'not sent back to the main chat').toBeUndefined()
    expect(helperLog(h)).toContain('helper agent-helper struggling (the same tool call failed twice): no answer in 30 seconds, goes on at low')
    await d.complete('t1')
    const run = readRuns(h).find(l => l.kind === 'run') as { helpers?: HelperEntry[]; retries?: number }
    expect(run.helpers?.map(x => [x.returned, x.raises]), 'neither returned nor raised').toEqual([[undefined, undefined]])
    expect('retries' in run, 'no chance used').toBe(false)
  })

  // ---- Every question waits 30 seconds (Question wait), then takes the choice that changes nothing ----

  const until = async (done: () => boolean) => {
    for (let i = 0; i < 200 && !done(); i++) await new Promise(r => setTimeout(r, 10))
  }
  const NO_ANSWER = 'No answer in 30 seconds:'

  test(`Lowering set to ask, with nobody to answer: this prompt runs as it is, nothing is saved, and it is asked again next time (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    await d.config('lowerRule', 'ask me')
    h.rating = LOWER
    h.answers = { Effort: NO_ONE }
    h.sleepEnds = true
    await d.submit(LOOKUP)
    await d.step('t1', 0)
    expect(h.asked.map(a => a.header), 'the dialog is the Effort question; no Remember question either').toEqual(['Effort'])
    expect(h.asked[0]?.question).toContain(`${NO_ANSWER} it stays as it is.`)
    expect(last(h.sent)?.effort, 'no change').toBe('medium')
    expect(h.store.choices, 'nothing saved').toBeUndefined()
    expect(helperLog(h)).toContain('no answer in 30 seconds to Effort: kept medium')
    await d.complete('t1')
    await d.submit(LOOKUP)
    expect(h.asked.map(a => a.header), 'asked again').toEqual(['Effort', 'Effort'])
  })

  test(`Stronger model set to ask, with nobody to answer: no switch and no hand-off, and nothing is saved (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    await d.config('upRule', 'ask first')
    h.rating = '{"level":"high","model":"fable","size":"small","type":"debug","read":30000,"write":4000,"steps":12,"reason":"subtle concurrency bug"}'
    h.answers = { Subagent: NO_ONE }
    h.sleepEnds = true
    await d.submit(DEBUG)
    await d.step('t1')
    expect(h.asked.map(a => a.header)).toEqual(['Subagent'])
    expect(h.asked[0]?.question).toContain(`${NO_ANSWER} it stays as it is.`)
    expect(handedTo(h), 'no hand-off').toBeUndefined()
    expect(last(h.sent)?.model, 'no switch').not.toBe('fable')
    expect(h.store.choices).toBeUndefined()
    expect(helperLog(h)).toContain('no answer in 30 seconds to Subagent')
    await d.complete('t1')
  })

  test(`Remember with nobody to answer: it waits on the band for the turn to end, and with no answer by the next prompt it is this session only (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    // The rule is the person's, set from the band: that is what the question follows.
    await setRaiseFromBand($, h, d, { Remember: NO_ONE })
    await d.step('t1', 0)
    expect(last(h.sent)?.effort, 'the prompt did not wait for Remember').toBe('high')
    expect(h.asked.map(a => a.header), 'Remember waits for the turn to end').toEqual(['Options'])
    await d.complete('t1')
    await settle()
    expect(h.asked.map(a => a.header)).toEqual(['Options', 'Remember'])
    expect(h.asked[1]?.question).toBe('Keep your rules (Raising: never raise) in every session? No answer: this session only.')
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    expect(h.question, 'the next prompt took it away').toBeNull()
    expect(h.store.remember, 'not kept for every session').toBeUndefined()
    expect(h.store.choices).toBeUndefined()
    expect(helperLog(h)).toContain('no answer on the band to Remember: these choices stay for this session only')
  })

  test(`Billing with nobody to answer: it waits on the band, API prices for now, not saved, asked again next session (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    h.rateLimits = []
    h.rating = NO_CHANGE
    h.answers = { Billing: NO_ONE }
    const turn = async (t: string) => {
      await d.submit(LOOKUP)
      await d.step(t)
      await d.complete(t)
      await settle()
    }
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    await turn('t1')
    expect(h.asked.map(a => a.header)).toEqual(['Billing'])
    expect(h.asked[0]?.question).toContain('No answer: reports use API prices for now.')
    await turn('t2')
    expect(h.store.billing, 'not saved').toBeUndefined()
    expect(helperLog(h)).toContain('no answer on the band to Billing')
    expect(h.asked.map(a => a.header), 'once a session').toEqual(['Billing'])
    await d.start(surface)
    await d.step('t3')
    await d.complete('t3')
    await turn('t4')
    expect(h.asked.map(a => a.header), 'asked again in the next session').toEqual(['Billing', 'Billing'])
  })

  test(`an ask-each-time question with nobody to answer stays as it is (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { remember: true, choices: { raise: 'ask' } } })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = RAISE_HIGH
    h.answers = { Effort: NO_ONE }
    h.sleepEnds = true
    await d.submit(DEBUG)
    await d.step('t1')
    expect(h.asked.map(a => a.header)).toEqual(['Effort'])
    expect(h.asked[0]?.question).toContain(`${NO_ANSWER} it stays as it is.`)
    expect(last(h.sent)?.effort, 'never raised').toBe('medium')
    expect(helperLog(h)).toContain('no answer in 30 seconds to Effort: kept medium')
    await d.complete('t1')
  })

  test(`Subagent with nobody to answer: nothing is sent to a subagent (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { remember: true, choices: { down: 'ask' } } })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = HAND_OFF()
    h.answers = { Subagent: NO_ONE }
    h.sleepEnds = true
    await d.submit(SEARCH)
    await d.step('t1')
    expect(h.asked.map(a => a.header)).toEqual(['Subagent'])
    expect(h.asked[0]?.question).toContain(`${NO_ANSWER} it stays as it is.`)
    expect(handedTo(h), 'not sent').toBeUndefined()
    expect(helperLog(h)).toContain('no answer in 30 seconds to Subagent: stayed on Opus')
    await d.complete('t1')
  })

  test(`Stuck in the main chat with nobody to answer: the turn goes on at its effort, and the question goes when the turn ends (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    // Raising set to ask: the default answer (auto) would raise without a question.
    await d.config('raiseRule', 'ask me')
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    await d.step('t1', 0)
    await d.bash('fail make')
    await d.bash('fail make')
    h.answers = { Stuck: NO_ONE }
    await d.step('t1', 1)
    expect(h.asked[0]?.question).toBe('Claude looks stuck: the same tool call failed twice. Raise effort from medium to high for the rest of this turn? No answer: the turn goes on at medium.')
    expect(h.question?.header, 'on the band').toBe('Stuck')
    await d.step('t1', 2)
    expect(last(h.sent)?.effort, 'the turn went on, not raised').toBe('medium')
    await d.complete('t1')
    expect(h.question, 'the turn ended: the question went').toBeNull()
    expect(helperLog(h)).toContain('no answer on the band to Stuck: kept medium')
  })

  test(`Stuck in the main chat answered on the band: the raise applies from the turn's next request (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    await d.step('t1', 0)
    await d.bash('fail make')
    await d.bash('fail make')
    h.answers = { Stuck: 'Raise to high for this turn' }
    await d.step('t1', 1)
    await settle()
    await d.step('t1', 2)
    expect(last(h.sent)?.effort).toBe('high')
    expect(h.question).toBeNull()
    await d.complete('t1')
  })

  test(`Workflow with nobody to answer: the workflow goes ahead with rightsize paused, nothing is saved, and the next prompt takes the question away (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS })
    const d = drive($, h)
    await d.start(surface)
    h.rating = NO_CHANGE
    h.answers = { Workflow: NO_ONE }
    await d.submit(LOOKUP)
    await d.step('t1')
    await d.workflow()
    expect(h.events, 'the workflow went ahead').toContain('workflow')
    expect(h.asked[0]?.question).toContain('No answer: rightsize stays paused for this workflow.')
    await d.complete('t1')
    expect(h.question?.header, 'it stays after the turn').toBe('Workflow')
    await d.submit(LOOKUP)
    expect(h.question, 'the next prompt took it away').toBeNull()
    expect(helperLog(h)).toContain('no answer on the band to Workflow: rightsize paused for this workflow; not saved')
    expect(await settingsText(d), 'not saved').not.toContain('Workflows:')
  })

  test(`a late answer to the Effort question (Lowering set to ask) is too late: the running prompt is unchanged, a toast says so, and it is asked again next time (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    await d.config('lowerRule', 'ask me')
    let release = () => {}
    h.answerGate = { Effort: new Promise<void>(r => (release = r)) }
    h.rating = LOWER
    h.answers = { Effort: 'Lower for this prompt' }
    h.sleepEnds = true
    await d.submit(LOOKUP)
    await d.step('t1', 0)
    expect(last(h.sent)?.effort, 'this prompt: no change').toBe('medium')
    await d.complete('t1')
    release()
    await until(() => h.toasts.some(t => t.includes('too late')))
    expect(last(h.toasts)).toBe('rightsize: that answer came too late; nothing changed.')
    expect(h.store.choices, 'nothing saved').toBeUndefined()

    h.answerGate = {}
    await d.submit(LOOKUP)
    await d.step('t2', 0)
    expect(h.asked.filter(a => a.header === 'Effort').length, 'asked again: the rule is still ask').toBe(2)
    expect(last(h.sent)?.effort, 'and this one was answered in time').toBe('low')
  })
}
