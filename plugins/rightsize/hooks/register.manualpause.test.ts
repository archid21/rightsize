import { expect, test } from 'claude-code/testing'
import { CAL_STORE } from './cost'
import { RUNS_FILE, LOG_PATH, LOOKUP, DEBUG, REVIEW, NO_CHANGE, LOWER, FREE_SWITCHES, engine, drive, last, mount, rowText } from './testkit'

// Manual step up: when the person picks a stronger model or a higher effort, rightsize changes neither until they resume. A step
// down keeps it on. The model is read at prompt.submit; the effort on the first step of the turn (the engine gives no read of it
// earlier), so a raise of effort drops the run that prompt was rated for.

const SONNET = 'claude-sonnet-5-5'
const OPUS_ID = 'claude-opus-5-5'
const FABLE = 'claude-fable-5-1'
const PAUSED_MODEL = "Paused: you switched to Opus. Rightsize won't change the model or effort until you resume."
const PAUSED_EFFORT = "Paused: you raised effort to high. Rightsize won't change the model or effort until you resume."
const LISTING = '{"fit":{"haiku":"low","sonnet":"low","opus":"low","fable":"low"},"type":"search","read":8000,"write":500,"steps":5,"reason":"list call sites"}'

for (const surface of ['desktop', 'terminal'] as const) {
  type H = ReturnType<typeof engine>
  type D = ReturnType<typeof drive>
  const log = (h: H) => h.files[LOG_PATH] ?? ''
  // The last value rightsize wrote to one of its state keys.
  const stateOf = (h: H, key: string) => h.stateWrites.filter(w => w.plugin === 'rightsize' && w.key === key).at(-1)?.value
  const runs = (h: H) => (h.files[RUNS_FILE] ?? '').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as { kind?: string; reason?: string })
  // The person's model, as /model shows it and as the next step carries it.
  const pick = (h: H, model: string) => {
    h.model = model
    h.liveModel = model
  }
  // The row of the band and its buttons, as drawn.
  const band = async ($: unknown) => {
    const ui = await mount($, surface)
    const text = (await rowText(ui, 'Prompt')) || (await rowText(ui, 'Cache'))
    const buttons = (await ui.findAll({ type: 'Button' })).map(b => b.key)
    await ui.unmount()
    return { text, buttons }
  }
  const press = async ($: unknown, key: string) => {
    const ui = await mount($, surface)
    await ui.press({ key })
    await ui.unmount()
  }
  // A Sonnet session that ran one turn: seenModel and the person's effort are known.
  function session(over: { model?: string; effort?: string; store?: Record<string, unknown> } = {}) {
    return { model: over.model ?? SONNET, effort: over.effort ?? 'medium', ...(over.store ? { store: over.store } : {}) }
  }
  async function warm(d: D) {
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
  }

  test(`Sonnet to Opus pauses: no rating, no hand-off, the prompt goes as typed, a row with Resume rightsize (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, session())
    const d = drive($, h)
    await warm(d)
    pick(h, OPUS_ID)
    h.rating = REVIEW
    const rated = h.completions.length
    await d.submit(DEBUG)
    expect(h.completions.length, 'no rating call').toBe(rated)
    expect(h.submitted.at(-1)).toMatchObject({ text: DEBUG })
    expect(h.submitted.at(-1)?.context ?? [], 'no hand-off note').toEqual([])
    await d.step('t1', 0)
    await d.step('t1', 1)
    expect(h.sent.filter(s => s.turnId === 't1').map(s => [s.model, s.effort]), 'the person\'s model and effort, as they came').toEqual([[OPUS_ID, 'medium'], [OPUS_ID, 'medium']])
    const shown = await band($)
    expect(shown.text).toBe(PAUSED_MODEL)
    expect(shown.buttons).toContain('resume')
    expect(last(h.statuses)).toBe('Rightsize paused (you picked Opus) · /rightsize resume')
    expect(log(h)).toContain('paused: the person switched to Opus from Sonnet')
    await d.complete('t1')
    expect(runs(h).filter(l => l.kind === 'run'), 'a paused turn claims nothing').toEqual([])
  })

  test(`the row shows once: a later prompt in the pause has no row, and the pause stays (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, session())
    const d = drive($, h)
    await warm(d)
    pick(h, OPUS_ID)
    await d.submit(DEBUG)
    await d.step('t1')
    await d.complete('t1')
    expect((await band($)).text).toBe(PAUSED_MODEL)
    const rated = h.completions.length
    await d.submit(LOOKUP)
    expect((await band($)).text, 'no row again').toBe('')
    await d.step('t2')
    await d.complete('t2')
    expect(h.completions.length, 'still no rating').toBe(rated)
    expect(last(h.statuses)).toBe('Rightsize paused (you picked Opus) · /rightsize resume')
  })

  test(`a further step up while paused shows the row again, and the way back is still the first model (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, session())
    const d = drive($, h)
    await warm(d)
    pick(h, OPUS_ID)
    await d.submit(DEBUG)
    await d.step('t1')
    await d.complete('t1')
    pick(h, FABLE)
    await d.submit(LOOKUP)
    expect((await band($)).text).toBe("Paused: you switched to Fable. Rightsize won't change the model or effort until you resume.")
    await d.step('t2')
    await d.complete('t2')
    // Opus is still above Sonnet, the model before the pause: no resume, and no row for a step down.
    pick(h, OPUS_ID)
    await d.submit(LOOKUP)
    expect(last(h.statuses)).toBe('Rightsize paused (you picked Fable) · /rightsize resume')
  })

  test(`Opus to Sonnet does not pause: rightsize stays on and plans from Sonnet (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, session({ model: OPUS_ID, store: { [CAL_STORE]: FREE_SWITCHES } }))
    const d = drive($, h)
    await warm(d)
    pick(h, SONNET)
    h.rating = LOWER
    const rated = h.completions.length
    await d.submit(LOOKUP)
    expect(h.completions.length, 'rated').toBe(rated + 1)
    await d.step('t1')
    expect(last(h.sent)?.effort, 'rightsize still lowers').toBe('low')
    expect(log(h)).toContain('lookup on sonnet/medium')
    expect(log(h)).not.toContain('paused')
    expect(last(h.statuses) ?? '').not.toContain('paused')
  })

  test(`a session that has run no step yet is not paused, whatever its model (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, session({ model: OPUS_ID }))
    const d = drive($, h)
    await d.start(surface)
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    expect(h.completions.length, 'rated').toBe(1)
    expect(log(h)).not.toContain('paused')
  })

  test(`a manual effort raise pauses from the first step: the effort goes as the person set it, the run is dropped (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, session())
    const d = drive($, h)
    await warm(d)
    h.effort = 'high'
    h.rating = LOWER
    const rated = h.completions.length
    await d.submit(LOOKUP)
    // The effort is only known on the first step, so this prompt was rated.
    expect(h.completions.length).toBe(rated + 1)
    await d.step('t1', 0)
    await d.step('t1', 1)
    expect(h.sent.filter(s => s.turnId === 't1').map(s => s.effort), 'neither step lowered').toEqual(['high', 'high'])
    expect((await band($)).text).toBe(PAUSED_EFFORT)
    expect((await band($)).buttons).toContain('resume')
    expect(last(h.statuses)).toBe('Rightsize paused (you raised effort to high) · /rightsize resume')
    expect(log(h)).toContain('paused: the person raised effort from medium to high')
    await d.complete('t1')
    const lines = runs(h)
    expect(lines.map(l => l.kind), 'no run claimed, the rating cost is overhead').toEqual(['dropped'])
    // The next prompt is held at prompt.submit: no rating.
    h.rating = LOWER
    await d.submit(LOOKUP)
    expect(h.completions.length, 'no rating').toBe(rated + 1)
    expect((await band($)).text, 'no row again').toBe('')
    await d.step('t2')
    expect(last(h.sent)?.effort).toBe('high')
  })

  test(`a manual effort step down does not pause (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, session({ effort: 'high', store: { [CAL_STORE]: FREE_SWITCHES } }))
    const d = drive($, h)
    await warm(d)
    h.effort = 'medium'
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    await d.step('t1')
    expect(log(h)).not.toContain('paused')
    expect(h.completions.length).toBeGreaterThan(0)
    h.rating = LOWER
    await d.complete('t1')
    await d.submit(LOOKUP)
    await d.step('t2')
    expect(last(h.sent)?.effort, 'rightsize plans from the new base and lowers').toBe('low')
  })

  test(`an effort that moved only because the model changed to its default is not a step up (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    // Opus at medium is its default; Fable's default is high. Stepping down from Fable to Opus moves the default effort down, and
    // from Opus to Fable up: the first is a step down in model and the second a step up in model, so only the second pauses.
    const h = engine(on, session({ model: FABLE, effort: 'high' }))
    const d = drive($, h)
    await warm(d)
    pick(h, OPUS_ID)
    h.effort = 'medium'
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    await d.step('t1')
    await d.complete('t1')
    expect(log(h)).not.toContain('paused')
    // Back up to Fable: its default effort is high, above Opus's medium. The model step up pauses it; the effort is not the cause.
    pick(h, FABLE)
    h.effort = 'high'
    await d.submit(LOOKUP)
    expect((await band($)).text).toBe("Paused: you switched to Fable. Rightsize won't change the model or effort until you resume.")
  })

  test(`rightsize's own review switch does not pause (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, session({ store: { 'cal-v1': {} } }))
    const d = drive($, h)
    await warm(d)
    h.rating = REVIEW
    await d.submit(DEBUG)
    await d.step('t1', 0)
    await d.step('t1', 1)
    expect(h.sent.filter(s => s.turnId === 't1').map(s => s.model), 'the turn ran on Opus').toEqual(['opus', 'opus'])
    await d.complete('t1')
    h.rating = NO_CHANGE
    const rated = h.completions.length
    await d.submit(LOOKUP)
    expect(h.completions.length, 'the next prompt is rated').toBe(rated + 1)
    await d.step('t2')
    expect(last(h.sent)?.model, 'back on the session model').toBe(SONNET)
    expect(log(h)).not.toContain('paused')
    expect(last(h.statuses) ?? '').not.toContain('paused')
  })

  test(`no subagent is moved to another model while paused (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, session({ model: OPUS_ID }))
    const d = drive($, h)
    await warm(d)
    // Control: running, a subagent Claude starts is sized.
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    await d.step('t1', 0)
    h.rating = LISTING
    await d.spawn('lister')
    expect(h.spawned[0]?.model, 'moved to a cheaper model').toBeDefined()
    await d.complete('t1')
    // Paused: the same spawn is left as Claude asked.
    pick(h, FABLE)
    await d.submit(LOOKUP)
    await d.step('t2', 0)
    const rated = h.completions.length
    await d.spawn('lister2', undefined)
    expect(h.spawned[1]?.model, 'left alone').toBeUndefined()
    expect(h.completions.length, 'and not rated').toBe(rated)
  })

  test(`× hides the row and keeps the pause (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, session())
    const d = drive($, h)
    await warm(d)
    pick(h, OPUS_ID)
    await d.submit(DEBUG)
    expect((await band($)).text).toBe(PAUSED_MODEL)
    await press($, 'close')
    expect((await band($)).text).toBe('')
    expect(last(h.statuses)).toBe('Rightsize paused (you picked Opus) · /rightsize resume')
    await d.step('t1')
    await d.complete('t1')
    const rated = h.completions.length
    h.rating = REVIEW
    await d.submit(LOOKUP)
    expect(h.completions.length, 'still held').toBe(rated)
  })

  test(`the Resume rightsize button resumes: a toast, and the next prompt is planned from the person's model (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, session())
    const d = drive($, h)
    await warm(d)
    pick(h, OPUS_ID)
    await d.submit(DEBUG)
    await d.step('t1')
    await d.complete('t1')
    await press($, 'resume')
    expect(last(h.toasts)).toBe('Rightsize resumed.')
    expect(last(h.statuses)).toBeUndefined()
    expect((await band($)).text).toBe('')
    expect(log(h)).toContain('resumed: the person asked')
    h.rating = NO_CHANGE
    const rated = h.completions.length
    await d.submit(LOOKUP)
    expect(h.completions.length, 'rated again').toBe(rated + 1)
    expect((await band($)).text, 'the resume is not a new step up').not.toContain('Paused')
    expect(log(h)).toContain('lookup on opus/medium')
    await d.step('t2')
    expect(last(h.sent)?.model, 'never back to Sonnet').toBe(OPUS_ID)
  })

  test(`a resume drops a session switch from before the pause, so the base is the person's effort (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, session())
    const d = drive($, h)
    await warm(d)
    pick(h, OPUS_ID)
    await d.submit(DEBUG)
    await d.step('t1')
    expect(last(h.sent)?.effort, 'held: the person\'s effort').toBe('medium')
    await d.complete('t1')
    expect((await d.command('resume')).text).toBe('Rightsize resumed.')
    expect(stateOf(h, 'sessionEffort')).toBeNull()
  })

  test(`/rightsize resume resumes, and says so when nothing is paused (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, session())
    const d = drive($, h)
    await warm(d)
    expect((await d.command('resume')).text).toBe('Rightsize is not paused.')
    pick(h, OPUS_ID)
    await d.submit(DEBUG)
    await d.step('t1')
    await d.complete('t1')
    expect((await d.command('resume')).text).toBe('Rightsize resumed.')
    expect(last(h.statuses)).toBeUndefined()
    h.rating = NO_CHANGE
    const rated = h.completions.length
    await d.submit(LOOKUP)
    expect(h.completions.length).toBe(rated + 1)
  })

  test(`/rightsize help lists resume (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, session())
    const d = drive($, h)
    await d.start(surface)
    expect((await d.command('help')).text).toMatch(/\/rightsize resume +start changing the model and effort again/)
  })

  test(`stepping back down to the model before the pause resumes on its own (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, session())
    const d = drive($, h)
    await warm(d)
    pick(h, OPUS_ID)
    await d.submit(DEBUG)
    await d.step('t1')
    await d.complete('t1')
    pick(h, SONNET)
    h.rating = NO_CHANGE
    const rated = h.completions.length
    await d.submit(LOOKUP)
    expect(last(h.toasts)).toBe('Rightsize resumed: you switched back.')
    expect(h.completions.length, 'this prompt is rated').toBe(rated + 1)
    expect(log(h)).toContain('resumed: the person is back at the model and effort they had before the pause')
    expect(last(h.statuses) ?? '').not.toContain('paused')
  })

  test(`stepping back down to a lower model than before the pause resumes too (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, session({ model: OPUS_ID }))
    const d = drive($, h)
    await warm(d)
    pick(h, FABLE)
    await d.submit(DEBUG)
    await d.step('t1')
    await d.complete('t1')
    pick(h, SONNET)
    await d.submit(LOOKUP)
    expect(last(h.toasts)).toBe('Rightsize resumed: you switched back.')
  })

  test(`stepping the effort back down resumes at the next turn's first step (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, session())
    const d = drive($, h)
    await warm(d)
    h.effort = 'high'
    await d.submit(LOOKUP)
    await d.step('t1')
    await d.complete('t1')
    expect(last(h.statuses)).toBe('Rightsize paused (you raised effort to high) · /rightsize resume')
    h.effort = 'medium'
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    await d.step('t2')
    expect(last(h.toasts)).toBe('Rightsize resumed: you switched back.')
    expect(last(h.statuses) ?? '').not.toContain('paused')
    await d.complete('t2')
    const rated = h.completions.length
    await d.submit(LOOKUP)
    expect(h.completions.length, 'rated again').toBe(rated + 1)
  })

  test(`a model pause stays while the effort is still above what it was (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, session())
    const d = drive($, h)
    await warm(d)
    pick(h, OPUS_ID)
    await d.submit(DEBUG)
    await d.step('t1')
    await d.complete('t1')
    // Back on Sonnet, and the effort is higher than before: the first step reads it and holds.
    pick(h, SONNET)
    h.effort = 'high'
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    await d.step('t2')
    expect(last(h.statuses)).toBe('Rightsize paused (you raised effort to high) · /rightsize resume')
  })

  test(`a fresh session starts unpaused (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, session())
    const d = drive($, h)
    await warm(d)
    pick(h, OPUS_ID)
    await d.submit(DEBUG)
    await d.step('t1')
    await d.complete('t1')
    expect(last(h.statuses)).toContain('paused')
    await d.start(surface)
    expect(last(h.statuses) ?? '').not.toContain('paused')
    expect(stateOf(h, 'manualPause')).toBeNull()
    h.rating = NO_CHANGE
    const rated = h.completions.length
    await d.submit(LOOKUP)
    expect(h.completions.length, 'rated').toBe(rated + 1)
  })

  test(`the pause is kept in state with what the person stepped to and from (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, session())
    const d = drive($, h)
    await warm(d)
    pick(h, OPUS_ID)
    await d.submit(DEBUG)
    const kept = stateOf(h, 'manualPause')
    expect(kept).toMatchObject({ model: 'opus', fromModel: 'sonnet', effort: 'medium', fromEffort: 'medium', by: 'model' })
    expect(typeof (kept as { at: number }).at).toBe('number')
  })
}
