import { type TestBody, expect, test } from 'claude-code/testing'
import { CAL_FULL, CAL_STORE, DEFAULT_PRICES, type Calibration, type Rating, type Situation, delegateCost, delegateKeys, plan, sizeSubagent, subagentKeys, subWork } from './cost'

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
    /** POST requests: the sharing sends. */
    posts: [] as { url: string; body: string }[],
    env: {} as Record<string, string>,
    hold: null as Promise<void> | null,
    fetchFails: false,
    pricesFile: '',
    backup: '',
    files: {} as Record<string, string>,
    toasts: [] as string[],
    configSet: [] as unknown[],
    // A gateway's spend limit by default: billed per token, so reports show dollars.
    rateLimits: [{ kind: 'spend_limit', percentUsed: 1 }] as { kind: string; percentUsed: number; resetsAt?: string }[],
    /** The session's cost ledger in dollars; undefined: the host keeps none. */
    ledger: 0 as number | undefined,
    stepCost: 0.01,
    /** Percent each main request adds to every rate-limit window. */
    windowStep: 0,
    ratingUsage: {} as Record<string, number>,
    /** Every model.complete call's model, in order: the rater is haiku, the spot-check sonnet. */
    completions: [] as string[],
    /** What the spot-check answers; the rating's own reply when unset. */
    checkRating: undefined as string | undefined,
    checkUsage: {} as Record<string, number>,
    /** What a spot-check adds to the session's ledger when it answers. */
    checkCost: 0,
    /** While set, the spot-check waits on it before it answers. */
    checkHold: null as Promise<void> | null,
    spawned: [] as { description: string; model?: string }[],
    /** While set, a spawn waits on it before it settles: its subagent can step first. */
    spawnHold: null as Promise<void> | null,
    agents: [] as { id: string; description: string; type: string; status: string; parentId?: string }[],
    /** What /context would break the window into; undefined: no breakdown. */
    breakdown: undefined as Record<string, unknown> | undefined,
  }
  on('session.start', async ($, e) => ({ cwd: e.cwd }) as never)
  on('command.register', async () => ({ value: undefined }) as never)
  on('clock.every', async () => ({ value: undefined }) as never)
  on('settings.read', async () => ({ value: {} }) as never)
  on('session.messages', async () => ({ value: [] }) as never)
  on('session.id', async () => ({ value: 'sess-1' }) as never)
  on('session.usage', async ($, e) => {
    const breakdown = (e as { breakdown?: string }).breakdown && h.breakdown ? { breakdown: h.breakdown } : {}
    return { value: { startedAt: 0, context: { window: 200_000, ...breakdown }, rateLimits: h.rateLimits, ...(h.ledger === undefined ? {} : { cost: { usd: h.ledger } }) } } as never
  })
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
  on('env.get', async ($, e) => {
    const name = (e as { name: string }).name
    return { value: name === 'HOME' ? '/home/test' : h.env[name] } as never
  })
  on('http.fetch', async ($, e) => {
    const { url, init } = e as { url: string; init?: { method?: string; body?: string } }
    if (init?.method === 'POST') {
      h.posts.push({ url, body: init.body ?? '' })
      return { value: { status: 200, ok: true, headers: {}, text: '{"accepted":1}' } } as never
    }
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
  on('model.complete', async (_$, e) => {
    const model = String((e as { model?: unknown }).model ?? '')
    h.completions.push(model)
    if (model === 'sonnet') {
      if (h.checkHold) await h.checkHold
      if (h.ledger !== undefined) h.ledger += h.checkCost
      return { value: { isAnswered: true, text: h.checkRating ?? h.rating, usage: h.checkUsage } } as never
    }
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
  // A command starting "fail" fails; one starting "denied" is refused, as a denied permission is.
  ;(on as unknown as LooseOn)('tool.call', { tool: 'Bash' }, async (_$, e) => {
    const command = String((e as unknown as { command: string }).command)
    if (command.startsWith('denied')) return { deny: 'permission denied' }
    return command.startsWith('fail') ? { result: { stdout: '', stderr: 'boom' }, text: 'boom', isError: true } : { result: { stdout: 'ok', stderr: '' }, text: 'ok' }
  })
  on('agent.spawn', async ($, e) => {
    h.spawned.push({ description: e.description, model: e.model })
    const id = `agent-${e.description}`
    h.agents.push({ id, description: e.description, type: e.subagentType, status: 'running', ...(e.parentAgentId ? { parentId: e.parentAgentId } : {}) })
    if (h.spawnHold) await h.spawnHold
    return { model: e.model ?? h.subModel, agentId: id } as never
  })
  on('agent.list', async () => ({ value: h.agents }) as never)
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
    // A subagent's own answer, in its own loop.
    answer: (agentId: string, isAborted = false) => e.turn.complete({ turnId: `${agentId}-turn`, agentId, answer: '', durationMs: 1, isAborted, reason: isAborted ? 'aborted' : 'answer' }),
    agent: (model: string) => e.tool.call({ tool: 'Agent', description: 'x', prompt: 'brief', model }),
    workflow: () => e.tool.call({ tool: 'Workflow', script: 'export const meta = {}' }),
    bash: (command: string) => e.tool.call({ tool: 'Bash', command, description: `try ${command} ${h.sent.length}` }),
    // The engine starting a subagent from the main chat's Agent call; its steps carry `agent-<description>`.
    spawn: (description: string, model?: string, over: Record<string, unknown> = {}) =>
      e.agent.spawn({ prompt: 'brief', description, subagentType: 'general-purpose', provider: { kind: 'core' }, parentModel: h.model, background: false, fork: false, ...(model ? { model } : {}), ...over }),
    raterCheck: (value: string) => (e as unknown as { config: { set: (x: unknown) => Promise<unknown> } }).config.set({ key: 'rightsize.raterCheck', value }),
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
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES } })
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
    const cal = h.store[CAL_STORE] as Record<string, { n: number }>
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
    const cal = h.store[CAL_STORE] as Record<string, { n: number }>
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

  test(`the hand-off subagent's first step, before its spawn settles, already runs at the hand-off's level (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = '{"fit":{"haiku":"high","sonnet":"high","opus":"high","fable":"medium"},"type":"feature","read":20000,"write":2000,"steps":6,"reason":"small helper with tests"}'
    h.answers = { Cheaper: 'Send it to a cheaper subagent (Recommended)', Remember: 'Just this session' }
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
    const cal = h.store[CAL_STORE] as Record<string, { n: number }>
    expect(['feature:delegate', 'feature:delegate:haiku', 'feature:delegate:haiku:high'].map(k => cal[k]?.n)).toEqual([1, 1, 1])
    const runs = (h.files['/home/test/.claude/mods-logs/rightsize-runs.jsonl'] ?? '').trim().split('\n')
    const line = JSON.parse(last(runs) ?? '{}') as { route?: string; subLevel?: string; fit?: unknown; read?: number; write?: number; steps?: number }
    expect(line.route).toBe('delegate:haiku')
    expect(line.subLevel).toBe('high')
    expect(line.fit).toEqual({ haiku: 'high', sonnet: 'high', opus: 'high', fable: 'medium' })
    expect([line.read, line.write, line.steps], "the rater's token guesses").toEqual([20000, 2000, 6])
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
    const runs = (h.files['/home/test/.claude/mods-logs/rightsize-runs.jsonl'] ?? '').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
    const sub = runs.filter(l => l.kind === 'subagent')
    expect(sub.length).toBe(1)
    expect([sub[0]?.from, sub[0]?.tier, sub[0]?.level, sub[0]?.type, sub[0]?.aborted]).toEqual(['opus', 'haiku', 'low', 'search', false])
    expect(Math.abs(Number(sub[0]?.actual) - TWO_HAIKU_STEPS) < 1e-6).toBe(true)
    expect(Number(sub[0]?.parentEstimate) > Number(sub[0]?.estimate) * 10, 'the same work on Opus').toBe(true)
    const cal = h.store[CAL_STORE] as Record<string, { n: number }>
    expect(['search:subagent', 'search:subagent:haiku', 'search:subagent:haiku:low'].map(k => cal[k]?.n)).toEqual([1, 1, 1])

    // Resumed later and stopped: logged, nothing taught.
    await d.step('l2', 0, 'agent-lister')
    await d.answer('agent-lister', true)
    const again = (h.files['/home/test/.claude/mods-logs/rightsize-runs.jsonl'] ?? '').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
    expect(again.filter(l => l.kind === 'subagent').map(l => l.aborted)).toEqual([false, true])
    expect(Math.abs(Number(last(again)?.actual) - TWO_HAIKU_STEPS / 2) < 1e-6, 'only what it spent since it answered').toBe(true)
    expect((h.store[CAL_STORE] as Record<string, { n: number }>)['search:subagent']?.n).toBe(1)
    h.now = Date.now()
    expect((await d.command('report')).text ?? '').toContain('2 subagents Claude started ran on a cheaper model.')
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
    const runs = (h.files['/home/test/.claude/mods-logs/rightsize-runs.jsonl'] ?? '').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
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
  const NEAR = '{"fit":{"haiku":"medium","sonnet":"medium","opus":"medium","fable":"medium"},"size":"small","type":"search","read":25000,"write":1000,"steps":20,"reason":"list call sites"}'
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
    h.answers = { Cheaper: 'Send it to a cheaper subagent (Recommended)', Remember: 'Just this session' }
    await d.submit(SEARCH)
    expect(last(h.submitted)?.context?.join('\n') ?? '').toContain('model "haiku"')
    expect(await bandText($, surface)).toContain('The 5-hour window is on pace to run out before it resets, so rightsize saves harder.')
    await d.step('t1')
    await d.complete('t1')
    const runs = (h.files['/home/test/.claude/mods-logs/rightsize-runs.jsonl'] ?? '').trim().split('\n')
    expect((JSON.parse(last(runs) ?? '{}') as { pace?: unknown }).pace).toEqual({ mode: 'hot', window: 'five_hour', pace: 1.33, used: 80 })
    expect((await d.command('')).text ?? '').toContain('Budget pacing: on. The 5-hour window')
  })

  test(`budget pacing off in /config: the same window changes nothing (${surface})`, { timeoutMs: 30000, options: { pacing: 'off' } }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    h.rateLimits = [{ kind: 'five_hour', percentUsed: 80, resetsAt: at(h, 2 * HOUR) }]
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = NEAR
    await d.submit(SEARCH)
    expect(last(h.submitted)?.context ?? []).toEqual([])
    expect(h.asked.length).toBe(0)
    expect((await d.command('')).text ?? '').toContain('Budget pacing: off.')
  })

  test(`budget pacing: a window nearly used up skips a raise and says why (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    h.rateLimits = [{ kind: 'five_hour', percentUsed: 93, resetsAt: at(h, 4 * HOUR) }]
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = '{"fit":{"haiku":"no","sonnet":"no","opus":"high","fable":"medium"},"size":"small","type":"debug","read":8000,"write":800,"steps":6,"reason":"race"}'
    h.answers = { Raising: 'Raise automatically (Recommended)', Remember: 'Just this session' }
    await d.submit(DEBUG)
    expect(h.asked.length, 'no raise to ask about').toBe(0)
    await d.step('t1')
    expect(last(h.sent)?.effort).toBe('medium')
    expect(await bandText($, surface)).toBe('rightsize: Kept medium on Opus instead of raising to high. 93% of the 5-hour window is used, so rightsize saves all it can.')
  })

  test(`budget pacing: when much of a window will go unused, "Ask" raises without asking (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    // 30% of the week used, 6 hours before it resets.
    h.rateLimits = [{ kind: 'seven_day', percentUsed: 30, resetsAt: at(h, 6 * HOUR) }]
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = '{"fit":{"haiku":"no","sonnet":"no","opus":"high","fable":"medium"},"size":"small","type":"debug","read":8000,"write":800,"steps":6,"reason":"race"}'
    h.answers = { Raising: 'Ask me each time', Remember: 'Just this session' }
    await d.submit(DEBUG)
    expect(h.asked.map(a => a.header), 'the Raising rule, but no per-prompt question').toEqual(['Raising', 'Remember'])
    await d.step('t1')
    expect(last(h.sent)?.effort).toBe('high')
    expect(await bandText($, surface)).toContain('Much of the 7-day window will go unused, so rightsize puts quality first.')
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
    expect(await bandText($, surface)).toBe('rightsize: Effort raised mid-turn: medium → high (the same tool call failed twice).')
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

    const runs = (h.files['/home/test/.claude/mods-logs/rightsize-runs.jsonl'] ?? '').trim().split('\n')
    const line = JSON.parse(last(runs) ?? '{}') as { escalations?: { step: number; from: string; to: string }[] }
    expect(line.escalations?.map(x => [x.step, x.from, x.to])).toEqual([[2, 'medium', 'high'], [4, 'high', 'xhigh']])
    expect(Object.keys(h.store[CAL_STORE] ?? {}).filter(k => k.startsWith('lookup:')), 'a turn at two levels teaches nothing').toEqual([])
    h.now = Date.now()
    expect((await d.command('report')).text ?? '').toContain('1 turn raised effort mid-turn because Claude looked stuck: the same tool call failed twice (1), several tool calls failed (1).')

    // The next turn starts at the person's level again.
    await d.submit(LOOKUP)
    await d.step('t2', 0)
    expect(last(h.sent)?.effort).toBe('medium')
  })

  test(`asks before a mid-turn raise unless Raising is automatic, and does not ask twice for one sign (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    await d.step('t1', 0)
    await d.bash('fail make')
    await d.bash('fail make')
    h.answers = { Stuck: 'Keep medium' }
    await d.step('t1', 1)
    expect(h.asked.map(a => a.question)).toEqual(['Claude looks stuck: the same tool call failed twice. Raise effort from medium to high for the rest of this turn?'])
    expect(last(h.sent)?.effort).toBe('medium')
    await d.step('t1', 2)
    expect(h.asked.length, 'the same sign is not asked again').toBe(1)
    await d.bash('fail make test')
    h.answers = { Stuck: 'Raise to high for this turn' }
    await d.step('t1', 3)
    expect(last(h.sent)?.effort, 'a new sign, and a yes').toBe('high')
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
    for (let i = 0; i < 3; i++) await d.bash('denied rm -rf build')
    await d.step('t1', 1)
    expect(last(h.sent)?.effort).toBe('medium')
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
    const runs = (h.files['/home/test/.claude/mods-logs/rightsize-runs.jsonl'] ?? '').trim().split('\n')
    const line = JSON.parse(last(runs) ?? '{}') as { requests?: number; fixed?: unknown }
    expect(line.requests).toBe(2)
    // Deferred MCP tools are not in the context: 20K MCP, 6K memory, 1K agents, 3K skills and commands.
    expect(line.fixed).toEqual({ tokens: 30000, mcp: 20000, memory: 6000, agents: 1000, skills: 3000, servers: { linear: 12000, github: 8000 }, cost: 0.012 })
    h.now = Date.now()
    expect((await d.command('report')).text ?? '').toContain('Fixed context (last 30 days): ~30K tokens rode along on every request: MCP tools ~20K (linear 12K, github 8K), CLAUDE.md and memory ~6K, skills and commands ~3K, agent descriptions ~1K.')
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

  test(`idle past the cache: asks before a prompt rewrites the whole cache, and can hold it (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await idleSetup($, on, surface)
    h.now += 30 * MIN
    await d.submit('continue')
    expect(h.asked.length, 'inside the hour the cache lives').toBe(0)
    await d.step('t1')
    await d.complete('t1')

    h.now += 2 * 60 * MIN
    h.answers = { Idle: 'Hold it: I will /clear or /compact first' }
    const sent = h.submitted.length
    const out = (await d.submit('continue')) as { drop?: string }
    expect(h.asked.map(a => a.question)).toEqual([
      'This session sat idle for 2 hours, so its cache has likely expired. Sending writes the whole conversation (~21K tokens) to the cache again: about $0.16 more on Opus than a warm cache. /clear costs nothing; /compact about $0.08.',
    ])
    expect(out.drop).toBe('rightsize held this prompt and put it back in the box. Run /clear or /compact, then send it.')
    expect(h.submitted.length, 'held: nothing entered').toBe(sent)
    expect(last(h.filled)).toBe('continue')

    await d.submit('continue')
    expect(h.asked.length, 'one question per idle gap').toBe(1)
    expect(h.submitted.length).toBe(sent + 1)
  })

  test(`idle guard after a resume reads the last turn from the store (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await idleSetup($, on, surface)
    // Claude Code exits and the session is resumed 3 days later.
    await d.start(surface)
    h.now += 3 * 24 * 60 * MIN
    h.answers = { Idle: 'Send it' }
    await d.submit('continue')
    expect(h.asked[0]?.question).toContain('sat idle for 3 days')
    expect(h.asked[0]?.question).not.toContain('1 minutes')
    expect(last(h.submitted)?.text, 'sent').toBe('continue')
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

  test(`idle on a subscription: gives the cost in API-equivalent dollars, then in the 5-hour window once runs show it (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    h.rateLimits = [{ kind: 'five_hour', percentUsed: 10 }]
    const d = drive($, h)
    await d.start(surface)
    h.rating = NO_CHANGE
    await d.step('t0')
    await d.complete('t0')
    h.now += 3 * 60 * MIN
    h.answers = { Idle: 'Send it' }
    await d.submit('continue')
    expect(h.asked.map(a => a.question)).toEqual([
      'This session sat idle for 3 hours, so its cache has likely expired. Sending writes the whole conversation (~21K tokens) to the cache again: about $0.16 API-equivalent more on Opus than a warm cache. /clear costs nothing; /compact about $0.08 API-equivalent.',
    ])
    await d.step('t1')
    await d.complete('t1')

    // 5% of the window for $1 of turns: $0.16 is 0.8%.
    const at = new Date(h.now).toISOString()
    h.files['/home/test/.claude/mods-logs/rightsize-runs.jsonl'] = `${JSON.stringify({ at, kind: 'run', actual: 1, before: { five_hour: 10 }, after: { five_hour: 15 } })}\n`
    h.now += 3 * 60 * MIN
    await d.submit('continue')
    expect(last(h.asked)?.question).toContain(
      'about 0.8% of your 5-hour window ($0.16 API-equivalent) more on Opus than a warm cache. /clear costs nothing; /compact about 0.4% of your 5-hour window ($0.08 API-equivalent).',
    )
  })

  test(`Idle warning in /config sets the bar (${surface})`, { timeoutMs: 30000, options: { idleWarning: 'over $1' } }, async ($, on) => {
    const { h, d } = await idleSetup($, on, surface)
    h.now += 3 * 60 * MIN
    await d.submit('continue')
    expect(h.asked.length, '$0.16 is under $1').toBe(0)
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
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES } })
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
    expect((await ui.findAll({ type: 'Button' })).map(b => b.key), 'a lowering can be marked 👍 or 👎').toEqual(['undo', 'good', 'bad', 'rule-ask', 'rule-never', 'mode', 'close'])

    // A rule button changes the answer to Q1 in one press.
    await ui.press({ key: 'rule-ask' })
    expect(last(h.toasts)).toBe('Rightsize: Lowering is now "Ask me each time".')
    expect((await d.command('')).text ?? '').toContain('Lowering: ask.')
    expect((await ui.findAll({ type: 'Button' })).map(b => b.key), 'the new rule is not offered again').toEqual(['undo', 'good', 'bad', 'rule-auto', 'rule-never', 'mode', 'close'])

    // Undo puts the prompt back in the box and closes the band.
    await ui.press({ key: 'undo' })
    expect(h.filled[0]).toBe(LOOKUP)
    expect(last(h.toasts) ?? '').toContain('run it at medium')
    await ui.unmount()
    expect(await bandText($, surface)).toBe('')
  })

  const RUNS = '/home/test/.claude/mods-logs/rightsize-runs.jsonl'
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
    expect(await bandText($, surface)).toMatch(/^rightsize: Starting on Sonnet at (medium|high) would have cost ~\d+% less than Opus at medium on your last 60 rated prompts\. Switch with \/model\.$/)
    const ui = await mount($, surface)
    expect((await ui.findAll({ type: 'Button' })).map(b => b.key)).toEqual(['tip-later', 'tip-stop', 'mode', 'close'])
    await ui.press({ key: 'tip-later' })
    await ui.unmount()
    expect(await bandText($, surface)).toBe('')
    expect(String((await d.command('report')).text)).toContain('Starting point (last 30 days, 60 rated prompts): Opus at medium.')

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

  const shareLog = (now: number, n: number) =>
    Array.from({ length: n }, (_, i) =>
      JSON.stringify({ at: new Date(now - (n - i) * 60_000).toISOString(), kind: 'run', id: `sess-0:${i}`, session: 'sess-0', type: 'lookup', route: 'main', tier: 'opus', level: 'medium', normal: 'medium', fit: { haiku: 'low', sonnet: 'low', opus: 'low', fable: 'low' }, read: 800, write: 60, steps: 2, actual: 0.1, fixed: { tokens: 1000, servers: { secret_server: 500 } }, escalations: [{ step: 2, from: 'low', to: 'medium', why: 'Bash failed on /Users/x' }] }),
    ).join('\n')

  test(`after 20 rated prompts, asks once whether to share anonymous numbers (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    h.files[RUNS] = shareLog(h.now, 20)
    const d = drive($, h)
    await d.start(surface)
    await flush()
    expect(h.posts.length, 'off by default: nothing sent').toBe(0)
    h.rating = NO_CHANGE
    h.answers = { Share: 'Share anonymous numbers' }
    await d.submit(LOOKUP)
    await d.step('t1')
    await d.complete('t1')
    expect(h.asked.filter(a => a.header === 'Share').length).toBe(1)
    expect(last(h.configSet)).toBe('on')
    expect(String(h.store.shareInstall)).toMatch(/^[a-f0-9]{32}$/)
    expect((await d.command('')).text ?? '').toContain('Sharing: on')

    await d.submit(LOOKUP)
    await d.step('t2')
    await d.complete('t2')
    expect(h.asked.filter(a => a.header === 'Share').length, 'asked once').toBe(1)
  })

  test(`sharing sends only new, anonymous numbers, at most once an hour (${surface})`, { timeoutMs: 30000, options: { share: 'on' } }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { shareInstall: 'b'.repeat(32), sharedUpTo: new Date(1_800_000_000_000 - 3 * 60_000).toISOString() } })
    h.files[RUNS] = shareLog(h.now, 10)
    const d = drive($, h)
    await d.start(surface)
    while (!h.posts.length) await flush()
    expect(h.posts.length).toBe(1)
    expect(h.posts[0]?.url).toBe('https://rightsize-feedback.vercel.app/api/v1/events')
    const body = JSON.parse(h.posts[0]?.body ?? '{}') as { install: string; events: Record<string, unknown>[] }
    expect(body.install).toBe('b'.repeat(32))
    expect(body.events.length, 'only the lines after the last send').toBe(2)
    const text = h.posts[0]?.body ?? ''
    for (const secret of ['sess-0', 'secret_server', '/Users/x', 'Bash failed']) expect(text, secret).not.toContain(secret)
    expect(body.events[0]?.escalations, 'a count, not the reasons').toBe(1)

    await d.start(surface)
    h.now += 10 * MIN
    await d.step('t0')
    await d.complete('t0')
    await flush()
    expect(h.posts.length, 'within the hour: nothing more').toBe(1)
  })

  test(`sharing sends nothing while Claude Code's nonessential traffic is off (${surface})`, { timeoutMs: 30000, options: { share: 'on' } }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { shareInstall: 'b'.repeat(32), sharedUpTo: '2020-01-01T00:00:00.000Z' } })
    h.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
    h.files[RUNS] = shareLog(h.now, 5)
    const d = drive($, h)
    await d.start(surface)
    await flush()
    expect(h.posts.length).toBe(0)
  })

  test(`Stop suggesting turns start suggestions off in /config (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    h.files[RUNS] = easyLog(h.now)
    const d = drive($, h)
    await d.start(surface)
    const ui = await mount($, surface)
    await ui.press({ key: 'tip-stop' })
    await ui.unmount()
    expect(last(h.configSet)).toBe('off')
    expect(last(h.toasts) ?? '').toContain('no more starting-model suggestions')
    expect((await d.command('')).text ?? '').toContain('Start suggestions: off.')
  })

  test(`no start suggestion when Start suggestions is off, or with too few prompts (${surface})`, { timeoutMs: 30000, options: { startTips: 'off' } }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    h.files[RUNS] = easyLog(h.now)
    const d = drive($, h)
    await d.start(surface)
    expect(await bandText($, surface)).toBe('')
    expect(String((await d.command('report')).text), 'the report still compares').toContain('Starting point (last 30 days')
  })

  test(`waits for 50 rated prompts before suggesting a start (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    h.files[RUNS] = easyLog(h.now).split('\n').slice(0, 30).join('\n')
    const d = drive($, h)
    await d.start(surface)
    expect(await bandText($, surface)).toBe('')
    expect(String((await d.command('report')).text)).toContain('Starting point: needs 50 rated prompts on Opus at medium to compare starts (has 30).')
  })

  test(`the Band setting: when it acts, always, off, and the ⋯ and × buttons (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES } })
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
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')

    // Another session saves its runs after this one loaded the calibration.
    h.store[CAL_STORE] = { ...FREE_SWITCHES, 'debug:main': { n: 3, ratio: 2 } }
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    await d.step('t1')
    await d.complete('t1')
    let cal = h.store[CAL_STORE] as Record<string, { n: number }>
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
    cal = h.store[CAL_STORE] as Record<string, { n: number }>
    expect(cal['lookup:main']?.n, 'the stepped-up turn is not counted').toBe(1)
  })

  test(`learns calibration into calibration-v2 and ignores the old calibration key (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { calibration: { 'lookup:main': { n: 40, ratio: 9 } }, [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    await d.start(surface)
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    await d.step('t1')
    await d.complete('t1')
    expect(CAL_STORE).toBe('calibration-v2')
    const cal = h.store['calibration-v2'] as Record<string, { n: number; ratio: number }>
    expect(cal['lookup:main']?.n, 'learned from zero, not from the old key').toBe(1)
    expect(cal['cache:effort-switch']?.n, 'read back from the new key').toBe(20)
    expect(h.store.calibration, 'the old key is left as it was').toEqual({ 'lookup:main': { n: 40, ratio: 9 } })
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
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES } })
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
    expect((first as { normal?: string; context?: number })?.normal, 'the session level, for the starting-point check').toBe('medium')
    expect(typeof (first as { context?: number })?.context).toBe('number')
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

  test(`a close call decided by the guide is counted in the store and logged on the run (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const cal = { ...tieCal(0.9), ...FREE_SWITCHES }
    const p = plan(tieRating, { ...fableHigh, cal, ties: 3 }, 'low')
    expect(p.kind === 'delegate' && p.tie, 'the setup is a close call').toEqual({ by: 'guide', over: 'opus' })
    const h = engine(on, { model: 'claude-fable-5-1', effort: 'high', store: { [CAL_STORE]: cal, ties: 3 } })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')

    h.rating = TIE_RATING
    h.answers = { Cheaper: 'Send it to a cheaper subagent (Recommended)', Remember: 'Just this session' }
    await d.submit(SEARCH)
    expect(h.store.ties, 'the close call is counted').toBe(4)
    expect(last(h.submitted)?.context?.join('\n') ?? '', 'the guide\'s pick, not the cheaper Opus').toContain('model "sonnet"')
    h.subModel = 'claude-sonnet-5-5'
    await d.step('t1', 0)
    await d.agent('sonnet')
    await d.step('t1', 0, 'a1')
    await d.step('t1', 1)
    await d.complete('t1')
    const runs = (h.files['/home/test/.claude/mods-logs/rightsize-runs.jsonl'] ?? '').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
    expect(last(runs)?.route).toBe('delegate:sonnet')
    expect(last(runs)?.tie).toEqual({ by: 'guide', over: 'opus' })
    expect((h.files['/home/test/.claude/mods-logs/rightsize.log'] ?? '').includes('tie guide over opus'), 'the log says so').toBe(true)

    // The next close call is the fifth (4 before it): it explores, and is counted too.
    await d.submit(SEARCH)
    expect(h.store.ties, 'counted again').toBe(5)
    expect(last(h.submitted)?.context?.join('\n') ?? '', 'the fifth takes the other close route').toContain('model "opus"')
    await d.step('t3', 0)
    await d.agent('opus')
    await d.step('t3', 1)
    await d.complete('t3')
    const again = (h.files['/home/test/.claude/mods-logs/rightsize-runs.jsonl'] ?? '').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
    expect(last(again)?.tie).toEqual({ by: 'explore', over: 'sonnet' })
  })

  test(`a prompt with no close call leaves the count alone and logs no tie (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const cal = { ...tieCal(0.7), ...FREE_SWITCHES }
    const h = engine(on, { model: 'claude-fable-5-1', effort: 'high', store: { [CAL_STORE]: cal, ties: 2 } })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = TIE_RATING
    h.answers = { Cheaper: 'Send it to a cheaper subagent (Recommended)', Remember: 'Just this session' }
    await d.submit(SEARCH)
    expect(last(h.submitted)?.context?.join('\n') ?? '', 'the cheapest').toContain('model "opus"')
    expect(h.store.ties, 'no close call: not counted').toBe(2)
    h.subModel = 'claude-opus-5-5'
    await d.step('t1', 0)
    await d.agent('opus')
    await d.step('t1', 1)
    await d.complete('t1')
    const runs = (h.files['/home/test/.claude/mods-logs/rightsize-runs.jsonl'] ?? '').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
    expect('tie' in (last(runs) ?? {})).toBe(false)
  })

  test(`a close call in sizing Claude's subagent is counted and logged on its resize (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const sub: Situation = { ...fableHigh, tier: 'fable' }
    // Both models carry the same rework factor under a Fable parent, so the raw estimates compare as the calibrated ones do.
    const raw = (t: 'sonnet' | 'opus') => subWork(tieRating, sub, t, 'medium')
    const cal = opusAt(0.9, raw, subagentKeys('feature', 'opus', 'medium'))
    const size = sizeSubagent(tieRating, { ...sub, cal }, 'fable', 'low')
    expect(size?.tie, 'the setup is a close call').toEqual({ by: 'guide', over: 'opus' })
    const h = engine(on, { model: 'claude-fable-5-1', effort: 'high', store: { [CAL_STORE]: cal } })
    const d = drive($, h)
    await d.start(surface)
    h.rating = NO_CHANGE
    await d.submit(SEARCH)
    await d.step('t1', 0)
    h.rating = TIE_RATING
    await d.spawn('lister')
    expect(h.spawned.map(x => x.model), 'sent to the guide\'s model').toEqual(['sonnet'])
    expect(h.store.ties, 'counted').toBe(1)
    await d.step('t1', 1)
    await d.complete('t1')
    const runs = (h.files['/home/test/.claude/mods-logs/rightsize-runs.jsonl'] ?? '').trim().split('\n').map(l => JSON.parse(l) as { resized?: { tier: string; tie?: unknown }[] })
    expect(last(runs)?.resized?.map(r => [r.tier, r.tie])).toEqual([['sonnet', { by: 'guide', over: 'opus' }]])
  })

  // Rater check: Sonnet's second opinion on every 50th rating, in the background.
  const FIT_NO = '{"fit":{"haiku":"no","sonnet":"no","opus":"medium","fable":"medium"},"type":"feature","read":2000,"write":300,"steps":1,"reason":"plain change"}'
  const CHECK_NO = '{"fit":{"haiku":"no","sonnet":"no","opus":"no","fable":"high"},"type":"feature","read":2000,"write":300,"steps":1}'
  const runLines = (h: ReturnType<typeof engine>) =>
    (h.files[RUNS] ?? '')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l) as Record<string, unknown>)
  const SONNET_USAGE = { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

  test(`the 50th rated prompt gets Sonnet's second opinion in the background, logged as a check line (${surface})`, { timeoutMs: 60000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    h.now = Date.now()
    await d.start(surface)
    h.rating = FIT_NO
    h.checkRating = CHECK_NO
    for (let i = 1; i < 50; i++) await d.submit(LOOKUP)
    expect(h.completions.filter(m => m === 'sonnet'), 'none before the 50th').toEqual([])
    expect(h.store.spotChecks).toBe(49)

    // The 50th: Sonnet is asked, and the prompt goes through while it is still thinking.
    let release = () => {}
    h.checkHold = new Promise<void>(resolve => {
      release = resolve
    })
    const sent = h.submitted.length
    await d.submit(LOOKUP)
    expect(h.submitted.length, 'the prompt was not held back').toBe(sent + 1)
    expect(h.completions.filter(m => m === 'sonnet'), 'asked once, after Haiku').toEqual(['sonnet'])
    expect(last(h.completions.slice(0, -1))).toBe('haiku')
    expect(h.store.spotChecks).toBe(50)
    expect(runLines(h).some(l => l.kind === 'check'), 'no line until it answers').toBe(false)

    release()
    await flush()
    const check = runLines(h).find(l => l.kind === 'check') as { kind: string; session: string; type: string; fit: unknown; check: unknown; overhead: number } | undefined
    expect(check?.session).toBe('sess-1')
    expect(check?.type).toBe('feature')
    expect(check?.fit, "Haiku's fit").toEqual({ haiku: null, sonnet: null, opus: 'medium', fable: 'medium' })
    expect(check?.check, "Sonnet's fit: Opus would struggle").toEqual({ by: 'sonnet', fit: { haiku: null, sonnet: null, opus: null, fable: 'high' } })
    expect(check?.overhead, 'its cost is logged').toBe(0)
    expect(runLines(h).filter(l => l.kind === 'run').length, 'a check line is not a rated run').toBe(0)

    // The 51st to 99th are not checked; the report counts the disagreement.
    await d.submit(LOOKUP)
    expect(h.completions.filter(m => m === 'sonnet').length).toBe(1)
    const report = (await d.command('report')).text ?? ''
    expect(report).toContain("Haiku's judgement was wrong on 1 of 2 checked prompts (50%)")
    expect(report, 'a check line is not a prompt').not.toContain('prompts rated')
  })

  test(`a check that lands during a turn is left out of that turn's cost (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES, spotChecks: 49 } })
    const d = drive($, h)
    h.now = Date.now()
    await d.start(surface)
    h.rating = FIT_NO
    h.checkRating = CHECK_NO
    h.checkUsage = SONNET_USAGE
    h.checkCost = 2
    let release = () => {}
    h.checkHold = new Promise<void>(resolve => {
      release = resolve
    })
    await d.submit(LOOKUP)
    await d.step('t1')
    release()
    await flush()
    await d.complete('t1')
    const lines = runLines(h)
    expect((lines.find(l => l.kind === 'check') as { overhead: number }).overhead, '1M Sonnet input tokens').toBe(2)
    expect((lines.find(l => l.kind === 'run') as { actual: number }).actual, "the turn's own cost: one step").toBe(0.01)
  })

  test(`Rater check off in /config: no second opinion, and the count does not move (${surface})`, { timeoutMs: 30000, options: { raterCheck: 'off' } }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { spotChecks: 49 } })
    const d = drive($, h)
    await d.start(surface)
    h.rating = FIT_NO
    await d.submit(LOOKUP)
    await d.submit(LOOKUP)
    expect(h.completions.filter(m => m === 'sonnet')).toEqual([])
    expect(h.store.spotChecks).toBe(49)
    expect((await d.command('')).text ?? '').toContain('Rater check: off.')
    // Turned on again in /config: the next rating is the 50th.
    await d.raterCheck('on')
    await d.submit(LOOKUP)
    await flush()
    expect(h.completions.filter(m => m === 'sonnet')).toEqual(['sonnet'])
    expect((await d.command('')).text ?? '').toContain('Rater check: on (every 50th rating).')
  })

  test(`Rater check turned off in /config stops the second opinions (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { spotChecks: 49 } })
    const d = drive($, h)
    await d.start(surface)
    h.rating = FIT_NO
    await d.raterCheck('off')
    await d.submit(LOOKUP)
    expect(h.completions.filter(m => m === 'sonnet')).toEqual([])
  })

  test(`a check that fails or cannot be read adds no check line, only its cost (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { spotChecks: 49 } })
    const d = drive($, h)
    await d.start(surface)
    h.rating = FIT_NO
    h.checkRating = 'no json here'
    h.checkUsage = SONNET_USAGE
    await d.submit(LOOKUP)
    await flush()
    expect(runLines(h).map(l => l.kind)).toEqual(['overhead'])
    expect((runLines(h)[0] as { overhead: number }).overhead).toBe(2)
  })

  // 👍 and 👎: a hand-off's result and an automatic lowering can be marked, on this machine only.
  const buttons = async ($: unknown) => {
    const ui = await mount($, surface)
    const keys = (await ui.findAll({ type: 'Button' })).map(b => b.key)
    await ui.unmount()
    return keys
  }

  test(`👍 and 👎 on a hand-off's result write a feedback line for that run, once (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-fable-5-1', effort: 'high' })
    const d = drive($, h)
    h.now = Date.now()
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')

    h.rating = '{"level":"low","model":"haiku","size":"bulky","type":"search","read":150000,"write":3000,"steps":30,"reason":"repo-wide search"}'
    h.answers = { Cheaper: 'Send it to a cheaper subagent (Recommended)', Remember: 'Just this session' }
    // Claude answers without the subagent: nothing to mark.
    await d.submit(SEARCH)
    await d.step('t1')
    await d.complete('t1')
    expect(await buttons($), 'no hand-off happened').toEqual(['rule-ask', 'rule-stay', 'mode', 'close'])

    await d.submit(SEARCH)
    await d.step('t2', 0)
    await d.agent('haiku')
    await d.step('t2', 0, 'a2')
    await d.step('t2', 1)
    await d.complete('t2')
    expect(await bandText($, surface)).toMatch(/^rightsize: Sent to Haiku:/)
    expect(await buttons($)).toEqual(['good', 'bad', 'rule-ask', 'rule-stay', 'mode', 'close'])

    const ui = await mount($, surface)
    await ui.press({ key: 'bad' })
    await flush()
    expect(last(h.toasts)).toBe('Rightsize: thanks — this tunes its choices on this machine.')
    const lines = runLines(h)
    const handOff = lines.filter(l => l.kind === 'run').find(l => l.route === 'delegate:haiku') as { id: string } | undefined
    expect(handOff?.id, 'the run line carries an id').toBeTruthy()
    const feedback = lines.filter(l => l.kind === 'feedback')
    expect(feedback.length).toBe(1)
    expect(feedback[0]).toMatchObject({ kind: 'feedback', session: 'sess-1', ref: handOff?.id, value: 'down' })
    expect(typeof feedback[0]?.at).toBe('string')
    expect((await ui.findAll({ type: 'Button' })).map(b => b.key), 'the marks go once pressed').toEqual(['rule-ask', 'rule-stay', 'mode', 'close'])
    await ui.unmount()
    expect(await bandText($, surface), 'the band itself stays').toMatch(/^rightsize: Sent to Haiku:/)
    // Nothing leaves the machine: no fetch beyond the price check, and the line is only in the run log.
    expect(h.fetches).toBeLessThanOrEqual(1)
    // One hit (no rework) and one 👎, both Haiku's.
    expect((await d.command('report')).text ?? '').toContain("Haiku's judgement was wrong on 1 of 2 checked prompts (50%)")
  })

  test(`👍 and 👎 on an automatic lowering write a feedback line for that run, and 👍 counts as a hit (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    h.now = Date.now()
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')

    h.rating = LOWER
    h.answers = { Lowering: 'Lower automatically', Remember: 'Just this session' }
    await d.submit(LOOKUP)
    await d.step('t1')
    await d.complete('t1')
    expect(await buttons($)).toEqual(['undo', 'good', 'bad', 'rule-ask', 'rule-never', 'mode', 'close'])

    const ui = await mount($, surface)
    await ui.press({ key: 'good' })
    await flush()
    const run = runLines(h).find(l => l.kind === 'run') as { id: string; change: string }
    expect(run.change).toBe('lower')
    expect(runLines(h).filter(l => l.kind === 'feedback')).toMatchObject([{ ref: run.id, value: 'up', session: 'sess-1' }])
    expect(last(h.toasts)).toBe('Rightsize: thanks — this tunes its choices on this machine.')
    expect((await ui.findAll({ type: 'Button' })).map(b => b.key)).toEqual(['undo', 'rule-ask', 'rule-never', 'mode', 'close'])
    await ui.unmount()
    expect(await bandText($, surface)).toBe('rightsize: Effort lowered: medium → low for this prompt (automatically).')
    // The next lowering has its own id.
    await d.submit(LOOKUP)
    await d.step('t2')
    await d.complete('t2')
    expect(await buttons($)).toEqual(['undo', 'good', 'bad', 'rule-ask', 'rule-never', 'mode', 'close'])
    const ui2 = await mount($, surface)
    await ui2.press({ key: 'bad' })
    await flush()
    await ui2.unmount()
    const ids = runLines(h).filter(l => l.kind === 'run').map(l => l.id)
    expect(new Set(ids).size, 'two runs, two ids').toBe(2)
    expect(runLines(h).filter(l => l.kind === 'feedback').map(l => [l.ref, l.value])).toEqual([[ids[0], 'up'], [ids[1], 'down']])
  })

  test(`a raise and a no-change band offer no 👍 or 👎 (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = '{"level":"high","model":"same","type":"debug","read":20000,"write":3000,"steps":8,"reason":"unknown cause"}'
    h.answers = { Raising: 'Raise automatically (Recommended)', Remember: 'Just this session' }
    await d.submit(DEBUG)
    expect(await bandText($, surface)).toContain('Effort raised')
    expect(await buttons($)).toEqual(['rule-ask', 'rule-never', 'mode', 'close'])
  })

  // The record steers the next decisions: a model the rater has often got wrong gets no lowering.
  test(`a task type the rater keeps getting wrong is not lowered, once the log shows it (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    h.files[RUNS] = Array.from({ length: 6 }, (_, i) =>
      JSON.stringify({ at: new Date(h.now - (6 - i) * 60_000).toISOString(), kind: 'run', type: 'lookup', route: 'main', tier: 'opus', change: 'lower', steppedUp: i < 3 }),
    ).join('\n') + '\n'
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = LOWER
    h.answers = { Lowering: 'Lower automatically', Remember: 'Just this session' }
    await d.submit(LOOKUP)
    expect(h.asked.length, 'wrong on 3 of 6 lookups on Opus: lowering is paused, so nothing is asked').toBe(0)
    await d.step('t1')
    expect(last(h.sent)?.effort, 'stays at medium').toBe('medium')
    await d.complete('t1')
    expect(await bandText($, surface)).toBe('')
    // The report says what the record is and what it paused.
    const report = (await d.command('report')).text ?? ''
    expect(report).toContain("Haiku's judgement was wrong on 3 of 6 checked prompts (50%)")
    expect(report).toContain('Hand-downs of lookup work to Opus (and lowering effort on it) are paused: wrong on 50% of 6.')
  })

  test(`with a clean record the same lowering goes ahead (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    h.files[RUNS] = Array.from({ length: 6 }, (_, i) =>
      JSON.stringify({ at: new Date(h.now - (6 - i) * 60_000).toISOString(), kind: 'run', type: 'lookup', route: 'main', tier: 'opus', change: 'lower', steppedUp: i < 1 }),
    ).join('\n') + '\n'
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = LOWER
    h.answers = { Lowering: 'Lower automatically', Remember: 'Just this session' }
    await d.submit(LOOKUP)
    await d.step('t1')
    expect(last(h.sent)?.effort, 'wrong on 1 of 6: under the line').toBe('low')
    await d.complete('t1')
  })
}
