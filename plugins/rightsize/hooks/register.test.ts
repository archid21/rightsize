import { type TestBody, expect, test } from 'claude-code/testing'

// Typed loosely: the AskUserQuestion matcher's full type is too deep for tsc.
type AskInput = { questions: { question: string; header?: string; options?: { label: string }[] }[] }
type LooseOn = (event: string, match: object, hook: (_$: unknown, e: AskInput) => Promise<unknown>) => void
type StepInput = { effort?: string; turnId: string; index: number; agentId?: string }
type LooseStep = (event: string, hook: (_$: unknown, e: StepInput) => AsyncGenerator<never, unknown>) => void
type Run = { text?: string }
type Engine = {
  session: { start: (x: unknown) => Promise<unknown> }
  prompt: { submit: (x: unknown) => Promise<unknown> }
  turn: { step: (x: unknown) => unknown; complete: (x: unknown) => Promise<unknown> }
  tool: { call: (x: unknown) => Promise<unknown> }
  command: { run: (x: unknown) => Promise<Run> }
}

const LOOKUP = 'what does the parseConfig function in src/config.ts return exactly'
const DEBUG = 'find and fix the race in token refresh across the auth services please'
const SEARCH = 'find every call site of the old logger across the whole repo and list them'
const FREE_SWITCHES = { 'cache:effort-switch': { n: 20, ratio: 0 } }

// Stands for the engine beneath the plugin, and records what reaches it.
function engine(on: Parameters<TestBody>[1], start: { model: string; effort: string; store?: Record<string, unknown> }) {
  const h = {
    model: start.model,
    effort: start.effort,
    subModel: 'claude-haiku-5-5',
    rating: '{"level":"medium"}',
    answers: {} as Record<string, string>,
    asked: [] as { header: string; question: string; options: string[] }[],
    sent: [] as { effort?: string; agentId?: string; turnId: string }[],
    submitted: [] as { text: string; context?: readonly string[] }[],
    logs: [] as string[],
    filled: [] as string[],
    store: { ...(start.store ?? {}) } as Record<string, unknown>,
    ratings: 0,
    now: 1_800_000_000_000,
    page: '',
    fetches: 0,
    hold: null as Promise<void> | null,
    fetchFails: false,
    pricesFile: '',
    backup: '',
    files: {} as Record<string, string>,
    toasts: [] as string[],
    configSet: [] as unknown[],
  }
  on('session.start', async ($, e) => ({ cwd: e.cwd }) as never)
  on('command.register', async () => ({ value: undefined }) as never)
  on('clock.every', async () => ({ value: undefined }) as never)
  on('settings.read', async () => ({ value: {} }) as never)
  on('session.messages', async () => ({ value: [] }) as never)
  on('fs.exists', async ($, e) => {
    const { path } = e as { path: string }
    return { value: path.endsWith('/prices.json') ? h.pricesFile !== '' : path in h.files } as never
  })
  on('fs.read', async ($, e) => {
    const { path } = e as { path: string }
    return { value: path.endsWith('/prices.json') ? h.pricesFile : (h.files[path] ?? '') } as never
  })
  on('fs.write', async ($, e) => {
    const { path, text } = e as { path: string; text: string }
    if (path.endsWith('/prices.json')) h.pricesFile = text
    if (path.endsWith('/prices.json.bak')) h.backup = text
    if (path.includes('/mods-logs/')) h.files[path] = text
    return { value: undefined } as never
  })
  on('clock.now', async () => ({ value: h.now }) as never)
  on('env.get', async ($, e) => ({ value: (e as { name: string }).name === 'HOME' ? '/home/test' : undefined }) as never)
  on('http.fetch', async () => {
    h.fetches += 1
    if (h.hold) await h.hold
    if (h.fetchFails) return { value: { status: 503, ok: false, headers: {}, text: '' } } as never
    return { value: { status: 200, ok: true, headers: {}, text: h.page } } as never
  })
  on('ui.toast', async ($, e) => {
    h.toasts.push((e as { text: string }).text)
    return { value: undefined } as never
  })
  on('config.set', async ($, e) => {
    h.configSet.push((e as { value: unknown }).value)
    return { value: (e as { value: unknown }).value } as never
  })
  on('process.run', async () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }) as never)
  on('ui.status', async () => ({ value: undefined }) as never)
  on('ui.log', async ($, e) => {
    h.logs.push((e as { text: string }).text)
    return { value: undefined } as never
  })
  on('store.get', async ($, e) => ({ value: h.store[(e as { key: string }).key] }) as never)
  on('store.set', async ($, e) => {
    const { key, value } = e as { key: string; value: unknown }
    h.store[key] = value
    return { value: undefined } as never
  })
  on('prompt.fill', async ($, e) => {
    h.filled.push((e as { text: string }).text)
    return { isFilled: true } as never
  })
  on('model.complete', async () => {
    h.ratings += 1
    return { value: { isAnswered: true, text: h.rating, usage: {} } } as never
  })
  ;(on as unknown as LooseOn)('tool.call', { tool: 'AskUserQuestion' }, async (_$, e) => {
    const q = e.questions[0]
    const header = q?.header ?? ''
    h.asked.push({ header, question: q?.question ?? '', options: (q?.options ?? []).map(o => o.label) })
    const answer = h.answers[header]
    if (answer === undefined) return { deny: `no answer set for ${header}` }
    return { result: { questions: e.questions, answers: { [q?.question ?? '']: answer } } }
  })
  ;(on as unknown as LooseOn)('tool.call', { tool: 'Agent' }, async () => ({ result: { content: 'done' } }))
  on('prompt.submit', async ($, e) => {
    h.submitted.push({ text: e.text, context: e.context })
    return { text: e.text } as never
  })
  ;(on as unknown as LooseStep)('turn.step', async function* (_$, e) {
    h.sent.push({ effort: e.effort, agentId: e.agentId, turnId: e.turnId })
    const usage = { input_tokens: 200, output_tokens: 400, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 300 }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: { ...usage, model: e.agentId ? h.subModel : h.model } } as never
  })
  on('turn.complete', async () => ({ text: '' }) as never)
  return h
}

const drive = ($: unknown, h: ReturnType<typeof engine>) => {
  const e = $ as Engine
  return {
    start: (surface: string) => e.session.start({ source: 'startup', cwd: '/tmp', surface, isInteractive: true }),
    submit: (text: string) => e.prompt.submit({ text, origin: { kind: 'composer' }, wait: false }),
    step: async (turnId: string, index = 0, agentId?: string) => {
      const it = e.turn.step({ turnId, index, model: h.model, effort: h.effort, messageCount: 1, ...(agentId ? { agentId } : {}) })
      for await (const _ of it as AsyncIterable<unknown>) void _
    },
    complete: (turnId: string) => e.turn.complete({ turnId, answer: '', durationMs: 1, isAborted: false, reason: 'answer' }),
    agent: (model: string) => e.tool.call({ tool: 'Agent', description: 'x', prompt: 'brief', model }),
    configSet: (value: string) => (e as unknown as { config: { set: (x: unknown) => Promise<unknown> } }).config.set({ key: 'rightsize.priceCheck', value }),
    command: (args: string) => e.command.run({ command: 'rightsize', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } }),
  }
}

// The test runner has timers; the hook environment's types do not declare them.
const timers = globalThis as unknown as { setTimeout: (f: () => void, ms: number) => unknown }
const flush = () => new Promise<void>(resolve => timers.setTimeout(resolve, 20))
const DAY = 24 * 60 * 60 * 1000
const PAGE = [
  '| Claude Fable 5.1 | $10 / MTok | $12.50 / MTok | $20 / MTok | $0.25 / MTok | $50 / MTok |',
  '| Claude Opus 5.5 | $4 / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok | $20 / MTok |',
  '| Claude Sonnet 5.5 | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.10 / MTok | $10 / MTok |',
  '| Claude Haiku 5.5 (for prompts up to 100,000 tokens) | $0.10 / MTok | $0.125 / MTok | $0.20 / MTok | $0.01 / MTok | $0.50 / MTok |',
].join('\n')
const OLD_PRICES = JSON.stringify({
  cacheTtl: '5m',
  models: {
    haiku: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite5m: 0.125, cacheWrite1h: 0.2 },
    sonnet: { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
    opus: { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 },
    fable: { input: 10, output: 50, cacheRead: 0.25, cacheWrite5m: 12.5, cacheWrite1h: 20 },
  },
})

const last = <T>(xs: readonly T[]) => xs[xs.length - 1]

for (const surface of ['desktop', 'terminal'] as const) {
  test(`asks Q1 once, lowers on its own after, steps up when the turn gets long, and undoes (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { calibration: FREE_SWITCHES } })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')

    h.rating = '{"level":"low","model":"same","size":"small","type":"lookup","read":2000,"write":3000,"steps":1,"reason":"one function lookup"}'
    h.answers = { Lowering: 'Lower automatically', Remember: 'Just this session' }
    await d.submit(LOOKUP)
    expect(h.asked.map(a => a.header), 'Q1, then the remember question').toEqual(['Lowering', 'Remember'])
    await d.step('t1', 0)
    expect(last(h.sent)?.effort, 'runs low').toBe('low')
    await d.step('t1', 5)
    expect(last(h.sent)?.effort, 'back to medium on step 6').toBe('medium')
    await d.complete('t1')
    expect(h.store.remember, 'just this session: not saved').toBeUndefined()

    // Same situation again: no question, lowered on its own.
    await d.submit(LOOKUP)
    expect(h.asked.length, 'no new question').toBe(2)
    await d.step('t2')
    expect(last(h.sent)?.effort).toBe('low')
    await d.complete('t2')

    // Undo puts the prompt back; sending it again runs it unrated at medium.
    const undo = await d.command('undo')
    expect(undo.text ?? '').toContain('run it at medium')
    expect(h.filled[0]).toBe(LOOKUP)
    const rated = h.ratings
    await d.submit(LOOKUP)
    expect(h.ratings, 'the re-run is not rated').toBe(rated)
    await d.step('t3')
    expect(last(h.sent)?.effort).toBe('medium')
    await d.complete('t3')

    // Each effort switch leaves one line of evidence: low, back to medium, low, medium.
    const switches = h.files['/home/test/.claude/mods-logs/rightsize-switches.jsonl'] ?? ''
    expect(Object.keys(h.files).every(k => k.startsWith('/home/test/.claude/mods-logs/')), 'logs go to HOME, wherever the plugin lives').toBe(true)
    const lines = switches.trim().split('\n').map(l => JSON.parse(l) as { from: string; to: string; kept: boolean })
    expect(lines.map(l => `${l.from}>${l.to}`)).toEqual(['medium>low', 'low>medium', 'medium>low', 'low>medium'])
    expect(lines.every(l => l.kept), 'the fake engine keeps the cache').toBe(true)

    // Calibration: every measured main turn is stored.
    const cal = h.store.calibration as Record<string, { n: number }>
    expect(cal['lookup:main']?.n, 'two measured lookup turns').toBe(2)
  })

  test(`asks Q2 for more effort, and does not lower when the cache would cost more (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')

    h.rating = '{"level":"high","model":"same","type":"debug","read":20000,"write":3000,"steps":8,"reason":"unknown cause"}'
    h.answers = { Raising: 'Raise automatically (Recommended)', Remember: 'Yes, from now on' }
    await d.submit(DEBUG)
    expect(h.asked.map(a => a.header)).toEqual(['Raising', 'Remember'])
    await d.step('t1')
    expect(last(h.sent)?.effort).toBe('high')
    await d.complete('t1')
    expect(h.store.remember, 'saved for every session').toBe(true)
    expect(h.store.choices).toEqual({ raise: 'auto' })

    // A lookup with the prior "switches miss the cache": not worth lowering, so no Q1.
    h.rating = '{"level":"low","model":"same","type":"lookup","read":2000,"write":300,"steps":1}'
    await d.submit(LOOKUP)
    expect(h.asked.length, 'no question when nothing would change').toBe(2)
    await d.step('t2')
    expect(last(h.sent)?.effort).toBe('medium')
    await d.complete('t2')

    // A new session loads the saved answers: Q2 is not asked again.
    await d.start(surface)
    await d.step('t3')
    await d.complete('t3')
    h.rating = '{"level":"xhigh","model":"same","type":"refactor"}'
    await d.submit(DEBUG)
    expect(h.asked.length).toBe(2)
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
    h.answers = { Stronger: 'Ask before sending it to a subagent (Recommended)', Remember: 'Just this session', Subagent: 'Send it to a Fable subagent' }
    await d.submit(DEBUG)
    expect(h.asked.map(a => a.header)).toEqual(['Stronger', 'Remember', 'Subagent'])
    expect(h.asked[2]?.question ?? '', 'the question carries both costs').toMatch(/About \$[\d.]+ that way vs \$[\d.]+ on Opus/)
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
    expect(last(h.logs) ?? '').toMatch(/^rightsize: Sent to Fable: \$[\d.]+ vs about \$[\d.]+ on Opus \(estimated\)/)
    const cal = h.store.calibration as Record<string, { n: number }>
    expect(cal['debug:delegate']?.n).toBe(1)
  })

  test(`Q4 hands a big search on Fable down to Haiku, and says so when Claude does not (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-fable-5-1', effort: 'high' })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')

    h.rating = '{"level":"low","model":"haiku","size":"bulky","type":"search","read":150000,"write":3000,"steps":30,"reason":"repo-wide search"}'
    h.answers = { Cheaper: 'Send it to a cheaper subagent (Recommended)', Remember: 'Just this session' }
    await d.submit(SEARCH)
    expect(h.asked.map(a => a.header)).toEqual(['Cheaper', 'Remember'])
    const note = last(h.submitted)?.context?.join('\n') ?? ''
    expect(note).toContain('model "haiku"')
    expect(note).toContain('finish the task yourself')

    // Claude answered without the subagent: the report says so.
    await d.step('t1')
    await d.complete('t1')
    expect(last(h.logs) ?? '').toContain('did not hand this to a Haiku subagent')

    // Next time: no question, and the subagent's cost is counted.
    await d.submit(SEARCH)
    expect(h.asked.length).toBe(2)
    await d.step('t2', 0)
    await d.agent('haiku')
    await d.step('t2', 0, 'a2')
    await d.step('t2', 1)
    await d.complete('t2')
    expect(last(h.logs) ?? '').toMatch(/^rightsize: Sent to Haiku: .* on Fable \(estimated\), saved about \d+%\.$/)
  })

  test(`skips short prompts, slash commands, other senders, and when off in /mods (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    await d.submit('yes go ahead')
    await d.submit('/rightsize show me the current level please')
    await ($ as unknown as Engine).prompt.submit({ text: DEBUG, origin: { kind: 'task-notification' }, wait: false })
    expect(h.ratings).toBe(0)
    const status = await d.command('')
    expect(status.text ?? '').toContain('Lowering: not asked yet')
  })

  test(`checks prices every 30 days, on /rightsize prices, and on "check now" in /config (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { pricesCheckedAt: 1_800_000_000_000 - DAY } })
    const d = drive($, h)
    h.page = PAGE
    h.pricesFile = OLD_PRICES
    await d.start(surface)
    await flush()
    expect(h.fetches, 'checked yesterday: not due').toBe(0)

    const r = await d.command('prices')
    expect(h.fetches).toBe(1)
    expect(r.text ?? '').toContain('Sonnet 5.5 cache read: $0.2 → $0.1')
    expect(h.backup, 'old file kept').toBe(OLD_PRICES)
    expect((JSON.parse(h.pricesFile) as { models: { sonnet: { cacheRead: number } } }).models.sonnet.cacheRead).toBe(0.1)
    expect(last(h.logs) ?? '').toContain('Prices updated')
    expect(h.store.pricesCheckedAt).toBe(h.now)

    // "check now" in /config: checks, and the row goes back to monthly.
    await d.configSet('check now')
    await flush()
    expect(h.configSet, 'the row is written as monthly').toEqual(['monthly'])
    expect(h.fetches).toBe(2)
    expect(last(h.toasts) ?? '').toContain('no change')

    // 31 days on, the next session start checks by itself.
    h.now += 31 * DAY
    await d.start(surface)
    await flush()
    expect(h.fetches).toBe(3)

    // A page that moved: nothing is written, and the check is not marked done.
    h.page = '<html>moved</html>'
    h.now += 31 * DAY
    const before = h.pricesFile
    const moved = await d.command('prices')
    expect(moved.text ?? '').toContain('found 0 of 4 models')
    expect(h.pricesFile).toBe(before)
    expect(h.store.pricesCheckedAt, 'still due').not.toBe(h.now)
  })

  test(`claims the monthly check before fetching, and gives the claim back when it fails (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const lastMonth = 1_800_000_000_000 - 31 * DAY
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { pricesCheckedAt: lastMonth } })
    const d = drive($, h)
    h.page = PAGE
    h.pricesFile = OLD_PRICES
    let release = () => {}
    h.hold = new Promise<void>(resolve => {
      release = resolve
    })
    await d.start(surface)
    await flush()
    expect(h.fetches).toBe(1)
    // Another session starting now reads this and finds the check not due.
    expect(h.store.pricesCheckedAt, 'claimed while the page is still loading').toBe(h.now)
    release()
    await flush()
    expect(h.store.pricesCheckedAt).toBe(h.now)

    // 31 days on, the page fails: the claim goes back, so the next start tries again.
    h.hold = null
    h.fetchFails = true
    h.now += 31 * DAY
    const claimedFrom = h.store.pricesCheckedAt
    await d.start(surface)
    await flush()
    expect(h.fetches).toBe(2)
    expect(h.store.pricesCheckedAt, 'given back: still due').toBe(claimedFrom)
  })
}
