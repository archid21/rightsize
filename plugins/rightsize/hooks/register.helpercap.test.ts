import { expect, test } from 'claude-code/testing'
import { RUNS_FILE, LOG_PATH, NO_ONE, SEARCH, engine, drive, last, settle } from './testkit'

// The helper spend limit: a helper on a cheaper tier may spend 1.5, 2 or 3 times what its task is estimated to cost on the main
// model (by its rated tool calls). Near the limit, while it is not stuck, Long helpers decides: ask on the band (no answer goes on
// while it makes progress, up to the hard cap of 10x), extend by itself up to 10x, or stop. At the limit it goes back to the main chat the way a helper with no retry left does. The flat call cap
// (25 for Haiku, 40 for Sonnet) stays only as the fallback for a helper with no estimate.

for (const surface of ['desktop', 'terminal'] as const) {
  const HELPERS = { remember: true, choices: { raise: 'auto', down: 'auto' } }
  // The 1.5x band (10 rated calls or fewer) is covered by struggle.test.ts: a task that short is not handed off in these fixtures, so no helper starts.
  const rating = (steps: number, haiku = 'low') =>
    `{"fit":{"haiku":"${haiku}","sonnet":"low","opus":"low","fable":"low"},"type":"search","read":150000,"write":3000,"steps":${steps},"continues":false,"reason":"repo-wide search"}`
  const HAND_OFF = rating(30)
  const log = (h: ReturnType<typeof engine>) => h.files[LOG_PATH] ?? ''
  type Drive = ReturnType<typeof drive>
  type H = ReturnType<typeof engine>
  type HelperEntry = { agent: string; kind: string; calls?: number; stall?: string; returned?: boolean; capped?: number; limited?: number; spend?: number; limit?: number; raises?: unknown[] }
  const runLine = (h: H) => (h.files[RUNS_FILE] ?? '').trim().split('\n').map(l => JSON.parse(l) as { kind?: string; helpers?: HelperEntry[]; retries?: number }).find(l => l.kind === 'run')
  const LONG = 'Long helper'
  // Output prices per million tokens of the helper's model: a step's cost is its output tokens times this.
  const PRICE = { haiku: 0.5, sonnet: 10 } as const

  async function warm(d: Drive, h: H, sub: string) {
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
  // The limit the helper got, and what it is a multiple of, as the log says.
  const limitOf = (h: H) => {
    const m = /spend limit \$([\d.]+), ([\d.]+)x its \$([\d.]+) estimate/.exec(log(h))
    return m ? { limit: Number(m[1]), multiple: Number(m[2]), estimate: Number(m[3]) } : undefined
  }
  // Each of `n` helper requests costs `share` of a block (the first limit), and is followed by one distinct, successful call.
  // None repeats, so no other sign of struggling can fire.
  let at = 0
  async function work(d: Drive, h: H, tier: 'haiku' | 'sonnet', n: number, share: number) {
    const block = limitOf(h)?.limit ?? 1
    h.stepUsage = { input_tokens: 0, output_tokens: Math.round((block * share / PRICE[tier]) * 1e6), cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    const out: { deny?: string }[] = []
    for (let i = 0; i < n; i++) {
      await d.step('t1', ++at, 'agent-helper')
      out.push((await d.bash(`ls dir${at}`, 'agent-helper')) as { deny?: string })
      await settle()
    }
    return out
  }
  async function begin(on: Parameters<typeof engine>[0], d$: unknown, tier: 'haiku' | 'sonnet', rated = HAND_OFF, extra: Record<string, unknown> = {}) {
    const h = engine(on, { model: 'claude-fable-5-2', effort: 'high', store: HELPERS, ...extra })
    const d = drive(d$, h)
    await d.start(surface)
    await warm(d, h, tier === 'haiku' ? 'claude-haiku-5-5' : 'claude-sonnet-5-5')
    h.rating = tier === 'sonnet' ? rated.replace('"haiku":"low"', '"haiku":"no"') : rated
    await startHelper(d, tier)
    at = 0
    return { h, d }
  }

  for (const [steps, multiple] of [[30, 2], [31, 3], [60, 3]] as const) {
    test(`a helper rated ${steps} tool calls gets ${multiple}x its estimate as the spend limit (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
      const { h } = await begin(on, $, 'sonnet', rating(steps))
      const got = limitOf(h)
      expect(got?.multiple, log(h)).toBe(multiple)
      expect(got?.limit, 'the limit is the multiple times the estimate').toBeGreaterThan(0)
    })
  }

  test(`a helper making progress is not stopped at the old 25 or 40 calls (${surface})`, { timeoutMs: 60000 }, async ($, on) => {
    const { h, d } = await begin(on, $, 'haiku')
    expect(limitOf(h), 'there is an estimate, so the spend limit applies').toBeDefined()
    const calls = await work(d, h, 'haiku', 45, 0.001)
    expect(calls.filter(r => r.deny), 'cheap calls go on past the flat cap').toEqual([])
    await d.complete('t1')
    const [line] = runLine(h)?.helpers ?? []
    expect(line?.calls).toBe(45)
    expect(line?.limit, 'the log keeps the limit').toBeGreaterThan(0)
    expect(line?.returned).toBeUndefined()
  })

  test(`Ask: the band asks at 80% of the limit, with no answer the helper goes on past it while it makes progress (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await begin(on, $, 'sonnet')
    h.answers = { [LONG]: NO_ONE }
    expect((await work(d, h, 'sonnet', 1, 0.45)).filter(r => r.deny), 'at 45% nothing is asked').toEqual([])
    expect(h.asked.filter(a => a.header === LONG)).toEqual([])
    expect((await work(d, h, 'sonnet', 1, 0.45)).filter(r => r.deny), 'at 90% the helper goes on while it is asked').toEqual([])
    const [q] = h.asked.filter(a => a.header === LONG)
    expect(q?.question).toMatch(/^Sonnet helper has spent \$[\d.]+ of its \$[\d.]+ limit and is still finding new things \(\d+ of its last \d+ calls were new\)\. Let it continue\?/)
    expect(q?.question, 'the first question carries the one-time hint').toContain('Default: ask. No answer means the helper goes on while it is making progress, up to 10 times its estimate, then stops and reports. To change it, use Long helpers in /config.')
    expect(q?.question, 'and says what no answer does').toMatch(/No answer: the helper goes on while it is making progress, up to \$[\d.]+, then stops and reports\./)
    expect(q?.options).toEqual(['Continue', 'Stop and report', "Always while it's making progress"])
    const over = await work(d, h, 'sonnet', 2, 0.45)
    expect(over.filter(r => r.deny), 'past the first limit, with no answer, it is not stopped').toEqual([])
    expect(log(h)).toMatch(/extended helper agent-helper's spend limit \$[\d.]+ → \$[\d.]+ \(no answer, making progress\)/)
    expect(log(h)).not.toContain('returned helper')
  })

  test(`Ask: with no answer a helper that keeps finding new things goes on to the hard cap (10x the estimate), then stops, and its report goes through (${surface})`, { timeoutMs: 60000 }, async ($, on) => {
    const { h, d } = await begin(on, $, 'sonnet')
    h.answers = { [LONG]: NO_ONE }
    const got = limitOf(h)
    expect(got?.multiple).toBe(2)
    // The limit is 2x the estimate and its blocks are 2x each, so the hard cap (10x) is the fifth block. Each request costs 0.85 of a block.
    const calls = await work(d, h, 'sonnet', 8, 0.85)
    const first = calls.findIndex(r => r.deny)
    expect(first, 'the first five blocks are taken without an answer: the sixth request is past the hard cap').toBe(5)
    expect(calls.slice(0, 5).filter(r => r.deny)).toEqual([])
    expect((log(h).match(/extended helper agent-helper's spend limit/g) ?? []).length, 'four extensions: 2x to 10x').toBe(4)
    expect(log(h)).toContain('(no answer, making progress)')
    const cap = (got?.estimate ?? 0) * 10
    expect(Math.abs(Number(/spend limit \(\$([\d.]+)\)/.exec(calls[first]?.deny ?? '')?.[1]) - cap), 'the stop names the hard cap').toBeLessThan(0.01)
    expect(calls[first]?.deny).toContain('next and only call must be SubagentHandback')
    expect(calls.slice(first).every(r => r.deny), 'it stays stopped').toBe(true)
    for (let i = 0; i < 2; i++) expect(((await d.handback('agent-helper')) as { deny?: string }).deny, 'its report goes through, even when tried again').toBeUndefined()
    await d.complete('t1')
    const run = runLine(h)
    expect(run?.helpers?.map(x => [x.stall, x.returned, Math.abs((x.limited ?? 0) - cap) / cap < 0.02, x.limit === x.limited])).toEqual([['struggling', true, true, true]])
    expect(run?.helpers?.map(x => x.calls), 'neither the report nor the refused calls are counted').toEqual([first])
  })

  test(`Ask: with no answer and no band to ask on, the helper goes on while it makes progress too (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await begin(on, $, 'sonnet')
    await d.config('band', 'off')
    const calls = await work(d, h, 'sonnet', 3, 0.45)
    expect(h.asked.filter(a => a.header === LONG), 'nothing can be asked').toEqual([])
    expect(calls.filter(r => r.deny), 'at 135% of the first limit it is still going').toEqual([])
    expect(log(h)).toContain('(no answer, making progress)')
  })

  test(`a stopped helper's report is delivered after a refused call (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await begin(on, $, 'sonnet')
    await d.config('longHelpers', 'stop at the limit')
    const calls = await work(d, h, 'sonnet', 3, 0.45)
    expect(calls[2]?.deny).toContain('spend limit')
    expect(((await d.bash('ls elsewhere', 'agent-helper')) as { deny?: string }).deny).toContain('spend limit')
    const sent = (await d.handback('agent-helper')) as { deny?: string; result?: { content?: string } }
    expect(sent.deny, 'the report is not refused').toBeUndefined()
    expect(sent.result?.content, 'it reaches the tool that delivers it').toBe('delivered')
  })

  test(`Ask: Continue adds one block, and the band asks again at 80% of the new limit; the hint shows once (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await begin(on, $, 'sonnet')
    h.answers = { [LONG]: 'Continue' }
    const calls = await work(d, h, 'sonnet', 3, 0.45)
    expect(calls.filter(r => r.deny), 'at 135% of the first limit it is still going: the limit is now two blocks').toEqual([])
    expect(log(h)).toMatch(/extended helper agent-helper's spend limit \$[\d.]+ → \$[\d.]+ \(you chose to continue\)/)
    expect((await work(d, h, 'sonnet', 2, 0.45)).filter(r => r.deny), 'at 225% it asks again at 80% of two blocks, and goes on to three').toEqual([])
    const qs = h.asked.filter(a => a.header === LONG)
    expect(qs.length, 'each extension asks again').toBe(2)
    expect(qs[0]?.question).toContain('Default: ask.')
    expect(qs[1]?.question, 'the hint does not come again').not.toContain('Default: ask.')
    h.answers = { [LONG]: NO_ONE }
    expect((await work(d, h, 'sonnet', 3, 0.45)).filter(r => r.deny), 'with no answer it goes on while it makes progress').toEqual([])
  })

  test(`Ask: Stop and report refuses the next call (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await begin(on, $, 'sonnet')
    h.answers = { [LONG]: 'Stop and report' }
    const calls = await work(d, h, 'sonnet', 3, 0.45)
    expect(calls[1]?.deny, 'the call that asked goes through').toBeUndefined()
    expect(calls[2]?.deny, 'the next call is refused').toContain('spend limit')
    expect(log(h)).toContain('stop and report, as you chose')
  })

  test(`Ask: Always while it's making progress sets the row and extends from then on (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await begin(on, $, 'sonnet')
    h.answers = { [LONG]: "Always while it's making progress" }
    expect((await work(d, h, 'sonnet', 4, 0.45)).filter(r => r.deny)).toEqual([])
    expect(h.asked.filter(a => a.header === LONG).length, 'asked once: the row now extends by itself').toBe(1)
    expect(JSON.stringify(h.configSet)).toContain('continue while making progress')
  })

  test(`Long helpers "continue while making progress" extends by itself up to 10x the estimate, then asks (${surface})`, { timeoutMs: 60000 }, async ($, on) => {
    const { h, d } = await begin(on, $, 'sonnet')
    await d.config('longHelpers', 'continue while making progress')
    h.answers = { [LONG]: NO_ONE }
    const got = limitOf(h)
    expect(got?.multiple).toBe(2)
    // 2x blocks: 2, 4, 6, 8 and 10x are taken without a question.
    const calls = await work(d, h, 'sonnet', 5, 0.85)
    expect(calls.filter(r => r.deny)).toEqual([])
    expect((log(h).match(/extended helper agent-helper's spend limit/g) ?? []).length, 'four automatic blocks').toBe(4)
    expect(h.asked.filter(a => a.header === LONG).length, 'at 10x it asks').toBe(1)
    expect(h.asked.find(a => a.header === LONG)?.question, 'the one-time hint still shows with the first question').toContain('Default: ask.')
    expect((await work(d, h, 'sonnet', 2, 0.85)).some(r => r.deny), 'no answer: it stops at 10x, the hard cap').toBe(true)
  })

  test(`Long helpers "stop at the limit" never asks or extends (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await begin(on, $, 'sonnet')
    await d.config('longHelpers', 'stop at the limit')
    const calls = await work(d, h, 'sonnet', 3, 0.45)
    expect(h.asked.filter(a => a.header === LONG)).toEqual([])
    expect(calls[1]?.deny, 'at 90% it goes on').toBeUndefined()
    expect(calls[2]?.deny, 'at the limit it stops').toContain('spend limit')
    expect(log(h)).not.toContain("extended helper agent-helper's")
  })

  test(`a report made exactly when the helper is at its limit goes through and does not send it back (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await begin(on, $, 'sonnet')
    await d.config('longHelpers', 'stop at the limit')
    // One request that costs more than the whole limit; the helper has made no call since.
    const block = limitOf(h)?.limit ?? 1
    h.stepUsage = { input_tokens: 0, output_tokens: Math.round(((block * 1.2) / PRICE.sonnet) * 1e6), cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    await d.step('t1', 1, 'agent-helper')
    expect(((await d.handback('agent-helper')) as { deny?: string }).deny).toBeUndefined()
    expect(log(h)).not.toContain('returned helper agent-helper')
  })

  test(`a refused call does not count: the denied approval steps of a helper leave its calls untouched (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await begin(on, $, 'haiku')
    for (let i = 0; i < 5; i++) expect(((await d.bash(`git push origin b${i}`, 'agent-helper')) as { deny?: string }).deny, 'refused as an approval step').toContain('cannot push')
    expect((await work(d, h, 'haiku', 3, 0.001)).filter(r => r.deny)).toEqual([])
    expect(last(h.sent)?.agentId).toBe('agent-helper')
    await d.complete('t1')
    expect(runLine(h)?.helpers?.map(x => x.calls)).toEqual([3])
  })
}
