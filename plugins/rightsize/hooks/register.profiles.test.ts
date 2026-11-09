import { expect, test } from 'claude-code/testing'
import { CAL_FULL, CAL_STORE, DEFAULT_PRICES, type Calibration, type Rating, type Situation, delegateCost, delegateKeys } from './cost'
import { SETTINGS } from './settings'
import { LOGS, RUNS_FILE, LOG_PATH, LEGACY_RUNS, LEGACY_SWITCHES, LOOKUP, DEBUG, SEARCH, REVIEW, NO_CHANGE, FREE_SWITCHES, engine, drive, flush, DAY, last, bandText, LOWER } from './testkit'

for (const surface of ['desktop', 'terminal'] as const) {
  const readRuns = (h: ReturnType<typeof engine>) => (h.files[RUNS_FILE] ?? '').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)

  // Hands off to Haiku at 78% of staying: over the 70% default, under the 85% a hot pace allows.
  const NEAR = '{"fit":{"haiku":"medium","sonnet":"medium","opus":"medium","fable":"medium"},"size":"small","type":"search","read":20000,"write":1000,"steps":14,"reason":"list call sites"}'
  const at = (h: { now: number }, ms: number) => new Date(h.now + ms).toISOString()

  const RUNS = LEGACY_RUNS

  // Close calls. A Fable session at high effort, a feature that Sonnet, Opus and Fable all do at medium.
  // Opus is measured (20 runs) at 0.9x Sonnet's estimate, Sonnet not at all: the 25% band is open, so the
  // two are close and the task-type guide (feature: Sonnet) decides. The stored count says which close call this is:
  // close calls are never explored.
  const TIE_RATING = '{"fit":{"haiku":"no","sonnet":"medium","opus":"medium","fable":"medium"},"type":"feature","read":150000,"write":3000,"steps":30,"reason":"big feature"}'
  const tieRating: Rating = { level: 'medium', fit: { haiku: null, sonnet: 'medium', opus: 'medium', fable: 'medium' }, type: 'feature', read: 150_000, write: 3000, steps: 30, reason: '' }
  const fableHigh: Situation = { tier: 'fable', level: 'high', context: 20_000, prices: DEFAULT_PRICES, cal: {} }
  // Opus's key pinned to `x` times Sonnet's estimate, from the raw cost of each route.
  const opusAt = (x: number, raw: (t: 'sonnet' | 'opus') => number, keys: readonly string[]): Calibration => ({
    [keys[keys.length - 1] ?? '']: { n: CAL_FULL, ratio: (raw('sonnet') * x) / raw('opus') },
  })
  const tieCal = (x: number) => opusAt(x, t => delegateCost(tieRating, fableHigh, t, 'medium'), delegateKeys('feature', 'opus', 'medium'))

  // Rater check: Sonnet's second opinion on every 50th rating, in the background.
  const FIT_NO = '{"fit":{"haiku":"no","sonnet":"no","opus":"medium","fable":"medium"},"type":"feature","read":2000,"write":300,"steps":1,"reason":"plain change"}'

  // ---- Every setting, on this surface ----------------------------------------------------------------
  //
  // Each of rightsize's /config rows is checked three ways: it is a declared option of its row (plugin.json
  // and settings.ts agree: Claude Code drops a stored value that is not one of a row's options, and fills in
  // its default), it takes effect when /config changes it, with no restart, and it takes effect when given at
  // load. The scenario for each shows one thing the row changes, with the value and with the default.

  const LOG = LOG_PATH
  const disagree = (h: ReturnType<typeof engine>) => (h.files[LOG] ?? '').includes('plugin.json and the settings table disagree')
  const settingsText = async (d: ReturnType<typeof drive>) => (await d.command('status')).text ?? ''
  const OPUS = { model: 'claude-opus-5-5', effort: 'medium' }
  const noteOf = (h: ReturnType<typeof engine>) => last(h.submitted)?.context?.join('\n') ?? ''
  const handedTo = (h: ReturnType<typeof engine>) => /model "(\w+)"/.exec(noteOf(h))?.[1]
  const YES_REMEMBER = { Remember: 'This session' }
  // A raise fixture: a review, the one task type whose rated raise is still taken at prompt time on Opus (ADR 0021).
  const RAISE_HIGH = '{"level":"high","model":"same","type":"review","read":20000,"write":3000,"steps":8,"reason":"unknown cause"}'
  const NEEDS_FABLE = '{"level":"high","model":"fable","size":"small","type":"debug","read":30000,"write":4000,"steps":12,"reason":"subtle concurrency bug"}'
  const HAIKU_SEARCH = '{"level":"low","model":"haiku","size":"bulky","type":"search","read":150000,"write":3000,"steps":30,"reason":"repo-wide search"}'


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
  const FILES = (h: ReturnType<typeof engine>) => Object.keys(h.files).sort()

  // ---- Outcomes rightsize measures itself: a test run's result, and a prompt that corrects the last reply ----

  const runsOf = (h: ReturnType<typeof engine>) => readRuns(h).filter(l => (l.kind ?? 'run') === 'run') as { id?: string; task?: string; tests?: string; change?: string }[]

  test(`a run line says tests: passed or failed when a test runner ran in the turn (the last run of the main chat), and says nothing when none did (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    await d.start(surface)
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    await d.step('t1', 0)
    await d.bash('npm test --red')
    await d.bash('npm test')
    await d.step('t1', 1)
    await d.complete('t1')
    await d.submit(LOOKUP)
    await d.step('t2', 0)
    await d.bash('npm test')
    await d.bash('pytest --red')
    await d.complete('t2')
    await d.submit(LOOKUP)
    await d.step('t3', 0)
    await d.bash('ls')
    await d.complete('t3')
    expect(runsOf(h).map(r => r.tests ?? null), 'the last test run of each turn: green, red, none').toEqual(['passed', 'failed', null])
  })

  test(`a run line takes tests from a helper when the main chat ran none, and the main chat's own run wins when it ran one (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-fable-5-1', effort: 'high', store: HELPERS })
    const d = drive($, h)
    await d.start(surface)
    await warm(d, h)
    h.rating = HAND_OFF()
    await startHelper(d, h, 't1', 'helper')
    await d.bash('npm test --red', 'agent-helper')
    await d.step('t1', 1, 'agent-helper')
    await d.step('t1', 1)
    await d.complete('t1')
    // The next hand-off: the helper's run is red, the main chat checked it and its own run is green.
    h.rating = HAND_OFF()
    await startHelper(d, h, 't2', 'second')
    await d.bash('npm test --red', 'agent-second')
    await d.step('t2', 1, 'agent-second')
    await d.bash('npm test')
    await d.step('t2', 1)
    await d.complete('t2')
    expect(runsOf(h).map(r => r.tests ?? null)).toEqual(['failed', 'passed'])
  })

  /** A rating that says the prompt corrects Claude's last reply, and carries on the task (so the task's last run is the one it corrects). */
  const CORRECTS = '{"fit":{"haiku":"no","sonnet":"medium","opus":"medium","fable":"medium"},"type":"lookup","read":2000,"write":300,"steps":1,"continues":true,"corrects":true,"reason":"it broke X"}'
  const correctedLines = (h: ReturnType<typeof engine>) => readRuns(h).filter(l => l.kind === 'corrected')

  test(`a prompt the rater says corrects the last reply writes one corrected line, for the task's last lowered run, once (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES } })
    // The run log's lines are stamped with the real clock: the engine's clock has to be there for them to count (30 days back).
    h.now = Date.now()
    const d = drive($, h)
    await d.start(surface)
    // The first prompt is lowered by the profile; it starts the task.
    h.rating = LOWER
    await d.submit(LOOKUP)
    await d.step('t1')
    await d.complete('t1')
    const first = runsOf(h)[0]
    expect(first?.change).toBe('lower')
    expect(correctedLines(h), 'nothing to correct yet').toEqual([])
    // The next prompt says the reply was wrong: a miss for the lowering.
    h.rating = CORRECTS
    await d.submit('no, that broke the parser, undo it')
    expect(correctedLines(h)).toMatchObject([{ kind: 'corrected', session: 'sess-1', task: first?.task, ref: first?.id }])
    expect(typeof (correctedLines(h)[0] as { at?: unknown }).at).toBe('string')
    expect(h.files[LOG_PATH] ?? '').toContain(`the prompt corrects the last reply: counted as a miss for run ${first?.id} (lower)`)
    await d.step('t2')
    await d.complete('t2')
    // Correcting again does not count the same run twice.
    h.rating = CORRECTS
    await d.submit('still wrong')
    // The correcting prompt before it was itself lowered (Opus at medium lowers every lookup), so this one counts that run, not the first again.
    expect(correctedLines(h).map(l => (l as { ref?: string }).ref), 'once per run').toEqual([first?.id, runsOf(h)[1]?.id])
    expect(h.asked, 'nothing is asked').toEqual([])
  })

  test(`a correcting prompt writes no corrected line when the task has no lowered or handed-down run, or no task (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    // Opus at low: nothing is lowered, so a run changes nothing.
    const h = engine(on, { ...OPUS, effort: 'low', store: { [CAL_STORE]: FREE_SWITCHES } })
    h.now = Date.now()
    const d = drive($, h)
    await d.start(surface)
    // One step first, so the session's level (low) is known.
    await d.step('t0')
    await d.complete('t0')
    // No task in progress: nothing to correct.
    h.rating = CORRECTS
    await d.submit('no, that is wrong')
    await d.step('t1')
    await d.complete('t1')
    expect(correctedLines(h), 'no task before it').toEqual([])
    // A task whose run changed nothing: nothing cheaper to blame.
    h.rating = CORRECTS
    await d.submit('still wrong')
    expect(runsOf(h)[0]?.change, 'the first run changed nothing').toBe('none')
    expect(correctedLines(h), 'no cheaper route made it').toEqual([])
  })

  test(`a session switch the person answered for a dropped prompt stays (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    await d.start(surface)
    h.rating = RAISE_HIGH
    await d.config('raiseRule', 'ask me')
    h.answers = { Effort: 'Raise for this session' }
    h.dropNext = 'refused'
    await d.submit(DEBUG)
    expect(readRuns(h).map(l => l.kind)).toEqual(['dropped'])
    expect(((await d.command('status'))).text ?? '', 'the answer was the person\'s').toContain('Session switch: high')
  })

  test(`a session start clears the line without logging it (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    await d.start(surface)
    await d.submit(DEBUG)
    await d.turnStart('t1', DEBUG)
    await d.step('t1')
    await d.complete('t1')
    expect(readRuns(h).map(l => l.kind), 'the earlier session start left no line for the waiting prompt').toEqual(['run'])
    expect(readRuns(h)[0]?.turnId).toBe('t1')
  })

  // ---- Pruning ----------------------------------------------------------------------

  test(`a session start removes the folders of sessions that last wrote over 45 days ago, and only those (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const at = (days: number) => h.now - days * DAY
    const put = (path: string, days: number) => {
      h.files[path] = `${JSON.stringify({ at: new Date(at(days)).toISOString(), kind: 'run' })}\n`
      h.mtimes[path] = at(days)
    }
    const R = `${LOGS}/rightsize`
    put(`${R}/old-one/runs.jsonl`, 46)
    put(`${R}/old-one/rightsize.log`, 60)
    put(`${R}/fresh/runs.jsonl`, 1)
    put(`${R}/fresh/rightsize.log`, 50)
    // One file written lately keeps the folder, however old the others are.
    put(`${R}/mixed/runs.jsonl`, 90)
    put(`${R}/mixed/switches.jsonl`, 44)
    // This session's own folder, though everything in it is old (a resumed session).
    put(RUNS_FILE, 100)
    // Not session folders at all: the old shared files, and a name that is not a plain one.
    put(LEGACY_RUNS, 100)
    put(LEGACY_SWITCHES, 100)
    put(`${R}/odd name/runs.jsonl`, 100)
    const d = drive($, h)
    await d.start(surface)
    await flush()
    expect(FILES(h).filter(f => f.includes('old-one')), 'the old folder is emptied').toEqual([])
    expect(h.ran).toContainEqual(['rm', '-f', `${R}/old-one/runs.jsonl`])
    expect(h.ran).toContainEqual(['rm', '-f', `${R}/old-one/rightsize.log`])
    expect(h.ran).toContainEqual(['rmdir', `${R}/old-one`])
    for (const kept of [`${R}/fresh/runs.jsonl`, `${R}/fresh/rightsize.log`, `${R}/mixed/runs.jsonl`, `${R}/mixed/switches.jsonl`, RUNS_FILE, LEGACY_RUNS, LEGACY_SWITCHES, `${R}/odd name/runs.jsonl`]) expect(h.files[kept], kept).toBeDefined()
    const removing = h.ran.filter(a => a[0] === 'rm' || a[0] === 'rmdir')
    expect(removing.length, 'two files and the folder, nothing else').toBe(3)
    expect(removing.every(a => a[a.length - 1]?.startsWith(`${R}/old-one`)), 'only paths inside the one old folder').toBe(true)
  })

  test(`a failing clean-up never stops the session from starting (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    h.files[`${LOGS}/rightsize/old-one/runs.jsonl`] = '{"at":"2026-01-01T00:00:00.000Z","kind":"run"}\n'
    h.mtimes[`${LOGS}/rightsize/old-one/runs.jsonl`] = h.now - 90 * DAY
    h.rmFails = true
    const d = drive($, h)
    await d.start(surface)
    await flush()
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    await d.step('t1')
    await d.complete('t1')
    expect(readRuns(h).map(l => l.kind), 'logging goes on').toEqual(['run'])
  })


  // ---- The fixed values and Ask before changing; your own setting wins ----------------------------

  /** Cheaper model: send automatically, so the Cheaper question never has to be answered. */
  const SEND = { [CAL_STORE]: FREE_SWITCHES, remember: true, choices: { down: 'auto' } }
  /** Rows set the way /config does: declared at load, and stored. */
  const withRows = (rows: Record<string, string>) => ({ options: rows, stored: rows })
  /** Hand-downs to Haiku for `search` work, `n` outcomes of which `missed` needed rework: what the evidence rule counts. */
  const haikuLog = (h: { now: number }, n: number, missed = 0) =>
    Array.from({ length: n }, (_, i) =>
      JSON.stringify({ at: new Date(h.now - (n - i) * 60_000).toISOString(), kind: 'run', type: 'search', tier: 'opus', route: 'delegate:haiku', change: 'delegate-down', agentCalls: i < missed ? 2 : 1 }),
    ).join('\n') + '\n'
  /** One prompt rated as NEAR (Haiku at about 78% of staying on Opus): where the hand-off went. */
  const nearHandOff = async ($: unknown, h: ReturnType<typeof engine>, d: ReturnType<typeof drive>, rating = NEAR) => {
    await d.start(surface)
    h.rating = rating
    await d.submit(SEARCH)
    return handedTo(h)
  }
  /** A repo-wide search that Haiku does at low: well under the fixed 70% of staying on Opus. */
  const CHEAP = '{"fit":{"haiku":"low","sonnet":"low","opus":"low","fable":"low"},"size":"bulky","type":"search","read":150000,"write":3000,"steps":30,"reason":"repo-wide search"}'

  // ---- One setting, two toggles (ADR 0021): the fixed values, Ask before changing, and the rows that replace them ----

  const SONNET = { model: 'claude-sonnet-5-5', effort: 'medium' }
  /** A raise on a Sonnet session: a rated raise is never taken at prompt time on Opus or Fable, and not for debugging on Sonnet. */
  const RAISE_FEATURE = '{"level":"high","model":"same","type":"feature","read":20000,"write":3000,"steps":20,"reason":"unknown cause"}'
  const IN_USE = 'In use: hand-off threshold 70%, pause at 20% misses, rater check every 20, 2 chances per task'

  test(`there is no Profile row: Ask before changing is a row of /config, off by default, and /rightsize shows it on its first line with what is in use (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS })
    const d = drive($, h)
    await d.start(surface)
    const text = await settingsText(d)
    expect(text.split('\n')[0]).toBe('Ask before changing: off')
    expect(text, 'the fixed values').toContain(IN_USE)
    expect(disagree(h)).toBe(false)
    expect(text, 'the default is not listed as yours').not.toMatch(/^ {2}Ask before changing:/m)
    expect(text).not.toContain('Profile')
  })

  test(`a row you set shows as yours; what is in use keeps the fixed values (${surface})`, { timeoutMs: 30000, options: withRows({ beforeCold: 'compact' }).options }, async ($, on) => {
    const h = engine(on, { ...OPUS, stored: withRows({ beforeCold: 'compact' }).stored })
    const d = drive($, h)
    await d.start(surface)
    const text = await settingsText(d)
    expect(text).toContain('Before the cache goes cold: compact')
    expect(text, 'the fixed values').toContain(IN_USE)
  })

  // The hand-off threshold is fixed at 70%: a cheaper route must cost under that share of staying (NEAR is 78%).
  test(`the hand-off threshold is 70%: NEAR (78% of staying) goes to no one, and a stored Hand-off threshold of 80% is ignored (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: SEND, stored: { handOff: '80%' } })
    const d = drive($, h)
    expect(await nearHandOff($, h, d)).toBeUndefined()
    expect(await settingsText(d)).not.toContain('Hand-off threshold')
    h.rating = CHEAP
    await d.submit(SEARCH)
    expect(handedTo(h), 'well under 70%: handed off').toBe('haiku')
  })

  // The evidence rule has no minimum of logged tasks: search on Haiku starts from its research prior.
  test(`with nothing logged, search work goes to Haiku: no minimum of logged tasks (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: SEND })
    expect(await nearHandOff($, h, drive($, h), CHEAP)).toBe('haiku')
  })

  // The first automatic miss on a route is forgiven once, ever: 1 miss in 5 counts as 0 of 4, and the log says so.
  test(`the first miss on search is forgiven: 1 miss in 5 still hands search to Haiku, and the log says so (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: SEND })
    h.files[RUNS] = haikuLog(h, 5, 1)
    expect(await nearHandOff($, h, drive($, h), CHEAP)).toBe('haiku')
    expect(h.files[LOG_PATH] ?? '', 'the log says the first miss was forgiven').toContain('forgave the first miss on search')
  })

  test(`a miss forgiven on a hand-off turn is shown on the band beside the hand-off's result (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-fable-5-1', effort: 'high', store: HELPERS })
    const d = drive($, h)
    // The log's times are the wall clock's: the 30-day window counts from now.
    h.now = Date.now()
    await d.start(surface)
    await warm(d, h)
    h.rating = HAND_OFF()
    await startHelper(d, h, 't1', 'helper')
    // The main chat starts a second subagent on Haiku: rework, so the hand-down was a miss.
    await d.agent('haiku')
    await d.complete('t1')
    const text = await bandText($, surface)
    expect(text, 'the hand-off result').toContain('Sent to Haiku')
    expect(text, 'and the forgiven miss').toContain('Haiku missed once on search work; that one is forgiven, and the next miss pauses it.')
    // The next prompt's band starts clean.
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    expect(await bandText($, surface)).not.toContain('missed once')
  })

  test(`every band ends with the session's running total once the session has rated prompts, and never carries it twice (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    h.now = Date.now()
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')

    // Prompts 1 and 2: fewer than SESSION_TOTAL_FROM (3) rated prompts, so no total on the band.
    h.rating = LOWER
    await d.submit(LOOKUP)
    expect(await bandText($, surface), 'prompt 1').not.toContain('Session:')
    await d.step('t1')
    await d.complete('t1')
    await d.submit(LOOKUP)
    expect(await bandText($, surface), 'prompt 2: still none').not.toContain('Session:')
    await d.step('t2')
    await d.complete('t2')
    // The 3rd rated prompt: its band ends with the total.
    // A third lowering, then a subagent of Claude's own moved to Haiku: the end-of-turn band is built from the third one's text.
    await d.submit(LOOKUP)
    expect(await bandText($, surface), 'prompt 3: the total').toMatch(/Effort lowered: medium → low for this prompt \(automatically\)\. Why: .+ Confidence: low\. Session: ~\$\d+\.\d\d saved$/)
    h.rating = '{"fit":{"haiku":"low","sonnet":"low","opus":"low","fable":"low"},"size":"small","type":"search","read":8000,"write":500,"steps":5,"reason":"list call sites"}'
    await d.step('t3', 0)
    await d.spawn('lister')
    await d.step('t3', 0, 'agent-lister')
    await d.complete('t3')
    const rebuilt = await bandText($, surface)
    expect(rebuilt, 'the earlier text and the new sentence are both there').toMatch(/Effort lowered.*Ran Claude's subagent on Haiku \(low\) instead of Opus\./)
    expect(rebuilt.match(/Session:/g), 'one total only').toHaveLength(1)
    expect(rebuilt, 'and it is last, with the figure as of now').toMatch(/ Session: ~\$\d+\.\d\d (saved|more)$/)
  })

  // With 10 logged tasks the research prior is gone. The first miss is forgiven, so 2 misses in 10 is 1 in 9: 11%, under the line.
  test(`2 misses in 10 still hands search to Haiku: the first is forgiven, 1 in 9 is under 20% (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: SEND })
    h.files[RUNS] = haikuLog(h, 10, 2)
    expect(await nearHandOff($, h, drive($, h), CHEAP)).toBe('haiku')
  })

  test(`a route that already used its forgiveness pauses at 2 misses in 10: 20% (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: { ...SEND, forgivenRoutes: ['search:haiku'] } })
    h.files[RUNS] = haikuLog(h, 10, 2)
    expect(await nearHandOff($, h, drive($, h), CHEAP)).toBeUndefined()
    expect(h.files[LOG_PATH] ?? '', 'nothing is forgiven again').not.toContain('forgave the first miss')
  })

  // The miss pause: 20% with 10 logged tasks (the research prior is gone). The first miss is forgiven, so 3 misses in 10 is 2 in 9: 22%.
  test(`3 misses in 10 pauses search at 20%, and a stored Pause after misses of 50% is ignored (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: SEND, stored: { missPause: '50%' } })
    h.files[RUNS] = haikuLog(h, 10, 3)
    const d = drive($, h)
    expect(await nearHandOff($, h, d, CHEAP)).toBeUndefined()
    expect(await settingsText(d)).toContain(IN_USE)
  })

  // The rater spot-check: every 20 Haiku ratings, fixed; a stored Rater check is ignored.
  for (const [more, before, checked] of [
    [{}, 19, true],
    [{}, 18, false],
    [{ raterCheck: 'every 100' }, 19, true],
    [{ raterCheck: 'off' }, 19, true],
  ] as const) {
    const row = 'raterCheck' in more ? `a stored Rater check ${more.raterCheck} is ignored` : 'the fixed rater check (every 20)'
    test(`${row}: the prompt after ${before} Haiku ratings ${checked ? 'is' : 'is not'} checked by Sonnet (${surface})`, { timeoutMs: 30000, options: withRows({ rater: 'haiku' }).options }, async ($, on) => {
      const h = engine(on, { ...OPUS, store: { spotChecks: before }, stored: { ...withRows({ rater: 'haiku' }).stored, ...more } })
      const d = drive($, h)
      h.now = Date.now()
      await d.start(surface)
      h.rating = FIT_NO
      await d.submit(LOOKUP)
      await flush()
      expect(h.completions.filter(m => m === 'sonnet').length).toBe(checked ? 1 : 0)
    })
  }

  // Chances: a task's retries, two.
  test(`a task has two chances: a helper is raised twice, and the third struggle sends it back (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
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
    // The errors sign looks at the last 10 calls: seven reads that make no progress fill the window.
    for (let i = 1; i <= 7; i++) await d.bash(`cat f${i}`, 'agent-helper')
    await d.step('t1', 2, 'agent-helper')
    expect(last(h.sent)?.effort, 'second chance').toBe('high')
    for (let i = 0; i < 3; i++) await d.bash('ls', 'agent-helper')
    await d.step('t1', 3, 'agent-helper')
    expect(last(h.sent)?.effort, 'no third raise').toBe('high')
    expect(helperLog(h)).toContain('and the task has no retry left')
    expect(((await d.bash('ls', 'agent-helper')) as { deny?: string }).deny, 'sent back').toContain('retry budget is used up')
    await d.complete('t1')
    expect((readRuns(h).find(l => l.kind === 'run') as { retries?: number }).retries).toBe(2)
  })

  test(`the hand-off note allows 2 rework rounds, the task's chances (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: SEND })
    expect(await nearHandOff($, h, drive($, h), CHEAP)).toBe('haiku')
    expect(noteOf(h)).toContain('At most 2 rework rounds.')
    expect(noteOf(h)).toContain('still fails after 2 rework')
  })

  // The four questions: asked once each from /rightsize settings; Ask before changing picks the first option, marked (Recommended).
  const FIRST = {
    off: ['Lower automatically (Recommended)', 'Raise automatically (Recommended)', 'Use the stronger model automatically (Recommended)', 'Send it to a cheaper subagent (Recommended)'],
    on: ['Ask me each time (Recommended)', 'Ask me each time (Recommended)', 'Ask before using it (Recommended)', 'Ask before sending it (Recommended)'],
  } as const
  const ROWS_AFTER = {
    off: { lowerRule: 'lower automatically', raiseRule: 'raise automatically', upRule: 'always send', downRule: 'always send' },
    on: { lowerRule: 'ask me', raiseRule: 'ask me', upRule: 'ask first', downRule: 'ask first' },
  } as const
  for (const ask of ['off', 'on'] as const) {
    test(`Ask before changing ${ask}: each of the four questions lists its recommended answer first, and answering it sets the matching rule (${surface})`, { timeoutMs: 30000, options: withRows({ askFirst: ask }).options }, async ($, on) => {
      const h = engine(on, { ...SONNET, stored: withRows({ askFirst: ask }).stored })
      const d = drive($, h)
      await d.start(surface)
      const [lower, raise, up, down] = FIRST[ask]
      h.answers = { Lowering: lower, Raising: raise, Stronger: up, Cheaper: down, ...YES_REMEMBER }
      await d.command('settings')
      const asked = h.asked.filter(a => ['Lowering', 'Raising', 'Stronger', 'Cheaper'].includes(a.header))
      expect(asked.map(a => a.header), 'all four, once each').toEqual(['Lowering', 'Raising', 'Stronger', 'Cheaper'])
      expect(asked.map(a => a.options[0]), 'the first option').toEqual([...FIRST[ask]])
      for (const a of asked) expect(a.options.filter(o => o.endsWith('(Recommended)')), `${a.header}: only the first is recommended`).toEqual([a.options[0]])
      expect(asked.map(a => a.options.length), 'no option is lost to the reorder').toEqual([3, 3, 4, 4])
      expect(h.stored, 'the answer stands for the value of its option, whatever the order').toMatchObject(ROWS_AFTER[ask])
    })
  }

  test(`a case with no rule set is decided by the default, noted once per session on the band with every case of that prompt; a rule you set is not asked or noted at all (${surface})`, { timeoutMs: 30000, options: withRows({ lowerRule: 'never lower' }).options }, async ($, on) => {
    const h = engine(on, { ...SONNET, stored: withRows({ lowerRule: 'never lower' }).stored })
    const d = drive($, h)
    await d.start(surface)
    // One step first, so the session's model is known (a session with no step yet is planned as Opus).
    await d.step('t0')
    await d.complete('t0')
    h.rating = LOWER
    await d.submit(LOOKUP)
    expect(h.asked, 'Lowering is yours').toEqual([])
    expect(await bandText($, surface), 'Lowering is the person\'s: the default did not decide it').not.toContain('decided')
    h.rating = RAISE_FEATURE
    await d.submit(DEBUG)
    expect(await bandText($, surface), 'Raising is decided by the default: said').toMatch(/The default decided \(Raising\); ⋯ changes it\.$/)
    expect(h.files[LOG_PATH] ?? '').toContain('Raising: no rule set, the default decides (raise automatically)')
    await d.submit(DEBUG)
    expect(h.asked, 'nothing is asked').toEqual([])
    expect(await bandText($, surface), 'once per session').not.toContain('decided')
    // A new session says it again.
    await d.start(surface)
    await d.step('t3')
    await d.complete('t3')
    await d.submit(DEBUG)
    expect(await bandText($, surface)).toMatch(/The default decided \(Raising\)/)
    expect(h.store.choices, 'nothing saved').toBeUndefined()
  })

  test(`Ask before changing on: Lowering asks in the Effort dialog, and the band says Ask before changing decided (${surface})`, { timeoutMs: 30000, options: withRows({ askFirst: 'on' }).options }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES }, stored: withRows({ askFirst: 'on' }).stored })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = LOWER
    h.answers = { Effort: 'Lower for this prompt' }
    await d.submit(LOOKUP)
    expect(h.asked.map(a => a.header), 'Lowering is ask: the Effort dialog').toEqual(['Effort'])
    expect(h.files[LOG_PATH] ?? '').toContain('Lowering: no rule set, Ask before changing decides (ask me)')
    expect(await bandText($, surface)).toMatch(/Ask before changing decided \(Lowering\); ⋯ changes it\.$/)
    await d.step('t1')
    expect(last(h.sent)?.effort, 'answered Lower for this prompt').toBe('low')
    expect(h.store.choices, 'nothing saved').toBeUndefined()
  })

  test(`Ask before changing on: Cheaper model asks in the Subagent dialog, and the band says Ask before changing decided (${surface})`, { timeoutMs: 30000, options: withRows({ askFirst: 'on' }).options }, async ($, on) => {
    const h = engine(on, { model: 'claude-fable-5-1', effort: 'high', store: { [CAL_STORE]: FREE_SWITCHES }, stored: withRows({ askFirst: 'on' }).stored })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = HAIKU_SEARCH
    h.answers = { Subagent: 'Send it to a Haiku subagent' }
    await d.submit(SEARCH)
    expect(h.asked.map(a => a.header), 'Cheaper model is ask: the Subagent dialog').toEqual(['Subagent'])
    expect(h.files[LOG_PATH] ?? '').toContain('Cheaper model: no rule set, Ask before changing decides (ask first)')
    expect(handedTo(h), 'answered yes').toBe('haiku')
    expect(await bandText($, surface)).toMatch(/Ask before changing decided \(Cheaper model\); ⋯ changes it\.$/)
  })

  test(`Ask before changing on: Raising asks too, and a rule row you set still wins for its case (${surface})`, { timeoutMs: 30000, options: withRows({ askFirst: 'on', raiseRule: 'raise automatically' }).options }, async ($, on) => {
    const h = engine(on, { ...SONNET, stored: withRows({ askFirst: 'on', raiseRule: 'raise automatically' }).stored })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = RAISE_FEATURE
    await d.submit(DEBUG)
    expect(h.asked, 'Raising is yours: nothing asked').toEqual([])
    await d.step('t1')
    expect(last(h.sent)?.effort).toBe('high')
    await d.complete('t1')
    await d.config('raiseRule', 'not set')
    await d.submit(DEBUG)
    expect(h.asked.map(a => a.header), 'the rule cleared: Ask before changing asks').toEqual(['Effort'])
    expect(h.files[LOG_PATH] ?? '').toContain('Raising: no rule set, Ask before changing decides (ask me)')
  })

  test(`a Quality profile stored by an older release reads as Ask before changing on, the status says so, and the row set in /config wins (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES }, stored: { profile: 'Quality' } })
    const d = drive($, h)
    await d.start(surface)
    expect((await settingsText(d)).split('\n')[0]).toBe('Ask before changing: on (from your old Quality profile)')
    expect(disagree(h), 'a stored row the manifest no longer has is not a disagreement').toBe(false)
    await d.step('t0')
    await d.complete('t0')
    h.rating = LOWER
    h.answers = { Effort: 'Lower for this prompt' }
    await d.submit(LOOKUP)
    expect(h.asked.map(a => a.header), 'asks, as Quality did').toEqual(['Effort'])
    await d.step('t1')
    await d.complete('t1')
    await d.config('askFirst', 'off')
    expect((await settingsText(d)).split('\n')[0], 'the row is yours now: the old profile no longer counts').toBe('Ask before changing: off')
    const asked = h.asked.length
    await d.submit(LOOKUP)
    expect(h.asked.length, 'nothing asked').toBe(asked)
    await d.step('t2')
    expect(last(h.sent)?.effort).toBe('low')
  })

  for (const profile of ['Balanced', 'Economy']) {
    test(`a ${profile} profile stored by an older release changes nothing (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
      const h = engine(on, { ...OPUS, stored: { profile } })
      const d = drive($, h)
      await d.start(surface)
      expect((await settingsText(d)).split('\n')[0]).toBe('Ask before changing: off')
      expect(await settingsText(d)).toContain(IN_USE)
    })
  }

  const REVIEW_XHIGH = REVIEW.replace('"level":"high"', '"level":"xhigh"')

  test(`a switched review rated for xhigh runs on Opus at xhigh: no cap below Highest effort (${surface})`, { timeoutMs: 30000, options: withRows({ upRule: 'always send' }).options }, async ($, on) => {
    const h = engine(on, { ...SONNET, store: { [CAL_STORE]: FREE_SWITCHES }, stored: withRows({ upRule: 'always send' }).stored })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = REVIEW_XHIGH
    await d.submit(DEBUG)
    await d.step('t1')
    expect(last(h.sent), 'the turn runs on Opus').toMatchObject({ model: 'opus', effort: 'xhigh' })
    await d.complete('t1')
  })

  test(`close calls are never explored: a stored Explore close calls on is ignored (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const cal = { ...tieCal(0.9), ...FREE_SWITCHES }
    const h = engine(on, { model: 'claude-fable-5-1', effort: 'high', store: { ...SEND, [CAL_STORE]: cal, ties: 4 }, stored: { explore: 'on' } })
    const d = drive($, h)
    await d.start(surface)
    h.rating = TIE_RATING
    await d.submit(SEARCH)
    expect(handedTo(h), 'the guide\'s pick, not the other route').toBe('sonnet')
  })


  // Switching Ask before changing in /config takes effect at once, through applyOption, like any other row.
  test(`switching Ask before changing in /config applies at once: the questions' first options, and whether a lowering asks (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = LOWER
    await d.submit(LOOKUP)
    expect(h.asked, 'off: lowered with no question').toEqual([])
    await d.step('t1')
    expect(last(h.sent)?.effort).toBe('low')
    await d.complete('t1')

    const result = await d.config('askFirst', 'on')
    expect(result.deny).toBeUndefined()
    expect((await settingsText(d)).split('\n')[0]).toBe('Ask before changing: on')
    expect(await settingsText(d), 'listed as yours').toMatch(/^ {2}Ask before changing: on$/m)
    h.answers = { Effort: 'Keep as is' }
    await d.submit(LOOKUP)
    expect(h.asked.map(a => a.header), 'on: the Effort dialog').toEqual(['Effort'])
    await d.step('t2')
    expect(last(h.sent)?.effort, 'kept').toBe('medium')
    await d.complete('t2')

    await d.config('askFirst', 'off')
    expect((await settingsText(d)).split('\n')[0]).toBe('Ask before changing: off')
    const asked = h.asked.length
    await d.submit(LOOKUP)
    expect(h.asked.length, 'off again: no question').toBe(asked)
  })

  test(`a value another plugin writes to the Ask before changing row is the row's value, and one outside its options changes nothing (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS })
    const d = drive($, h)
    await d.start(surface)
    await d.config('askFirst', 'on', 'plugin')
    expect((await settingsText(d)).split('\n')[0], 'the value is the row\'s now').toBe('Ask before changing: on')
    expect((await d.config('askFirst', 'maybe')).deny, 'not an option').toBeDefined()
    expect((await settingsText(d)).split('\n')[0]).toBe('Ask before changing: on')
  })

}
