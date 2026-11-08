import { expect, test } from 'claude-code/testing'
import { PING_PROMPT } from './warm'
import { ratingSystem } from './rate'
import { delegateNote } from './register'
import { BIG_TURN, DEBUG, LOOKUP, NO_CHANGE, drive, engine } from './testkit'

// Keep warm depends on the prompt-cache prefix staying as it was. rightsize runs as a mod, not as Claude Code shell hooks, so
// there is no `additionalContext` field. The places where it puts text in front of the model are these, and each must add at the
// tail or stay out of the conversation's prefix:
//   1. prompt.submit: a hand-off's note goes in the prompt's `context`, after the person's text. The text itself is unchanged.
//   2. The rater and the rater check: separate calls with their own system text, which depends only on the tier and level.
//   3. A keep-warm request: a fork of the conversation that adds one fixed prompt and nothing else.
// Effort and model changes on a step are request settings, not text; the cache cost of those is measured separately.

const HOUR = 3600_000
const EVENING = new Date(2027, 0, 15, 18, 0, 0, 0).getTime()
const DEBUG_RATING = '{"level":"high","model":"fable","size":"small","type":"debug","read":30000,"write":4000,"steps":12,"reason":"subtle concurrency bug"}'

for (const surface of ['desktop', 'terminal'] as const) {
  test(`cache prefix: a hand-off adds its note to the prompt's context only; the typed text goes through unchanged (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = DEBUG_RATING
    await d.config('upRule', 'always')
    await d.submit(DEBUG)
    const sent = h.submitted.at(-1)
    expect(sent?.text, 'the prompt text is never rewritten').toBe(DEBUG)
    expect(sent?.context?.length ?? 0, 'the note is added').toBeGreaterThan(0)
    for (const line of sent?.context ?? []) expect(line.startsWith('[rightsize]'), 'every added line is marked as rightsize\'s').toBe(true)
  })

  test(`cache prefix: a prompt with no hand-off adds nothing, and the same hand-off adds the same note each time (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    expect(h.submitted.at(-1)?.text).toBe(LOOKUP)
    expect(h.submitted.at(-1)?.context ?? [], 'no hand-off: nothing is added').toEqual([])
    const down = { tier: 'haiku', level: 'low', dir: 'down' } as never
    const up = { tier: 'fable', level: 'high', dir: 'up' } as never
    expect(delegateNote(down, 2), 'same inputs, same bytes').toBe(delegateNote(down, 2))
    expect(delegateNote(up, 1), 'same inputs, same bytes').toBe(delegateNote(up, 1))
    // Nothing in a note changes with the clock, the session or the prompt: only the tier, level, direction and rework count.
    expect(delegateNote(down, 2)).not.toMatch(/\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}|sess-|turn/)
  })

  test(`cache prefix: the rater's system text depends on the tier and level only, never on the prompt or the clock (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    await d.step('t1')
    await d.complete('t1')
    h.now += 3 * HOUR
    await d.submit('rename the helper in src/util.ts to formatName')
    expect(h.completionSystems.length, 'two ratings').toBeGreaterThanOrEqual(2)
    expect(new Set(h.completionSystems).size, 'the same tier and level: one system text, byte for byte').toBe(1)
    expect(h.completionSystems[0]).toBe(ratingSystem('opus', 'medium'))
    for (const s of h.completionSystems) {
      expect(s, 'the prompt is data, not part of the system text').not.toContain(LOOKUP)
      expect(s).not.toMatch(/\d{4}-\d{2}-\d{2}/)
    }
  })

  test(`cache prefix: every keep-warm request is a fork that adds the one fixed prompt and nothing else (${surface})`, { timeoutMs: 30000, options: { beforeCold: 'keep warm 2 h' } }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', stored: { beforeCold: 'keep warm 2 h' } })
    h.now = EVENING
    h.virtual = true
    h.stepUsage = BIG_TURN
    h.commands = []
    const d = drive($, h)
    await d.start(surface)
    h.rating = NO_CHANGE
    await d.step('t1')
    await d.complete('t1')
    await h.advance(5 * HOUR)
    expect(h.forks.length, 'at least two pings ran').toBeGreaterThanOrEqual(2)
    expect(new Set(h.forks), 'the same text every time').toEqual(new Set([PING_PROMPT]))
    expect(new Set(h.forkKeys.map(k => k.join(','))), 'a prompt and no system text, context or model of its own').toEqual(new Set(['prompt']))
  })
}
