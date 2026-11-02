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
  // the fourth (3 before it) goes to the guide, the fifth explores.
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
  const RAISE_HIGH = '{"level":"high","model":"same","type":"debug","read":20000,"write":3000,"steps":8,"reason":"unknown cause"}'
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
    expect(correctedLines(h).length, 'once for the run').toBe(1)
    expect(h.asked, 'nothing is asked').toEqual([])
  })

  test(`a correcting prompt writes no corrected line when the task has no lowered or handed-down run, or no task (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES } })
    h.now = Date.now()
    const d = drive($, h)
    await d.start(surface)
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
    h.rating = '{"level":"high","model":"same","type":"debug","read":20000,"write":3000,"steps":8,"reason":"unknown cause"}'
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


  // ---- Profiles: Quality, Balanced and Economy supply defaults; your own setting wins ----------------------------

  const PROFILE_NAMES = ['Quality', 'Balanced', 'Economy'] as const
  /** Cheaper model: send automatically, so the first option of the question (which differs by profile) never has to be answered. */
  const SEND = { [CAL_STORE]: FREE_SWITCHES, remember: true, choices: { down: 'auto' } }
  /** Opts a session into a profile the way /config does: declared at load, and stored. */
  const inProfile = (profile: string, more: Record<string, string> = {}) => ({ options: { profile, ...more }, stored: { profile, ...more } })
  /** Hand-downs to Haiku for `search` work, `n` outcomes of which `missed` needed rework: what a profile's evidence rule counts. */
  const haikuLog = (h: { now: number }, n: number, missed = 0) =>
    Array.from({ length: n }, (_, i) =>
      JSON.stringify({ at: new Date(h.now - (n - i) * 60_000).toISOString(), kind: 'run', type: 'search', tier: 'opus', route: 'delegate:haiku', change: 'delegate-down', agentCalls: i < missed ? 2 : 1 }),
    ).join('\n') + '\n'
  /** One prompt rated as NEAR (Haiku at about 78% of staying on Opus): where the hand-off went. */
  const nearHandOff = async ($: unknown, h: ReturnType<typeof engine>, d: ReturnType<typeof drive>) => {
    await d.start(surface)
    h.rating = NEAR
    await d.submit(SEARCH)
    return handedTo(h)
  }

  test(`Profile is a row of /config, and /rightsize shows it on its first line (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS })
    const d = drive($, h)
    await d.start(surface)
    const text = await settingsText(d)
    expect(text.split('\n')[0], 'Balanced by default').toBe('Profile: Balanced')
    expect(text, 'what the profile applies').toContain('In use: hand-off threshold 70%, pause at 20% misses, rater check every 20, 2 chances per task')
    expect(disagree(h)).toBe(false)
    expect(text, 'the default is not listed as yours').not.toMatch(/^ {2}Profile:/m)
  })

  for (const profile of PROFILE_NAMES) {
    const { options, stored } = inProfile(profile)
    test(`${profile}: /rightsize shows it, and what it applies (${surface})`, { timeoutMs: 30000, options }, async ($, on) => {
      const h = engine(on, { ...OPUS, stored })
      const d = drive($, h)
      await d.start(surface)
      const text = await settingsText(d)
      expect(text.split('\n')[0]).toBe(`Profile: ${profile}`)
      const line = { Quality: 'hand-off threshold 50%, pause at 10% misses and 10 logged tasks, rater check every 10, 1 chance per task', Balanced: 'hand-off threshold 70%, pause at 20% misses, rater check every 20, 2 chances per task', Economy: 'hand-off threshold 85%, pause at 30% misses, rater check every 30, 3 chances per task' }[profile]
      expect(text).toContain(`In use: ${line}`)
    })
  }

  test(`a row you set shows as yours, and what is in use follows it, not the profile (${surface})`, { timeoutMs: 30000, options: inProfile('Quality', { handOff: '60%', raterCheck: 'every 100' }).options }, async ($, on) => {
    const h = engine(on, { ...OPUS, stored: inProfile('Quality', { handOff: '60%', raterCheck: 'every 100' }).stored })
    const d = drive($, h)
    await d.start(surface)
    const text = await settingsText(d)
    expect(text).toContain('Hand-off threshold: 60%')
    expect(text).toContain('Rater check: every 100')
    expect(text, 'Pause after misses is not yours: the profile still sets it').toContain('In use: hand-off threshold 60%, pause at 10% misses and 10 logged tasks, rater check every 100, 1 chance per task')
  })

  // The hand-off threshold: a cheaper route must cost under this share of staying (NEAR is 78%).
  for (const [profile, to] of [['Quality', undefined], ['Balanced', undefined], ['Economy', 'haiku']] as const) {
    test(`${profile} sets the hand-off threshold when the row is not yours: NEAR (78% of staying) goes to ${to ?? 'no one'} (${surface})`, { timeoutMs: 30000, options: inProfile(profile).options }, async ($, on) => {
      const h = engine(on, { ...OPUS, store: SEND, stored: inProfile(profile).stored })
      // Quality would need 10 logged tasks too: give it, so the threshold is what decides.
      h.files[RUNS] = haikuLog(h, 12)
      expect(await nearHandOff($, h, drive($, h))).toBe(to)
    })
  }

  test(`a Hand-off threshold you set wins over the profile, whichever way it differs (${surface})`, { timeoutMs: 30000, options: inProfile('Economy', { handOff: '60%' }).options }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: SEND, stored: inProfile('Economy', { handOff: '60%' }).stored })
    expect(await nearHandOff($, h, drive($, h)), 'Economy would have said 85%: the row says 60%').toBeUndefined()
  })

  test(`a Hand-off threshold of 80% set under Quality wins over its 50% (${surface})`, { timeoutMs: 30000, options: inProfile('Quality', { handOff: '80%' }).options }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: SEND, stored: inProfile('Quality', { handOff: '80%' }).stored })
    h.files[RUNS] = haikuLog(h, 12)
    expect(await nearHandOff($, h, drive($, h))).toBe('haiku')
  })

  // Quality's evidence rule: 10 tasks of that kind on that route, and under 10% misses. Search on Haiku has a research
  // prior worth 10 tasks at 0% misses; each logged task takes the place of one of them.
  for (const [what, n, missed, to] of [
    ['9 logged tasks, none missed: allowed, the research prior fills the tenth', 9, 0, 'haiku'],
    ['5 logged tasks, 2 missed (the first forgiven: 1 in 4, 10% with the prior): refused', 5, 2, undefined],
    ['10 logged tasks, none missed: allowed', 10, 0, 'haiku'],
    ['10 logged tasks, 2 missed (the first forgiven: 1 in 9, 10%): refused', 10, 2, undefined],
    ['11 logged tasks, 1 missed, forgiven: allowed', 11, 1, 'haiku'],
  ] as const) {
    test(`Quality, ${what} (${surface})`, { timeoutMs: 30000, options: inProfile('Quality', { handOff: '90%' }).options }, async ($, on) => {
      const h = engine(on, { ...OPUS, store: SEND, stored: inProfile('Quality', { handOff: '90%' }).stored })
      h.files[RUNS] = haikuLog(h, n, missed)
      expect(await nearHandOff($, h, drive($, h))).toBe(to)
    })
  }

  test(`Quality with nothing logged starts from the research prior: search work goes to Haiku (${surface})`, { timeoutMs: 30000, options: inProfile('Quality', { handOff: '90%' }).options }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: SEND, stored: inProfile('Quality', { handOff: '90%' }).stored })
    expect(await nearHandOff($, h, drive($, h))).toBe('haiku')
  })

  // The first automatic miss on a route is forgiven once, ever: 1 miss in 5 counts as 0 of 4, and the log says so.
  test(`Quality forgives the first miss on search: 1 miss in 5 still hands search to Haiku, and the log says so (${surface})`, { timeoutMs: 30000, options: inProfile('Quality', { handOff: '90%' }).options }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: SEND, stored: inProfile('Quality', { handOff: '90%' }).stored })
    h.files[RUNS] = haikuLog(h, 5, 1)
    expect(await nearHandOff($, h, drive($, h))).toBe('haiku')
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

  test(`Quality: 2 misses in 5 pauses search, the first of them forgiven (${surface})`, { timeoutMs: 30000, options: inProfile('Quality', { handOff: '90%' }).options }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: SEND, stored: inProfile('Quality', { handOff: '90%' }).stored })
    h.files[RUNS] = haikuLog(h, 5, 2)
    expect(await nearHandOff($, h, drive($, h))).toBeUndefined()
  })

  test(`Quality: a route that already used its forgiveness pauses on its first miss (${surface})`, { timeoutMs: 30000, options: inProfile('Quality', { handOff: '90%' }).options }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: { ...SEND, forgivenRoutes: ['search:haiku'] }, stored: inProfile('Quality', { handOff: '90%' }).stored })
    h.files[RUNS] = haikuLog(h, 5, 1)
    expect(await nearHandOff($, h, drive($, h))).toBeUndefined()
    expect(h.files[LOG_PATH] ?? '', 'nothing is forgiven again').not.toContain('forgave the first miss')
  })

  test(`Pause after misses you set replaces the whole evidence rule, Quality's 10 logged tasks too (${surface})`, { timeoutMs: 30000, options: inProfile('Quality', { handOff: '90%', missPause: '50%' }).options }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: SEND, stored: inProfile('Quality', { handOff: '90%', missPause: '50%' }).stored })
    expect(await nearHandOff($, h, drive($, h)), 'no tasks logged, and the row says 50%').toBe('haiku')
  })

  // The miss pause: Balanced pauses a kind of work at 20% misses, Economy at 30%. With 10 logged tasks the research
  // prior is gone. The first miss is forgiven, so 3 misses in 10 is 2 in 9: 20%.
  for (const [profile, to] of [['Balanced', undefined], ['Economy', 'haiku']] as const) {
    test(`${profile} at 20% misses hands off to ${to ?? 'no one'} (${surface})`, { timeoutMs: 30000, options: inProfile(profile, profile === 'Balanced' ? { handOff: '90%' } : {}).options }, async ($, on) => {
      const h = engine(on, { ...OPUS, store: SEND, stored: inProfile(profile, profile === 'Balanced' ? { handOff: '90%' } : {}).stored })
      h.files[RUNS] = haikuLog(h, 10, 3)
      expect(await nearHandOff($, h, drive($, h))).toBe(to)
    })
  }

  test(`Economy pauses at 30% misses: 4 in 10 (the first forgiven: 3 in 9) is paused, and early misses are softened by the prior (${surface})`, { timeoutMs: 30000, options: inProfile('Economy').options }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: SEND, stored: inProfile('Economy').stored })
    h.files[RUNS] = haikuLog(h, 10, 4)
    expect(await nearHandOff($, h, drive($, h))).toBeUndefined()
  })

  // The rater spot-check: the interval is the profile's unless Rater check is yours.
  for (const [profile, more, before, checked] of [
    ['Quality', {}, 9, true],
    ['Quality', {}, 8, false],
    ['Balanced', {}, 19, true],
    ['Balanced', {}, 18, false],
    ['Economy', {}, 29, true],
    ['Economy', {}, 19, false],
    ['Quality', { raterCheck: 'every 25' }, 9, false],
    ['Quality', { raterCheck: 'every 25' }, 24, true],
    ['Economy', { raterCheck: 'off' }, 29, false],
  ] as const) {
    const row = `${profile}${'raterCheck' in more ? ` with Rater check ${more.raterCheck}` : ''}`
    test(`${row}: the prompt after ${before} Haiku ratings ${checked ? 'is' : 'is not'} checked by Sonnet (${surface})`, { timeoutMs: 30000, options: inProfile(profile, { rater: 'haiku', ...more }).options }, async ($, on) => {
      const h = engine(on, { ...OPUS, store: { spotChecks: before }, stored: inProfile(profile, { rater: 'haiku', ...more }).stored })
      const d = drive($, h)
      h.now = Date.now()
      await d.start(surface)
      h.rating = FIT_NO
      await d.submit(LOOKUP)
      await flush()
      expect(h.completions.filter(m => m === 'sonnet').length).toBe(checked ? 1 : 0)
    })
  }

  // Chances: a task's retries. Quality 1, Balanced 2, Economy 3.
  test(`Quality gives a task one chance: the second struggle sends the helper back (${surface})`, { timeoutMs: 30000, options: inProfile('Quality').options }, async ($, on) => {
    const h = engine(on, { model: 'claude-fable-5-1', effort: 'high', store: HELPERS, stored: inProfile('Quality').stored })
    // Quality hands a task down only on evidence: 12 logged hand-downs to Haiku for search work, none missed.
    h.files[RUNS] = haikuLog(h, 12)
    const d = drive($, h)
    await d.start(surface)
    await warm(d, h)
    h.rating = HAND_OFF()
    await startHelper(d, h, 't1', 'helper')
    await d.bash('fail a', 'agent-helper')
    await d.bash('fail a', 'agent-helper')
    await d.step('t1', 1, 'agent-helper')
    expect(last(h.sent)?.effort, 'the one chance').toBe('medium')
    await d.bash('fail b', 'agent-helper')
    await d.step('t1', 2, 'agent-helper')
    expect(last(h.sent)?.effort, 'no second raise').toBe('medium')
    expect(helperLog(h)).toContain('and the task has no retry left')
    expect(((await d.bash('ls', 'agent-helper')) as { deny?: string }).deny, 'sent back').toContain('retry budget is used up')
    await d.complete('t1')
    expect((readRuns(h).find(l => l.kind === 'run') as { retries?: number }).retries).toBe(1)
  })

  test(`Economy gives a task three chances: a helper is raised three times before it is sent back (${surface})`, { timeoutMs: 30000, options: inProfile('Economy').options }, async ($, on) => {
    const h = engine(on, { model: 'claude-fable-5-1', effort: 'high', store: HELPERS, stored: inProfile('Economy').stored })
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
    expect(last(h.sent)?.effort, 'third chance').toBe('xhigh')
    expect(helperLog(h)).not.toContain('no retry left')
    await d.complete('t1')
    expect((readRuns(h).find(l => l.kind === 'run') as { retries?: number }).retries).toBe(3)
  })

  for (const [profile, rounds] of [['Quality', '1 rework round'], ['Balanced', '2 rework rounds'], ['Economy', '3 rework rounds']] as const) {
    test(`${profile}: the hand-off note allows ${rounds}, the task's chances (${surface})`, { timeoutMs: 30000, options: inProfile(profile, { handOff: '90%', missPause: '50%' }).options }, async ($, on) => {
      const h = engine(on, { ...OPUS, store: SEND, stored: inProfile(profile, { handOff: '90%', missPause: '50%' }).stored })
      expect(await nearHandOff($, h, drive($, h))).toBe('haiku')
      expect(noteOf(h)).toContain(`At most ${rounds}.`)
      expect(noteOf(h)).toContain(`still fails after ${rounds.replace(' round', '')}`)
    })
  }

  // The four questions: asked in every profile, once each; the profile only picks the first option, marked (Recommended).
  const FIRST = {
    Quality: ['Ask me each time (Recommended)', 'Raise automatically (Recommended)', 'Use the stronger model automatically (Recommended)', 'Ask before sending it (Recommended)'],
    Balanced: ['Lower automatically (Recommended)', 'Raise automatically (Recommended)', 'Use the stronger model automatically (Recommended)', 'Send it to a cheaper subagent (Recommended)'],
    Economy: ['Lower automatically (Recommended)', 'Raise automatically (Recommended)', 'Stay on Sonnet, raise effort only (Recommended)', 'Send it to a cheaper subagent (Recommended)'],
  } as const
  const ROWS_AFTER = {
    Quality: { lowerRule: 'ask me', raiseRule: 'raise automatically', upRule: 'always send', downRule: 'ask first' },
    Balanced: { lowerRule: 'lower automatically', raiseRule: 'raise automatically', upRule: 'always send', downRule: 'always send' },
    Economy: { lowerRule: 'lower automatically', raiseRule: 'raise automatically', upRule: 'stay, raise effort only', downRule: 'always send' },
  } as const
  for (const profile of PROFILE_NAMES) {
    test(`${profile}: each of the four questions lists its recommended answer first, and answering it sets the matching rule (${surface})`, { timeoutMs: 30000, options: inProfile(profile).options }, async ($, on) => {
      const h = engine(on, { model: 'claude-sonnet-5-5', effort: 'medium', stored: inProfile(profile).stored })
      const d = drive($, h)
      await d.start(surface)
      const [lower, raise, up, down] = FIRST[profile]
      h.answers = { Lowering: lower, Raising: raise, Stronger: up, Cheaper: down, ...YES_REMEMBER }
      await d.command('settings')
      const asked = h.asked.filter(a => ['Lowering', 'Raising', 'Stronger', 'Cheaper'].includes(a.header))
      expect(asked.map(a => a.header), 'all four, once each').toEqual(['Lowering', 'Raising', 'Stronger', 'Cheaper'])
      expect(asked.map(a => a.options[0]), 'the first option').toEqual([...FIRST[profile]])
      for (const a of asked) expect(a.options.filter(o => o.endsWith('(Recommended)')), `${a.header}: only the first is recommended`).toEqual([a.options[0]])
      expect(asked.map(a => a.options.length), 'no option is lost to the reorder').toEqual([3, 3, 4, 4])
      expect(h.stored, 'the answer stands for the value of its option, whatever the order').toMatchObject(ROWS_AFTER[profile])
    })
  }

  test(`Economy decides Stronger model itself: it stays and raises effort only, with no question, and the band says so once (${surface})`, { timeoutMs: 30000, options: inProfile('Economy').options }, async ($, on) => {
    const h = engine(on, { ...OPUS, stored: inProfile('Economy').stored })
    const d = drive($, h)
    await d.start(surface)
    h.rating = NEEDS_FABLE
    await d.submit(DEBUG)
    expect(h.asked, 'nothing is asked').toEqual([])
    expect(h.files[LOG_PATH] ?? '').toContain('Stronger model: no rule set, the Economy profile decides (stay, raise effort only)')
    expect(await bandText($, surface), 'every case of the prompt is named: the raise too').toMatch(/Your Economy profile decided \(Stronger model, Raising\); ⋯ changes it\.$/)
    expect(handedTo(h), 'stay: no hand-off').toBeUndefined()
    await d.submit(DEBUG)
    expect(h.asked, 'still nothing').toEqual([])
    expect(await bandText($, surface), 'said once per session').not.toContain('profile decided')
    expect(handedTo(h), 'still no hand-off').toBeUndefined()
    expect(h.store.choices, 'nothing saved').toBeUndefined()
  })

  test(`a case the profile decides is noted once per session on the band, with every case that came up in that prompt, and a rule you set is not asked or noted at all (${surface})`, { timeoutMs: 30000, options: inProfile('Balanced', { lowerRule: 'never lower' }).options }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: SEND, stored: inProfile('Balanced', { lowerRule: 'never lower' }).stored })
    const d = drive($, h)
    await d.start(surface)
    h.rating = LOWER
    await d.submit(LOOKUP)
    expect(h.asked, 'Lowering is yours').toEqual([])
    expect(await bandText($, surface), 'Lowering is the person\'s: the profile did not decide it').not.toContain('profile decided')
    h.rating = RAISE_HIGH
    await d.submit(DEBUG)
    expect(await bandText($, surface), 'Raising is decided by the profile: said').toMatch(/Your Balanced profile decided \(Raising\); ⋯ changes it\.$/)
    await d.submit(DEBUG)
    expect(h.asked, 'nothing is asked').toEqual([])
    expect(await bandText($, surface), 'once per session').not.toContain('profile decided')
    // A new session says it again.
    await d.start(surface)
    await d.submit(DEBUG)
    expect(await bandText($, surface)).toMatch(/Your Balanced profile decided \(Raising\)/)
  })

  // Quality needs 10 logged tasks of the kind before it lowers or hands down.
  const lowered12 = (h: { now: number }) =>
    Array.from({ length: 12 }, (_, i) => JSON.stringify({ at: new Date(h.now - (12 - i) * 60_000).toISOString(), kind: 'run', type: 'lookup', route: 'main', tier: 'opus', change: 'lower', steppedUp: false })).join('\n') + '\n'

  test(`Quality decides Lowering as ask: the Effort dialog still opens, and the band says the profile asked (${surface})`, { timeoutMs: 30000, options: inProfile('Quality').options }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES }, stored: inProfile('Quality').stored })
    h.files[RUNS] = lowered12(h)
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = LOWER
    h.answers = { Effort: 'Lower for this prompt' }
    await d.submit(LOOKUP)
    expect(h.asked.map(a => a.header), 'Lowering is ask under Quality: the Effort dialog').toEqual(['Effort'])
    expect(h.files[LOG_PATH] ?? '').toContain('Lowering: no rule set, the Quality profile decides (ask me)')
    expect(await bandText($, surface)).toMatch(/Your Quality profile decided \(Lowering\); ⋯ changes it\.$/)
    await d.step('t1')
    expect(last(h.sent)?.effort, 'answered Lower for this prompt').toBe('low')
    expect(h.store.choices, 'nothing saved').toBeUndefined()
  })

  test(`Quality decides Cheaper model as ask: the Subagent dialog still opens, and the band says the profile asked (${surface})`, { timeoutMs: 30000, options: inProfile('Quality').options }, async ($, on) => {
    const h = engine(on, { model: 'claude-fable-5-1', effort: 'high', store: { [CAL_STORE]: FREE_SWITCHES }, stored: inProfile('Quality').stored })
    h.files[RUNS] = haikuLog(h, 12)
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = HAIKU_SEARCH
    h.answers = { Subagent: 'Send it to a Haiku subagent' }
    await d.submit(SEARCH)
    expect(h.asked.map(a => a.header), 'Cheaper model is ask under Quality: the Subagent dialog').toEqual(['Subagent'])
    expect(h.files[LOG_PATH] ?? '').toContain('Cheaper model: no rule set, the Quality profile decides (ask first)')
    expect(handedTo(h), 'answered yes').toBe('haiku')
    expect(await bandText($, surface)).toMatch(/Your Quality profile decided \(Cheaper model\); ⋯ changes it\.$/)
  })

  const REVIEW_XHIGH = REVIEW.replace('"level":"high"', '"level":"xhigh"')

  for (const [profile, level] of [['Balanced', 'xhigh'], ['Economy', 'high']] as const) {
    test(`${profile}: a switched review rated for xhigh runs on Opus at ${level}${profile === 'Economy' ? ', the profile\'s cap' : ''} (${surface})`, { timeoutMs: 30000, options: inProfile(profile, { upRule: 'always send' }).options }, async ($, on) => {
      const h = engine(on, { model: 'claude-sonnet-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES }, stored: inProfile(profile, { upRule: 'always send' }).stored })
      const d = drive($, h)
      await d.start(surface)
      await d.step('t0')
      await d.complete('t0')
      h.rating = REVIEW_XHIGH
      await d.submit(DEBUG)
      await d.step('t1')
      expect(last(h.sent), 'the turn runs on Opus').toMatchObject({ model: 'opus', effort: level })
      await d.complete('t1')
    })
  }

  // Exploring close calls is off in every profile.
  for (const profile of PROFILE_NAMES) {
    test(`${profile}: close calls are not explored (${surface})`, { timeoutMs: 30000, options: inProfile(profile, profile === 'Quality' ? { missPause: '50%' } : {}).options }, async ($, on) => {
      const cal = { ...tieCal(0.9), ...FREE_SWITCHES }
      const h = engine(on, { model: 'claude-fable-5-1', effort: 'high', store: { ...SEND, [CAL_STORE]: cal, ties: 4 }, stored: inProfile(profile, profile === 'Quality' ? { missPause: '50%' } : {}).stored })
      const d = drive($, h)
      await d.start(surface)
      h.rating = TIE_RATING
      if (profile === 'Quality') await d.config('handOff', '90%')
      await d.submit(SEARCH)
      expect(handedTo(h), 'the fifth close call takes the guide\'s pick, not the other route').toBe('sonnet')
    })
  }

  test(`Explore close calls is off by default and a person who turns it on gets it (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    expect(SETTINGS.explore.default).toBe('off')
    const cal = { ...tieCal(0.9), ...FREE_SWITCHES }
    const h = engine(on, { model: 'claude-fable-5-1', effort: 'high', store: { [CAL_STORE]: cal, ties: 4 } })
    const d = drive($, h)
    await d.start(surface)
    h.rating = TIE_RATING
    h.answers = { Cheaper: 'Send it to a cheaper subagent (Recommended)', ...YES_REMEMBER }
    await d.submit(SEARCH)
    expect(handedTo(h), 'off: the guide').toBe('sonnet')
    await d.config('explore', 'on')
    h.store.ties = 4
    await d.submit(SEARCH)
    expect(handedTo(h), 'on: the other close route').toBe('opus')
  })

  // Switching the profile in /config takes effect at once, through applyOption, like any other row.
  test(`switching the profile in /config applies at once: hand-off threshold, spot-check, chances and questions (${surface})`, { timeoutMs: 30000, options: { rater: 'haiku' } }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES, spotChecks: 28 }, stored: { rater: 'haiku' } })
    h.files[RUNS] = haikuLog(h, 12)
    const d = drive($, h)
    h.now = Date.now()
    await d.start(surface)
    h.rating = NEAR
    h.answers = { Cheaper: 'Send it to a cheaper subagent (Recommended)', ...YES_REMEMBER }
    await d.submit(SEARCH)
    expect(handedTo(h), 'Balanced: 78% is over 70%').toBeUndefined()
    expect(h.completions.filter(m => m === 'sonnet'), 'Balanced: the 29th is not checked').toEqual([])

    const result = await d.config('profile', 'Economy')
    expect(result.deny).toBeUndefined()
    expect((await settingsText(d)).split('\n')[0]).toBe('Profile: Economy')
    await d.submit(SEARCH)
    expect(handedTo(h), 'Economy: 78% is under 85%').toBe('haiku')
    await flush()
    expect(h.completions.filter(m => m === 'sonnet').length, 'Economy checks every 30th: the 30th').toBe(1)

    await d.config('profile', 'Quality')
    expect((await settingsText(d)).split('\n')[0]).toBe('Profile: Quality')
    expect(await settingsText(d)).toContain('In use: hand-off threshold 50%, pause at 10% misses and 10 logged tasks, rater check every 10, 1 chance per task')
    // A row set after the switch wins over the new profile, and the others follow it.
    await d.config('handOff', '80%')
    expect(await settingsText(d)).toContain('In use: hand-off threshold 80%, pause at 10% misses and 10 logged tasks, rater check every 10, 1 chance per task')
    await d.config('profile', 'Balanced')
    expect(await settingsText(d), 'the row you set stays, the rest follow Balanced').toContain('In use: hand-off threshold 80%, pause at 20% misses, rater check every 20, 2 chances per task')
  })

  test(`a value another plugin writes to the Profile row does not make it yours, and one outside its options changes nothing (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS })
    const d = drive($, h)
    await d.start(surface)
    await d.config('profile', 'Economy', 'plugin')
    expect((await settingsText(d)).split('\n')[0], 'the value is the row\'s now').toBe('Profile: Economy')
    expect((await d.config('profile', 'Reckless')).deny, 'not an option').toBeDefined()
    expect((await settingsText(d)).split('\n')[0]).toBe('Profile: Economy')
  })

  test(`a row reset to its default goes back to the profile's value (${surface})`, { timeoutMs: 30000, options: inProfile('Economy', { handOff: '60%' }).options }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: SEND, stored: inProfile('Economy', { handOff: '60%' }).stored })
    const d = drive($, h)
    await d.start(surface)
    expect(await settingsText(d)).toContain('hand-off threshold 60%')
    h.answers = { Confirm: 'Yes' }
    await d.command('reset handOff')
    expect(await settingsText(d), 'Economy\'s 85% again').toContain('hand-off threshold 85%')
  })
}
