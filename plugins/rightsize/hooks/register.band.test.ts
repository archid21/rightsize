import { type TestBody, expect, test } from 'claude-code/testing'
import { CAL_STORE } from './cost'
import { LOGS, SESSION_DIR, RUNS_FILE, SWITCHES_FILE, LOG_PATH, LEGACY_RUNS, LEGACY_SWITCHES, LOOKUP, DEBUG, NO_ONE, SEARCH, NO_CHANGE, FREE_SWITCHES, cellsOf, engine, drive, settle, DAY, last, mount, rowText, bandText, LOWER } from './testkit'

declare const setTimeout: (fn: (...a: unknown[]) => void, ms: number) => unknown

for (const surface of ['desktop', 'terminal'] as const) {

  const rated = (type: string, continues: boolean) => `{"fit":{"haiku":"no","sonnet":"medium","opus":"medium","fable":"medium"},"type":"${type}","read":8000,"write":1200,"steps":5,"continues":${continues},"reason":"rated"}`
  const readRuns = (h: ReturnType<typeof engine>) => (h.files[RUNS_FILE] ?? '').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
  const FOLLOW_UP = 'yes that looks right so go ahead and put it in parentheses'

  const LISTING = '{"fit":{"haiku":"low","sonnet":"low","opus":"low","fable":"low"},"type":"search","read":8000,"write":500,"steps":5,"reason":"list call sites"}'
  const at = (h: { now: number }, ms: number) => new Date(h.now + ms).toISOString()

  const AUTO_RAISE = { remember: true, choices: { raise: 'auto' } }
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
  const OPUS = { model: 'claude-opus-5-5', effort: 'medium' }


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

  // ---- Every question waits 30 seconds (Question wait), then takes the choice that changes nothing ----

  const until = async (done: () => boolean) => {
    for (let i = 0; i < 200 && !done(); i++) await new Promise(r => setTimeout(r, 10))
  }

  // ---- On the terminal and the desktop app, a question that need not stop the work is a row on the band ----

  /** A turn where Claude looks stuck and Raising is not automatic: the band asks Stuck, and nobody answers yet. */
  const stuckAsked = async ($: unknown, on: Parameters<TestBody>[1]) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'low' })
    const d = drive($, h)
    await d.start(surface)
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

  test(`a band question is a row of its own: its options are buttons with number keys, then × (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await stuckAsked($, on)
    const ui = await mount($, surface)
    const options = (await ui.findAll({ type: 'Button' })).filter(b => String(b.props?.key).startsWith('q-'))
    expect(options.map(b => b.props?.key)).toEqual(['q-0', 'q-1', 'q-2', 'q-3', 'q-close'])
    expect(options.map(b => (b.props as { hotkey?: string } | undefined)?.hotkey)).toEqual(['1', '2', '3', '4', undefined])
    expect(options.map(b => b.props?.label)).toEqual(['Raise to medium for this turn', 'Raise when stuck for this session', 'Keep low', 'Always raise when stuck', '×'])
    expect(await rowText(ui, 'Stuck'), 'the label, then the question').toContain('The same tool call failed twice.')
    expect((await ui.find({ type: 'Text', text: /^No answer:/ }))?.text, 'what happens with no answer, on a line of its own').toBe('No answer: the turn goes on at low.')
    await ui.press({ key: 'q-0' })
    await ui.unmount()
    await d.step('t1', 2)
    expect(last(h.sent)?.effort, 'the answer applies').toBe('medium')
    expect(h.question, 'the row is gone').toBeNull()
    await d.complete('t1')
  })

  test(`× on a band question dismisses it: nothing changes, and it is not counted as unanswered (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await stuckAsked($, on)
    const ui = await mount($, surface)
    await ui.press({ key: 'q-close' })
    await ui.unmount()
    await d.step('t1', 2)
    expect(last(h.sent)?.effort).toBe('low')
    expect(h.question).toBeNull()
    await d.complete('t1')
    expect(helperLog(h)).not.toContain('no answer on the band')
  })

  test(`two band questions take turns: the second shows when the first is answered (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await stuckAsked($, on)
    await d.workflow()
    expect(h.events, 'the workflow went ahead').toContain('workflow')
    expect(h.question?.header, 'the second waits behind the first').toBe('Stuck')
    expect(h.asked.map(a => a.header)).toEqual(['Stuck'])
    const ui = await mount($, surface)
    await ui.press({ key: 'q-close' })
    await ui.unmount()
    await settle()
    expect(h.question?.header, 'then the second shows').toBe('Workflow')
    expect(h.asked.map(a => a.header)).toEqual(['Stuck', 'Workflow'])
  })

  test(`with Band set to Never the Effort question is the same dialog, never on the band, and a late answer to it is too late (${surface})`, { timeoutMs: 30000, options: { band: 'off' } }, async ($, on) => {
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
    expect(h.question, 'never on the band').toBeNull()
    expect(last(h.sent)?.effort, 'this prompt: no change').toBe('medium')
    await d.complete('t1')
    release()
    await until(() => h.toasts.some(t => t.includes('too late')))
    expect(last(h.toasts)).toBe('rightsize: that answer came too late; nothing changed.')
  })

  test(`with Band set to Never a late answer in the dialog to a one-time question gets a toast (${surface})`, { timeoutMs: 30000, options: { band: 'off' } }, async ($, on) => {
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
    let release = () => {}
    h.answerGate = { Stuck: new Promise<void>(r => (release = r)) }
    h.answers = { Stuck: 'Raise to high for this turn' }
    h.sleepEnds = true
    await d.step('t1', 1)
    expect(h.question).toBeNull()
    expect(last(h.sent)?.effort).toBe('medium')
    release()
    await until(() => h.toasts.some(t => t.includes('too late')))
    expect(last(h.toasts)).toBe('rightsize: that answer came too late; nothing changed.')
  })

  test(`a helper whose task has no retry left goes back without a question (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-fable-5-2', effort: 'high', store: { remember: true, choices: { down: 'auto' } } })
    const d = drive($, h)
    await d.start(surface)
    await warm(d, h)
    h.rating = HAND_OFF()
    await startHelper(d, h, 't1', 'helper')
    // Two rework rounds from the main chat use both of the task's chances.
    await d.send()
    await d.send()
    await d.bash('fail a', 'agent-helper')
    await d.bash('fail a', 'agent-helper')
    await d.step('t1', 1, 'agent-helper')
    expect(h.asked.length, 'nothing to ask about').toBe(0)
    expect(((await d.bash('ls', 'agent-helper')) as { deny?: string }).deny).toContain('stuck')
    await d.complete('t1')
  })

  test(`Raising set to never leaves a struggling helper alone: not raised, not sent back (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-fable-5-2', effort: 'high', store: { remember: true, choices: { down: 'auto', raise: 'never' } } })
    const d = drive($, h)
    await d.start(surface)
    await warm(d, h)
    h.rating = HAND_OFF()
    await startHelper(d, h, 't1', 'helper')
    await d.bash('fail a', 'agent-helper')
    await d.bash('fail a', 'agent-helper')
    await d.step('t1', 1, 'agent-helper')
    expect(last(h.sent)?.effort).toBe('low')
    expect(((await d.bash('ls', 'agent-helper')) as { deny?: string }).deny, 'left alone').toBeUndefined()
  })

  test(`a failing test run in a helper is not an error of the work, and needs one more repeat (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-fable-5-2', effort: 'high', store: HELPERS })
    const d = drive($, h)
    await d.start(surface)
    await warm(d, h)
    h.rating = HAND_OFF()
    await startHelper(d, h, 't1', 'helper')
    for (let i = 0; i < 2; i++) await d.bash('npm test --red', 'agent-helper')
    // Other test runs failing do not add up to "several tool calls failed" either.
    await d.bash('pytest -x --red', 'agent-helper')
    await d.bash('cargo test --red', 'agent-helper')
    await d.step('t1', 1, 'agent-helper')
    expect(last(h.sent)?.effort, 'red test runs: expected reds, not struggling').toBe('low')
    await d.bash('npm test --red', 'agent-helper')
    await d.step('t1', 2, 'agent-helper')
    expect(last(h.sent)?.effort, 'the same one a third time: stuck').toBe('medium')
    expect(helperLog(h)).toContain('the same test run failed 3 times')
    await d.complete('t1')
  })

  test(`a failing test run in the main chat is not an error of the work either (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: AUTO_RAISE })
    const d = drive($, h)
    await d.start(surface)
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    await d.step('m1', 0)
    for (let i = 0; i < 2; i++) await d.bash('npm test --red')
    await d.bash('pytest --red')
    await d.bash('go test --red')
    await d.step('m1', 1)
    expect(last(h.sent)?.effort, 'four red test runs: not four errors').toBe('medium')
    await d.bash('npm test --red')
    await d.step('m1', 2)
    expect(last(h.sent)?.effort, 'the same one a third time').toBe('high')
  })

  test(`the main chat's rework of a hand-off uses the task's chances, and is refused once they are used up (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-fable-5-2', effort: 'high', store: HELPERS })
    const d = drive($, h)
    await d.start(surface)
    await warm(d, h)
    h.rating = HAND_OFF()
    await startHelper(d, h, 't1', 'helper')
    expect(((await d.agent('haiku')) as { deny?: string }).deny, 'a second subagent on its model: rework, one chance').toBeUndefined()
    expect(((await d.send()) as { deny?: string }).deny, 'a message to the subagent: rework, the second chance').toBeUndefined()
    const refused = (await d.send()) as { deny?: string }
    expect(refused.deny).toContain('retry budget is used up')
    expect(refused.deny).toContain('Finish the task yourself')
    expect(((await d.agent('haiku')) as { deny?: string }).deny, 'a third subagent too').toContain('retry budget is used up')
    expect(helperLog(h)).toContain("rework refused: the task's retry budget is used up")
    // A helper's raise would find no chance left either.
    await d.bash('fail a', 'agent-helper')
    await d.bash('fail a', 'agent-helper')
    await d.step('t1', 1, 'agent-helper')
    expect(((await d.bash('ls', 'agent-helper')) as { deny?: string }).deny, 'sent back').toContain('stuck')
    await d.complete('t1')
    expect((readRuns(h).find(l => l.kind === 'run') as { retries?: number }).retries).toBe(2)
  })

  test(`a follow-up shares its task's retry budget; a new task starts a fresh one (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-fable-5-2', effort: 'high', store: HELPERS })
    const d = drive($, h)
    await d.start(surface)
    await warm(d, h)
    h.rating = HAND_OFF()
    await startHelper(d, h, 't1', 'helper')
    await d.bash('fail a', 'agent-helper')
    await d.bash('fail a', 'agent-helper')
    await d.step('t1', 1, 'agent-helper')
    expect(last(h.sent)?.effort, 'a raise: one chance used').toBe('medium')
    await d.complete('t1')

    // The follow-up continues the task: one chance left, then none.
    h.rating = HAND_OFF(true)
    await d.submit(FOLLOW_UP)
    await d.step('t2', 0)
    await d.agent('haiku')
    expect(((await d.send()) as { deny?: string }).deny, 'the second chance').toBeUndefined()
    expect(((await d.send()) as { deny?: string }).deny, 'none left').toContain('retry budget is used up')
    await d.complete('t2')

    // A new goal is a new task.
    h.rating = HAND_OFF(false)
    await d.submit('now list every call site of the new logger across the repo')
    await d.step('t3', 0)
    await d.agent('haiku')
    expect(((await d.send()) as { deny?: string }).deny, 'a fresh budget').toBeUndefined()
    await d.complete('t3')

    const runs = readRuns(h).filter(l => l.kind === 'run')
    expect(runs.map(r => r.retries)).toEqual([1, 2, 1])
    expect(runs[1]?.task, 'one task').toBe(runs[0]?.task)
    expect(runs[2]?.task, 'another').not.toBe(runs[0]?.task)
  })

  test(`a moved subagent is watched too: raised from the budget, and its own line carries what the watch saw (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: AUTO_RAISE })
    const d = drive($, h)
    await d.start(surface)
    h.rating = NO_CHANGE
    await d.submit(SEARCH)
    await d.step('t1', 0)
    h.rating = LISTING
    await d.spawn('lister')
    h.now += 1000
    await d.step('l1', 0, 'agent-lister')
    expect(last(h.sent)?.effort).toBe('low')
    await d.bash('fail make', 'agent-lister')
    await d.bash('fail make', 'agent-lister')
    h.now += 4000
    await d.step('l1', 1, 'agent-lister')
    expect(last(h.sent)?.effort, 'raised one level').toBe('medium')
    expect(helperLog(h)).toContain('raised helper agent-lister low → medium at step 2')
    await d.step('l1', 2, 'agent-lister')
    expect(last(h.sent)?.effort).toBe('medium')
    await d.answer('agent-lister')
    await d.complete('t1')
    const runs = readRuns(h)
    const sub = runs.find(l => l.kind === 'subagent') as Record<string, unknown>
    expect([sub.steps, sub.ms, sub.errors, sub.blocked, sub.stall, sub.raises]).toEqual([3, 5000, 2, 0, 'struggling', [{ step: 2, from: 'low', to: 'medium', why: 'the same tool call failed twice' }]])
    expect('returned' in sub).toBe(false)
    const run = runs.find(l => l.kind === 'run') as { helpers?: HelperEntry[]; retries?: number }
    expect(run.helpers?.map(x => [x.agent, x.kind, x.steps, x.ms])).toEqual([['agent-lister', 'moved', 3, 5000]])
    expect(run.retries).toBe(1)
  })

  test(`a new session starts with a fresh retry budget and no helpers watched (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-fable-5-2', effort: 'high', store: HELPERS })
    const d = drive($, h)
    await d.start(surface)
    await warm(d, h)
    h.rating = HAND_OFF()
    await startHelper(d, h, 't1', 'helper')
    await d.agent('haiku')
    await d.send()
    await d.send()
    expect(((await d.send()) as { deny?: string }).deny).toContain('retry budget is used up')
    await d.complete('t1')
    await d.start(surface)
    await warm(d, h)
    h.rating = HAND_OFF()
    await startHelper(d, h, 't2', 'helper')
    expect(((await d.send()) as { deny?: string }).deny, 'a fresh budget').toBeUndefined()
  })

  // ---- Every prompt is rated, with the whole request and the task in progress ----

  const LONG = (head: string) => `${head} ${'and the details go on. '.repeat(320)}but only in src/`
  const unsureOf = (h: ReturnType<typeof engine>) => readRuns(h).filter(l => l.kind === 'run').map(l => l.unsure ?? null)

  test(`every prompt is rated as entered: two words, and 150 words with brain-dump on (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS })
    h.files['/home/test/.claude/mods/switches.json'] = '{"brain-dump": true}'
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = NO_CHANGE
    await d.submit('yes go')
    expect(h.ratings, 'a two-word prompt is rated').toBe(1)
    await d.submit(Array.from({ length: 150 }, (_, i) => `word${i}`).join(' '))
    expect(h.ratings, 'a 150-word prompt is rated though brain-dump is on').toBe(2)
    expect(h.completions, 'one rater call each').toEqual(['sonnet', 'sonnet'])
  })

  test(`a request that is cut is not lowered, and its run line says unsure: cut (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = LOWER
    await d.submit(LOOKUP)
    await d.step('t1')
    expect(last(h.sent)?.effort, 'the same rating lowers a request that is whole').toBe('low')
    await d.complete('t1')

    const request = LONG(LOOKUP)
    expect(request.length).toBeGreaterThan(6000)
    await d.submit(request)
    const shown = last(h.ratingPrompts) ?? ''
    expect(shown, 'the rater sees the start, a marked cut and the end').toContain(`<request>\n${request.slice(0, 4000)}\n[… ${request.length - 6000} characters cut …]\n`)
    expect(shown.endsWith('but only in src/\n</request>')).toBe(true)
    await d.step('t2')
    expect(last(h.sent)?.effort, 'not lowered: the rater did not see all of it').toBe('medium')
    expect(h.files[LOG_PATH] ?? '').toContain('no downgrade: context cut')
    expect(h.asked, 'nothing was asked: the default decides Lowering, and a rule it decided is not kept').toEqual([])
    await d.complete('t2')
    expect(unsureOf(h)).toEqual([null, 'cut'])
  })

  test(`a task whose last reply is missing is not lowered, but a raise still happens (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    // No task yet, so no reply is missing: the first prompt of a session is lowered as ever.
    h.messages = []
    h.rating = LOWER
    await d.submit(LOOKUP)
    await d.step('t1')
    expect(last(h.sent)?.effort).toBe('low')
    await d.complete('t1')

    // A task is in progress and the conversation holds no reply from Claude.
    await d.submit(LOOKUP)
    await d.step('t2')
    expect(last(h.sent)?.effort, 'no reply to read: not lowered').toBe('medium')
    expect(h.files[LOG_PATH] ?? '').toContain('no downgrade: context missing')
    await d.complete('t2')

    // The conversation cannot be read at all.
    h.messagesFail = true
    await d.submit(LOOKUP)
    await d.step('t3')
    expect(last(h.sent)?.effort, 'unreadable: not lowered').toBe('medium')
    await d.complete('t3')

    // A raise is not held back.
    // A review: the one task type whose rated raise is still taken at prompt time on Opus (ADR 0021).
    h.rating = '{"level":"high","model":"same","type":"review","read":20000,"write":3000,"steps":8,"reason":"unknown cause"}'
    await d.submit(DEBUG)
    await d.step('t4')
    expect(last(h.sent)?.effort, 'raised').toBe('high')
    await d.complete('t4')
    expect(unsureOf(h)).toEqual([null, 'missing', 'missing', 'missing'])
  })

  test(`a cut request is not handed to a cheaper model (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-fable-5-2', effort: 'high', store: HELPERS })
    const d = drive($, h)
    await d.start(surface)
    await warm(d, h)
    h.rating = HAND_OFF()
    await d.submit(SEARCH)
    expect(last(h.submitted)?.context?.length, 'a whole request is handed down').toBe(1)
    await d.step('t1')
    await d.complete('t1')

    await d.submit(LONG(SEARCH))
    expect(last(h.submitted)?.context ?? [], 'a cut one stays in the main chat').toEqual([])
    expect(helperLog(h)).toContain('no downgrade: context cut')
    await d.step('t2')
    await d.complete('t2')
    expect(unsureOf(h)).toEqual([null, 'cut'])
    expect(readRuns(h).filter(l => l.kind === 'run').map(l => [l.change, l.offered])).toEqual([['delegate-down', 'delegate-down'], ['none', 'none']])
  })

  test(`a run line carries the learning note, and the real hand-off is still made (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    // The step exponent is stored under 'step-exponent-v1' (steps.ts state, register.tsx STEP_STORE).
    const h = engine(on, { model: 'claude-fable-5-2', effort: 'high', store: { ...HELPERS, 'step-exponent-v1': { g: -0.4, since: 0, samples: [] } } })
    const d = drive($, h)
    await d.start(surface)
    await warm(d, h)
    h.rating = HAND_OFF()
    await d.submit(SEARCH)
    expect(last(h.submitted)?.context?.length, 'a whole request is handed down, as without learning mode').toBe(1)
    await d.step('t1')
    await d.complete('t1')
    const run = readRuns(h).find(l => l.kind === 'run')
    expect(run?.change, 'the decision is unchanged').toBe('delegate-down')
    const note = run?.learning as { g: number; plan: string; differs: boolean; applied: boolean } | undefined
    expect(note?.g, 'the learned exponent is logged').toBe(-0.4)
    expect(note?.applied, 'a fresh exponent is not applied yet').toBe(false)
    expect(typeof note?.plan, 'the learning plan is labelled').toBe('string')
    expect(note?.differs, 'differs is whether the labels differ').toBe(note?.plan !== 'delegate-down:haiku')
  })

  test(`a promotion of the step exponent rebases calibration once, and the state is stored (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    // 49 scores where g beats the plain estimate, steady refits and a typical shrink of 16 ** -0.2: the 50th score promotes it.
    const scores = Array.from({ length: 49 }, () => ({ inc: 0.6, cand: 0.3, flip: false, unjust: false }))
    const samples = Array.from({ length: 10 }, () => ({ ls: Math.log(16), lr: 0 }))
    const state = { g: -0.2, since: 0, samples, scores, gs: [-0.2, -0.2, -0.2], applied: false }
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { 'step-exponent-v1': state, [CAL_STORE]: { ...FREE_SWITCHES, 'writing:main': { n: 30, ratio: 1 } } } })
    const d = drive($, h)
    await d.start(surface)
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    await d.step('t1')
    await d.complete('t1')
    const stored = h.store['step-exponent-v1'] as { applied: boolean; appliedAt?: number }
    expect(stored.applied, 'the exponent is applied once it has proven itself').toBe(true)
    const ratio = (h.store[CAL_STORE] as Record<string, { n: number; ratio: number }>)['writing:main']?.ratio ?? 0
    const once = 1 / 16 ** -0.2
    expect(Math.abs(ratio - once) < 0.01, `calibration is rebased once (${once.toFixed(2)}), not twice`).toBe(true)
    expect(h.files[LOG_PATH] ?? '').toContain('step estimates applied')
  })

  test(`the rater is told how the task began and how many prompts it has had (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-sonnet-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    const first = `add a dark mode toggle to the settings page ${'and keep it in step with the OS theme. '.repeat(20)}`
    expect(first.length).toBeGreaterThan(600)

    h.rating = rated('feature', false)
    await d.submit(first)
    expect(h.ratingPrompts[0], 'no task yet').not.toContain('<task>')

    h.rating = rated('feature', true)
    await d.submit(FOLLOW_UP)
    expect(h.ratingPrompts[1]).toContain(`<task>\nTask in progress: feature, 1 prompt so far. It started with:\n${first.trim().slice(0, 600)}\n</task>\n\n<last_reply>\nDone: the change is in.\n</last_reply>\n\n<request>\n${FOLLOW_UP}\n</request>`)
    expect(h.ratingPrompts[1], 'the brief stops at 600 characters').not.toContain(first.trim().slice(0, 601))

    await d.submit(FOLLOW_UP)
    expect(h.ratingPrompts[2], 'a continuing prompt counts').toContain('Task in progress: feature, 2 prompts so far.')

    // A prompt that could not be rated counts too.
    h.ratingQueue = ['unavailable', 'unavailable']
    await d.submit(FOLLOW_UP)
    h.rating = rated('feature', true)
    await d.submit(FOLLOW_UP)
    expect(last(h.ratingPrompts)).toContain('Task in progress: feature, 4 prompts so far.')

    // A new goal starts a task of its own: one prompt, and its own brief.
    h.rating = rated('lookup', false)
    await d.submit(LOOKUP)
    h.rating = rated('lookup', true)
    await d.submit(FOLLOW_UP)
    expect(last(h.ratingPrompts)).toContain(`Task in progress: lookup, 1 prompt so far. It started with:\n${LOOKUP}\n</task>`)
  })


  // ---- Logs: one folder per session, read together ----------------------------------
  const MIN_MS = 60_000
  /** A rated prompt for the start check's replay: the fields isRated wants. */
  const easyLine = (at: number, tier: string) =>
    JSON.stringify({ at: new Date(at).toISOString(), kind: 'run', session: 'x', type: 'feature', route: 'main', tier, level: 'medium', normal: 'medium', fit: { haiku: null, sonnet: 'medium', opus: 'low', fable: 'low' }, read: 8000, write: 2000, steps: 8, context: 60_000, actual: 0.1, stay: 0.1, taken: 0.1, change: 'none', offered: 'none' })
  const FILES = (h: ReturnType<typeof engine>) => Object.keys(h.files).sort()
  /** A rating call that costs something, so a dropped or unbound prompt has overhead to count. */
  const PAID = { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

  test(`every log is written in the session's own folder, files 600 and folders 700, and the old shared files are never written (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES } })
    const legacy = `${easyLine(h.now - 3 * DAY, 'opus')}\n`
    h.files[LEGACY_RUNS] = legacy
    h.files[LEGACY_SWITCHES] = `${JSON.stringify({ at: new Date(h.now - 3 * DAY).toISOString(), kept: true })}\n`
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = LOWER
    await d.submit(LOOKUP)
    await d.step('t1', 0)
    await d.step('t1', 1)
    await d.complete('t1')
    await d.submit(LOOKUP)
    await d.step('t2')
    await d.complete('t2')
    expect(FILES(h), 'only this session writes, in its own folder').toEqual([LEGACY_RUNS, LEGACY_SWITCHES, LOG_PATH, RUNS_FILE, SWITCHES_FILE].sort())
    expect(h.files[LEGACY_RUNS], 'the old runs file is read, never written').toBe(legacy)
    expect(h.files[LEGACY_SWITCHES]?.trim().split('\n').length).toBe(1)
    expect(h.ran).toContainEqual(['mkdir', '-m', '700', '-p', SESSION_DIR])
    expect(h.ran).toContainEqual(['chmod', '700', LOGS, `${LOGS}/rightsize`, SESSION_DIR])
    for (const file of [RUNS_FILE, SWITCHES_FILE, LOG_PATH]) expect(h.ran, file).toContainEqual(['chmod', '600', file])
    expect(h.ran.filter(a => a[0] === 'chmod' && a[1] === '600').length, 'each new file is made readable by you alone once').toBe(3)
    expect(readRuns(h).map(l => l.kind)).toEqual(['run', 'run'])
  })

  for (const [id, folder] of [['../../etc/x y', '______etc_x_y'], ['', 'unknown']] as const) {
    test(`session id ${JSON.stringify(id)} writes its logs under ${folder} (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
      const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
      h.sessionId = id
      const d = drive($, h)
      await d.start(surface)
      h.rating = NO_CHANGE
      await d.submit(LOOKUP)
      await d.step('t1')
      await d.complete('t1')
      expect(FILES(h).length).toBeGreaterThan(0)
      expect(FILES(h).every(f => f.startsWith(`${LOGS}/rightsize/${folder}/`)), `files: ${FILES(h).join(' ')}`).toBe(true)
    })
  }

  test(`the report reads every session's folder and the old shared file together, in time order, and one unreadable file loses nothing (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    // The newest 60 prompts are in the old file, on Opus; an older Sonnet one and a newer Opus one are in two session folders.
    // Read in file order the last prompt would be Sonnet's (a folder comes after the old file), and the start would not be Opus.
    h.files[LEGACY_RUNS] = easyLog(h.now)
    h.files[`${LOGS}/rightsize/aaa/runs.jsonl`] = `${easyLine(h.now - 3 * DAY, 'sonnet')}\n`
    h.files[`${LOGS}/rightsize/zzz/runs.jsonl`] = `${easyLine(h.now - 2 * DAY, 'opus')}\n`
    h.files[`${LOGS}/rightsize/torn/runs.jsonl`] = `not json at all\n{"at":"2026-01-01T00:00:00.000Z","kind":"ru`
    h.files[`${LOGS}/rightsize/torn/rightsize.log`] = 'text that is not a run log\n'
    h.files[LEGACY_SWITCHES] = `${JSON.stringify({ at: new Date(h.now - DAY).toISOString(), kept: false })}\n`
    h.files[`${LOGS}/rightsize/zzz/switches.jsonl`] = `${JSON.stringify({ at: new Date(h.now - 2 * DAY).toISOString(), kept: false })}\n`
    const d = drive($, h)
    await d.start(surface)
    const report = (await d.report())
    expect(cellsOf(report, 'Prompts rated'), 'all three sources, 60 + 1 + 1').toEqual(['62'])
    expect(report, 'the newest prompt is Opus, so Opus is the start').toContain('STARTING POINT  Opus at medium, 62 rated prompts in 30 days')
    expect(report, 'effort switches from both places').toMatch(/2 switches\s+missed the cache, of 2 effort switches/)
  })

  test(`two writes to one file in the same moment both land (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    h.rating = NO_CHANGE
    await Promise.all([d.submit(LOOKUP), d.submit(`${LOOKUP} in src/other.ts`)])
    const rated = (h.files[LOG_PATH] ?? '').split('\n').filter(l => l.includes(': rated '))
    expect(rated.length, 'both decisions are in the log').toBe(2)
    // The two turns end together as well: a turn's line and a later one's go to the same file.
    await d.turnStart('t1', LOOKUP)
    await d.step('t1')
    await d.complete('t1')
    await d.turnStart('t2', `${LOOKUP} in src/other.ts`)
    await d.step('t2')
    await Promise.all([d.complete('t2'), d.submit(`${DEBUG} again`)])
    expect(readRuns(h).filter(l => l.kind === 'run').map(l => l.turnId), 'and both turns are in the run log').toEqual(['t1', 't2'])
  })

  // ---- Prompts and turns: a queue, bound by text ------------------------------------

  test(`a prompt another plugin rewrote is still bound to its turn: the turn that starts while it enters (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    h.rating = NO_CHANGE
    h.duringSubmit = () => d.turnStart('t1', `THE JOB: ${LOOKUP}`)
    await d.submit(LOOKUP)
    await d.step('t1')
    await d.complete('t1')
    expect(readRuns(h).filter(l => l.kind === 'run').map(l => l.turnId), 'bound to its turn').toEqual(['t1'])
    expect(readRuns(h).some(l => l.kind === 'unbound'), 'not left in line').toBe(false)
  })

  test(`prompts typed during a running turn wait in line and each runs its own turn, bound by its text, with its own rating and turn id (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-sonnet-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    await d.start(surface)
    h.rating = rated('feature', false)
    await d.submit('add a dark mode toggle to the settings page')
    await d.turnStart('t1', 'add a dark mode toggle to the settings page')
    await d.step('t1')
    // Two more while t1 runs: each is rated as it is typed.
    h.rating = rated('lookup', false)
    await d.submit(LOOKUP, 't1')
    h.rating = rated('debug', false)
    await d.submit(DEBUG, 't1')
    await d.complete('t1')
    await d.turnStart('t2', `  ${LOOKUP}\n`)
    await d.step('t2')
    await d.complete('t2')
    await d.turnStart('t3', DEBUG)
    await d.step('t3')
    await d.complete('t3')
    const runs = readRuns(h)
    expect(runs.map(l => l.kind), 'three runs, nothing unbound').toEqual(['run', 'run', 'run'])
    expect(runs.map(l => [l.turnId, l.type, l.queued]), 'each is in its own turn, and the typed-over two say so').toEqual([['t1', 'feature', undefined], ['t2', 'lookup', true], ['t3', 'debug', true]])
    expect(new Set(runs.map(l => l.id)).size, 'three ids').toBe(3)
    expect(new Set(runs.map(l => l.task)).size, 'and three tasks').toBe(3)
  })

  test(`a prompt that never started is logged unbound at the next idle prompt and never takes another prompt's turn (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    h.ratingUsage = PAID
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    // Cancelled before its turn started: no turn.start for it. The session is idle when the next one is typed.
    await d.submit(DEBUG)
    await d.turnStart('t1', DEBUG)
    await d.step('t1')
    await d.complete('t1')
    // The log's times are the wall clock's: the report's periods count from now.
    h.now = Date.now()
    const runs = readRuns(h)
    expect(runs.map(l => l.kind)).toEqual(['unbound', 'run'])
    expect(runs[0]).toMatchObject({ kind: 'unbound', reason: 'cancelled before its turn started' })
    expect(Number(runs[0]?.overhead), 'its rating call is still counted').toBeGreaterThan(0)
    expect(runs[1], 'the run in turn t1 is the prompt that started it').toMatchObject({ turnId: 't1' })
    expect(runs[1]?.id).not.toBe(runs[0]?.id)
    expect(runs[1]?.queued, 'typed while idle').toBeUndefined()
    expect(cellsOf(await d.report(), 'Prompts rated'), 'one rated run: the unbound prompt is not one').toEqual(['1'])
  })

  test(`a prompt delivered into the running turn is logged unbound when the next turn starts for other text, and does not attach to it (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    h.ratingUsage = PAID
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    await d.turnStart('t1', LOOKUP)
    await d.step('t1')
    // The engine hands this one to the model inside t1: no turn will ever start for it.
    await d.submit(DEBUG, 't1')
    await d.complete('t1')
    // A continuation says nothing about the line.
    await d.turnStart('t2', '')
    await d.step('t2')
    await d.complete('t2')
    expect(readRuns(h).map(l => l.kind), 'still waiting after a continuation').toEqual(['run'])
    // The next turn starts for other text: the prompt was read by t1.
    await d.turnStart('t3', 'a background task finished')
    await d.step('t3')
    await d.complete('t3')
    const runs = readRuns(h)
    expect(runs.map(l => l.kind)).toEqual(['run', 'unbound'])
    expect(runs[1]).toMatchObject({ kind: 'unbound', reason: 'delivered into the running turn' })
    expect(Number(runs[1]?.overhead)).toBeGreaterThan(0)
    expect(runs.filter(l => l.kind === 'run').map(l => l.turnId), 'nothing ran in t2 or t3 as a rated prompt').toEqual(['t1'])
  })

  test(`a prompt delivered into the running turn is logged unbound when the session goes idle and the next prompt is typed (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    await d.turnStart('t1', LOOKUP)
    await d.step('t1')
    await d.submit(DEBUG, 't1')
    await d.complete('t1')
    await d.submit(SEARCH)
    await d.turnStart('t2', SEARCH)
    await d.step('t2')
    await d.complete('t2')
    const runs = readRuns(h)
    expect(runs.map(l => [l.kind, l.turnId ?? l.reason])).toEqual([['run', 't1'], ['unbound', 'delivered into the running turn'], ['run', 't2']])
  })

  test(`a prompt that something beneath refuses is logged dropped with its rating cost, its own state is undone, and it does not attach to the next turn (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-sonnet-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    await d.start(surface)
    h.ratingUsage = PAID
    h.rating = LOWER
    h.dropNext = 'a hook refused it'
    const out = (await d.submit(LOOKUP)) as { drop?: string }
    expect(out.drop, 'the refusal is passed up as it came').toBe('a hook refused it')
    expect(await bandText($, surface), 'the band it set is gone').toBe('')
    const undo = await d.command('retry')
    expect(undo.text ?? '', 'nothing of it is left to retry').toContain('Nothing to retry')
    const runs = readRuns(h)
    expect(runs.map(l => l.kind)).toEqual(['dropped'])
    expect(runs[0]).toMatchObject({ kind: 'dropped', reason: 'a hook refused it', session: 'sess-1' })
    expect(Number(runs[0]?.overhead)).toBeGreaterThan(0)
    expect(h.files[LOG_PATH] ?? '').toContain('prompt dropped (a hook refused it)')

    // The next prompt starts its own task (the dropped one never began one), and its turn is its own.
    h.rating = rated('lookup', true)
    await d.submit(FOLLOW_UP)
    expect(last(h.ratingPrompts), 'the dropped prompt began no task to continue').not.toContain('<task>')
    await d.turnStart('t1', FOLLOW_UP)
    await d.step('t1')
    await d.complete('t1')
    const after = readRuns(h)
    expect(after.map(l => l.kind)).toEqual(['dropped', 'run'])
    expect(after[1]?.turnId).toBe('t1')
    expect(after[1]?.id, 'its own run').not.toBe(after[0]?.id)
    expect(after[1]?.overhead, "its own rating call's cost, not the dropped one's").toBe(after[0]?.overhead)
  })
}
