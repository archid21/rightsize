import { expect, test } from 'claude-code/testing'
import { RUNS_FILE, LOG_PATH, SEARCH, engine, drive, last } from './testkit'

// The Helper call cap (key `helperCap`): a helper on a cheaper tier gets a fixed number of tool calls for a task. At the cap it is
// struggling, and it goes back to the main chat the way a helper with no retry left does. Haiku 25 and Sonnet 40 by default.

for (const surface of ['desktop', 'terminal'] as const) {
  const HELPERS = { remember: true, choices: { raise: 'auto', down: 'auto' } }
  const HAND_OFF = '{"fit":{"haiku":"low","sonnet":"low","opus":"low","fable":"low"},"type":"search","read":150000,"write":3000,"steps":30,"continues":false,"reason":"repo-wide search"}'
  const SONNET_FIT = '{"fit":{"haiku":"no","sonnet":"low","opus":"low","fable":"low"},"type":"search","read":150000,"write":3000,"steps":30,"continues":false,"reason":"repo-wide search"}'
  const log = (h: ReturnType<typeof engine>) => h.files[LOG_PATH] ?? ''
  type Drive = ReturnType<typeof drive>
  type HelperEntry = { agent: string; kind: string; stall?: string; returned?: boolean; capped?: number; raises?: unknown[] }
  const runLine = (h: ReturnType<typeof engine>) => (h.files[RUNS_FILE] ?? '').trim().split('\n').map(l => JSON.parse(l) as { kind?: string; helpers?: HelperEntry[]; retries?: number }).find(l => l.kind === 'run')

  async function warm(d: Drive, h: ReturnType<typeof engine>, sub: string) {
    h.subModel = sub
    await d.step('t0')
    await d.complete('t0')
  }
  // The main chat hands the work to a subagent on `tier`, which takes its first step.
  async function startHelper(d: Drive, tier: 'haiku' | 'sonnet') {
    await d.submit(SEARCH)
    await d.step('t1', 0)
    await d.agent(tier)
    await d.spawn('helper', tier)
    await d.step('t1', 0, 'agent-helper')
  }
  // `n` distinct, successful calls from the helper: none repeats, so no other sign of struggling can fire.
  const calls = async (d: Drive, n: number, from = 0) => {
    const out: { deny?: string }[] = []
    for (let i = from; i < from + n; i++) out.push((await d.bash(`ls dir${i}`, 'agent-helper')) as { deny?: string })
    return out
  }

  test(`a Haiku helper may make 25 tool calls; the 26th is refused and sends it back to the main chat (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-fable-5-1', effort: 'high', store: HELPERS })
    const d = drive($, h)
    await d.start(surface)
    await warm(d, h, 'claude-haiku-5-5')
    h.rating = HAND_OFF
    await startHelper(d, 'haiku')
    const first = await calls(d, 25)
    expect(first.filter(r => r.deny), 'the first 25 go through').toEqual([])
    const [over] = await calls(d, 1, 25)
    expect(over?.deny, 'the 26th is refused with the cap in the reason').toContain('25 tool calls')
    expect(over?.deny).toContain('The main chat takes it from here')
    expect(((await calls(d, 1, 26))[0] as { deny?: string }).deny, 'and so is every call after').toContain('25 tool calls')
    expect(log(h)).toContain('returned helper agent-helper to the main chat at step 1: it reached the 25-call cap for haiku')
    expect(((await d.bash('ls')) as { deny?: string }).deny, 'the main chat has no cap').toBeUndefined()
    await d.complete('t1')
    const run = runLine(h)
    expect(run?.helpers?.map(x => [x.stall, x.returned, x.capped, x.raises])).toEqual([['struggling', true, 25, undefined]])
    expect('retries' in (run ?? {}), 'no retry is spent: the cap goes straight back to the main chat').toBe(false)
  })

  test(`a Sonnet helper may make 40 tool calls (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-fable-5-1', effort: 'high', store: HELPERS })
    const d = drive($, h)
    await d.start(surface)
    await warm(d, h, 'claude-sonnet-5-5')
    h.rating = SONNET_FIT
    await startHelper(d, 'sonnet')
    expect((await calls(d, 40)).filter(r => r.deny), 'the first 40 go through').toEqual([])
    expect(((await calls(d, 1, 40))[0] as { deny?: string }).deny, 'the 41st is refused').toContain('40 tool calls')
    expect(log(h)).toContain('it reached the 40-call cap for sonnet')
  })

  for (const [value, cap] of [['tight', 15], ['loose', 40], ['off', undefined]] as const) {
    test(`Helper call cap ${value}: ${cap === undefined ? 'a Haiku helper has no cap' : `a Haiku helper is capped at ${cap}`} (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
      const h = engine(on, { model: 'claude-fable-5-1', effort: 'high', store: HELPERS })
      const d = drive($, h)
      await d.start(surface)
      await d.config('helperCap', value)
      await warm(d, h, 'claude-haiku-5-5')
      h.rating = HAND_OFF
      await startHelper(d, 'haiku')
      const n = cap ?? 60
      expect((await calls(d, n)).filter(r => r.deny), `${n} calls go through`).toEqual([])
      const after = ((await calls(d, 1, n))[0] as { deny?: string }).deny
      if (cap === undefined) expect(after, 'no cap').toBeUndefined()
      else expect(after, 'the next is refused').toContain(`${cap} tool calls`)
    })
  }

  test(`a refused call does not count: the denied approval steps of a helper leave its calls untouched (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-fable-5-1', effort: 'high', store: HELPERS })
    const d = drive($, h)
    await d.start(surface)
    await warm(d, h, 'claude-haiku-5-5')
    h.rating = HAND_OFF
    await startHelper(d, 'haiku')
    for (let i = 0; i < 5; i++) expect(((await d.bash(`git push origin b${i}`, 'agent-helper')) as { deny?: string }).deny, 'refused as an approval step').toContain('cannot push')
    expect((await calls(d, 25)).filter(r => r.deny), 'all 25 of its allowed calls are still there').toEqual([])
    expect(last(h.sent)?.agentId).toBe('agent-helper')
  })
}
