import { type TestBody, expect, test } from 'claude-code/testing'
import { CAL_FULL, CAL_STORE, DEFAULT_PRICES, type Calibration, type Rating, type Situation, delegateCost, delegateKeys, plan, sizeSubagent, subagentKeys, subWork } from './cost'
import { KEYS, SETTINGS, type SettingKey, inOptions } from './settings'

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
function engine(on: Parameters<TestBody>[1], start: { model: string; effort: string; store?: Record<string, unknown>; stored?: Record<string, string>; configKey?: string }) {
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
    /** Every config.set that reached the writer, with who made it. */
    sets: [] as { key: string; value: unknown; origin?: { kind: string } }[],
    /** The plugin's options as settings.json holds them: only what the person (or rightsize on their behalf) set. */
    stored: { ...(start.stored ?? {}) } as Record<string, string>,
    /** The key settings.json files them under: `rightsize`, or `rightsize@<marketplace>`. */
    configKey: start.configKey ?? 'rightsize@archid21',
    /** True: settings cannot be read. */
    settingsFail: false,
    /** What reached the engine, in order: each question asked (`ask:<header>`) and each workflow started (`workflow`). */
    events: [] as string[],
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
  // The merged settings, as the engine holds them: a read of one key is this object, projected.
  on('settings.read', async () => {
    if (h.settingsFail) throw new Error('settings could not be read')
    return { value: { pluginConfigs: { other: { options: { floor: 'high' } }, ...(Object.keys(h.stored).length ? { [h.configKey]: { options: h.stored } } : {}) } } } as never
  })
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
  // The writer: a value outside a row's options does not fit, so the row is left as it was; one that fits goes into settings.json.
  on('config.set', async ($, e) => {
    const { key, value, origin } = e as { key: string; value: unknown; origin?: { kind: string } }
    const field = key.startsWith('rightsize.') ? key.slice('rightsize.'.length) : ''
    const known = KEYS.find(k => k === field)
    if (known && !inOptions(known, value)) return { deny: `${String(value)} is not one of ${known}'s options` } as never
    h.configSet.push(value)
    h.sets.push({ key, value, ...(origin ? { origin } : {}) })
    if (known) h.stored[known] = value as string
    return { value } as never
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
    h.events.push(`ask:${header}`)
    const answer = h.answers[header]
    if (answer === undefined) return { deny: `no answer set for ${header}` }
    return { result: { questions: e.questions, answers: { [q?.question ?? '']: answer } } }
  })
  ;(on as unknown as LooseOn)('tool.call', { tool: 'Agent' }, async () => ({ result: { content: 'done' } }))
  ;(on as unknown as LooseOn)('tool.call', { tool: 'Workflow' }, async () => {
    h.events.push('workflow')
    return { result: { content: 'started in the background' } }
  })
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
    workflow: (id?: string) => e.tool.call({ tool: 'Workflow', script: 'export const meta = {}', ...(id ? { tool_use_id: id } : {}) }),
    bash: (command: string) => e.tool.call({ tool: 'Bash', command, description: `try ${command} ${h.sent.length}` }),
    // The engine starting a subagent from the main chat's Agent call; its steps carry `agent-<description>`.
    spawn: (description: string, model?: string, over: Record<string, unknown> = {}) =>
      e.agent.spawn({ prompt: 'brief', description, subagentType: 'general-purpose', provider: { kind: 'core' }, parentModel: h.model, background: false, fork: false, ...(model ? { model } : {}), ...over }),
    /** A change to one of rightsize's /config rows, made by the person in the menu unless `kind` says otherwise. */
    config: (key: string, value: string, kind: 'composer' | 'bridge' | 'plugin' = 'composer') =>
      (e as unknown as { config: { set: (x: unknown) => Promise<{ value?: unknown; deny?: string }> } }).config.set({
        key: `rightsize.${key}`,
        value,
        origin: kind === 'plugin' ? { kind, name: 'other' } : { kind },
      }),
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
    expect(h.asked[2]?.question ?? '', 'the question carries both costs').toMatch(/About \$[\d.]+ that way vs \$[\d.]+ staying on Opus/)
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
    expect(await bandText($, surface), 'the band carries the result').toMatch(/^rightsize: Sent to Fable: \$[\d.]+ vs about \$[\d.]+ staying on Opus \(estimated\)/)
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
    expect(await bandText($, surface)).toMatch(/^rightsize: Sent to Haiku: .* staying on Fable \(estimated\), saved about \d+%\.$/)
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
    expect(await bandText($, surface)).toMatch(/^rightsize: Sending this to a Haiku subagent at high effort instead of raising Opus to high\. About \$[\d.]+ that way vs \$[\d.]+ staying on Opus/)

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
    expect((await d.command('')).text ?? '').toContain('Budget pacing: on (default). The 5-hour window')
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
    expect((await d.command('')).text ?? '').toContain('Budget pacing: off (yours).')
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

  test(`budget pacing: when much of a window will go unused, "Ask" still asks (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    // 30% of the week used, 6 hours before it resets.
    h.rateLimits = [{ kind: 'seven_day', percentUsed: 30, resetsAt: at(h, 6 * HOUR) }]
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = '{"fit":{"haiku":"no","sonnet":"no","opus":"high","fable":"medium"},"size":"small","type":"debug","read":8000,"write":800,"steps":6,"reason":"race"}'
    h.answers = { Raising: 'Ask me each time', Remember: 'Just this session', Effort: 'Keep medium' }
    await d.submit(DEBUG)
    expect(h.asked.map(a => a.header), 'the Raising rule asks, as it always does').toEqual(['Raising', 'Remember', 'Effort'])
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
    expect((await d.command('')).text ?? '').toContain('Lowering: ask me (yours).')
    expect(h.stored.lowerRule, 'the button sets the /config row too').toBe('ask me')
    expect(h.sets.filter(x => x.key === 'rightsize.lowerRule').length, 'once').toBe(1)
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
    expect((await d.command('')).text ?? '').toContain('Share anonymous feedback: on (yours)')
    expect((await d.command('')).text ?? '').toContain(`Sharing install ID: ${String(h.store.shareInstall)}`)

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
    expect(h.posts[0]?.url).toBe('https://feedback.aivalue.blog/api/v1/events')
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
    expect((await d.command('')).text ?? '').toContain('Start suggestions: off (yours)')
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
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', stored: { handOff: '50%', lowering: '80%' } })
    const d = drive($, h)
    await d.start(surface)
    expect((await d.command('')).text ?? '').toContain('Thresholds: Hand-off threshold: 50% (yours). Lowering threshold: 80% (yours).')
  })

  test(`says the thresholds are the defaults when none are set (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    expect((await d.command('')).text ?? '').toContain('Thresholds: Hand-off threshold: 70% (default). Lowering threshold: 90% (default).')
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
    expect(status.text ?? '').toContain('Lowering: not set (default)')
  })

  test(`checks prices every 30 days, and on /rightsize prices (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
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

    // Again, right away: /rightsize prices always checks.
    expect((await d.command('prices')).text ?? '').toContain('no change')
    expect(h.fetches).toBe(2)
    // "check now" is not a Price check option any more: the row refuses it, and nothing is checked.
    const refused = await d.config('priceCheck', 'check now')
    await flush()
    expect(refused.deny).toBeDefined()
    expect(h.fetches).toBe(2)
    expect(h.configSet, 'nothing was written').toEqual([])

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
    expect((await d.command('')).text ?? '').toContain('Reports: subscription (detected)')
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

    // Your answer stands: rate limits that show a subscription change nothing, and /rightsize says they disagree.
    h.rateLimits = [{ kind: 'five_hour', percentUsed: 1 }]
    await d.step('t3')
    await d.complete('t3')
    expect(h.store.billing, 'still your answer').toEqual({ value: 'api', by: 'answered' })
    const status = (await d.command('')).text ?? ''
    expect(status).toContain('Reports: api (yours)')
    expect(status).toContain('Rate limits look like a subscription; Reports is set to api by you.')
    expect(h.stored.billing, 'the answer is the Reports row too').toBe('api')
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
    expect(report).toContain('Prompts: 2 rated, 1 changed (1 lowered).')
    expect(report).toContain('This session, last 7 days and last 30 days')
    expect(report).toContain('rating calls')
    expect(report).toContain('PROBLEMS (last 30 days)')
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
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { spotChecks: 49 }, stored: { raterCheck: 'off' } })
    const d = drive($, h)
    await d.start(surface)
    h.rating = FIT_NO
    await d.submit(LOOKUP)
    await d.submit(LOOKUP)
    expect(h.completions.filter(m => m === 'sonnet')).toEqual([])
    expect(h.store.spotChecks).toBe(49)
    expect((await d.command('')).text ?? '').toContain('Rater check: off (yours)')
    // Turned on again in /config: the next rating is the 50th.
    await d.config('raterCheck', 'every 50')
    await d.submit(LOOKUP)
    await flush()
    expect(h.completions.filter(m => m === 'sonnet')).toEqual(['sonnet'])
    expect((await d.command('')).text ?? '').toContain('Rater check: every 50 (yours)')
  })

  test(`Rater check turned off in /config stops the second opinions (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { spotChecks: 49 } })
    const d = drive($, h)
    await d.start(surface)
    h.rating = FIT_NO
    await d.config('raterCheck', 'off')
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

  // ---- Every setting, on this surface ----------------------------------------------------------------
  //
  // Each of rightsize's /config rows is checked three ways: it is a declared option of its row (plugin.json
  // and settings.ts agree: Claude Code drops a stored value that is not one of a row's options, and fills in
  // its default), it takes effect when /config changes it, with no restart, and it takes effect when given at
  // load. The scenario for each shows one thing the row changes, with the value and with the default.

  const LOG = '/home/test/.claude/mods-logs/rightsize.log'
  const disagree = (h: ReturnType<typeof engine>) => (h.files[LOG] ?? '').includes('plugin.json and the settings table disagree')
  const settingsText = async (d: ReturnType<typeof drive>) => (await d.command('')).text ?? ''
  const OPUS = { model: 'claude-opus-5-5', effort: 'medium' }
  const FABLE = { model: 'claude-fable-5-1', effort: 'high' }
  const noteOf = (h: ReturnType<typeof engine>) => last(h.submitted)?.context?.join('\n') ?? ''
  const handedTo = (h: ReturnType<typeof engine>) => /model "(\w+)"/.exec(noteOf(h))?.[1]
  const YES_REMEMBER = { Remember: 'Just this session' }
  const LOWER_300 = '{"level":"low","model":"same","size":"small","type":"lookup","read":2000,"write":300,"steps":1}'
  const RAISE_HIGH = '{"level":"high","model":"same","type":"debug","read":20000,"write":3000,"steps":8,"reason":"unknown cause"}'
  const NEEDS_FABLE = '{"level":"high","model":"fable","size":"small","type":"debug","read":30000,"write":4000,"steps":12,"reason":"subtle concurrency bug"}'
  const HAIKU_SEARCH = '{"level":"low","model":"haiku","size":"bulky","type":"search","read":150000,"write":3000,"steps":30,"reason":"repo-wide search"}'
  const FIT_LOW = '{"fit":{"haiku":"low","sonnet":"low","fable":"low"},"size":"bulky","type":"search","read":150000,"write":3000,"steps":30,"reason":"repo-wide search"}'
  const lookupLog = (h: { now: number }, steppedUp: number) =>
    Array.from({ length: 6 }, (_, i) => JSON.stringify({ at: new Date(h.now - (6 - i) * 60_000).toISOString(), kind: 'run', type: 'lookup', route: 'main', tier: 'opus', change: 'lower', steppedUp: i < steppedUp })).join('\n') + '\n'

  type Scene = { h: ReturnType<typeof engine>; d: ReturnType<typeof drive>; $: unknown; surface: string; turn: () => string }
  type Case = {
    key: SettingKey
    /** A value other than the default. */
    value: string
    start: { model: string; effort: string; store?: Record<string, unknown> }
    /** One turn first, so rightsize has seen the model and level the session runs on. */
    warm?: boolean
    setup?: (h: ReturnType<typeof engine>) => void
    /** The change in /config comes before the session starts, for what happens at the start. */
    early?: boolean
    /** Runs the scenario on a started plugin and says what it showed. */
    see: (c: Scene) => Promise<unknown>
    /** What `see` shows with the value, and with the default. */
    set: unknown
    def: unknown
  }

  // One prompt, with the questions it asked and the effort and hand-off it ended in.
  const prompt = async (c: Scene, text: string, rating: string, answers: Record<string, string> = {}) => {
    const asked = c.h.asked.length
    c.h.rating = rating
    c.h.answers = answers
    await c.d.submit(text)
    await c.d.step(c.turn())
    return { asked: c.h.asked.slice(asked).map(a => a.header), effort: last(c.h.sent)?.effort, to: handedTo(c.h) }
  }
  const effortOf = async (c: Scene, text: string, rating: string, answers: Record<string, string> = {}) => (await prompt(c, text, rating, answers)).effort
  const asking = async (c: Scene, text: string, rating: string, answers: Record<string, string> = {}) => {
    const { asked, effort } = await prompt(c, text, rating, answers)
    return { asked, effort }
  }
  const handOff = async (c: Scene, text: string, rating: string, answers: Record<string, string> = {}) => {
    const { asked, to } = await prompt(c, text, rating, answers)
    return { asked, to }
  }
  const hotWindows = (h: { now: number }) => [
    { kind: 'five_hour', percentUsed: 80, resetsAt: at(h, 2 * HOUR) },
    { kind: 'seven_day', percentUsed: 20, resetsAt: at(h, 160 * HOUR) },
  ]
  const CHEAPER_AUTO = { Cheaper: 'Send it to a cheaper subagent (Recommended)', ...YES_REMEMBER }

  const CASES: Case[] = [
    { key: 'floor', value: 'medium', start: { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES } }, see: c => effortOf(c, LOOKUP, LOWER, { Lowering: 'Lower automatically', ...YES_REMEMBER }), set: 'medium', def: 'low' },
    {
      key: 'ceiling',
      value: 'high',
      start: OPUS,
      see: c => effortOf(c, DEBUG, '{"level":"xhigh","model":"same","type":"refactor"}', { Raising: 'Raise automatically (Recommended)', ...YES_REMEMBER }),
      set: 'high',
      def: 'xhigh',
    },
    { key: 'lowerRule', value: 'lower automatically', start: { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES } }, see: c => asking(c, LOOKUP, LOWER), set: { asked: [], effort: 'low' }, def: { asked: ['Lowering'], effort: 'medium' } },
    { key: 'raiseRule', value: 'raise automatically', start: OPUS, see: c => asking(c, DEBUG, RAISE_HIGH), set: { asked: [], effort: 'high' }, def: { asked: ['Raising'], effort: 'medium' } },
    { key: 'upRule', value: 'always send', start: OPUS, see: c => handOff(c, DEBUG, NEEDS_FABLE), set: { asked: [], to: 'fable' }, def: { asked: ['Stronger'], to: undefined } },
    { key: 'downRule', value: 'always send', start: FABLE, warm: true, see: c => handOff(c, SEARCH, HAIKU_SEARCH), set: { asked: [], to: 'haiku' }, def: { asked: ['Cheaper'], to: undefined } },
    {
      key: 'remember',
      value: 'this session',
      start: { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES } },
      see: async c => {
        const { asked } = await prompt(c, LOOKUP, LOWER, { Lowering: 'Lower automatically', Remember: 'Yes, from now on' })
        return { asked, saved: c.h.store.choices, remembered: c.h.store.remember }
      },
      set: { asked: ['Lowering'], saved: undefined, remembered: undefined },
      def: { asked: ['Lowering', 'Remember'], saved: { lower: 'auto' }, remembered: true },
    },
    { key: 'handOff', value: '80%', start: { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES } }, see: async c => (await handOff(c, SEARCH, NEAR, CHEAPER_AUTO)).to, set: 'haiku', def: undefined },
    { key: 'lowering', value: '70%', start: { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES } }, see: c => effortOf(c, LOOKUP, LOWER_300, { Lowering: 'Lower automatically', ...YES_REMEMBER }), set: 'medium', def: 'low' },
    { key: 'useHaiku', value: 'off', start: FABLE, warm: true, see: async c => (await handOff(c, SEARCH, FIT_LOW, CHEAPER_AUTO)).to, set: 'sonnet', def: 'haiku' },
    { key: 'useFable', value: 'off', start: OPUS, see: async c => (await handOff(c, DEBUG, NEEDS_FABLE, { Stronger: 'Send it to a subagent automatically', ...YES_REMEMBER })).to, set: undefined, def: 'fable' },
    {
      key: 'subagents',
      value: 'off',
      start: OPUS,
      see: async c => {
        c.h.rating = NO_CHANGE
        await c.d.submit(SEARCH)
        await c.d.step(c.turn())
        c.h.rating = LISTING
        await c.d.spawn('lister')
        return c.h.spawned[0]?.model
      },
      set: undefined,
      def: 'haiku',
    },
    {
      key: 'workflows',
      value: 'follow my rules',
      start: OPUS,
      see: async c => {
        const asked = c.h.asked.length
        c.h.rating = NO_CHANGE
        c.h.answers = { Workflow: 'Pause rightsize for workflows (recommended)', Stronger: 'Send it to a subagent automatically', ...YES_REMEMBER }
        await c.d.submit(LOOKUP)
        const t = c.turn()
        await c.d.step(t)
        await c.d.workflow()
        await c.d.complete(t)
        c.h.rating = NEEDS_FABLE
        await c.d.submit(DEBUG)
        return { asked: c.h.asked.slice(asked).map(a => a.header).filter(x => x === 'Workflow'), to: handedTo(c.h) }
      },
      set: { asked: [], to: 'fable' },
      def: { asked: ['Workflow'], to: undefined },
    },
    {
      key: 'explore',
      value: 'off',
      start: { ...FABLE, store: { [CAL_STORE]: { ...tieCal(0.9), ...FREE_SWITCHES }, ties: 4 } },
      warm: true,
      see: async c => (await handOff(c, SEARCH, TIE_RATING, CHEAPER_AUTO)).to,
      set: 'sonnet',
      def: 'opus',
    },
    {
      key: 'missPause',
      value: '40%',
      start: { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES } },
      // Wrong on 2 of 6 lookups on Opus: 33%.
      setup: h => void (h.files[RUNS] = lookupLog(h, 2)),
      see: c => effortOf(c, LOOKUP, LOWER, { Lowering: 'Lower automatically', ...YES_REMEMBER }),
      set: 'low',
      def: 'medium',
    },
    { key: 'pacing', value: 'off', start: { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES } }, setup: h => void (h.rateLimits = hotWindows(h)), see: async c => (await handOff(c, SEARCH, NEAR, CHEAPER_AUTO)).to, set: undefined, def: 'haiku' },
    {
      key: 'escalation',
      value: 'off',
      start: { ...OPUS, store: AUTO_RAISE },
      see: async c => {
        c.h.rating = NO_CHANGE
        await c.d.submit(LOOKUP)
        const t = c.turn()
        await c.d.step(t, 0)
        await c.d.bash('fail npm test')
        await c.d.bash('fail npm test')
        await c.d.step(t, 1)
        return last(c.h.sent)?.effort
      },
      set: 'medium',
      def: 'high',
    },
    {
      key: 'stuck',
      value: 'sensitive',
      start: { ...OPUS, store: AUTO_RAISE },
      see: async c => {
        c.h.rating = NO_CHANGE
        await c.d.submit(LOOKUP)
        const t = c.turn()
        await c.d.step(t, 0)
        await c.d.bash('fail make')
        await c.d.bash('fail lint')
        await c.d.step(t, 1)
        return last(c.h.sent)?.effort
      },
      set: 'high',
      def: 'medium',
    },
    {
      key: 'minWords',
      value: '3 words',
      start: OPUS,
      see: async c => {
        c.h.rating = NO_CHANGE
        await c.d.submit('rename this variable please')
        return c.h.ratings
      },
      set: 1,
      def: 0,
    },
    {
      key: 'raterCheck',
      value: 'every 25',
      start: { ...OPUS, store: { spotChecks: 24 } },
      see: async c => {
        c.h.rating = FIT_NO
        await c.d.submit(LOOKUP)
        await flush()
        return c.h.completions.filter(m => m === 'sonnet').length
      },
      set: 1,
      def: 0,
    },
    {
      key: 'startTips',
      value: 'monthly',
      start: { ...OPUS, store: { startCheckedAt: 1_800_000_000_000 - 10 * DAY } },
      setup: h => void (h.files[RUNS] = easyLog(h.now)),
      early: true,
      see: async c => {
        await c.d.start(c.surface)
        return (await bandText(c.$, c.surface)).startsWith('rightsize: Starting on')
      },
      set: false,
      def: true,
    },
    {
      key: 'idleWarning',
      value: 'over $1',
      start: OPUS,
      see: async c => {
        const t = c.turn()
        await c.d.step(t)
        await c.d.complete(t)
        c.h.now += 3 * 60 * MIN
        c.h.rating = NO_CHANGE
        c.h.answers = { Idle: 'Send it' }
        await c.d.submit('continue')
        return c.h.asked.some(a => a.header === 'Idle')
      },
      set: false,
      def: true,
    },
    {
      key: 'billing',
      value: 'subscription',
      start: OPUS,
      see: async c => {
        await prompt(c, DEBUG, NEEDS_FABLE, { Stronger: 'Ask before sending it to a subagent (Recommended)', Subagent: 'Send it to a Fable subagent', ...YES_REMEMBER })
        const q = c.h.asked.find(a => a.header === 'Subagent')?.question ?? ''
        return /That uses/.test(q) ? 'usage' : /About \$/.test(q) ? 'dollars' : q
      },
      set: 'usage',
      def: 'dollars',
    },
    {
      key: 'band',
      value: 'always',
      start: OPUS,
      see: async c => {
        c.h.rating = NO_CHANGE
        await c.d.submit(LOOKUP)
        return bandText(c.$, c.surface)
      },
      set: 'rightsize: No change: medium on Opus fits this prompt.',
      def: '',
    },
    {
      key: 'share',
      value: 'on',
      start: OPUS,
      setup: h => void (h.files[RUNS] = shareLog(h.now, 20)),
      see: async c => {
        c.h.rating = NO_CHANGE
        c.h.answers = { Share: "Don't share" }
        await c.d.submit(LOOKUP)
        const t = c.turn()
        await c.d.step(t)
        await c.d.complete(t)
        return c.h.asked.filter(a => a.header === 'Share').length
      },
      set: 0,
      def: 1,
    },
    {
      key: 'priceCheck',
      value: 'off',
      start: { ...OPUS, store: { pricesCheckedAt: 1_800_000_000_000 - 31 * DAY } },
      setup: h => {
        h.page = PAGE
        h.pricesFile = OLD_PRICES
      },
      early: true,
      see: async c => {
        await c.d.start(c.surface)
        await flush()
        return c.h.fetches
      },
      set: 0,
      def: 1,
    },
  ]

  test(`every setting has a scenario here, and every scenario's value is one of its options (${surface})`, async () => {
    expect(CASES.map(c => c.key).sort()).toEqual([...KEYS].sort())
    for (const c of CASES) {
      expect(inOptions(c.key, c.value), `${c.key}: ${c.value}`).toBe(true)
      expect(c.value, `${c.key}: a value other than the default`).not.toBe(SETTINGS[c.key].default)
    }
  })

  const scene = async ($: unknown, h: ReturnType<typeof engine>, c: Case, begin = true): Promise<Scene> => {
    let n = 0
    const s: Scene = { h, d: drive($, h), $, surface, turn: () => `t${++n}` }
    if (begin && !c.early) {
      await s.d.start(surface)
      if (c.warm) {
        const t = s.turn()
        await s.d.step(t)
        await s.d.complete(t)
      }
    }
    return s
  }

  for (const c of CASES) {
    const title = SETTINGS[c.key].title
    test(`${title} (${c.key}): by default, the scenario shows ${JSON.stringify(c.def)} (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
      const h = engine(on, c.start)
      c.setup?.(h)
      const s = await scene($, h, c)
      expect(await c.see(s)).toEqual(c.def)
    })

    test(`${title} (${c.key}): changed in /config it takes effect without a restart (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
      const h = engine(on, c.start)
      c.setup?.(h)
      const s = await scene($, h, c)
      const result = await s.d.config(c.key, c.value)
      expect(result.deny, 'the row takes the value').toBeUndefined()
      expect(await c.see(s)).toEqual(c.set)
      // It is yours now, and /rightsize says so.
      expect(await settingsText(s.d)).toContain(`${title}: ${c.value} (yours)`)
    })

    test(`${title} (${c.key}): given at load it takes effect (${surface})`, { timeoutMs: 30000, options: { [c.key]: c.value } }, async ($, on) => {
      const h = engine(on, { ...c.start, stored: { [c.key]: c.value } })
      c.setup?.(h)
      const s = await scene($, h, c)
      expect(await c.see(s)).toEqual(c.set)
      expect(await settingsText(s.d)).toContain(`${title}: ${c.value} (yours)`)
    })
  }

  // The row exists as plugin.json declares it: its default, and each of its options. Claude Code fills the
  // default in and drops a stored value that is not an option, so rightsize reading a value back is the
  // proof that plugin.json declares it. (A test cannot read plugin.json; scripts/check-settings.mjs does.)
  for (const key of KEYS) {
    const row = SETTINGS[key]
    test(`${row.title} (${key}): a picker whose default is "${row.default}" (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
      const h = engine(on, { ...OPUS })
      const d = drive($, h)
      await d.start(surface)
      expect(await settingsText(d)).toContain(`${row.title}: ${row.default} (default)`)
      expect(disagree(h), 'plugin.json declares this row with this default').toBe(false)
    })
    for (const option of row.options.filter(o => o !== row.default)) {
      test(`${row.title} (${key}): "${option}" is a declared option (${surface})`, { timeoutMs: 30000, options: { [key]: option } }, async ($, on) => {
        const h = engine(on, { ...OPUS, stored: { [key]: option } })
        const d = drive($, h)
        await d.start(surface)
        // "check now" is an action, not a state: it checks once and the row goes back to monthly.
        const shown = key === 'priceCheck' && option === 'check now' ? 'monthly' : option
        expect(await settingsText(d)).toContain(`${row.title}: ${shown} (yours)`)
        expect(disagree(h)).toBe(false)
      })
    }
  }

  test(`every row at its default: plugin.json and the table agree, and nothing is yours (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS })
    const d = drive($, h)
    await d.start(surface)
    const text = await settingsText(d)
    for (const key of KEYS) expect(text, key).toContain(`${SETTINGS[key].title}: ${SETTINGS[key].default} (default)`)
    expect(text).not.toContain('(yours)')
    expect(disagree(h)).toBe(false)
  })

  test(`a value that is not one of a row's options counts as unset: the default applies, and it is not yours (${surface})`, { timeoutMs: 30000, options: { ceiling: 'ultra', raterCheck: 'on', startTips: 'on', missPause: '35%', minWords: 'six' } }, async ($, on) => {
    const h = engine(on, { ...OPUS, stored: { ceiling: 'ultra', raterCheck: 'on', startTips: 'on', missPause: '35%', minWords: 'six' } })
    const d = drive($, h)
    await d.start(surface)
    const text = await settingsText(d)
    expect(text).toContain('Highest effort: max (default)')
    expect(text, 'a stored on, from before it became a list: the old on is the default').toContain('Rater check: every 50 (default)')
    expect(text).toContain('Start suggestions: weekly (default)')
    expect(text).toContain('Pause after misses: 30% (default)')
    expect(text).toContain('Rate prompts from: 6 words (default)')
    expect(text).not.toContain('(yours)')
  })

  const SOME = { floor: 'medium', ceiling: 'xhigh', lowerRule: 'never lower', billing: 'api', explore: 'on', minWords: '10 words' }
  test(`/rightsize lists every setting, with (yours) for those you set and (default) for the rest (${surface})`, { timeoutMs: 30000, options: SOME }, async ($, on) => {
    const set = SOME
    const h = engine(on, { ...OPUS, stored: set })
    const d = drive($, h)
    await d.start(surface)
    const text = await settingsText(d)
    for (const key of KEYS) {
      const row = SETTINGS[key]
      const mine = key in set
      const shown = mine ? (set as Record<string, string>)[key] : row.default
      expect(text, key).toContain(`${row.title}: ${shown} (${mine ? 'yours' : 'default'})`)
    }
    expect((text.match(/\(yours\)/g) ?? []).length).toBe(6)
    expect((text.match(/\((?:yours|default|detected|saved)\)/g) ?? []).length, 'one mark per setting').toBe(KEYS.length)
  })

  test(`on a subscription the hand-off question and its result say what the usage is compared with: "vs staying on" (${surface})`, { timeoutMs: 30000, options: { billing: 'subscription' } }, async ($, on) => {
    const h = engine(on, { ...FABLE, stored: { billing: 'subscription' } })
    h.rateLimits = [{ kind: 'five_hour', percentUsed: 12 }]
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = HAIKU_SEARCH
    h.answers = { Cheaper: 'Ask before sending it', Subagent: 'Send it to a Haiku subagent', ...YES_REMEMBER }
    await d.submit(SEARCH)
    expect(h.asked.find(a => a.header === 'Subagent')?.question ?? '').toMatch(/That uses about \d+% of the usage vs staying on Fable \(estimated\)\./)
    h.subModel = 'claude-haiku-5-5'
    await d.step('t1', 0)
    await d.agent('haiku')
    await d.step('t1', 0, 'a1')
    await d.step('t1', 1)
    await d.complete('t1')
    expect(await bandText($, surface)).toMatch(/^rightsize: Sent to Haiku: used about \d+% of the usage vs staying on Fable\. API-equivalent: \$[\d.]+ vs about \$[\d.]+ staying on Fable \(estimated\)\.$/)
  })

  test(`answers saved by an earlier session show in /config at the next start, and a row you set wins over them (${surface})`, { timeoutMs: 30000, options: { raiseRule: 'never raise' } }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: { remember: true, choices: { lower: 'auto', raise: 'auto' } }, stored: { raiseRule: 'never raise' } })
    const d = drive($, h)
    await d.start(surface)
    expect(h.stored.lowerRule, 'the saved answer, now a row').toBe('lower automatically')
    expect(h.stored.raiseRule, 'the row you set is left alone').toBe('never raise')
    const text = await settingsText(d)
    expect(text).toContain('Lowering: lower automatically (yours)')
    expect(text).toContain('Raising: never raise (yours)')
  })

  // Where plugin.json files the options: `rightsize`, or `rightsize@<marketplace>`.
  for (const configKey of ['rightsize', 'rightsize@archid21', 'rightsize@inline']) {
    test(`options stored under ${configKey} are yours (${surface})`, { timeoutMs: 30000, options: { floor: 'high' } }, async ($, on) => {
      const h = engine(on, { ...OPUS, stored: { floor: 'high' }, configKey })
      const d = drive($, h)
      await d.start(surface)
      const text = await settingsText(d)
      expect(text).toContain('Lowest effort: high (yours)')
      expect(text, 'another plugin\'s entry is not ours').not.toContain('Highest effort: max (yours)')
    })
  }

  test(`settings that cannot be read: a value that differs from its default counts as yours (${surface})`, { timeoutMs: 30000, options: { ceiling: 'high', floor: 'low' } }, async ($, on) => {
    const h = engine(on, { ...OPUS })
    h.settingsFail = true
    const d = drive($, h)
    await d.start(surface)
    const text = await settingsText(d)
    expect(text).toContain('Highest effort: high (yours)')
    expect(text, 'at its default: nothing says it was set').toContain('Lowest effort: low (default)')
  })

  test(`another plugin's change to a row, and a change to another row of the menu, do not make a row yours (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS })
    const d = drive($, h)
    await d.start(surface)
    await d.config('pacing', 'off', 'plugin')
    expect(await settingsText(d), 'applied, but not yours').toContain('Budget pacing: off (default)')
    await ($ as unknown as { config: { set: (x: unknown) => Promise<unknown> } }).config.set({ key: 'theme', value: 'dark', origin: { kind: 'composer' } })
    expect(await settingsText(d), 'another row of the menu changes nothing here').not.toContain('(yours)')
    await d.config('pacing', 'on')
    expect(await settingsText(d), 'the person sets it back: now it is theirs').toContain('Budget pacing: on (yours)')
    await d.config('escalation', 'off', 'bridge')
    expect(await settingsText(d), "a /config key=value from the person's phone").toContain('Raise when stuck: off (yours)')
  })

  test(`a row changed in /config never reaches another row (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS })
    const d = drive($, h)
    await d.start(surface)
    await d.config('floor', 'high')
    await d.config('handOff', '50%')
    const text = await settingsText(d)
    expect(text).toContain('Lowest effort: high (yours)')
    expect(text).toContain('Hand-off threshold: 50% (yours)')
    expect(text).toContain('Lowering threshold: 90% (default)')
    expect(text).toContain('Highest effort: max (default)')
    expect((text.match(/\(yours\)/g) ?? []).length).toBe(2)
  })

  // ---- Your setting wins ----------------------------------------------------------------------------

  const REPORTS_DOLLARS = /About \$[\d.]+ that way/
  const askAboutFable = { Stronger: 'Ask before sending it to a subagent (Recommended)', Subagent: 'Send it to a Fable subagent', ...YES_REMEMBER }

  test(`Reports set in /config is yours: rate limits that show a subscription change nothing, and /rightsize says they disagree (${surface})`, { timeoutMs: 30000, options: { billing: 'api' } }, async ($, on) => {
    const h = engine(on, { ...OPUS, stored: { billing: 'api' } })
    h.rateLimits = [{ kind: 'five_hour', percentUsed: 12 }, { kind: 'seven_day', percentUsed: 3 }]
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = NEEDS_FABLE
    h.answers = askAboutFable
    await d.submit(DEBUG)
    expect(h.store.billing, 'a reading was never saved over it').toBeUndefined()
    expect(h.asked.find(a => a.header === 'Subagent')?.question ?? '', 'dollars, as you set').toMatch(REPORTS_DOLLARS)
    const text = await settingsText(d)
    expect(text).toContain('Reports: api (yours)')
    expect(text).toContain('Rate limits look like a subscription; Reports is set to api by you.')
  })

  test(`Reports set to subscription stays one when the responses show a gateway's spend limit (${surface})`, { timeoutMs: 30000, options: { billing: 'subscription' } }, async ($, on) => {
    const h = engine(on, { ...OPUS, stored: { billing: 'subscription' } })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    const text = await settingsText(d)
    expect(text).toContain('Reports: subscription (yours)')
    expect(text).toContain('Rate limits look like API billing; Reports is set to subscription by you.')
    expect(h.store.billing).toBeUndefined()
  })

  test(`Reports left at its default is still read off the rate limits, even with other settings made (${surface})`, { timeoutMs: 30000, options: { floor: 'medium' } }, async ($, on) => {
    const h = engine(on, { ...OPUS, stored: { floor: 'medium' } })
    h.rateLimits = [{ kind: 'five_hour', percentUsed: 12 }]
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    expect(h.store.billing).toEqual({ value: 'subscription', by: 'detected' })
    const text = await settingsText(d)
    expect(text).toContain('Reports: subscription (detected)')
    expect(text).not.toContain('Rate limits look like')
  })

  test(`Reports set in /config after the rate limits were read changes the reports at once, and the limits no longer change it (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS })
    h.rateLimits = [{ kind: 'five_hour', percentUsed: 12 }]
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    expect(h.store.billing).toEqual({ value: 'subscription', by: 'detected' })
    await d.config('billing', 'api')
    expect(h.store.billing, 'your answer replaces the reading').toEqual({ value: 'api', by: 'answered' })
    await d.step('t1')
    await d.complete('t1')
    h.rateLimits = [{ kind: 'five_hour', percentUsed: 15 }]
    await d.step('t2')
    await d.complete('t2')
    expect(h.store.billing).toEqual({ value: 'api', by: 'answered' })
    expect(await settingsText(d)).toContain('Reports: api (yours)')
  })

  test(`Reports changed by another plugin is not yours: the rate limits still win (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS })
    h.rateLimits = [{ kind: 'five_hour', percentUsed: 12 }]
    const d = drive($, h)
    await d.start(surface)
    await d.config('billing', 'api', 'plugin')
    await d.step('t0')
    await d.complete('t0')
    expect(h.store.billing).toEqual({ value: 'subscription', by: 'detected' })
  })

  test(`a saved answer from an earlier session is yours too: the rate limits do not replace it (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: { billing: { value: 'api', by: 'answered' } } })
    h.rateLimits = [{ kind: 'five_hour', percentUsed: 12 }]
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    expect(h.store.billing).toEqual({ value: 'api', by: 'answered' })
    expect(await settingsText(d)).toContain('Reports: api (yours)')
  })

  test(`Reports asked again in /rightsize settings replaces a value you set, and writes the row (${surface})`, { timeoutMs: 30000, options: { billing: 'api' } }, async ($, on) => {
    const h = engine(on, { ...OPUS, stored: { billing: 'api' } })
    h.rateLimits = [{ kind: 'five_hour', percentUsed: 12 }]
    const d = drive($, h)
    await d.start(surface)
    h.answers = { Billing: 'Subscription (Pro, Max, Team or Enterprise)', ...YES_REMEMBER }
    await d.command('settings')
    expect(h.asked.some(a => a.header === 'Billing'), 'asked, though the rate limits could answer').toBe(true)
    expect(h.stored.billing).toBe('subscription')
    expect(await settingsText(d)).toContain('Reports: subscription (yours)')
  })

  // A hot window, with a rating that hands off to Haiku at 78% of staying: over the default threshold (70%), under
  // the 85% a hot pace allows. Each row is one session.
  const handedOffUnder = async (h: ReturnType<typeof engine>, d: ReturnType<typeof drive>, rating = NEAR) => {
    await d.start(surface)
    h.rating = rating
    h.answers = CHEAPER_AUTO
    await d.submit(SEARCH)
    return handedTo(h)
  }
  // Lowering saves 94% of staying: over the default 90%, under the 97% a hot window allows.
  const SMALL = '{"level":"low","model":"same","size":"small","type":"lookup","read":2000,"write":50,"steps":1}'
  // Hands off at 51% of staying: over the 50% a cool window allows, under the default 70%.
  const BIG = '{"fit":{"haiku":"medium","sonnet":"medium","opus":"medium","fable":"medium"},"size":"small","type":"search","read":60000,"write":2000,"steps":20,"reason":"list call sites"}'
  const hot = (h: { now: number; rateLimits: unknown }) => void (h.rateLimits = hotWindows(h))
  const cool = (h: { now: number; rateLimits: unknown }) => void (h.rateLimits = [{ kind: 'seven_day', percentUsed: 30, resetsAt: at(h, 6 * HOUR) }])
  const nearlyUsed = (h: { now: number; rateLimits: unknown }) => void (h.rateLimits = [{ kind: 'five_hour', percentUsed: 93, resetsAt: at(h, 4 * HOUR) }])

  const HAND_OFF_ROWS: { name: string; windows: (h: { now: number; rateLimits: unknown }) => void; stored: Record<string, string>; rating: string; to: string | undefined }[] = [
    { name: 'hot, default threshold: moved to 85%, and 78% is under it', windows: hot, stored: {}, rating: NEAR, to: 'haiku' },
    { name: 'hot, set to 70% (its own default value): stays, and 78% is over it', windows: hot, stored: { handOff: '70%' }, rating: NEAR, to: undefined },
    { name: 'hot, set to 80%: stays, and 78% is under it', windows: hot, stored: { handOff: '80%' }, rating: NEAR, to: 'haiku' },
    { name: 'cool, default threshold: moved to 50%, and 51% is over it', windows: cool, stored: {}, rating: BIG, to: undefined },
    { name: 'cool, set to 70%: stays, and 51% is under it', windows: cool, stored: { handOff: '70%' }, rating: BIG, to: 'haiku' },
    { name: 'nearly used up, default threshold: moved to 95%', windows: nearlyUsed, stored: {}, rating: NEAR, to: 'haiku' },
    { name: 'nearly used up, set to 50%: stays, and 78% is over it', windows: nearlyUsed, stored: { handOff: '50%' }, rating: NEAR, to: undefined },
  ]
  for (const row of HAND_OFF_ROWS) {
    test(`pacing and the hand-off threshold: ${row.name} (${surface})`, { timeoutMs: 30000, options: row.stored }, async ($, on) => {
      const h = engine(on, { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES }, stored: row.stored })
      row.windows(h)
      expect(await handedOffUnder(h, drive($, h), row.rating)).toBe(row.to)
    })
  }

  const LOWERING_ROWS: { name: string; stored: Record<string, string>; effort: string }[] = [
    { name: 'default threshold: moved to 97%, and 94% is under it', stored: {}, effort: 'low' },
    { name: 'set to 90% (its own default value): stays, and 94% is over it', stored: { lowering: '90%' }, effort: 'medium' },
    { name: 'set to 95%: stays, and 94% is under it', stored: { lowering: '95%' }, effort: 'low' },
  ]
  for (const row of LOWERING_ROWS) {
    test(`pacing and the lowering threshold, hot: ${row.name} (${surface})`, { timeoutMs: 30000, options: row.stored }, async ($, on) => {
      const h = engine(on, { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES }, stored: row.stored })
      hot(h)
      const d = drive($, h)
      await d.start(surface)
      h.rating = SMALL
      h.answers = { Lowering: 'Lower automatically', ...YES_REMEMBER }
      await d.submit(LOOKUP)
      await d.step('t1')
      expect(last(h.sent)?.effort).toBe(row.effort)
    })
  }

  const NOTE_ROWS: { name: string; stored: Record<string, string>; band: string | RegExp }[] = [
    { name: 'both left at their defaults: moved', stored: {}, band: /so rightsize saves harder\.$/ },
    { name: 'one of them yours: the other moved', stored: { handOff: '70%' }, band: /so rightsize saves harder\.$/ },
    { name: 'both yours: nothing moved, nothing said', stored: { handOff: '70%', lowering: '90%' }, band: 'rightsize: No change: medium on Opus fits this prompt.' },
  ]
  for (const row of NOTE_ROWS) {
    test(`the band mentions pacing only when it moved something: ${row.name} (${surface})`, { timeoutMs: 30000, options: { band: 'always', ...row.stored } }, async ($, on) => {
      const h = engine(on, { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES }, stored: { band: 'always', ...row.stored } })
      hot(h)
      const d = drive($, h)
      await d.start(surface)
      h.rating = NO_CHANGE
      await d.submit(SEARCH)
      const band = await bandText($, surface)
      if (typeof row.band === 'string') expect(band).toBe(row.band)
      else expect(band).toMatch(row.band)
    })
  }

  const PACES: [string, (h: { now: number; rateLimits: unknown }) => void][] = [
    ['an ordinary pace', () => undefined],
    ['a window running hot', hot],
    ['much of a window unused', cool],
  ]
  for (const [name, windows] of PACES) {
    test(`"Ask" for a raise always asks, with ${name} (${surface})`, { timeoutMs: 30000, options: { raiseRule: 'ask me' } }, async ($, on) => {
      const h = engine(on, { ...OPUS, stored: { raiseRule: 'ask me' } })
      windows(h)
      const d = drive($, h)
      await d.start(surface)
      h.rating = RAISE_HIGH
      h.answers = { Effort: 'Keep medium' }
      await d.submit(DEBUG)
      expect(h.asked.map(a => a.header)).toEqual(['Effort'])
      await d.step('t1')
      expect(last(h.sent)?.effort, 'asking never raises on its own').toBe('medium')
    })
  }

  test(`a raise mid-turn when "Ask" is the rule asks, though much of the window will go unused (${surface})`, { timeoutMs: 30000, options: { raiseRule: 'ask me' } }, async ($, on) => {
    const h = engine(on, { ...OPUS, stored: { raiseRule: 'ask me' } })
    cool(h)
    const d = drive($, h)
    await d.start(surface)
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    await d.step('t1', 0)
    await d.bash('fail make')
    await d.bash('fail make')
    h.answers = { Stuck: 'Keep medium' }
    await d.step('t1', 1)
    expect(h.asked.map(a => a.header)).toEqual(['Stuck'])
    expect(last(h.sent)?.effort).toBe('medium')
  })

  // A window at 93% used: a raise or a stronger model is skipped unless you set its rule.
  const BOTH_THRESHOLDS = { handOff: '70%', lowering: '90%' }
  type Raised = { effort: string | undefined; asked: string[]; band?: string }
  const RAISE_ROWS: { name: string; store?: Record<string, unknown>; stored: Record<string, string>; answers?: Record<string, string>; want: Raised | ((r: Raised) => void) }[] = [
    {
      name: 'Raising at its default: skipped, nothing asked',
      stored: {},
      want: { effort: 'medium', asked: [], band: 'rightsize: Kept medium on Opus instead of raising to high. 93% of the 5-hour window is used, so rightsize saves all it can.' },
    },
    {
      name: 'Raising set in /config to automatic: followed, and the band only says how full the window is',
      stored: { raiseRule: 'raise automatically', ...BOTH_THRESHOLDS },
      want: { effort: 'high', asked: [], band: 'rightsize: Effort raised: medium → high for this prompt. 93% of the 5-hour window is used.' },
    },
    {
      name: 'Raising answered in an earlier session and saved: yours too, and the default thresholds that moved are said',
      store: { remember: true, choices: { raise: 'auto' } },
      stored: {},
      want: r => {
        expect([r.effort, r.asked]).toEqual(['high', []])
        expect(r.band).toContain('Effort raised: medium → high for this prompt. 93% of the 5-hour window is used, so rightsize saves all it can.')
      },
    },
    { name: 'Raising set to "ask me": asked', stored: { raiseRule: 'ask me' }, answers: { Effort: 'Raise for this prompt' }, want: r => expect([r.effort, r.asked]).toEqual(['high', ['Effort']]) },
    { name: 'Raising set to never: no raise and no question', stored: { raiseRule: 'never raise' }, want: r => expect([r.effort, r.asked]).toEqual(['medium', []]) },
  ]
  for (const row of RAISE_ROWS) {
    test(`a window nearly used up and a raise: ${row.name} (${surface})`, { timeoutMs: 30000, options: row.stored }, async ($, on) => {
      const h = engine(on, { ...OPUS, ...(row.store ? { store: row.store } : {}), stored: row.stored })
      nearlyUsed(h)
      const d = drive($, h)
      await d.start(surface)
      h.rating = RAISE_HIGH
      h.answers = row.answers ?? {}
      await d.submit(DEBUG)
      await d.step('t1')
      const got: Raised = { effort: last(h.sent)?.effort, asked: h.asked.map(a => a.header), band: await bandText($, surface) }
      if (typeof row.want === 'function') row.want(got)
      else expect(got).toEqual(row.want)
    })
  }

  type Up = { to: string | undefined; asked: string[]; effort: string | undefined }
  const UP_ROWS: { name: string; stored: Record<string, string>; answers?: Record<string, string>; want: Up }[] = [
    { name: 'Stronger model at its default: skipped, nothing asked', stored: {}, want: { to: undefined, asked: [], effort: 'medium' } },
    { name: 'set to "always send": followed', stored: { upRule: 'always send' }, want: { to: 'fable', asked: [], effort: 'medium' } },
    { name: 'set to "ask first": asked', stored: { upRule: 'ask first' }, answers: { Subagent: 'Send it to a Fable subagent' }, want: { to: 'fable', asked: ['Subagent'], effort: 'medium' } },
    { name: 'set to "stay, raise effort only", Raising at its default: no hand-off, and the raise is skipped', stored: { upRule: 'stay, raise effort only' }, want: { to: undefined, asked: [], effort: 'medium' } },
    { name: 'set to "stay, raise effort only", Raising set to automatic: raised', stored: { upRule: 'stay, raise effort only', raiseRule: 'raise automatically' }, want: { to: undefined, asked: [], effort: 'high' } },
  ]
  for (const row of UP_ROWS) {
    test(`a window nearly used up and a stronger model: ${row.name} (${surface})`, { timeoutMs: 30000, options: row.stored }, async ($, on) => {
      const h = engine(on, { ...OPUS, stored: row.stored })
      nearlyUsed(h)
      const d = drive($, h)
      await d.start(surface)
      h.rating = NEEDS_FABLE
      h.answers = row.answers ?? {}
      await d.submit(DEBUG)
      await d.step('t1')
      expect({ to: handedTo(h), asked: h.asked.map(a => a.header), effort: last(h.sent)?.effort }).toEqual(row.want)
    })
  }

  for (const [name, stored, want] of [
    ['Raising at its default: skipped, and logged', {}, ['medium', []]],
    ['Raising set to automatic: followed', { raiseRule: 'raise automatically' }, ['high', []]],
  ] as const) {
    test(`a window nearly used up and a raise mid-turn: ${name} (${surface})`, { timeoutMs: 30000, options: stored }, async ($, on) => {
      const h = engine(on, { ...OPUS, stored })
      nearlyUsed(h)
      const d = drive($, h)
      await d.start(surface)
      h.rating = NO_CHANGE
      await d.submit(LOOKUP)
      await d.step('t1', 0)
      await d.bash('fail make')
      await d.bash('fail make')
      await d.step('t1', 1)
      expect([last(h.sent)?.effort, h.asked.map(a => a.header)]).toEqual(want)
      if (want[0] === 'medium') expect(h.files[LOG] ?? '').toContain('mid-turn raise to high skipped (the same tool call failed twice): the usage window is nearly used up')
    })
  }

  for (const row of [
    { name: 'Pause after misses off: 50% wrong pauses nothing, and the report says no pause', pause: 'off', steppedUp: 3, effort: 'low', paused: false },
    { name: 'at 50%: exactly 50% wrong pauses, and the report says so', pause: '50%', steppedUp: 3, effort: 'medium', paused: true },
    { name: 'at 50%: 33% wrong does not pause', pause: '50%', steppedUp: 2, effort: 'low', paused: false },
    { name: 'at 20%: 33% wrong pauses', pause: '20%', steppedUp: 2, effort: 'medium', paused: true },
  ]) {
    test(`${row.name} (${surface})`, { timeoutMs: 30000, options: { missPause: row.pause } }, async ($, on) => {
      const h = engine(on, { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES }, stored: { missPause: row.pause } })
      h.now = Date.now()
      h.files[RUNS] = lookupLog(h, row.steppedUp)
      const d = drive($, h)
      await d.start(surface)
      h.rating = LOWER
      h.answers = { Lowering: 'Lower automatically', ...YES_REMEMBER }
      await d.submit(LOOKUP)
      await d.step('t1')
      expect(last(h.sent)?.effort).toBe(row.effort)
      const report = (await d.command('report')).text ?? ''
      expect(report.includes('are paused')).toBe(row.paused)
      expect(report).toContain(`Haiku's judgement was wrong on ${row.steppedUp} of 6 checked prompts`)
    })
  }

  test(`Use Haiku off: no hand-off and no resized subagent goes to Haiku, and Haiku still rates the prompts (${surface})`, { timeoutMs: 30000, options: { useHaiku: 'off' } }, async ($, on) => {
    const h = engine(on, { ...OPUS, stored: { useHaiku: 'off' } })
    const d = drive($, h)
    await d.start(surface)
    h.rating = NO_CHANGE
    await d.submit(SEARCH)
    await d.step('t1', 0)
    expect(h.completions, 'the rater is Haiku, not a worker').toContain('haiku')
    h.rating = LISTING
    await d.spawn('lister')
    expect(h.spawned[0]?.model, "Claude's subagent goes to Sonnet instead").toBe('sonnet')
  })

  const RULE_ROWS: { name: string; rule: string; store?: Record<string, unknown>; want: { asked: string[]; effort: string } }[] = [
    { name: 'lower automatically', rule: 'lower automatically', want: { asked: [], effort: 'low' } },
    { name: 'never lower', rule: 'never lower', want: { asked: [], effort: 'medium' } },
    { name: 'ask me: asks each time, with the effort question', rule: 'ask me', want: { asked: ['Effort'], effort: 'medium' } },
    { name: 'never lower, over the saved answers of an earlier session', rule: 'never lower', store: { remember: true, choices: { lower: 'auto' } }, want: { asked: [], effort: 'medium' } },
  ]
  for (const row of RULE_ROWS) {
    test(`Lowering set in /config to ${row.name} is used as it is (${surface})`, { timeoutMs: 30000, options: { lowerRule: row.rule } }, async ($, on) => {
      const h = engine(on, { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES, ...(row.store ?? {}) }, stored: { lowerRule: row.rule } })
      const d = drive($, h)
      await d.start(surface)
      h.rating = LOWER
      h.answers = { Effort: 'Keep medium' }
      await d.submit(LOOKUP)
      await d.step('t1')
      expect({ asked: h.asked.map(a => a.header), effort: last(h.sent)?.effort }).toEqual(row.want)
    })
  }

  test(`a rule row set back to "not set" clears the rule, in this session and in the saved copy: the question comes back (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES, remember: true, choices: { lower: 'auto', raise: 'auto' } } })
    const d = drive($, h)
    await d.start(surface)
    expect(await settingsText(d), 'the saved answer is yours').toContain('Lowering: lower automatically (yours)')
    await d.config('lowerRule', 'not set')
    expect(await settingsText(d)).toContain('Lowering: not set (default)')
    expect(h.store.choices, 'the saved copy keeps only the other rule').toEqual({ raise: 'auto' })
    h.rating = LOWER
    h.answers = { Lowering: 'Never lower' }
    await d.submit(LOOKUP)
    expect(h.asked.map(a => a.header), 'asked again').toEqual(['Lowering'])
    // A new session keeps the other rule.
    await d.start(surface)
    expect(await settingsText(d)).toContain('Raising: raise automatically (yours)')
  })

  const KEEP_ROWS: { name: string; mode?: string; remember: string; asked: string[]; kept: boolean; remembered?: boolean }[] = [
    { name: 'ask, yes: kept, and Remember choices becomes every session', remember: 'Yes, from now on', asked: ['Lowering', 'Remember'], kept: true, remembered: true },
    { name: 'ask, just this session: kept for the session only', remember: 'Just this session', asked: ['Lowering', 'Remember'], kept: false },
    { name: 'every session: kept without asking', mode: 'every session', remember: 'Just this session', asked: ['Lowering'], kept: true },
    { name: 'this session: never asked, never kept', mode: 'this session', remember: 'Yes, from now on', asked: ['Lowering'], kept: false },
  ]
  for (const row of KEEP_ROWS) {
    test(`Remember choices, ${row.name} (${surface})`, { timeoutMs: 30000, ...(row.mode ? { options: { remember: row.mode } } : {}) }, async ($, on) => {
      const h = engine(on, { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES }, ...(row.mode ? { stored: { remember: row.mode } } : {}) })
      const d = drive($, h)
      await d.start(surface)
      h.rating = LOWER
      h.answers = { Lowering: 'Lower automatically', Remember: row.remember }
      await d.submit(LOOKUP)
      expect(h.asked.map(a => a.header)).toEqual(row.asked)
      expect(h.store.choices, 'the store').toEqual(row.kept ? { lower: 'auto' } : undefined)
      expect(h.stored.lowerRule, 'the Lowering row').toBe(row.kept ? 'lower automatically' : undefined)
      expect(h.store.remember).toBe(row.remembered ? true : undefined)
      if (row.remembered) expect(h.stored.remember, 'the Remember choices row').toBe('every session')
      expect(await settingsText(d), 'the answer is yours either way').toContain('Lowering: lower automatically (yours)')
    })
  }

  test(`Remember choices set live to every session keeps what was answered so far, and back to ask asks again (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    await d.start(surface)
    h.rating = LOWER
    h.answers = { Lowering: 'Lower automatically', ...YES_REMEMBER }
    await d.submit(LOOKUP)
    expect(h.store.choices, 'not kept yet').toBeUndefined()
    await d.config('remember', 'every session')
    expect(h.store.choices).toEqual({ lower: 'auto' })
    expect(h.stored.lowerRule).toBe('lower automatically')
    await d.config('remember', 'ask')
    expect(h.store.remember, 'ask again').toBe(false)
  })

  test(`a band button sets the rule's /config row, and so does /rightsize settings (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    await d.start(surface)
    h.rating = LOWER
    h.answers = { Lowering: 'Lower automatically', ...YES_REMEMBER }
    await d.submit(LOOKUP)
    const ui = await mount($, surface)
    await ui.press({ key: 'rule-never' })
    await ui.unmount()
    expect(h.stored.lowerRule).toBe('never lower')
    expect(h.sets.find(x => x.key === 'rightsize.lowerRule')?.value).toBe('never lower')

    // /rightsize settings asks the four questions again and writes every row.
    h.answers = { Lowering: 'Ask me each time', Raising: 'Never raise', Stronger: 'Send it to a subagent automatically', Cheaper: 'Ask before sending it', ...YES_REMEMBER }
    const text = (await d.command('settings')).text ?? ''
    expect(h.stored).toMatchObject({ lowerRule: 'ask me', raiseRule: 'never raise', upRule: 'always send', downRule: 'ask first' })
    expect(text).toContain('Lowering: ask me (yours)')
    expect(text).toContain('Raising: never raise (yours)')
    expect(text).toContain('Cheaper model: ask first (yours)')
  })

  // ---- Price check: monthly or off ----------------------------------------------------------------

  test(`a stored "check now" is not an option any more: it counts as unset, monthly applies, and nothing is checked at the start (${surface})`, { timeoutMs: 30000, options: { priceCheck: 'check now' } }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: { pricesCheckedAt: 1_800_000_000_000 - DAY }, stored: { priceCheck: 'check now' } })
    h.page = PAGE
    h.pricesFile = OLD_PRICES
    const d = drive($, h)
    await d.start(surface)
    await flush()
    const text = await settingsText(d)
    expect(text, 'monthly, and not yours').toContain('Price check: monthly (default)')
    expect(h.fetches, 'it used to check once at the start').toBe(0)
    expect(h.configSet, 'and to write the row back').toEqual([])
    // /rightsize prices is how to check now.
    expect((await d.command('prices')).text ?? '').toContain('Sonnet 5.5 cache read')
    expect(h.fetches).toBe(1)
  })

  test(`Price check off stops the monthly check, and /rightsize prices still checks (${surface})`, { timeoutMs: 30000, options: { priceCheck: 'off' } }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: { pricesCheckedAt: 1_800_000_000_000 - 31 * DAY }, stored: { priceCheck: 'off' } })
    h.page = PAGE
    h.pricesFile = OLD_PRICES
    const d = drive($, h)
    await d.start(surface)
    await flush()
    expect(h.fetches).toBe(0)
    await d.command('prices')
    expect(h.fetches).toBe(1)
    // Back to monthly in /config: once a month has passed, the next start checks.
    await d.config('priceCheck', 'monthly')
    h.now += 31 * DAY
    await d.start(surface)
    await flush()
    expect(h.fetches).toBe(2)
  })

  // ---- Workflows ------------------------------------------------------------------------------------

  const WORKFLOW_QUESTION =
    'Claude is starting a workflow. It may start many helper agents at once, often 10 or more, and each picks its own model. What should rightsize do during workflows? You can change this any time with Workflows in /config.'
  const WORKFLOW_ANSWERS: [string, string][] = [
    ['Pause rightsize for workflows (recommended)', 'pause rightsize'],
    ['Follow my rules for the main chat', 'follow my rules'],
    ['Also right-size every workflow agent (one Haiku rating per agent; many may run on cheaper models at once)', 'right-size every agent'],
  ]
  /** A turn that starts a workflow, with the Workflow question answered as `answer` (none: closed without an answer). */
  const startWorkflow = async (h: ReturnType<typeof engine>, d: ReturnType<typeof drive>, answer?: string, turn = 't1', id?: string) => {
    h.rating = NO_CHANGE
    h.answers = answer ? { Workflow: answer } : {}
    await d.submit(LOOKUP)
    await d.step(turn)
    await d.workflow(id)
  }

  test(`at ask, the Workflow question comes before the workflow starts, with its three answers (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS })
    const d = drive($, h)
    await d.start(surface)
    await startWorkflow(h, d, 'Follow my rules for the main chat')
    expect(h.events.filter(x => x === 'workflow' || x === 'ask:Workflow'), 'asked first').toEqual(['ask:Workflow', 'workflow'])
    const q = h.asked.find(a => a.header === 'Workflow')
    expect(q?.question).toBe(WORKFLOW_QUESTION)
    expect(q?.options).toEqual(WORKFLOW_ANSWERS.map(a => a[0]))
  })

  for (const [label, value] of WORKFLOW_ANSWERS) {
    test(`the Workflow answer "${value}" is saved to Workflows, is yours, and is not asked again (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
      const h = engine(on, { ...OPUS })
      const d = drive($, h)
      await d.start(surface)
      await startWorkflow(h, d, label)
      expect(h.stored.workflows).toBe(value)
      expect(await settingsText(d)).toContain(`Workflows: ${value} (yours)`)
      await d.workflow()
      expect(h.events.filter(x => x === 'ask:Workflow').length, 'once').toBe(1)
      expect(h.events.filter(x => x === 'workflow').length).toBe(2)
      // A new session does not ask either: it is a setting now.
      await d.start(surface)
      await d.workflow()
      expect(h.events.filter(x => x === 'ask:Workflow').length).toBe(1)
    })
  }

  test(`closed without an answer: paused for this workflow, nothing saved, asked again at the next one (${surface})`, { timeoutMs: 30000, options: { upRule: 'always send' } }, async ($, on) => {
    const h = engine(on, { ...OPUS, stored: { upRule: 'always send' } })
    const d = drive($, h)
    await d.start(surface)
    await startWorkflow(h, d)
    expect(h.stored.workflows, 'nothing saved').toBeUndefined()
    expect(await settingsText(d)).toContain('Workflows: ask (default)')
    // Paused: the hand-off waits, though the rule says always send.
    h.rating = NEEDS_FABLE
    await d.submit(DEBUG)
    expect(handedTo(h), 'paused').toBeUndefined()
    // The next workflow asks again.
    await d.workflow()
    expect(h.events.filter(x => x === 'ask:Workflow').length).toBe(2)
  })

  test(`a workflow call is asked about once, even when its hook runs again (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS })
    const d = drive($, h)
    await d.start(surface)
    await startWorkflow(h, d, undefined, 't1', 'toolu_1')
    await d.workflow('toolu_1')
    expect(h.events.filter(x => x === 'ask:Workflow').length, 'the same call').toBe(1)
    await d.workflow('toolu_2')
    expect(h.events.filter(x => x === 'ask:Workflow').length, 'another call').toBe(2)
  })

  test(`rightsize off in /mods: a workflow is not asked about (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS })
    h.files['/home/test/.claude/mods/switches.json'] = '{"rightsize": false}'
    const d = drive($, h)
    await d.start(surface)
    await d.workflow()
    expect(h.events).toEqual(['workflow'])
  })

  test(`a set Workflows value is never asked about (${surface})`, { timeoutMs: 30000, options: { workflows: 'pause rightsize' } }, async ($, on) => {
    const h = engine(on, { ...OPUS, stored: { workflows: 'pause rightsize' } })
    const d = drive($, h)
    await d.start(surface)
    await d.workflow()
    expect(h.events).toEqual(['workflow'])
  })

  // After a workflow, a hand-off goes ahead or waits as Workflows says; the rule here is "always send".
  const AFTER_ROWS: { mode: string; to: string | undefined }[] = [
    { mode: 'ask', to: undefined },
    { mode: 'pause rightsize', to: undefined },
    { mode: 'follow my rules', to: 'fable' },
    { mode: 'right-size every agent', to: 'fable' },
  ]
  for (const row of AFTER_ROWS) {
    test(`Workflows ${row.mode}: a hand-off after a workflow ${row.to ? 'follows your rules' : 'waits'} (${surface})`, { timeoutMs: 30000, options: { workflows: row.mode, upRule: 'always send' } }, async ($, on) => {
      const h = engine(on, { ...OPUS, stored: { workflows: row.mode, upRule: 'always send' } })
      const d = drive($, h)
      await d.start(surface)
      await startWorkflow(h, d)
      h.rating = NEEDS_FABLE
      await d.submit(DEBUG)
      expect(handedTo(h)).toBe(row.to)
      if (!row.to) expect(h.files[LOG] ?? '').toContain('hand-off to fable skipped: a workflow ran this session')
    })
  }

  // A workflow's agent, from the Workflow tool: `workflow` names the run. Only "right-size every agent" sizes it.
  const WORKFLOW_AGENT = { workflow: { runId: 'wf_1', agentIndex: 1 } }
  const SPAWN_ROWS: { name: string; options: Record<string, string>; model: string | undefined; rated: boolean }[] = [
    { name: 'ask (closed without an answer): the agent is left alone', options: {}, model: undefined, rated: false },
    { name: 'pause rightsize: left alone', options: { workflows: 'pause rightsize' }, model: undefined, rated: false },
    { name: 'follow my rules: left alone', options: { workflows: 'follow my rules' }, model: undefined, rated: false },
    { name: 'right-size every agent: sized, with one rating', options: { workflows: 'right-size every agent' }, model: 'haiku', rated: true },
    { name: "right-size every agent with Claude's subagents off: left alone, and no rating", options: { workflows: 'right-size every agent', subagents: 'off' }, model: undefined, rated: false },
    { name: 'right-size every agent with Use Haiku off: Sonnet instead', options: { workflows: 'right-size every agent', useHaiku: 'off' }, model: 'sonnet', rated: true },
  ]
  for (const row of SPAWN_ROWS) {
    test(`a workflow's agent, with Workflows at ${row.name} (${surface})`, { timeoutMs: 30000, options: row.options }, async ($, on) => {
      const h = engine(on, { ...OPUS, stored: row.options })
      const d = drive($, h)
      await d.start(surface)
      await startWorkflow(h, d)
      h.rating = LISTING
      const before = h.ratings
      await d.spawn('wf-agent', undefined, WORKFLOW_AGENT)
      expect(h.spawned[0]?.model).toBe(row.model)
      expect(h.ratings - before, 'one Haiku rating for the agent, or none').toBe(row.rated ? 1 : 0)
    })
  }

  test(`with Workflows at right-size every agent, a fork, a teammate, a resume and an agent started by an agent are still left alone (${surface})`, { timeoutMs: 30000, options: { workflows: 'right-size every agent' } }, async ($, on) => {
    const h = engine(on, { ...OPUS, stored: { workflows: 'right-size every agent' } })
    const d = drive($, h)
    await d.start(surface)
    await startWorkflow(h, d)
    h.rating = LISTING
    await d.spawn('forked', undefined, { ...WORKFLOW_AGENT, fork: true })
    await d.spawn('mate', undefined, { ...WORKFLOW_AGENT, isTeammate: true })
    await d.spawn('again', undefined, { ...WORKFLOW_AGENT, resume: true })
    await d.spawn('nested', undefined, { ...WORKFLOW_AGENT, parentAgentId: 'agent-x' })
    await d.spawn('named', 'opus', WORKFLOW_AGENT)
    await d.spawn('explorer', undefined, { ...WORKFLOW_AGENT, subagentType: 'Explore' })
    expect(h.spawned.map(x => x.model ?? null)).toEqual([null, null, null, null, 'opus', null])
    // And one that is not a workflow's is sized as before.
    await d.spawn('lister')
    expect(last(h.spawned)?.model).toBe('haiku')
  })

  const MODES = ['ask', 'pause rightsize', 'follow my rules', 'right-size every agent']
  for (const mode of MODES) {
    test(`Workflows ${mode}: measurement stays paused after a workflow: calibration learns nothing, and its turns are marked (${surface})`, { timeoutMs: 30000, options: { workflows: mode } }, async ($, on) => {
      const h = engine(on, { ...OPUS, stored: { workflows: mode } })
      const d = drive($, h)
      await d.start(surface)
      await d.step('t0')
      await d.complete('t0')
      const learned = () => Object.keys((h.store[CAL_STORE] as Record<string, unknown> | undefined) ?? {}).filter(k => k.startsWith('lookup:') || k.endsWith(':subagent') || k.includes(':subagent:'))
      h.rating = NO_CHANGE
      await d.submit(LOOKUP)
      await d.step('t1', 0)
      await d.workflow()
      if (mode === 'right-size every agent') {
        h.rating = LISTING
        await d.spawn('wf-agent', undefined, WORKFLOW_AGENT)
        expect(h.spawned[0]?.model, 'sized').toBe('haiku')
        await d.step('w1', 0, 'agent-wf-agent')
        await d.step('w1', 1, 'agent-wf-agent')
      }
      await d.complete('t1')
      if (mode === 'right-size every agent') await d.answer('agent-wf-agent')
      await d.submit(LOOKUP)
      await d.step('t2')
      await d.complete('t2')
      expect(learned(), 'nothing learned').toEqual([])
      const lines = runLines(h)
      expect(lines.filter(l => l.kind === 'run').map(l => l.afterWorkflow), 'both turns marked').toEqual([true, true])
      if (mode === 'right-size every agent') {
        const sub = lines.filter(l => l.kind === 'subagent')
        expect(sub.map(l => l.afterWorkflow), 'the agent is logged, and marked').toEqual([true])
        h.now = Date.now()
        expect((await d.command('report')).text ?? '').toContain('1 subagent Claude started ran on a cheaper model.')
      }
    })
  }

  // ---- /rightsize reset ------------------------------------------------------------------------------------

  const SETTINGS_GO = "Every rightsize setting in /config goes back to its default, and your saved answers to the four questions are forgotten. This can't be undone."
  const MEASURE_GO = "rightsize goes back to its starting estimates and relearns from your next prompts. This can't be undone."
  const SOME_SET = { floor: 'medium', handOff: '50%', lowerRule: 'never lower', remember: 'every session', billing: 'api', band: 'always', pacing: 'off' }

  // A session with settings made, answers saved, and a cost measurement behind it.
  const measured = (h: ReturnType<typeof engine>) => {
    h.now = Date.now()
    h.store.pricesCheckedAt = h.now
    h.files[RUNS] = lookupLog(h, 3) + easyLog(h.now) + '\n'
  }
  const MEASURE_STORE = {
    [CAL_STORE]: { ...FREE_SWITCHES, 'lookup:main': { n: 5, ratio: 1.5 } },
    ties: 7,
    spotChecks: 3,
    startCheckedAt: 1_800_000_000_000 - DAY,
    startSnooze: { key: 'sonnet:high', until: 1_900_000_000_000 },
    remember: true,
    choices: { raise: 'auto' },
  }

  test(`/rightsize reset asks what to reset, with four choices, then confirms with what goes (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS })
    const d = drive($, h)
    await d.start(surface)
    h.answers = { Reset: 'Cancel' }
    const out = await d.command('reset')
    expect(h.asked.map(a => a.header)).toEqual(['Reset'])
    expect(h.asked[0]?.question).toBe('What should I reset?')
    expect(h.asked[0]?.options).toEqual(['Settings', 'Cost measurement', 'Both', 'Cancel'])
    expect(out.text).toBe('Nothing was reset.')
    for (const [choice, text] of [
      ['Settings', `Reset settings? ${SETTINGS_GO}`],
      ['Cost measurement', `Reset cost measurement? ${MEASURE_GO}`],
      ['Both', `Reset settings and cost measurement? ${SETTINGS_GO.replace(" This can't be undone.", '')} ${MEASURE_GO}`],
    ] as const) {
      h.asked.length = 0
      h.answers = { Reset: choice, Confirm: 'No' }
      expect((await d.command('reset')).text, choice).toBe('Nothing was reset.')
      expect(h.asked.map(a => a.header), choice).toEqual(['Reset', 'Confirm'])
      expect(h.asked[1]?.question, choice).toBe(text)
      expect(h.asked[1]?.options, choice).toEqual(['Yes', 'No'])
    }
  })

  for (const choice of ['Settings', 'Cost measurement', 'Both', 'Cancel']) {
    for (const confirm of ['No', 'closed']) {
      if (choice === 'Cancel' && confirm === 'closed') continue
      test(`/rightsize reset ${choice}${choice === 'Cancel' ? '' : `, ${confirm === 'No' ? 'confirmed with No' : 'confirmation closed'}`}: nothing changes (${surface})`, { timeoutMs: 30000, options: SOME_SET }, async ($, on) => {
        const h = engine(on, { ...OPUS, store: MEASURE_STORE, stored: SOME_SET })
        measured(h)
        const d = drive($, h)
        await d.start(surface)
        const store = JSON.stringify(h.store)
        const stored = JSON.stringify(h.stored)
        const sets = h.sets.length
        const before = await settingsText(d)
        h.answers = { Reset: choice, ...(confirm === 'No' ? { Confirm: 'No' } : {}) }
        expect((await d.command('reset')).text).toBe('Nothing was reset.')
        expect(JSON.stringify(h.store), 'the store').toBe(store)
        expect(JSON.stringify(h.stored), 'settings.json').toBe(stored)
        expect(await settingsText(d)).toBe(before)
        expect(h.sets.length, 'nothing was written').toBe(sets)
      })
    }
  }

  const ROWS_RESET = Object.keys(SOME_SET)
  const resetSettingsRun = async ($: unknown, h: ReturnType<typeof engine>, choice: string) => {
    const d = drive($, h)
    await d.start(surface)
    h.rating = LOWER
    h.answers = { Reset: choice, Confirm: 'Yes' }
    const before = h.sets.length
    return { d, before, out: (await d.command('reset')).text ?? '' }
  }
  for (const choice of ['Settings', 'Both']) {
    test(`/rightsize reset ${choice}: every row is back to its default, and shows (default) though the stored value equals the default (${surface})`, { timeoutMs: 30000, options: SOME_SET }, async ($, on) => {
      const h = engine(on, { ...OPUS, store: MEASURE_STORE, stored: SOME_SET })
      measured(h)
      const { d, out, before } = await resetSettingsRun($, h, choice)
      expect(out).toContain('Every setting is back to its default, and the saved answers are forgotten.')
      const text = await settingsText(d)
      expect(text).not.toContain('(yours)')
      for (const key of KEYS) expect(text, key).toContain(`${SETTINGS[key].title}: ${SETTINGS[key].default} (default)`)
      // The defaults were written, through the config API (plugin origin), where the value was not already the default.
      for (const key of ROWS_RESET) expect(h.stored[key], `${key} stored as its default`).toBe(SETTINGS[key as SettingKey].default)
      // Raising was the saved answer, shown in its row at the start: the reset writes it back to not set.
      expect(h.sets.slice(before).map(x => x.key.replace('rightsize.', '')).sort(), 'only the rows that were not default').toEqual(['band', 'floor', 'handOff', 'lowerRule', 'pacing', 'raiseRule', 'remember'])
      // billing was stored as api, which is the default: reset without a write.
      expect(h.stored.billing).toBe('api')
      expect(h.store.choices, 'saved answers cleared').toBeNull()
      for (const key of ROWS_RESET) expect(h.store.resetFields, `${key} is on the list`).toContain(key)
      // The saved answers are gone from this session too: the Raising question (saved as automatic) comes back.
      h.rating = RAISE_HIGH
      h.answers = { Raising: 'Never raise' }
      await d.submit(DEBUG)
      expect(h.asked.map(a => a.header)).toContain('Raising')
      // A new session still shows defaults: the stored values equal them.
      await d.start(surface)
      const again = await settingsText(d)
      expect(again.match(/\(yours\)/g) ?? [], 'only the answer given just now').toHaveLength(1)
      expect(again).toContain('Raising: never raise (yours)')
      // Reports is read off the rate limits once a prompt went through, and saved: not yours either.
      for (const key of ROWS_RESET.filter(k => k !== 'billing')) expect(again, key).toContain(`${SETTINGS[key as SettingKey].title}: ${SETTINGS[key as SettingKey].default} (default)`)
      expect(again).toContain('Reports: api (saved)')
    })
  }

  test(`a row reset then set again in /config is yours again, whatever its value, and leaves the list (${surface})`, { timeoutMs: 30000, options: SOME_SET }, async ($, on) => {
    const h = engine(on, { ...OPUS, stored: SOME_SET })
    const { d } = await resetSettingsRun($, h, 'Settings')
    expect(await settingsText(d)).toContain('Lowest effort: low (default)')
    await d.config('floor', 'high')
    expect(await settingsText(d)).toContain('Lowest effort: high (yours)')
    expect(h.store.resetFields).not.toContain('floor')
    expect(h.store.resetFields, 'the others stay on it').toContain('handOff')
    // Set to the default value itself: yours too.
    await d.config('handOff', '70%', 'bridge')
    expect(await settingsText(d)).toContain('Hand-off threshold: 70% (yours)')
    expect(h.store.resetFields).not.toContain('handOff')
    // A new session keeps all of that: floor and handOff are yours, the rest default.
    await d.start(surface)
    const text = await settingsText(d)
    expect(text).toContain('Lowest effort: high (yours)')
    expect(text).toContain('Hand-off threshold: 70% (yours)')
    expect(text).toContain('Band: when it acts (default)')
    expect((text.match(/\(yours\)/g) ?? []).length).toBe(2)
  })

  test(`a reset row changed by hand in settings.json is yours at the next start (${surface})`, { timeoutMs: 30000, options: SOME_SET }, async ($, on) => {
    const h = engine(on, { ...OPUS, stored: SOME_SET })
    const { d } = await resetSettingsRun($, h, 'Settings')
    h.stored.floor = 'high'
    await d.start(surface)
    const text = await settingsText(d)
    expect(text).toMatch(/Lowest effort: \w+ \(yours\)/)
    expect(text).toContain('Hand-off threshold: 70% (default)')
    expect(h.store.resetFields, 'floor left the list').not.toContain('floor')
  })

  // One setting, by key or by title, in any case.
  for (const name of ['handOff', 'HANDOFF', 'hand-off threshold', 'Hand-Off Threshold']) {
    test(`/rightsize reset ${name} resets that one setting and confirms first (${surface})`, { timeoutMs: 30000, options: SOME_SET }, async ($, on) => {
      const h = engine(on, { ...OPUS, store: MEASURE_STORE, stored: SOME_SET })
      const d = drive($, h)
      await d.start(surface)
      h.answers = { Confirm: 'Yes' }
      const out = await d.command(`reset ${name}`)
      expect(h.asked.map(a => a.header), 'no menu: it names the setting').toEqual(['Confirm'])
      expect(h.asked[0]?.question).toBe("Reset Hand-off threshold? It goes back to its default, 70%. This can't be undone.")
      expect(out.text).toBe('Hand-off threshold is back to its default, 70%.')
      const text = await settingsText(d)
      expect(text).toContain('Hand-off threshold: 70% (default)')
      expect(text, 'the others are as they were').toContain('Lowest effort: medium (yours)')
      expect(text).toContain('Budget pacing: off (yours)')
      expect(h.stored.handOff).toBe('70%')
      expect(h.store.resetFields).toEqual(['handOff'])
      expect(h.store.choices, 'the saved answers stay').toEqual({ raise: 'auto' })
      // The other six rows, and the saved answer for Raising: seven.
      expect((text.match(/\(yours\)/g) ?? []).length).toBe(7)
    })
  }

  test(`/rightsize reset on one setting declined: nothing changes (${surface})`, { timeoutMs: 30000, options: SOME_SET }, async ($, on) => {
    const h = engine(on, { ...OPUS, stored: SOME_SET })
    const d = drive($, h)
    await d.start(surface)
    h.answers = { Confirm: 'No' }
    expect((await d.command('reset handOff')).text).toBe('Nothing was reset.')
    expect(await settingsText(d)).toContain('Hand-off threshold: 50% (yours)')
    expect(h.stored.handOff).toBe('50%')
  })

  test(`/rightsize reset on a rule row forgets that answer, and its question comes back; the other answers stay (${surface})`, { timeoutMs: 30000, options: { lowerRule: 'never lower', raiseRule: 'never raise' } }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES }, stored: { lowerRule: 'never lower', raiseRule: 'never raise' } })
    const d = drive($, h)
    await d.start(surface)
    h.answers = { Confirm: 'Yes' }
    const out = await d.command('reset Lowering')
    expect(h.asked[0]?.question).toBe("Reset Lowering? It goes back to its default, not set. Its question is asked again the next time it comes up. This can't be undone.")
    expect(out.text).toContain('Lowering is back to its default, not set.')
    const text = await settingsText(d)
    expect(text).toContain('Lowering: not set (default)')
    expect(text).toContain('Raising: never raise (yours)')
    h.rating = LOWER
    h.answers = { Lowering: 'Never lower' }
    await d.submit(LOOKUP)
    expect(h.asked.map(a => a.header)).toContain('Lowering')
  })

  test(`/rightsize reset on Reports forgets the answer, and the rate limits read the billing again (${surface})`, { timeoutMs: 30000, options: { billing: 'api' } }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: { billing: { value: 'api', by: 'answered' } }, stored: { billing: 'api' } })
    h.rateLimits = [{ kind: 'five_hour', percentUsed: 12 }]
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    expect(h.store.billing, 'your answer stands').toEqual({ value: 'api', by: 'answered' })
    h.answers = { Confirm: 'Yes' }
    await d.command('reset billing')
    expect(h.store.billing, 'your answer is gone').toBeNull()
    expect(await settingsText(d)).toContain('Reports: api (default)')
    // The next response's rate limits read the billing again.
    await d.step('t1')
    await d.complete('t1')
    expect(h.store.billing).toEqual({ value: 'subscription', by: 'detected' })
    expect(await settingsText(d)).toContain('Reports: subscription (detected)')
  })

  test(`/rightsize reset on Remember choices asks about keeping answers again (${surface})`, { timeoutMs: 30000, options: { remember: 'every session' } }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES, remember: true }, stored: { remember: 'every session' } })
    const d = drive($, h)
    await d.start(surface)
    h.answers = { Confirm: 'Yes' }
    await d.command('reset remember')
    expect(h.store.remember, 'the old yes is forgotten').toBe(false)
    h.rating = LOWER
    h.answers = { Lowering: 'Lower automatically', Remember: 'Just this session' }
    h.asked.length = 0
    await d.submit(LOOKUP)
    expect(h.asked.map(a => a.header)).toEqual(['Lowering', 'Remember'])
  })

  test(`/rightsize reset on Share anonymous feedback turns sharing off and forgets the install id (${surface})`, { timeoutMs: 30000, options: { share: 'on' } }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: { shareInstall: 'b'.repeat(32) }, stored: { share: 'on' } })
    const d = drive($, h)
    await d.start(surface)
    h.answers = { Confirm: 'Yes' }
    await d.command('reset share')
    expect(await settingsText(d)).toContain('Share anonymous feedback: off (default)')
    expect(h.store.shareInstall).toBeNull()
  })

  test(`/rightsize reset with a name it does not know says so and lists the keys, and asks nothing (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS })
    const d = drive($, h)
    await d.start(surface)
    const out = (await d.command('reset hand off threshhold')).text ?? ''
    expect(out).toContain('No setting called "hand off threshhold".')
    for (const key of KEYS) expect(out, key).toContain(key)
    expect(h.asked).toEqual([])
  })

  for (const choice of ['Cost measurement', 'Both']) {
    test(`/rightsize reset ${choice}: the calibration and counts go, measureFrom is set, and the log and report history stay (${surface})`, { timeoutMs: 30000, options: { lowerRule: 'lower automatically' } }, async ($, on) => {
      const h = engine(on, { ...OPUS, store: MEASURE_STORE, stored: { lowerRule: 'lower automatically' } })
      measured(h)
      const log = h.files[RUNS] ?? ''
      const d = drive($, h)
      await d.start(surface)
      expect(await settingsText(d), 'the calibration was loaded').toContain('Calibration: 5 measured run(s).')
      h.answers = { Reset: choice, Confirm: 'Yes' }
      const out = (await d.command('reset')).text ?? ''
      expect(out).toContain('Cost measurement restarted: rightsize is back to its starting estimates and relearns from your next prompts.')
      for (const key of [CAL_STORE, 'ties', 'spotChecks', 'startCheckedAt', 'startSnooze']) expect(h.store[key], key).toBeNull()
      expect(h.store.measureFrom).toBe(new Date(h.now).toISOString())
      expect(await settingsText(d), 'in memory too').toContain('Calibration: 0 measured run(s).')
      expect(h.files[RUNS], 'the run log is kept, line for line').toBe(log)
      // The report still counts all of it, and says when measurement restarted.
      const report = (await d.command('report')).text ?? ''
      expect(report).toContain(`Cost measurement restarted on ${new Date(h.now).toISOString().slice(0, 10)}.`)
      expect(report).toContain('Last 7 days and last 30 days\n  Prompts: 66 rated')
      expect(report, 'what went wrong reads the whole history').toContain("Haiku's judgement was wrong on 3 of 6 checked prompts (50%)")
      expect(report, 'but nothing is paused any more').not.toContain('are paused')
      // Settings stay unless Both.
      expect(await settingsText(d)).toContain(choice === 'Both' ? 'Lowering: not set (default)' : 'Lowering: lower automatically (yours)')
    })
  }

  test(`live miss rates ignore the run log from before Cost measurement restarted (${surface})`, { timeoutMs: 30000, options: { lowerRule: 'lower automatically' } }, async ($, on) => {
    const h = engine(on, { ...OPUS, stored: { lowerRule: 'lower automatically' } })
    h.now = Date.now()
    // Wrong on 3 of 6 lookups on Opus: lowering is paused.
    h.files[RUNS] = lookupLog(h, 3)
    const d = drive($, h)
    await d.start(surface)
    // Lowering saves enough to pay even without evidence about the cache.
    h.rating = '{"level":"low","model":"same","size":"small","type":"lookup","read":2000,"write":40000,"steps":1}'
    await d.submit(LOOKUP)
    await d.step('t1')
    expect(last(h.sent)?.effort, 'paused: stays at medium').toBe('medium')
    await d.complete('t1')
    h.answers = { Reset: 'Cost measurement', Confirm: 'Yes' }
    await d.command('reset')
    await d.submit(LOOKUP)
    await d.step('t2')
    expect(last(h.sent)?.effort, 'those lines teach nothing now: lowered').toBe('low')
    await d.complete('t2')
    // The calibration restarted too: it learns again from this turn.
    expect(Object.keys((h.store[CAL_STORE] as Record<string, unknown> | null) ?? {}).length).toBeGreaterThan(0)
    // And a restart keeps it: measureFrom is read back from the store.
    await d.start(surface)
    await d.submit(LOOKUP)
    await d.step('t3')
    expect(last(h.sent)?.effort).toBe('low')
  })

  test(`the starting-point check and the report's comparison ignore the run log from before Cost measurement restarted (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: { startCheckedAt: 1_800_000_000_000 - 30 * DAY } })
    h.files[RUNS] = easyLog(h.now)
    const d = drive($, h)
    await d.start(surface)
    expect(await bandText($, surface), 'before: a cheaper start is suggested').toContain('Starting on Sonnet')
    expect(String((await d.command('report')).text)).toContain('Starting point (last 30 days, 60 rated prompts): Opus at medium.')
    h.answers = { Reset: 'Cost measurement', Confirm: 'Yes' }
    await d.command('reset')
    // The report's block waits for rated prompts from now on, though its history still counts the 60.
    const report = String((await d.command('report')).text)
    expect(report).toContain('Starting point: needs 50 rated prompts to compare starts (has 0).')
    expect(report).toContain('Last 7 days and last 30 days\n  Prompts: 60 rated')
    // The next start does not suggest anything either: startCheckedAt is clear, so it checks, and finds nothing to go on.
    await d.start(surface)
    expect(await bandText($, surface)).toBe('')
    expect(h.store.startCheckedAt, 'the check ran and was counted').toBe(h.now)
  })

  test(`/rightsize reset Both does both after one confirmation (${surface})`, { timeoutMs: 30000, options: SOME_SET }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: MEASURE_STORE, stored: SOME_SET })
    measured(h)
    const { d, out } = await resetSettingsRun($, h, 'Both')
    expect(h.asked.filter(a => a.header === 'Confirm').length, 'one confirmation').toBe(1)
    expect(out).toContain('Every setting is back to its default')
    expect(out).toContain('Cost measurement restarted')
    expect(h.store[CAL_STORE]).toBeNull()
    expect(h.store.choices).toBeNull()
    expect(await settingsText(d)).not.toContain('(yours)')
  })

  test(`the /rightsize help line names reset (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS })
    const d = drive($, h)
    await d.start(surface)
    expect(await settingsText(d)).toContain('reset [setting] puts settings back to their defaults and/or restarts cost measurement.')
  })

  test(`/rightsize share prints the framed message, sends nothing and asks nothing (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS })
    const d = drive($, h)
    await d.start(surface)
    const posts = h.posts.length
    const fetches = h.fetches
    const text = (await d.command('share')).text ?? ''
    expect(text.startsWith('Copy and paste this anywhere. rightsize sends nothing itself.\n\n')).toBe(true)
    expect(text).toContain("I'm using rightsize, a free Claude Code mod")
    expect(text).toContain('https://aivalue.blog/rightsize')
    expect(h.posts.length, 'no POST').toBe(posts)
    expect(h.fetches, 'no fetch').toBe(fetches)
    expect(h.asked, 'no question').toEqual([])
  })

  test(`the /rightsize help line names share (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS })
    const d = drive($, h)
    await d.start(surface)
    expect(await settingsText(d)).toContain('share prints a message you can paste to tell others about rightsize')
  })
}
