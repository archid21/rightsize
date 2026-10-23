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
  agent: { spawn: (x: unknown) => Promise<unknown> }
  command: { run: (x: unknown) => Promise<Run> }
}

const LOOKUP = 'what does the parseConfig function in src/config.ts return exactly'
const DEBUG = 'find and fix the race in token refresh across the auth services please'
const SEARCH = 'find every call site of the old logger across the whole repo and list them'
const NO_CHANGE = '{"level":"medium","model":"same","size":"small","type":"lookup","read":2000,"write":300,"steps":1}'
const FREE_SWITCHES = { 'cache:effort-switch': { n: 20, ratio: 0 } }

const h$ = ($: { ui: { resolve: (e: never) => { Box: unknown } } }, e: unknown) => h($.ui.resolve(e as never).Box as never, {}) as never

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
    // A gateway's spend limit by default: billed per token, so reports show dollars.
    rateLimits: [{ kind: 'spend_limit', percentUsed: 1 }] as { kind: string; percentUsed: number }[],
    /** The session's cost ledger in dollars; undefined: the host keeps none. */
    ledger: 0 as number | undefined,
    stepCost: 0.01,
    /** Percent each main request adds to every rate-limit window. */
    windowStep: 0,
    ratingUsage: {} as Record<string, number>,
    spawned: [] as { description: string; model?: string }[],
  }
  on('session.start', async ($, e) => ({ cwd: e.cwd }) as never)
  on('command.register', async () => ({ value: undefined }) as never)
  on('clock.every', async () => ({ value: undefined }) as never)
  on('settings.read', async () => ({ value: {} }) as never)
  on('session.messages', async () => ({ value: [] }) as never)
  on('session.id', async () => ({ value: 'sess-1' }) as never)
  on('session.usage', async () => ({ value: { startedAt: 0, context: {}, rateLimits: h.rateLimits, ...(h.ledger === undefined ? {} : { cost: { usd: h.ledger } }) } }) as never)
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
    // The rating call is priced too; the turn's measured cost leaves it out.
    if (h.ledger !== undefined) h.ledger += 0.5
    return { value: { isAnswered: true, text: h.rating, usage: h.ratingUsage } } as never
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
  ;(on as unknown as LooseOn)('tool.call', { tool: 'Workflow' }, async () => ({ result: { content: 'started in the background' } }))
  on('agent.spawn', async ($, e) => {
    h.spawned.push({ description: e.description, model: e.model })
    return { model: e.model ?? h.subModel, agentId: `agent-${e.description}` } as never
  })
  on('prompt.submit', async ($, e) => {
    h.submitted.push({ text: e.text, context: e.context })
    return { text: e.text } as never
  })
  ;(on as unknown as LooseStep)('turn.step', async function* (_$, e) {
    h.sent.push({ effort: e.effort, agentId: e.agentId, turnId: e.turnId })
    if (h.ledger !== undefined) h.ledger += h.stepCost
    if (!e.agentId && h.windowStep) h.rateLimits = h.rateLimits.map(l => ({ ...l, percentUsed: l.percentUsed + h.windowStep }))
    const usage = { input_tokens: 200, output_tokens: 400, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 300 }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: { ...usage, model: e.agentId ? h.subModel : h.model } } as never
  })
  on('turn.complete', async () => ({ text: '' }) as never)
  // The engine's own band above the prompt: an empty row.
  on('ui.render', ($, e) => h$($, e))
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
    workflow: () => e.tool.call({ tool: 'Workflow', script: 'export const meta = {}' }),
    // The engine starting a subagent from the main chat's Agent call; its steps carry `agent-<description>`.
    spawn: (description: string, model?: string, over: Record<string, unknown> = {}) =>
      e.agent.spawn({ prompt: 'brief', description, subagentType: 'general-purpose', provider: { kind: 'core' }, parentModel: h.model, background: false, fork: false, ...(model ? { model } : {}), ...over }),
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

const BAND = {
  plugin: 'rightsize',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const
type Mounted = {
  find: (q: object) => Promise<{ text?: string } | undefined>
  findAll: (q: object) => Promise<{ key?: string }[]>
  press: (t: object) => Promise<unknown>
  unmount: () => Promise<void>
}
const mount = ($: unknown, surface: string) => ($ as { ui: { mount: (x: unknown) => Promise<Mounted> } }).ui.mount({ ...BAND, surface })
// The band's line as drawn, or '' when it draws nothing.
async function bandText($: unknown, surface: string) {
  const ui = await mount($, surface)
  const text = (await ui.find({ type: 'Text', text: /rightsize:/ }))?.text ?? ''
  await ui.unmount()
  return text
}
const setBand = ($: unknown, value: string) => ($ as { config: { set: (x: unknown) => Promise<unknown> } }).config.set({ key: 'rightsize.band', value })
const LOWER = '{"level":"low","model":"same","size":"small","type":"lookup","read":2000,"write":3000,"steps":1,"reason":"one function lookup"}'

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

    // Calibration: t1 stepped back up and teaches nothing; t2 is stored.
    const cal = h.store.calibration as Record<string, { n: number }>
    expect(cal['lookup:main']?.n, 'one measured lookup turn').toBe(1)
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
    expect(await bandText($, surface), 'the band carries the result').toMatch(/^rightsize: Sent to Fable: \$[\d.]+ vs about \$[\d.]+ on Opus \(estimated\)/)
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
    expect(await bandText($, surface)).toContain('did not hand this to a Haiku subagent')

    // Next time: no question, and the subagent's cost is counted.
    await d.submit(SEARCH)
    expect(h.asked.length).toBe(2)
    await d.step('t2', 0)
    await d.agent('haiku')
    await d.step('t2', 0, 'a2')
    await d.step('t2', 1)
    await d.complete('t2')
    expect(await bandText($, surface)).toMatch(/^rightsize: Sent to Haiku: .* on Fable \(estimated\), saved about \d+%\.$/)
  })

  test(`counts a hand-off whose Agent call names the full model id (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')

    h.rating = '{"fit":{"haiku":"high","sonnet":"high","opus":"high","fable":"medium"},"size":"small","type":"feature","read":20000,"write":2000,"steps":6,"reason":"small helper with tests"}'
    h.answers = { Cheaper: 'Send it to a cheaper subagent (Recommended)', Remember: 'Just this session' }
    await d.submit(DEBUG)
    h.subModel = 'claude-haiku-5-5'
    await d.step('t1', 0)
    await d.agent('claude-haiku-5-5')
    await d.spawn('helper', 'claude-haiku-5-5')
    await d.step('t1', 0, 'agent-helper')
    await d.step('t1', 1)
    await d.complete('t1')
    expect(h.sent.find(s => s.agentId === 'agent-helper')?.effort).toBe('high')
    const runs = (h.files['/home/test/.claude/mods-logs/rightsize-runs.jsonl'] ?? '').trim().split('\n')
    expect((JSON.parse(last(runs) ?? '{}') as { route?: string }).route).toBe('delegate:haiku')
  })

  test(`on Opus at medium, hands work Haiku can do at high to Haiku at high, and runs it there (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')

    h.rating = '{"fit":{"haiku":"high","sonnet":"high","opus":"high","fable":"medium"},"size":"small","type":"feature","read":20000,"write":2000,"steps":6,"reason":"small helper with tests"}'
    h.answers = { Cheaper: 'Send it to a cheaper subagent (Recommended)', Remember: 'Just this session' }
    await d.submit(DEBUG)
    expect(h.asked.map(a => a.header), 'Q4, not Q2: a cheaper model, not more effort').toEqual(['Cheaper', 'Remember'])
    const note = last(h.submitted)?.context?.join('\n') ?? ''
    expect(note).toContain('model "haiku", effort "high"')
    expect(await bandText($, surface)).toMatch(/^rightsize: Sending this to a Haiku subagent at high effort instead of raising Opus to high\. About \$[\d.]+ that way vs \$[\d.]+ on Opus/)

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
    const cal = h.store.calibration as Record<string, { n: number }>
    expect(['feature:delegate', 'feature:delegate:haiku', 'feature:delegate:haiku:high'].map(k => cal[k]?.n)).toEqual([1, 1, 1])
    const runs = (h.files['/home/test/.claude/mods-logs/rightsize-runs.jsonl'] ?? '').trim().split('\n')
    const line = JSON.parse(last(runs) ?? '{}') as { route?: string; subLevel?: string; fit?: unknown }
    expect(line.route).toBe('delegate:haiku')
    expect(line.subLevel).toBe('high')
    expect(line.fit).toEqual({ haiku: 'high', sonnet: 'high', opus: 'high', fable: 'medium' })
    expect((await d.command('')).text ?? '', 'the run count counts the run once').toContain('Calibration: 1 measured run(s).')
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
    expect(await bandText($, surface)).toBe("rightsize: Ran Claude's subagent on Haiku (low) instead of Opus.")
    const runs = (h.files['/home/test/.claude/mods-logs/rightsize-runs.jsonl'] ?? '').trim().split('\n')
    const line = JSON.parse(last(runs) ?? '{}') as { route?: string; resized?: unknown }
    expect(line.route, 'not a hand-off').toBe('main')
    expect(line.resized).toEqual([{ from: 'opus', tier: 'haiku', level: 'low', type: 'search' }])

    // A later turn's step of the same subagent (a background one) still runs at its level.
    await d.submit(LOOKUP)
    await d.step('t2', 0)
    await d.step('t2', 0, 'agent-lister')
    expect(last(h.sent)?.effort).toBe('low')
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

  test(`a workflow pauses hand-offs and learning for the session, and the report lists it (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-fable-5-1', effort: 'high' })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    const keys = ['lookup:main', 'lookup:main:fable', 'lookup:main:fable:high']
    const learned = () => keys.map(k => (h.store.calibration as Record<string, { n: number }> | undefined)?.[k]?.n)

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
    h.answers = { Lowering: 'Never lower', Cheaper: 'Send it to a cheaper subagent (Recommended)', Remember: 'Just this session' }
    await d.submit(SEARCH)
    expect(h.asked.map(a => a.header), 'no hand-off question').not.toContain('Cheaper')
    expect(last(h.submitted)?.context ?? [], 'no hand-off note').toEqual([])
    await d.step('t3')
    await d.complete('t3')
    expect(learned()).toEqual([1, 1, 1])
    const lines = (h.files['/home/test/.claude/mods-logs/rightsize-runs.jsonl'] ?? '').trim().split('\n').map(l => JSON.parse(l) as { workflows?: number; afterWorkflow?: boolean })
    expect(lines.map(l => [l.workflows ?? 0, l.afterWorkflow ?? false])).toEqual([[0, false], [1, true], [0, true]])
    h.now = Date.now()
    expect((await d.command('report')).text ?? '').toContain('2 turns ran during or after a workflow (1 workflow, ultracode or asked for)')

    // A new session hands off again.
    await d.start(surface)
    await d.step('t4')
    await d.complete('t4')
    const before = h.asked.length
    await d.submit(SEARCH)
    expect(h.asked.slice(before).map(q => q.header)).toContain('Cheaper')
    expect(last(h.submitted)?.context?.join('\n') ?? '').toContain('model "haiku"')
  })

  test(`the band shows a change, and its buttons change the rule and undo it (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { calibration: FREE_SWITCHES } })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    expect(await bandText($, surface), 'nothing to show yet').toBe('')

    h.rating = LOWER
    h.answers = { Lowering: 'Lower automatically', Remember: 'Just this session' }
    await d.submit(LOOKUP)
    expect(await bandText($, surface)).toBe('rightsize: Effort lowered: medium → low for this prompt (automatically).')
    const ui = await mount($, surface)
    expect((await ui.findAll({ type: 'Button' })).map(b => b.key)).toEqual(['undo', 'rule-ask', 'rule-never', 'mode', 'close'])

    // A rule button changes the answer to Q1 in one press.
    await ui.press({ key: 'rule-ask' })
    expect(last(h.toasts)).toBe('Rightsize: Lowering is now "Ask me each time".')
    expect((await d.command('')).text ?? '').toContain('Lowering: ask.')
    expect((await ui.findAll({ type: 'Button' })).map(b => b.key), 'the new rule is not offered again').toEqual(['undo', 'rule-auto', 'rule-never', 'mode', 'close'])

    // Undo puts the prompt back in the box and closes the band.
    await ui.press({ key: 'undo' })
    expect(h.filled[0]).toBe(LOOKUP)
    expect(last(h.toasts) ?? '').toContain('run it at medium')
    await ui.unmount()
    expect(await bandText($, surface)).toBe('')
  })

  test(`the Band setting: when it acts, always, off, and the ⋯ and × buttons (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { calibration: FREE_SWITCHES } })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')

    // "when it acts" (the default): no change, no band.
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    expect(await bandText($, surface)).toBe('')

    // "always": the same prompt shows that nothing changed.
    await setBand($, 'always')
    expect(await bandText($, surface)).toBe('rightsize: No change: medium on Opus fits this prompt.')

    // × closes it until the next prompt.
    let ui = await mount($, surface)
    await ui.press({ key: 'close' })
    await ui.unmount()
    expect(await bandText($, surface)).toBe('')
    await d.submit(LOOKUP)
    expect(await bandText($, surface)).toContain('No change')

    // ⋯ asks when the band should show, and saves the answer in /config.
    h.answers = { Band: 'Never (status line only)' }
    ui = await mount($, surface)
    await ui.press({ key: 'mode' })
    await ui.unmount()
    expect(last(h.configSet)).toBe('off')
    expect(await bandText($, surface)).toBe('')

    // "off": a hand-off result goes back to a transcript line.
    h.rating = '{"level":"high","model":"fable","size":"small","type":"debug","read":30000,"write":4000,"steps":12,"reason":"subtle concurrency bug"}'
    h.answers = { Stronger: 'Send it to a subagent automatically', Remember: 'Just this session' }
    await d.submit(DEBUG)
    await d.step('t1')
    await d.complete('t1')
    expect(await bandText($, surface)).toBe('')
    expect(last(h.logs) ?? '').toContain('did not hand this to a Fable subagent')
  })

  test(`adds its calibration to what another session saved, and skips turns that stepped up (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { calibration: FREE_SWITCHES } })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')

    // Another session saves its runs after this one loaded the calibration.
    h.store.calibration = { ...FREE_SWITCHES, 'debug:main': { n: 3, ratio: 2 } }
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    await d.step('t1')
    await d.complete('t1')
    let cal = h.store.calibration as Record<string, { n: number }>
    expect(cal['debug:main']?.n, "the other session's runs are kept").toBe(3)
    expect(cal['lookup:main']?.n, "this session's run is added").toBe(1)
    expect(cal['cache:effort-switch']?.n, 'the switch record is kept').toBe(20)

    // An auto-lowered turn that steps back up teaches nothing.
    h.rating = LOWER
    h.answers = { Lowering: 'Lower automatically', Remember: 'Just this session' }
    await d.submit(LOOKUP)
    await d.step('t2', 0)
    await d.step('t2', 5)
    await d.complete('t2')
    cal = h.store.calibration as Record<string, { n: number }>
    expect(cal['lookup:main']?.n, 'the stepped-up turn is not counted').toBe(1)
  })

  test(`uses the hand-off and lowering thresholds set in /config (${surface})`, { timeoutMs: 30000, options: { handOff: '50%', lowering: '80%' } }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    expect((await d.command('')).text ?? '').toContain('Thresholds: hand off under 50% of staying, lower under 80%.')
  })

  test(`says the thresholds are the defaults when none are set (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    expect((await d.command('')).text ?? '').toContain('Thresholds: hand off under 70% of staying, lower under 90% (the defaults).')
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

  test(`reads a subscription off the rate limits and does not ask (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    h.rateLimits = [{ kind: 'five_hour', percentUsed: 12 }, { kind: 'seven_day', percentUsed: 3 }]
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    expect(h.store.billing).toEqual({ value: 'subscription', by: 'detected' })
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    expect(h.asked.length, 'no billing question').toBe(0)
    expect((await d.command('')).text ?? '').toContain('Billing: subscription (detected)')
  })

  test(`asks about billing only after a response says nothing, and keeps the answer (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    h.rateLimits = []
    h.rating = NO_CHANGE
    h.answers = { Billing: 'API (pay per token)' }
    await d.start(surface)
    await d.submit(LOOKUP)
    expect(h.asked.length, 'no response read yet: nothing to ask on').toBe(0)
    await d.step('t1')
    await d.complete('t1')

    await d.submit(LOOKUP)
    expect(h.asked.map(a => a.header)).toEqual(['Billing'])
    expect(h.store.billing).toEqual({ value: 'api', by: 'answered' })
    await d.submit(LOOKUP)
    expect(h.asked.length, 'asked once').toBe(1)

    // A new session keeps the answer while the rate limits still say nothing.
    await d.start(surface)
    await d.step('t2')
    await d.complete('t2')
    await d.submit(LOOKUP)
    expect(h.asked.length).toBe(1)

    // Rate limits that show a subscription win over the old answer.
    h.rateLimits = [{ kind: 'five_hour', percentUsed: 1 }]
    await d.step('t3')
    await d.complete('t3')
    expect(h.store.billing).toEqual({ value: 'subscription', by: 'detected' })
  })

  test(`measures a turn's cost off the session's cost ledger, leaving out the rating (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    const runs = () =>
      (h.files['/home/test/.claude/mods-logs/rightsize-runs.jsonl'] ?? '')
        .trim()
        .split('\n')
        .map(l => JSON.parse(l) as { actual: number; measured: string; tokens: number })
    await d.start(surface)
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    await d.step('t1', 0)
    await d.step('t1', 1)
    await d.complete('t1')
    expect(last(runs())?.measured).toBe('ledger')
    expect(last(runs())?.actual, 'two requests at $0.01, the $0.50 rating left out').toBe(0.02)

    // No ledger: the token counts priced from prices.json.
    h.ledger = undefined
    await d.submit(LOOKUP)
    await d.step('t2')
    await d.complete('t2')
    const r = last(runs())
    expect(r?.measured).toBe('tokens')
    expect(r?.actual).toBe(r?.tokens)
  })

  test(`logs every rated turn with its change, overhead and windows, and /rightsize report adds them up (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { calibration: FREE_SWITCHES } })
    const d = drive($, h)
    const runs = () =>
      (h.files['/home/test/.claude/mods-logs/rightsize-runs.jsonl'] ?? '')
        .trim()
        .split('\n')
        .map(l => JSON.parse(l) as { kind: string; session: string; change: string; offered: string; overhead: number; before?: Record<string, number>; after?: Record<string, number> })
    // The log's times are the wall clock's: the report's periods count from now.
    h.now = Date.now()
    h.rateLimits = [{ kind: 'five_hour', percentUsed: 10 }]
    h.windowStep = 1
    h.ratingUsage = { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')

    // Unchanged: still logged.
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    await d.step('t1')
    await d.complete('t1')
    const first = last(runs())
    expect(first?.kind).toBe('run')
    expect(first?.session).toBe('sess-1')
    expect(first?.change).toBe('none')
    expect(first?.overhead, '1000 in and 100 out on Haiku').toBe(0.00015)
    expect(first?.before).toEqual({ five_hour: 11 })
    expect(first?.after).toEqual({ five_hour: 12 })

    // Lowered on its own.
    h.rating = '{"level":"low","model":"same","size":"small","type":"lookup","read":2000,"write":3000,"steps":1}'
    h.answers = { Lowering: 'Lower automatically', Remember: 'Just this session' }
    await d.submit(LOOKUP)
    await d.step('t2')
    await d.complete('t2')
    expect(last(runs())?.change).toBe('lower')
    expect(last(runs())?.offered).toBe('lower')

    // A rating that comes to nothing: its cost is logged alone.
    h.rating = 'no json here'
    await d.submit(LOOKUP)
    expect(last(runs())?.kind).toBe('overhead')

    const report = (await d.command('report')).text ?? ''
    expect(report).toContain('This session: 2 prompts rated, 1 changed (1 lowered).')
    expect(report).toContain('Last 7 days: 2 prompts rated')
    expect(report).toContain('rating calls')
    expect(report).toContain('What went wrong (last 30 days):')
  })
}
