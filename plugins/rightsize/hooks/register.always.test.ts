import { type TestBody, expect, test } from 'claude-code/testing'
import { CAL_STORE } from './cost'
import { BIG_TURN, DEBUG, FREE_SWITCHES, LOOKUP, NO_CHANGE, NO_COLD, NO_ONE, REVIEW, SEARCH, LOWER, WHATSNEXT_CMDS, drive, engine, installWhatsnext, last, mount, settle } from './testkit'

// P-81 step 4 (ADR 0094, general rule 4): on the third same answer to a question in a row, the next time it shows it carries a
// small third button: "Always do this" after three changes, "Stop asking" after three noes. Pressing it answers the question that
// way and writes the rule row as the person's own. Offered once per case; an answer on the normal buttons instead is a decline,
// and it never comes back. A different answer breaks the run. The count is kept in the store (`askRuns`), per case.
//
// Keep warm offers Always do this only (it sets Cache changes to Auto); three noes offer nothing and do not close the case.
// Not covered here, on purpose (no row can hold them): the helper-stuck and Compact questions offer nothing.

for (const surface of ['desktop', 'terminal'] as const) {
  const OPUS = { model: 'claude-opus-5-5', effort: 'medium' }
  const SONNET = { model: 'claude-sonnet-5-5', effort: 'medium' }
  const ASK = { changes: 'Ask' }
  const HAND_OFF = '{"level":"low","model":"haiku","size":"bulky","type":"search","read":150000,"write":3000,"steps":30,"reason":"repo-wide search"}'
  const RAISE_HIGH = '{"level":"high","model":"same","type":"review","read":20000,"write":3000,"steps":8,"reason":"unknown cause"}'
  const NEEDS_FABLE = '{"level":"high","model":"fable","size":"small","type":"debug","read":30000,"write":4000,"steps":12,"reason":"subtle concurrency bug"}'
  const handedTo = (h: ReturnType<typeof engine>) => /model "(\w+)"/.exec(last(h.submitted)?.context?.join('\n') ?? '')?.[1]
  const ALWAYS = 'Always do this'
  const STOP = 'Stop asking'
  type Runs = Record<string, { last?: 'yes' | 'no'; n: number; closed?: true }>
  const MIN = 60_000
  const HOUR = 60 * MIN

  // ---- The dialog cases (before the prompt) ----

  type Case = {
    name: string
    /** The case's key in the store's `askRuns`. */
    key: string
    start: { model: string; effort: string }
    rating: string
    text: string
    header: string
    yes: string
    no: string
    /** What the turn ends in for the change and for the no. */
    acts: (h: ReturnType<typeof engine>) => unknown
    wantYes: unknown
    wantNo: unknown
    /** The /config row the third button writes, and its value for Always do this and for Stop asking. */
    row: string
    always: string
    stop: string
    /** The name /config and the toast use for the rule. */
    rule: string
  }
  const CASES: Case[] = [
    { name: 'lowering', key: 'lower', start: OPUS, rating: LOWER, text: LOOKUP, header: 'Effort', yes: 'Lower effort', no: 'Keep as is', acts: h => last(h.sent)?.effort, wantYes: 'low', wantNo: 'medium', row: 'lowerRule', always: 'lower automatically', stop: 'never lower', rule: 'Lowering' },
    { name: 'raising', key: 'raise', start: OPUS, rating: RAISE_HIGH, text: DEBUG, header: 'Effort', yes: 'Raise effort', no: 'Keep as is', acts: h => last(h.sent)?.effort, wantYes: 'high', wantNo: 'medium', row: 'raiseRule', always: 'raise automatically', stop: 'never raise', rule: 'Raising' },
    { name: 'a cheaper helper', key: 'down', start: OPUS, rating: HAND_OFF, text: SEARCH, header: 'Subagent', yes: 'Send to Haiku', no: 'Keep on Opus (lower effort)', acts: handedTo, wantYes: 'haiku', wantNo: undefined, row: 'downRule', always: 'always send', stop: 'stay, lower effort only', rule: 'Cheaper model' },
    { name: 'a stronger helper', key: 'up', start: OPUS, rating: NEEDS_FABLE, text: DEBUG, header: 'Subagent', yes: 'Send to Fable', no: 'Keep on Opus (raise effort)', acts: handedTo, wantYes: 'fable', wantNo: undefined, row: 'upRule', always: 'always send', stop: 'stay, raise effort only', rule: 'Stronger model' },
    { name: 'a review switched to Opus', key: 'switch', start: SONNET, rating: REVIEW, text: DEBUG, header: 'Stronger', yes: 'Use Opus', no: 'Stay on Sonnet', acts: h => last(h.sent)?.model, wantYes: 'opus', wantNo: 'claude-sonnet-5-5', row: 'upRule', always: 'always send', stop: 'stay, raise effort only', rule: 'Stronger model' },
  ]

  const OPTIONS = { ...NO_COLD, ...ASK }
  const first = async ($: unknown, on: Parameters<TestBody>[1], c: Case, runs: Runs, answer: string | typeof NO_ONE) => {
    const h = engine(on, { ...c.start, stored: { ...NO_COLD, ...ASK }, store: { [CAL_STORE]: FREE_SWITCHES, askRuns: runs } })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = c.rating
    h.answers = { [c.header]: answer }
    h.sleepEnds = true
    await d.submit(c.text)
    await d.step('t1')
    return { h, d }
  }
  const runsOf = (h: ReturnType<typeof engine>) => h.store.askRuns as Runs | undefined

  for (const c of CASES) {
    const T = { timeoutMs: 30000, options: OPTIONS }

    test(`${c.name}: two same answers in a row, still two buttons (${surface})`, T, async ($, on) => {
      const { h } = await first($, on, c, { [c.key]: { last: 'yes', n: 2 } }, c.yes)
      expect(h.asked.map(x => x.header)).toEqual([c.header])
      expect(h.asked[0]?.options.length).toBe(2)
    })

    test(`${c.name}: after three changes in a row the next question has ${ALWAYS} as a third button (${surface})`, T, async ($, on) => {
      const { h } = await first($, on, c, { [c.key]: { last: 'yes', n: 3 } }, c.yes)
      expect(h.asked[0]?.options.length).toBe(3)
      expect(h.asked[0]?.options[0], 'the recommended button stays first').toBe(c.yes)
      expect(h.asked[0]?.options[2]).toBe(ALWAYS)
    })

    test(`${c.name}: after three noes in a row the third button is ${STOP} (${surface})`, T, async ($, on) => {
      const { h } = await first($, on, c, { [c.key]: { last: 'no', n: 3 } }, c.no)
      expect(h.asked[0]?.options.length).toBe(3)
      expect(h.asked[0]?.options[2]).toBe(STOP)
    })

    test(`${c.name}: ${ALWAYS} answers with the change and writes ${c.row} as the person's, with a toast (${surface})`, T, async ($, on) => {
      const { h } = await first($, on, c, { [c.key]: { last: 'yes', n: 3 } }, ALWAYS)
      expect(c.acts(h), 'it answered the question with the change').toBe(c.wantYes)
      expect(h.stored[c.row]).toBe(c.always)
      expect(h.sets.find(s => s.key === `rightsize.${c.row}`)?.value).toBe(c.always)
      expect(h.toasts.join('\n')).toMatch(new RegExp(`${c.rule} set to .*${c.always}.*/config`))
      expect(runsOf(h)?.[c.key]?.closed, 'offered once').toBe(true)
    })

    test(`${c.name}: ${STOP} answers with the no and writes ${c.row} as the person's, with a toast (${surface})`, T, async ($, on) => {
      const { h } = await first($, on, c, { [c.key]: { last: 'no', n: 3 } }, STOP)
      expect(c.acts(h), 'it answered the question with the no').toBe(c.wantNo)
      expect(h.stored[c.row]).toBe(c.stop)
      expect(h.toasts.join('\n')).toMatch(new RegExp(`${c.rule} set to .*${c.stop}.*/config`))
      expect(runsOf(h)?.[c.key]?.closed).toBe(true)
    })

    test(`${c.name}: a normal button on the offer is a decline: the row stays unset (${surface})`, T, async ($, on) => {
      const { h } = await first($, on, c, { [c.key]: { last: 'yes', n: 3 } }, c.yes)
      expect(c.acts(h)).toBe(c.wantYes)
      expect(h.stored[c.row], 'nothing written').toBeUndefined()
      expect(runsOf(h)?.[c.key]?.closed).toBe(true)
    })

    test(`${c.name}: a declined case offers nothing again, however long the run (${surface})`, T, async ($, on) => {
      const { h } = await first($, on, c, { [c.key]: { last: 'yes', n: 9, closed: true } }, c.yes)
      expect(h.asked[0]?.options.length).toBe(2)
    })

    test(`${c.name}: each answer is counted (${surface})`, T, async ($, on) => {
      const { h } = await first($, on, c, { [c.key]: { last: 'yes', n: 1 } }, c.yes)
      expect(runsOf(h)?.[c.key]).toEqual({ last: 'yes', n: 2 })
    })

    test(`${c.name}: a different answer starts the run again (${surface})`, T, async ($, on) => {
      const { h } = await first($, on, c, { [c.key]: { last: 'yes', n: 2 } }, c.no)
      expect(runsOf(h)?.[c.key]).toEqual({ last: 'no', n: 1 })
    })

    test(`${c.name}: no answer is not counted, and does not decline the offer (${surface})`, T, async ($, on) => {
      const { h } = await first($, on, c, { [c.key]: { last: 'yes', n: 3 } }, NO_ONE)
      expect(h.asked[0]?.options.length).toBe(3)
      expect(runsOf(h)?.[c.key]).toEqual({ last: 'yes', n: 3 })
    })
  }

  // Counted for real: three Lower efforts, and the fourth question has the button; a Keep as is in the middle breaks the run.
  const prompts = async ($: unknown, on: Parameters<TestBody>[1], answers: string[]) => {
    const h = engine(on, { ...OPUS, stored: { ...NO_COLD, ...ASK }, store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = LOWER
    h.sleepEnds = true
    const seen: string[][] = []
    for (const [i, a] of answers.entries()) {
      h.answers = { Effort: a }
      await d.submit(LOOKUP)
      await d.step(`p${i}`)
      await d.complete(`p${i}`)
      seen.push(h.asked.at(-1)?.options ?? [])
    }
    return { h, seen }
  }
  const LOWER_OPTIONS = { timeoutMs: 60000, options: OPTIONS }

  test(`three Lower efforts in a row: the first three questions have two buttons, the fourth has ${ALWAYS} (${surface})`, LOWER_OPTIONS, async ($, on) => {
    const { seen } = await prompts($, on, ['Lower effort', 'Lower effort', 'Lower effort', 'Lower effort'])
    expect(seen.map(o => o.length)).toEqual([2, 2, 2, 3])
    expect(seen[3]?.[2]).toBe(ALWAYS)
  })

  test(`a Keep as is in the run breaks it: yes, yes, no, yes, yes asks no third button (${surface})`, LOWER_OPTIONS, async ($, on) => {
    const { seen } = await prompts($, on, ['Lower effort', 'Lower effort', 'Keep as is', 'Lower effort', 'Lower effort', 'Lower effort'])
    expect(seen.map(o => o.length)).toEqual([2, 2, 2, 2, 2, 2])
  })

  test(`a decline on the real offer: Lower effort on the fourth question, and the fifth has two buttons (${surface})`, LOWER_OPTIONS, async ($, on) => {
    const { seen } = await prompts($, on, ['Lower effort', 'Lower effort', 'Lower effort', 'Lower effort', 'Lower effort'])
    expect(seen.map(o => o.length)).toEqual([2, 2, 2, 3, 2])
  })

  test(`a Lower effort that is pressed as ${ALWAYS} makes lowering automatic: the next prompt is lowered with no question (${surface})`, LOWER_OPTIONS, async ($, on) => {
    const { h, seen } = await prompts($, on, ['Lower effort', 'Lower effort', 'Lower effort', ALWAYS, 'Keep as is'])
    expect(seen.map(o => o.length)).toEqual([2, 2, 2, 3, 3])
    expect(h.asked.length, 'the fifth prompt asked nothing: the fifth entry is the fourth question').toBe(4)
    expect(h.stored.lowerRule).toBe('lower automatically')
  })

  // ---- Claude looks stuck (a band question) ----

  const STUCK_ROWS = { ...NO_COLD, ...ASK, lowerRule: 'never lower' }
  const stuckTurn = async ($: unknown, on: Parameters<TestBody>[1], runs: Runs, answer: string | typeof NO_ONE, folded = false) => {
    const h = engine(on, { ...OPUS, stored: STUCK_ROWS, store: { askRuns: runs, ...(folded ? { bandFolded: true } : {}) } })
    const d = drive($, h)
    await d.start(surface)
    h.rating = NO_CHANGE
    h.answers = { Stuck: answer }
    await d.submit(LOOKUP)
    await d.step('t1', 0)
    await d.bash('fail make')
    await d.bash('fail make')
    await d.step('t1', 1)
    await settle()
    await d.step('t1', 2)
    return { h, d, effort: last(h.sent)?.effort }
  }
  const S = { timeoutMs: 30000, options: STUCK_ROWS }

  test(`Stuck: two same answers in a row, still two buttons (${surface})`, S, async ($, on) => {
    const { h } = await stuckTurn($, on, { stuck: { last: 'yes', n: 2 } }, NO_ONE)
    expect(h.asked[0]?.options).toEqual(['Raise effort', 'Keep going'])
  })

  test(`Stuck: three changes in a row, ${ALWAYS} is the third button, on the band, numbered 3 and shown folded too (${surface})`, S, async ($, on) => {
    const { h } = await stuckTurn($, on, { stuck: { last: 'yes', n: 3 } }, NO_ONE)
    expect(h.asked[0]?.options).toEqual(['Raise effort', 'Keep going', ALWAYS])
    expect(h.question?.options).toEqual(['Raise effort', 'Keep going', ALWAYS])
    const ui = await mount($, surface)
    const buttons = (await ui.findAll({ type: 'Button' })).map(b => b.props as { key?: string; label?: string; hotkey?: string })
    expect(buttons.map(b => b.key)).toEqual(expect.arrayContaining(['q-0', 'q-1', 'q-2']))
    expect(buttons.find(b => b.key === 'q-2')?.hotkey, 'the next number key').toBe('3')
    await ui.unmount()
  })

  test(`Stuck: folded, the third button shows with the other two and has the next number key (${surface})`, S, async ($, on) => {
    const { h } = await stuckTurn($, on, { stuck: { last: 'yes', n: 3 } }, NO_ONE, true)
    expect(h.question?.options).toEqual(['Raise effort', 'Keep going', ALWAYS])
    const ui = await mount($, surface)
    const buttons = (await ui.findAll({ type: 'Button' })).map(b => b.props as { key?: string; label?: string; hotkey?: string })
    expect(buttons.find(b => b.key === 'fold')?.label, 'it is folded').toBe('▴')
    expect(buttons.map(b => b.label)).toEqual(expect.arrayContaining(['Raise effort', 'Keep going', ALWAYS]))
    expect(buttons.find(b => b.key === 'q-2')?.hotkey).toBe('3')
    await ui.unmount()
  })

  test(`Stuck: three noes in a row, ${STOP} is the third button (${surface})`, S, async ($, on) => {
    const { h } = await stuckTurn($, on, { stuck: { last: 'no', n: 3 } }, NO_ONE)
    expect(h.asked[0]?.options).toEqual(['Raise effort', 'Keep going', STOP])
  })

  test(`Stuck: ${ALWAYS} raises effort and sets Raise when stuck to automatic, as the person's (${surface})`, S, async ($, on) => {
    const { h, effort } = await stuckTurn($, on, { stuck: { last: 'yes', n: 3 } }, ALWAYS)
    expect(effort, 'it answered with the raise').toBe('high')
    expect(h.stored.escalation).toBe('raise automatically')
    expect(h.toasts.join('\n')).toMatch(/Raise when stuck set to .*raise automatically.*\/config/)
    expect((h.store.askRuns as Runs).stuck?.closed).toBe(true)
  })

  test(`Stuck: ${STOP} keeps the effort and sets Raise when stuck to off (${surface})`, S, async ($, on) => {
    const { h, effort } = await stuckTurn($, on, { stuck: { last: 'no', n: 3 } }, STOP)
    expect(effort, 'it answered with the no').toBe('medium')
    expect(h.stored.escalation).toBe('off')
    expect(h.toasts.join('\n')).toMatch(/Raise when stuck set to .*off.*\/config/)
    expect((h.store.askRuns as Runs).stuck?.closed).toBe(true)
  })

  test(`Stuck: a normal button on the offer declines it, and nothing is written (${surface})`, S, async ($, on) => {
    const { h, effort } = await stuckTurn($, on, { stuck: { last: 'yes', n: 3 } }, 'Raise effort')
    expect(effort).toBe('high')
    expect(h.stored.escalation).toBeUndefined()
    expect((h.store.askRuns as Runs).stuck?.closed).toBe(true)
  })

  test(`Stuck: a declined case offers nothing again (${surface})`, S, async ($, on) => {
    const { h } = await stuckTurn($, on, { stuck: { last: 'yes', n: 9, closed: true } }, NO_ONE)
    expect(h.asked[0]?.options).toEqual(['Raise effort', 'Keep going'])
  })

  test(`Stuck: a different answer breaks the run (${surface})`, S, async ($, on) => {
    const { h } = await stuckTurn($, on, { stuck: { last: 'yes', n: 2 } }, 'Keep going')
    expect((h.store.askRuns as Runs).stuck).toEqual({ last: 'no', n: 1 })
  })

  test(`Stuck: an unanswered offer is neither counted nor declined (${surface})`, S, async ($, on) => {
    const { h } = await stuckTurn($, on, { stuck: { last: 'yes', n: 3 } }, NO_ONE)
    expect((h.store.askRuns as Runs).stuck).toEqual({ last: 'yes', n: 3 })
  })

  // ---- Keep warm (a band question): Always do this only; it sets Cache changes to Auto ----

  /** 18:00 local on Friday 2027-01-15, as the Cache Ask tests start. */
  const EVENING = new Date(2027, 0, 15, 18, 0, 0, 0).getTime()
  const KEEP_ROWS = { cacheMode: 'Ask' }
  const K = { timeoutMs: 30000, options: KEEP_ROWS }
  const warm = async ($: unknown, on: Parameters<TestBody>[1], runs: Runs, answer: string | typeof NO_ONE) => {
    const h = engine(on, { ...OPUS, stored: KEEP_ROWS, store: { askRuns: runs } })
    h.answers = { 'Keep warm': answer }
    h.now = EVENING
    h.virtual = true
    h.stepUsage = BIG_TURN
    h.commands = WHATSNEXT_CMDS
    installWhatsnext(h)
    const d = drive($, h)
    await d.start(surface)
    await d.step('t1')
    await d.complete('t1')
    await h.advance(5 * MIN)
    await settle()
    return { h, d }
  }

  test(`Keep warm: two Keep warm answers in a row, still two buttons (${surface})`, K, async ($, on) => {
    const { h } = await warm($, on, { keepWarm: { last: 'yes', n: 2 } }, NO_ONE)
    expect(h.question?.options).toEqual(['Keep warm', 'Save handoff note'])
  })

  test(`Keep warm: three Keep warms in a row, ${ALWAYS} is the third button (${surface})`, K, async ($, on) => {
    const { h } = await warm($, on, { keepWarm: { last: 'yes', n: 3 } }, NO_ONE)
    expect(h.question?.options).toEqual(['Keep warm', 'Save handoff note', ALWAYS])
    expect((h.question as unknown as { kind?: string } | null)?.kind).toBe('cache')
    expect((h.store.askRuns as Runs).keepWarm, 'an unanswered offer is not counted').toEqual({ last: 'yes', n: 3 })
  })

  test(`Keep warm: three noes in a row offer nothing, and do not close the case (${surface})`, K, async ($, on) => {
    const { h } = await warm($, on, { keepWarm: { last: 'no', n: 3 } }, NO_ONE)
    expect(h.question?.options).toEqual(['Keep warm', 'Save handoff note'])
    expect((h.store.askRuns as Runs).keepWarm).toEqual({ last: 'no', n: 3 })
  })

  test(`Keep warm: a no after three noes is counted and still closes nothing (${surface})`, K, async ($, on) => {
    const { h } = await warm($, on, { keepWarm: { last: 'no', n: 3 } }, 'Save handoff note')
    expect((h.store.askRuns as Runs).keepWarm).toEqual({ last: 'no', n: 4 })
  })

  test(`Keep warm: ${ALWAYS} keeps warm, sets Cache changes to Auto as the person's, and toasts (${surface})`, K, async ($, on) => {
    const { h } = await warm($, on, { keepWarm: { last: 'yes', n: 3 } }, ALWAYS)
    await h.advance(HOUR)
    expect(h.forks.length, 'it answered Keep warm: the first keep-warm request went out').toBeGreaterThanOrEqual(1)
    expect(h.stored.cacheMode).toBe('Auto')
    expect(h.sets.find(x => x.key === 'rightsize.cacheMode')?.value).toBe('Auto')
    expect(h.toasts.join('\n')).toContain('Cache changes set to Auto. /config changes it.')
    expect((h.store.askRuns as Runs).keepWarm?.closed, 'offered once').toBe(true)
  })

  test(`Keep warm: a normal button on the offer declines it, and nothing is written (${surface})`, K, async ($, on) => {
    const { h } = await warm($, on, { keepWarm: { last: 'yes', n: 3 } }, 'Keep warm')
    await h.advance(HOUR)
    expect(h.stored.cacheMode, 'still Ask').toBe('Ask')
    expect((h.store.askRuns as Runs).keepWarm?.closed).toBe(true)
  })

  test(`Keep warm: a declined case offers nothing again (${surface})`, K, async ($, on) => {
    const { h } = await warm($, on, { keepWarm: { last: 'yes', n: 9, closed: true } }, NO_ONE)
    expect(h.question?.options).toEqual(['Keep warm', 'Save handoff note'])
  })

  test(`Keep warm: a different answer starts the run again (${surface})`, K, async ($, on) => {
    const { h } = await warm($, on, { keepWarm: { last: 'yes', n: 2 } }, 'Save handoff note')
    expect((h.store.askRuns as Runs).keepWarm).toEqual({ last: 'no', n: 1 })
  })

  test(`Helper stuck and the Compact question never offer a third button (${surface})`, K, async ($, on) => {
    const { h } = await warm($, on, { helper: { last: 'yes', n: 9 }, limitCompact: { last: 'yes', n: 9 } }, NO_ONE)
    expect(h.question?.options, 'only Keep warm has an offer, and only after its own run').toEqual(['Keep warm', 'Save handoff note'])
  })
}
