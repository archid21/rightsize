import { type TestBody, expect, test } from 'claude-code/testing'
import { CAL_STORE, REESTIMATE_AFTER } from './cost'
import { FALSE_ALARM_NOTE, FINISH_UP_TEXT, PLAN_FIRST_TEXT, STOPPED_TEXT, STOP_REPORT_TEXT } from './bigturn'
import { missRates } from './misses'
import type { RunLine } from './report'
import { DAY, LOG_PATH, NO_COLD, NO_ONE, REVIEW, RUNS_FILE, bandText, drive, engine, last, settle } from './testkit'

// The big-turn warning (P-46, ADR 0075): the opt-in question after the first turn over the person's top 1%, the hold before a prompt
// that looks that expensive, and the band row during a turn. Off by default; a row the person set is never asked about or overridden.

const logOf = (h: ReturnType<typeof engine>) => h.files[LOG_PATH] ?? ''
const runLines = (h: ReturnType<typeof engine>) =>
  (h.files[RUNS_FILE] ?? '')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as RunLine & { bigTurn?: Record<string, { answer: string; lo: number; hi: number; amount: number }>; loweredBy?: string; auto?: boolean })
    .filter(l => (l.kind ?? 'run') === 'run')

/** A big job: about $2.70 on Sonnet at high effort, at its own level, so rightsize changes nothing. */
const BIG = '{"level":"high","model":"same","size":"large","type":"feature","read":300000,"write":50000,"steps":40,"reason":"a large feature"}'
/** A small job by estimate, but rated for 40 steps: each request that costs $0.03 projects to about $1.30. */
const LONG = '{"level":"high","model":"same","size":"small","type":"feature","read":5000,"write":2000,"steps":40,"reason":"long but light"}'
/** The same job rated small: far under any amount. */
const SMALL = '{"level":"high","model":"same","size":"small","type":"feature","read":2000,"write":300,"steps":2,"reason":"small"}'
const PROMPT = 'implement the whole thing across the app'
/** A request that costs about $0.03 on Sonnet: 3,000 tokens of output. */
const COSTLY_STEP = { input_tokens: 200, output_tokens: 3000, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 300 }
const SONNET = { model: 'claude-sonnet-5-5', effort: 'high' }
const HEADS_UP = 'Big turn'
const DURING = 'Big turn now'
const OPT_IN = 'Big-turn warning'
const AMOUNT = 'Big-turn amount'
const STOP = 'Warnings during a turn'
const ASK = 'Warn you before a prompt that looks this expensive?'

/** `config`: rows the person sets in /config after the start (so they are theirs and take effect at once). */
type Opts = { config?: Record<string, string>; store?: Record<string, unknown>; start?: typeof SONNET }
const session = async ($: unknown, on: Parameters<TestBody>[1], surface: 'desktop' | 'terminal', o: Opts = {}) => {
  const h = engine(on, { ...(o.start ?? SONNET), stored: { ...NO_COLD }, ...(o.store ? { store: o.store } : {}) })
  const d = drive($, h)
  await d.start(surface)
  for (const [key, value] of Object.entries(o.config ?? {})) await d.config(key, value)
  return { h, d }
}
/** One turn of `PROMPT` rated as `rating`, costing `cost` in the ledger, finished, with the band's questions answered. */
const turn = async (h: ReturnType<typeof engine>, d: ReturnType<typeof drive>, id: string, rating: string, cost = 0.01) => {
  h.rating = rating
  h.stepCost = cost
  await d.submit(PROMPT)
  await d.step(id, 0)
  await d.complete(id)
  await settle()
}
const asked = (h: ReturnType<typeof engine>, header: string) => h.asked.filter(x => x.header === header)

for (const surface of ['desktop', 'terminal'] as const) {
  // ---- The opt-in question ----

  test(`opt-in: the first finished turn over the amount asks once, and a second one does not (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on, surface)
    h.answers[OPT_IN] = 'No thanks'
    await turn(h, d, 't1', SMALL, 0.5)
    expect(asked(h, OPT_IN), 'a turn under the amount asks nothing').toEqual([])
    await turn(h, d, 't2', SMALL, 2.5)
    const q = asked(h, OPT_IN)
    expect(q.length).toBe(1)
    expect(q[0]?.question).toContain(`That turn cost ~$2.50, more than 99% of your turns. ${ASK}`)
    expect(q[0]?.options).toEqual(['Yes', 'No thanks'])
    await turn(h, d, 't3', SMALL, 3)
    expect(asked(h, OPT_IN).length, 'not asked again').toBe(1)
    expect(h.stored.bigTurn, 'nothing was turned on').toBeUndefined()
    expect(logOf(h)).toContain('big-turn question: that turn cost $2.50')
    expect(logOf(h)).toContain('big-turn question: No thanks')
  })

  test(`opt-in: Yes, then "Your top 1%" sets the row to auto, and the text carries the false-alarm sentence (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on, surface)
    h.answers[OPT_IN] = 'Yes'
    h.answers[AMOUNT] = 'Your top 1% (now $2.00, updates weekly)'
    await turn(h, d, 't1', SMALL, 2.5)
    await settle()
    const q = asked(h, AMOUNT)
    expect(q.length).toBe(1)
    expect(q[0]?.options).toEqual(['Your top 1% (now $2.00, updates weekly)', 'Set an amount'])
    expect(q[0]?.question).toContain(FALSE_ALARM_NOTE)
    expect(FALSE_ALARM_NOTE).toBe('rightsize learns as you go: early warnings can be false alarms.')
    expect(h.stored.bigTurn).toBe('auto')
    expect(h.sets.filter(x => x.key === 'rightsize.bigTurn').map(x => x.value)).toEqual(['auto'])
  })

  for (const amount of ['$1', '$2', '$5']) {
    test(`opt-in: Yes, then Set an amount, then ${amount} sets the row to ${amount} (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
      const { h, d } = await session($, on, surface)
      h.answers[OPT_IN] = 'Yes'
      h.answerQueue[AMOUNT] = ['Set an amount', amount]
      await turn(h, d, 't1', SMALL, 2.5)
      await settle()
      const q = asked(h, AMOUNT)
      expect(q.length).toBe(2)
      expect(q[1]?.options).toEqual(['$1', '$2', '$5'])
      expect(q[1]?.question).toContain(FALSE_ALARM_NOTE)
      expect(h.stored.bigTurn).toBe(amount)
    })
  }

  test(`opt-in: No thanks is not asked again for 90 days (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on, surface)
    h.answers[OPT_IN] = 'No thanks'
    await turn(h, d, 't1', SMALL, 2.5)
    expect(asked(h, OPT_IN).length).toBe(1)
    h.now += 89 * DAY
    await turn(h, d, 't2', SMALL, 2.5)
    expect(asked(h, OPT_IN).length, 'day 89: still quiet').toBe(1)
    h.now += 2 * DAY
    await turn(h, d, 't3', SMALL, 2.5)
    expect(asked(h, OPT_IN).length, 'day 91: asked again').toBe(2)
  })

  test(`opt-in: no answer counts as No thanks for this time only: asked again at the next qualifying turn after 7 days (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on, surface)
    h.answers[OPT_IN] = NO_ONE
    await turn(h, d, 't1', SMALL, 2.5)
    expect(asked(h, OPT_IN).length).toBe(1)
    // The next prompt takes the unanswered question away.
    await turn(h, d, 't2', SMALL, 2.5)
    expect(logOf(h)).toContain('no answer on the band to Big-turn warning')
    expect(asked(h, OPT_IN).length, 'day 0: not again').toBe(1)
    h.now += 6 * DAY
    await turn(h, d, 't3', SMALL, 2.5)
    expect(asked(h, OPT_IN).length, 'day 6: not yet').toBe(1)
    h.now += 2 * DAY
    await turn(h, d, 't4', SMALL, 2.5)
    expect(asked(h, OPT_IN).length, 'day 8: asked again').toBe(2)
    expect(h.stored.bigTurn).toBeUndefined()
  })

  for (const row of ['off', '$5']) {
    test(`opt-in: a row the person set (${row}) is never asked about or overridden (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
      const { h, d } = await session($, on, surface, { config: { bigTurn: row } })
      const before = h.sets.length
      await turn(h, d, 't1', SMALL, 9)
      expect(asked(h, OPT_IN), `set to ${row}`).toEqual([])
      expect(h.sets.length, 'rightsize wrote no row').toBe(before)
      expect(h.stored.bigTurn).toBe(row)
    })
  }

  test(`opt-in: a row set in the settings file before the session starts is the person's too (${surface})`, { timeoutMs: 30000, options: { bigTurn: 'off' } }, async ($, on) => {
    const h = engine(on, { ...SONNET, stored: { ...NO_COLD, bigTurn: 'off' } })
    const d = drive($, h)
    await d.start(surface)
    await turn(h, d, 't1', SMALL, 9)
    expect(asked(h, OPT_IN)).toEqual([])
    expect(h.sets.filter(x => x.key === 'rightsize.bigTurn')).toEqual([])
  })

  test(`opt-in: the row is off by default, so no prompt is held and no turn warned, however big (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on, surface)
    h.answers[OPT_IN] = 'No thanks'
    h.stepUsage = COSTLY_STEP
    await turn(h, d, 't1', BIG)
    expect(asked(h, HEADS_UP)).toEqual([])
    expect(asked(h, DURING)).toEqual([])
    h.rating = LONG
    await d.submit(PROMPT)
    for (let i = 0; i < 8; i++) await d.step('t2', i)
    await settle()
    await d.complete('t2')
    expect(asked(h, DURING)).toEqual([])
  })

  test(`a non-interactive run (-p, which includes --max-budget-usd) is never held or warned (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...SONNET, stored: { ...NO_COLD } })
    const d = drive($, h)
    await d.start(surface, false)
    await d.config('bigTurn', '$1')
    h.stepUsage = COSTLY_STEP
    h.rating = BIG
    await d.submit(PROMPT)
    for (let i = 0; i < 8; i++) await d.step('t1', i)
    await d.complete('t1')
    await settle()
    expect(h.asked.filter(x => [HEADS_UP, DURING, OPT_IN].includes(x.header))).toEqual([])
    expect(last(h.submitted)?.text).toBe(PROMPT)
    expect(logOf(h)).not.toContain('big-turn')
  })

  test(`a non-interactive run is not asked to opt in either (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...SONNET, stored: { ...NO_COLD } })
    const d = drive($, h)
    await d.start(surface, false)
    await turn(h, d, 't1', SMALL, 9)
    expect(asked(h, OPT_IN)).toEqual([])
  })

  // ---- Before the prompt ----

  test(`before: an estimate at the amount holds the prompt, with the range and the three buttons; Run it sends it unchanged (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on, surface, { config: { bigTurn: '$2' } })
    h.answers[HEADS_UP] = 'Run it'
    h.rating = BIG
    await d.submit(PROMPT)
    const q = asked(h, HEADS_UP)
    expect(q.length).toBe(1)
    expect(q[0]?.question).toMatch(/^Heads-up: this looks like a long turn, about \$[\d.]+–\$[\d.]+ \(your top 1% start at \$2\.00\)\. \(still learning your work\) No answer in 30 seconds: it runs as it is\.$/)
    expect(q[0]?.options).toEqual(['Run it', 'Plan first', 'Lower effort (high to medium)'])
    expect(last(h.submitted)?.text).toBe(PROMPT)
    await d.step('t1', 0)
    expect(last(h.sent)?.effort, 'effort as it was').toBe('high')
    await d.complete('t1')
    expect(logOf(h)).toMatch(/big-turn warning before the prompt: estimate \$[\d.]+, range \$[\d.]+-\$[\d.]+ \(default\), amount \$2\.00, still learning/)
    expect(logOf(h)).toContain('big-turn answer: you chose Run it')
    expect(runLines(h)[0]?.bigTurn?.before?.answer).toBe('run')
  })

  test(`before: no answer in the Question wait runs it unchanged, and logs the timeout (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on, surface, { config: { bigTurn: '$2' } })
    h.sleepEnds = true
    h.answers[HEADS_UP] = NO_ONE
    h.rating = BIG
    await d.submit(PROMPT)
    expect(asked(h, HEADS_UP).length).toBe(1)
    expect(last(h.submitted)?.text).toBe(PROMPT)
    expect(h.sleeps).toContain(30_000)
    expect(logOf(h)).toContain('no answer in 30 seconds to Big turn: Run it')
    await d.step('t1', 0)
    expect(last(h.sent)?.effort).toBe('high')
    await d.complete('t1')
    expect(runLines(h)[0]?.bigTurn?.before?.answer).toBe('none')
  })

  test(`before: Plan first appends its request after a blank line (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on, surface, { config: { bigTurn: '$2' } })
    h.answers[HEADS_UP] = 'Plan first'
    h.rating = BIG
    await d.submit(PROMPT)
    expect(last(h.submitted)?.text).toBe(`${PROMPT}\n\nBefore doing the work, propose a short plan and wait for my go-ahead.`)
    expect(PLAN_FIRST_TEXT).toBe('Before doing the work, propose a short plan and wait for my go-ahead.')
    expect(logOf(h)).toContain('big-turn answer: Plan first')
    // The turn that starts carries the appended text and still finds its run.
    await d.turnStart('t1', `${PROMPT}\n\n${PLAN_FIRST_TEXT}`)
    await d.step('t1', 0)
    await d.complete('t1')
    expect(runLines(h)[0]?.bigTurn?.before?.answer).toBe('plan')
  })

  test(`before: Lower effort runs the prompt one level lower, as the person's choice, and leaves the next prompt alone (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on, surface, { config: { bigTurn: '$2' } })
    h.answers[HEADS_UP] = 'Lower effort (high to medium)'
    h.rating = BIG
    await d.submit(PROMPT)
    await d.step('t1', 0)
    expect(last(h.sent)?.effort).toBe('medium')
    await d.complete('t1')
    expect(logOf(h)).toContain('big-turn answer: you chose Lower effort: high to medium for this prompt')
    const line = runLines(h)[0]
    expect(line?.loweredBy).toBe('you')
    expect(line?.auto, 'not an automatic lowering').toBe(false)
    expect(line?.level).toBe('medium')
    expect(line?.bigTurn?.before?.answer).toBe('lower')
    expect(missRates(runLines(h)), 'the misses log leaves it out').toEqual({})
    // The next prompt runs at the session's own level again.
    h.answers[HEADS_UP] = 'Run it'
    await d.submit(PROMPT)
    await d.step('t2', 0)
    expect(last(h.sent)?.effort).toBe('high')
    await d.complete('t2')
  })

  const REVIEW_BIG = '{"level":"high","model":"same","size":"large","type":"review","read":300000,"write":50000,"steps":40,"reason":"a review"}'
  const NO_LOWER: [string, Opts, string][] = [
    ['a review', { config: { bigTurn: '$2' }, start: { model: 'claude-opus-5-5', effort: 'high' } }, REVIEW_BIG],
    ['the Lowest effort row', { config: { bigTurn: '$2', floor: 'high' } }, BIG],
    ['a Lowering rule of never', { config: { bigTurn: '$2', lowerRule: 'never lower' } }, BIG],
    ['a rating the rater was not sure of', { config: { bigTurn: '$2' } }, BIG.replace('"reason"', '"sure":false,"reason"')],
    ['Routing off', { config: { bigTurn: '$2', routing: 'off' } }, BIG],
  ]
  for (const [why, o, rating] of NO_LOWER) {
    test(`before: Lower effort is not offered with ${why} (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
      const { h, d } = await session($, on, surface, o)
      h.answers[HEADS_UP] = 'Run it'
      h.rating = rating
      await d.submit(PROMPT)
      expect(asked(h, HEADS_UP).length).toBe(1)
      expect(asked(h, HEADS_UP)[0]?.options).toEqual(['Run it', 'Plan first'])
    })
  }

  const learned = (n: number) => ({ [CAL_STORE]: Object.fromEntries(['feature:main', 'feature:main:sonnet', 'feature:main:sonnet:high'].map(k => [k, { n, ratio: 1 }])) })
  for (const [n, still] of [[19, true], [20, false]] as const) {
    test(`before: "(still learning your work)" with ${n} calibrated runs: ${still ? 'shown' : 'not shown'} (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
      const { h, d } = await session($, on, surface, { config: { bigTurn: '$2' }, store: learned(n) })
      h.answers[HEADS_UP] = 'Run it'
      h.rating = BIG
      await d.submit(PROMPT)
      const q = asked(h, HEADS_UP)[0]?.question ?? ''
      expect(q).toContain('Heads-up')
      expect(q.includes('(still learning your work)')).toBe(still)
    })
  }

  test(`before: nothing is asked under the amount ($5 against a $2.70 estimate) (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on, surface, { config: { bigTurn: '$5' } })
    h.rating = BIG
    await d.submit(PROMPT)
    expect(asked(h, HEADS_UP)).toEqual([])
    expect(last(h.submitted)?.text).toBe(PROMPT)
  })

  test(`before: at $1 a small job is not held and a big one is (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on, surface, { config: { bigTurn: '$1' } })
    h.answers[HEADS_UP] = 'Run it'
    h.rating = SMALL
    await d.submit(PROMPT)
    expect(asked(h, HEADS_UP)).toEqual([])
    h.rating = BIG
    await d.submit(PROMPT)
    expect(asked(h, HEADS_UP).length).toBe(1)
    expect(asked(h, HEADS_UP)[0]?.question).toContain('(your top 1% start at $1.00)')
  })

  test(`before: auto uses the $2 start until 50 turns exist, and keeps the amount it computed for a week (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on, surface, { config: { bigTurn: 'auto' } })
    h.answers[HEADS_UP] = 'Run it'
    h.rating = BIG
    await d.submit(PROMPT)
    expect(asked(h, HEADS_UP)[0]?.question).toContain('(your top 1% start at $2.00)')
    expect(h.store.bigTurn).toEqual({ value: 2, at: h.now })
  })

  test(`before: a prompt typed into a running turn is not held (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await session($, on, surface, { config: { bigTurn: '$2' } })
    h.rating = SMALL
    await d.submit(PROMPT)
    await d.step('t1', 0)
    h.rating = BIG
    await d.submit(PROMPT, 't1')
    expect(asked(h, HEADS_UP)).toEqual([])
    await d.complete('t1')
  })

  // ---- During the turn ----

  /** `n` main-chat requests of turn `id`, from request `from`; the band's answers get a moment after each. */
  const steps = async (d: ReturnType<typeof drive>, id: string, to: number, from = 0) => {
    for (let i = from; i < to; i++) {
      await d.step(id, i)
      await settle()
    }
  }
  const during = async ($: unknown, on: Parameters<TestBody>[1], over: Opts = {}) => {
    const s = await session($, on, surface, { config: { bigTurn: '$1' }, ...over })
    s.h.stepUsage = COSTLY_STEP
    return s
  }

  test(`during: after ${REESTIMATE_AFTER} requests a turn heading for the amount shows the row, once, and nothing stops the turn (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await during($, on)
    h.answers[DURING] = NO_ONE
    h.rating = LONG
    await d.submit(PROMPT)
    expect(asked(h, HEADS_UP), 'the estimate is under the amount: nothing before the prompt').toEqual([])
    await steps(d, 't1', REESTIMATE_AFTER - 1)
    expect(asked(h, DURING), 'not before the re-estimate').toEqual([])
    await steps(d, 't1', REESTIMATE_AFTER + 5, REESTIMATE_AFTER - 1)
    const q = asked(h, DURING)
    expect(q.length, 'once per turn').toBe(1)
    const stop = surface === 'desktop' ? 'click Stop to stop it now' : 'Esc stops it now'
    expect(q[0]?.question).toMatch(new RegExp(`^Turn estimate \\$[\\d.]+–\\$[\\d.]+ \\(\\$[\\d.]+ spent so far\\)\\. Finish up drafts a message to end this turn; ${stop}\\.$`))
    expect(q[0]?.question, 'the old up-front sentence is gone').not.toContain('wrap-up message for you to send')
    expect(q[0]?.options, 'no Lower effort during a turn').toEqual(['Keep going', 'Finish up'])
    // Every request went out as it was: the turn is never stopped, and the effort is unchanged.
    expect(h.sent.length).toBe(REESTIMATE_AFTER + 5)
    expect(new Set(h.sent.map(x => x.effort))).toEqual(new Set(['high']))
    expect(logOf(h)).toMatch(/big-turn warning during the turn: projected \$[\d.]+, range \$[\d.]+-\$[\d.]+, \$[\d.]+ spent so far, amount \$1\.00/)
    await d.complete('t1')
    await settle()
    expect(logOf(h)).toContain('no answer on the band to Big turn now: the turn goes on, as it was')
    expect(runLines(h)[0]?.bigTurn?.during?.answer).toBe('none')
  })

  for (const row of ['$5', 'off']) {
    test(`during: nothing shows when the row is ${row} and the turn projects to about $1.30 (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
      const { h, d } = await during($, on, { config: { bigTurn: row } })
      h.rating = LONG
      await d.submit(PROMPT)
      await steps(d, 't1', 8)
      expect(asked(h, DURING)).toEqual([])
      await d.complete('t1')
    })
  }

  test(`during: Keep going dismisses; three in a row ask whether to stop the warnings during a turn, and Yes stops only that one (${surface})`, { timeoutMs: 60000 }, async ($, on) => {
    const { h, d } = await during($, on)
    h.answers[DURING] = 'Keep going'
    h.answers[STOP] = 'Yes'
    for (const id of ['t1', 't2', 't3']) {
      h.rating = LONG
      await d.submit(PROMPT)
      await steps(d, id, REESTIMATE_AFTER + 1)
      expect(asked(h, STOP).length, `after turn ${id}`).toBe(id === 't3' ? 1 : 0)
      await d.complete(id)
    }
    await settle()
    expect(asked(h, DURING).length).toBe(3)
    expect(asked(h, STOP)[0]?.question).toContain('Stop the warnings during a turn?')
    expect(logOf(h)).toContain('big-turn answer: Keep going (3 in a row)')
    expect(logOf(h)).toContain('warnings during a turn stopped; the warning before a prompt stays')
    // A fourth turn: no row during the turn. The warning before a prompt still holds one.
    h.rating = LONG
    await d.submit(PROMPT)
    await steps(d, 't4', REESTIMATE_AFTER + 2)
    await d.complete('t4')
    expect(asked(h, DURING).length, 'no more during the turn').toBe(3)
    h.answers[HEADS_UP] = 'Run it'
    h.rating = BIG
    await d.submit(PROMPT)
    expect(asked(h, HEADS_UP).length, 'before the prompt it still holds').toBe(1)
    await d.complete('t4')
  })

  test(`during: another answer breaks the run of Keep goings, and the stop question is asked once (${surface})`, { timeoutMs: 60000 }, async ($, on) => {
    const { h, d } = await during($, on)
    h.answers[STOP] = 'No thanks'
    const answers = ['Keep going', 'Keep going', 'Finish up', 'Keep going', 'Keep going', 'Keep going', 'Keep going']
    h.answerQueue[DURING] = [...answers]
    let n = 0
    for (const answer of answers) {
      h.rating = LONG
      await d.submit(PROMPT)
      await steps(d, `t${++n}`, REESTIMATE_AFTER + 1)
      await d.complete(`t${n}`)
      void answer
    }
    await settle()
    expect(asked(h, DURING).length).toBe(answers.length)
    // The run of three came after the Finish up, and was asked about once; the fourth Keep going in a row did not ask again.
    expect(asked(h, STOP).length).toBe(1)
  })

  test(`during: Finish up puts the message in the prompt box, and the row says how to send it (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await during($, on)
    h.answers[DURING] = 'Finish up'
    h.rating = LONG
    await d.submit(PROMPT)
    await steps(d, 't1', REESTIMATE_AFTER)
    expect(h.fills).toEqual([{ text: FINISH_UP_TEXT, mode: 'replace' }])
    expect(FINISH_UP_TEXT).toBe("Finish the current step, then report what you've done and what's left.")
    const row = await bandText($, surface)
    expect(row).toContain(
      surface === 'desktop'
        ? 'The message is in your prompt box. Click Send now to send it at once, or press Enter to send it after the current step.'
        : 'The message is in your prompt box. Send it now with Ctrl+Enter, or press Enter to send it after the current step.',
    )
    // Nothing was sent: no prompt, no abort, and the turn goes on.
    expect(h.submitted.length).toBe(1)
    await steps(d, 't1', REESTIMATE_AFTER + 3, REESTIMATE_AFTER)
    expect(h.sent.length).toBe(REESTIMATE_AFTER + 3)
    await d.complete('t1')
    expect(runLines(h)[0]?.bigTurn?.during?.answer).toBe('finish')
    expect(logOf(h)).toContain('big-turn answer: Finish up; the message is in the prompt box for you to send')
    expect(h.fills.length, 'a turn that finishes by itself drafts nothing more').toBe(1)
  })

  test(`during: Finish up keeps a draft the person has typed, adding the message after a blank line (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await during($, on)
    h.draft = 'and also the docs'
    h.answers[DURING] = 'Finish up'
    h.rating = LONG
    await d.submit(PROMPT)
    await steps(d, 't1', REESTIMATE_AFTER)
    expect(h.fills).toEqual([{ text: `\n\n${FINISH_UP_TEXT}`, mode: 'append' }])
    expect(h.draft).toBe(`and also the docs\n\n${FINISH_UP_TEXT}`)
  })

  test(`during: Finish up with the box refusing the text says to type it yourself (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await during($, on)
    h.fillRefused = 'dialog'
    h.answers[DURING] = 'Finish up'
    h.rating = LONG
    await d.submit(PROMPT)
    await steps(d, 't1', REESTIMATE_AFTER)
    const row = await bandText($, surface)
    expect(row).toContain(`Type it yourself: ${FINISH_UP_TEXT}`)
    expect(row).not.toContain('The message is in your prompt box')
    expect(logOf(h)).toContain('big-turn answer: Finish up; the prompt box could not be filled')
    await d.complete('t1')
  })

  test(`during: there is no Lower effort for the rest, on any kind of work (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await during($, on)
    h.answers[DURING] = NO_ONE
    h.rating = LONG
    await d.submit(PROMPT)
    await steps(d, 't1', REESTIMATE_AFTER + 4)
    expect(asked(h, DURING)[0]?.options).toEqual(['Keep going', 'Finish up'])
    expect(new Set(h.sent.map(x => x.effort)), 'every step ran at the effort it had').toEqual(new Set(['high']))
    await d.complete('t1')
    expect(runLines(h)[0]?.loweredBy).toBeUndefined()
  })

  const stopAfterWarning = async ($: unknown, on: Parameters<TestBody>[1], answer: string, over: Opts = {}, setup?: (h: ReturnType<typeof engine>) => void) => {
    const { h, d } = await during($, on, over)
    setup?.(h)
    h.answers[DURING] = answer
    h.rating = LONG
    await d.submit(PROMPT)
    await steps(d, 't1', REESTIMATE_AFTER + 1)
    await d.abort('t1')
    await settle()
    return { h, d }
  }

  for (const answer of [NO_ONE, 'Keep going']) {
    test(`during: stopping a turn that showed the warning (${answer === NO_ONE ? 'unanswered' : answer}) puts a report request in the prompt box, and never sends it (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
      const { h } = await stopAfterWarning($, on, answer)
      expect(STOP_REPORT_TEXT).toBe("Report what you've done so far and what's left.")
      expect(h.fills).toEqual([{ text: STOP_REPORT_TEXT, mode: 'replace' }])
      expect(h.draft).toBe(STOP_REPORT_TEXT)
      expect(h.submitted.length, 'nothing was submitted').toBe(1)
      expect(await bandText($, surface)).toBe(STOPPED_TEXT)
      expect(STOPPED_TEXT).toBe('Stopped. A report request is in your prompt box: send it if you want one.')
      expect(logOf(h)).toContain('big-turn: you stopped the turn; a report request is in your prompt box, not sent')
      expect(runLines(h)[0]?.aborted).toBe(true)
    })
  }

  test(`during: stopping with a draft in the box adds the report request after a blank line (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h } = await stopAfterWarning($, on, NO_ONE, {}, x => void (x.draft = 'and also the docs'))
    expect(h.fills).toEqual([{ text: `\n\n${STOP_REPORT_TEXT}`, mode: 'append' }])
    expect(h.draft).toBe(`and also the docs\n\n${STOP_REPORT_TEXT}`)
  })

  test(`during: stopping after Finish up was pressed adds no second draft (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h } = await stopAfterWarning($, on, 'Finish up')
    expect(h.fills, 'only the Finish up message').toEqual([{ text: FINISH_UP_TEXT, mode: 'replace' }])
    expect(await bandText($, surface)).not.toBe(STOPPED_TEXT)
    expect(logOf(h)).not.toContain('you stopped the turn')
  })

  test(`during: a box that refuses the report request is only logged (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h } = await stopAfterWarning($, on, NO_ONE, {}, x => void (x.fillRefused = 'dialog'))
    expect(h.submitted.length).toBe(1)
    expect(await bandText($, surface)).not.toContain('Stopped.')
    expect(logOf(h)).toContain('big-turn: you stopped the turn; the prompt box could not be filled')
  })

  test(`during: a stop with no warning shown, and a turn that ends by itself, draft nothing (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await during($, on)
    h.answers[DURING] = NO_ONE
    h.rating = SMALL
    await d.submit(PROMPT)
    await steps(d, 't1', 3)
    await d.abort('t1')
    expect(h.fills).toEqual([])
    h.rating = LONG
    await d.submit(PROMPT)
    await steps(d, 't2', REESTIMATE_AFTER + 1)
    await d.complete('t2')
    await settle()
    expect(asked(h, DURING).length, 'the second turn did show it').toBe(1)
    expect(h.fills, 'but it ended by itself').toEqual([])
  })

  test(`during: the opt-in question and the during-turn row can both follow a big turn (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    // A row that is not the person's has no during-turn warning (it is off): only the question after the turn.
    const { h, d } = await session($, on, surface)
    h.stepUsage = COSTLY_STEP
    h.answers[OPT_IN] = 'No thanks'
    h.rating = LONG
    h.stepCost = 0.6
    await d.submit(PROMPT)
    await steps(d, 't1', 6)
    await d.complete('t1')
    await settle()
    expect(asked(h, DURING)).toEqual([])
    expect(asked(h, OPT_IN).length).toBe(1)
  })
}
