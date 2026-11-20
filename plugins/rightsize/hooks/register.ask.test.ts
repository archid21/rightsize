import { type TestBody, expect, test } from 'claude-code/testing'
import { CAL_STORE } from './cost'
import { BIG_TURN, DEBUG, FREE_SWITCHES, LOG_PATH, LOOKUP, NO_CHANGE, NO_COLD, NO_ONE, REVIEW, SEARCH, bandText, settle, drive, engine, installWhatsnext, last, LOWER, mount, WHATSNEXT_CMDS } from './testkit'

// P-81 step 3 (ADR 0094, general rule 3, groups 1 to 3): what an area does when it resolves to Ask. One question, the
// recommended answer first, with the ADR's button names. Only a question about the prompt about to run may hold it (the
// Question wait, 30 seconds; no answer runs it as typed). Mid-turn, cache and compact questions are band rows that never
// hold anything; with no answer the safe default stands. Cache Off and Compact Off show and do nothing.

for (const surface of ['desktop', 'terminal'] as const) {
  const MIN = 60_000
  const HOUR = 60 * MIN
  const OPUS = { model: 'claude-opus-5-5', effort: 'medium' }
  const SONNET = { model: 'claude-sonnet-5-5', effort: 'medium' }
  const FABLE = { model: 'claude-fable-5-2', effort: 'high' }
  const withRows = (rows: Record<string, string>) => ({ options: rows, stored: rows })
  const ASK = { changes: 'Ask' }
  const HAND_OFF = '{"level":"low","model":"haiku","size":"bulky","type":"search","read":150000,"write":3000,"steps":30,"reason":"repo-wide search"}'
  const RAISE_HIGH = '{"level":"high","model":"same","type":"review","read":20000,"write":3000,"steps":8,"reason":"unknown cause"}'
  const log = (h: ReturnType<typeof engine>) => h.files[LOG_PATH] ?? ''
  const handedTo = (h: ReturnType<typeof engine>) => /model "(\w+)"/.exec(last(h.submitted)?.context?.join('\n') ?? '')?.[1]
  type Question = { header?: string; question?: string; options?: string[]; kind?: string; blocks?: boolean } | null
  const onBand = (h: ReturnType<typeof engine>) => h.question as unknown as Question

  // ---- Group 1: before the prompt (a dialog that holds the prompt up to the Question wait) ----

  type Before = {
    name: string
    start: { model: string; effort: string; store?: Record<string, unknown> }
    rows: Record<string, string>
    rating: string
    text: string
    header: string
    question: RegExp
    options: (string | RegExp)[]
    /** What each answer ends in: the effort or hand-off the turn was sent with. */
    acts: (h: ReturnType<typeof engine>) => unknown
    yes: string
    wantYes: unknown
    no: string
    wantNo: unknown
  }
  const BEFORE: Before[] = [
    {
      name: 'routine work: lower effort',
      start: { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES } },
      rows: ASK,
      rating: LOWER,
      text: LOOKUP,
      header: 'Effort',
      question: /^Routine work\. Lower effort to low\?/,
      options: ['Lower effort', 'Keep as is'],
      acts: h => last(h.sent)?.effort,
      yes: 'Lower effort',
      wantYes: 'low',
      no: 'Keep as is',
      wantNo: 'medium',
    },
    {
      name: 'a raise before the prompt',
      start: OPUS,
      rows: ASK,
      rating: RAISE_HIGH,
      text: DEBUG,
      header: 'Effort',
      question: /^Unknown cause\. Raise effort to high\?/,
      options: ['Raise effort', 'Keep as is'],
      acts: h => last(h.sent)?.effort,
      yes: 'Raise effort',
      wantYes: 'high',
      no: 'Keep as is',
      wantNo: 'medium',
    },
    {
      name: 'a routine task a cheaper helper can do',
      start: OPUS,
      rows: ASK,
      rating: HAND_OFF,
      text: SEARCH,
      header: 'Subagent',
      question: /^Send to a Haiku helper\? (\$[\d.]+ vs ~\$[\d.]+ on Opus|~\d+% of the usage)/,
      options: ['Send to Haiku', /^Keep on Opus( \(lower effort\))?$/],
      acts: handedTo,
      yes: 'Send to Haiku',
      wantYes: 'haiku',
      no: 'Keep on Opus',
      wantNo: undefined,
    },
    {
      name: 'a review from a Sonnet start',
      start: { ...SONNET, store: { [CAL_STORE]: FREE_SWITCHES } },
      rows: ASK,
      rating: REVIEW,
      text: DEBUG,
      header: 'Stronger',
      question: /^Run this review on Opus for one turn\?/,
      options: ['Use Opus', 'Stay on Sonnet'],
      acts: h => last(h.sent)?.model,
      yes: 'Use Opus',
      wantYes: 'opus',
      no: 'Stay on Sonnet',
      wantNo: 'claude-sonnet-5-5',
    },
  ]

  const before = async ($: unknown, on: Parameters<TestBody>[1], b: Before, answer: string | typeof NO_ONE) => {
    const h = engine(on, { ...b.start, stored: { ...NO_COLD, ...b.rows } })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = b.rating
    h.answers = { [b.header]: answer }
    h.sleepEnds = true
    await d.submit(b.text)
    await d.step('t1')
    return { h, d, out: b.acts(h) }
  }

  for (const b of BEFORE) {
    test(`Ask, ${b.name}: one question with the ADR's wording, the recommended answer first (${surface})`, { timeoutMs: 30000, options: { ...NO_COLD, ...b.rows } }, async ($, on) => {
      const { h } = await before($, on, b, b.yes)
      expect(h.asked.map(x => x.header), 'one question').toEqual([b.header])
      expect(h.asked[0]?.question).toMatch(b.question)
      expect(h.asked[0]?.options.length, 'two buttons').toBe(2)
      b.options.forEach((o, i) => (typeof o === 'string' ? expect(h.asked[0]?.options[i]).toBe(o) : expect(h.asked[0]?.options[i]).toMatch(o)))
      expect(h.question, 'a dialog that holds the prompt, never a band row').toBeNull()
    })

    test(`Ask, ${b.name}: ${b.yes} acts (${surface})`, { timeoutMs: 30000, options: { ...NO_COLD, ...b.rows } }, async ($, on) => {
      expect((await before($, on, b, b.yes)).out).toBe(b.wantYes)
    })

    test(`Ask, ${b.name}: ${b.no} changes nothing more, and asks no second question (${surface})`, { timeoutMs: 30000, options: { ...NO_COLD, ...b.rows } }, async ($, on) => {
      const kept = await before($, on, b, b.no)
      expect(kept.out).toBe(b.wantNo)
      expect(kept.h.asked.length, 'no second question').toBe(1)
    })

    test(`Ask, ${b.name}: no answer in 30 seconds runs the prompt as typed (${surface})`, { timeoutMs: 30000, options: { ...NO_COLD, ...b.rows } }, async ($, on) => {
      const { h, out } = await before($, on, b, NO_ONE)
      expect(h.sleeps, 'it waited the Question wait').toContain(30_000)
      expect(last(h.submitted)?.text, 'as typed').toBe(b.text)
      expect(out, 'no change').toBe(b.wantNo)
      expect(log(h)).toMatch(/no answer in 30 seconds to (Effort|Subagent|Stronger)/)
    })
  }

  // ---- Group 2: during a turn (band rows; Claude never waits) ----

  const OPEN = { timeoutMs: 30000, options: { ...NO_COLD, ...ASK, lowerRule: 'never lower' } }
  /** A turn that fails the same call twice at its first step: Claude looks stuck. Returns the effort of the step after it. */
  const stuckTurn = async ($: unknown, on: Parameters<TestBody>[1], answer: string | typeof NO_ONE) => {
    const h = engine(on, { ...OPUS, stored: { ...NO_COLD, ...ASK, lowerRule: 'never lower' } })
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

  test(`Ask, Claude looks stuck: one band question, Raise effort first and Keep going second, and the turn is never held (${surface})`, OPEN, async ($, on) => {
    const { h, effort } = await stuckTurn($, on, NO_ONE)
    expect(h.asked.map(x => x.header)).toEqual(['Stuck'])
    expect(h.asked[0]?.question).toMatch(/^Claude looks stuck: .+\. Raise effort to high\?/)
    expect(h.asked[0]?.options).toEqual(['Raise effort', 'Keep going'])
    expect(onBand(h)?.header, 'it is on the band, waiting').toBe('Stuck')
    expect(onBand(h)?.blocks, 'it holds nothing, so it does not unfold the band').toBeUndefined()
    expect(effort, 'no answer: the turn went on at its effort').toBe('medium')
    expect(h.sleeps, 'no wait at all').toEqual([])
  })

  test(`Ask, Claude looks stuck: Raise effort raises it (${surface})`, OPEN, async ($, on) => {
    expect((await stuckTurn($, on, 'Raise effort')).effort).toBe('high')
  })

  test(`Ask, Claude looks stuck: Keep going keeps it (${surface})`, OPEN, async ($, on) => {
    expect((await stuckTurn($, on, 'Keep going')).effort).toBe('medium')
  })

  const HELPER = { timeoutMs: 30000, options: { ...NO_COLD, ...ASK, downRule: 'always send' } }
  const stuckHelper = async ($: unknown, on: Parameters<TestBody>[1], answer: string | typeof NO_ONE) => {
    const h = engine(on, { ...FABLE, stored: { ...NO_COLD, ...ASK, downRule: 'always send' }, store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    await d.start(surface)
    h.subModel = 'claude-haiku-5-5'
    await d.step('t0')
    await d.complete('t0')
    h.rating = '{"fit":{"haiku":"low","sonnet":"low","opus":"low","fable":"low"},"type":"search","read":150000,"write":3000,"steps":30,"reason":"repo-wide search"}'
    h.answers = { Stuck: answer }
    await d.submit(SEARCH)
    await d.step('t1', 0)
    await d.agent('haiku')
    await d.spawn('helper', 'haiku')
    await d.step('t1', 0, 'agent-helper')
    await d.bash('fail make', 'agent-helper')
    await d.bash('fail make', 'agent-helper')
    await d.step('t1', 1, 'agent-helper')
    await settle()
    const next = (await d.bash('ls', 'agent-helper')) as { deny?: string }
    return { h, next }
  }

  test(`Ask, a helper is stuck: Finish on the session's model first, Give it one more try second, on the band, and nothing is held (${surface})`, HELPER, async ($, on) => {
    const { h, next } = await stuckHelper($, on, NO_ONE)
    expect(h.asked.map(x => x.header)).toEqual(['Stuck'])
    expect(h.asked[0]?.question).toMatch(/^The Haiku helper is stuck: .+\. Finish on Fable\?/)
    expect(h.asked[0]?.options).toEqual(['Finish on Fable', 'Give it one more try'])
    expect(onBand(h)?.header, 'a band row').toBe('Stuck')
    expect(onBand(h)?.blocks).toBeUndefined()
    expect(next.deny, 'no answer: the helper goes on at its effort').toBeUndefined()
    expect(h.sleeps, 'no wait').toEqual([])
  })

  test(`Ask, a helper is stuck: Finish on Fable stops the helper and sends its work back to the main chat (${surface})`, HELPER, async ($, on) => {
    const { h, next } = await stuckHelper($, on, 'Finish on Fable')
    expect(next.deny).toContain('stuck')
    expect(log(h)).toContain('you chose to finish on Fable')
  })

  test(`Ask, a helper is stuck: Give it one more try raises it one level and goes on (${surface})`, HELPER, async ($, on) => {
    const { h, next } = await stuckHelper($, on, 'Give it one more try')
    expect(next.deny).toBeUndefined()
    expect(log(h)).toContain('raised helper agent-helper low → medium')
  })

  // ---- Group 3: the Cache area (a band question; nothing waits) ----

  /** 18:00 local on Friday 2027-01-15. */
  const EVENING = new Date(2027, 0, 15, 18, 0, 0, 0).getTime()
  const warmSession = async ($: unknown, on: Parameters<TestBody>[1], rows: Record<string, string>, over: { whatsnext?: boolean; answer?: string | typeof NO_ONE } = {}) => {
    const h = engine(on, { ...OPUS, stored: rows })
    if (over.answer !== undefined) h.answers = { 'Keep warm': over.answer }
    h.now = EVENING
    h.virtual = true
    h.stepUsage = BIG_TURN
    h.commands = over.whatsnext ? WHATSNEXT_CMDS : []
    if (over.whatsnext) installWhatsnext(h)
    const d = drive($, h)
    await d.start(surface)
    await d.step('t1')
    await d.complete('t1')
    await h.advance(5 * MIN)
    return { h, d }
  }
  const KEEP = { ...withRows({ cacheMode: 'Ask' }) }

  test(`Cache Ask, keep warm pays: "Keep warm until <time>? <cost>", Keep warm then Save handoff note, on the band (${surface})`, { timeoutMs: 30000, options: KEEP.options }, async ($, on) => {
    const { h } = await warmSession($, on, KEEP.stored, { whatsnext: true, answer: NO_ONE })
    const q = onBand(h)
    expect(q?.header).toBe('Keep warm')
    expect(q?.question).toMatch(/^Keep warm until \d{1,2}:\d\d (AM|PM)( tomorrow)?\? (~\$[\d.]+|~[\d.–]+% usage)$/)
    expect(q?.options).toEqual(['Keep warm', 'Save handoff note'])
    expect(q?.kind).toBe('cache')
    expect(q?.blocks, 'never holds anything').toBeUndefined()
    expect(h.forks.length, 'nothing runs by itself while it waits').toBe(0)
    expect(h.sleeps, 'no wait on the Question wait').not.toContain(30_000)
    expect(await bandText($, surface), 'the Cache timer row stays').toContain('to come back')
  })

  test(`Cache Ask: Keep warm starts keeping warm, with no further question (${surface})`, { timeoutMs: 30000, options: KEEP.options }, async ($, on) => {
    const h = engine(on, { ...OPUS, stored: KEEP.stored })
    h.now = EVENING
    h.virtual = true
    h.stepUsage = BIG_TURN
    h.answers = { 'Keep warm': 'Keep warm' }
    const d = drive($, h)
    await d.start(surface)
    await d.step('t1')
    await d.complete('t1')
    await h.advance(5 * MIN)
    expect(h.asked.map(x => x.header)).toEqual(['Keep warm'])
    await h.advance(HOUR)
    expect(h.forks.length, 'the first keep-warm request went out').toBeGreaterThanOrEqual(1)
    expect(log(h)).toMatch(/keeping warm until .*\(button /)
  })

  test(`Cache Ask: Save handoff note saves it with whatsnext (${surface})`, { timeoutMs: 30000, options: KEEP.options }, async ($, on) => {
    const h = engine(on, { ...OPUS, stored: KEEP.stored })
    h.now = EVENING
    h.virtual = true
    h.stepUsage = BIG_TURN
    h.commands = WHATSNEXT_CMDS
    installWhatsnext(h)
    h.answers = { 'Keep warm': 'Save handoff note' }
    const d = drive($, h)
    await d.start(surface)
    await d.step('t1')
    await d.complete('t1')
    await h.advance(5 * MIN)
    await settle()
    expect(h.submitted.map(s => s.text)).toEqual(['wrap up'])
    expect(h.forks.length).toBe(0)
  })

  test(`Cache Ask, no answer: with whatsnext a handoff note is saved before the cache goes cold, and nothing is held (${surface})`, { timeoutMs: 30000, options: KEEP.options }, async ($, on) => {
    const { h } = await warmSession($, on, KEEP.stored, { whatsnext: true, answer: NO_ONE })
    expect(h.submitted, 'nothing yet').toEqual([])
    await h.advance(HOUR)
    expect(h.submitted.map(s => s.text), 'at the lead time before it goes cold').toEqual(['wrap up'])
    expect(h.forks.length, 'and nothing was kept warm').toBe(0)
    expect(onBand(h), 'the question went with it').toBeNull()
    expect(log(h)).toContain('no answer on the band to Keep warm: a handoff note is saved')
  })

  test(`Cache Ask, no answer, no whatsnext: the second button is Let it go cold, and nothing happens (${surface})`, { timeoutMs: 30000, options: KEEP.options }, async ($, on) => {
    const { h } = await warmSession($, on, KEEP.stored, { answer: NO_ONE })
    expect(onBand(h)?.options).toEqual(['Keep warm', 'Let it go cold'])
    await h.advance(HOUR)
    expect(h.submitted, 'no handoff note without whatsnext').toEqual([])
    expect(h.forks.length).toBe(0)
    expect(h.compactions, 'and no compact').toBe(0)
  })

  test(`Cache Ask is the Cache area only: Changes Ask with Cache Auto asks no keep-warm question, and keep warm runs by itself (${surface})`, { timeoutMs: 30000, options: withRows({ changes: 'Ask', cacheMode: 'Auto' }).options }, async ($, on) => {
    const { h } = await warmSession($, on, withRows({ changes: 'Ask', cacheMode: 'Auto' }).stored)
    expect(onBand(h)).toBeNull()
    await h.advance(HOUR)
    expect(h.forks.length, 'keep warm while it pays: the first request at 57 minutes').toBe(1)
  })

  test(`Cache Ask follows Changes Ask when Cache is Same as Changes (${surface})`, { timeoutMs: 30000, options: withRows({ changes: 'Ask' }).options }, async ($, on) => {
    const { h } = await warmSession($, on, withRows({ changes: 'Ask' }).stored, { answer: NO_ONE })
    expect(onBand(h)?.header).toBe('Keep warm')
  })

  test(`Cache Off: no question, no keep warm, no handoff note; the timer line follows Cache timer, not this (${surface})`, { timeoutMs: 30000, options: withRows({ cacheMode: 'Off' }).options }, async ($, on) => {
    const { h } = await warmSession($, on, withRows({ cacheMode: 'Off' }).stored, { whatsnext: true })
    expect(onBand(h)).toBeNull()
    expect(h.asked).toEqual([])
    expect(await bandText($, surface), 'the timer line is still there').toContain('to come back')
    await h.advance(2 * HOUR)
    expect(h.forks.length, 'no keep warm').toBe(0)
    expect(h.submitted, 'no handoff note').toEqual([])
    expect(log(h)).toContain('the Cache area is Off')
  })

  test(`Cache Off with Cache timer off: no row at all (${surface})`, { timeoutMs: 30000, options: withRows({ cacheMode: 'Off', cacheTimer: 'off' }).options }, async ($, on) => {
    const { h } = await warmSession($, on, withRows({ cacheMode: 'Off', cacheTimer: 'off' }).stored)
    expect(await bandText($, surface)).toBe('')
    expect(onBand(h)).toBeNull()
  })

  // ---- Group 3: the Compact area, near the 5-hour limit ----

  /** A main request that read 100,000 tokens in all: on Opus a compaction now saves $0.59 after the reset. */
  const BIG = { input_tokens: 200, output_tokens: 400, cache_read_input_tokens: 99_500, cache_creation_input_tokens: 300 }
  const nearLimit = async ($: unknown, on: Parameters<TestBody>[1], rows: Record<string, string>, answer?: string | typeof NO_ONE) => {
    const h = engine(on, { ...OPUS, stored: { ...NO_COLD, billing: 'api', lowerRule: 'never lower', ...rows } })
    h.rating = NO_CHANGE
    h.stepUsage = BIG
    h.commands = []
    h.rateLimits = [{ kind: 'five_hour', percentUsed: 92, resetsAt: new Date(h.now + 3 * HOUR).toISOString() }]
    if (answer !== undefined) h.answers = { Compact: answer }
    const d = drive($, h)
    await d.start(surface)
    await d.submit('continue')
    await d.turnStart('t1', 'continue')
    await d.step('t1')
    await d.complete('t1')
    return { h, d }
  }
  const COMPACT_ASK = { billing: 'api', lowerRule: 'never lower', compactMode: 'Ask' }
  const NEAR = { billing: 'api', lowerRule: 'never lower' }

  test(`Compact Ask, near the 5-hour limit: "Compact now to save ~$0.59 after reset?", Compact now then Not now, on the band (${surface})`, { timeoutMs: 30000, options: COMPACT_ASK }, async ($, on) => {
    const { h } = await nearLimit($, on, { compactMode: 'Ask' }, NO_ONE)
    expect(h.asked.map(x => x.header)).toEqual(['Compact'])
    expect(h.asked[0]?.question).toMatch(/^Compact now to save ~\$0\.59 after reset\?/)
    expect(h.asked[0]?.options).toEqual(['Compact now', 'Not now'])
    expect(onBand(h)?.header, 'a band row').toBe('Compact')
    expect(onBand(h)?.kind).toBe('cost')
    expect(onBand(h)?.blocks).toBeUndefined()
    expect(h.compactions, 'no answer: nothing compacted').toBe(0)
    expect(h.sleeps).not.toContain(30_000)
  })

  const press = async ($: unknown, key: string) => {
    const ui = await mount($, surface)
    await ui.press({ key })
    await ui.unmount()
    await settle()
  }

  test(`Compact Ask: Compact now compacts, once the person presses it and not before (${surface})`, { timeoutMs: 30000, options: COMPACT_ASK }, async ($, on) => {
    const { h } = await nearLimit($, on, { compactMode: 'Ask' }, NO_ONE)
    expect(h.compactions, 'asked, nothing compacted').toBe(0)
    await press($, 'q-0')
    expect(h.compactions).toBe(1)
    expect(log(h)).toContain("usage-limit advice: compacted before the reset, on the person's button")
  })

  test(`Compact Ask: Not now compacts nothing (${surface})`, { timeoutMs: 30000, options: COMPACT_ASK }, async ($, on) => {
    const { h } = await nearLimit($, on, { compactMode: 'Ask' }, NO_ONE)
    await press($, 'q-1')
    expect(h.compactions).toBe(0)
    expect(onBand(h), 'the question is gone').toBeNull()
  })

  test(`Compact Ask follows Changes Ask (${surface})`, { timeoutMs: 30000, options: { ...NEAR, changes: 'Ask' } }, async ($, on) => {
    const { h } = await nearLimit($, on, { changes: 'Ask' }, NO_ONE)
    expect(h.asked.map(x => x.header)).toEqual(['Compact'])
  })

  test(`Changes Ask with Compact Auto shows the usage-limit advice row, not a question (${surface})`, { timeoutMs: 30000, options: { ...NEAR, changes: 'Ask', compactMode: 'Auto' } }, async ($, on) => {
    const auto = await nearLimit($, on, { changes: 'Ask', compactMode: 'Auto' })
    expect(auto.h.asked).toEqual([])
    expect(await bandText($, surface)).toContain('Compact now to save ~$0.59 after the reset.')
  })

  test(`Compact Off: no advice and no question near the limit, and no Compact Now button on the timer row (${surface})`, { timeoutMs: 30000, options: { ...NEAR, compactMode: 'Off', beforeCold: 'ask' } }, async ($, on) => {
    const { h } = await nearLimit($, on, { compactMode: 'Off', beforeCold: 'ask' })
    expect(h.asked).toEqual([])
    expect(await bandText($, surface), 'no limit advice').not.toContain('Compact now to save')
    const ui = await mount($, surface)
    const keys = (await ui.findAll({ type: 'Button' })).map(b => String(b.props?.key))
    await ui.unmount()
    expect(keys.filter(k => /compact/i.test(k)), 'no compact button on the Cache row').toEqual([])
    expect(h.compactions).toBe(0)
  })

  test(`Compact Off: rightsize runs no compact of its own, even where Before the cache goes cold says compact (${surface})`, { timeoutMs: 30000, options: withRows({ compactMode: 'Off', beforeCold: 'compact' }).options }, async ($, on) => {
    const h = engine(on, { ...OPUS, stored: { compactMode: 'Off', beforeCold: 'compact' } })
    h.now = EVENING
    h.virtual = true
    h.stepUsage = BIG_TURN
    const d = drive($, h)
    await d.start(surface)
    await d.step('t1')
    await d.complete('t1')
    await h.advance(2 * HOUR)
    expect(h.compactions).toBe(0)
    expect(log(h)).toContain('compact skipped: the Compact area is Off')
  })

  test(`Compact Auto (the default) near the limit is unchanged: the advice row, and a Compact Now button (${surface})`, { timeoutMs: 30000, options: NEAR }, async ($, on) => {
    const { h } = await nearLimit($, on, {})
    expect(h.asked).toEqual([])
    expect(await bandText($, surface)).toContain('Compact now to save ~$0.59 after the reset.')
  })
}
