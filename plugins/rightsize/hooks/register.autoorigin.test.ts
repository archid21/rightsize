import { expect, test } from 'claude-code/testing'
import { NO_CHANGE, RUNS_FILE, LOOKUP, NO_COLD, engine, drive } from './testkit'

// P-25 (ADR 0065): a turn the person did not type writes one 'auto' line with its prompt origin (and, for a scheduled trigger, the
// hook's source), so the P-17 decision rests on logged origins. It is not a run: the report and the checks do not count it.

for (const surface of ['desktop', 'terminal'] as const) {
  const OPUS = { model: 'claude-opus-5-5', effort: 'medium', stored: NO_COLD }
  type Line = Record<string, unknown>
  const lines = (h: ReturnType<typeof engine>) => (h.files[RUNS_FILE] ?? '').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as Line)
  const autos = (h: ReturnType<typeof engine>) => lines(h).filter(l => l.kind === 'auto')
  type Api = { prompt: { submit: (x: unknown) => Promise<unknown> }; classic: { UserPromptSubmit: (x: unknown) => Promise<unknown> } }

  async function turn($: unknown, h: ReturnType<typeof engine>, origin: object, text: string, source?: string) {
    const d = drive($, h)
    const api = $ as Api
    // The settings hook runs inside the submit, after the turn starts.
    h.duringSubmit = () => d.turnStart('a1', text)
    await api.prompt.submit({ text, origin, wait: false })
    if (source) await api.classic.UserPromptSubmit({ prompt: text, source })
    await d.step('a1', 0)
    await d.complete('a1')
  }

  test(`a scheduled trigger logs its origin and the hook's source, and no run line (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, OPUS)
    await drive($, h).start(surface)
    h.rating = NO_CHANGE
    await turn($, h, { kind: 'scheduled-trigger' }, 'check the build', 'loop_wakeup')
    expect(autos(h)).toHaveLength(1)
    expect(autos(h)[0]).toMatchObject({ kind: 'auto', origin: 'scheduled-trigger', source: 'loop_wakeup', turnId: 'a1' })
    expect(autos(h)[0]?.context).toBeDefined()
    expect(lines(h).filter(l => l.kind === 'run'), 'no rated run').toHaveLength(0)
    expect(h.ratings, 'not rated').toBe(0)
  })

  test(`a task notification logs its origin and no source (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, OPUS)
    await drive($, h).start(surface)
    h.rating = NO_CHANGE
    await turn($, h, { kind: 'task-notification' }, 'task done')
    expect(autos(h)).toHaveLength(1)
    expect(autos(h)[0]).toMatchObject({ origin: 'task-notification' })
    expect(autos(h)[0]).not.toHaveProperty('source')
  })

  test(`a peer message logs its origin (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, OPUS)
    await drive($, h).start(surface)
    h.rating = NO_CHANGE
    await turn($, h, { kind: 'peer' }, 'hello from another session')
    expect(autos(h)[0]).toMatchObject({ origin: 'peer' })
  })

  test(`a typed turn writes a run line with no origin and no auto line (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, OPUS)
    const d = drive($, h)
    await d.start(surface)
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    await d.step('t1', 0)
    await d.complete('t1')
    expect(autos(h)).toHaveLength(0)
    const run = lines(h).filter(l => l.kind === 'run')
    expect(run).toHaveLength(1)
    expect(run[0]).not.toHaveProperty('origin')
  })
}
