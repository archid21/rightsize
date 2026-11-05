import { type TestBody, expect, test } from 'claude-code/testing'
import { CAL_STORE } from './cost'
import { RUNS_FILE, SWITCHES_FILE, LOG_PATH, LEGACY_RUNS, LOOKUP, DEBUG, SEARCH, REVIEW, NO_CHANGE, FREE_SWITCHES, NO_COLD, BIG_TURN, cellsOf, engine, drive, flush, settle, untilAsked, last, mount, bandText, LOWER } from './testkit'

for (const surface of ['desktop', 'terminal'] as const) {
  test(`Q1 is the profile's: Balanced lowers on its own with no question, says so on the band once, steps up when the turn gets long, and retries at the original effort (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')

    h.rating = '{"level":"low","model":"same","size":"small","type":"lookup","read":2000,"write":3000,"steps":1,"reason":"one function lookup"}'
    await d.submit(LOOKUP)
    expect(h.asked, 'no Lowering question: the profile decides').toEqual([])
    expect(h.files[LOG_PATH] ?? '').toContain('Lowering: no rule set, the Balanced profile decides (lower automatically)')
    expect(await bandText($, surface), 'the band says who decided, once').toMatch(/^Effort lowered: medium → low for this prompt \(automatically\)\..* Your Balanced profile decided \(Lowering\); ⋯ changes it\.$/)
    await d.step('t1', 0)
    expect(last(h.sent)?.effort, 'runs low').toBe('low')
    await d.step('t1', 5)
    expect(last(h.sent)?.effort, 'back to medium on step 6').toBe('medium')
    await d.complete('t1')
    const stepped = ((h.files[RUNS_FILE] ?? '').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)).filter(r => r.steppedUp)
    expect(stepped, 'the 5-step rule alone: stepped up, but not a miss').toMatchObject([{ steppedUpBy: 'steps' }])
    expect(h.store.remember, 'nothing is saved: the profile decided').toBeUndefined()
    expect(h.store.choices, 'no rule is kept either').toBeUndefined()
    expect(h.asked, 'Remember follows only a rule the person set').toEqual([])

    // Same situation again: no question, lowered on its own, and the band does not say it again.
    await d.submit(LOOKUP)
    expect(h.asked.length, 'no new question').toBe(0)
    expect(await bandText($, surface), 'said once per session').not.toContain('profile decided')
    await d.step('t2')
    expect(last(h.sent)?.effort).toBe('low')
    await d.complete('t2')
    expect((h.files[LOG_PATH] ?? '').split('Lowering: no rule set').length - 1, 'the log has the line each time').toBe(2)

    // Retry puts the prompt back; sending it again runs it unrated at medium.
    const undo = await d.command('retry')
    expect(undo.text ?? '').toContain('run it at medium')
    expect(h.filled[0]).toBe(LOOKUP)
    const rated = h.ratings
    await d.submit(LOOKUP)
    expect(h.ratings, 'the re-run is not rated').toBe(rated)
    await d.step('t3')
    expect(last(h.sent)?.effort).toBe('medium')
    await d.complete('t3')

    // Each effort switch leaves one line of evidence: low, back to medium, low, medium.
    const switches = h.files[SWITCHES_FILE] ?? ''
    expect(Object.keys(h.files).every(k => k.startsWith('/home/test/.claude/mods-logs/')), 'logs go to HOME, wherever the plugin lives').toBe(true)
    const lines = switches.trim().split('\n').map(l => JSON.parse(l) as { from: string; to: string; kept: boolean })
    expect(lines.map(l => `${l.from}>${l.to}`)).toEqual(['medium>low', 'low>medium', 'medium>low', 'low>medium'])
    expect(lines.every(l => l.kept), 'the fake engine keeps the cache').toBe(true)

    // Calibration: t1 stepped back up and teaches nothing; t2 is stored.
    const cal = h.store[CAL_STORE] as Record<string, { n: number }>
    expect(cal['lookup:main']?.n, 'one measured lookup turn').toBe(1)
  })

  test(`Q2 is the profile's: Balanced raises effort with no question, and does not lower when the cache would cost more (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')

    h.rating = '{"level":"high","model":"same","type":"debug","read":20000,"write":3000,"steps":8,"reason":"unknown cause"}'
    await d.submit(DEBUG)
    expect(h.asked, 'no Raising question: the profile decides').toEqual([])
    expect(h.files[LOG_PATH] ?? '').toContain('Raising: no rule set, the Balanced profile decides (raise automatically)')
    expect(await bandText($, surface)).toMatch(/Your Balanced profile decided \(Raising\); ⋯ changes it\.$/)
    await d.step('t1')
    expect(last(h.sent)?.effort).toBe('high')
    await d.complete('t1')
    await settle()
    expect(h.store.remember, 'nothing was answered, so nothing is kept').toBeUndefined()
    expect(h.store.choices).toBeUndefined()
    expect(h.asked, 'no Remember question: no rule of the person\'s').toEqual([])

    // A lookup with the prior "switches miss the cache": not worth lowering, so nothing changes.
    h.rating = '{"level":"low","model":"same","type":"lookup","read":2000,"write":300,"steps":1}'
    await d.submit(LOOKUP)
    expect(h.asked.length, 'no question when nothing would change').toBe(0)
    await d.step('t2')
    expect(last(h.sent)?.effort).toBe('medium')
    await d.complete('t2')

    // A new session decides the same way, and says so again: nothing was kept from this one.
    await d.start(surface)
    await d.step('t3')
    await d.complete('t3')
    h.rating = '{"level":"xhigh","model":"same","type":"refactor"}'
    await d.submit(DEBUG)
    expect(h.asked.length).toBe(0)
    expect(await bandText($, surface), 'the band says it again in a new session').toMatch(/Your Balanced profile decided \(Raising\)/)
    await d.step('t4')
    expect(last(h.sent)?.effort).toBe('xhigh')
    await d.complete('t4')
  })

  test(`Q3 sends work that needs Fable to a Fable subagent and reports the cost (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')

    h.rating = '{"level":"high","model":"fable","size":"small","type":"debug","read":30000,"write":4000,"steps":12,"reason":"subtle concurrency bug"}'
    // Balanced would send it on its own: the person's rule row says ask first, and that is the one question left.
    await d.config('upRule', 'ask first')
    h.answers = { Subagent: 'Send it to a Fable subagent' }
    await d.submit(DEBUG)
    expect(h.asked.map(a => a.header), 'only the Subagent question: the rule is already the person\'s').toEqual(['Subagent'])
    expect(h.asked[0]?.question ?? '', 'the question carries both costs').toMatch(/About \$[\d.]+ that way vs \$[\d.]+ staying on Opus/)
    const note = last(h.submitted)?.context?.join('\n') ?? ''
    expect(note).toContain('[rightsize]')
    expect(note).toContain('model "fable", effort "high"')
    expect(note).toContain('Done means')
    expect(note).toContain('At most 2 rework rounds')
    expect(last(h.submitted)?.text, 'the prompt itself is unchanged').toBe(DEBUG)

    h.subModel = 'claude-fable-5-1'
    await d.step('t1', 0)
    await d.agent('fable')
    await d.step('t1', 0, 'a1')
    await d.step('t1', 1, 'a1')
    await d.step('t1', 1)
    await d.complete('t1')
    expect(h.sent.filter(s => s.turnId === 't1' && !s.agentId).every(s => s.effort === 'medium'), 'main chat effort untouched').toBe(true)
    expect(await bandText($, surface), 'the band carries the result').toMatch(/^Sent to Fable\. \$[\d.]+ vs ~\$[\d.]+ on Opus \(~[\d.]+(%|x)/)
    const cal = h.store[CAL_STORE] as Record<string, { n: number }>
    expect(cal['debug:delegate']?.n).toBe(1)
  })

  test(`a review in a Sonnet session runs its turn on Opus at high, then goes back (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-sonnet-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')

    h.rating = REVIEW
    await d.submit(DEBUG)
    expect(h.asked, 'no Stronger question: the Balanced profile switches on its own').toEqual([])
    expect(h.files[LOG_PATH] ?? '').toContain('Stronger model: no rule set, the Balanced profile decides (always send)')
    expect(h.submitted.at(-1)?.context ?? [], 'no subagent note').toEqual([])
    await d.step('t1', 0)
    await d.step('t1', 1)
    const turn = h.sent.filter(s => s.turnId === 't1')
    expect(turn.map(s => s.model), 'every step on Opus').toEqual(['opus', 'opus'])
    expect(turn.map(s => s.effort), 'at high').toEqual(['high', 'high'])
    await d.complete('t1')
    expect(await bandText($, surface)).toMatch(/^Running this review on Opus at high effort, then back to Sonnet\. \$[\d.]+ vs ~\$[\d.]+ on Sonnet\..* Your Balanced profile decided \(Stronger model\); ⋯ changes it\.$/)

    // The next prompt goes back to the session's model and level.
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    await d.step('t2')
    await d.complete('t2')
    expect(last(h.sent)?.model, 'back on the session model').toBe('claude-sonnet-5-5')
    expect(last(h.sent)?.effort).toBe('medium')

    // The switch is not an effort switch: nothing measured, nothing logged, and the session stays Sonnet.
    const cal = h.store[CAL_STORE] as Record<string, { n: number }>
    expect(cal['cache:effort-switch']?.n, 'no switch measured').toBe(20)
    expect(h.files[SWITCHES_FILE], 'no switch line').toBeUndefined()
    expect(cal['review:main:opus:high']?.n, "the switched tier's key is taught").toBe(1)
    expect(cal['review:main:sonnet:high'], "Sonnet's key is not taught Opus costs").toBeUndefined()
    const runs = (h.files[RUNS_FILE] ?? '').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
    const run = runs.find(l => l.type === 'review')
    expect(run).toMatchObject({ rule: 'review', switched: 'opus', switchedLevel: 'high', change: 'switch-up', offered: 'switch-up', route: 'main', tier: 'sonnet' })
    expect(runs.find(l => l.type === 'lookup')).toMatchObject({ change: 'none', tier: 'sonnet' })
  })

  const rated = (type: string, continues: boolean) => `{"fit":{"haiku":"no","sonnet":"medium","opus":"medium","fable":"medium"},"type":"${type}","read":8000,"write":1200,"steps":5,"continues":${continues},"reason":"rated"}`
  const readRuns = (h: ReturnType<typeof engine>) => (h.files[RUNS_FILE] ?? '').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
  const FOLLOW_UP = 'yes that looks right so go ahead and put it in parentheses'

  test(`a follow-up keeps its task's type: a continuing prompt typed review in a feature task plans as feature, a new goal typed review switches (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-sonnet-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')

    h.rating = rated('feature', false)
    await d.submit(DEBUG)
    await d.step('t1')
    await d.complete('t1')
    expect(last(h.sent)?.model, 'a feature stays on Sonnet').toBe('claude-sonnet-5-5')

    // The one-line follow-up is typed review, but it continues the feature task.
    h.rating = rated('review', true)
    await d.submit(FOLLOW_UP)
    await d.step('t2')
    await d.complete('t2')
    expect(last(h.sent)?.model, 'no switch to Opus for the follow-up').toBe('claude-sonnet-5-5')
    expect(h.asked.map(a => a.header), 'and no Stronger-model question').toEqual([])
    expect(h.files[LOG_PATH] ?? '', 'the log names both types').toContain('feature (rated review, continues the feature task) on sonnet/medium')

    // A new goal typed review is a review: it switches.
    h.rating = rated('review', false)
    await d.submit('now review the whole auth module for subtle bugs please')
    await d.step('t3')
    expect(last(h.sent)?.model, 'a review of its own').toBe('opus')
    await d.complete('t3')

    const runs = readRuns(h)
    expect(runs.map(r => [r.type, r.continues, r.ratedType ?? null, r.switched ?? null])).toEqual([
      ['feature', false, null, null],
      ['feature', true, 'review', null],
      ['review', false, null, 'opus'],
    ])
    // One task id from the brief to its follow-up, the id of the run that started it; a new goal starts a task of its own.
    expect(runs.map(r => r.task), 'task ids').toEqual([runs[0]?.id, runs[0]?.id, runs[2]?.id])
    expect(runs[2]?.id).not.toBe(runs[0]?.id)
  })

  test(`a continuing prompt in a review task that the rater typed as something else is planned as that, with no review switch; one typed review is still a review (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-sonnet-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')

    // The session has kept no task yet: "continues" has nothing to continue, so the rated type stands and becomes the task.
    h.rating = rated('review', true)
    await d.submit(DEBUG)
    await d.step('t1')
    expect(last(h.sent)?.model, 'a review').toBe('opus')
    await d.complete('t1')

    // A follow-up typed review carries on the review: it gets the review rule.
    h.rating = rated('review', true)
    await d.submit(FOLLOW_UP)
    await d.step('t2')
    expect(last(h.sent)?.model, 'the review rule holds for a follow-up that is a review').toBe('opus')
    await d.complete('t2')

    // A follow-up typed lookup is a lookup: planned as that, with no switch to Opus, and the log says why.
    h.rating = rated('lookup', true)
    await d.submit(FOLLOW_UP)
    await d.step('t3')
    expect(last(h.sent)?.model, 'no review switch for a lookup in a review task').toBe('claude-sonnet-5-5')
    await d.complete('t3')
    expect(h.files[LOG_PATH] ?? '').toContain('the prompt continues a review task but is a lookup: planned as that, no review switch')

    // A new goal ends the task.
    h.rating = rated('lookup', false)
    await d.submit(LOOKUP)
    await d.step('t4')
    expect(last(h.sent)?.model).toBe('claude-sonnet-5-5')
    await d.complete('t4')
    const runs = readRuns(h)
    expect(runs.map(r => [r.type, r.ratedType ?? null, r.switched ?? null]), 'a lookup in a review task is a lookup of its own: no retyping, no switch').toEqual([
      ['review', null, 'opus'],
      ['review', null, 'opus'],
      ['lookup', null, null],
      ['lookup', null, null],
    ])
    expect(runs.map(r => r.task), 'the follow-ups stay in the review task').toEqual([runs[0]?.id, runs[0]?.id, runs[0]?.id, runs[3]?.id])
  })

  test(`a review in a Sonnet session stays on Sonnet when Stronger model is Stay (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-sonnet-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')

    h.rating = REVIEW
    await d.config('upRule', 'stay, raise effort only')
    await d.submit(DEBUG)
    expect(h.asked, 'the rule is the person\'s: no question').toEqual([])
    await d.step('t1')
    await d.complete('t1')
    expect(last(h.sent)?.model, 'no model rewrite').toBe('claude-sonnet-5-5')
    const runs = (h.files[RUNS_FILE] ?? '').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
    expect(runs.find(l => l.type === 'review')?.switched).toBeUndefined()
  })

  test(`asking: a review's question offers Opus or staying, and Opus runs the turn (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-sonnet-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES, remember: true, choices: { up: 'ask' } } })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')

    h.rating = REVIEW
    h.answers = { Stronger: 'Run it on Opus' }
    await d.submit(DEBUG)
    expect(h.asked.map(a => a.header)).toEqual(['Stronger'])
    expect(h.asked[0]?.question ?? '').toContain('This is a review: reviews run on Opus at high effort or more. Run this prompt on Opus at high, then go back to Sonnet?')
    expect(h.asked[0]?.options).toEqual(['Run it on Opus', 'Stay on Sonnet'])
    await d.step('t1')
    expect(last(h.sent)).toMatchObject({ model: 'opus', effort: 'high' })
  })

  test(`Q4 hands a big search on Fable down to Haiku, and says so when Claude does not (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-fable-5-1', effort: 'high' })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')

    h.rating = '{"level":"low","model":"haiku","size":"bulky","type":"search","read":150000,"write":3000,"steps":30,"reason":"repo-wide search"}'
    await d.submit(SEARCH)
    expect(h.asked, 'no Cheaper question: the Balanced profile sends it on its own').toEqual([])
    expect(h.files[LOG_PATH] ?? '').toContain('Cheaper model: no rule set, the Balanced profile decides (always send)')
    expect(await bandText($, surface)).toMatch(/Your Balanced profile decided \(Cheaper model\); ⋯ changes it\.$/)
    const note = last(h.submitted)?.context?.join('\n') ?? ''
    expect(note).toContain('model "haiku"')
    expect(note).toContain('finish the task yourself')

    expect(note, 'the subagent stops before steps only the person can approve').toContain('only the person can approve')

    // Claude answered without the subagent: the report says so.
    await d.step('t1')
    await d.complete('t1')
    expect(await bandText($, surface)).toContain('did not hand this to a Haiku subagent')

    // Next time: no question, and the subagent's cost is counted.
    await d.submit(SEARCH)
    expect(h.asked.length, 'still no question').toBe(0)
    await d.step('t2', 0)
    await d.agent('haiku')
    await d.step('t2', 0, 'a2')
    await d.step('t2', 1)
    await d.complete('t2')
    expect(await bandText($, surface)).toMatch(/^Sent to Haiku\. \$[\d.]+ vs ~\$[\d.]+ on Fable \(~\d+% saved\)\.?/)
  })

  test(`a hand-off kept in the main chat for a push is not counted as skipped (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-fable-5-1', effort: 'high' })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')

    h.rating = '{"level":"low","model":"haiku","size":"bulky","type":"search","read":150000,"write":3000,"steps":30,"reason":"repo-wide search"}'
    await d.submit(SEARCH)
    await d.step('t1')
    await d.bash('denied git push')
    await d.bash('git push origin main')
    await d.complete('t1')
    expect(await bandText($, surface)).toContain('kept this in the main chat for steps only you can approve')
    const runs = (h.files[RUNS_FILE] ?? '').trim().split('\n').map(l => JSON.parse(l) as { approvalSteps?: number })
    expect(runs.at(-1)?.approvalSteps, 'the refused push does not count').toBe(1)
  })

  test(`the hand-off's subagent cannot push; other subagents and the main chat can (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')

    h.rating = '{"fit":{"haiku":"high","sonnet":"high","opus":"high","fable":"medium"},"type":"feature","read":20000,"write":2000,"steps":6,"reason":"small helper with tests"}'
    await d.submit(DEBUG)
    h.subModel = 'claude-haiku-5-5'
    await d.step('t1', 0)
    await d.agent('claude-haiku-5-5')
    await d.spawn('helper', 'claude-haiku-5-5')
    await d.step('t1', 0, 'agent-helper')
    const blocked = (await d.bash('git -C . push origin main', 'agent-helper')) as { deny?: string }
    expect(blocked.deny, "the hand-off's subagent is stopped").toContain('main chat does it')
    const tests = (await d.bash('npm test', 'agent-helper')) as { deny?: string }
    expect(tests.deny, 'other work goes on').toBeUndefined()
    const other = (await d.bash('git push origin main', 'agent-explore')) as { deny?: string }
    expect(other.deny, 'a subagent rightsize did not start is left alone').toBeUndefined()
    const main = (await d.bash('git push origin main')) as { deny?: string }
    expect(main.deny, 'the main chat pushes').toBeUndefined()
    await d.step('t1', 1)
    await d.complete('t1')
  })

  test(`a request that is mainly an approval step is not handed off (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-fable-5-1', effort: 'high' })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')

    h.rating = '{"fit":{"haiku":"low","sonnet":"low","opus":"low","fable":"low"},"type":"other","read":150000,"write":3000,"steps":30,"approval":true,"reason":"push and release"}'
    await d.submit(SEARCH)
    expect(h.asked.map(a => a.header).includes('Cheaper'), 'no hand-off question').toBe(false)
    expect(last(h.submitted)?.context?.join('\n') ?? '', 'no hand-off note').not.toContain('subagent')
  })

  test(`counts a hand-off whose Agent call names the full model id (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')

    h.rating = '{"fit":{"haiku":"high","sonnet":"high","opus":"high","fable":"medium"},"size":"small","type":"feature","read":20000,"write":2000,"steps":6,"reason":"small helper with tests"}'
    await d.submit(DEBUG)
    h.subModel = 'claude-haiku-5-5'
    await d.step('t1', 0)
    await d.agent('claude-haiku-5-5')
    await d.spawn('helper', 'claude-haiku-5-5')
    await d.step('t1', 0, 'agent-helper')
    await d.step('t1', 1)
    await d.complete('t1')
    expect(h.sent.find(s => s.agentId === 'agent-helper')?.effort).toBe('high')
    const runs = (h.files[RUNS_FILE] ?? '').trim().split('\n')
    expect((JSON.parse(last(runs) ?? '{}') as { route?: string }).route).toBe('delegate:haiku')
  })

  test(`the hand-off subagent's first step, before its spawn settles, already runs at the hand-off's level (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = '{"fit":{"haiku":"high","sonnet":"high","opus":"high","fable":"medium"},"type":"feature","read":20000,"write":2000,"steps":6,"reason":"small helper with tests"}'
    await d.submit(DEBUG)
    await d.step('t1', 0)
    await d.agent('haiku')
    let release = () => {}
    h.spawnHold = new Promise<void>(r => (release = r))
    const spawning = d.spawn('helper', 'haiku')
    while (!h.spawned.length) await flush()
    // An Explore agent the engine starts meanwhile is not the hand-off's.
    h.agents.push({ id: 'agent-other', description: 'other', type: 'Explore', status: 'running' })
    await d.step('t1', 0, 'agent-other')
    expect(last(h.sent)?.effort).toBe('medium')
    await d.step('t1', 0, 'agent-helper')
    expect(last(h.sent)?.effort).toBe('high')
    release()
    await spawning
    await d.step('t1', 1)
    await d.complete('t1')
    expect(h.spawned.map(x => x.model), 'the named model is left as Claude named it').toEqual(['haiku'])
  })

  test(`on Opus at medium, hands work Haiku can do at high to Haiku at high, and runs it there (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')

    h.rating = '{"fit":{"haiku":"high","sonnet":"high","opus":"high","fable":"medium"},"size":"small","type":"feature","read":20000,"write":2000,"steps":6,"reason":"small helper with tests"}'
    await d.submit(DEBUG)
    expect(h.asked, 'no question: Cheaper model is the profile\'s, and it is the one that decided, not Raising').toEqual([])
    expect(h.files[LOG_PATH] ?? '', 'Q4, not Q2: a cheaper model, not more effort').toContain('Cheaper model: no rule set, the Balanced profile decides')
    expect(h.files[LOG_PATH] ?? '').not.toContain('Raising: no rule set')
    const note = last(h.submitted)?.context?.join('\n') ?? ''
    expect(note).toContain('model "haiku", effort "high"')
    expect(await bandText($, surface)).toMatch(/^Sending this to a Haiku subagent at high effort instead of raising Opus to high\. \$[\d.]+ vs ~\$[\d.]+ on Opus\./)

    h.subModel = 'claude-haiku-5-5'
    await d.step('t1', 0)
    await d.agent('haiku')
    await d.spawn('helper', 'haiku')
    await d.spawn('explore', 'opus')
    await d.step('t1', 0, 'agent-helper')
    await d.step('t1', 1, 'agent-helper')
    await d.step('t1', 0, 'agent-explore')
    await d.step('t1', 1)
    await d.complete('t1')
    const sent = h.sent.filter(s => s.turnId === 't1')
    expect(sent.filter(s => s.agentId === 'agent-helper').map(s => s.effort), "the hand-off's subagent runs at high").toEqual(['high', 'high'])
    expect(sent.find(s => s.agentId === 'agent-explore')?.effort, 'another subagent keeps its own level').toBe('medium')
    expect(sent.filter(s => !s.agentId).every(s => s.effort === 'medium'), 'the main chat stays at medium').toBe(true)

    // It learns for the task type, for Haiku, and for Haiku at high.
    const cal = h.store[CAL_STORE] as Record<string, { n: number }>
    expect(['feature:delegate', 'feature:delegate:haiku', 'feature:delegate:haiku:high'].map(k => cal[k]?.n)).toEqual([1, 1, 1])
    const runs = (h.files[RUNS_FILE] ?? '').trim().split('\n')
    const line = JSON.parse(last(runs) ?? '{}') as { route?: string; subLevel?: string; fit?: unknown; read?: number; write?: number; steps?: number }
    expect(line.route).toBe('delegate:haiku')
    expect(line.subLevel).toBe('high')
    expect(line.fit).toEqual({ haiku: 'high', sonnet: 'high', opus: 'high', fable: 'medium' })
    expect([line.read, line.write, line.steps], "the rater's token guesses").toEqual([20000, 2000, 6])
    expect((await d.command('status')).text ?? '', 'the run count counts the run once').toContain('Measured runs: 1')
  })

  test(`runs a subagent Claude starts on its own on the cheapest model that fits, at that model's level (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')

    h.rating = NO_CHANGE
    await d.submit(SEARCH)
    await d.step('t1', 0)
    // The brief is rated: Haiku at low does a file listing.
    h.rating = '{"fit":{"haiku":"low","sonnet":"low","opus":"low","fable":"low"},"size":"small","type":"search","read":8000,"write":500,"steps":5,"reason":"list call sites"}'
    await d.spawn('lister')
    // Left alone: a model named, another type (it may set its own), a fork, a nested spawn, a workflow agent.
    await d.spawn('named', 'opus')
    await d.spawn('explorer', undefined, { subagentType: 'Explore' })
    await d.spawn('forked', undefined, { fork: true })
    await d.spawn('nested', undefined, { parentAgentId: 'agent-lister' })
    await d.spawn('wf', undefined, { workflow: { runId: 'wf_1', agentIndex: 1 } })
    expect(h.spawned.map(x => [x.description, x.model ?? null])).toEqual([
      ['lister', 'haiku'],
      ['named', 'opus'],
      ['explorer', null],
      ['forked', null],
      ['nested', null],
      ['wf', null],
    ])
    await d.step('t1', 0, 'agent-lister')
    await d.step('t1', 1, 'agent-lister')
    await d.step('t1', 0, 'agent-named')
    await d.step('t1', 1)
    await d.complete('t1')
    const sent = h.sent.filter(s => s.turnId === 't1')
    expect(sent.filter(s => s.agentId === 'agent-lister').map(s => s.effort), 'the moved subagent runs at Haiku\'s level').toEqual(['low', 'low'])
    expect(sent.find(s => s.agentId === 'agent-named')?.effort, 'a subagent left alone keeps its level').toBe('medium')
    expect(await bandText($, surface)).toBe("Ran Claude's subagent on Haiku (low) instead of Opus.")
    const runs = (h.files[RUNS_FILE] ?? '').trim().split('\n')
    const line = JSON.parse(last(runs) ?? '{}') as { route?: string; resized?: unknown }
    expect(line.route, 'not a hand-off').toBe('main')
    expect(line.resized).toEqual([{ from: 'opus', tier: 'haiku', level: 'low', type: 'search' }])

    // A later turn's step of the same subagent (a background one) still runs at its level.
    await d.submit(LOOKUP)
    await d.step('t2', 0)
    await d.step('t2', 0, 'agent-lister')
    expect(last(h.sent)?.effort).toBe('low')
  })

  const LISTING = '{"fit":{"haiku":"low","sonnet":"low","opus":"low","fable":"low"},"type":"search","read":8000,"write":500,"steps":5,"reason":"list call sites"}'
  // Two steps of the fake subagent on Haiku, at the fake usage: (200 x 0.1 + 400 x 0.5 + 20,000 x 0.01 + 300 x 0.2) / 1M each.
  const TWO_HAIKU_STEPS = 0.00096

  test(`measures a moved subagent when it answers, teaches its model and level, and logs it (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    h.rating = NO_CHANGE
    await d.submit(SEARCH)
    await d.step('t1', 0)
    h.rating = LISTING
    await d.spawn('lister')
    await d.step('t1', 1)
    await d.complete('t1')
    // A background subagent: it works and answers after the turn ended.
    await d.step('l1', 0, 'agent-lister')
    await d.step('l1', 1, 'agent-lister')
    await d.answer('agent-lister')
    const runs = (h.files[RUNS_FILE] ?? '').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
    const sub = runs.filter(l => l.kind === 'subagent')
    expect(sub.length).toBe(1)
    expect([sub[0]?.from, sub[0]?.tier, sub[0]?.level, sub[0]?.type, sub[0]?.aborted]).toEqual(['opus', 'haiku', 'low', 'search', false])
    expect(Math.abs(Number(sub[0]?.actual) - TWO_HAIKU_STEPS) < 1e-6).toBe(true)
    // The subagent line names the run whose turn started it, and that run's task.
    const started = runs.find(l => l.kind === 'run')
    expect([sub[0]?.run, sub[0]?.task], 'tied to its run and task').toEqual([started?.id, started?.task])
    expect(Number(sub[0]?.parentEstimate) > Number(sub[0]?.estimate) * 10, 'the same work on Opus').toBe(true)
    const cal = h.store[CAL_STORE] as Record<string, { n: number }>
    expect(['search:subagent', 'search:subagent:haiku', 'search:subagent:haiku:low'].map(k => cal[k]?.n)).toEqual([1, 1, 1])

    // Resumed later and stopped: logged, nothing taught.
    await d.step('l2', 0, 'agent-lister')
    await d.answer('agent-lister', true)
    const again = (h.files[RUNS_FILE] ?? '').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
    expect(again.filter(l => l.kind === 'subagent').map(l => l.aborted)).toEqual([false, true])
    expect(Math.abs(Number(last(again)?.actual) - TWO_HAIKU_STEPS / 2) < 1e-6, 'only what it spent since it answered').toBe(true)
    expect((h.store[CAL_STORE] as Record<string, { n: number }>)['search:subagent']?.n).toBe(1)
    h.now = Date.now()
    expect(cellsOf((await d.command('report')).text ?? '', 'Subagents on cheaper model')?.at(-1)).toBe('2')
  })

  test(`a moved subagent's first step, before its spawn settles, already runs at its level (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    h.rating = NO_CHANGE
    await d.submit(SEARCH)
    await d.step('t1', 0)
    h.rating = LISTING
    let release = () => {}
    h.spawnHold = new Promise<void>(r => (release = r))
    const spawning = d.spawn('lister')
    while (!h.spawned.length) await flush()
    // A subagent's own subagent, of the same description and type, is not the one being spawned.
    h.agents.push({ id: 'agent-nested', description: 'lister', type: 'general-purpose', status: 'running', parentId: 'agent-x' })
    await d.step('n1', 0, 'agent-nested')
    expect(last(h.sent)?.effort).toBe('medium')
    await d.step('l1', 0, 'agent-lister')
    expect(last(h.sent)?.effort, 'matched to its spawn by what the agent list shows').toBe('low')
    release()
    await spawning
    await d.step('l1', 1, 'agent-lister')
    expect(last(h.sent)?.effort).toBe('low')
    await d.answer('agent-lister')
    const runs = (h.files[RUNS_FILE] ?? '').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
    expect(Math.abs(Number(runs.find(l => l.kind === 'subagent')?.actual) - TWO_HAIKU_STEPS) < 1e-6, 'both steps counted once').toBe(true)
  })

  test(`keeps Claude's subagent on its model when no cheaper one fits (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    h.rating = NO_CHANGE
    await d.submit(DEBUG)
    await d.step('t1', 0)
    h.rating = '{"fit":{"haiku":"no","sonnet":"no","opus":"high","fable":"medium"},"size":"small","type":"debug","read":8000,"write":500,"steps":5,"reason":"subtle race"}'
    await d.spawn('debugger')
    await d.step('t1', 0, 'agent-debugger')
    expect(h.spawned[0]?.model, 'never a stronger model either').toBeUndefined()
    expect(last(h.sent)?.effort).toBe('medium')
  })

  test(`leaves Claude's subagents alone when "Claude's subagents" is off in /config (${surface})`, { timeoutMs: 30000, options: { subagents: 'off' } }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    h.rating = '{"fit":{"haiku":"low","sonnet":"low","opus":"low","fable":"low"},"size":"small","type":"search","read":8000,"write":500,"steps":5,"reason":"list"}'
    const before = h.ratings
    await d.spawn('lister')
    expect(h.spawned[0]?.model).toBeUndefined()
    expect(h.ratings, 'no rating call either').toBe(before)
  })

  // Hands off to Haiku at 78% of staying: over the 70% default, under the 85% a hot pace allows.
  const NEAR = '{"fit":{"haiku":"medium","sonnet":"medium","opus":"medium","fable":"medium"},"size":"small","type":"search","read":20000,"write":1000,"steps":14,"reason":"list call sites"}'
  const HOUR = 3600_000
  const at = (h: { now: number }, ms: number) => new Date(h.now + ms).toISOString()

  test(`budget pacing: a window running hot hands off what the default threshold keeps (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    // 80% used with 3 of 5 hours gone; the 7-day window is too new to say anything.
    h.rateLimits = [
      { kind: 'five_hour', percentUsed: 80, resetsAt: at(h, 2 * HOUR) },
      { kind: 'seven_day', percentUsed: 20, resetsAt: at(h, 160 * HOUR) },
    ]
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = NEAR
    await d.submit(SEARCH)
    expect(last(h.submitted)?.context?.join('\n') ?? '').toContain('model "haiku"')
    expect(await bandText($, surface)).toContain('The 5-hour window is on pace to run out before it resets, so rightsize saves harder.')
    await d.step('t1')
    await d.complete('t1')
    const runs = (h.files[RUNS_FILE] ?? '').trim().split('\n')
    expect((JSON.parse(last(runs) ?? '{}') as { pace?: unknown }).pace).toEqual({ mode: 'hot', window: 'five_hour', pace: 1.33, used: 80 })
    expect((await d.command('status')).text ?? '').toContain('The 5-hour window')
  })

  test(`budget pacing off in /config: the same window changes nothing (${surface})`, { timeoutMs: 30000, options: { pacing: 'off' } }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES }, stored: { pacing: 'off' } })
    const d = drive($, h)
    h.rateLimits = [{ kind: 'five_hour', percentUsed: 80, resetsAt: at(h, 2 * HOUR) }]
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = NEAR
    await d.submit(SEARCH)
    expect(last(h.submitted)?.context ?? []).toEqual([])
    expect(h.asked.length).toBe(0)
    expect((await d.command('status')).text ?? '').toContain('Budget pacing: off')
  })

  test(`budget pacing: a window nearly used up skips a raise and says why (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    h.rateLimits = [{ kind: 'five_hour', percentUsed: 93, resetsAt: at(h, 4 * HOUR) }]
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = '{"fit":{"haiku":"no","sonnet":"no","opus":"high","fable":"medium"},"size":"small","type":"debug","read":8000,"write":800,"steps":6,"reason":"race"}'
    await d.submit(DEBUG)
    expect(h.asked.length, 'no raise to ask about').toBe(0)
    await d.step('t1')
    expect(last(h.sent)?.effort).toBe('medium')
    expect(await bandText($, surface)).toBe('Kept medium on Opus instead of raising to high. 93% of the 5-hour window is used, so rightsize saves all it can. (hand-off bar 70% → 95%, lowering bar 90% → 100%)')
  })

  test(`budget pacing: with Reports set to the API, the band shows no window share (${surface})`, { timeoutMs: 30000, options: { billing: 'api' } }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', stored: { billing: 'api' } })
    const d = drive($, h)
    h.rateLimits = [{ kind: 'five_hour', percentUsed: 93, resetsAt: at(h, 4 * HOUR) }]
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = '{"fit":{"haiku":"no","sonnet":"no","opus":"high","fable":"medium"},"size":"small","type":"debug","read":8000,"write":800,"steps":6,"reason":"race"}'
    await d.submit(DEBUG)
    await d.step('t1')
    expect(last(h.sent)?.effort, 'the decision still follows the window').toBe('medium')
    expect(await bandText($, surface)).not.toMatch(/window|%/)
  })

  test(`budget pacing: when much of a window will go unused, "Ask" still asks (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    // 30% of the week used, 6 hours before it resets.
    h.rateLimits = [{ kind: 'seven_day', percentUsed: 30, resetsAt: at(h, 6 * HOUR) }]
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = '{"fit":{"haiku":"no","sonnet":"no","opus":"high","fable":"medium"},"size":"small","type":"debug","read":8000,"write":800,"steps":6,"reason":"race"}'
    await d.config('raiseRule', 'ask me')
    h.answers = { Effort: 'Keep medium' }
    await d.submit(DEBUG)
    expect(h.asked.map(a => a.header), 'the Raising rule is the person\'s and says ask, so it asks, as it always does').toEqual(['Effort'])
    await d.step('t1')
    expect(last(h.sent)?.effort, 'kept: "Ask" never raises on its own').toBe('medium')
    expect(last(h.asked)?.question ?? '', 'the question names the raise').toContain('Raise from medium to high?')
  })

  const AUTO_RAISE = { remember: true, choices: { raise: 'auto' } }

  test(`raises effort mid-turn when Claude looks stuck, once per sign, at most twice (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: AUTO_RAISE })
    const d = drive($, h)
    await d.start(surface)
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    await d.step('t1', 0)
    await d.bash('fail npm test')
    await d.step('t1', 1)
    expect(last(h.sent)?.effort, 'one failure is ordinary').toBe('medium')
    await d.bash('fail npm test')
    await d.step('t1', 2)
    expect(last(h.sent)?.effort).toBe('high')
    expect(await bandText($, surface)).toBe('Effort raised mid-turn: medium → high (the same tool call failed twice).')
    await d.step('t1', 3)
    expect(last(h.sent)?.effort, 'for the rest of the turn').toBe('high')
    await d.bash('fail lint')
    await d.step('t1', 4)
    expect(last(h.sent)?.effort, 'three failures: a second sign').toBe('xhigh')
    for (let i = 0; i < 3; i++) await d.bash('ls')
    await d.step('t1', 5)
    expect(last(h.sent)?.effort, 'two raises a turn at most').toBe('xhigh')
    expect(h.asked.length, 'automatic: nothing asked').toBe(0)
    await d.complete('t1')

    const runs = (h.files[RUNS_FILE] ?? '').trim().split('\n')
    const line = JSON.parse(last(runs) ?? '{}') as { escalations?: { step: number; from: string; to: string }[] }
    expect(line.escalations?.map(x => [x.step, x.from, x.to])).toEqual([[2, 'medium', 'high'], [4, 'high', 'xhigh']])
    expect(Object.keys(h.store[CAL_STORE] ?? {}).filter(k => k.startsWith('lookup:')), 'a turn at two levels teaches nothing').toEqual([])
    h.now = Date.now()
    const stuck = (await d.command('report')).text ?? ''
    expect(stuck).toMatch(/1 turn +raised mid-turn because Claude looked stuck/)
    expect(stuck).toContain('the same tool call failed twice (1), several tool calls failed (1)')

    // The next turn starts at the person's level again.
    await d.submit(LOOKUP)
    await d.step('t2', 0)
    expect(last(h.sent)?.effort).toBe('medium')
  })

  test(`Raising left unset follows the profile: Balanced raises a stuck main chat without a question, and says so in the log (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    await d.step('t1', 0)
    await d.bash('fail make')
    await d.bash('fail make')
    await d.step('t1', 1)
    await d.step('t1', 2)
    expect(h.asked, 'no question: the profile\'s Raising answer is auto').toEqual([])
    expect(last(h.sent)?.effort, 'raised from the next request').toBe('high')
    expect(h.files[LOG_PATH] ?? '').toContain('raised mid-turn medium → high at step')
    expect(await bandText($, surface)).toBe('Effort raised mid-turn: medium → high (the same tool call failed twice).')
  })

  test(`asks before a mid-turn raise unless Raising is automatic, and does not ask twice for one sign (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    // Raising set to ask: the profile's own answer (auto) would raise without a question.
    await d.config('raiseRule', 'ask me')
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    await d.step('t1', 0)
    await d.bash('fail make')
    await d.bash('fail make')
    h.answers = { Stuck: 'Keep medium' }
    await d.step('t1', 1)
    expect(h.asked.map(a => a.question)).toEqual(['Claude looks stuck: the same tool call failed twice. Raise effort from medium to high for the rest of this turn? No answer: the turn goes on at medium.'])
    await settle()
    await d.step('t1', 2)
    expect(last(h.sent)?.effort).toBe('medium')
    expect(h.asked.length, 'the same sign is not asked again').toBe(1)
    await d.bash('fail make test')
    h.answers = { Stuck: 'Raise to high for this turn' }
    await d.step('t1', 3)
    await settle()
    await d.step('t1', 4)
    expect(last(h.sent)?.effort, 'a new sign, and a yes: from the next request').toBe('high')
  })

  test(`no mid-turn raise when Raising is never (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { remember: true, choices: { raise: 'never' } } })
    const d = drive($, h)
    await d.start(surface)
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    await d.step('t1', 0)
    for (let i = 0; i < 3; i++) await d.bash('fail x')
    await d.step('t1', 1)
    expect([last(h.sent)?.effort, h.asked.length]).toEqual(['medium', 0])
  })

  test(`refused calls are not a sign of struggling (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: AUTO_RAISE })
    const d = drive($, h)
    await d.start(surface)
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    await d.step('t1', 0)
    for (let i = 0; i < 3; i++) await d.bash('denied clean build')
    await d.step('t1', 1)
    expect(last(h.sent)?.effort, 'refused by a hook').toBe('medium')
    for (let i = 0; i < 3; i++) await d.bash('rejected clean build')
    await d.step('t1', 2)
    expect(last(h.sent)?.effort, 'refused by the person at the prompt').toBe('medium')
    expect(h.asked.length).toBe(0)
  })

  test(`blocked errors (sandbox, network, missing program) do not raise effort, however often they repeat (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: AUTO_RAISE })
    const d = drive($, h)
    await d.start(surface)
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    await d.step('t1', 0)
    // The same blocked call three times (a repeat failure and a loop for any other error), then three different ones.
    for (let i = 0; i < 3; i++) await d.bash('env:fatal: unable to access registry.example.com: Could not resolve host: registry.example.com')
    await d.step('t1', 1)
    expect(last(h.sent)?.effort, 'a network failure repeated').toBe('medium')
    await d.bash('env:bash: /etc/hosts: Operation not permitted')
    await d.bash('env:zsh: command not found: jq')
    await d.bash('env:The command was blocked by the sandbox: write outside the allowed directories')
    await d.step('t1', 2)
    expect(last(h.sent)?.effort, 'sandbox, a missing program: still not struggling').toBe('medium')
    expect(h.asked.length).toBe(0)
    await d.complete('t1')
    const line = JSON.parse(last((h.files[RUNS_FILE] ?? '').trim().split('\n')) ?? '{}') as { blocked?: number; escalations?: unknown[] }
    expect(line.blocked, 'counted apart, on the run line').toBe(6)
    expect(line.escalations).toBeUndefined()

    // Ordinary failures in the next turn still raise, and a turn with none writes no `blocked`.
    await d.submit(LOOKUP)
    await d.step('t2', 0)
    await d.bash('fail npm test')
    await d.bash('fail npm test')
    await d.step('t2', 1)
    expect(last(h.sent)?.effort, 'the same ordinary failure twice').toBe('high')
    await d.complete('t2')
    const next = JSON.parse(last((h.files[RUNS_FILE] ?? '').trim().split('\n')) ?? '{}') as Record<string, unknown>
    expect('blocked' in next).toBe(false)
  })

  test(`a blocked error or a refused call does not step an auto-lowered turn back up; an ordinary failure does (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = LOWER

    await d.submit(LOOKUP)
    await d.step('t1', 0)
    expect(last(h.sent)?.effort, 'lowered').toBe('low')
    await d.bash('env:ssh: connect to host example.com port 22: Network is unreachable')
    await d.step('t1', 1)
    expect(last(h.sent)?.effort, 'the network is down: effort would not help').toBe('low')
    await d.bash('rejected git reset --hard')
    await d.step('t1', 2)
    expect(last(h.sent)?.effort, 'the person said no: the task is no harder').toBe('low')
    await d.bash('fail npm test')
    await d.step('t1', 3)
    expect(last(h.sent)?.effort, 'a failure of the work: back to medium').toBe('medium')
    await d.complete('t1')
    const stepped = ((h.files[RUNS_FILE] ?? '').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)).filter(r => r.steppedUp)
    expect(stepped, 'a tool error stepped it up: a miss').toMatchObject([{ steppedUpBy: 'error' }])
  })

  test(`Escalation off in /config: no mid-turn raise (${surface})`, { timeoutMs: 30000, options: { escalation: 'off' } }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: AUTO_RAISE })
    const d = drive($, h)
    await d.start(surface)
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    await d.step('t1', 0)
    for (let i = 0; i < 3; i++) await d.bash('fail x')
    await d.step('t1', 1)
    expect(last(h.sent)?.effort).toBe('medium')
  })

  test(`logs the fixed context each request carried, and the report shows what it cost (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    h.breakdown = {
      mcpTools: [
        { name: 'mcp__linear__a', serverName: 'linear', tokens: 9000, isLoaded: true },
        { name: 'mcp__linear__b', serverName: 'linear', tokens: 3000, isLoaded: true },
        { name: 'mcp__github__a', serverName: 'github', tokens: 8000, isLoaded: true },
        { name: 'mcp__vercel__a', serverName: 'vercel', tokens: 50000, isLoaded: false },
      ],
      memoryFiles: [{ path: '/home/test/.claude/CLAUDE.md', type: 'User', tokens: 6000 }],
      agents: [{ agentType: 'x', source: 'plugin', tokens: 1000 }],
      skills: { totalSkills: 3, includedSkills: 3, tokens: 2000, skillFrontmatter: [] },
      slashCommands: { totalCommands: 4, includedCommands: 4, tokens: 1000 },
    }
    await d.start(surface)
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    await d.step('t1', 0)
    await d.step('t1', 1)
    await d.complete('t1')
    const runs = (h.files[RUNS_FILE] ?? '').trim().split('\n')
    const line = JSON.parse(last(runs) ?? '{}') as { requests?: number; fixed?: unknown }
    expect(line.requests).toBe(2)
    // Deferred MCP tools are not in the context: 20K MCP, 6K memory, 1K agents, 3K skills and commands.
    expect(line.fixed).toEqual({ tokens: 30000, mcp: 20000, memory: 6000, agents: 1000, skills: 3000, servers: { linear: 12000, github: 8000 }, cost: 0.012 })
    h.now = Date.now()
    const fixed = (await d.command('report')).text ?? ''
    expect(fixed).toContain('FIXED CONTEXT  ~30K tokens sent with every request')
    // Largest first, the last part closing the tree.
    expect(fixed).toMatch(/├─ MCP tools +20K +linear 12K, github 8K\n +├─ Memory +6K\n +├─ Skills +3K\n +└─ Agents +1K\n/)
  })

  const MIN = 60_000
  const idleSetup = async ($: unknown, on: Parameters<TestBody>[1], surface: string, opts: { store?: Record<string, unknown> } = {}) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', ...(opts.store ? { store: opts.store } : {}) })
    const d = drive($, h)
    await d.start(surface)
    h.rating = NO_CHANGE
    await d.step('t0')
    await d.complete('t0')
    return { h, d }
  }

  test(`idle past the cache: the prompt is never held; the band notes what rewriting the cache costs, once per idle gap (${surface})`, { timeoutMs: 30000, options: { idleWarning: 'over $0.10' } }, async ($, on) => {
    const { h, d } = await idleSetup($, on, surface)
    h.now += 30 * MIN
    await d.submit('continue')
    expect(h.asked.length, 'inside the hour the cache lives').toBe(0)
    expect(await bandText($, surface)).not.toContain('Idle')
    await d.step('t1')
    await d.complete('t1')

    h.now += 2 * 60 * MIN
    const sent = h.submitted.length
    const out = (await d.submit('continue')) as { drop?: string }
    expect(h.asked, 'no question: the Idle dialog is gone').toEqual([])
    expect(out.drop, 'never held').toBeUndefined()
    expect(h.submitted.length, 'the prompt entered').toBe(sent + 1)
    expect(h.filled, 'and nothing was put back in the box').toEqual([])
    expect(await bandText($, surface)).toContain('Idle 2 hours: the cache went cold, so this prompt writes the conversation (~21K tokens) again, about $0.16 more than warm; /compact first would have cost about $0.08.')
    expect(h.files[LOG_PATH] ?? '').toContain('idle 2 hours with 20500 tokens: noted on the band ($0.16 to write again)')

    await d.submit('continue')
    expect(await bandText($, surface), 'one note per idle gap').not.toContain('Idle')
    expect(h.asked.length).toBe(0)
  })

  test(`idle note after a resume reads the last turn from the store (${surface})`, { timeoutMs: 30000, options: { idleWarning: 'over $0.10' } }, async ($, on) => {
    const { h, d } = await idleSetup($, on, surface)
    // Claude Code exits and the session is resumed 3 days later.
    await d.start(surface)
    h.now += 3 * 24 * 60 * MIN
    const out = (await d.submit('continue')) as { drop?: string }
    expect(await bandText($, surface)).toContain('Idle 3 days: the cache went cold')
    expect(await bandText($, surface)).not.toContain('1 minutes')
    expect(out.drop).toBeUndefined()
    expect(last(h.submitted)?.text, 'sent').toBe('continue')
    expect(h.asked.length, 'no question').toBe(0)
  })

  test(`no idle guard past 200K tokens: Claude Code compacts those itself (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.store.lastTurns = { 'sess-1': { at: h.now, context: 250_000 } }
    // Resumed later: the store is all it has.
    await d.start(surface)
    h.now += 3 * 60 * MIN
    await d.submit('continue')
    expect(h.asked.length).toBe(0)
  })

  test(`idle on a subscription: the note gives the cost in API-equivalent dollars, then in the 5-hour window once runs show it (${surface})`, { timeoutMs: 30000, options: { idleWarning: 'over $0.10' } }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    h.rateLimits = [{ kind: 'five_hour', percentUsed: 10 }]
    const d = drive($, h)
    await d.start(surface)
    h.rating = NO_CHANGE
    await d.step('t0')
    await d.complete('t0')
    h.now += 3 * 60 * MIN
    await d.submit('continue')
    expect(h.asked, 'nothing is asked').toEqual([])
    expect(await bandText($, surface)).toContain(
      'Idle 3 hours: the cache went cold, so this prompt writes the conversation (~21K tokens) again, about $0.16 API-equivalent more than warm; /compact first would have cost about $0.08 API-equivalent.',
    )
    await d.step('t1')
    await d.complete('t1')

    // 5% of the window for $1 of one turn, give or take 1 point of rounding: $0.16 is 0.6–1.0%.
    const at = new Date(h.now).toISOString()
    h.files[LEGACY_RUNS] = `${JSON.stringify({ at, kind: 'run', actual: 1, before: { five_hour: 10 }, after: { five_hour: 15 } })}\n`
    h.now += 3 * 60 * MIN
    await d.submit('continue')
    expect(await bandText($, surface)).toContain(
      '~0.6–1.0% of your 5-hour window ($0.16 API-equivalent) more than warm; /compact first would have cost ~0.3–0.5% of your 5-hour window ($0.08 API-equivalent).',
    )
  })

  test(`Idle warning is over $0.50 by default: $0.16 is not noted, a conversation that costs $0.63 to write again is (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await idleSetup($, on, surface)
    h.now += 3 * 60 * MIN
    await d.submit('continue')
    expect(await bandText($, surface), '$0.16 is under $0.50').not.toContain('Idle')
    h.stepUsage = BIG_TURN
    await d.step('t1')
    await d.complete('t1')
    h.now += 3 * 60 * MIN
    const out = (await d.submit('continue')) as { drop?: string }
    expect(out.drop, 'never held').toBeUndefined()
    expect(h.asked, 'nothing asked').toEqual([])
    expect(await bandText($, surface)).toContain('Idle 3 hours: the cache went cold, so this prompt writes the conversation (~81K tokens) again, about $0.63 more than warm; /compact first would have cost about $0.32.')
  })

  test(`Idle warning in /config sets the bar (${surface})`, { timeoutMs: 30000, options: { idleWarning: 'over $1' } }, async ($, on) => {
    const { h, d } = await idleSetup($, on, surface)
    h.now += 3 * 60 * MIN
    await d.submit('continue')
    expect(h.asked.length, '$0.16 is under $1').toBe(0)
    expect(await bandText($, surface), '$0.16 is under $1: no note').not.toContain('Idle')
  })

  test(`a workflow pauses hand-offs and learning for the session, and the report lists it (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-fable-5-1', effort: 'high' })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    const keys = ['lookup:main', 'lookup:main:fable', 'lookup:main:fable:high']
    const learned = () => keys.map(k => (h.store[CAL_STORE] as Record<string, { n: number }> | undefined)?.[k]?.n)

    // An ordinary turn teaches the type, the model, and the model at its level.
    h.rating = '{"level":"high","model":"same","type":"lookup","read":2000,"write":300,"steps":1}'
    await d.submit(LOOKUP)
    await d.step('t1')
    await d.complete('t1')
    expect(learned()).toEqual([1, 1, 1])

    // A turn that starts a workflow teaches nothing.
    await d.submit(LOOKUP)
    await d.step('t2')
    await d.workflow()
    await d.complete('t2')
    expect(learned(), 'unchanged').toEqual([1, 1, 1])

    // A task that would go to Haiku stays here; the turn after the workflow teaches nothing either.
    h.rating = '{"level":"low","model":"haiku","size":"bulky","type":"search","read":150000,"write":3000,"steps":30}'
    await d.config('lowerRule', 'never lower')
    await d.submit(SEARCH)
    expect(h.files[LOG_PATH] ?? '', 'the profile did not decide a hand-off').not.toContain('Cheaper model: no rule set')
    expect(last(h.submitted)?.context ?? [], 'no hand-off note').toEqual([])
    await d.step('t3')
    await d.complete('t3')
    expect(learned()).toEqual([1, 1, 1])
    const lines = (h.files[RUNS_FILE] ?? '').trim().split('\n').map(l => JSON.parse(l) as { workflows?: number; afterWorkflow?: boolean })
    expect(lines.map(l => [l.workflows ?? 0, l.afterWorkflow ?? false])).toEqual([[0, false], [1, true], [0, true]])
    h.now = Date.now()
    const flows = (await d.command('report')).text ?? ''
    expect(flows).toMatch(/2 turns +ran during or after a workflow/)
    expect(flows).toContain('1 workflow, from ultracode or asked for')

    // A new session hands off again.
    await d.start(surface)
    await d.step('t4')
    await d.complete('t4')
    await d.submit(SEARCH)
    expect(h.files[LOG_PATH] ?? '').toContain('Cheaper model: no rule set, the Balanced profile decides (always send)')
    expect(last(h.submitted)?.context?.join('\n') ?? '').toContain('model "haiku"')
  })

  test(`the band shows a change and who decided it; Retry undoes it (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES }, stored: NO_COLD })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    expect(await bandText($, surface), 'nothing to show yet').toBe('')

    h.rating = LOWER
    await d.submit(LOOKUP)
    expect(await bandText($, surface), 'what was done, why, how confident, and who decided').toBe('Effort lowered: medium → low for this prompt (automatically). Why: One function lookup. Confidence: low. Your Balanced profile decided (Lowering); ⋯ changes it.')
    const ui = await mount($, surface)
    expect((await ui.findAll({ type: 'Button' })).map(b => b.key), '👍 and 👎 are in the ⋯ menu now, not buttons').toEqual(['retry', 'mode', 'close'])

    // Retry at original effort puts the prompt back in the box and closes the band.
    await ui.press({ key: 'retry' })
    expect(h.filled[0]).toBe(LOOKUP)
    expect(last(h.toasts) ?? '').toContain('run it at medium')
    await ui.unmount()
    expect(await bandText($, surface)).toBe('')
  })

  const HIGH = '{"level":"high","model":"same","type":"debug","read":20000,"write":3000,"steps":8,"reason":"unknown cause"}'

  test(`the ⋯ menu of a band lists the other rules; one pick sets the rule's /config row, and Remember follows it (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES }, stored: NO_COLD })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')

    h.rating = HIGH
    await d.submit(DEBUG)
    expect(await bandText($, surface)).toMatch(/Effort raised: medium → high.* Your Balanced profile decided \(Raising\); ⋯ changes it\.$/)
    expect(h.asked, 'nothing asked yet: Remember follows only a rule the person sets').toEqual([])
    const ui = await mount($, surface)
    expect((await ui.findAll({ type: 'Button' })).map(b => b.key), 'no marks on a raise').toEqual(['mode', 'close'])
    h.answers = { Options: 'Ask me each time', Remember: 'This session' }
    let asked = h.asked.length
    await ui.press({ key: 'mode' })
    await untilAsked(h, asked)
    expect(h.asked.at(-1)?.options, 'no rule is the person\'s yet: all three, then the band setting').toEqual(['Raise automatically', 'Ask me each time', 'Never raise', 'When the band shows…'])
    expect(last(h.toasts)).toBe('Rightsize: Raising is now "Ask me each time".')
    expect(h.stored.raiseRule, 'the button sets the /config row too').toBe('ask me')
    expect((await d.command('status')).text ?? '').toContain('Raising: ask me')
    expect(h.sets.filter(x => x.key === 'rightsize.raiseRule').length, 'once').toBe(1)
    await d.step('t1')
    await d.complete('t1')
    await settle()
    expect(h.asked.map(a => a.header), 'the rule is the person\'s now: Remember follows it, when the turn ends').toContain('Remember')
    // Dismissing the menu (no answer) does nothing.
    h.answers = {}
    asked = h.asked.length
    await ui.press({ key: 'mode' })
    await untilAsked(h, asked)
    expect(h.asked.at(-1)?.options, 'the new rule is not offered again').toEqual(['Raise automatically', 'Never raise', 'When the band shows…'])
    expect(h.stored.raiseRule, 'dismissed: unchanged').toBe('ask me')
    expect(h.sets.filter(x => x.key === 'rightsize.raiseRule').length).toBe(1)
    await ui.unmount()
  })

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

  test(`once a week the band suggests a cheaper start, and Not now quiets it for 14 days (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    h.files[RUNS] = easyLog(h.now)
    const d = drive($, h)
    await d.start(surface)
    expect(await bandText($, surface)).toMatch(/^Starting on Sonnet at (medium|high) would have cost ~\d+% less than Opus at medium on your last 60 rated prompts\. Switch with \/model\.$/)
    const ui = await mount($, surface)
    expect((await ui.findAll({ type: 'Button' })).map(b => b.key), 'Stop suggesting is in the ⋯ menu').toEqual(['tip-later', 'mode', 'close'])
    await ui.press({ key: 'tip-later' })
    await ui.unmount()
    expect(await bandText($, surface)).toBe('')
    expect(String((await d.command('report')).text)).toContain('STARTING POINT  Opus at medium, 60 rated prompts in 30 days')

    // A day later: not checked again. A week later: checked, but the same start is quiet for 14 days.
    h.now += 24 * 60 * MIN
    await d.start(surface)
    expect(await bandText($, surface)).toBe('')
    h.now += 7 * 24 * 60 * MIN
    h.files[RUNS] = easyLog(h.now)
    await d.start(surface)
    expect(await bandText($, surface), 'snoozed').toBe('')
    h.now += 8 * 24 * 60 * MIN
    h.files[RUNS] = easyLog(h.now)
    await d.start(surface)
    expect(await bandText($, surface), 'the 14 days are over').toContain('Starting on Sonnet')
  })

  test(`rightsize sends nothing anywhere: no POST, no Share row or install ID, and the only address it fetches is Anthropic's pricing page (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    h.rating = NO_CHANGE
    let n = 0
    for (const runs of [20, 100]) {
      h.files[RUNS] = easyLog(h.now).split('\n').slice(0, runs).join('\n')
      await d.start(surface)
      await flush()
      const t = `t${++n}`
      await d.submit(LOOKUP)
      await d.step(t)
      await d.complete(t)
      await settle()
      expect(h.asked.filter(a => a.header === 'Share'), 'no Share question').toEqual([])
    }
    h.now += 31 * 24 * 60 * MIN
    await d.start(surface)
    await flush()
    expect(h.posts, 'no POST, ever').toEqual([])
    expect(new Set(h.urls).size === 0 || [...new Set(h.urls)].every(u => u === 'https://platform.claude.com/docs/en/about-claude/pricing.md'), 'a GET goes only to the pricing page').toBe(true)
    const text = (await d.command('status')).text ?? ''
    expect(text).not.toContain('Share anonymous feedback')
    expect(text).not.toContain('install ID')
    expect(h.store.shareInstall, 'no install ID is made').toBeUndefined()
    expect(h.store.sharedUpTo).toBeUndefined()
  })

  test(`Stop suggesting turns start suggestions off in /config (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    h.files[RUNS] = easyLog(h.now)
    const d = drive($, h)
    await d.start(surface)
    await openMenu($, h, { Options: 'Stop suggesting' })
    expect(last(h.configSet)).toBe('off')
    expect(last(h.toasts) ?? '').toContain('no more starting-model suggestions')
    expect((await d.command('status')).text ?? '').toContain('Start suggestions: off')
  })

  test(`no start suggestion when Start suggestions is off, or with too few prompts (${surface})`, { timeoutMs: 30000, options: { startTips: 'off' } }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    h.files[RUNS] = easyLog(h.now)
    const d = drive($, h)
    await d.start(surface)
    expect(await bandText($, surface)).toBe('')
    expect(String((await d.command('report')).text), 'the report still compares').toContain('rated prompts in 30 days')
  })

  test(`waits for 50 rated prompts before suggesting a start (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    h.files[RUNS] = easyLog(h.now).split('\n').slice(0, 30).join('\n')
    const d = drive($, h)
    await d.start(surface)
    expect(await bandText($, surface)).toBe('')
    expect(String((await d.command('report')).text)).toContain('STARTING POINT  Needs 50 rated prompts on Opus at medium to compare (has 30).')
  })

  // ---- The three feature switches: Routing, Hand-offs, Cache ----------------------------------------------------------
  const switches = (more: Record<string, string>) => ({ options: more, stored: more })
  /** Presses ⋯, answers the menu's questions by header (no answer: dismissed), and returns the questions asked. */
  const openMenu = async ($: unknown, h: ReturnType<typeof engine>, answers: Record<string, string> = {}, questions = 1) => {
    h.answers = answers
    const before = h.asked.length
    const ui = await mount($, surface)
    await ui.press({ key: 'mode' })
    await untilAsked(h, before, questions)
    await ui.unmount()
    return h.asked.slice(before)
  }
}
