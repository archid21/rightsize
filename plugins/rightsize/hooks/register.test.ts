import { type TestBody, expect, test } from 'claude-code/testing'
import { CAL_FULL, CAL_STORE, DEFAULT_PRICES, type Calibration, type Rating, type Situation, delegateCost, delegateKeys, plan, sizeSubagent, subagentKeys, subWork } from './cost'
import { KEYS, SETTINGS, type SettingKey, inOptions, plainTitle } from './settings'
import { type RunLine, sessionTotal } from './report'

declare const setTimeout: (fn: (...a: unknown[]) => void, ms: number) => unknown

// Typed loosely: the AskUserQuestion matcher's full type is too deep for tsc.
type AskInput = { questions: { question: string; header?: string; options?: { label: string }[] }[] }
type LooseOn = (event: string, match: object, hook: (_$: unknown, e: AskInput) => Promise<unknown>) => void
type StepInput = { effort?: string; model?: string; turnId: string; index: number; agentId?: string }
type LooseStep = (event: string, hook: (_$: unknown, e: StepInput) => AsyncGenerator<never, unknown>) => void
type Run = { text?: string }
type Engine = {
  session: { start: (x: unknown) => Promise<unknown> }
  prompt: { submit: (x: unknown) => Promise<unknown> }
  turn: { start: (x: unknown) => Promise<unknown>; step: (x: unknown) => unknown; complete: (x: unknown) => Promise<unknown> }
  tool: { call: (x: unknown) => Promise<unknown> }
  agent: { spawn: (x: unknown) => Promise<unknown> }
  command: { run: (x: unknown) => Promise<Run> }
}

/** Where this session's logs go: its own folder, and only its own. */
const LOGS = '/home/test/.claude/mods-logs'
const SESSION_DIR = `${LOGS}/rightsize/sess-1`
const RUNS_FILE = `${SESSION_DIR}/runs.jsonl`
const SWITCHES_FILE = `${SESSION_DIR}/switches.jsonl`
const LOG_PATH = `${SESSION_DIR}/rightsize.log`
/** The shared files of 0.7 and before: still read, never written. */
const LEGACY_RUNS = `${LOGS}/rightsize-runs.jsonl`
const LEGACY_SWITCHES = `${LOGS}/rightsize-switches.jsonl`

const LOOKUP = 'what does the parseConfig function in src/config.ts return exactly'
const DEBUG = 'find and fix the race in token refresh across the auth services please'
/** An answer for h.answers: nobody is there, so the question is never answered. */
const NO_ONE = '(no one answers)'
const SEARCH = 'find every call site of the old logger across the whole repo and list them'
const REVIEW = '{"level":"high","model":"opus","size":"small","type":"review","read":30000,"write":3000,"steps":10,"reason":"subtle bug hunt"}'
const NO_CHANGE = '{"level":"medium","model":"same","size":"small","type":"lookup","read":2000,"write":300,"steps":1}'
const FREE_SWITCHES = { 'cache:effort-switch': { n: 20, ratio: 0 } }
/** A main request that read 80,500 tokens: on Opus a cold return costs $0.63, over the $0.50 bar for Before the cache goes cold. */
const BIG_TURN = { input_tokens: 200, output_tokens: 400, cache_read_input_tokens: 80_000, cache_creation_input_tokens: 300 }
// A report table row's cells (session, 7 days, 30 days), by its label.
const cellsOf = (text: string, label: string) => text.split('\n').find(l => l.startsWith(`  ${label}`))?.slice(2 + label.length).trim().split(/ {2,}/)

const h$ = ($: { ui: { resolve: (e: never) => { Box: unknown } } }, e: unknown) => h($.ui.resolve(e as never).Box as never, {}) as never

// Stands for the engine beneath the plugin, and records what reaches it.
function engine(on: Parameters<TestBody>[1], start: { model: string; effort: string; store?: Record<string, unknown>; stored?: Record<string, string>; configKey?: string }) {
  const h = {
    model: start.model,
    effort: start.effort,
    subModel: 'claude-haiku-5-5',
    rating: '{"level":"medium"}',
    answers: {} as Record<string, string>,
    /** Answers to a header's questions in order, used before `answers`: a loop of questions needs a different answer each time. */
    answerQueue: {} as Record<string, string[]>,
    /** Every pane $.ui.open was asked for, and every $.ui.close; `panePlaced` is what an open answers (false: no surface draws panes). */
    paneOpens: [] as { id: string; title?: string; focus?: boolean; closeOnEscape?: boolean; holdToasts?: boolean }[],
    paneCloses: [] as string[],
    panePlaced: true,
    asked: [] as { header: string; question: string; options: string[] }[],
    sent: [] as { effort?: string; model?: string; agentId?: string; turnId: string }[],
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
    /** Last-modified times of the files, in ms; a file not listed was written now. */
    mtimes: {} as Record<string, number>,
    /** Every program the plugin ran, as its arguments. */
    ran: [] as string[][],
    /** Set to a reason: the next prompt that reaches the engine is refused with it, as a hook beneath would. */
    dropNext: undefined as string | undefined,
    /** Run while a submit is entering, before it answers: where the engine starts the prompt's turn. */
    duringSubmit: undefined as (() => Promise<unknown>) | undefined,
    /** True: rm and rmdir fail to start. */
    rmFails: false,
    /** What $.session.id() answers. */
    sessionId: 'sess-1',
    toasts: [] as string[],
    /** Status bar texts, in order; undefined clears it. */
    statuses: [] as (string | undefined)[],
    /** Rows whose writes Claude Code refuses, as the desktop app does with no /config menu. */
    refuse: [] as string[],
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
    /** Every model.complete call's model, in order: the rater is sonnet (haiku as the fallback or when Rater says so), the spot-check sonnet. */
    completions: [] as string[],
    /** The text of every rating call (the rater's, not the spot-check's), in order. */
    ratingPrompts: [] as string[],
    /** The conversation as $.session.messages() reports it: Claude's last reply is what the rater is shown. */
    messages: [{ role: 'assistant', text: 'Done: the change is in.' }] as { role: string; text: string }[],
    /** True: $.session.messages() throws. */
    messagesFail: false,
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
    /** Where the session draws: the surface it started on. */
    surfaces: [] as string[],
    /** What $.session.model() answers: the model in use now, as /model shows it. Defaults to the starting model. */
    liveModel: undefined as string | undefined,
    /** The input tokens of the live window's last response, as $.session.usage() reports; undefined: none yet. */
    contextTokens: undefined as number | undefined,
    /** Rating replies to give before `rating`, in order; a reply starting with "timeout" is a timed-out call, one starting with "unavailable" a refused one. */
    ratingQueue: [] as string[],
    /** How long each rating call takes, in ms, in order: the clock moves on by it before the call answers. A call with none listed takes no time. */
    ratingTakes: [] as number[],
    /** The timeoutMs each rating call (not the spot-check) was given, in order. */
    ratingTimeouts: [] as number[],
    /** True: a $.clock.sleep ends after a moment (the wait ran out), after any answer that is ready. False: it never ends, so an answer always comes first. */
    sleepEnds: false,
    /** A header's question answers only once its promise settles: an answer that comes after the wait. */
    answerGate: {} as Record<string, Promise<void>>,
    /** What a main request's usage says (stepUsage): the conversation's size is the sum of the input fields. */
    stepUsage: { input_tokens: 200, output_tokens: 400, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 300 },
    /** What $.command.list() answers: the commands other plugins add. */
    commands: [] as { name: string; description: string; source: string; plugin?: string }[],
    /** True: $.command.list() throws. */
    commandsFail: false,
    /** Every prompt $.model.fork was given, in order (the keep-warm requests). */
    forks: [] as string[],
    /** Replies for the next forks, in order; when none is left a fork answers with `forkUsage`. */
    forkReplies: [] as unknown[],
    /** What an answered fork's usage says: it read the whole conversation from the cache. */
    forkUsage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 80_000, cache_creation_input_tokens: 0 } as Record<string, number> | undefined,
    /** How many times $.session.compact() ran, and what it answers: a reason to skip, or the compaction. */
    compactions: 0,
    compactSkip: undefined as string | undefined,
    /** True: sleeps are on a virtual clock. They end only when `advance` reaches them, and the clock moves to each one's time. */
    virtual: false,
    sleepers: [] as { due: number; release: () => void }[],
    /** Every wait the plugin asked $.clock.sleep for, and every $.clock.after, in ms: a long wait has to be an `after`, which does not hang on a hook's budget. */
    sleeps: [] as number[],
    afters: [] as number[],
    /** Moves the virtual clock on by `ms`, ending each sleep that comes due on the way and letting the plugin run before the next. */
    advance: async (ms: number) => {
      // What the plugin has started waits for first: a sleep it is about to start counts from now, not from the time moved on to.
      await flush()
      const target = h.now + ms
      for (;;) {
        const due = h.sleepers.filter(x => x.due <= target).sort((a, b) => a.due - b.due)[0]
        if (!due) break
        h.sleepers.splice(h.sleepers.indexOf(due), 1)
        h.now = Math.max(h.now, due.due)
        due.release()
        await flush()
      }
      h.now = target
      await flush()
    },
  }
  on('session.start', async ($, e) => {
    h.surfaces = e.surface ? [e.surface] : []
    return { cwd: e.cwd } as never
  })
  on('session.surfaces', async () => ({ value: h.surfaces }) as never)
  on('ui.open', async (_$, e) => {
    h.paneOpens.push(e as (typeof h.paneOpens)[number])
    return { value: h.panePlaced ? { isPlaced: true } : { isPlaced: false, reason: 'no surface draws panes' } } as never
  })
  on('ui.close', async (_$, e) => {
    h.paneCloses.push((e as { id: string }).id)
    return { value: undefined } as never
  })
  on('command.register', async () => ({ value: undefined }) as never)
  on('clock.every', async () => ({ value: undefined }) as never)
  // The merged settings, as the engine holds them: a read of one key is this object, projected.
  on('settings.read', async () => {
    if (h.settingsFail) throw new Error('settings could not be read')
    return { value: { pluginConfigs: { other: { options: { floor: 'high' } }, ...(Object.keys(h.stored).length ? { [h.configKey]: { options: h.stored } } : {}) } } } as never
  })
  on('session.messages', async () => {
    if (h.messagesFail) throw new Error('messages could not be read')
    return { value: h.messages } as never
  })
  on('session.id', async () => ({ value: h.sessionId }) as never)
  on('session.model', async () => ({ value: h.liveModel ?? h.model }) as never)
  on('session.usage', async ($, e) => {
    const breakdown = (e as { breakdown?: string }).breakdown && h.breakdown ? { breakdown: h.breakdown } : {}
    return { value: { startedAt: 0, context: { window: 200_000, ...(h.contextTokens === undefined ? {} : { tokens: h.contextTokens }), ...breakdown }, rateLimits: h.rateLimits, ...(h.ledger === undefined ? {} : { cost: { usd: h.ledger } }) } } as never
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
    if (path.includes('/mods-logs/')) {
      h.files[path] = text
      h.mtimes[path] = h.now
    }
    return { value: undefined } as never
  })
  // The files under a folder, and the folders in it (the fake keeps files only); a folder with nothing in it lists as empty.
  on('fs.list', async ($, e) => {
    const { path } = e as { path: string }
    const prefix = `${path}/`
    const names = new Map<string, 'file' | 'dir'>()
    for (const key of Object.keys(h.files)) {
      if (!key.startsWith(prefix)) continue
      const rest = key.slice(prefix.length)
      const slash = rest.indexOf('/')
      names.set(slash < 0 ? rest : rest.slice(0, slash), slash < 0 ? 'file' : 'dir')
    }
    return { value: [...names].map(([name, kind]) => ({ name, kind, size: kind === 'file' ? (h.files[`${prefix}${name}`] ?? '').length : 0, mtimeMs: kind === 'file' ? (h.mtimes[`${prefix}${name}`] ?? h.now) : 0, isLink: false })) } as never
  })
  on('clock.now', async () => ({ value: h.now }) as never)
  // A timer: the plugin keeps its callback and cancels it itself. Not on the virtual clock, it never fires.
  on('clock.after', async (_$, e) => {
    const ms = (e as { ms: number }).ms
    h.afters.push(ms)
    if (!h.virtual) await new Promise(() => {})
    await new Promise<void>(release => h.sleepers.push({ due: h.now + ms, release }))
    return { value: undefined } as never
  })
  on('clock.sleep', async (_$, e) => {
    h.sleeps.push((e as { ms: number }).ms)
    if (h.virtual) {
      await new Promise<void>(release => h.sleepers.push({ due: h.now + (e as { ms: number }).ms, release }))
      return { value: undefined } as never
    }
    if (!h.sleepEnds) await new Promise(() => {})
    await new Promise(r => setTimeout(r, 25))
    return { value: undefined } as never
  })
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
    if (known && h.refuse.includes(known)) return { deny: 'only its dialog changes it' } as never
    h.configSet.push(value)
    h.sets.push({ key, value, ...(origin ? { origin } : {}) })
    if (known) h.stored[known] = value as string
    return { value } as never
  })
  // Only rm and rmdir do anything: the fake has files, not folders.
  on('process.run', async ($, e) => {
    const { argv } = e as { argv: string[] }
    h.ran.push(argv)
    if (h.rmFails && (argv[0] === 'rm' || argv[0] === 'rmdir')) throw new Error('no such program')
    if (argv[0] === 'rm') for (const f of argv.slice(1).filter(a => !a.startsWith('-'))) delete h.files[f]
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
  })
  on('ui.status', async ($, e) => {
    h.statuses.push((e as { text?: string }).text)
    return { value: undefined } as never
  })
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
    // The spot-check is the only call with a 15 s timeout; a rating call has what is left of its prompt's 12 s.
    if (model === 'sonnet' && (e as { timeoutMs?: number }).timeoutMs === 15_000) {
      if (h.checkHold) await h.checkHold
      if (h.ledger !== undefined) h.ledger += h.checkCost
      return { value: { isAnswered: true, text: h.checkRating ?? h.rating, usage: h.checkUsage } } as never
    }
    h.ratings += 1
    h.ratingTimeouts.push((e as { timeoutMs?: number }).timeoutMs ?? -1)
    h.now += h.ratingTakes.shift() ?? 0
    h.ratingPrompts.push(String((e as { prompt?: unknown }).prompt ?? ''))
    // The rating call is priced too; the turn's measured cost leaves it out.
    if (h.ledger !== undefined) h.ledger += 0.5
    const queued = h.ratingQueue.shift()
    if (queued?.startsWith('timeout')) return { value: { isAnswered: false, reason: 'aborted', usage: h.ratingUsage } } as never
    if (queued?.startsWith('unavailable')) return { value: { isAnswered: false, reason: 'api-error', status: 401, error: 'authentication_failed', usage: h.ratingUsage } } as never
    return { value: { isAnswered: true, text: queued ?? h.rating, usage: h.ratingUsage } } as never
  })
  ;(on as unknown as LooseOn)('tool.call', { tool: 'AskUserQuestion' }, async (_$, e) => {
    const q = e.questions[0]
    const header = q?.header ?? ''
    h.asked.push({ header, question: q?.question ?? '', options: (q?.options ?? []).map(o => o.label) })
    h.events.push(`ask:${header}`)
    const answer = h.answerQueue[header]?.shift() ?? h.answers[header]
    if (answer === undefined) return { deny: `no answer set for ${header}` }
    // Nobody there: the question stays open and is never answered.
    if (answer === NO_ONE) await new Promise(() => {})
    await h.answerGate[header]
    return { result: { questions: e.questions, answers: { [q?.question ?? '']: answer } } }
  })
  ;(on as unknown as LooseOn)('tool.call', { tool: 'Agent' }, async () => ({ result: { content: 'done' } }))
  ;(on as unknown as LooseOn)('tool.call', { tool: 'SendMessage' }, async () => ({ result: { content: 'sent' } }))
  ;(on as unknown as LooseOn)('tool.call', { tool: 'Workflow' }, async () => {
    h.events.push('workflow')
    return { result: { content: 'started in the background' } }
  })
  // A command starting "fail" fails, and so does one ending " --red" (a test run that is red); one starting "denied" is refused, as a denied permission is; one starting "env:" fails with the text after it.
  ;(on as unknown as LooseOn)('tool.call', { tool: 'Bash' }, async (_$, e) => {
    const command = String((e as unknown as { command: string }).command)
    if (command.startsWith('denied')) return { deny: 'permission denied' }
    // "env:<text>" fails with that text, as the environment does (no network, a missing program); the text is part of the call.
    if (command.startsWith('env:')) return { result: command.slice(4), text: command.slice(4), isError: true }
    return command.startsWith('fail') || command.endsWith(' --red') ? { result: { stdout: '', stderr: 'boom' }, text: 'boom', isError: true } : { result: { stdout: 'ok', stderr: '' }, text: 'ok' }
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
    if (h.dropNext !== undefined) {
      const drop = h.dropNext
      h.dropNext = undefined
      return { drop } as never
    }
    h.submitted.push({ text: e.text, context: e.context })
    const during = h.duringSubmit
    h.duringSubmit = undefined
    if (during) await during()
    return { text: e.text } as never
  })
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }) as never)
  ;(on as unknown as LooseStep)('turn.step', async function* (_$, e) {
    h.sent.push({ effort: e.effort, model: e.model, agentId: e.agentId, turnId: e.turnId })
    if (h.ledger !== undefined) h.ledger += h.stepCost
    if (!e.agentId && h.windowStep) h.rateLimits = h.rateLimits.map(l => ({ ...l, percentUsed: l.percentUsed + h.windowStep }))
    const usage = h.stepUsage
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: { ...usage, model: e.agentId ? h.subModel : (e.model ?? h.model) } } as never
  })
  on('turn.complete', async () => ({ text: '' }) as never)
  on('command.list', async () => {
    if (h.commandsFail) throw new Error('commands could not be listed')
    return { value: h.commands } as never
  })
  on('model.fork', async (_$, e) => {
    h.forks.push((e as { prompt: string }).prompt)
    const queued = h.forkReplies.shift()
    if (queued !== undefined) return { value: queued } as never
    return { value: { isAnswered: true, text: 'OK', ...(h.forkUsage ? { usage: h.forkUsage } : {}) } } as never
  })
  on('session.compact', async () => {
    h.compactions += 1
    return (h.compactSkip !== undefined ? { skip: h.compactSkip } : { messages: [{ role: 'user', text: 'Summary of the conversation.', toolUses: [] }] }) as never
  })
  // The engine's own band above the prompt: an empty row.
  on('ui.render', ($, e) => h$($, e))
  return h
}

const drive = ($: unknown, h: ReturnType<typeof engine>) => {
  const e = $ as Engine
  return {
    start: (surface: string) => e.session.start({ source: 'startup', cwd: '/tmp', surface, isInteractive: true }),
    /** `turnId`: the turn that was running when the prompt was typed; left out, the session was idle. */
    submit: (text: string, turnId?: string) => e.prompt.submit({ text, origin: { kind: 'composer' }, wait: false, ...(turnId ? { turnId } : {}) }),
    /** The engine starting a main-chat turn for this text ("" for a continuation). */
    turnStart: (turnId: string, text: string) => e.turn.start({ turnId, text }),
    step: async (turnId: string, index = 0, agentId?: string) => {
      const it = e.turn.step({ turnId, index, model: h.model, effort: h.effort, messageCount: 1, ...(agentId ? { agentId } : {}) })
      for await (const _ of it as AsyncIterable<unknown>) void _
    },
    complete: (turnId: string) => e.turn.complete({ turnId, answer: '', durationMs: 1, isAborted: false, reason: 'answer' }),
    // A subagent's own answer, in its own loop.
    answer: (agentId: string, isAborted = false) => e.turn.complete({ turnId: `${agentId}-turn`, agentId, answer: '', durationMs: 1, isAborted, reason: isAborted ? 'aborted' : 'answer' }),
    agent: (model: string) => e.tool.call({ tool: 'Agent', description: 'x', prompt: 'brief', model }),
    send: () => e.tool.call({ tool: 'SendMessage', to: 'agent-helper', message: 'fix the failing test' }),
    workflow: (id?: string) => e.tool.call({ tool: 'Workflow', script: 'export const meta = {}', ...(id ? { tool_use_id: id } : {}) }),
    bash: (command: string, agentId?: string) => e.tool.call({ tool: 'Bash', command, description: `try ${command} ${h.sent.length}`, ...(agentId ? { agentId } : {}) }),
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
/** Waits until a question was asked (more than `before` so far) and its answer was handled: the ⋯ menu asks through the engine, which takes a moment. */
const untilAsked = async (h: { asked: unknown[] }, before: number, questions = 1) => {
  for (let i = 0; i < 50 && h.asked.length < before + questions; i++) await flush()
  await flush()
}
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
type Found = { type?: string; key?: string; text?: string; props?: { key?: string; label?: string; value?: string; options?: { value: string }[] }; children?: Found[] | string[] }
type Mounted = {
  find: (q: object) => Promise<Found | undefined>
  findAll: (q: object) => Promise<Found[]>
  press: (t: object) => Promise<unknown>
  select: (t: { key: string; value: string }) => Promise<unknown>
  unmount: () => Promise<void>
}
/** The settings pane (bare /rightsize), as an engine asks for it. */
const PANE = {
  plugin: 'rightsize',
  component: 'Pane',
  requestId: 'rightsize-menu',
  props: { title: 'Rightsize', isFocused: true, bodyColumns: 80, placement: 'inline', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const
const mountPane = ($: unknown, surface: string) => ($ as { ui: { mount: (x: unknown) => Promise<Mounted> } }).ui.mount({ ...PANE, surface })
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
  test(`asks Q1 once, lowers on its own after, steps up when the turn gets long, and retries at the original effort (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')

    h.rating = '{"level":"low","model":"same","size":"small","type":"lookup","read":2000,"write":3000,"steps":1,"reason":"one function lookup"}'
    h.answers = { Lowering: 'Lower automatically (Recommended)', Remember: 'Just this session' }
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
    h.answers = { Stronger: 'Ask before using it', Remember: 'Just this session', Subagent: 'Send it to a Fable subagent' }
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
    expect(await bandText($, surface), 'the band carries the result').toMatch(/^rightsize: Sent to Fable\. \$[\d.]+ vs ~\$[\d.]+ on Opus \(~[\d.]+(%|x)/)
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
    h.answers = { Stronger: 'Use the stronger model automatically (Recommended)', Remember: 'Just this session' }
    await d.submit(DEBUG)
    expect(h.asked.map(a => a.header), 'Q3 then the remember question').toEqual(['Stronger', 'Remember'])
    expect(h.submitted.at(-1)?.context ?? [], 'no subagent note').toEqual([])
    await d.step('t1', 0)
    await d.step('t1', 1)
    const turn = h.sent.filter(s => s.turnId === 't1')
    expect(turn.map(s => s.model), 'every step on Opus').toEqual(['opus', 'opus'])
    expect(turn.map(s => s.effort), 'at high').toEqual(['high', 'high'])
    await d.complete('t1')
    expect(await bandText($, surface)).toMatch(/^rightsize: Running this review on Opus at high effort, then back to Sonnet\. \$[\d.]+ vs ~\$[\d.]+ on Sonnet\./)

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
    h.answers = { Stronger: 'Use the stronger model automatically (Recommended)', Remember: 'Just this session' }

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

  test(`a continuing prompt in a review task is still a review; a continuing prompt with no task kept takes its own type (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-sonnet-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.answers = { Stronger: 'Use the stronger model automatically (Recommended)', Remember: 'Just this session' }

    // The session has kept no task yet: "continues" has nothing to continue, so the rated type stands and becomes the task.
    h.rating = rated('review', true)
    await d.submit(DEBUG)
    await d.step('t1')
    expect(last(h.sent)?.model, 'a review').toBe('opus')
    await d.complete('t1')

    // A follow-up typed lookup carries on the review: it gets the review rule.
    h.rating = rated('lookup', true)
    await d.submit(FOLLOW_UP)
    await d.step('t2')
    expect(last(h.sent)?.model, 'the review rule holds for the follow-up').toBe('opus')
    await d.complete('t2')

    // A new goal ends the task.
    h.rating = rated('lookup', false)
    await d.submit(LOOKUP)
    await d.step('t3')
    expect(last(h.sent)?.model).toBe('claude-sonnet-5-5')
    await d.complete('t3')
    expect(readRuns(h).map(r => [r.type, r.ratedType ?? null])).toEqual([['review', null], ['review', 'lookup'], ['lookup', null]])
  })

  test(`a review in a Sonnet session stays on Sonnet when Stronger model is Stay (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-sonnet-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')

    h.rating = REVIEW
    h.answers = { Stronger: 'Stay on Sonnet, raise effort only', Raising: 'Raise automatically (Recommended)', Remember: 'Just this session' }
    await d.submit(DEBUG)
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
    h.answers = { Cheaper: 'Send it to a cheaper subagent (Recommended)', Remember: 'Just this session' }
    await d.submit(SEARCH)
    expect(h.asked.map(a => a.header)).toEqual(['Cheaper', 'Remember'])
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
    expect(h.asked.length).toBe(2)
    await d.step('t2', 0)
    await d.agent('haiku')
    await d.step('t2', 0, 'a2')
    await d.step('t2', 1)
    await d.complete('t2')
    expect(await bandText($, surface)).toMatch(/^rightsize: Sent to Haiku\. \$[\d.]+ vs ~\$[\d.]+ on Fable \(~\d+% saved\)\.?/)
  })

  test(`a hand-off kept in the main chat for a push is not counted as skipped (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-fable-5-1', effort: 'high' })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')

    h.rating = '{"level":"low","model":"haiku","size":"bulky","type":"search","read":150000,"write":3000,"steps":30,"reason":"repo-wide search"}'
    h.answers = { Cheaper: 'Send it to a cheaper subagent (Recommended)', Remember: 'Just this session' }
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
    h.answers = { Cheaper: 'Send it to a cheaper subagent (Recommended)', Remember: 'Just this session' }
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
    expect(await bandText($, surface)).toMatch(/^rightsize: Sending this to a Haiku subagent at high effort instead of raising Opus to high\. \$[\d.]+ vs ~\$[\d.]+ on Opus\./)

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
    expect(await bandText($, surface)).toBe("rightsize: Ran Claude's subagent on Haiku (low) instead of Opus.")
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
    h.answers = { Cheaper: 'Send it to a cheaper subagent (Recommended)', Remember: 'Just this session' }
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
    h.answers = { Raising: 'Raise automatically (Recommended)', Remember: 'Just this session' }
    await d.submit(DEBUG)
    expect(h.asked.length, 'no raise to ask about').toBe(0)
    await d.step('t1')
    expect(last(h.sent)?.effort).toBe('medium')
    expect(await bandText($, surface)).toBe('rightsize: Kept medium on Opus instead of raising to high. 93% of the 5-hour window is used, so rightsize saves all it can.')
  })

  test(`budget pacing: with Reports set to the API, the band shows no window share (${surface})`, { timeoutMs: 30000, options: { billing: 'api' } }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', stored: { billing: 'api' } })
    const d = drive($, h)
    h.rateLimits = [{ kind: 'five_hour', percentUsed: 93, resetsAt: at(h, 4 * HOUR) }]
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = '{"fit":{"haiku":"no","sonnet":"no","opus":"high","fable":"medium"},"size":"small","type":"debug","read":8000,"write":800,"steps":6,"reason":"race"}'
    h.answers = { Raising: 'Raise automatically (Recommended)', Remember: 'Just this session' }
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
    expect(h.asked.map(a => a.question)).toEqual(['Claude looks stuck: the same tool call failed twice. Raise effort from medium to high for the rest of this turn? No answer in 2 minutes: it keeps medium.'])
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

  test(`blocked errors (sandbox, network, missing program) do not raise effort, however often they repeat (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: AUTO_RAISE })
    const d = drive($, h)
    await d.start(surface)
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    await d.step('t1', 0)
    // The same blocked call three times (a repeat failure and a loop for any other error), then three different ones.
    for (let i = 0; i < 3; i++) await d.bash('env:curl: (6) Could not resolve host: registry.example.com')
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

  test(`a blocked error does not step an auto-lowered turn back up; an ordinary failure does (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = LOWER
    h.answers = { Lowering: 'Lower automatically (Recommended)', Remember: 'Just this session' }

    await d.submit(LOOKUP)
    await d.step('t1', 0)
    expect(last(h.sent)?.effort, 'lowered').toBe('low')
    await d.bash('env:ssh: connect to host example.com port 22: Network is unreachable')
    await d.step('t1', 1)
    expect(last(h.sent)?.effort, 'the network is down: effort would not help').toBe('low')
    await d.bash('fail npm test')
    await d.step('t1', 2)
    expect(last(h.sent)?.effort, 'a failure of the work: back to medium').toBe('medium')
    await d.complete('t1')
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

    // 5% of the window for $1 of one turn, give or take 1 point of rounding: $0.16 is 0.6–1.0%.
    const at = new Date(h.now).toISOString()
    h.files[LEGACY_RUNS] = `${JSON.stringify({ at, kind: 'run', actual: 1, before: { five_hour: 10 }, after: { five_hour: 15 } })}\n`
    h.now += 3 * 60 * MIN
    await d.submit('continue')
    expect(last(h.asked)?.question).toContain(
      '~0.6–1.0% of your 5-hour window ($0.16 API-equivalent) more on Opus than a warm cache. /clear costs nothing; /compact ~0.3–0.5% of your 5-hour window ($0.08 API-equivalent).',
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
    h.answers = { Lowering: 'Lower automatically (Recommended)', Remember: 'Just this session' }
    await d.submit(LOOKUP)
    expect(await bandText($, surface), 'what was done, why, and how confident').toBe('rightsize: Effort lowered: medium → low for this prompt (automatically). Why: One function lookup. Confidence: low.')
    const ui = await mount($, surface)
    expect((await ui.findAll({ type: 'Button' })).map(b => b.key), 'a lowering can be marked 👍 or 👎').toEqual(['retry', 'good', 'bad', 'mode', 'close'])

    // The ⋯ menu lists the rule options for this band; one pick changes the answer to Q1.
    h.answers = { Options: 'Ask me each time' }
    let asked = h.asked.length
    await ui.press({ key: 'mode' })
    await untilAsked(h, asked)
    expect(h.asked.at(-1)?.options, 'the current rule is not offered; the band setting is last').toEqual(['Ask me each time', 'Never lower', 'When the band shows…'])
    expect(h.asked.at(-1)?.question, 'the menu says what the dollars are').toContain('API-equivalent')
    expect(h.asked.at(-1)?.question, 'and the detail behind the band\'s confidence').toMatch(/^Confidence: low, none of your tasks yet\. Options for this band\./)
    expect(last(h.toasts)).toBe('Rightsize: Lowering is now "Ask me each time".')
    expect((await d.command('status')).text ?? '').toContain('Lowering: ask me')
    expect(h.stored.lowerRule, 'the button sets the /config row too').toBe('ask me')
    expect(h.sets.filter(x => x.key === 'rightsize.lowerRule').length, 'once').toBe(1)
    expect((await ui.findAll({ type: 'Button' })).map(b => b.key), 'the row keeps Retry, the marks, ⋯ and ×').toEqual(['retry', 'good', 'bad', 'mode', 'close'])
    // Dismissing the menu (no answer) does nothing.
    h.answers = {}
    asked = h.asked.length
    await ui.press({ key: 'mode' })
    await untilAsked(h, asked)
    expect(h.asked.at(-1)?.options, 'the new rule is not offered again').toEqual(['Lower automatically', 'Never lower', 'When the band shows…'])
    expect(h.stored.lowerRule, 'dismissed: unchanged').toBe('ask me')
    expect(h.sets.filter(x => x.key === 'rightsize.lowerRule').length).toBe(1)

    // Retry at original effort puts the prompt back in the box and closes the band.
    await ui.press({ key: 'retry' })
    expect(h.filled[0]).toBe(LOOKUP)
    expect(last(h.toasts) ?? '').toContain('run it at medium')
    await ui.unmount()
    expect(await bandText($, surface)).toBe('')
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
    expect(await bandText($, surface)).toMatch(/^rightsize: Starting on Sonnet at (medium|high) would have cost ~\d+% less than Opus at medium on your last 60 rated prompts\. Switch with \/model\.$/)
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
    expect((await d.command('status')).text ?? '').toContain('Share anonymous feedback: on')
    expect((await d.command('status')).text ?? '').toContain(`Sharing install ID: ${String(h.store.shareInstall)}`)

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

    // ⋯ opens the menu; "When the band shows…" asks when the band should show, and saves the answer in /config.
    h.answers = { Options: 'When the band shows…', Band: 'Never (status line only)' }
    ui = await mount($, surface)
    const asked = h.asked.length
    await ui.press({ key: 'mode' })
    await untilAsked(h, asked, 2)
    await ui.unmount()
    expect(last(h.configSet)).toBe('off')
    expect(await bandText($, surface)).toBe('')

    // "off": a hand-off result goes back to a transcript line.
    h.rating = '{"level":"high","model":"fable","size":"small","type":"debug","read":30000,"write":4000,"steps":12,"reason":"subtle concurrency bug"}'
    h.answers = { Stronger: 'Use the stronger model automatically (Recommended)', Remember: 'Just this session' }
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
    h.answers = { Lowering: 'Lower automatically (Recommended)', Remember: 'Just this session' }
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
    expect((await d.command('status')).text ?? '').toContain('Hand-off threshold: 50%\n  Lowering threshold: 80%')
  })

  test(`says the thresholds are the defaults when none are set (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    expect((await d.command('status')).text ?? '').not.toContain('Hand-off threshold:')
  })

  test(`skips slash commands and other senders (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    await d.submit('/rightsize show me the current level please')
    await ($ as unknown as Engine).prompt.submit({ text: DEBUG, origin: { kind: 'task-notification' }, wait: false })
    expect(h.ratings).toBe(0)
    const status = await d.command('status')
    expect(status.text ?? '').not.toContain('Lowering:')
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
    expect((await d.command('status')).text ?? '').toContain('Reports: subscription (detected)')
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
    const status = (await d.command('status')).text ?? ''
    expect(status).toContain('Reports: api')
    expect(status).toContain('Rate limits look like a subscription; Reports is set to api by you.')
    expect(h.stored.billing, 'the answer is the Reports row too').toBe('api')
  })

  test(`measures a turn's cost off the session's cost ledger, leaving out the rating (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    const runs = () =>
      (h.files[RUNS_FILE] ?? '')
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
      (h.files[RUNS_FILE] ?? '')
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
    expect(first?.overhead, '1000 in and 100 out on Sonnet, the rater').toBe(0.003)
    expect((first as { normal?: string; context?: number })?.normal, 'the session level, for the starting-point check').toBe('medium')
    expect(typeof (first as { context?: number })?.context).toBe('number')
    expect(first?.before).toEqual({ five_hour: 11 })
    expect(first?.after).toEqual({ five_hour: 12 })

    // Lowered on its own.
    h.rating = '{"level":"low","model":"same","size":"small","type":"lookup","read":2000,"write":3000,"steps":1}'
    h.answers = { Lowering: 'Lower automatically (Recommended)', Remember: 'Just this session' }
    await d.submit(LOOKUP)
    await d.step('t2')
    await d.complete('t2')
    expect(last(runs())?.change).toBe('lower')
    expect(last(runs())?.offered).toBe('lower')

    // A rating that comes to nothing, twice: the prompt is logged as unrated, with what both calls cost.
    h.rating = 'no json here'
    await d.submit(LOOKUP)
    expect(last(runs())?.kind).toBe('unrated')
    expect(last(runs())?.overhead, 'Sonnet\'s call and the Haiku fallback\'s, 1000 in and 100 out each').toBe(0.00315)

    const report = (await d.command('report')).text ?? ''
    expect(cellsOf(report, 'Prompts rated')).toEqual(['2', '2', '2'])
    expect(cellsOf(report, 'Kept / lowered / raised')).toEqual(['1/1/0', '1/1/0', '1/1/0'])
    expect(report).toContain('Total saved is after the cost of rating prompts')
    expect(report.includes('```'), 'fenced only in the desktop app').toBe(surface === 'desktop')
    expect(report).toContain('NOT COUNTED AS SAVINGS')
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

  test(`a close call decided by the guide is counted in the store and logged on the run (${surface})`, { timeoutMs: 30000, options: { explore: 'on' } }, async ($, on) => {
    const cal = { ...tieCal(0.9), ...FREE_SWITCHES }
    const p = plan(tieRating, { ...fableHigh, cal, ties: 3 }, 'low')
    expect(p.kind === 'delegate' && p.tie, 'the setup is a close call').toEqual({ by: 'guide', over: 'opus' })
    // Exploring is off in every profile: this one turned it on.
    const h = engine(on, { model: 'claude-fable-5-1', effort: 'high', store: { [CAL_STORE]: cal, ties: 3 }, stored: { explore: 'on' } })
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
    const runs = (h.files[RUNS_FILE] ?? '').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
    expect(last(runs)?.route).toBe('delegate:sonnet')
    expect(last(runs)?.tie).toEqual({ by: 'guide', over: 'opus' })
    expect((h.files[LOG_PATH] ?? '').includes('tie guide over opus'), 'the log says so').toBe(true)

    // The next close call is the fifth (4 before it): it explores, and is counted too.
    await d.submit(SEARCH)
    expect(h.store.ties, 'counted again').toBe(5)
    expect(last(h.submitted)?.context?.join('\n') ?? '', 'the fifth takes the other close route').toContain('model "opus"')
    await d.step('t3', 0)
    await d.agent('opus')
    await d.step('t3', 1)
    await d.complete('t3')
    const again = (h.files[RUNS_FILE] ?? '').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
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
    const runs = (h.files[RUNS_FILE] ?? '').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
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
    const runs = (h.files[RUNS_FILE] ?? '').trim().split('\n').map(l => JSON.parse(l) as { resized?: { tier: string; tie?: unknown }[] })
    expect(last(runs)?.resized?.map(r => [r.tier, r.tie])).toEqual([['sonnet', { by: 'guide', over: 'opus' }]])
  })

  // Rater check: Sonnet's second opinion on every 50th rating, in the background.
  const FIT_NO = '{"fit":{"haiku":"no","sonnet":"no","opus":"medium","fable":"medium"},"type":"feature","read":2000,"write":300,"steps":1,"reason":"plain change"}'
  const CHECK_NO = '{"fit":{"haiku":"no","sonnet":"no","opus":"no","fable":"high"},"type":"feature","read":2000,"write":300,"steps":1}'
  const runLines = (h: ReturnType<typeof engine>) =>
    (h.files[RUNS_FILE] ?? '')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l) as Record<string, unknown>)
  const SONNET_USAGE = { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

  test(`the 20th Haiku-rated prompt gets Sonnet's second opinion in the background, logged as a check line (${surface})`, { timeoutMs: 60000, options: { rater: 'haiku' } }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES }, stored: { rater: 'haiku' } })
    const d = drive($, h)
    h.now = Date.now()
    await d.start(surface)
    h.rating = FIT_NO
    h.checkRating = CHECK_NO
    for (let i = 1; i < 20; i++) await d.submit(LOOKUP)
    expect(h.completions.filter(m => m === 'sonnet'), 'none before the 20th (Balanced checks every 20)').toEqual([])
    expect(h.store.spotChecks).toBe(19)

    // The 20th: Sonnet is asked, and the prompt goes through while it is still thinking.
    let release = () => {}
    h.checkHold = new Promise<void>(resolve => {
      release = resolve
    })
    const sent = h.submitted.length
    await d.submit(LOOKUP)
    expect(h.submitted.length, 'the prompt was not held back').toBe(sent + 1)
    expect(h.completions.filter(m => m === 'sonnet'), 'asked once, after Haiku').toEqual(['sonnet'])
    expect(last(h.completions.slice(0, -1))).toBe('haiku')
    expect(h.store.spotChecks).toBe(20)
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

    // The 21st to 39th are not checked; the report counts the disagreement.
    await d.submit(LOOKUP)
    expect(h.completions.filter(m => m === 'sonnet').length).toBe(1)
    const report = (await d.command('report')).text ?? ''
    expect(report).toMatch(/Haiku's judgement +wrong on 1 of 2 checked prompts \(50%\)/)
    expect(report, 'a check line is not a prompt').toContain('Nothing rated yet.')
  })

  test(`a check that lands during a turn is left out of that turn's cost (${surface})`, { timeoutMs: 30000, options: { rater: 'haiku' } }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES, spotChecks: 19 }, stored: { rater: 'haiku' } })
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

  test(`Rater check off in /config: no second opinion, and the count does not move (${surface})`, { timeoutMs: 30000, options: { raterCheck: 'off', rater: 'haiku' } }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { spotChecks: 49 }, stored: { raterCheck: 'off', rater: 'haiku' } })
    const d = drive($, h)
    await d.start(surface)
    h.rating = FIT_NO
    await d.submit(LOOKUP)
    await d.submit(LOOKUP)
    expect(h.completions.filter(m => m === 'sonnet')).toEqual([])
    expect(h.store.spotChecks).toBe(49)
    expect((await d.command('status')).text ?? '').toContain('Rater check: off')
    // Turned on again in /config: the next rating is the 50th.
    await d.config('raterCheck', 'every 50')
    await d.submit(LOOKUP)
    await flush()
    expect(h.completions.filter(m => m === 'sonnet')).toEqual(['sonnet'])
    expect((await d.command('status')).text ?? '').toContain('Rater check: every 50')
  })

  test(`Rater check turned off in /config stops the second opinions (${surface})`, { timeoutMs: 30000, options: { rater: 'haiku' } }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { spotChecks: 49 }, stored: { rater: 'haiku' } })
    const d = drive($, h)
    await d.start(surface)
    h.rating = FIT_NO
    await d.config('raterCheck', 'off')
    await d.submit(LOOKUP)
    expect(h.completions.filter(m => m === 'sonnet')).toEqual([])
  })

  test(`a check that fails or cannot be read adds no check line, only its cost (${surface})`, { timeoutMs: 30000, options: { rater: 'haiku' } }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { spotChecks: 19 }, stored: { rater: 'haiku' } })
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

  test(`Sonnet rates first; a Sonnet rating is not spot-checked and does not count toward the check (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { spotChecks: 49 } })
    const d = drive($, h)
    h.now = Date.now()
    await d.start(surface)
    h.rating = FIT_NO
    await d.submit(LOOKUP)
    await flush()
    expect(h.completions, 'one call, to Sonnet: no Haiku, and no check').toEqual(['sonnet'])
    expect(h.store.spotChecks, 'not counted').toBe(49)
    await d.step('t1')
    await d.complete('t1')
    expect(runLines(h).find(l => l.kind === 'run')?.rater, 'the run line says who rated').toBe('sonnet')
  })

  test(`a Sonnet rating that times out, is refused or is unreadable falls back to Haiku once; both failing logs the prompt unrated (${surface})`, { timeoutMs: 60000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    h.now = Date.now()
    // Sonnet and Haiku are priced apart: 1M input tokens each.
    h.ratingUsage = SONNET_USAGE
    await d.start(surface)
    h.rating = FIT_NO
    for (const [n, queue] of [['timeout', ['timeout']], ['refused', ['unavailable']], ['unreadable', ['no json']]] as const) {
      h.completions = []
      h.ratingQueue = [...queue]
      await d.submit(`${LOOKUP} ${n}`)
      expect(h.completions, `${n}: Sonnet, then Haiku once`).toEqual(['sonnet', 'haiku'])
      expect(h.ratingQueue).toEqual([])
      const t = `t-${n}`
      await d.step(t)
      await d.complete(t)
      const run = last(runLines(h).filter(l => l.kind === 'run')) as { rater: string; overhead: number }
      expect(run.rater, `${n}: Haiku rated`).toBe('haiku')
      expect(run.overhead, `${n}: each call priced with its own model: 1M tokens on Sonnet plus 1M on Haiku`).toBe(2.1)
    }
    expect(runLines(h).some(l => l.kind === 'unrated')).toBe(false)

    // Both fail: unrated, the session as it was, no third call.
    h.completions = []
    h.ratingQueue = ['timeout', 'no json']
    await d.submit(`${LOOKUP} both`)
    expect(h.completions).toEqual(['sonnet', 'haiku'])
    const unrated = runLines(h).filter(l => l.kind === 'unrated')
    // An unrated prompt is part of the task in progress: the last rated run's.
    const task = (last(runLines(h).filter(l => l.kind === 'run')) as { task: string }).task
    expect(unrated).toEqual([{ at: expect.any(String), kind: 'unrated', session: 'sess-1', task, reason: 'rating unreadable', rater: 'haiku', overhead: 2.1, ratingMs: 0 }])
    expect(h.files[LOG_FILE] ?? '').toContain('prompt not rated (rating unreadable)')
    expect(h.files[LOG_FILE] ?? '').toContain('rating by sonnet failed (rating call timed out): trying haiku')
  })

  test(`all rating attempts for a prompt fit in 12 s: Sonnet gets 9, Haiku the rest, and run lines carry ratingMs and submittedAt (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    h.now = Date.now()
    await d.start(surface)
    h.rating = FIT_NO

    // A rating inside its time: Sonnet had 9 s, and the run says how long it took and when the prompt came in.
    h.ratingTakes = [1800]
    const t0 = h.now
    await d.submit(LOOKUP)
    expect(h.ratingTimeouts, 'Sonnet had at most 9 s').toEqual([9000])
    await d.step('t1')
    await d.complete('t1')
    const first = last(runLines(h).filter(l => l.kind === 'run')) as { ratingMs: number; submittedAt: string; rater: string }
    expect(first.ratingMs).toBe(1800)
    expect(first.submittedAt, 'when the prompt was submitted, before its rating').toBe(new Date(t0).toISOString())
    expect(first.rater).toBe('sonnet')

    // Sonnet used its 9 s: Haiku gets the 3 s that are left, and rates. The two attempts took 10 s.
    h.ratingTimeouts = []
    h.completions = []
    h.ratingQueue = ['timeout']
    h.ratingTakes = [9000, 1000]
    await d.submit(`${LOOKUP} slow`)
    expect(h.completions).toEqual(['sonnet', 'haiku'])
    expect(h.ratingTimeouts, 'Sonnet 9 s, then what is left of 12 s').toEqual([9000, 3000])
    await d.step('t2')
    await d.complete('t2')
    const second = last(runLines(h).filter(l => l.kind === 'run')) as { ratingMs: number; rater: string }
    expect(second.rater).toBe('haiku')
    expect(second.ratingMs).toBe(10_000)
  })

  test(`when Sonnet used nearly all the budget, Haiku is skipped: the prompt is unrated, runs unchanged, and the line says why (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    h.now = Date.now()
    await d.start(surface)
    h.rating = LOWER
    h.ratingQueue = ['timeout']
    // 10.5 s gone: 1.5 s is left, under the 2 s an attempt needs.
    h.ratingTakes = [10_500]
    await d.submit(LOOKUP)
    expect(h.completions, 'Sonnet only: no Haiku attempt').toEqual(['sonnet'])
    await d.step('t1')
    expect(last(h.sent)?.effort, 'no rating, no change').toBe('medium')
    expect(last(h.sent)?.model).toBe('claude-opus-5-5')
    await d.complete('t1')
    expect(runLines(h).filter(l => l.kind === 'unrated')).toEqual([{ at: expect.any(String), kind: 'unrated', session: 'sess-1', reason: 'rating budget used up', rater: 'sonnet', overhead: 0, ratingMs: 10_500 }])
    expect(h.files[LOG_FILE] ?? '').toContain('rating budget used up: not rated')
    expect(h.files[LOG_FILE] ?? '').toContain('prompt not rated (rating budget used up)')

    // Exactly 2 s left is enough for an attempt.
    h.completions = []
    h.ratingTimeouts = []
    h.ratingQueue = ['timeout']
    h.ratingTakes = [10_000]
    await d.submit(`${LOOKUP} again`)
    expect(h.completions).toEqual(['sonnet', 'haiku'])
    expect(h.ratingTimeouts).toEqual([9000, 2000])

    // The report counts the budget hit.
    const text = (await d.command('report')).text ?? ''
    expect(text).toMatch(/Rating budget used up +1 of \d+ prompts?/)
  })

  test(`Rater set to haiku: the first try leaves room for the retry, and a retry with under 2 s left is not made (${surface})`, { timeoutMs: 30000, options: { rater: 'haiku' } }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', stored: { rater: 'haiku' } })
    const d = drive($, h)
    h.now = Date.now()
    await d.start(surface)
    h.rating = FIT_NO
    h.ratingQueue = ['timeout']
    h.ratingTakes = [10_000, 500]
    await d.submit(LOOKUP)
    expect(h.completions).toEqual(['haiku', 'haiku'])
    expect(h.ratingTimeouts, 'the first try 10 s, the retry the 2 s that are left').toEqual([10_000, 2000])

    h.completions = []
    h.ratingTimeouts = []
    h.ratingQueue = ['timeout']
    h.ratingTakes = [10_500]
    await d.submit(`${LOOKUP} slow`)
    expect(h.completions, 'no retry: 1.5 s is left').toEqual(['haiku'])
    expect(runLines(h).filter(l => l.kind === 'unrated').at(-1)).toMatchObject({ reason: 'rating budget used up', rater: 'haiku', ratingMs: 10_500 })
  })

  test(`a Haiku rating after a Sonnet failure counts toward the spot-check, and one check is asked (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { spotChecks: 19 } })
    const d = drive($, h)
    h.now = Date.now()
    await d.start(surface)
    h.rating = FIT_NO
    h.checkRating = CHECK_NO
    h.ratingQueue = ['timeout']
    await d.submit(LOOKUP)
    await flush()
    expect(h.completions, 'Sonnet failed, Haiku rated, Sonnet checked').toEqual(['sonnet', 'haiku', 'sonnet'])
    expect(h.store.spotChecks).toBe(20)
    expect(runLines(h).some(l => l.kind === 'check')).toBe(true)
  })

  test(`Rater set to haiku rates with Haiku, retries a timeout once on Haiku, and never calls Sonnet to rate (${surface})`, { timeoutMs: 30000, options: { rater: 'haiku' } }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', stored: { rater: 'haiku' } })
    const d = drive($, h)
    await d.start(surface)
    h.rating = FIT_NO
    h.ratingQueue = ['timeout']
    await d.submit(LOOKUP)
    expect(h.completions).toEqual(['haiku', 'haiku'])
    h.completions = []
    h.ratingQueue = ['unavailable']
    await d.submit(LOOKUP)
    expect(h.completions, 'a refused rater is not asked again').toEqual(['haiku'])
    expect((await d.command('status')).text ?? '').toContain('Rater: haiku')
  })

  test(`on a Sonnet session a debug rating at high does not raise effort, and stuck detection still can (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-sonnet-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES, ...AUTO_RAISE } })
    const d = drive($, h)
    await d.start(surface)
    h.rating = '{"fit":{"haiku":"no","sonnet":"high","opus":"medium","fable":"medium"},"type":"debug","read":20000,"write":3000,"steps":8,"reason":"unknown cause"}'
    await d.submit(DEBUG)
    await d.step('t1', 0)
    expect(last(h.sent)?.effort, 'the rating alone does not raise').toBe('medium')
    await d.bash('fail npm test')
    await d.bash('fail npm test')
    await d.step('t1', 1)
    expect(last(h.sent)?.effort, 'the same call failing twice raises it').toBe('high')
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
    expect(await buttons($), 'no hand-off happened').toEqual(['mode', 'close'])

    await d.submit(SEARCH)
    await d.step('t2', 0)
    await d.agent('haiku')
    await d.step('t2', 0, 'a2')
    await d.step('t2', 1)
    await d.complete('t2')
    expect(await bandText($, surface)).toMatch(/^rightsize: Sent to Haiku\./)
    expect(await buttons($)).toEqual(['good', 'bad', 'mode', 'close'])

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
    expect((await ui.findAll({ type: 'Button' })).map(b => b.key), 'the marks go once pressed').toEqual(['mode', 'close'])
    await ui.unmount()
    expect(await bandText($, surface), 'the band itself stays').toMatch(/^rightsize: Sent to Haiku\./)
    // Nothing leaves the machine: no fetch beyond the price check, and the line is only in the run log.
    expect(h.fetches).toBeLessThanOrEqual(1)
    // One hit (no rework) and one 👎, both Haiku's.
    expect((await d.command('report')).text ?? '').toMatch(/Haiku's judgement +wrong on 1 of 2 checked prompts \(50%\)/)
  })

  test(`👍 and 👎 on an automatic lowering write a feedback line for that run, and 👍 counts as a hit (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    h.now = Date.now()
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')

    h.rating = LOWER
    h.answers = { Lowering: 'Lower automatically (Recommended)', Remember: 'Just this session' }
    await d.submit(LOOKUP)
    await d.step('t1')
    await d.complete('t1')
    expect(await buttons($)).toEqual(['retry', 'good', 'bad', 'mode', 'close'])

    const ui = await mount($, surface)
    await ui.press({ key: 'good' })
    await flush()
    const run = runLines(h).find(l => l.kind === 'run') as { id: string; change: string }
    expect(run.change).toBe('lower')
    expect(runLines(h).filter(l => l.kind === 'feedback')).toMatchObject([{ ref: run.id, value: 'up', session: 'sess-1' }])
    expect(last(h.toasts)).toBe('Rightsize: thanks — this tunes its choices on this machine.')
    expect((await ui.findAll({ type: 'Button' })).map(b => b.key)).toEqual(['retry', 'mode', 'close'])
    await ui.unmount()
    expect(await bandText($, surface), 'one rated prompt: no session total yet').toMatch(/^rightsize: Effort lowered: medium → low for this prompt \(automatically\)\. Why: .+ Confidence: low\.$/)
    // The next lowering has its own id.
    await d.submit(LOOKUP)
    await d.step('t2')
    await d.complete('t2')
    expect(await buttons($)).toEqual(['retry', 'good', 'bad', 'mode', 'close'])
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
    expect(await buttons($)).toEqual(['mode', 'close'])
  })

  // The band says why, and for a move to a cheaper model how confident rightsize is; a hand-off or a switch-run
  // also offers "Run on <current model>", which runs this prompt once as it would have run without rightsize.
  const SMALL_FEATURE = '{"fit":{"haiku":"high","sonnet":"high","opus":"high","fable":"medium"},"size":"small","type":"feature","read":20000,"write":2000,"steps":6,"reason":"small helper with tests"}'

  test(`a hand-off down says why and its confidence, and Run on Opus runs the prompt once as normal (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = SMALL_FEATURE
    h.answers = { Cheaper: 'Send it to a cheaper subagent (Recommended)', Remember: 'Just this session' }
    await d.submit(DEBUG)
    const text = await bandText($, surface)
    expect(text).toMatch(/^rightsize: Sending this to a Haiku subagent at high effort/)
    expect(text).toContain('Why: Small helper with tests.')
    expect(text, 'a fresh log: the research alone').toContain('Confidence: low.')
    expect(await buttons($), 'the rule buttons are in the ⋯ menu').toEqual(['stay', 'mode', 'close'])

    const ui = await mount($, surface)
    expect((await ui.find({ type: 'Button', label: 'Run on Opus' }))?.text ?? 'none', 'named for the current model').not.toBe('none')
    await ui.press({ key: 'stay' })
    expect(h.filled.at(-1), 'the prompt is back in the box').toBe(DEBUG)
    expect(last(h.toasts) ?? '').toContain('run it on Opus at medium')
    await ui.unmount()
    expect(await bandText($, surface), 'the band closes').toBe('')

    // Sending it again: not rated, no hand-off note; the next prompt after it is rated again.
    const rated = h.ratings
    await d.submit(DEBUG)
    expect(h.ratings, 'not rated').toBe(rated)
    expect(last(h.submitted)?.context ?? [], 'no subagent note').toEqual([])
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    expect(h.ratings, 'rated again').toBe(rated + 1)
  })

  test(`a switch-run says why, offers Run on Sonnet, and has no confidence (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-sonnet-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = REVIEW
    h.answers = { Stronger: 'Use the stronger model automatically (Recommended)', Remember: 'Just this session' }
    await d.submit(DEBUG)
    const text = await bandText($, surface)
    expect(text).toContain('Running this review on Opus at high effort')
    expect(text).toContain('Why: Subtle bug hunt.')
    expect(text).not.toContain('Confidence')
    await d.step('t1')
    await d.complete('t1')
    expect(await buttons($)).toContain('stay')
    const ui = await mount($, surface)
    await ui.press({ key: 'stay' })
    expect(h.filled.at(-1)).toBe(DEBUG)
    expect(last(h.toasts) ?? '').toContain('run it on Sonnet at medium')
    await ui.unmount()
    const rated = h.ratings
    await d.submit(DEBUG)
    expect(h.ratings, 'not rated').toBe(rated)
    await d.step('t2')
    expect(last(h.sent)?.model, 'runs on the session model').not.toBe('opus')
  })

  test(`a raise says why but has no confidence, and offers no Run on (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = '{"level":"high","model":"same","type":"debug","read":20000,"write":3000,"steps":8,"reason":"unknown cause"}'
    h.answers = { Raising: 'Raise automatically (Recommended)', Remember: 'Just this session' }
    await d.submit(DEBUG)
    const text = await bandText($, surface)
    expect(text).toContain('Effort raised')
    expect(text).toContain('Why: Unknown cause.')
    expect(text).not.toContain('Confidence')
    expect(await buttons($)).not.toContain('stay')
  })

  test(`a band with no reason from the rater has no Why (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = LOWER.replace(',"reason":"one function lookup"', '')
    h.answers = { Lowering: 'Lower automatically (Recommended)', Remember: 'Just this session' }
    await d.submit(LOOKUP)
    expect(await bandText($, surface)).toBe('rightsize: Effort lowered: medium → low for this prompt (automatically). Confidence: low.')
  })

  test(`the band says only the confidence level; the ⋯ menu question carries the counts (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    h.files[RUNS] = Array.from({ length: 12 }, (_, i) =>
      JSON.stringify({ at: new Date(h.now - (12 - i) * 60_000).toISOString(), kind: 'run', type: 'lookup', route: 'main', tier: 'opus', change: 'lower', task: `k${i}`, steppedUp: false, session: 'old' }),
    ).join('\n') + '\n'
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = LOWER
    h.answers = { Lowering: 'Lower automatically (Recommended)', Remember: 'Just this session' }
    await d.submit(LOOKUP)
    const text = await bandText($, surface)
    expect(text).toMatch(/Why: One function lookup\. Confidence: (high|medium)\.$/)
    expect(text, 'no counts on the band').not.toMatch(/of your tasks|missed|How sure/)
    h.answers = {}
    const before = h.asked.length
    const ui = await mount($, surface)
    await ui.press({ key: 'mode' })
    await untilAsked(h, before)
    await ui.unmount()
    expect(h.asked.at(-1)?.question).toMatch(/^Confidence: (high|medium), 12 of your tasks, \d+% missed\. Options for this band\. /)
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
    h.answers = { Lowering: 'Lower automatically (Recommended)', Remember: 'Just this session' }
    await d.submit(LOOKUP)
    expect(h.asked.length, 'wrong on 3 of 6 lookups on Opus: lowering is paused, so nothing is asked').toBe(0)
    await d.step('t1')
    expect(last(h.sent)?.effort, 'stays at medium').toBe('medium')
    await d.complete('t1')
    expect(await bandText($, surface)).toBe('')
    // The report says what the record is and what it paused.
    const report = (await d.command('report')).text ?? ''
    expect(report).toMatch(/Haiku's judgement +wrong on 3 of 6 checked prompts \(50%\)/)
    expect(report).toMatch(/Hand-downs paused +lookup work to Opus, wrong on 50% of 6/)
    expect(report).toContain('Hand-downs of lookup work to Opus, and lowering effort on it, resume when')
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
    h.answers = { Lowering: 'Lower automatically (Recommended)', Remember: 'Just this session' }
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

  const LOG = LOG_PATH
  const disagree = (h: ReturnType<typeof engine>) => (h.files[LOG] ?? '').includes('plugin.json and the settings table disagree')
  const settingsText = async (d: ReturnType<typeof drive>) => (await d.command('status')).text ?? ''
  // A row in the "you changed" list: indented, with no (default) or (detected) mark after it.
  const listed = (t: string, title: string) => new RegExp(`^  ${title}: [^(\\n]+$`, 'm').test(t)
  const changedCount = (t: string) => Number(/You changed (\d+) setting/.exec(t)?.[1] ?? 0)
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
    { key: 'profile', value: 'Economy', start: { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES } }, see: async c => (await handOff(c, SEARCH, NEAR, CHEAPER_AUTO)).to, set: 'haiku', def: undefined },
    { key: 'floor', value: 'medium', start: { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES } }, see: c => effortOf(c, LOOKUP, LOWER, { Lowering: 'Lower automatically (Recommended)', ...YES_REMEMBER }), set: 'medium', def: 'low' },
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
        const { asked } = await prompt(c, LOOKUP, LOWER, { Lowering: 'Lower automatically (Recommended)', Remember: 'Yes, from now on' })
        return { asked, saved: c.h.store.choices, remembered: c.h.store.remember }
      },
      set: { asked: ['Lowering'], saved: undefined, remembered: undefined },
      def: { asked: ['Lowering', 'Remember'], saved: { lower: 'auto' }, remembered: true },
    },
    { key: 'handOff', value: '80%', start: { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES } }, see: async c => (await handOff(c, SEARCH, NEAR, CHEAPER_AUTO)).to, set: 'haiku', def: undefined },
    { key: 'lowering', value: '70%', start: { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES } }, see: c => effortOf(c, LOOKUP, LOWER_300, { Lowering: 'Lower automatically (Recommended)', ...YES_REMEMBER }), set: 'medium', def: 'low' },
    { key: 'useHaiku', value: 'off', start: FABLE, warm: true, see: async c => (await handOff(c, SEARCH, FIT_LOW, CHEAPER_AUTO)).to, set: 'sonnet', def: 'haiku' },
    { key: 'useFable', value: 'off', start: OPUS, see: async c => (await handOff(c, DEBUG, NEEDS_FABLE, { Stronger: 'Use the stronger model automatically (Recommended)', ...YES_REMEMBER })).to, set: undefined, def: 'fable' },
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
        c.h.answers = { Workflow: 'Pause rightsize for workflows (recommended)', Stronger: 'Use the stronger model automatically (Recommended)', ...YES_REMEMBER }
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
      value: 'on',
      start: { ...FABLE, store: { [CAL_STORE]: { ...tieCal(0.9), ...FREE_SWITCHES }, ties: 4 } },
      warm: true,
      see: async c => (await handOff(c, SEARCH, TIE_RATING, CHEAPER_AUTO)).to,
      set: 'opus',
      def: 'sonnet',
    },
    {
      key: 'missPause',
      value: '40%',
      start: { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES } },
      // Wrong on 2 of 6 lookups on Opus: 33%.
      setup: h => void (h.files[RUNS] = lookupLog(h, 2)),
      see: c => effortOf(c, LOOKUP, LOWER, { Lowering: 'Lower automatically (Recommended)', ...YES_REMEMBER }),
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
      key: 'rater',
      value: 'haiku',
      start: OPUS,
      see: async c => {
        c.h.rating = NO_CHANGE
        await c.d.submit(LOOKUP)
        return c.h.completions[0]
      },
      set: 'haiku',
      def: 'sonnet',
    },
    {
      key: 'raterCheck',
      value: 'every 25',
      start: { ...OPUS, store: { spotChecks: 24 } },
      see: async c => {
        // Only Haiku's ratings are checked.
        await c.d.config('rater', 'haiku')
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
      key: 'beforeCold',
      value: 'off',
      start: OPUS,
      see: async c => {
        c.h.stepUsage = BIG_TURN
        c.h.virtual = true
        const t = c.turn()
        await c.d.step(t)
        await c.d.complete(t)
        // The default asks, in the band, 5 minutes after the end of a big turn.
        await c.h.advance(5 * MIN)
        return (await bandText(c.$, c.surface)).startsWith('rightsize: Cache goes cold at ')
      },
      set: false,
      def: true,
    },
    {
      key: 'billing',
      value: 'subscription',
      start: OPUS,
      see: async c => {
        await prompt(c, DEBUG, NEEDS_FABLE, { Stronger: 'Ask before using it', Subagent: 'Send it to a Fable subagent', ...YES_REMEMBER })
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
      expect(await settingsText(s.d)).toContain(`${plainTitle(title)}: ${c.value}`)
    })

    test(`${title} (${c.key}): given at load it takes effect (${surface})`, { timeoutMs: 30000, options: { [c.key]: c.value } }, async ($, on) => {
      const h = engine(on, { ...c.start, stored: { [c.key]: c.value } })
      c.setup?.(h)
      const s = await scene($, h, c)
      expect(await c.see(s)).toEqual(c.set)
      expect(await settingsText(s.d)).toContain(`${plainTitle(title)}: ${c.value}`)
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
      expect(listed(await settingsText(d), plainTitle(row.title))).toBe(false)
      expect(disagree(h), 'plugin.json declares this row with this default').toBe(false)
    })
    for (const option of row.options.filter(o => o !== row.default)) {
      test(`${row.title} (${key}): "${option}" is a declared option (${surface})`, { timeoutMs: 30000, options: { [key]: option } }, async ($, on) => {
        const h = engine(on, { ...OPUS, stored: { [key]: option } })
        const d = drive($, h)
        await d.start(surface)
        // "check now" is an action, not a state: it checks once and the row goes back to monthly.
        const shown = key === 'priceCheck' && option === 'check now' ? 'monthly' : option
        expect(await settingsText(d)).toContain(`${plainTitle(row.title)}: ${shown}`)
        expect(disagree(h)).toBe(false)
      })
    }
  }

  test(`every row at its default: plugin.json and the table agree, and nothing is yours (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS })
    const d = drive($, h)
    await d.start(surface)
    const text = await settingsText(d)
    for (const key of KEYS) expect(listed(text, plainTitle(SETTINGS[key].title)), key).toBe(false)
    expect(text).toContain('are at their defaults')
    expect(disagree(h)).toBe(false)
  })

  test(`a value that is not one of a row's options counts as unset: the default applies, and it is not yours (${surface})`, { timeoutMs: 30000, options: { ceiling: 'ultra', raterCheck: 'on', startTips: 'on', missPause: '35%' } }, async ($, on) => {
    const h = engine(on, { ...OPUS, stored: { ceiling: 'ultra', raterCheck: 'on', startTips: 'on', missPause: '35%' } })
    const d = drive($, h)
    await d.start(surface)
    const text = await settingsText(d)
    expect(text).not.toContain('Highest effort:')
    expect(text, 'a stored on, from before it became a list: the old on is the default').not.toContain('Rater check:')
    expect(text).not.toContain('Start suggestions:')
    expect(text).not.toContain('Pause after misses:')
    expect(text).toContain('are at their defaults')
  })

  const SOME = { floor: 'medium', ceiling: 'xhigh', lowerRule: 'never lower', billing: 'api', explore: 'on', pacing: 'off' }
  test(`/rightsize lists every setting, with (yours) for those you set and (default) for the rest (${surface})`, { timeoutMs: 30000, options: SOME }, async ($, on) => {
    const set = SOME
    const h = engine(on, { ...OPUS, stored: set })
    const d = drive($, h)
    await d.start(surface)
    const text = await settingsText(d)
    for (const key of KEYS) {
      const row = SETTINGS[key]
      expect(listed(text, plainTitle(row.title)), key).toBe(key in set)
      if (key in set) expect(text, key).toContain(`${plainTitle(row.title)}: ${(set as Record<string, string>)[key]}\n`)
    }
    expect(changedCount(text)).toBe(6)
    expect(text).toContain(`The other ${KEYS.length - 6} are defaults`)
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
    expect(await bandText($, surface)).toMatch(/^rightsize: Sent to Haiku\. ~\d+% of Fable usage \(\$[\d.]+ vs \$[\d.]+\)\.?/)
  })

  test(`answers saved by an earlier session show in /config at the next start, and a row you set wins over them (${surface})`, { timeoutMs: 30000, options: { raiseRule: 'never raise' } }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: { remember: true, choices: { lower: 'auto', raise: 'auto' } }, stored: { raiseRule: 'never raise' } })
    const d = drive($, h)
    await d.start(surface)
    expect(h.stored.lowerRule, 'the saved answer, now a row').toBe('lower automatically')
    expect(h.stored.raiseRule, 'the row you set is left alone').toBe('never raise')
    const text = await settingsText(d)
    expect(text).toContain('Lowering: lower automatically')
    expect(text).toContain('Raising: never raise')
  })

  // Where plugin.json files the options: `rightsize`, or `rightsize@<marketplace>`.
  for (const configKey of ['rightsize', 'rightsize@archid21', 'rightsize@inline']) {
    test(`options stored under ${configKey} are yours (${surface})`, { timeoutMs: 30000, options: { floor: 'high' } }, async ($, on) => {
      const h = engine(on, { ...OPUS, stored: { floor: 'high' }, configKey })
      const d = drive($, h)
      await d.start(surface)
      const text = await settingsText(d)
      expect(text).toContain('Lowest effort: high')
      expect(text, 'another plugin\'s entry is not ours').not.toContain('Highest effort: max (yours)')
    })
  }

  test(`settings that cannot be read: a value that differs from its default counts as yours (${surface})`, { timeoutMs: 30000, options: { ceiling: 'high', floor: 'low' } }, async ($, on) => {
    const h = engine(on, { ...OPUS })
    h.settingsFail = true
    const d = drive($, h)
    await d.start(surface)
    const text = await settingsText(d)
    expect(text).toContain('Highest effort: high')
    expect(text, 'at its default: nothing says it was set').not.toContain('Lowest effort:')
  })

  test(`another plugin's change to a row, and a change to another row of the menu, do not make a row yours (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS })
    const d = drive($, h)
    await d.start(surface)
    await d.config('pacing', 'off', 'plugin')
    expect(await settingsText(d), 'applied, but not yours').not.toContain('Budget pacing:')
    await ($ as unknown as { config: { set: (x: unknown) => Promise<unknown> } }).config.set({ key: 'theme', value: 'dark', origin: { kind: 'composer' } })
    expect(await settingsText(d), 'another row of the menu changes nothing here').toContain('are at their defaults')
    await d.config('pacing', 'on')
    expect(await settingsText(d), 'the person sets it back: now it is theirs').toContain('Budget pacing: on')
    await d.config('escalation', 'off', 'bridge')
    expect(await settingsText(d), "a /config key=value from the person's phone").toContain('Raise when stuck: off')
  })

  test(`a row changed in /config never reaches another row (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS })
    const d = drive($, h)
    await d.start(surface)
    await d.config('floor', 'high')
    await d.config('handOff', '50%')
    const text = await settingsText(d)
    expect(text).toContain('Lowest effort: high')
    expect(text).toContain('Hand-off threshold: 50%')
    expect(text).not.toContain('Lowering threshold:')
    expect(text).not.toContain('Highest effort:')
    expect(changedCount(text)).toBe(2)
  })

  // ---- Your setting wins ----------------------------------------------------------------------------

  const REPORTS_DOLLARS = /About \$[\d.]+ that way/
  const askAboutFable = { Stronger: 'Ask before using it', Subagent: 'Send it to a Fable subagent', ...YES_REMEMBER }

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
    expect(text).toContain('Reports: api')
    expect(text).toContain('Rate limits look like a subscription; Reports is set to api by you.')
  })

  test(`Reports set to subscription stays one when the responses show a gateway's spend limit (${surface})`, { timeoutMs: 30000, options: { billing: 'subscription' } }, async ($, on) => {
    const h = engine(on, { ...OPUS, stored: { billing: 'subscription' } })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    const text = await settingsText(d)
    expect(text).toContain('Reports: subscription')
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
    expect(await settingsText(d)).toContain('Reports: api')
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
    expect(await settingsText(d)).toContain('Reports: api')
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
    expect(await settingsText(d)).toContain('Reports: subscription')
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
  // Hands off at 51% of staying: under the default 70%, and over a 50% bar. An underused window never moves the bar to 50%.
  const BIG = '{"fit":{"haiku":"medium","sonnet":"medium","opus":"medium","fable":"medium"},"size":"small","type":"search","read":40000,"write":1000,"steps":25,"reason":"list call sites"}'
  const hot = (h: { now: number; rateLimits: unknown }) => void (h.rateLimits = hotWindows(h))
  const cool = (h: { now: number; rateLimits: unknown }) => void (h.rateLimits = [{ kind: 'seven_day', percentUsed: 30, resetsAt: at(h, 6 * HOUR) }])
  const nearlyUsed = (h: { now: number; rateLimits: unknown }) => void (h.rateLimits = [{ kind: 'five_hour', percentUsed: 93, resetsAt: at(h, 4 * HOUR) }])

  const HAND_OFF_ROWS: { name: string; windows: (h: { now: number; rateLimits: unknown }) => void; stored: Record<string, string>; rating: string; to: string | undefined }[] = [
    { name: 'hot, default threshold: moved to 85%, and 78% is under it', windows: hot, stored: {}, rating: NEAR, to: 'haiku' },
    { name: 'hot, set to 70% (its own default value): stays, and 78% is over it', windows: hot, stored: { handOff: '70%' }, rating: NEAR, to: undefined },
    { name: 'hot, set to 80%: stays, and 78% is under it', windows: hot, stored: { handOff: '80%' }, rating: NEAR, to: 'haiku' },
    { name: 'cool, default threshold: not moved, and 51% is under 70%', windows: cool, stored: {}, rating: BIG, to: 'haiku' },
    { name: 'cool, set to 70%: stays, and 51% is under it', windows: cool, stored: { handOff: '70%' }, rating: BIG, to: 'haiku' },
    { name: 'cool, set to 50%: stays, and 51% is over it', windows: cool, stored: { handOff: '50%' }, rating: BIG, to: undefined },
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
      h.answers = { Lowering: 'Lower automatically (Recommended)', ...YES_REMEMBER }
      await d.submit(LOOKUP)
      await d.step('t1')
      expect(last(h.sent)?.effort).toBe(row.effort)
    })
  }

  // An underused window changes nothing: the same prompt gets the same plan and the same band at a cool pace as at an ordinary one.
  for (const [name, windows] of [['an ordinary pace', () => undefined], ['much of a window unused', cool]] as const) {
    test(`a hand-off to a cheaper model is planned the same with ${name} (${surface})`, { timeoutMs: 30000, options: { band: 'always' } }, async ($, on) => {
      const h = engine(on, { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES }, stored: { band: 'always' } })
      windows(h)
      expect(await handedOffUnder(h, drive($, h), BIG)).toBe('haiku')
      expect(await bandText($, surface), 'no pace note').not.toMatch(/window/)
    })
    test(`a lowering is planned the same with ${name} (${surface})`, { timeoutMs: 30000, options: { band: 'always' } }, async ($, on) => {
      const h = engine(on, { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES }, stored: { band: 'always' } })
      windows(h)
      const d = drive($, h)
      await d.start(surface)
      h.rating = SMALL
      h.answers = { Lowering: 'Lower automatically (Recommended)', ...YES_REMEMBER }
      await d.submit(LOOKUP)
      await d.step('t1')
      expect(last(h.sent)?.effort, '94% is over the default 90% bar: not lowered, and not at 80% either').toBe('medium')
      expect(await bandText($, surface), 'no pace note').not.toMatch(/window|unused/)
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
      want: { effort: 'high', asked: [], band: 'rightsize: Effort raised: medium → high for this prompt. Why: Unknown cause. 93% of the 5-hour window is used.' },
    },
    {
      name: 'Raising answered in an earlier session and saved: yours too, and the default thresholds that moved are said',
      store: { remember: true, choices: { raise: 'auto' } },
      stored: {},
      want: r => {
        expect([r.effort, r.asked]).toEqual(['high', []])
        expect(r.band).toContain('Effort raised: medium → high for this prompt. Why: Unknown cause. 93% of the 5-hour window is used, so rightsize saves all it can.')
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
    { name: 'at 50%: 4 of 6 wrong pauses (the first miss forgiven: 3 of 5, 60%), and the report says so', pause: '50%', steppedUp: 4, effort: 'medium', paused: true },
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
      h.answers = { Lowering: 'Lower automatically (Recommended)', ...YES_REMEMBER }
      await d.submit(LOOKUP)
      await d.step('t1')
      expect(last(h.sent)?.effort).toBe(row.effort)
      const report = (await d.command('report')).text ?? ''
      expect(report.includes('Hand-downs paused')).toBe(row.paused)
      expect(report).toMatch(new RegExp(`Haiku's judgement +wrong on ${row.steppedUp} of 6 checked prompts`))
    })
  }

  test(`Use Haiku off: no hand-off and no resized subagent goes to Haiku, and the rater is not a worker (${surface})`, { timeoutMs: 30000, options: { useHaiku: 'off' } }, async ($, on) => {
    const h = engine(on, { ...OPUS, stored: { useHaiku: 'off' } })
    const d = drive($, h)
    await d.start(surface)
    h.rating = NO_CHANGE
    await d.submit(SEARCH)
    await d.step('t1', 0)
    expect(h.completions, 'the rater is Sonnet, not a worker').toEqual(['sonnet'])
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
    expect(await settingsText(d), 'the saved answer is yours').toContain('Lowering: lower automatically')
    await d.config('lowerRule', 'not set')
    expect(await settingsText(d)).not.toContain('Lowering:')
    expect(h.store.choices, 'the saved copy keeps only the other rule').toEqual({ raise: 'auto' })
    h.rating = LOWER
    h.answers = { Lowering: 'Never lower' }
    await d.submit(LOOKUP)
    expect(h.asked.map(a => a.header), 'asked again').toEqual(['Lowering'])
    // A new session keeps the other rule.
    await d.start(surface)
    expect(await settingsText(d)).toContain('Raising: raise automatically')
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
      h.answers = { Lowering: 'Lower automatically (Recommended)', Remember: row.remember }
      await d.submit(LOOKUP)
      expect(h.asked.map(a => a.header)).toEqual(row.asked)
      expect(h.store.choices, 'the store').toEqual(row.kept ? { lower: 'auto' } : undefined)
      expect(h.stored.lowerRule, 'the Lowering row').toBe(row.kept ? 'lower automatically' : undefined)
      expect(h.store.remember).toBe(row.remembered ? true : undefined)
      if (row.remembered) expect(h.stored.remember, 'the Remember choices row').toBe('every session')
      expect(await settingsText(d), 'the answer is yours either way').toContain('Lowering: lower automatically')
    })
  }

  test(`Remember choices set live to every session keeps what was answered so far, and back to ask asks again (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    await d.start(surface)
    h.rating = LOWER
    h.answers = { Lowering: 'Lower automatically (Recommended)', ...YES_REMEMBER }
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
    h.answers = { Lowering: 'Lower automatically (Recommended)', ...YES_REMEMBER }
    await d.submit(LOOKUP)
    const ui = await mount($, surface)
    h.answers = { Options: 'Never lower' }
    const asked = h.asked.length
    await ui.press({ key: 'mode' })
    await untilAsked(h, asked)
    await ui.unmount()
    expect(h.stored.lowerRule).toBe('never lower')
    expect(h.sets.find(x => x.key === 'rightsize.lowerRule')?.value).toBe('never lower')

    // /rightsize settings asks the four questions again and writes every row.
    h.answers = { Lowering: 'Ask me each time', Raising: 'Never raise', Stronger: 'Use the stronger model automatically (Recommended)', Cheaper: 'Ask before sending it', ...YES_REMEMBER }
    const text = (await d.command('settings')).text ?? ''
    expect(h.stored).toMatchObject({ lowerRule: 'ask me', raiseRule: 'never raise', upRule: 'always send', downRule: 'ask first' })
    expect(text).toContain('Lowering: ask me')
    expect(text).toContain('Raising: never raise')
    expect(text).toContain('Cheaper model: ask first')
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
    expect(text, 'monthly, and not yours').not.toContain('Price check:')
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
    'Claude is starting a workflow. It may start many helper agents at once, often 10 or more, and each picks its own model. What should rightsize do during workflows? You can change this any time with Workflows in /config. No answer in 2 minutes: rightsize pauses for this workflow.'
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
      expect(await settingsText(d)).toContain(`Workflows: ${value}`)
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
    expect(await settingsText(d)).not.toContain('Workflows:')
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
        expect(cellsOf((await d.command('report')).text ?? '', 'Subagents on cheaper model')?.at(-1)).toBe('1')
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
      expect(text).toContain('are at their defaults')
      for (const key of KEYS) expect(listed(text, plainTitle(SETTINGS[key].title)), key).toBe(false)
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
      expect(changedCount(again), 'only the answer given just now').toBe(1)
      expect(again).toContain('Raising: never raise')
      // Reports is read off the rate limits once a prompt went through, and saved: not yours either.
      for (const key of ROWS_RESET.filter(k => k !== 'billing')) expect(listed(again, plainTitle(SETTINGS[key as SettingKey].title)), key).toBe(false)
      expect(again).toContain('Reports: api (saved)')
    })
  }

  test(`a row reset then set again in /config is yours again, whatever its value, and leaves the list (${surface})`, { timeoutMs: 30000, options: SOME_SET }, async ($, on) => {
    const h = engine(on, { ...OPUS, stored: SOME_SET })
    const { d } = await resetSettingsRun($, h, 'Settings')
    expect(await settingsText(d)).not.toContain('Lowest effort:')
    await d.config('floor', 'high')
    expect(await settingsText(d)).toContain('Lowest effort: high')
    expect(h.store.resetFields).not.toContain('floor')
    expect(h.store.resetFields, 'the others stay on it').toContain('handOff')
    // Set to the default value itself: yours too.
    await d.config('handOff', '70%', 'bridge')
    expect(await settingsText(d)).toContain('Hand-off threshold: 70%')
    expect(h.store.resetFields).not.toContain('handOff')
    // A new session keeps all of that: floor and handOff are yours, the rest default.
    await d.start(surface)
    const text = await settingsText(d)
    expect(text).toContain('Lowest effort: high')
    expect(text).toContain('Hand-off threshold: 70%')
    expect(text).not.toContain('Band:')
    expect(changedCount(text)).toBe(2)
  })

  test(`a reset row changed by hand in settings.json is yours at the next start (${surface})`, { timeoutMs: 30000, options: SOME_SET }, async ($, on) => {
    const h = engine(on, { ...OPUS, stored: SOME_SET })
    const { d } = await resetSettingsRun($, h, 'Settings')
    h.stored.floor = 'high'
    await d.start(surface)
    const text = await settingsText(d)
    expect(text).toMatch(/Lowest effort: \w+\n/)
    expect(text).not.toContain('Hand-off threshold:')
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
      expect(text).not.toContain('Hand-off threshold:')
      expect(text, 'the others are as they were').toContain('Lowest effort: medium')
      expect(text).toContain('Budget pacing: off')
      expect(h.stored.handOff).toBe('70%')
      expect(h.store.resetFields).toEqual(['handOff'])
      expect(h.store.choices, 'the saved answers stay').toEqual({ raise: 'auto' })
      // The other six rows, and the saved answer for Raising: seven.
      expect(changedCount(text)).toBe(7)
    })
  }

  test(`/rightsize reset when Claude Code refuses the write: says so, gives the terminal command, logs the reason (${surface})`, { timeoutMs: 30000, options: SOME_SET }, async ($, on) => {
    const h = engine(on, { ...OPUS, stored: SOME_SET })
    h.refuse = ['handOff']
    const d = drive($, h)
    await d.start(surface)
    h.answers = { Confirm: 'Yes' }
    const out = (await d.command('reset handOff')).text ?? ''
    expect(out).toBe(`Hand-off threshold could not be changed from here. To reset it, run this in a terminal, then restart Claude Code: echo '{"handOff":"70%"}' | claude plugin configure rightsize@archid21 --values-stdin`)
    expect(out).not.toContain('back to its default')
    expect(h.stored.handOff, 'unchanged').toBe('50%')
    expect(await settingsText(d)).toContain('Hand-off threshold: 50%')
    expect(h.files[LOG_PATH] ?? '').toContain('reset handOff: Claude Code refused to write it: only its dialog changes it')
    expect(h.store.resetFields, 'listed, so the default counts as a default once set from a terminal').toEqual(['handOff'])
  })

  test(`/rightsize reset on one setting declined: nothing changes (${surface})`, { timeoutMs: 30000, options: SOME_SET }, async ($, on) => {
    const h = engine(on, { ...OPUS, stored: SOME_SET })
    const d = drive($, h)
    await d.start(surface)
    h.answers = { Confirm: 'No' }
    expect((await d.command('reset handOff')).text).toBe('Nothing was reset.')
    expect(await settingsText(d)).toContain('Hand-off threshold: 50%')
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
    expect(text).not.toContain('Lowering:')
    expect(text).toContain('Raising: never raise')
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
    expect(await settingsText(d)).not.toMatch(/Reports: \w+\n/)
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
    h.answers = { Lowering: 'Lower automatically (Recommended)', Remember: 'Just this session' }
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
    expect(await settingsText(d)).not.toContain('Share anonymous feedback:')
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
      expect(await settingsText(d), 'the calibration was loaded').toContain('Measured runs: 5')
      h.answers = { Reset: choice, Confirm: 'Yes' }
      const out = (await d.command('reset')).text ?? ''
      expect(out).toContain('Cost measurement restarted: rightsize is back to its starting estimates and relearns from your next prompts.')
      for (const key of [CAL_STORE, 'ties', 'spotChecks', 'startCheckedAt', 'startSnooze']) expect(h.store[key], key).toBeNull()
      expect(h.store.measureFrom).toBe(new Date(h.now).toISOString())
      expect(await settingsText(d), 'in memory too').toContain('Measured runs: 0')
      expect(h.files[RUNS], 'the run log is kept, line for line').toBe(log)
      // The report still counts all of it, and says when measurement restarted.
      const report = (await d.command('report')).text ?? ''
      expect(report).toContain(`Cost measurement restarted on ${new Date(h.now).toISOString().slice(0, 10)}.`)
      expect(cellsOf(report, 'Prompts rated')?.slice(1)).toEqual(['66', '66'])
      expect(report, 'what went wrong reads the whole history').toMatch(/Haiku's judgement +wrong on 3 of 6 checked prompts \(50%\)/)
      expect(report, 'but nothing is paused any more').not.toContain('Hand-downs paused')
      // Settings stay unless Both.
      expect(await settingsText(d)).toContain(choice === 'Both' ? `All ${KEYS.length} settings are at their defaults` : 'Lowering: lower automatically')
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
    expect(String((await d.command('report')).text)).toContain('STARTING POINT  Opus at medium, 60 rated prompts in 30 days')
    h.answers = { Reset: 'Cost measurement', Confirm: 'Yes' }
    await d.command('reset')
    // The report's block waits for rated prompts from now on, though its history still counts the 60.
    const report = String((await d.command('report')).text)
    expect(report).toContain('STARTING POINT  Needs 50 rated prompts to compare (has 0).')
    expect(cellsOf(report, 'Prompts rated')?.slice(1)).toEqual(['60', '60'])
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
    expect(await settingsText(d)).toContain('are at their defaults')
  })


  test(`/rightsize help lists every command and what it does (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS })
    const d = drive($, h)
    await d.start(surface)
    const text = (await d.command('help')).text ?? ''
    for (const c of ['', 'status', 'settings', 'report', 'retry', 'clear', 'prices', 'share', 'reset', 'help']) expect(text, c).toMatch(new RegExp(`^  /rightsize${c ? ` ${c}` : ''} +\\S`, 'm'))
    expect(text).toContain('reset <setting> resets one')
    expect(text).toContain('message you can paste to tell others')
    expect(h.asked, 'no question').toEqual([])
  })

  test(`an unknown /rightsize command says so and lists the commands (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS })
    const d = drive($, h)
    await d.start(surface)
    const text = (await d.command('foo')).text ?? ''
    expect(text.startsWith('Unknown command "foo".')).toBe(true)
    expect(text).toContain('rightsize commands')
  })

  test(`/rightsize ends with a pointer to help, and no long command list (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS })
    const d = drive($, h)
    await d.start(surface)
    const text = await settingsText(d)
    expect(text.endsWith('Commands: /rightsize help')).toBe(true)
    expect(text).not.toContain('undo re-runs')
  })

  test(`the status bar never repeats the name Claude Code already shows (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    expect(h.statuses).toContain('Rating the prompt...')
    expect(h.statuses.filter(t => t?.toLowerCase().startsWith('rightsize')), 'no status starts with the name').toEqual([])
  })

  test(`/rightsize starts with "On." (Claude Code already shows the name) and points to claude plugin configure (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS })
    const d = drive($, h)
    await d.start(surface)
    const text = await settingsText(d)
    expect(text.startsWith('Profile: Balanced\nOn.\n'), 'the profile on the first line').toBe(true)
    expect(text).not.toContain('Rightsize is')
    expect(text).toContain('(list them with claude plugin configure rightsize@archid21)')
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


  // The first prompt of a session: nothing has run a step yet, so the model and the window come from the engine.
  const PLAIN = '{"level":"medium","model":"same","size":"small","type":"lookup","read":2000,"write":300,"steps":1}'
  const LOG_FILE = LOG_PATH
  const firstPrompt = async (h: ReturnType<typeof engine>, d: ReturnType<typeof drive>, turn: string) => {
    h.rating = PLAIN
    await d.submit(LOOKUP)
    await d.step(turn)
    await d.complete(turn)
    return runLines(h).filter(l => l.kind === 'run').at(-1) as { tier: string; context: number } | undefined
  }

  test(`the first prompt of a session started on Sonnet, with no model setting, is planned on Sonnet (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-sonnet-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    const run = await firstPrompt(h, d, 't1')
    expect(run?.tier, 'the run was planned on the live model, not the Opus fallback').toBe('sonnet')
    const log = h.files[LOG_FILE] ?? ''
    expect(log).toContain('lookup on sonnet/')
    expect(log).not.toContain('on opus/')
    expect(log, 'the model was known: nothing to say about it').not.toContain('session model unknown')
  })

  test(`a /model change before the next prompt is planned on the new model, ahead of the one last seen (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-sonnet-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    await firstPrompt(h, d, 't1')
    h.liveModel = 'claude-haiku-5-5'
    h.model = 'claude-haiku-5-5'
    h.rating = PLAIN
    await d.submit(LOOKUP)
    expect(h.files[LOG_FILE] ?? '', 'the second prompt, planned on Haiku').toContain('lookup on haiku/')
  })

  test(`a model nobody can name is planned as Opus, and the log says it was unknown (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'mystery-1', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    h.rating = PLAIN
    await d.submit(LOOKUP)
    const log = h.files[LOG_FILE] ?? ''
    expect(log).toContain('session model unknown')
    expect(log, 'a fallback, not a guess made silently').toContain('lookup on opus/')
  })

  test(`the first prompt is planned at the live context size when the engine reports one (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    h.contextTokens = 150_000
    await d.start(surface)
    expect((await firstPrompt(h, d, 't1'))?.context, 'a resumed session of 150K').toBe(150_000)

  })

  test(`the first prompt keeps the 20K start size when the engine has no reading yet (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    expect((await firstPrompt(h, d, 't1'))?.context, 'a fresh session').toBe(20_000)
  })

  test(`a rating that times out falls back to Haiku; if that fails too the prompt is logged as unrated and the session is left as it was (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    h.ratingUsage = { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    // The log's times are the wall clock's: the report's periods count from now.
    h.now = Date.now()
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')

    // One timeout, then an answer: the retry rates the prompt, and nothing is logged as unrated.
    h.ratingQueue = ['timeout']
    h.rating = LOWER
    h.answers = { Lowering: 'Lower automatically (Recommended)', Remember: 'Just this session' }
    const before = h.ratings
    await d.submit(LOOKUP)
    expect(h.ratings - before, 'two calls').toBe(2)
    expect(runLines(h).some(l => l.kind === 'unrated')).toBe(false)
    await d.step('t1')
    expect(last(h.sent)?.effort, 'the rating counted: lowered').toBe('low')
    await d.complete('t1')

    // Two timeouts: no route, the session as it is, one unrated line carrying both calls' cost.
    h.ratingQueue = ['timeout', 'timeout']
    const calls = h.ratings
    await d.submit(LOOKUP)
    expect(h.ratings - calls, 'one retry, no more').toBe(2)
    await d.step('t2')
    expect(last(h.sent)?.effort, 'effort as the session has it').toBe('medium')
    expect(last(h.sent)?.model, 'model as the session has it').toBe('claude-opus-5-5')
    await d.complete('t2')
    const unrated = runLines(h).filter(l => l.kind === 'unrated')
    // An unrated prompt is part of the task in progress: the last rated run's.
    const task = (last(runLines(h).filter(l => l.kind === 'run')) as { task: string }).task
    expect(unrated).toEqual([{ at: expect.any(String), kind: 'unrated', session: 'sess-1', task, reason: 'rating call timed out', rater: 'haiku', overhead: 0.00315, ratingMs: 0 }])
    expect(h.files[LOG_FILE] ?? '').toContain('prompt not rated (rating call timed out)')

    // An answer that cannot be read is tried again the same way.
    h.ratingQueue = ['no json', 'still no json']
    const reads = h.ratings
    await d.submit(LOOKUP)
    expect(h.ratings - reads).toBe(2)
    expect(runLines(h).filter(l => l.kind === 'unrated').at(-1)?.reason).toBe('rating unreadable')
    await d.step('t3')
    await d.complete('t3')

    // A rater that is not available is not asked again by itself; Sonnet's refusal still tries Haiku once.
    h.ratingQueue = ['unavailable', 'unavailable']
    const asked = h.ratings
    await d.submit(LOOKUP)
    expect(h.ratings - asked, 'Sonnet, then Haiku').toBe(2)
    expect(runLines(h).filter(l => l.kind === 'unrated').at(-1)?.reason).toBe('rating call failed (status 401)')

    // The report counts them as not counted, with a plain reason.
    const report = (await d.command('report')).text ?? ''
    expect(report).toMatch(/3 prompts +not rated \(the rating failed\), so nothing was changed/)
  })


  // ---- Watching the cheaper helpers, with one retry budget per task ----

  const HELPERS = { remember: true, choices: { raise: 'auto', down: 'auto' } }
  const HAND_OFF = (continues = false) => `{"fit":{"haiku":"low","sonnet":"low","opus":"low","fable":"low"},"type":"search","read":150000,"write":3000,"steps":30,"continues":${continues},"reason":"repo-wide search"}`
  const HELPER_LOG = LOG_PATH
  const helperLog = (h: ReturnType<typeof engine>) => h.files[HELPER_LOG] ?? ''
  type Drive = ReturnType<typeof drive>
  // The main chat hands the work to a Haiku subagent called `helper`, which takes its first step (at low effort).
  async function startHelper(d: Drive, h: ReturnType<typeof engine>, turn: string, helper: string, text = SEARCH) {
    await d.submit(text)
    await d.step(turn, 0)
    await d.agent('haiku')
    await d.spawn(helper, 'haiku')
    await d.step(turn, 0, `agent-${helper}`)
    expect(last(h.sent)?.effort).toBe('low')
  }
  async function warm(d: Drive, h: ReturnType<typeof engine>) {
    h.subModel = 'claude-haiku-5-5'
    await d.step('t0')
    await d.complete('t0')
  }
  type HelperEntry = { agent: string; kind: string; steps: number; ms: number; errors: number; blocked: number; stall?: string; raises?: { step: number; from: string; to: string; why: string }[]; returned?: boolean }

  test(`a struggling hand-off helper is raised one level, and its later steps go out at it (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-fable-5-1', effort: 'high', store: HELPERS })
    const d = drive($, h)
    await d.start(surface)
    await warm(d, h)
    h.rating = HAND_OFF()
    await startHelper(d, h, 't1', 'helper')
    await d.bash('fail make', 'agent-helper')
    await d.step('t1', 1, 'agent-helper')
    expect(last(h.sent)?.effort, 'one failure is ordinary').toBe('low')
    await d.bash('fail make', 'agent-helper')
    await d.step('t1', 2, 'agent-helper')
    expect(last(h.sent)?.effort, 'the same call failed twice: one level up').toBe('medium')
    expect(helperLog(h)).toContain('raised helper agent-helper low → medium at step 3: the same tool call failed twice')
    await d.step('t1', 3, 'agent-helper')
    expect(last(h.sent)?.effort, 'and it stays there').toBe('medium')
    expect(h.asked.length, 'nobody is asked mid-helper').toBe(0)
    expect(await bandText($, surface)).toBe('rightsize: Helper effort raised: low → medium (the same tool call failed twice).')
    await d.step('t1', 1)
    await d.complete('t1')
    const run = readRuns(h).find(l => l.kind === 'run') as { helpers?: HelperEntry[]; retries?: number }
    expect(run.retries, 'one chance used').toBe(1)
    expect(run.helpers).toEqual([
      { agent: 'agent-helper', kind: 'handoff', steps: 4, ms: 0, errors: 2, blocked: 0, stall: 'struggling', raises: [{ step: 3, from: 'low', to: 'medium', why: 'the same tool call failed twice' }] },
    ])
  })

  test(`a blocked helper is not raised, and a sign with only blocked errors behind it is not either (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-fable-5-1', effort: 'high', store: HELPERS })
    const d = drive($, h)
    await d.start(surface)
    await warm(d, h)
    h.rating = HAND_OFF()
    await startHelper(d, h, 't1', 'helper')
    for (let i = 0; i < 3; i++) await d.bash('env:curl: (6) Could not resolve host: registry.example.com', 'agent-helper')
    await d.step('t1', 1, 'agent-helper')
    expect(last(h.sent)?.effort, 'the network is down: effort would not help').toBe('low')
    // The same successful call three times is a loop, but only blocked errors stand behind it: can't tell.
    for (let i = 0; i < 3; i++) await d.bash('ls', 'agent-helper')
    await d.step('t1', 2, 'agent-helper')
    expect(last(h.sent)?.effort).toBe('low')
    expect(helperLog(h).match(/helper agent-helper blocked by the environment: more effort will not help/g)?.length, 'logged once').toBe(1)
    expect(helperLog(h)).toContain("can't tell, no raise")
    const after = (await d.bash('ls', 'agent-helper')) as { deny?: string }
    expect(after.deny, 'not returned either').toBeUndefined()
    await d.complete('t1')
    const run = readRuns(h).find(l => l.kind === 'run') as { helpers?: HelperEntry[]; retries?: number }
    expect(run.helpers?.map(x => [x.stall, x.blocked, x.returned, x.raises])).toEqual([['blocked', 3, undefined, undefined]])
    expect('retries' in run, 'no chance used').toBe(false)
  })

  test(`the third struggle of a task with two chances used sends the helper back: every tool call after is refused (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-fable-5-1', effort: 'high', store: HELPERS })
    const d = drive($, h)
    await d.start(surface)
    await warm(d, h)
    h.rating = HAND_OFF()
    await startHelper(d, h, 't1', 'helper')
    await d.bash('fail a', 'agent-helper')
    await d.bash('fail a', 'agent-helper')
    await d.step('t1', 1, 'agent-helper')
    expect(last(h.sent)?.effort, 'first chance').toBe('medium')
    await d.bash('fail b', 'agent-helper')
    await d.step('t1', 2, 'agent-helper')
    expect(last(h.sent)?.effort, 'second chance').toBe('high')
    for (let i = 0; i < 3; i++) await d.bash('ls', 'agent-helper')
    await d.step('t1', 3, 'agent-helper')
    expect(last(h.sent)?.effort, 'no third raise').toBe('high')
    expect(helperLog(h)).toContain('returned helper agent-helper to the main chat at step 4: the same tool call ran 3 times, and the task has no retry left')
    for (let i = 0; i < 2; i++) {
      const denied = (await d.bash('ls', 'agent-helper')) as { deny?: string }
      expect(denied.deny, 'stopped: report back').toContain('stuck')
      expect(denied.deny).toContain('retry budget is used up')
    }
    expect(((await d.bash('ls')) as { deny?: string }).deny, 'the main chat is not stopped').toBeUndefined()
    await d.answer('agent-helper')
    await d.complete('t1')
    const run = readRuns(h).find(l => l.kind === 'run') as { helpers?: HelperEntry[]; retries?: number }
    expect(run.retries).toBe(2)
    expect(run.helpers?.map(x => [x.stall, x.returned, x.raises?.map(r => `${r.from}>${r.to}`)])).toEqual([['struggling', true, ['low>medium', 'medium>high']]])
  })

  test(`a struggling helper is asked about when Raising is not automatic: raised on yes, left alone on keep (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-fable-5-1', effort: 'high', store: { remember: true, choices: { down: 'auto' } } })
    const d = drive($, h)
    await d.start(surface)
    await warm(d, h)
    h.rating = HAND_OFF()
    h.answers = { Stuck: 'Raise to medium' }
    await startHelper(d, h, 't1', 'helper')
    await d.bash('fail a', 'agent-helper')
    await d.bash('fail a', 'agent-helper')
    await d.step('t1', 1, 'agent-helper')
    expect(h.asked.map(a => a.header), 'asked, as for the main chat').toEqual(['Stuck'])
    expect(h.asked[0]?.question).toContain('It uses one of this task\'s 2 retries. With no answer in 2 minutes it goes back to the main chat.')
    expect(last(h.sent)?.effort, 'raised on yes').toBe('medium')
    await d.complete('t1')

    // A new task, and a keep: not raised, not sent back.
    h.asked = []
    h.answers = { Stuck: 'Keep low' }
    h.rating = HAND_OFF()
    await startHelper(d, h, 't2', 'second')
    await d.bash('fail b', 'agent-second')
    await d.bash('fail b', 'agent-second')
    await d.step('t2', 1, 'agent-second')
    expect(h.asked.map(a => a.header)).toEqual(['Stuck'])
    expect(last(h.sent)?.effort, 'kept').toBe('low')
    expect(((await d.bash('ls', 'agent-second')) as { deny?: string }).deny, 'not sent back').toBeUndefined()
    expect(helperLog(h)).toContain('kept at low, as you chose')
    await d.complete('t2')
  })

  test(`a struggling helper with nobody to answer goes back to the main chat after the wait (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-fable-5-1', effort: 'high', store: { remember: true, choices: { down: 'auto' } } })
    const d = drive($, h)
    await d.start(surface)
    await warm(d, h)
    h.rating = HAND_OFF()
    h.answers = { Stuck: NO_ONE }
    h.sleepEnds = true
    await startHelper(d, h, 't1', 'helper')
    await d.bash('fail a', 'agent-helper')
    await d.bash('fail a', 'agent-helper')
    await d.step('t1', 1, 'agent-helper')
    expect(h.asked.map(a => a.header)).toEqual(['Stuck'])
    expect(last(h.sent)?.effort, 'not raised').toBe('low')
    expect(helperLog(h)).toContain('no answer in 2 minutes')
    expect(((await d.bash('ls', 'agent-helper')) as { deny?: string }).deny).toContain('stuck')
    await d.complete('t1')
  })

  // ---- Every question waits 2 minutes, then takes the choice that changes nothing ----

  const until = async (done: () => boolean) => {
    for (let i = 0; i < 200 && !done(); i++) await new Promise(r => setTimeout(r, 10))
  }
  const NO_ANSWER = 'No answer in 2 minutes:'

  test(`Lowering with nobody to answer: this prompt runs as it is, nothing is saved, and it is asked again next time (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = LOWER
    h.answers = { Lowering: NO_ONE }
    h.sleepEnds = true
    await d.submit(LOOKUP)
    await d.step('t1', 0)
    expect(h.asked.map(a => a.header), 'no Remember question either').toEqual(['Lowering'])
    expect(h.asked[0]?.question).toContain(`${NO_ANSWER} this prompt runs as it is.`)
    expect(last(h.sent)?.effort, 'no change').toBe('medium')
    expect(h.store.choices, 'nothing saved').toBeUndefined()
    expect(helperLog(h)).toContain('no answer in 2 minutes to Lowering: this prompt ran with no change; nothing saved')
    await d.complete('t1')
    await d.submit(LOOKUP)
    expect(h.asked.map(a => a.header), 'asked again').toEqual(['Lowering', 'Lowering'])
  })

  test(`Stronger model with nobody to answer: no switch and no hand-off, and nothing is saved (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = '{"level":"high","model":"fable","size":"small","type":"debug","read":30000,"write":4000,"steps":12,"reason":"subtle concurrency bug"}'
    h.answers = { Stronger: NO_ONE }
    h.sleepEnds = true
    await d.submit(DEBUG)
    await d.step('t1')
    expect(h.asked.map(a => a.header)).toEqual(['Stronger'])
    expect(h.asked[0]?.question).toContain(`${NO_ANSWER} this prompt runs as it is.`)
    expect(handedTo(h), 'no hand-off').toBeUndefined()
    expect(last(h.sent)?.model, 'no switch').not.toBe('fable')
    expect(h.store.choices).toBeUndefined()
    expect(helperLog(h)).toContain('no answer in 2 minutes to Stronger')
    await d.complete('t1')
  })

  test(`Remember with nobody to answer: this session only, and it is not asked again (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = LOWER
    h.answers = { Lowering: 'Lower automatically (Recommended)', Remember: NO_ONE }
    h.sleepEnds = true
    await d.submit(LOOKUP)
    await d.step('t1', 0)
    expect(h.asked.map(a => a.header)).toEqual(['Lowering', 'Remember'])
    expect(h.asked[1]?.question).toBe(`Use these choices in every session? ${NO_ANSWER} this session only.`)
    expect(last(h.sent)?.effort, 'the Lowering answer still applies').toBe('low')
    expect(h.store.remember, 'not kept for every session').toBeUndefined()
    expect(h.store.choices).toBeUndefined()
    expect(helperLog(h)).toContain('no answer in 2 minutes to Remember: these choices stay for this session only')
  })

  test(`Billing with nobody to answer: API prices for now, not saved, asked again next session (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    h.rateLimits = []
    h.rating = NO_CHANGE
    h.answers = { Billing: NO_ONE }
    h.sleepEnds = true
    await d.start(surface)
    await d.step('t1')
    await d.complete('t1')
    await d.submit(LOOKUP)
    expect(h.asked.map(a => a.header)).toEqual(['Billing'])
    expect(h.asked[0]?.question).toContain(`${NO_ANSWER} reports use API prices for now.`)
    expect(h.store.billing, 'not saved').toBeUndefined()
    expect(helperLog(h)).toContain('no answer in 2 minutes to Billing')
    await d.start(surface)
    await d.step('t2')
    await d.complete('t2')
    await d.submit(LOOKUP)
    expect(h.asked.map(a => a.header), 'asked again in the next session').toEqual(['Billing', 'Billing'])
  })

  test(`an ask-each-time question with nobody to answer stays as it is (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { remember: true, choices: { raise: 'ask' } } })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = RAISE_HIGH
    h.answers = { Effort: NO_ONE }
    h.sleepEnds = true
    await d.submit(DEBUG)
    await d.step('t1')
    expect(h.asked.map(a => a.header)).toEqual(['Effort'])
    expect(h.asked[0]?.question).toContain(`${NO_ANSWER} it stays as it is.`)
    expect(last(h.sent)?.effort, 'never raised').toBe('medium')
    expect(helperLog(h)).toContain('no answer in 2 minutes to Effort: kept medium')
    await d.complete('t1')
  })

  test(`Subagent with nobody to answer: nothing is sent to a subagent (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { remember: true, choices: { down: 'ask' } } })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = HAND_OFF()
    h.answers = { Subagent: NO_ONE }
    h.sleepEnds = true
    await d.submit(SEARCH)
    await d.step('t1')
    expect(h.asked.map(a => a.header)).toEqual(['Subagent'])
    expect(h.asked[0]?.question).toContain(`${NO_ANSWER} it stays as it is.`)
    expect(handedTo(h), 'not sent').toBeUndefined()
    expect(helperLog(h)).toContain('no answer in 2 minutes to Subagent: stayed on Opus')
    await d.complete('t1')
  })

  test(`Stuck in the main chat with nobody to answer keeps the effort, and a late answer only gets a toast (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    await d.step('t1', 0)
    await d.bash('fail make')
    await d.bash('fail make')
    let release = () => {}
    h.answerGate = { Stuck: new Promise<void>(r => (release = r)) }
    h.answers = { Stuck: 'Raise to high for this turn' }
    h.sleepEnds = true
    await d.step('t1', 1)
    expect(h.asked[0]?.question).toBe(`Claude looks stuck: the same tool call failed twice. Raise effort from medium to high for the rest of this turn? ${NO_ANSWER} it keeps medium.`)
    expect(last(h.sent)?.effort).toBe('medium')
    expect(helperLog(h)).toContain('no answer in 2 minutes to Stuck: kept medium')
    release()
    await until(() => h.toasts.some(t => t.includes('too late')))
    expect(last(h.toasts)).toBe('rightsize: that answer came too late; nothing changed.')
    await d.step('t1', 2)
    expect(last(h.sent)?.effort, 'still not raised').toBe('medium')
  })

  test(`Workflow with nobody to answer pauses rightsize for this workflow without saving it; a late answer is kept for later (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS })
    const d = drive($, h)
    await d.start(surface)
    let release = () => {}
    h.answerGate = { Workflow: new Promise<void>(r => (release = r)) }
    h.rating = NO_CHANGE
    h.answers = { Workflow: 'Follow my rules for the main chat' }
    h.sleepEnds = true
    await d.submit(LOOKUP)
    await d.step('t1')
    await d.workflow()
    expect(h.events, 'the workflow went ahead').toContain('workflow')
    expect(h.asked[0]?.question).toContain(`${NO_ANSWER} rightsize pauses for this workflow.`)
    expect(await settingsText(d), 'not saved').not.toContain('Workflows:')
    expect(helperLog(h)).toContain('no answer in 2 minutes to Workflow')
    release()
    await until(() => h.configSet.length > 0)
    expect(await settingsText(d), 'the late answer is kept').toContain('Workflows: follow my rules')
  })

  test(`a late answer to a rule question is saved for the next prompt, and the running one is unchanged (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    let release = () => {}
    h.answerGate = { Lowering: new Promise<void>(r => (release = r)) }
    h.rating = LOWER
    h.answers = { Lowering: 'Lower automatically (Recommended)', Remember: 'Just this session' }
    h.sleepEnds = true
    await d.submit(LOOKUP)
    await d.step('t1', 0)
    expect(last(h.sent)?.effort, 'this prompt: no change').toBe('medium')
    await d.complete('t1')
    release()
    await until(() => h.toasts.some(t => t.includes('saved your answer')))
    expect(last(h.toasts)).toBe('rightsize: saved your answer for next time.')

    h.asked = []
    await d.submit(LOOKUP)
    await d.step('t2', 0)
    expect(h.asked.filter(a => a.header === 'Lowering'), 'not asked again').toEqual([])
    expect(last(h.sent)?.effort, 'the saved rule lowers it').toBe('low')
  })

  test(`Idle is not timed: after 2 minutes the band says the prompt is held, and an answer still works (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await idleSetup($, on, surface)
    h.now += 2 * 60 * MIN
    let release = () => {}
    h.answerGate = { Idle: new Promise<void>(r => (release = r)) }
    h.answers = { Idle: 'Hold it: I will /clear or /compact first' }
    h.sleepEnds = true
    const sent = h.submitted.length
    const pending = d.submit('continue') as Promise<{ drop?: string }>
    let settled = false
    void pending.then(() => (settled = true))
    await until(() => h.asked.length > 0)
    // The engine draws nothing while the prompt hook is open, so the log carries the band's text.
    await until(() => helperLog(h).includes('Held:'))
    expect(helperLog(h)).toContain('no answer in 2 minutes to Idle: the prompt stays held; band: Held: sending now costs about $0.16 more than a warm cache. Answer to go on.')
    expect(settled, 'still waiting for the answer').toBe(false)
    expect(h.submitted.length, 'not sent').toBe(sent)
    release()
    const out = await pending
    expect(out.drop).toContain('rightsize held this prompt')
    expect(h.submitted.length).toBe(sent)
    expect(await bandText($, surface), 'the band clears').toBe('')
  })

  test(`a helper whose task has no retry left goes back without a question (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-fable-5-1', effort: 'high', store: { remember: true, choices: { down: 'auto' } } })
    const d = drive($, h)
    await d.start(surface)
    await warm(d, h)
    h.rating = HAND_OFF()
    await startHelper(d, h, 't1', 'helper')
    // Two rework rounds from the main chat use both of the task's chances.
    await d.send()
    await d.send()
    await d.bash('fail a', 'agent-helper')
    await d.bash('fail a', 'agent-helper')
    await d.step('t1', 1, 'agent-helper')
    expect(h.asked.length, 'nothing to ask about').toBe(0)
    expect(((await d.bash('ls', 'agent-helper')) as { deny?: string }).deny).toContain('stuck')
    await d.complete('t1')
  })

  test(`Raising set to never leaves a struggling helper alone: not raised, not sent back (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-fable-5-1', effort: 'high', store: { remember: true, choices: { down: 'auto', raise: 'never' } } })
    const d = drive($, h)
    await d.start(surface)
    await warm(d, h)
    h.rating = HAND_OFF()
    await startHelper(d, h, 't1', 'helper')
    await d.bash('fail a', 'agent-helper')
    await d.bash('fail a', 'agent-helper')
    await d.step('t1', 1, 'agent-helper')
    expect(last(h.sent)?.effort).toBe('low')
    expect(((await d.bash('ls', 'agent-helper')) as { deny?: string }).deny, 'left alone').toBeUndefined()
  })

  test(`a failing test run in a helper is not an error of the work, and needs one more repeat (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-fable-5-1', effort: 'high', store: HELPERS })
    const d = drive($, h)
    await d.start(surface)
    await warm(d, h)
    h.rating = HAND_OFF()
    await startHelper(d, h, 't1', 'helper')
    for (let i = 0; i < 2; i++) await d.bash('npm test --red', 'agent-helper')
    // Other test runs failing do not add up to "several tool calls failed" either.
    await d.bash('pytest -x --red', 'agent-helper')
    await d.bash('cargo test --red', 'agent-helper')
    await d.step('t1', 1, 'agent-helper')
    expect(last(h.sent)?.effort, 'red test runs: expected reds, not struggling').toBe('low')
    await d.bash('npm test --red', 'agent-helper')
    await d.step('t1', 2, 'agent-helper')
    expect(last(h.sent)?.effort, 'the same one a third time: stuck').toBe('medium')
    expect(helperLog(h)).toContain('the same test run failed 3 times')
    await d.complete('t1')
  })

  test(`a failing test run in the main chat is not an error of the work either (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: AUTO_RAISE })
    const d = drive($, h)
    await d.start(surface)
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    await d.step('m1', 0)
    for (let i = 0; i < 2; i++) await d.bash('npm test --red')
    await d.bash('pytest --red')
    await d.bash('go test --red')
    await d.step('m1', 1)
    expect(last(h.sent)?.effort, 'four red test runs: not four errors').toBe('medium')
    await d.bash('npm test --red')
    await d.step('m1', 2)
    expect(last(h.sent)?.effort, 'the same one a third time').toBe('high')
  })

  test(`the main chat's rework of a hand-off uses the task's chances, and is refused once they are used up (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-fable-5-1', effort: 'high', store: HELPERS })
    const d = drive($, h)
    await d.start(surface)
    await warm(d, h)
    h.rating = HAND_OFF()
    await startHelper(d, h, 't1', 'helper')
    expect(((await d.agent('haiku')) as { deny?: string }).deny, 'a second subagent on its model: rework, one chance').toBeUndefined()
    expect(((await d.send()) as { deny?: string }).deny, 'a message to the subagent: rework, the second chance').toBeUndefined()
    const refused = (await d.send()) as { deny?: string }
    expect(refused.deny).toContain('retry budget is used up')
    expect(refused.deny).toContain('Finish the task yourself')
    expect(((await d.agent('haiku')) as { deny?: string }).deny, 'a third subagent too').toContain('retry budget is used up')
    expect(helperLog(h)).toContain("rework refused: the task's retry budget is used up")
    // A helper's raise would find no chance left either.
    await d.bash('fail a', 'agent-helper')
    await d.bash('fail a', 'agent-helper')
    await d.step('t1', 1, 'agent-helper')
    expect(((await d.bash('ls', 'agent-helper')) as { deny?: string }).deny, 'sent back').toContain('stuck')
    await d.complete('t1')
    expect((readRuns(h).find(l => l.kind === 'run') as { retries?: number }).retries).toBe(2)
  })

  test(`a follow-up shares its task's retry budget; a new task starts a fresh one (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-fable-5-1', effort: 'high', store: HELPERS })
    const d = drive($, h)
    await d.start(surface)
    await warm(d, h)
    h.rating = HAND_OFF()
    await startHelper(d, h, 't1', 'helper')
    await d.bash('fail a', 'agent-helper')
    await d.bash('fail a', 'agent-helper')
    await d.step('t1', 1, 'agent-helper')
    expect(last(h.sent)?.effort, 'a raise: one chance used').toBe('medium')
    await d.complete('t1')

    // The follow-up continues the task: one chance left, then none.
    h.rating = HAND_OFF(true)
    await d.submit(FOLLOW_UP)
    await d.step('t2', 0)
    await d.agent('haiku')
    expect(((await d.send()) as { deny?: string }).deny, 'the second chance').toBeUndefined()
    expect(((await d.send()) as { deny?: string }).deny, 'none left').toContain('retry budget is used up')
    await d.complete('t2')

    // A new goal is a new task.
    h.rating = HAND_OFF(false)
    await d.submit('now list every call site of the new logger across the repo')
    await d.step('t3', 0)
    await d.agent('haiku')
    expect(((await d.send()) as { deny?: string }).deny, 'a fresh budget').toBeUndefined()
    await d.complete('t3')

    const runs = readRuns(h).filter(l => l.kind === 'run')
    expect(runs.map(r => r.retries)).toEqual([1, 2, 1])
    expect(runs[1]?.task, 'one task').toBe(runs[0]?.task)
    expect(runs[2]?.task, 'another').not.toBe(runs[0]?.task)
  })

  test(`a moved subagent is watched too: raised from the budget, and its own line carries what the watch saw (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: AUTO_RAISE })
    const d = drive($, h)
    await d.start(surface)
    h.rating = NO_CHANGE
    await d.submit(SEARCH)
    await d.step('t1', 0)
    h.rating = LISTING
    await d.spawn('lister')
    h.now += 1000
    await d.step('l1', 0, 'agent-lister')
    expect(last(h.sent)?.effort).toBe('low')
    await d.bash('fail make', 'agent-lister')
    await d.bash('fail make', 'agent-lister')
    h.now += 4000
    await d.step('l1', 1, 'agent-lister')
    expect(last(h.sent)?.effort, 'raised one level').toBe('medium')
    expect(helperLog(h)).toContain('raised helper agent-lister low → medium at step 2')
    await d.step('l1', 2, 'agent-lister')
    expect(last(h.sent)?.effort).toBe('medium')
    await d.answer('agent-lister')
    await d.complete('t1')
    const runs = readRuns(h)
    const sub = runs.find(l => l.kind === 'subagent') as Record<string, unknown>
    expect([sub.steps, sub.ms, sub.errors, sub.blocked, sub.stall, sub.raises]).toEqual([3, 5000, 2, 0, 'struggling', [{ step: 2, from: 'low', to: 'medium', why: 'the same tool call failed twice' }]])
    expect('returned' in sub).toBe(false)
    const run = runs.find(l => l.kind === 'run') as { helpers?: HelperEntry[]; retries?: number }
    expect(run.helpers?.map(x => [x.agent, x.kind, x.steps, x.ms])).toEqual([['agent-lister', 'moved', 3, 5000]])
    expect(run.retries).toBe(1)
  })

  test(`a new session starts with a fresh retry budget and no helpers watched (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-fable-5-1', effort: 'high', store: HELPERS })
    const d = drive($, h)
    await d.start(surface)
    await warm(d, h)
    h.rating = HAND_OFF()
    await startHelper(d, h, 't1', 'helper')
    await d.agent('haiku')
    await d.send()
    await d.send()
    expect(((await d.send()) as { deny?: string }).deny).toContain('retry budget is used up')
    await d.complete('t1')
    await d.start(surface)
    await warm(d, h)
    h.rating = HAND_OFF()
    await startHelper(d, h, 't2', 'helper')
    expect(((await d.send()) as { deny?: string }).deny, 'a fresh budget').toBeUndefined()
  })

  // ---- Every prompt is rated, with the whole request and the task in progress ----

  const LONG = (head: string) => `${head} ${'and the details go on. '.repeat(320)}but only in src/`
  const unsureOf = (h: ReturnType<typeof engine>) => readRuns(h).filter(l => l.kind === 'run').map(l => l.unsure ?? null)

  test(`every prompt is rated as entered: two words, and 150 words with brain-dump on (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS })
    h.files['/home/test/.claude/mods/switches.json'] = '{"brain-dump": true}'
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = NO_CHANGE
    await d.submit('yes go')
    expect(h.ratings, 'a two-word prompt is rated').toBe(1)
    await d.submit(Array.from({ length: 150 }, (_, i) => `word${i}`).join(' '))
    expect(h.ratings, 'a 150-word prompt is rated though brain-dump is on').toBe(2)
    expect(h.completions, 'one rater call each').toEqual(['sonnet', 'sonnet'])
  })

  test(`a request that is cut is not lowered, and its run line says unsure: cut (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = LOWER
    h.answers = { Lowering: 'Lower automatically (Recommended)', Remember: 'Just this session' }
    await d.submit(LOOKUP)
    await d.step('t1')
    expect(last(h.sent)?.effort, 'the same rating lowers a request that is whole').toBe('low')
    await d.complete('t1')

    const request = LONG(LOOKUP)
    expect(request.length).toBeGreaterThan(6000)
    await d.submit(request)
    const shown = last(h.ratingPrompts) ?? ''
    expect(shown, 'the rater sees the start, a marked cut and the end').toContain(`<request>\n${request.slice(0, 4000)}\n[… ${request.length - 6000} characters cut …]\n`)
    expect(shown.endsWith('but only in src/\n</request>')).toBe(true)
    await d.step('t2')
    expect(last(h.sent)?.effort, 'not lowered: the rater did not see all of it').toBe('medium')
    expect(h.files[LOG_PATH] ?? '').toContain('no downgrade: context cut')
    expect(h.asked.map(a => a.header), 'and Lowering is not asked again').toEqual(['Lowering', 'Remember'])
    await d.complete('t2')
    expect(unsureOf(h)).toEqual([null, 'cut'])
  })

  test(`a task whose last reply is missing is not lowered, but a raise still happens (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.answers = { Lowering: 'Lower automatically (Recommended)', Raising: 'Raise automatically (Recommended)', Remember: 'Just this session' }
    // No task yet, so no reply is missing: the first prompt of a session is lowered as ever.
    h.messages = []
    h.rating = LOWER
    await d.submit(LOOKUP)
    await d.step('t1')
    expect(last(h.sent)?.effort).toBe('low')
    await d.complete('t1')

    // A task is in progress and the conversation holds no reply from Claude.
    await d.submit(LOOKUP)
    await d.step('t2')
    expect(last(h.sent)?.effort, 'no reply to read: not lowered').toBe('medium')
    expect(h.files[LOG_PATH] ?? '').toContain('no downgrade: context missing')
    await d.complete('t2')

    // The conversation cannot be read at all.
    h.messagesFail = true
    await d.submit(LOOKUP)
    await d.step('t3')
    expect(last(h.sent)?.effort, 'unreadable: not lowered').toBe('medium')
    await d.complete('t3')

    // A raise is not held back.
    h.rating = '{"level":"high","model":"same","type":"debug","read":20000,"write":3000,"steps":8,"reason":"unknown cause"}'
    await d.submit(DEBUG)
    await d.step('t4')
    expect(last(h.sent)?.effort, 'raised').toBe('high')
    await d.complete('t4')
    expect(unsureOf(h)).toEqual([null, 'missing', 'missing', 'missing'])
  })

  test(`a cut request is not handed to a cheaper model (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-fable-5-1', effort: 'high', store: HELPERS })
    const d = drive($, h)
    await d.start(surface)
    await warm(d, h)
    h.rating = HAND_OFF()
    await d.submit(SEARCH)
    expect(last(h.submitted)?.context?.length, 'a whole request is handed down').toBe(1)
    await d.step('t1')
    await d.complete('t1')

    await d.submit(LONG(SEARCH))
    expect(last(h.submitted)?.context ?? [], 'a cut one stays in the main chat').toEqual([])
    expect(helperLog(h)).toContain('no downgrade: context cut')
    await d.step('t2')
    await d.complete('t2')
    expect(unsureOf(h)).toEqual([null, 'cut'])
    expect(readRuns(h).filter(l => l.kind === 'run').map(l => [l.change, l.offered])).toEqual([['delegate-down', 'delegate-down'], ['none', 'none']])
  })

  test(`a run line carries the learning note, and the real hand-off is still made (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    // The step exponent is stored under 'step-exponent-v1' (steps.ts state, register.tsx STEP_STORE).
    const h = engine(on, { model: 'claude-fable-5-1', effort: 'high', store: { ...HELPERS, 'step-exponent-v1': { g: -0.4, since: 0, samples: [] } } })
    const d = drive($, h)
    await d.start(surface)
    await warm(d, h)
    h.rating = HAND_OFF()
    await d.submit(SEARCH)
    expect(last(h.submitted)?.context?.length, 'a whole request is handed down, as without learning mode').toBe(1)
    await d.step('t1')
    await d.complete('t1')
    const run = readRuns(h).find(l => l.kind === 'run')
    expect(run?.change, 'the decision is unchanged').toBe('delegate-down')
    const note = run?.learning as { g: number; plan: string; differs: boolean; applied: boolean } | undefined
    expect(note?.g, 'the learned exponent is logged').toBe(-0.4)
    expect(note?.applied, 'a fresh exponent is not applied yet').toBe(false)
    expect(typeof note?.plan, 'the learning plan is labelled').toBe('string')
    expect(note?.differs, 'differs is whether the labels differ').toBe(note?.plan !== 'delegate-down:haiku')
  })

  test(`a promotion of the step exponent rebases calibration once, and the state is stored (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    // 49 scores where g beats the plain estimate, steady refits and a typical shrink of 16 ** -0.2: the 50th score promotes it.
    const scores = Array.from({ length: 49 }, () => ({ inc: 0.6, cand: 0.3, flip: false, unjust: false }))
    const samples = Array.from({ length: 10 }, () => ({ ls: Math.log(16), lr: 0 }))
    const state = { g: -0.2, since: 0, samples, scores, gs: [-0.2, -0.2, -0.2], applied: false }
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { 'step-exponent-v1': state, [CAL_STORE]: { ...FREE_SWITCHES, 'writing:main': { n: 30, ratio: 1 } } } })
    const d = drive($, h)
    await d.start(surface)
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    await d.step('t1')
    await d.complete('t1')
    const stored = h.store['step-exponent-v1'] as { applied: boolean; appliedAt?: number }
    expect(stored.applied, 'the exponent is applied once it has proven itself').toBe(true)
    const ratio = (h.store[CAL_STORE] as Record<string, { n: number; ratio: number }>)['writing:main']?.ratio ?? 0
    const once = 1 / 16 ** -0.2
    expect(Math.abs(ratio - once) < 0.01, `calibration is rebased once (${once.toFixed(2)}), not twice`).toBe(true)
    expect(h.files[LOG_PATH] ?? '').toContain('step estimates applied')
  })

  test(`the rater is told how the task began and how many prompts it has had (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-sonnet-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    const first = `add a dark mode toggle to the settings page ${'and keep it in step with the OS theme. '.repeat(20)}`
    expect(first.length).toBeGreaterThan(600)

    h.rating = rated('feature', false)
    await d.submit(first)
    expect(h.ratingPrompts[0], 'no task yet').not.toContain('<task>')

    h.rating = rated('feature', true)
    await d.submit(FOLLOW_UP)
    expect(h.ratingPrompts[1]).toContain(`<task>\nTask in progress: feature, 1 prompt so far. It started with:\n${first.trim().slice(0, 600)}\n</task>\n\n<last_reply>\nDone: the change is in.\n</last_reply>\n\n<request>\n${FOLLOW_UP}\n</request>`)
    expect(h.ratingPrompts[1], 'the brief stops at 600 characters').not.toContain(first.trim().slice(0, 601))

    await d.submit(FOLLOW_UP)
    expect(h.ratingPrompts[2], 'a continuing prompt counts').toContain('Task in progress: feature, 2 prompts so far.')

    // A prompt that could not be rated counts too.
    h.ratingQueue = ['unavailable', 'unavailable']
    await d.submit(FOLLOW_UP)
    h.rating = rated('feature', true)
    await d.submit(FOLLOW_UP)
    expect(last(h.ratingPrompts)).toContain('Task in progress: feature, 4 prompts so far.')

    // A new goal starts a task of its own: one prompt, and its own brief.
    h.rating = rated('lookup', false)
    await d.submit(LOOKUP)
    h.rating = rated('lookup', true)
    await d.submit(FOLLOW_UP)
    expect(last(h.ratingPrompts)).toContain(`Task in progress: lookup, 1 prompt so far. It started with:\n${LOOKUP}\n</task>`)
  })


  // ---- Logs: one folder per session, read together ----------------------------------
  const MIN_MS = 60_000
  /** A rated prompt for the start check's replay: the fields isRated wants. */
  const easyLine = (at: number, tier: string) =>
    JSON.stringify({ at: new Date(at).toISOString(), kind: 'run', session: 'x', type: 'feature', route: 'main', tier, level: 'medium', normal: 'medium', fit: { haiku: null, sonnet: 'medium', opus: 'low', fable: 'low' }, read: 8000, write: 2000, steps: 8, context: 60_000, actual: 0.1, stay: 0.1, taken: 0.1, change: 'none', offered: 'none' })
  const FILES = (h: ReturnType<typeof engine>) => Object.keys(h.files).sort()
  /** A rating call that costs something, so a dropped or unbound prompt has overhead to count. */
  const PAID = { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

  test(`every log is written in the session's own folder, files 600 and folders 700, and the old shared files are never written (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES } })
    const legacy = `${easyLine(h.now - 3 * DAY, 'opus')}\n`
    h.files[LEGACY_RUNS] = legacy
    h.files[LEGACY_SWITCHES] = `${JSON.stringify({ at: new Date(h.now - 3 * DAY).toISOString(), kept: true })}\n`
    const d = drive($, h)
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')
    h.rating = LOWER
    h.answers = { Lowering: 'Lower automatically (Recommended)', Remember: 'Just this session' }
    await d.submit(LOOKUP)
    await d.step('t1', 0)
    await d.step('t1', 1)
    await d.complete('t1')
    await d.submit(LOOKUP)
    await d.step('t2')
    await d.complete('t2')
    expect(FILES(h), 'only this session writes, in its own folder').toEqual([LEGACY_RUNS, LEGACY_SWITCHES, LOG_PATH, RUNS_FILE, SWITCHES_FILE].sort())
    expect(h.files[LEGACY_RUNS], 'the old runs file is read, never written').toBe(legacy)
    expect(h.files[LEGACY_SWITCHES]?.trim().split('\n').length).toBe(1)
    expect(h.ran).toContainEqual(['mkdir', '-m', '700', '-p', SESSION_DIR])
    expect(h.ran).toContainEqual(['chmod', '700', LOGS, `${LOGS}/rightsize`, SESSION_DIR])
    for (const file of [RUNS_FILE, SWITCHES_FILE, LOG_PATH]) expect(h.ran, file).toContainEqual(['chmod', '600', file])
    expect(h.ran.filter(a => a[0] === 'chmod' && a[1] === '600').length, 'each new file is made readable by you alone once').toBe(3)
    expect(readRuns(h).map(l => l.kind)).toEqual(['run', 'run'])
  })

  for (const [id, folder] of [['../../etc/x y', '______etc_x_y'], ['', 'unknown']] as const) {
    test(`session id ${JSON.stringify(id)} writes its logs under ${folder} (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
      const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
      h.sessionId = id
      const d = drive($, h)
      await d.start(surface)
      h.rating = NO_CHANGE
      await d.submit(LOOKUP)
      await d.step('t1')
      await d.complete('t1')
      expect(FILES(h).length).toBeGreaterThan(0)
      expect(FILES(h).every(f => f.startsWith(`${LOGS}/rightsize/${folder}/`)), `files: ${FILES(h).join(' ')}`).toBe(true)
    })
  }

  test(`the report reads every session's folder and the old shared file together, in time order, and one unreadable file loses nothing (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    // The newest 60 prompts are in the old file, on Opus; an older Sonnet one and a newer Opus one are in two session folders.
    // Read in file order the last prompt would be Sonnet's (a folder comes after the old file), and the start would not be Opus.
    h.files[LEGACY_RUNS] = easyLog(h.now)
    h.files[`${LOGS}/rightsize/aaa/runs.jsonl`] = `${easyLine(h.now - 3 * DAY, 'sonnet')}\n`
    h.files[`${LOGS}/rightsize/zzz/runs.jsonl`] = `${easyLine(h.now - 2 * DAY, 'opus')}\n`
    h.files[`${LOGS}/rightsize/torn/runs.jsonl`] = `not json at all\n{"at":"2026-01-01T00:00:00.000Z","kind":"ru`
    h.files[`${LOGS}/rightsize/torn/rightsize.log`] = 'text that is not a run log\n'
    h.files[LEGACY_SWITCHES] = `${JSON.stringify({ at: new Date(h.now - DAY).toISOString(), kept: false })}\n`
    h.files[`${LOGS}/rightsize/zzz/switches.jsonl`] = `${JSON.stringify({ at: new Date(h.now - 2 * DAY).toISOString(), kept: false })}\n`
    const d = drive($, h)
    await d.start(surface)
    const report = String((await d.command('report')).text)
    expect(cellsOf(report, 'Prompts rated')?.slice(1), 'all three sources, 60 + 1 + 1').toEqual(['62', '62'])
    expect(report, 'the newest prompt is Opus, so Opus is the start').toContain('STARTING POINT  Opus at medium, 62 rated prompts in 30 days')
    expect(report, 'effort switches from both places').toMatch(/2 switches\s+missed the cache, of 2 effort switches/)
  })

  test(`two writes to one file in the same moment both land (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    h.rating = NO_CHANGE
    await Promise.all([d.submit(LOOKUP), d.submit(`${LOOKUP} in src/other.ts`)])
    const rated = (h.files[LOG_PATH] ?? '').split('\n').filter(l => l.includes(': rated '))
    expect(rated.length, 'both decisions are in the log').toBe(2)
    // The two turns end together as well: a turn's line and a later one's go to the same file.
    await d.turnStart('t1', LOOKUP)
    await d.step('t1')
    await d.complete('t1')
    await d.turnStart('t2', `${LOOKUP} in src/other.ts`)
    await d.step('t2')
    await Promise.all([d.complete('t2'), d.submit(`${DEBUG} again`)])
    expect(readRuns(h).filter(l => l.kind === 'run').map(l => l.turnId), 'and both turns are in the run log').toEqual(['t1', 't2'])
  })

  // ---- Prompts and turns: a queue, bound by text ------------------------------------

  test(`a prompt another plugin rewrote is still bound to its turn: the turn that starts while it enters (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    h.rating = NO_CHANGE
    h.duringSubmit = () => d.turnStart('t1', `THE JOB: ${LOOKUP}`)
    await d.submit(LOOKUP)
    await d.step('t1')
    await d.complete('t1')
    expect(readRuns(h).filter(l => l.kind === 'run').map(l => l.turnId), 'bound to its turn').toEqual(['t1'])
    expect(readRuns(h).some(l => l.kind === 'unbound'), 'not left in line').toBe(false)
  })

  test(`prompts typed during a running turn wait in line and each runs its own turn, bound by its text, with its own rating and turn id (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-sonnet-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    await d.start(surface)
    h.rating = rated('feature', false)
    await d.submit('add a dark mode toggle to the settings page')
    await d.turnStart('t1', 'add a dark mode toggle to the settings page')
    await d.step('t1')
    // Two more while t1 runs: each is rated as it is typed.
    h.rating = rated('lookup', false)
    await d.submit(LOOKUP, 't1')
    h.rating = rated('debug', false)
    await d.submit(DEBUG, 't1')
    await d.complete('t1')
    await d.turnStart('t2', `  ${LOOKUP}\n`)
    await d.step('t2')
    await d.complete('t2')
    await d.turnStart('t3', DEBUG)
    await d.step('t3')
    await d.complete('t3')
    const runs = readRuns(h)
    expect(runs.map(l => l.kind), 'three runs, nothing unbound').toEqual(['run', 'run', 'run'])
    expect(runs.map(l => [l.turnId, l.type, l.queued]), 'each is in its own turn, and the typed-over two say so').toEqual([['t1', 'feature', undefined], ['t2', 'lookup', true], ['t3', 'debug', true]])
    expect(new Set(runs.map(l => l.id)).size, 'three ids').toBe(3)
    expect(new Set(runs.map(l => l.task)).size, 'and three tasks').toBe(3)
  })

  test(`a prompt that never started is logged unbound at the next idle prompt and never takes another prompt's turn (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    h.ratingUsage = PAID
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    // Cancelled before its turn started: no turn.start for it. The session is idle when the next one is typed.
    await d.submit(DEBUG)
    await d.turnStart('t1', DEBUG)
    await d.step('t1')
    await d.complete('t1')
    const runs = readRuns(h)
    expect(runs.map(l => l.kind)).toEqual(['unbound', 'run'])
    expect(runs[0]).toMatchObject({ kind: 'unbound', reason: 'cancelled before its turn started' })
    expect(Number(runs[0]?.overhead), 'its rating call is still counted').toBeGreaterThan(0)
    expect(runs[1], 'the run in turn t1 is the prompt that started it').toMatchObject({ turnId: 't1' })
    expect(runs[1]?.id).not.toBe(runs[0]?.id)
    expect(runs[1]?.queued, 'typed while idle').toBeUndefined()
    expect(cellsOf(String((await d.command('report')).text), 'Prompts rated')?.[0], 'one rated run in this session: the unbound prompt is not one').toBe('1')
  })

  test(`a prompt delivered into the running turn is logged unbound when the next turn starts for other text, and does not attach to it (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    h.ratingUsage = PAID
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    await d.turnStart('t1', LOOKUP)
    await d.step('t1')
    // The engine hands this one to the model inside t1: no turn will ever start for it.
    await d.submit(DEBUG, 't1')
    await d.complete('t1')
    // A continuation says nothing about the line.
    await d.turnStart('t2', '')
    await d.step('t2')
    await d.complete('t2')
    expect(readRuns(h).map(l => l.kind), 'still waiting after a continuation').toEqual(['run'])
    // The next turn starts for other text: the prompt was read by t1.
    await d.turnStart('t3', 'a background task finished')
    await d.step('t3')
    await d.complete('t3')
    const runs = readRuns(h)
    expect(runs.map(l => l.kind)).toEqual(['run', 'unbound'])
    expect(runs[1]).toMatchObject({ kind: 'unbound', reason: 'delivered into the running turn' })
    expect(Number(runs[1]?.overhead)).toBeGreaterThan(0)
    expect(runs.filter(l => l.kind === 'run').map(l => l.turnId), 'nothing ran in t2 or t3 as a rated prompt').toEqual(['t1'])
  })

  test(`a prompt delivered into the running turn is logged unbound when the session goes idle and the next prompt is typed (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    await d.turnStart('t1', LOOKUP)
    await d.step('t1')
    await d.submit(DEBUG, 't1')
    await d.complete('t1')
    await d.submit(SEARCH)
    await d.turnStart('t2', SEARCH)
    await d.step('t2')
    await d.complete('t2')
    const runs = readRuns(h)
    expect(runs.map(l => [l.kind, l.turnId ?? l.reason])).toEqual([['run', 't1'], ['unbound', 'delivered into the running turn'], ['run', 't2']])
  })

  test(`a prompt that something beneath refuses is logged dropped with its rating cost, its own state is undone, and it does not attach to the next turn (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-sonnet-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    await d.start(surface)
    h.ratingUsage = PAID
    h.rating = LOWER
    h.answers = { Lowering: 'Lower automatically (Recommended)', Remember: 'Just this session' }
    h.dropNext = 'a hook refused it'
    const out = (await d.submit(LOOKUP)) as { drop?: string }
    expect(out.drop, 'the refusal is passed up as it came').toBe('a hook refused it')
    expect(await bandText($, surface), 'the band it set is gone').toBe('')
    const undo = await d.command('retry')
    expect(undo.text ?? '', 'nothing of it is left to retry').toContain('Nothing to retry')
    const runs = readRuns(h)
    expect(runs.map(l => l.kind)).toEqual(['dropped'])
    expect(runs[0]).toMatchObject({ kind: 'dropped', reason: 'a hook refused it', session: 'sess-1' })
    expect(Number(runs[0]?.overhead)).toBeGreaterThan(0)
    expect(h.files[LOG_PATH] ?? '').toContain('prompt dropped (a hook refused it)')

    // The next prompt starts its own task (the dropped one never began one), and its turn is its own.
    h.rating = rated('lookup', true)
    await d.submit(FOLLOW_UP)
    expect(last(h.ratingPrompts), 'the dropped prompt began no task to continue').not.toContain('<task>')
    await d.turnStart('t1', FOLLOW_UP)
    await d.step('t1')
    await d.complete('t1')
    const after = readRuns(h)
    expect(after.map(l => l.kind)).toEqual(['dropped', 'run'])
    expect(after[1]?.turnId).toBe('t1')
    expect(after[1]?.id, 'its own run').not.toBe(after[0]?.id)
    expect(after[1]?.overhead, "its own rating call's cost, not the dropped one's").toBe(after[0]?.overhead)
  })

  test(`a session switch the person answered for a dropped prompt stays (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    await d.start(surface)
    h.rating = '{"level":"high","model":"same","type":"debug","read":20000,"write":3000,"steps":8,"reason":"unknown cause"}'
    h.answers = { Raising: 'Ask me each time', Effort: 'Raise for this session', Remember: 'Just this session' }
    h.dropNext = 'refused'
    await d.submit(DEBUG)
    expect(readRuns(h).map(l => l.kind)).toEqual(['dropped'])
    expect(((await d.command('status'))).text ?? '', 'the answer was the person\'s').toContain('Session switch: high')
  })

  test(`a session start clears the line without logging it (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const d = drive($, h)
    await d.start(surface)
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    await d.start(surface)
    await d.submit(DEBUG)
    await d.turnStart('t1', DEBUG)
    await d.step('t1')
    await d.complete('t1')
    expect(readRuns(h).map(l => l.kind), 'the earlier session start left no line for the waiting prompt').toEqual(['run'])
    expect(readRuns(h)[0]?.turnId).toBe('t1')
  })

  // ---- Pruning ----------------------------------------------------------------------

  test(`a session start removes the folders of sessions that last wrote over 45 days ago, and only those (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    const at = (days: number) => h.now - days * DAY
    const put = (path: string, days: number) => {
      h.files[path] = `${JSON.stringify({ at: new Date(at(days)).toISOString(), kind: 'run' })}\n`
      h.mtimes[path] = at(days)
    }
    const R = `${LOGS}/rightsize`
    put(`${R}/old-one/runs.jsonl`, 46)
    put(`${R}/old-one/rightsize.log`, 60)
    put(`${R}/fresh/runs.jsonl`, 1)
    put(`${R}/fresh/rightsize.log`, 50)
    // One file written lately keeps the folder, however old the others are.
    put(`${R}/mixed/runs.jsonl`, 90)
    put(`${R}/mixed/switches.jsonl`, 44)
    // This session's own folder, though everything in it is old (a resumed session).
    put(RUNS_FILE, 100)
    // Not session folders at all: the old shared files, and a name that is not a plain one.
    put(LEGACY_RUNS, 100)
    put(LEGACY_SWITCHES, 100)
    put(`${R}/odd name/runs.jsonl`, 100)
    const d = drive($, h)
    await d.start(surface)
    await flush()
    expect(FILES(h).filter(f => f.includes('old-one')), 'the old folder is emptied').toEqual([])
    expect(h.ran).toContainEqual(['rm', '-f', `${R}/old-one/runs.jsonl`])
    expect(h.ran).toContainEqual(['rm', '-f', `${R}/old-one/rightsize.log`])
    expect(h.ran).toContainEqual(['rmdir', `${R}/old-one`])
    for (const kept of [`${R}/fresh/runs.jsonl`, `${R}/fresh/rightsize.log`, `${R}/mixed/runs.jsonl`, `${R}/mixed/switches.jsonl`, RUNS_FILE, LEGACY_RUNS, LEGACY_SWITCHES, `${R}/odd name/runs.jsonl`]) expect(h.files[kept], kept).toBeDefined()
    const removing = h.ran.filter(a => a[0] === 'rm' || a[0] === 'rmdir')
    expect(removing.length, 'two files and the folder, nothing else').toBe(3)
    expect(removing.every(a => a[a.length - 1]?.startsWith(`${R}/old-one`)), 'only paths inside the one old folder').toBe(true)
  })

  test(`a failing clean-up never stops the session from starting (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    h.files[`${LOGS}/rightsize/old-one/runs.jsonl`] = '{"at":"2026-01-01T00:00:00.000Z","kind":"run"}\n'
    h.mtimes[`${LOGS}/rightsize/old-one/runs.jsonl`] = h.now - 90 * DAY
    h.rmFails = true
    const d = drive($, h)
    await d.start(surface)
    await flush()
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    await d.step('t1')
    await d.complete('t1')
    expect(readRuns(h).map(l => l.kind), 'logging goes on').toEqual(['run'])
  })


  // ---- Profiles: Quality, Balanced and Economy supply defaults; your own setting wins ----------------------------

  const PROFILE_NAMES = ['Quality', 'Balanced', 'Economy'] as const
  /** Cheaper model: send automatically, so the first option of the question (which differs by profile) never has to be answered. */
  const SEND = { [CAL_STORE]: FREE_SWITCHES, remember: true, choices: { down: 'auto' } }
  /** Opts a session into a profile the way /config does: declared at load, and stored. */
  const inProfile = (profile: string, more: Record<string, string> = {}) => ({ options: { profile, ...more }, stored: { profile, ...more } })
  /** Hand-downs to Haiku for `search` work, `n` outcomes of which `missed` needed rework: what a profile's evidence rule counts. */
  const haikuLog = (h: { now: number }, n: number, missed = 0) =>
    Array.from({ length: n }, (_, i) =>
      JSON.stringify({ at: new Date(h.now - (n - i) * 60_000).toISOString(), kind: 'run', type: 'search', tier: 'opus', route: 'delegate:haiku', change: 'delegate-down', agentCalls: i < missed ? 2 : 1 }),
    ).join('\n') + '\n'
  /** One prompt rated as NEAR (Haiku at about 78% of staying on Opus): where the hand-off went. */
  const nearHandOff = async ($: unknown, h: ReturnType<typeof engine>, d: ReturnType<typeof drive>) => {
    await d.start(surface)
    h.rating = NEAR
    await d.submit(SEARCH)
    return handedTo(h)
  }

  test(`Profile is a row of /config, and /rightsize shows it on its first line (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS })
    const d = drive($, h)
    await d.start(surface)
    const text = await settingsText(d)
    expect(text.split('\n')[0], 'Balanced by default').toBe('Profile: Balanced')
    expect(text, 'what the profile applies').toContain('In use: hand-off threshold 70%, pause at 20% misses, rater check every 20, 2 chances per task')
    expect(disagree(h)).toBe(false)
    expect(text, 'the default is not listed as yours').not.toMatch(/^ {2}Profile:/m)
  })

  for (const profile of PROFILE_NAMES) {
    const { options, stored } = inProfile(profile)
    test(`${profile}: /rightsize shows it, and what it applies (${surface})`, { timeoutMs: 30000, options }, async ($, on) => {
      const h = engine(on, { ...OPUS, stored })
      const d = drive($, h)
      await d.start(surface)
      const text = await settingsText(d)
      expect(text.split('\n')[0]).toBe(`Profile: ${profile}`)
      const line = { Quality: 'hand-off threshold 50%, pause at 10% misses and 10 logged tasks, rater check every 10, 1 chance per task', Balanced: 'hand-off threshold 70%, pause at 20% misses, rater check every 20, 2 chances per task', Economy: 'hand-off threshold 85%, pause at 30% misses, rater check every 30, 3 chances per task' }[profile]
      expect(text).toContain(`In use: ${line}`)
    })
  }

  test(`a row you set shows as yours, and what is in use follows it, not the profile (${surface})`, { timeoutMs: 30000, options: inProfile('Quality', { handOff: '60%', raterCheck: 'every 100' }).options }, async ($, on) => {
    const h = engine(on, { ...OPUS, stored: inProfile('Quality', { handOff: '60%', raterCheck: 'every 100' }).stored })
    const d = drive($, h)
    await d.start(surface)
    const text = await settingsText(d)
    expect(text).toContain('Hand-off threshold: 60%')
    expect(text).toContain('Rater check: every 100')
    expect(text, 'Pause after misses is not yours: the profile still sets it').toContain('In use: hand-off threshold 60%, pause at 10% misses and 10 logged tasks, rater check every 100, 1 chance per task')
  })

  // The hand-off threshold: a cheaper route must cost under this share of staying (NEAR is 78%).
  for (const [profile, to] of [['Quality', undefined], ['Balanced', undefined], ['Economy', 'haiku']] as const) {
    test(`${profile} sets the hand-off threshold when the row is not yours: NEAR (78% of staying) goes to ${to ?? 'no one'} (${surface})`, { timeoutMs: 30000, options: inProfile(profile).options }, async ($, on) => {
      const h = engine(on, { ...OPUS, store: SEND, stored: inProfile(profile).stored })
      // Quality would need 10 logged tasks too: give it, so the threshold is what decides.
      h.files[RUNS] = haikuLog(h, 12)
      expect(await nearHandOff($, h, drive($, h))).toBe(to)
    })
  }

  test(`a Hand-off threshold you set wins over the profile, whichever way it differs (${surface})`, { timeoutMs: 30000, options: inProfile('Economy', { handOff: '60%' }).options }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: SEND, stored: inProfile('Economy', { handOff: '60%' }).stored })
    expect(await nearHandOff($, h, drive($, h)), 'Economy would have said 85%: the row says 60%').toBeUndefined()
  })

  test(`a Hand-off threshold of 80% set under Quality wins over its 50% (${surface})`, { timeoutMs: 30000, options: inProfile('Quality', { handOff: '80%' }).options }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: SEND, stored: inProfile('Quality', { handOff: '80%' }).stored })
    h.files[RUNS] = haikuLog(h, 12)
    expect(await nearHandOff($, h, drive($, h))).toBe('haiku')
  })

  // Quality's evidence rule: 10 tasks of that kind on that route, and under 10% misses. Search on Haiku has a research
  // prior worth 10 tasks at 0% misses; each logged task takes the place of one of them.
  for (const [what, n, missed, to] of [
    ['9 logged tasks, none missed: allowed, the research prior fills the tenth', 9, 0, 'haiku'],
    ['5 logged tasks, 2 missed (the first forgiven: 1 in 4, 10% with the prior): refused', 5, 2, undefined],
    ['10 logged tasks, none missed: allowed', 10, 0, 'haiku'],
    ['10 logged tasks, 2 missed (the first forgiven: 1 in 9, 10%): refused', 10, 2, undefined],
    ['11 logged tasks, 1 missed, forgiven: allowed', 11, 1, 'haiku'],
  ] as const) {
    test(`Quality, ${what} (${surface})`, { timeoutMs: 30000, options: inProfile('Quality', { handOff: '90%' }).options }, async ($, on) => {
      const h = engine(on, { ...OPUS, store: SEND, stored: inProfile('Quality', { handOff: '90%' }).stored })
      h.files[RUNS] = haikuLog(h, n, missed)
      expect(await nearHandOff($, h, drive($, h))).toBe(to)
    })
  }

  test(`Quality with nothing logged starts from the research prior: search work goes to Haiku (${surface})`, { timeoutMs: 30000, options: inProfile('Quality', { handOff: '90%' }).options }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: SEND, stored: inProfile('Quality', { handOff: '90%' }).stored })
    expect(await nearHandOff($, h, drive($, h))).toBe('haiku')
  })

  // The first automatic miss on a route is forgiven once, ever: 1 miss in 5 counts as 0 of 4, and the log says so.
  test(`Quality forgives the first miss on search: 1 miss in 5 still hands search to Haiku, and the log says so (${surface})`, { timeoutMs: 30000, options: inProfile('Quality', { handOff: '90%' }).options }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: SEND, stored: inProfile('Quality', { handOff: '90%' }).stored })
    h.files[RUNS] = haikuLog(h, 5, 1)
    expect(await nearHandOff($, h, drive($, h))).toBe('haiku')
    expect(h.files[LOG_PATH] ?? '', 'the log says the first miss was forgiven').toContain('forgave the first miss on search')
  })

  test(`a miss forgiven on a hand-off turn is shown on the band beside the hand-off's result (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-fable-5-1', effort: 'high', store: HELPERS })
    const d = drive($, h)
    // The log's times are the wall clock's: the 30-day window counts from now.
    h.now = Date.now()
    await d.start(surface)
    await warm(d, h)
    h.rating = HAND_OFF()
    await startHelper(d, h, 't1', 'helper')
    // The main chat starts a second subagent on Haiku: rework, so the hand-down was a miss.
    await d.agent('haiku')
    await d.complete('t1')
    const text = await bandText($, surface)
    expect(text, 'the hand-off result').toContain('Sent to Haiku')
    expect(text, 'and the forgiven miss').toContain('Haiku missed once on search work; that one is forgiven, and the next miss pauses it.')
    // The next prompt's band starts clean.
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    expect(await bandText($, surface)).not.toContain('missed once')
  })

  test(`every band ends with the session's running total once the session has rated prompts, and never carries it twice (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', store: { [CAL_STORE]: FREE_SWITCHES } })
    const d = drive($, h)
    h.now = Date.now()
    await d.start(surface)
    await d.step('t0')
    await d.complete('t0')

    // Prompts 1 and 2: fewer than SESSION_TOTAL_FROM (3) rated prompts, so no total on the band.
    h.rating = LOWER
    h.answers = { Lowering: 'Lower automatically (Recommended)', Remember: 'Just this session' }
    await d.submit(LOOKUP)
    expect(await bandText($, surface), 'prompt 1').not.toContain('Session:')
    await d.step('t1')
    await d.complete('t1')
    await d.submit(LOOKUP)
    expect(await bandText($, surface), 'prompt 2: still none').not.toContain('Session:')
    await d.step('t2')
    await d.complete('t2')
    // The 3rd rated prompt: its band ends with the total.
    // A third lowering, then a subagent of Claude's own moved to Haiku: the end-of-turn band is built from the third one's text.
    await d.submit(LOOKUP)
    expect(await bandText($, surface), 'prompt 3: the total').toMatch(/Effort lowered: medium → low for this prompt \(automatically\)\. Why: .+ Confidence: low\. Session: ~\$\d+\.\d\d saved$/)
    h.rating = '{"fit":{"haiku":"low","sonnet":"low","opus":"low","fable":"low"},"size":"small","type":"search","read":8000,"write":500,"steps":5,"reason":"list call sites"}'
    await d.step('t3', 0)
    await d.spawn('lister')
    await d.step('t3', 0, 'agent-lister')
    await d.complete('t3')
    const rebuilt = await bandText($, surface)
    expect(rebuilt, 'the earlier text and the new sentence are both there').toMatch(/Effort lowered.*Ran Claude's subagent on Haiku \(low\) instead of Opus\./)
    expect(rebuilt.match(/Session:/g), 'one total only').toHaveLength(1)
    expect(rebuilt, 'and it is last, with the figure as of now').toMatch(/ Session: ~\$\d+\.\d\d (saved|more)$/)
  })

  test(`Quality: 2 misses in 5 pauses search, the first of them forgiven (${surface})`, { timeoutMs: 30000, options: inProfile('Quality', { handOff: '90%' }).options }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: SEND, stored: inProfile('Quality', { handOff: '90%' }).stored })
    h.files[RUNS] = haikuLog(h, 5, 2)
    expect(await nearHandOff($, h, drive($, h))).toBeUndefined()
  })

  test(`Quality: a route that already used its forgiveness pauses on its first miss (${surface})`, { timeoutMs: 30000, options: inProfile('Quality', { handOff: '90%' }).options }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: { ...SEND, forgivenRoutes: ['search:haiku'] }, stored: inProfile('Quality', { handOff: '90%' }).stored })
    h.files[RUNS] = haikuLog(h, 5, 1)
    expect(await nearHandOff($, h, drive($, h))).toBeUndefined()
    expect(h.files[LOG_PATH] ?? '', 'nothing is forgiven again').not.toContain('forgave the first miss')
  })

  test(`Pause after misses you set replaces the whole evidence rule, Quality's 10 logged tasks too (${surface})`, { timeoutMs: 30000, options: inProfile('Quality', { handOff: '90%', missPause: '50%' }).options }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: SEND, stored: inProfile('Quality', { handOff: '90%', missPause: '50%' }).stored })
    expect(await nearHandOff($, h, drive($, h)), 'no tasks logged, and the row says 50%').toBe('haiku')
  })

  // The miss pause: Balanced pauses a kind of work at 20% misses, Economy at 30%. With 10 logged tasks the research
  // prior is gone. The first miss is forgiven, so 3 misses in 10 is 2 in 9: 20%.
  for (const [profile, to] of [['Balanced', undefined], ['Economy', 'haiku']] as const) {
    test(`${profile} at 20% misses hands off to ${to ?? 'no one'} (${surface})`, { timeoutMs: 30000, options: inProfile(profile, profile === 'Balanced' ? { handOff: '90%' } : {}).options }, async ($, on) => {
      const h = engine(on, { ...OPUS, store: SEND, stored: inProfile(profile, profile === 'Balanced' ? { handOff: '90%' } : {}).stored })
      h.files[RUNS] = haikuLog(h, 10, 3)
      expect(await nearHandOff($, h, drive($, h))).toBe(to)
    })
  }

  test(`Economy pauses at 30% misses: 4 in 10 (the first forgiven: 3 in 9) is paused, and early misses are softened by the prior (${surface})`, { timeoutMs: 30000, options: inProfile('Economy').options }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: SEND, stored: inProfile('Economy').stored })
    h.files[RUNS] = haikuLog(h, 10, 4)
    expect(await nearHandOff($, h, drive($, h))).toBeUndefined()
  })

  // The rater spot-check: the interval is the profile's unless Rater check is yours.
  for (const [profile, more, before, checked] of [
    ['Quality', {}, 9, true],
    ['Quality', {}, 8, false],
    ['Balanced', {}, 19, true],
    ['Balanced', {}, 18, false],
    ['Economy', {}, 29, true],
    ['Economy', {}, 19, false],
    ['Quality', { raterCheck: 'every 25' }, 9, false],
    ['Quality', { raterCheck: 'every 25' }, 24, true],
    ['Economy', { raterCheck: 'off' }, 29, false],
  ] as const) {
    const row = `${profile}${'raterCheck' in more ? ` with Rater check ${more.raterCheck}` : ''}`
    test(`${row}: the prompt after ${before} Haiku ratings ${checked ? 'is' : 'is not'} checked by Sonnet (${surface})`, { timeoutMs: 30000, options: inProfile(profile, { rater: 'haiku', ...more }).options }, async ($, on) => {
      const h = engine(on, { ...OPUS, store: { spotChecks: before }, stored: inProfile(profile, { rater: 'haiku', ...more }).stored })
      const d = drive($, h)
      h.now = Date.now()
      await d.start(surface)
      h.rating = FIT_NO
      await d.submit(LOOKUP)
      await flush()
      expect(h.completions.filter(m => m === 'sonnet').length).toBe(checked ? 1 : 0)
    })
  }

  // Chances: a task's retries. Quality 1, Balanced 2, Economy 3.
  test(`Quality gives a task one chance: the second struggle sends the helper back (${surface})`, { timeoutMs: 30000, options: inProfile('Quality').options }, async ($, on) => {
    const h = engine(on, { model: 'claude-fable-5-1', effort: 'high', store: HELPERS, stored: inProfile('Quality').stored })
    // Quality hands a task down only on evidence: 12 logged hand-downs to Haiku for search work, none missed.
    h.files[RUNS] = haikuLog(h, 12)
    const d = drive($, h)
    await d.start(surface)
    await warm(d, h)
    h.rating = HAND_OFF()
    await startHelper(d, h, 't1', 'helper')
    await d.bash('fail a', 'agent-helper')
    await d.bash('fail a', 'agent-helper')
    await d.step('t1', 1, 'agent-helper')
    expect(last(h.sent)?.effort, 'the one chance').toBe('medium')
    await d.bash('fail b', 'agent-helper')
    await d.step('t1', 2, 'agent-helper')
    expect(last(h.sent)?.effort, 'no second raise').toBe('medium')
    expect(helperLog(h)).toContain('and the task has no retry left')
    expect(((await d.bash('ls', 'agent-helper')) as { deny?: string }).deny, 'sent back').toContain('retry budget is used up')
    await d.complete('t1')
    expect((readRuns(h).find(l => l.kind === 'run') as { retries?: number }).retries).toBe(1)
  })

  test(`Economy gives a task three chances: a helper is raised three times before it is sent back (${surface})`, { timeoutMs: 30000, options: inProfile('Economy').options }, async ($, on) => {
    const h = engine(on, { model: 'claude-fable-5-1', effort: 'high', store: HELPERS, stored: inProfile('Economy').stored })
    const d = drive($, h)
    await d.start(surface)
    await warm(d, h)
    h.rating = HAND_OFF()
    await startHelper(d, h, 't1', 'helper')
    await d.bash('fail a', 'agent-helper')
    await d.bash('fail a', 'agent-helper')
    await d.step('t1', 1, 'agent-helper')
    expect(last(h.sent)?.effort, 'first chance').toBe('medium')
    await d.bash('fail b', 'agent-helper')
    await d.step('t1', 2, 'agent-helper')
    expect(last(h.sent)?.effort, 'second chance').toBe('high')
    for (let i = 0; i < 3; i++) await d.bash('ls', 'agent-helper')
    await d.step('t1', 3, 'agent-helper')
    expect(last(h.sent)?.effort, 'third chance').toBe('xhigh')
    expect(helperLog(h)).not.toContain('no retry left')
    await d.complete('t1')
    expect((readRuns(h).find(l => l.kind === 'run') as { retries?: number }).retries).toBe(3)
  })

  for (const [profile, rounds] of [['Quality', '1 rework round'], ['Balanced', '2 rework rounds'], ['Economy', '3 rework rounds']] as const) {
    test(`${profile}: the hand-off note allows ${rounds}, the task's chances (${surface})`, { timeoutMs: 30000, options: inProfile(profile, { handOff: '90%', missPause: '50%' }).options }, async ($, on) => {
      const h = engine(on, { ...OPUS, store: SEND, stored: inProfile(profile, { handOff: '90%', missPause: '50%' }).stored })
      expect(await nearHandOff($, h, drive($, h))).toBe('haiku')
      expect(noteOf(h)).toContain(`At most ${rounds}.`)
      expect(noteOf(h)).toContain(`still fails after ${rounds.replace(' round', '')}`)
    })
  }

  // The four questions: asked in every profile, once each; the profile only picks the first option, marked (Recommended).
  const FIRST = {
    Quality: ['Ask me each time (Recommended)', 'Raise automatically (Recommended)', 'Use the stronger model automatically (Recommended)', 'Ask before sending it (Recommended)'],
    Balanced: ['Lower automatically (Recommended)', 'Raise automatically (Recommended)', 'Use the stronger model automatically (Recommended)', 'Send it to a cheaper subagent (Recommended)'],
    Economy: ['Lower automatically (Recommended)', 'Raise automatically (Recommended)', 'Stay on Sonnet, raise effort only (Recommended)', 'Send it to a cheaper subagent (Recommended)'],
  } as const
  const ROWS_AFTER = {
    Quality: { lowerRule: 'ask me', raiseRule: 'raise automatically', upRule: 'always send', downRule: 'ask first' },
    Balanced: { lowerRule: 'lower automatically', raiseRule: 'raise automatically', upRule: 'always send', downRule: 'always send' },
    Economy: { lowerRule: 'lower automatically', raiseRule: 'raise automatically', upRule: 'stay, raise effort only', downRule: 'always send' },
  } as const
  for (const profile of PROFILE_NAMES) {
    test(`${profile}: each of the four questions lists its recommended answer first, and answering it sets the matching rule (${surface})`, { timeoutMs: 30000, options: inProfile(profile).options }, async ($, on) => {
      const h = engine(on, { model: 'claude-sonnet-5-5', effort: 'medium', stored: inProfile(profile).stored })
      const d = drive($, h)
      await d.start(surface)
      const [lower, raise, up, down] = FIRST[profile]
      h.answers = { Lowering: lower, Raising: raise, Stronger: up, Cheaper: down, ...YES_REMEMBER }
      await d.command('settings')
      const asked = h.asked.filter(a => ['Lowering', 'Raising', 'Stronger', 'Cheaper'].includes(a.header))
      expect(asked.map(a => a.header), 'all four, once each').toEqual(['Lowering', 'Raising', 'Stronger', 'Cheaper'])
      expect(asked.map(a => a.options[0]), 'the first option').toEqual([...FIRST[profile]])
      for (const a of asked) expect(a.options.filter(o => o.endsWith('(Recommended)')), `${a.header}: only the first is recommended`).toEqual([a.options[0]])
      expect(asked.map(a => a.options.length), 'no option is lost to the reorder').toEqual([3, 3, 4, 4])
      expect(h.stored, 'the answer stands for the value of its option, whatever the order').toMatchObject(ROWS_AFTER[profile])
    })
  }

  test(`the first option moves, the others keep their order, and each still stands for its own value (${surface})`, { timeoutMs: 30000, options: inProfile('Economy').options }, async ($, on) => {
    const h = engine(on, { ...OPUS, stored: inProfile('Economy').stored })
    const d = drive($, h)
    await d.start(surface)
    h.rating = NEEDS_FABLE
    h.answers = { Stronger: 'Stay on Opus, raise effort only (Recommended)', ...YES_REMEMBER }
    await d.submit(DEBUG)
    expect(h.asked.find(a => a.header === 'Stronger')?.options).toEqual(['Stay on Opus, raise effort only (Recommended)', 'Use the stronger model automatically', 'Ask before using it', 'Ask me each time'])
    expect(handedTo(h), 'stay: no hand-off').toBeUndefined()
    await d.submit(DEBUG)
    expect(h.asked.filter(a => a.header === 'Stronger').length, 'asked once, and the answer stands').toBe(1)
    expect(handedTo(h), 'still no hand-off').toBeUndefined()
  })

  test(`a question is asked once per case in every profile, and a rule you set is not asked at all (${surface})`, { timeoutMs: 30000, options: inProfile('Quality', { lowerRule: 'never lower' }).options }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: SEND, stored: inProfile('Quality', { lowerRule: 'never lower' }).stored })
    const d = drive($, h)
    await d.start(surface)
    h.rating = LOWER
    await d.submit(LOOKUP)
    expect(h.asked, 'Lowering is yours').toEqual([])
    h.rating = RAISE_HIGH
    h.answers = { Raising: 'Raise automatically (Recommended)', ...YES_REMEMBER }
    await d.submit(DEBUG)
    await d.submit(DEBUG)
    expect(h.asked.filter(a => a.header === 'Raising').length, 'once').toBe(1)
    expect(h.asked.find(a => a.header === 'Raising')?.options[0]).toBe('Raise automatically (Recommended)')
  })

  // Exploring close calls is off in every profile.
  for (const profile of PROFILE_NAMES) {
    test(`${profile}: close calls are not explored (${surface})`, { timeoutMs: 30000, options: inProfile(profile, profile === 'Quality' ? { missPause: '50%' } : {}).options }, async ($, on) => {
      const cal = { ...tieCal(0.9), ...FREE_SWITCHES }
      const h = engine(on, { model: 'claude-fable-5-1', effort: 'high', store: { ...SEND, [CAL_STORE]: cal, ties: 4 }, stored: inProfile(profile, profile === 'Quality' ? { missPause: '50%' } : {}).stored })
      const d = drive($, h)
      await d.start(surface)
      h.rating = TIE_RATING
      if (profile === 'Quality') await d.config('handOff', '90%')
      await d.submit(SEARCH)
      expect(handedTo(h), 'the fifth close call takes the guide\'s pick, not the other route').toBe('sonnet')
    })
  }

  test(`Explore close calls is off by default and a person who turns it on gets it (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    expect(SETTINGS.explore.default).toBe('off')
    const cal = { ...tieCal(0.9), ...FREE_SWITCHES }
    const h = engine(on, { model: 'claude-fable-5-1', effort: 'high', store: { [CAL_STORE]: cal, ties: 4 } })
    const d = drive($, h)
    await d.start(surface)
    h.rating = TIE_RATING
    h.answers = { Cheaper: 'Send it to a cheaper subagent (Recommended)', ...YES_REMEMBER }
    await d.submit(SEARCH)
    expect(handedTo(h), 'off: the guide').toBe('sonnet')
    await d.config('explore', 'on')
    h.store.ties = 4
    await d.submit(SEARCH)
    expect(handedTo(h), 'on: the other close route').toBe('opus')
  })

  // Switching the profile in /config takes effect at once, through applyOption, like any other row.
  test(`switching the profile in /config applies at once: hand-off threshold, spot-check, chances and questions (${surface})`, { timeoutMs: 30000, options: { rater: 'haiku' } }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: { [CAL_STORE]: FREE_SWITCHES, spotChecks: 28 }, stored: { rater: 'haiku' } })
    h.files[RUNS] = haikuLog(h, 12)
    const d = drive($, h)
    h.now = Date.now()
    await d.start(surface)
    h.rating = NEAR
    h.answers = { Cheaper: 'Send it to a cheaper subagent (Recommended)', ...YES_REMEMBER }
    await d.submit(SEARCH)
    expect(handedTo(h), 'Balanced: 78% is over 70%').toBeUndefined()
    expect(h.completions.filter(m => m === 'sonnet'), 'Balanced: the 29th is not checked').toEqual([])

    const result = await d.config('profile', 'Economy')
    expect(result.deny).toBeUndefined()
    expect((await settingsText(d)).split('\n')[0]).toBe('Profile: Economy')
    await d.submit(SEARCH)
    expect(handedTo(h), 'Economy: 78% is under 85%').toBe('haiku')
    await flush()
    expect(h.completions.filter(m => m === 'sonnet').length, 'Economy checks every 30th: the 30th').toBe(1)

    await d.config('profile', 'Quality')
    expect((await settingsText(d)).split('\n')[0]).toBe('Profile: Quality')
    expect(await settingsText(d)).toContain('In use: hand-off threshold 50%, pause at 10% misses and 10 logged tasks, rater check every 10, 1 chance per task')
    // A row set after the switch wins over the new profile, and the others follow it.
    await d.config('handOff', '80%')
    expect(await settingsText(d)).toContain('In use: hand-off threshold 80%, pause at 10% misses and 10 logged tasks, rater check every 10, 1 chance per task')
    await d.config('profile', 'Balanced')
    expect(await settingsText(d), 'the row you set stays, the rest follow Balanced').toContain('In use: hand-off threshold 80%, pause at 20% misses, rater check every 20, 2 chances per task')
  })

  test(`a value another plugin writes to the Profile row does not make it yours, and one outside its options changes nothing (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { ...OPUS })
    const d = drive($, h)
    await d.start(surface)
    await d.config('profile', 'Economy', 'plugin')
    expect((await settingsText(d)).split('\n')[0], 'the value is the row\'s now').toBe('Profile: Economy')
    expect((await d.config('profile', 'Reckless')).deny, 'not an option').toBeDefined()
    expect((await settingsText(d)).split('\n')[0]).toBe('Profile: Economy')
  })

  test(`a row reset to its default goes back to the profile's value (${surface})`, { timeoutMs: 30000, options: inProfile('Economy', { handOff: '60%' }).options }, async ($, on) => {
    const h = engine(on, { ...OPUS, store: SEND, stored: inProfile('Economy', { handOff: '60%' }).stored })
    const d = drive($, h)
    await d.start(surface)
    expect(await settingsText(d)).toContain('hand-off threshold 60%')
    h.answers = { Confirm: 'Yes' }
    await d.command('reset handOff')
    expect(await settingsText(d), 'Economy\'s 85% again').toContain('hand-off threshold 85%')
  })


  // ---- Before the cache goes cold ------------------------------------------------------------------------------
  //
  // A big session (a cold return would cost $0.50 or more) gets, at the end of a main turn, an offer, keep-warm
  // requests, a handoff or a compaction, by the row. These run on a virtual clock: a sleep ends when `advance` reaches it.

  /** 18:00 local: the next 9:00 is 15 hours away. */
  const EVENING = new Date(2027, 0, 15, 18, 0, 0, 0).getTime()
  const GROUNDWORK = [{ name: 'groundwork:groundwork', description: 'Groundwork', source: 'plugin', plugin: 'groundwork' }]
  const CACHE_CLOCK = [{ name: 'cache-clock:status', description: 'Cache Clock', source: 'plugin', plugin: 'cache-clock' }]
  type ColdOver = {
    stored?: Record<string, string>
    commands?: typeof GROUNDWORK
    prices?: string
    usage?: typeof BIG_TURN
    fork?: Record<string, number> | undefined
    model?: string
    store?: Record<string, unknown>
    rateLimits?: { kind: string; percentUsed: number }[]
  }
  // Opus: 80,500 tokens in the conversation, $0.63 to come back cold.
  const coldSession = async ($: unknown, on: Parameters<TestBody>[1], over: ColdOver = {}) => {
    const h = engine(on, { model: over.model ?? 'claude-opus-5-5', effort: 'medium', ...(over.stored ? { stored: over.stored } : {}), ...(over.store ? { store: over.store } : {}) })
    if (over.rateLimits) h.rateLimits = over.rateLimits
    h.now = EVENING
    h.virtual = true
    h.stepUsage = over.usage ?? BIG_TURN
    h.commands = over.commands ?? []
    if ('fork' in over) h.forkUsage = over.fork
    if (over.prices) h.pricesFile = over.prices
    const d = drive($, h)
    await d.start(surface)
    return { h, d }
  }
  const coldTurn = async (d: ReturnType<typeof drive>, id: string) => {
    await d.step(id)
    await d.complete(id)
  }
  const bandButtons = async ($: unknown) => {
    const ui = await mount($, surface)
    const found = await ui.findAll({ type: 'Button' })
    await ui.unmount()
    return found.map(b => [b.key, b.text])
  }
  const pressBand = async ($: unknown, key: string) => {
    const ui = await mount($, surface)
    await ui.press({ key })
    await ui.unmount()
  }
  /** The turn ends and 5 minutes pass: on a 1-hour cache the offer shows then, not at the turn's end. */
  const coldOffer = async (h: ReturnType<typeof engine>, d: ReturnType<typeof drive>, id: string) => {
    await coldTurn(d, id)
    await h.advance(5 * MIN)
  }
  /** The text of the cache row (its own line), without the route's row above it. */
  const coldRow = async ($: unknown) => {
    const ui = await mount($, surface)
    const found = await ui.find({ type: 'Text', text: /goes cold|Keeping warm|Kept the cache|Stopped keeping|Compacted|Saved a handoff/ })
    await ui.unmount()
    return found?.text ?? ''
  }
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
  /** The cache offer's cache-only menu: the first level, then the cache choices (4 at most each: a fifth is under More…). */
  const CACHE_MENU = { Options: 'More cache choices…', Cache: 'More…' }
  const warmLines = (h: ReturnType<typeof engine>) =>
    (h.files[RUNS_FILE] ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l) as { kind?: string; overhead?: number; session?: string; tier?: string; context?: number }).filter(l => l.kind === 'warm')
  const coldLog = (h: ReturnType<typeof engine>) => h.files[LOG_PATH] ?? ''
  const NOTHING_DONE = (h: ReturnType<typeof engine>) => ({ forks: h.forks.length, submitted: h.submitted.length, compactions: h.compactions })
  const NONE = { forks: 0, submitted: 0, compactions: 0 }
  const ZERO = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

  test(`ask: a big Opus session gets the offer 5 minutes after the turn on a 1-hour cache: one line, one button, the other choices in the ⋯ menu; nobody presses, nothing happens (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await coldSession($, on)
    await coldTurn(d, 't1')
    expect(await bandText($, surface), 'not at the turn\'s end').toBe('')
    expect(h.afters, 'one timer, for 5 minutes after the turn').toEqual([5 * MIN])
    await h.advance(4 * MIN)
    expect(await bandText($, surface), 'not at 4 minutes').toBe('')
    await h.advance(MIN)
    expect(await bandText($, surface), 'the cache line stands alone: no route text, so it carries the prefix').toBe('rightsize: Cache goes cold at 19:00 · coming back cold costs about $0.63')
    expect(await bandButtons($), 'one button; ⋯ and × follow it').toEqual([
      ['cold-2h', 'Keep warm until 20:00 · $0.03'],
      ['mode', '⋯'],
      ['close', '×'],
    ])
    // $.ui.ask takes 4 options at most: the menu has the band setting and a way down to the cache choices; five of them are 4 and "More…".
    const asks = await openMenu($, h, CACHE_MENU, 3)
    expect(asks.map(a => a.options)).toEqual([
      ['More cache choices…', 'When the band shows…'],
      ['Keep warm until 2:00 tomorrow · $0.13', 'Keep warm until 9:00 tomorrow · $0.24', 'Compact now', 'More…'],
      ['Let it go cold', "Don't offer again"],
    ])
    expect(asks[0]?.question, 'the menu says what the dollars are').toContain('API-equivalent')
    await h.advance(3 * HOUR)
    expect(NOTHING_DONE(h), 'the cache goes cold').toEqual(NONE)
    expect(h.sleepers.length, 'no timer waits').toBe(0)
  })

  test(`ask: the offer names the clock time the cache goes cold, and the tokens and the model stay out of the band, in the log (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await coldSession($, on)
    await coldTurn(d, 't1')
    await h.advance(5 * MIN)
    expect(await bandText($, surface)).toContain('Cache goes cold at 19:00')
    expect(await bandText($, surface)).not.toMatch(/tokens|Opus/)
    expect(coldLog(h)).toContain('($0.63 cold, 81K tokens on Opus')
  })

  test(`ask: a prompt in the first 5 minutes cancels the offer (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await coldSession($, on)
    await coldTurn(d, 't1')
    await h.advance(3 * MIN)
    h.rating = NO_CHANGE
    await d.submit('continue')
    await h.advance(10 * MIN)
    expect(await bandText($, surface), 'no offer for the turn before it').not.toContain('Cache goes cold')
    expect(h.afters.length, 'the timer was the only one; it was cancelled before it fired').toBe(1)
  })

  test(`ask: with a route band above, the cache line is a second row with the one button, and ⋯ and × stay on the first (${surface})`, { timeoutMs: 30000, options: { lowerRule: 'lower automatically' } }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: { lowerRule: 'lower automatically' }, store: { [CAL_STORE]: FREE_SWITCHES } })
    await coldTurn(d, 't0')
    h.rating = LOWER
    await d.submit(LOOKUP)
    await d.step('t1')
    await d.complete('t1')
    expect(await coldRow($), 'not yet').toBe('')
    await h.advance(5 * MIN)
    const ui = await mount($, surface)
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    expect(texts.some(t => t?.startsWith('rightsize: Effort lowered') && !t.includes('Cache goes cold')), 'row 1 is the route text alone').toBe(true)
    expect(await coldRow($)).toBe('Cache goes cold at 19:00 · coming back cold costs about $0.63')
    await ui.unmount()
    expect((await bandButtons($)).map(b => b[0]), 'route buttons, ⋯ and ×; then the cache button').toEqual(['retry', 'good', 'bad', 'mode', 'close', 'cold-2h'])
    expect((await openMenu($, h))[0]?.options, 'the rule options, the way down to the cache choices, the band setting').toEqual(['Ask me each time', 'Never lower', 'More cache choices…', 'When the band shows…'])
  })

  test(`ask: with Groundwork installed the offer says Save a handoff, and the usual start time comes from the run log (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await coldSession($, on, { commands: GROUNDWORK })
    // Six days whose first prompt was at 8:21, 8:22 ... 8:26: the median, 8:23.5, rounds to 8:30.
    const day = (n: number) => JSON.stringify({ at: new Date(2027, 0, 15 - n, 9, 30).toISOString(), submittedAt: new Date(2027, 0, 15 - n, 8, 20 + n).toISOString(), kind: 'run' })
    h.files[LEGACY_RUNS] = `${[1, 2, 3, 4, 5, 6].map(day).join('\n')}\n`
    await d.start(surface)
    await coldOffer(h, d, 't1')
    expect((await bandButtons($)).map(b => b[1])).toEqual(['Keep warm until 20:00 · $0.03', '⋯', '×'])
    const asks = await openMenu($, h, CACHE_MENU, 3)
    expect(asks[1]?.options).toEqual(['Keep warm until 2:00 tomorrow · $0.13', 'Keep warm until 8:30 tomorrow · $0.24', 'Save a handoff', 'More…'])
    expect(asks[2]?.options).toEqual(['Let it go cold', "Don't offer again"])
    expect(coldLog(h)).toContain('offered 2h, 8h, start')
  })

  test(`ask: nothing for a small conversation, for Haiku, or past 200K tokens; Sonnet needs about 128K (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await coldSession($, on, { usage: { ...BIG_TURN, cache_read_input_tokens: 20_000 } })
    await coldTurn(d, 't1')
    expect(await bandText($, surface), '20K tokens on Opus: $0.16 cold').toBe('')
    // Haiku with a big conversation: a cold return costs about a cent and a half.
    h.stepUsage = BIG_TURN
    h.model = 'claude-haiku-5-5'
    await coldTurn(d, 't2')
    expect(await bandText($, surface), 'Haiku never').toBe('')
    // Sonnet at 100K tokens: $0.39 cold, under the bar; at 140K: $0.55.
    h.model = 'claude-sonnet-5-5'
    h.stepUsage = { ...BIG_TURN, cache_read_input_tokens: 99_500 }
    await coldTurn(d, 't3')
    expect(await bandText($, surface)).toBe('')
    h.stepUsage = { ...BIG_TURN, cache_read_input_tokens: 139_500 }
    await coldOffer(h, d, 't4')
    expect(await bandText($, surface)).toBe('rightsize: Cache goes cold at 19:00 · coming back cold costs about $0.55')
    // Opus at exactly 200K tokens is offered; one token more is Claude Code's to compact.
    h.model = 'claude-opus-5-5'
    h.stepUsage = { ...BIG_TURN, cache_read_input_tokens: 199_500 }
    await coldOffer(h, d, 't5')
    expect(coldLog(h)).toContain('200K tokens on Opus')
    expect(await bandText($, surface)).toContain('Cache goes cold')
    h.stepUsage = { ...BIG_TURN, cache_read_input_tokens: 199_501 }
    await coldOffer(h, d, 't6')
    expect(await bandText($, surface), 'over IDLE_MAX_CONTEXT').toBe('')
  })

  test(`ask: an aborted turn gets no offer: the person is at the keyboard (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { d } = await coldSession($, on)
    await d.step('t1')
    await ($ as Engine).turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: true, reason: 'aborted' })
    expect(await bandText($, surface)).toBe('')
  })

  test(`Don't offer again saves the row as yours, says where it is, and no profile offers again (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await coldSession($, on)
    await coldOffer(h, d, 't1')
    await openMenu($, h, { ...CACHE_MENU, 'More cache': "Don't offer again" }, 3)
    expect(last(h.sets)).toMatchObject({ key: 'rightsize.beforeCold', value: 'off' })
    expect(h.stored.beforeCold, 'written to settings.json as the person\'s own').toBe('off')
    expect(last(h.toasts)).toBe('Rightsize: Before the cache goes cold is now "off". It is the row in /config; set it back any time.')
    expect(await settingsText(d), 'yours now').toContain('Before the cache goes cold: off')
    expect(await bandText($, surface), 'the offer closes').toBe('')
    await coldTurn(d, 't2')
    expect(await bandText($, surface), 'and does not come back').toBe('')
    // Not for Quality either, which would keep warm by default, and not in the next session.
    await d.config('profile', 'Quality')
    await coldTurn(d, 't3')
    await d.start(surface)
    await coldTurn(d, 't4')
    await h.advance(3 * HOUR)
    expect(NOTHING_DONE(h)).toEqual(NONE)
    expect(await bandText($, surface)).toBe('')
  })

  test(`Let it go cold closes the offer and does nothing; Compact now runs at once, while the cache is warm (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await coldSession($, on)
    await coldOffer(h, d, 't1')
    await openMenu($, h, { ...CACHE_MENU, 'More cache': 'Let it go cold' }, 3)
    expect(await bandText($, surface)).toBe('')
    expect(NOTHING_DONE(h)).toEqual(NONE)
    expect(coldLog(h)).toContain('let it go cold')
    await coldOffer(h, d, 't2')
    // Let it go cold is the one button now (the choice picked most); Compact now is on the second page of the menu.
    expect((await bandButtons($)).map(b => b[1]).slice(0, 1)).toEqual(['Let it go cold'])
    await openMenu($, h, { Options: 'More cache choices…', Cache: 'More…', 'More cache': 'Compact now' }, 3)
    expect(h.compactions, 'right away').toBe(1)
    expect(await bandText($, surface)).toBe('rightsize: Compacted while the cache was warm.')
    await h.advance(3 * HOUR)
    expect(h.compactions, 'once').toBe(1)
  })

  test(`Save a handoff from the offer submits "wrap up" at once, and the turn it starts does not bring the offer back (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await coldSession($, on, { commands: GROUNDWORK })
    await coldOffer(h, d, 't1')
    await openMenu($, h, { Options: 'More cache choices…', Cache: 'Save a handoff' }, 2)
    expect(h.submitted.map(s => s.text)).toEqual(['wrap up'])
    expect(await bandText($, surface)).toBe('rightsize: Saved a handoff with Groundwork before the cache went cold.')
    expect(h.ratings, 'rightsize\'s own prompt is not rated').toBe(0)
    // Groundwork's wrap-up is a turn of its own.
    await d.turnStart('t2', 'wrap up')
    await coldTurn(d, 't2')
    expect(await bandText($, surface), 'no second offer after a handoff').toBe('rightsize: Saved a handoff with Groundwork before the cache went cold.')
    await h.advance(3 * HOUR)
    expect(h.submitted.length).toBe(1)
    // The person comes back and works: it starts afresh.
    h.rating = NO_CHANGE
    await d.submit('continue')
    await coldOffer(h, d, 't3')
    expect(await bandText($, surface)).toContain('Cache goes cold at ')
  })

  test(`an offered keep-warm time starts at once and counts from the turn's end (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await coldSession($, on)
    await coldTurn(d, 't1')
    await h.advance(10 * MIN)
    await pressBand($, 'cold-2h')
    expect(await bandText($, surface)).toBe('rightsize: Keeping warm until 20:00 · nothing used yet')
    expect(await bandButtons($)).toEqual([['cold-stop', 'Stop keeping warm'], ['mode', '⋯'], ['close', '×']])
    await h.advance(46 * MIN)
    expect(h.forks.length, '56 minutes after the turn ended').toBe(0)
    await h.advance(MIN)
    expect(h.forks, 'at 57').toEqual(['Reply with the single word OK.'])
    await h.advance(HOUR)
    expect(h.forks.length, 'and at 114: two for 2 hours').toBe(2)
    await h.advance(4 * HOUR)
    expect(h.forks.length).toBe(2)
    expect(await bandText($, surface)).toBe('rightsize: Kept the cache warm until 20:00 · $0.03.')
  })

  test(`a keep-warm button pressed 40 minutes after the turn ends keeps the end time and the cost it showed (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await coldSession($, on)
    await coldOffer(h, d, 't1')
    expect((await bandButtons($))[0], 'the button as shown at 5 minutes').toEqual(['cold-2h', 'Keep warm until 20:00 · $0.03'])
    await h.advance(35 * MIN)
    expect((await bandButtons($))[0], 'the same at 40 minutes').toEqual(['cold-2h', 'Keep warm until 20:00 · $0.03'])
    await pressBand($, 'cold-2h')
    expect(await bandText($, surface)).toBe('rightsize: Keeping warm until 20:00 · nothing used yet')
    await h.advance(4 * HOUR)
    expect(h.forks.length, 'two pings, as for a press at 5 minutes').toBe(2)
    expect(await bandText($, surface)).toBe('rightsize: Kept the cache warm until 20:00 · $0.03.')
  })

  test(`an offered time on a cache that already went cold says so and keeps nothing warm (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await coldSession($, on)
    await coldTurn(d, 't1')
    await h.advance(61 * MIN)
    await pressBand($, 'cold-2h')
    expect(last(h.toasts)).toBe('Rightsize: the cache already went cold, so there is nothing to keep warm.')
    await h.advance(3 * HOUR)
    expect(h.forks.length).toBe(0)
  })

  const WARM8 = inProfile('Balanced', { beforeCold: 'keep warm 8 h' })
  test(`keep warm 8 h: starts at the turn's end with no question, pings through $0.model.fork each 57 minutes, and each ping is a warm line of overhead (${surface})`, { timeoutMs: 30000, options: WARM8.options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: WARM8.stored })
    await coldTurn(d, 't1')
    expect(h.asked.length, 'no question').toBe(0)
    expect(await bandText($, surface)).toBe('rightsize: Keeping warm until 2:00 · nothing used yet')
    expect(await bandButtons($)).toEqual([['cold-stop', 'Stop keeping warm'], ['mode', '⋯'], ['close', '×']])
    expect(h.afters, 'one timer, for the first ping: a long wait is an after, not a sleep').toEqual([57 * MIN])
    await h.advance(56 * MIN)
    expect(h.forks.length).toBe(0)
    await h.advance(MIN)
    expect(h.forks.length, 'the first at 57 minutes: 3 before the cache expires').toBe(1)
    expect(h.afters, 'the first ping armed the second').toEqual([57 * MIN, 57 * MIN])
    expect(await bandText($, surface)).toBe('rightsize: Keeping warm until 2:00 · $0.02 so far')
    expect(warmLines(h).length).toBe(1)
    expect(warmLines(h)[0]).toMatchObject({ kind: 'warm', session: 'sess-1', tier: 'opus', context: 80_500, overhead: 0.01613 })
    await h.advance(7 * HOUR)
    expect(h.forks.length, 'eight in eight hours').toBe(8)
    expect(h.forks.every(f => f === 'Reply with the single word OK.')).toBe(true)
    expect(warmLines(h).length).toBe(8)
    expect(h.afters.length, 'one timer per ping, and none after the last').toBe(8)
    expect(h.sleeps.every(ms => ms <= 120_000), 'no long sleep').toBe(true)
    expect(await bandText($, surface)).toBe('rightsize: Kept the cache warm until 2:00 · $0.13.')
    // Nearly 8 hours after the turn ended, but 21 minutes after the last ping: coming back is not an idle return.
    h.rating = NO_CHANGE
    await d.submit('continue')
    expect(h.asked.length, 'no idle question: the pings kept the cache warm').toBe(0)
    await h.advance(3 * HOUR)
    expect(h.forks.length, 'and no more').toBe(8)
  })

  test(`the pings count against rightsize in the report: Total saved is lower by what they cost (${surface})`, { timeoutMs: 30000, options: WARM8.options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: WARM8.stored })
    await coldTurn(d, 't1')
    await h.advance(8 * HOUR)
    expect(warmLines(h).length).toBe(8)
    h.now = Date.now()
    const only = (await d.command('report')).text ?? ''
    expect(only.split('\n')[1]).toBe('Cost ~$0.13 more than it saved in the last 30 days.')
    expect(only.replace(/\s+/g, ' ')).toContain('Total saved is after the cost of rating prompts and of keeping the cache warm ($0.13 in 30 days), and counts what keeping it warm saved when you came back to a warm cache.')
    // A saving of $0.30 in another session: the 30 days show it less the pings.
    h.files[LEGACY_RUNS] = `${JSON.stringify({ at: new Date().toISOString(), kind: 'run', session: 'other', change: 'lower', offered: 'lower', stay: 0.4, taken: 0.1, actual: 0.1, overhead: 0 })}\n`
    expect(cellsOf((await d.command('report')).text ?? '', 'Total saved')).toEqual(['-$0.13', '~$0.17', '~$0.17'])
  })

  test(`keep warm stops when the person submits a prompt (${surface})`, { timeoutMs: 30000, options: WARM8.options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: WARM8.stored })
    await coldTurn(d, 't1')
    await h.advance(57 * MIN)
    expect(h.forks.length).toBe(1)
    h.rating = NO_CHANGE
    await d.submit('continue')
    expect(await bandText($, surface), 'the prompt closes the band').toBe('')
    await h.advance(4 * HOUR)
    expect(h.forks.length, 'no more').toBe(1)
    expect(coldLog(h)).toContain('keep warm stopped (a prompt was submitted): 1 ping')
  })

  // ---- Keep warm savings: a `warmSaved` line, only for a return the pings earned and the first request's cache read proved ----
  const savedLines = (h: ReturnType<typeof engine>) =>
    (h.files[RUNS_FILE] ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l) as { kind?: string; saved?: number; task?: string; tier?: string; context?: number; session?: string; overhead?: number }).filter(l => l.kind === 'warmSaved')
  /** The person comes back and the first request of their prompt is made: `t2`. */
  const comeBack = async (d: ReturnType<typeof drive>, h: ReturnType<typeof engine>) => {
    h.rating = NO_CHANGE
    await d.submit('continue')
    await d.step('t2')
    await d.complete('t2')
  }

  const SHOWN = inProfile('Balanced', { beforeCold: 'keep warm 8 h', band: 'always' })
  test(`keep warm saving: a return during the run, after the cache would have gone cold, whose first request read the cache, is a warmSaved line with what a cold return would have cost (${surface})`, { timeoutMs: 30000, options: SHOWN.options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: SHOWN.stored })
    h.rating = NO_CHANGE
    await d.submit(LOOKUP)
    await coldTurn(d, 't1')
    await h.advance(57 * MIN)
    expect(h.forks.length, 'one ping so far').toBe(1)
    await h.advance(5 * MIN)
    h.rating = NO_CHANGE
    await d.submit('continue')
    await d.step('t2')
    // The first request showed the cache held: the session total counts the saving at once (0.6279 less the ping's 0.01613).
    // The band shows that total only from the 3rd rated prompt, so it is read from the log here.
    expect(sessionTotal(readRuns(h) as unknown as RunLine[], 'sess-1', false), 'the session total counts it').toBe('Session: ~$0.61 saved')
    await d.complete('t2')
    // 62 minutes after the turn ended: past its 60 minutes, kept warm by the ping at 57.
    const taskId = (readRuns(h).find(l => l.kind === 'run') as { id?: string } | undefined)?.id
    expect(taskId, 'the task is the first prompt\'s run').toBeTruthy()
    expect(savedLines(h).map(l => ({ ...l, at: undefined }))).toEqual([{ kind: 'warmSaved', session: 'sess-1', task: taskId, tier: 'opus', context: 80_500, saved: 0.6279 }])
    expect(warmLines(h)[0], 'the keep-warm request carries the same task').toMatchObject({ task: taskId })
    expect(coldLog(h)).toContain('keep warm: the cache held on return (read 80000 of 80500 tokens); coming back cold would have cost $0.63')
    // The ping stays its own cost line; the saving is a separate line, never in a cost.
    expect(warmLines(h).length).toBe(1)
    expect(warmLines(h)[0]?.overhead).toBe(0.01613)
    // The saving is in the totals: 0.6279 saved less 0.01613 of pings, and the band's session total says so.
    h.now = Date.now()
    const text = (await d.command('report')).text ?? ''
    expect(text.replace(/\s+/g, ' ')).toContain('Keep warm: 1 run · saved ~$0.63 on 1 return · cost ~$0.02 · net ~$0.61 saved')
    expect(cellsOf(text, 'Total saved')?.[2]).toBe('~$0.61')
  })

  test(`keep warm saving: a run the person never returned to has no saving line, and its requests are pure cost in the report (${surface})`, { timeoutMs: 30000, options: WARM8.options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: WARM8.stored })
    await coldTurn(d, 't1')
    await h.advance(8 * HOUR)
    expect(warmLines(h).length).toBe(8)
    expect(savedLines(h)).toEqual([])
    h.now = Date.now()
    const text = (await d.command('report')).text ?? ''
    expect(text.replace(/\s+/g, ' ')).toContain('Keep warm: 1 run · saved nothing: no returns · cost ~$0.13 · net ~$0.13 more')
    expect(text.split('\n')[1]).toBe('Cost ~$0.13 more than it saved in the last 30 days.')
  })

  test(`keep warm saving: a return before the cache would have gone cold saves nothing, even if its first request read the cache (${surface})`, { timeoutMs: 30000, options: WARM8.options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: WARM8.stored })
    await coldTurn(d, 't1')
    await h.advance(57 * MIN)
    await h.advance(2 * MIN)
    await comeBack(d, h)
    expect(h.forks.length).toBe(1)
    expect(savedLines(h), '59 minutes: the cache was warm without the ping').toEqual([])
    expect(coldLog(h)).not.toContain('the cache held on return')
    expect(coldLog(h)).not.toContain('missed on return')
  })

  test(`keep warm saving: a return that was not first to the pings (no request answered yet) saves nothing (${surface})`, { timeoutMs: 30000, options: WARM8.options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: WARM8.stored })
    await coldTurn(d, 't1')
    await h.advance(40 * MIN)
    await comeBack(d, h)
    expect(h.forks.length, 'no ping yet').toBe(0)
    expect(savedLines(h)).toEqual([])
  })

  test(`keep warm saving: a cache miss on the return is logged, and no saving is recorded (${surface})`, { timeoutMs: 30000, options: WARM8.options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: WARM8.stored })
    await coldTurn(d, 't1')
    await h.advance(62 * MIN)
    expect(h.forks.length).toBe(1)
    // The first request wrote the whole conversation again: the cache was not there.
    h.stepUsage = { input_tokens: 200, output_tokens: 400, cache_read_input_tokens: 0, cache_creation_input_tokens: 80_300 }
    await comeBack(d, h)
    expect(savedLines(h)).toEqual([])
    expect(coldLog(h)).toContain('keep warm: the cache missed on return (the first request read 0 of 80500 tokens), so no saving is counted')
    // Under 80% is a miss too; the check is the first request's only.
    expect(coldLog(h)).not.toContain('the cache held on return')
  })

  const WARM2_SAVING = inProfile('Balanced', { beforeCold: 'keep warm 2 h' })
  test(`keep warm saving: a return after the run ended counts while the last request still kept the cache (${surface})`, { timeoutMs: 30000, options: WARM2_SAVING.options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: WARM2_SAVING.stored })
    await coldTurn(d, 't1')
    await h.advance(2 * HOUR + 30 * MIN)
    expect(h.forks.length, 'two pings, at 57 and 114 minutes').toBe(2)
    await comeBack(d, h)
    expect(savedLines(h).length, '150 minutes after the turn, 36 after the last ping').toBe(1)
  })

  test(`keep warm saving: a return after the last request's life, with the run over, saves nothing (${surface})`, { timeoutMs: 30000, options: WARM2_SAVING.options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: WARM2_SAVING.stored })
    await coldTurn(d, 't1')
    await h.advance(3 * HOUR)
    expect(h.forks.length).toBe(2)
    await comeBack(d, h)
    expect(savedLines(h), '180 minutes after the turn, 66 after the last ping: cold anyway').toEqual([])
  })

  test(`keep warm stops at Stop, and the band says how much it cost (${surface})`, { timeoutMs: 30000, options: WARM8.options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: WARM8.stored })
    await coldTurn(d, 't1')
    await h.advance(57 * MIN)
    await pressBand($, 'cold-stop')
    expect(await bandText($, surface)).toBe('rightsize: Stopped keeping warm · $0.02.')
    expect((await bandButtons($)).map(b => b[0]), 'no Stop once stopped').toEqual(['mode', 'close'])
    await h.advance(4 * HOUR)
    expect(h.forks.length).toBe(1)
    expect(coldLog(h)).toContain('keep warm stopped (Stop pressed): 1 ping')
  })

  test(`keep warm stops when a fork fails, and logs the reason (${surface})`, { timeoutMs: 30000, options: WARM8.options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: WARM8.stored })
    await coldTurn(d, 't1')
    h.forkReplies = [{ isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: ZERO }]
    await h.advance(57 * MIN)
    expect(h.forks.length).toBe(1)
    expect(coldLog(h)).toContain('keep warm stopped: the request failed (api-error 529, overloaded)')
    expect(await bandText($, surface)).toBe('rightsize: Stopped keeping warm: a request failed · nothing used.')
    await h.advance(4 * HOUR)
    expect(h.forks.length, 'no retry').toBe(1)
    expect(warmLines(h), 'a request that cost nothing is no line').toEqual([])
  })

  test(`keep warm stops when there is nothing to fork, and prices a ping with no usage as a cache read of the conversation (${surface})`, { timeoutMs: 30000, options: WARM8.options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: WARM8.stored, fork: undefined })
    await coldTurn(d, 't1')
    await h.advance(57 * MIN)
    expect(warmLines(h).map(l => l.overhead), '80,500 tokens read at $0.20 per million').toEqual([0.01610])
    h.forkReplies = [{ isAnswered: false, reason: 'nothing-to-fork' }]
    await h.advance(57 * MIN)
    expect(h.forks.length).toBe(2)
    expect(coldLog(h)).toContain('keep warm stopped: the request failed (nothing-to-fork)')
    await h.advance(4 * HOUR)
    expect(h.forks.length).toBe(2)
  })

  test(`keep warm stops when its row changes in /config (${surface})`, { timeoutMs: 30000, options: WARM8.options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: WARM8.stored })
    await coldTurn(d, 't1')
    await h.advance(57 * MIN)
    await d.config('beforeCold', 'off')
    await h.advance(4 * HOUR)
    expect(h.forks.length).toBe(1)
  })

  const WARM2 = inProfile('Balanced', { beforeCold: 'keep warm 2 h' })
  test(`keep warm 2 h ends at its end time (${surface})`, { timeoutMs: 30000, options: WARM2.options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: WARM2.stored })
    await coldTurn(d, 't1')
    expect(await bandText($, surface)).toBe('rightsize: Keeping warm until 20:00 · nothing used yet')
    await h.advance(5 * HOUR)
    expect(h.forks.length, 'at 57 and 114 minutes; the next would be past 2 hours').toBe(2)
    expect(await bandText($, surface)).toBe('rightsize: Kept the cache warm until 20:00 · $0.03.')
    expect(coldLog(h)).toContain('keep warm ended at 20:00: 2 pings')
  })

  test(`a newer turn end replaces the timer: one keep-warm run at a time (${surface})`, { timeoutMs: 30000, options: WARM2.options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: WARM2.stored })
    await coldTurn(d, 't1')
    await h.advance(30 * MIN)
    // A turn the person did not start (a background task reporting back) ends 30 minutes later.
    await d.turnStart('t2', '')
    await coldTurn(d, 't2')
    await h.advance(HOUR)
    expect(h.forks.length, 'the old run is gone: the first ping of the new one is at 57 minutes after t2').toBe(1)
    await h.advance(5 * HOUR)
    expect(h.forks.length, 'the new run sends its second and last at 144 minutes; the old one sent none').toBe(2)
  })

  const FIVE = { prices: OLD_PRICES, usage: { ...BIG_TURN, cache_read_input_tokens: 150_000 }, fork: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 150_000, cache_creation_input_tokens: 0 } }
  test(`break-even on a 5-minute cache: only times under it are offered, and the offer says where keeping warm stops paying (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await coldSession($, on, FIVE)
    await coldTurn(d, 't1')
    expect(h.afters, 'a cache under 1 hour shows the offer at the turn\'s end: the one timer is for the cache going cold, 5 minutes on').toEqual([5 * MIN])
    expect(await bandText($, surface)).toBe(
      'rightsize: Cache goes cold at 18:05 · coming back cold costs about $0.72. Keeping warm past 19:36 costs more than coming back cold.',
    )
    expect((await bandButtons($)).map(b => b[1]), 'one button').toEqual(['Keep warm until 18:30 · $0.21', '⋯', '×'])
    const asks = await openMenu($, h, { Options: 'More cache choices…' }, 2)
    expect(asks.map(a => a.options), 'four choices fit one list').toEqual([['More cache choices…', 'When the band shows…'], ['Keep warm until 19:00 · $0.42', 'Compact now', 'Let it go cold', "Don't offer again"]])
  })

  const WARM8_5M = inProfile('Balanced', { beforeCold: 'keep warm 8 h' })
  test(`break-even: keep warm 8 h on a 5-minute cache is capped at 24 pings, and the cap is logged (${surface})`, { timeoutMs: 30000, options: WARM8_5M.options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { ...FIVE, stored: WARM8_5M.stored })
    await coldTurn(d, 't1')
    expect(coldLog(h)).toContain('keep warm capped at 24 pings: more would cost more than coming back cold ($0.72)')
    await h.advance(3 * HOUR)
    expect(h.forks.length, 'every 4 minutes for 96 minutes').toBe(24)
    await h.advance(5 * HOUR)
    expect(h.forks.length).toBe(24)
    expect(await bandText($, surface)).toMatch(/^rightsize: Kept the cache warm until 19:41 · \$0\.72\./)
  })

  test(`break-even: pings that cost more than planned stop the run before the cap (${surface})`, { timeoutMs: 30000, options: WARM8_5M.options }, async ($, on) => {
    // Each ping really cost a third of a cold return (it wrote the conversation again).
    const { h, d } = await coldSession($, on, { ...FIVE, stored: WARM8_5M.stored, fork: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 50_000 } })
    await coldTurn(d, 't1')
    await h.advance(HOUR)
    expect(h.forks.length, 'three pings of $0.25 pass $0.72').toBe(3)
    expect(coldLog(h)).toContain('keep warm stopped: $0.75 spent, as much as coming back cold')
  })

  const HANDOFF = inProfile('Balanced', { beforeCold: 'save a handoff' })
  test(`save a handoff: with Groundwork it submits "wrap up" once, 3 minutes before expiry, unrated (${surface})`, { timeoutMs: 30000, options: HANDOFF.options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: HANDOFF.stored, commands: GROUNDWORK })
    await coldTurn(d, 't1')
    expect(await bandText($, surface), 'nothing to show yet').toBe('')
    expect(h.afters, 'one timer, 3 minutes before the cache expires').toEqual([57 * MIN])
    await h.advance(56 * MIN)
    expect(NOTHING_DONE(h)).toEqual(NONE)
    await h.advance(MIN)
    expect(h.submitted.map(s => s.text)).toEqual(['wrap up'])
    expect(h.compactions).toBe(0)
    expect(h.ratings, 'not rated').toBe(0)
    expect(h.completions, 'no rating call at all').toEqual([])
    expect(await bandText($, surface)).toBe('rightsize: Saved a handoff with Groundwork before the cache went cold.')
    expect(coldLog(h)).toContain('handoff: submitted "wrap up" to Groundwork before the cache went cold')
    // Groundwork's turn ends: no second round.
    await d.turnStart('t2', 'wrap up')
    await coldTurn(d, 't2')
    await h.advance(5 * HOUR)
    expect(h.submitted.length, 'once').toBe(1)
  })

  test(`save a handoff: with no Groundwork it compacts instead (${surface})`, { timeoutMs: 30000, options: HANDOFF.options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: HANDOFF.stored })
    await coldTurn(d, 't1')
    await h.advance(56 * MIN)
    expect(h.compactions).toBe(0)
    await h.advance(MIN)
    expect(h.compactions).toBe(1)
    expect(h.submitted, 'no wrap-up prompt').toEqual([])
    expect(await bandText($, surface)).toBe('rightsize: Compacted while the cache was warm.')
    await h.advance(5 * HOUR)
    expect(h.compactions, 'once').toBe(1)
    // The conversation is small now: coming back is not asked about as an idle return of the old size.
    h.rating = NO_CHANGE
    await d.submit('continue')
    expect(h.asked.length).toBe(0)
  })

  const COMPACT = inProfile('Balanced', { beforeCold: 'compact' })
  test(`compact: calls $.session.compact() once before expiry, and logs a skip with its reason (${surface})`, { timeoutMs: 30000, options: COMPACT.options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: COMPACT.stored, commands: GROUNDWORK })
    await coldTurn(d, 't1')
    await h.advance(57 * MIN)
    expect(h.compactions).toBe(1)
    expect(h.submitted, 'compact is not a handoff, with Groundwork or not').toEqual([])
    expect(coldLog(h)).toContain('compact: compacted before the cache went cold')
    await h.advance(5 * HOUR)
    expect(h.compactions).toBe(1)
  })

  test(`compact: a compaction a hook vetoes is logged with its reason and shows nothing (${surface})`, { timeoutMs: 30000, options: COMPACT.options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: COMPACT.stored })
    h.compactSkip = 'a PreCompact hook blocked it'
    await coldTurn(d, 't1')
    await h.advance(57 * MIN)
    expect(h.compactions).toBe(1)
    expect(coldLog(h)).toContain('compact skipped: a PreCompact hook blocked it')
    expect(await bandText($, surface)).toBe('')
  })

  test(`a prompt before expiry cancels the waiting handoff (${surface})`, { timeoutMs: 30000, options: HANDOFF.options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: HANDOFF.stored, commands: GROUNDWORK })
    await coldTurn(d, 't1')
    await h.advance(30 * MIN)
    h.rating = NO_CHANGE
    await d.submit('continue')
    await h.advance(5 * HOUR)
    expect(NOTHING_DONE(h)).toEqual({ forks: 0, submitted: 1, compactions: 0 })
    expect(h.submitted.map(s => s.text), 'only the person\'s own prompt').toEqual(['continue'])
  })

  test(`nothing fires while a turn is active (${surface})`, { timeoutMs: 30000, options: HANDOFF.options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: HANDOFF.stored, commands: GROUNDWORK })
    await coldTurn(d, 't1')
    await h.advance(30 * MIN)
    // A turn the person did not start runs when the timer is due.
    await d.turnStart('t2', '')
    await h.advance(HOUR)
    expect(NOTHING_DONE(h), 'skipped: the turn keeps the cache warm itself').toEqual(NONE)
    expect(coldLog(h)).toContain('handoff skipped: a turn is running')
    // Its end starts a round of its own.
    await d.step('t2')
    await d.complete('t2')
    await h.advance(57 * MIN)
    expect(h.submitted.map(s => s.text)).toEqual(['wrap up'])
  })

  test(`keep warm skips a ping while a turn is active (${surface})`, { timeoutMs: 30000, options: WARM8.options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: WARM8.stored })
    await coldTurn(d, 't1')
    await h.advance(30 * MIN)
    await d.turnStart('t2', '')
    await h.advance(HOUR)
    expect(h.forks.length).toBe(0)
    expect(coldLog(h)).toContain('keep warm skipped: a turn is running')
  })

  test(`Cache Clock installed: nothing happens, whatever the row says, and the skip is logged (${surface})`, { timeoutMs: 30000, options: WARM8.options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: WARM8.stored, commands: [...GROUNDWORK, ...CACHE_CLOCK] })
    await coldTurn(d, 't1')
    await h.advance(3 * HOUR)
    expect(NOTHING_DONE(h)).toEqual(NONE)
    expect(await bandText($, surface)).toBe('')
    expect(coldLog(h)).toContain('skipped, Cache Clock is installed and keeps the cache warm')
    await d.config('beforeCold', 'ask')
    await coldOffer(h, d, 't2')
    expect(await bandText($, surface), 'no offer either').toBe('')
    await d.config('beforeCold', 'save a handoff')
    await coldTurn(d, 't3')
    await h.advance(3 * HOUR)
    expect(NOTHING_DONE(h)).toEqual(NONE)
  })

  test(`a command list that fails is no Cache Clock: the offer shows, and the log says what happened (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await coldSession($, on)
    h.commandsFail = true
    await coldOffer(h, d, 't1')
    expect(await bandText($, surface)).toContain('Cache goes cold at 19:00')
    expect(coldLog(h)).toContain('could not list the commands')
  })

  test(`rightsize off: nothing at the end of a turn (${surface})`, { timeoutMs: 30000, options: WARM8.options }, async ($, on) => {
    const h = engine(on, { ...OPUS, stored: WARM8.stored })
    h.files['/home/test/.claude/mods/switches.json'] = '{"rightsize": false}'
    h.now = EVENING
    h.virtual = true
    h.stepUsage = BIG_TURN
    const d = drive($, h)
    await d.start(surface)
    await coldTurn(d, 't1')
    await h.advance(3 * HOUR)
    expect(NOTHING_DONE(h)).toEqual(NONE)
    expect(await bandText($, surface)).toBe('')
  })

  test(`profiles: Quality keeps warm for 8 hours when the row is not set (${surface})`, { timeoutMs: 30000, options: inProfile('Quality').options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: inProfile('Quality').stored })
    await coldTurn(d, 't1')
    expect(await bandText($, surface)).toBe('rightsize: Keeping warm until 2:00 · nothing used yet')
    await h.advance(57 * MIN)
    expect(NOTHING_DONE(h)).toEqual({ forks: 1, submitted: 0, compactions: 0 })
  })

  test(`profiles: Balanced asks when the row is not set (${surface})`, { timeoutMs: 30000, options: inProfile('Balanced').options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: inProfile('Balanced').stored })
    await coldOffer(h, d, 't1')
    expect(await bandText($, surface)).toContain('Cache goes cold at 19:00')
    await h.advance(3 * HOUR)
    expect(NOTHING_DONE(h)).toEqual(NONE)
  })

  test(`profiles: Economy saves a handoff with Groundwork when the row is not set, and never keeps warm (${surface})`, { timeoutMs: 30000, options: inProfile('Economy').options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: inProfile('Economy').stored, commands: GROUNDWORK })
    await coldTurn(d, 't1')
    expect(await bandText($, surface), 'no offer, no keep-warm line').toBe('')
    await h.advance(57 * MIN)
    expect(NOTHING_DONE(h)).toEqual({ forks: 0, submitted: 1, compactions: 0 })
    expect(h.submitted.map(s => s.text)).toEqual(['wrap up'])
    await h.advance(8 * HOUR)
    expect(h.forks.length).toBe(0)
  })

  test(`profiles: Economy compacts when Groundwork is not installed (${surface})`, { timeoutMs: 30000, options: inProfile('Economy').options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: inProfile('Economy').stored })
    await coldTurn(d, 't1')
    await h.advance(57 * MIN)
    expect(NOTHING_DONE(h)).toEqual({ forks: 0, submitted: 0, compactions: 1 })
  })

  test(`your setting wins: Quality compacts when you say compact (${surface})`, { timeoutMs: 30000, options: inProfile('Quality', { beforeCold: 'compact' }).options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: inProfile('Quality', { beforeCold: 'compact' }).stored })
    await coldTurn(d, 't1')
    await h.advance(57 * MIN)
    expect(NOTHING_DONE(h), 'not Quality\'s keep warm').toEqual({ forks: 0, submitted: 0, compactions: 1 })
  })

  test(`your setting wins: Economy keeps warm when you say keep warm 2 h (${surface})`, { timeoutMs: 30000, options: inProfile('Economy', { beforeCold: 'keep warm 2 h' }).options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: inProfile('Economy', { beforeCold: 'keep warm 2 h' }).stored, commands: GROUNDWORK })
    await coldTurn(d, 't1')
    await h.advance(5 * HOUR)
    expect(NOTHING_DONE(h), 'not Economy\'s handoff').toEqual({ forks: 2, submitted: 0, compactions: 0 })
  })

  test(`your setting wins: Balanced stays quiet when you say off, and Quality asks when you say ask (${surface})`, { timeoutMs: 30000, options: inProfile('Balanced', { beforeCold: 'off' }).options }, async ($, on) => {
    const { h, d } = await coldSession($, on, { stored: inProfile('Balanced', { beforeCold: 'off' }).stored })
    await coldTurn(d, 't1')
    await h.advance(9 * HOUR)
    expect(NOTHING_DONE(h)).toEqual(NONE)
    expect(await bandText($, surface)).toBe('')
    // The same row, set to ask (the default value, but yours), under Quality: it asks.
    await d.config('profile', 'Quality')
    await d.config('beforeCold', 'ask')
    await coldOffer(h, d, 't2')
    expect(await bandText($, surface)).toContain('Cache goes cold at ')
    await h.advance(9 * HOUR)
    expect(NOTHING_DONE(h)).toEqual(NONE)
  })

  const SUB = { rateLimits: [{ kind: 'five_hour', percentUsed: 10 }] }
  test(`on a subscription the costs are window shares as ranges, with API-equivalent dollars (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await coldSession($, on, { rateLimits: SUB.rateLimits })
    await coldOffer(h, d, 't1')
    // No run has shown the window rate yet: dollars, said to be API-equivalent.
    expect(await bandText($, surface)).toBe('rightsize: Cache goes cold at 19:00 · coming back cold costs about $0.63 API-equivalent')
    expect((await bandButtons($)).map(b => b[1]).slice(0, 1)).toEqual(['Keep warm until 20:00 · ~$0.03'])
    expect((await openMenu($, h, { Options: 'More cache choices…' }, 2))[1]?.options.slice(0, 2)).toEqual(['Keep warm until 2:00 tomorrow · ~$0.13', 'Keep warm until 9:00 tomorrow · ~$0.24'])
    // 5% of the window for $1 of one turn, give or take a point: $0.63 is 2.5–3.8%, written in whole percent.
    h.files[LEGACY_RUNS] = `${JSON.stringify({ at: new Date(h.now).toISOString(), kind: 'run', actual: 1, before: { five_hour: 10 }, after: { five_hour: 15 } })}\n`
    await coldOffer(h, d, 't2')
    expect(await bandText($, surface)).toBe('rightsize: Cache goes cold at 19:05 · coming back cold costs ~3–4% ($0.63)')
    expect((await bandButtons($)).map(b => b[1]).slice(0, 1)).toEqual(['Keep warm until 20:05 · ~0.1–0.2% usage'])
    expect((await openMenu($, h, { Options: 'More cache choices…' }, 2))[1]?.options.slice(0, 2)).toEqual(['Keep warm until 2:05 tomorrow · ~0.5–0.8% usage', 'Keep warm until 9:00 tomorrow · ~1% usage'])
    // Keeping warm says what it cost in the window too.
    await pressBand($, 'cold-2h')
    await h.advance(57 * MIN)
    expect(await bandText($, surface)).toMatch(/^rightsize: Keeping warm until 20:05 · ~0\.1% used so far/)
    expect((await bandText($, surface)).split(' Session:')[0], 'no ping count, no dollars next to the share').not.toMatch(/\bpings?\b|\$/)
    await pressBand($, 'cold-stop')
    expect(await bandText($, surface)).toMatch(/^rightsize: Stopped keeping warm · ~0\.1% used\./)
  })

  test(`on a subscription before the rate is known the keep-warm line says ~dollars, and no percentage (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await coldSession($, on, { rateLimits: SUB.rateLimits })
    await coldOffer(h, d, 't1')
    await pressBand($, 'cold-2h')
    expect(await bandText($, surface)).toBe('rightsize: Keeping warm until 20:00 · nothing used yet')
    await h.advance(57 * MIN)
    expect(await bandText($, surface)).toMatch(/^rightsize: Keeping warm until 20:00 · ~\$0\.02 so far/)
    await pressBand($, 'cold-stop')
    expect(await bandText($, surface)).toMatch(/^rightsize: Stopped keeping warm · ~\$0\.02\./)
  })

  test(`the usual start time is 9:00 until the run log shows five days of first prompts (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await coldSession($, on)
    const day = (n: number) => JSON.stringify({ at: new Date(2027, 0, 15 - n, 9, 30).toISOString(), submittedAt: new Date(2027, 0, 15 - n, 6, 0).toISOString(), kind: 'run' })
    h.files[LEGACY_RUNS] = `${[1, 2, 3, 4].map(day).join('\n')}\n`
    await d.start(surface)
    await coldOffer(h, d, 't1')
    expect((await openMenu($, h, { Options: 'More cache choices…' }, 2))[1]?.options, 'four days: 9:00, not 6:00').toContain('Keep warm until 9:00 tomorrow · $0.24')
    expect(coldLog(h)).toContain('usual start 9:00 by default, 4 days of runs')
  })

  // ---- What the person answers: logged, learned, and asked about -----------------------------------------------

  /** Offers answered before, oldest first, in the old shared log (read at a session's start): one `cold` line each, a day apart. */
  const history = async (h: ReturnType<typeof engine>, d: ReturnType<typeof drive>, choices: string[]) => {
    h.files[LEGACY_RUNS] = `${choices.map((c, i) => JSON.stringify({ at: new Date(EVENING - (choices.length - i) * DAY).toISOString(), kind: 'cold', session: 'earlier', choice: c })).join('\n')}\n`
    await d.start(surface)
  }
  const coldChoices = (h: ReturnType<typeof engine>) =>
    (h.files[RUNS_FILE] ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l) as { kind?: string; choice?: string; session?: string }).filter(l => l.kind === 'cold').map(l => l.choice)

  test(`each answer to an offer is one cold line in the run log: the button or menu choice pressed (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await coldSession($, on, { commands: GROUNDWORK })
    await coldOffer(h, d, 't1')
    await pressBand($, 'cold-2h')
    expect(coldChoices(h)).toEqual(['2h'])
    const line = (h.files[RUNS_FILE] ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>).find(l => l.kind === 'cold')
    expect(line, 'a cold line names the session and the choice, and nothing else but its time').toEqual({ at: expect.any(String), kind: 'cold', session: 'sess-1', choice: '2h' })
    // Keep warm until 2:00 tomorrow and Until the usual start, then the handoff, Let it go cold and Don't offer again, from the ⋯ menu.
    await coldOffer(h, d, 't2')
    await openMenu($, h, { Options: 'More cache choices…', Cache: 'Keep warm until 2:05 tomorrow · $0.13' }, 2)
    await coldOffer(h, d, 't3')
    await openMenu($, h, { Options: 'More cache choices…', Cache: 'Save a handoff' }, 2)
    h.rating = NO_CHANGE
    await d.submit('continue')
    await coldOffer(h, d, 't4')
    await openMenu($, h, { Options: 'More cache choices…', Cache: 'More…', 'More cache': 'Let it go cold' }, 3)
    expect(coldChoices(h)).toEqual(['2h', '8h', 'handoff', 'let-go'])
  })

  test(`an offer nobody answers is logged ignored: when a prompt is sent, when a turn ends, or when the cache goes cold; once each (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await coldSession($, on)
    await coldOffer(h, d, 't1')
    h.rating = NO_CHANGE
    await d.submit('continue')
    expect(coldChoices(h), 'a prompt').toEqual(['ignored'])
    await coldTurn(d, 't2')
    expect(coldChoices(h), 'no offer was showing: the turn ending logs nothing more').toEqual(['ignored'])
    await h.advance(5 * MIN)
    expect(await bandText($, surface)).toContain('Cache goes cold')
    // Another turn ends with this offer still showing.
    await coldTurn(d, 't3')
    expect(coldChoices(h), 'a newer turn ended').toEqual(['ignored', 'ignored'])
    await h.advance(5 * MIN)
    expect(await bandText($, surface)).toContain('Cache goes cold')
    await h.advance(2 * HOUR)
    expect(coldChoices(h), 'the cache went cold').toEqual(['ignored', 'ignored', 'ignored'])
    // A press after that is no second outcome for the same offer.
    await pressBand($, 'cold-2h')
    expect(coldChoices(h)).toEqual(['ignored', 'ignored', 'ignored'])
    expect(NOTHING_DONE(h).forks, 'and keeps nothing warm').toBe(0)
  })

  test(`a cold line is no run: it is not shared, and it changes no report total (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await coldSession($, on)
    const saving = { at: new Date().toISOString(), kind: 'run', session: 'sess-1', change: 'lower', offered: 'lower', stay: 0.4, taken: 0.1, actual: 0.1, overhead: 0 }
    h.files[LEGACY_RUNS] = `${JSON.stringify(saving)}\n`
    h.now = Date.now()
    const before = (await d.command('report')).text
    await d.start(surface)
    await coldOffer(h, d, 't1')
    await pressBand($, 'cold-2h')
    expect(coldChoices(h)).toEqual(['2h'])
    const after = (await d.command('report')).text
    expect(after).toBe(before)
  })

  test(`the cache row's one button is the choice picked most in the last 10 answered offers; the rest are in the ⋯ menu in the usual order (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await coldSession($, on)
    // 8 hours three times, 2 hours once, and ignored offers, which are no answer.
    await history(h, d, ['8h', 'ignored', '8h', '2h', 'ignored', '8h'])
    await coldOffer(h, d, 't1')
    expect(await bandButtons($), 'the one picked most').toEqual([['cold-8h', 'Keep warm until 2:00 tomorrow · $0.13'], ['mode', '⋯'], ['close', '×']])
    expect(await bandText($, surface), 'the line is the same').toBe('rightsize: Cache goes cold at 19:00 · coming back cold costs about $0.63')
    const asks = await openMenu($, h, { Options: 'More cache choices…', Cache: 'More…' }, 3)
    expect(asks.map(a => a.options), 'the others, in the fixed order, without the one on the row').toEqual([
      ['More cache choices…', 'When the band shows…'],
      ['Keep warm until 20:00 · $0.03', 'Keep warm until 9:00 tomorrow · $0.24', 'Compact now', 'More…'],
      ['Let it go cold', "Don't offer again"],
    ])
    await pressBand($, 'cold-8h')
    expect(await bandText($, surface)).toBe('rightsize: Keeping warm until 2:00 · nothing used yet')
  })

  test(`the one button looks back over 10 answers only, and a tie goes to the most recent (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await coldSession($, on)
    // Seven answers of 8 hours, 4 of them before the last 10; in the last 10: 2 hours five times, 8 hours three times, Let it go cold twice.
    await history(h, d, ['8h', '8h', '8h', '8h', '2h', '8h', '2h', '8h', '2h', 'let-go', '2h', '8h', '2h', 'let-go'])
    await coldOffer(h, d, 't1')
    expect((await bandButtons($))[0]).toEqual(['cold-2h', 'Keep warm until 20:00 · $0.03'])
    await h.advance(2 * HOUR)
    // A tie: 8 hours and 2 hours twice each; the 8 hours was picked last.
    await history(h, d, ['let-go', '2h', '8h', '2h', '8h'])
    await coldOffer(h, d, 't2')
    expect((await bandButtons($))[0], 'the tie goes to the most recent').toEqual(['cold-8h', 'Keep warm until 4:05 tomorrow · $0.13'])
  })

  test(`a learned choice this offer does not have is passed over: the default button stands (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    // Groundwork was installed, and a handoff picked twice; now it is not, so the offer has Compact now and no handoff.
    const { h, d } = await coldSession($, on)
    await history(h, d, ['handoff', 'handoff'])
    await coldOffer(h, d, 't1')
    expect((await bandButtons($))[0], 'today\'s default: the first priced keep-warm choice').toEqual(['cold-2h', 'Keep warm until 20:00 · $0.03'])
    // With Groundwork the handoff is the button; with nothing priced, the handoff or the compaction is the default.
    h.commands = GROUNDWORK
    await history(h, d, ['handoff', '2h', 'handoff'])
    await coldOffer(h, d, 't2')
    expect((await bandButtons($))[0]).toEqual(['cold-handoff', 'Save a handoff'])
  })

  test(`the one button can be a choice with no price: Let it go cold (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await coldSession($, on)
    await history(h, d, ['let-go', '2h', 'let-go'])
    await coldOffer(h, d, 't1')
    expect((await bandButtons($))[0]).toEqual(['cold-let-go', 'Let it go cold'])
    await pressBand($, 'cold-let-go')
    expect(await bandText($, surface)).toBe('')
    expect(coldChoices(h)).toEqual(['let-go'])
  })

  const ALWAYS = [
    { choice: '2h', question: 'Always keep warm 2 hours?', value: 'keep warm 2 h', commands: [] as typeof GROUNDWORK },
    { choice: '8h', question: 'Always keep warm 8 hours?', value: 'keep warm 8 h', commands: [] as typeof GROUNDWORK },
    { choice: 'handoff', question: 'Always save a handoff?', value: 'save a handoff', commands: GROUNDWORK },
    { choice: 'compact', question: 'Always compact?', value: 'compact', commands: [] as typeof GROUNDWORK },
  ]
  for (const a of ALWAYS) {
    test(`after 3 answers of ${a.choice} the next offer asks "${a.question}" once; Yes sets the /config row and does it now (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
      const { h, d } = await coldSession($, on, { commands: a.commands })
      await history(h, d, ['let-go', a.choice, a.choice, a.choice])
      await coldOffer(h, d, 't1')
      expect(await bandText($, surface)).toBe(`rightsize: ${a.question}`)
      const buttons = await bandButtons($)
      expect(buttons.slice(0, 2), 'Yes and No, then the usual button').toEqual([['cold-ask-yes', 'Yes'], ['cold-ask-no', 'No']])
      expect(buttons[2]?.[0]).toBe(`cold-${a.choice}`)
      await pressBand($, 'cold-ask-yes')
      expect(h.sets.filter(x => x.key === 'rightsize.beforeCold').map(x => x.value)).toEqual([a.value])
      expect(h.stored.beforeCold, 'written to settings.json as the person\'s own').toBe(a.value)
      expect(last(h.toasts)).toBe(`Rightsize: Before the cache goes cold is now "${a.value}". It is the row in /config; set it back any time.`)
      expect(await settingsText(d), 'the row shows it').toContain(`Before the cache goes cold: ${a.value}`)
      expect(coldChoices(h), 'the answer is the choice').toEqual([a.choice])
      // This offer's choice is done now, as its button would have done it.
      if (a.choice === 'handoff') expect(h.submitted.map(x => x.text)).toEqual(['wrap up'])
      else if (a.choice === 'compact') expect(h.compactions).toBe(1)
      else expect(await bandText($, surface)).toBe('rightsize: Keeping warm until ' + (a.choice === '2h' ? '20:00' : '2:00') + ' · nothing used yet')
      // The row now decides: no more offers.
      await d.step('t2')
      await d.complete('t2')
      await h.advance(10 * MIN)
      expect(await bandText($, surface)).not.toContain('Always')
    })
  }

  test(`No to "Always …?" keeps the offer and the question is never asked again, in this session or the next (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await coldSession($, on)
    await history(h, d, ['2h', '2h', '2h'])
    await coldOffer(h, d, 't1')
    await pressBand($, 'cold-ask-no')
    expect(await bandText($, surface), 'the offer, as it was').toBe('rightsize: Cache goes cold at 19:00 · coming back cold costs about $0.63')
    expect((await bandButtons($))[0]).toEqual(['cold-2h', 'Keep warm until 20:00 · $0.03'])
    expect(h.sets.filter(x => x.key === 'rightsize.beforeCold')).toEqual([])
    await coldOffer(h, d, 't2')
    expect(await bandText($, surface), 'not asked twice').toContain('Cache goes cold')
    await d.start(surface)
    await coldOffer(h, d, 't3')
    expect(await bandText($, surface), 'not in the next session').toContain('Cache goes cold')
  })

  test(`"Always …?" is asked once whatever happens to it: an ignored question is not asked again (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await coldSession($, on)
    await history(h, d, ['8h', '8h', '8h'])
    await coldOffer(h, d, 't1')
    expect(await bandText($, surface)).toBe('rightsize: Always keep warm 8 hours?')
    await coldOffer(h, d, 't2')
    expect(await bandText($, surface)).toContain('Cache goes cold')
    expect(coldChoices(h), 'the question went unanswered: that offer was ignored').toEqual(['ignored'])
  })

  test(`3 different answers, or a choice with no row value, make no "Always …?" (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await coldSession($, on)
    await history(h, d, ['2h', '8h', '2h'])
    await coldOffer(h, d, 't1')
    expect(await bandText($, surface)).toContain('Cache goes cold')
    await history(h, d, ['let-go', 'let-go', 'let-go'])
    await coldOffer(h, d, 't2')
    expect(await bandText($, surface), 'Let it go cold has no row value').toContain('Cache goes cold')
    await history(h, d, ['2h', '2h', 'ignored', '2h'])
    await coldOffer(h, d, 't3')
    expect(await bandText($, surface), 'ignored offers are no answers: the last 3 answers were 2 hours').toBe('rightsize: Always keep warm 2 hours?')
  })

  test(`after 5 ignored offers the next one asks "Stop offering to keep the cache warm?" once; Yes is Don't offer again (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await coldSession($, on)
    for (let i = 1; i <= 5; i++) {
      await coldOffer(h, d, `t${i}`)
      expect(await bandText($, surface), `offer ${i}`).toContain('Cache goes cold')
      await h.advance(2 * HOUR)
    }
    expect(coldChoices(h), 'the cache went cold on every one').toEqual(['ignored', 'ignored', 'ignored', 'ignored', 'ignored'])
    expect(h.sets.filter(x => x.key === 'rightsize.beforeCold'), 'rightsize never turns the offer off by itself').toEqual([])
    await coldOffer(h, d, 't6')
    expect(await bandText($, surface)).toBe('rightsize: Stop offering to keep the cache warm?')
    expect((await bandButtons($)).map(b => b[1])).toEqual(['Yes', 'No', '⋯', '×'])
    // The menu still has every choice, the one that would have been the button too.
    const asks = await openMenu($, h, { Options: 'More cache choices…', Cache: 'More…' }, 3)
    expect(asks[1]?.options.slice(0, 2)).toEqual(['Keep warm until 6:25 · $0.03', 'Keep warm until 12:25 · $0.13'])
    await pressBand($, 'cold-ask-yes')
    expect(last(h.sets)).toMatchObject({ key: 'rightsize.beforeCold', value: 'off' })
    expect(h.stored.beforeCold).toBe('off')
    expect(last(h.toasts)).toBe('Rightsize: Before the cache goes cold is now "off". It is the row in /config; set it back any time.')
    expect(await bandText($, surface), 'the offer closes').toBe('')
    expect(coldChoices(h).slice(-1), 'the same as Don\'t offer again').toEqual(['off'])
  })

  test(`No to stopping keeps the offer, and it is never asked again (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await coldSession($, on)
    await history(h, d, ['ignored', 'ignored', 'ignored', 'ignored', 'ignored'])
    await coldOffer(h, d, 't1')
    expect(await bandText($, surface)).toBe('rightsize: Stop offering to keep the cache warm?')
    await pressBand($, 'cold-ask-no')
    expect(await bandText($, surface)).toContain('Cache goes cold')
    expect(h.sets.filter(x => x.key === 'rightsize.beforeCold')).toEqual([])
    // Still ignoring: no second question, and the offer keeps coming.
    await h.advance(2 * HOUR)
    await coldOffer(h, d, 't2')
    await h.advance(2 * HOUR)
    await coldOffer(h, d, 't3')
    expect(await bandText($, surface)).toContain('Cache goes cold')
    expect(h.stored.beforeCold).toBeUndefined()
  })

  test(`4 ignored offers, or 5 with an answer among them, ask nothing (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await coldSession($, on)
    await history(h, d, ['ignored', 'ignored', 'ignored', 'ignored'])
    await coldOffer(h, d, 't1')
    expect(await bandText($, surface)).toContain('Cache goes cold')
    await history(h, d, ['ignored', 'ignored', 'let-go', 'ignored', 'ignored'])
    await coldOffer(h, d, 't2')
    expect(await bandText($, surface)).toContain('Cache goes cold')
  })

}

// ---- The settings pane: bare /rightsize ----------------------------------------------------------------------

for (const surface of ['desktop', 'terminal'] as const) {
  const PANE_ID = 'rightsize-menu'
  const MIN = 60_000
  const HOUR = 60 * MIN
  const start = async ($: unknown, on: Parameters<TestBody>[1], over: { stored?: Record<string, string> } = {}) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium', ...(over.stored ? { stored: over.stored } : {}) })
    const d = drive($, h)
    await d.start(surface)
    return { h, d }
  }
  const selectOf = async (ui: Mounted, key: SettingKey) => (await ui.find({ type: 'Select', key: `row-${key}` }))?.props
  /** The Selects of the pane and the heading, in the order drawn. */
  const drawn = async (ui: Mounted) => {
    const root = (await ui.findAll({ type: 'Box' }))[0]
    return (root?.children ?? []).map(c => (typeof c === 'string' ? c : c.type === 'Select' ? c.props?.key : String(c.children?.[0])))
  }

  test(`bare /rightsize opens the pane and asks nothing; /rightsize status is the old summary (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await start($, on)
    const opened = (await d.command('')).text ?? ''
    expect(h.paneOpens, 'one pane, focused, Esc closes it, toasts held').toEqual([{ id: PANE_ID, title: 'Rightsize', focus: true, closeOnEscape: true, holdToasts: true }])
    expect(opened).toContain('settings are open in a pane')
    expect(opened, 'the summary moved').not.toContain('Profile: Balanced')
    expect(h.asked, 'no question').toEqual([])
    expect(h.paneCloses).toEqual([])
    const status = (await d.command('status')).text ?? ''
    expect(status.startsWith('Profile: Balanced')).toBe(true)
    expect(status).toContain('All 28 settings are at their defaults')
    expect(status.endsWith('Commands: /rightsize help')).toBe(true)
    expect(h.paneOpens.length, 'status opens no pane').toBe(1)
  })

  test(`the pane lists every row of the settings table in order, Profile first, the Advanced ones under a heading, each with its value (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { d } = await start($, on)
    await d.command('')
    const ui = await mountPane($, surface)
    const selects = await ui.findAll({ type: 'Select' })
    expect(selects.map(x => x.key), 'every row, in the table\'s order').toEqual(KEYS.map(k => `row-${k}`))
    for (const key of KEYS) {
      const p = await selectOf(ui, key)
      expect(p?.value, key).toBe(SETTINGS[key].default)
      expect(p?.options?.map(o => o.value), key).toEqual([...SETTINGS[key].options])
      expect(p?.label, key).toBe(`${plainTitle(SETTINGS[key].title)} (default)`)
    }
    const order = await drawn(ui)
    expect(order[0], 'the keys, above the rows').toContain('Tab: next setting · ↑↓: choose a value · Enter: set · Esc: close.')
    expect(order.indexOf('row-profile'), 'Profile first, above the heading').toBe(1)
    expect(order[2], 'the heading').toBe('Advanced')
    expect(order.filter(x => x === 'Advanced').length).toBe(1)
    expect(order.slice(3), 'the Advanced rows follow it, in order').toEqual(KEYS.slice(1).map(k => `row-${k}`))
    await ui.unmount()
  })

  const SET_TWO = { options: { floor: 'medium', band: 'always' }, stored: { floor: 'medium', band: 'always' } }
  test(`a row you set is marked yours; the rest are tagged default (${surface})`, { timeoutMs: 30000, options: SET_TWO.options }, async ($, on) => {
    const { d } = await start($, on, { stored: SET_TWO.stored })
    const ui = await mountPane($, surface)
    expect(await selectOf(ui, 'floor')).toMatchObject({ label: 'Lowest effort (yours)', value: 'medium' })
    expect(await selectOf(ui, 'band')).toMatchObject({ label: 'Band (yours)', value: 'always' })
    expect(await selectOf(ui, 'ceiling')).toMatchObject({ label: 'Highest effort (default)' })
    await ui.unmount()
    // A change in /config shows too.
    await d.config('handOff', '60%')
    const again = await mountPane($, surface)
    expect(await selectOf(again, 'handOff')).toMatchObject({ label: 'Hand-off threshold (yours)', value: '60%' })
    await again.unmount()
  })

  test(`picking a value writes the /config row as yours, follows it, and draws the pane again: Band off hides the band (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await start($, on)
    await d.step('t0')
    await d.complete('t0')
    h.rating = NO_CHANGE
    await setBand($, 'always')
    await d.submit(LOOKUP)
    expect(await bandText($, surface)).toBe('rightsize: No change: medium on Opus fits this prompt.')
    await d.command('')
    const ui = await mountPane($, surface)
    const before = h.sets.length
    await ui.select({ key: 'row-band', value: 'off' })
    expect(h.sets.slice(before).map(x => [x.key, x.value]), 'written once, to the /config row').toEqual([['rightsize.band', 'off']])
    expect(h.stored.band, 'as the person\'s own setting').toBe('off')
    expect(await bandText($, surface), 'the side effect ran: the band is hidden').toBe('')
    expect(await selectOf(ui, 'band'), 'the open pane drew again').toMatchObject({ label: 'Band (yours)', value: 'off' })
    expect(((await d.command('status')).text ?? '')).toContain('  Band: off')
    await ui.unmount()
  })

  test(`a change in the pane runs what /config does after a change, once: Before the cache goes cold off stops a keep-warm run (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await start($, on)
    h.now = Date.UTC(2027, 0, 15, 18)
    h.virtual = true
    h.stepUsage = BIG_TURN
    await d.config('beforeCold', 'keep warm 8 h')
    await d.step('t1')
    await d.complete('t1')
    await h.advance(57 * MIN)
    expect(h.forks.length).toBe(1)
    const ui = await mountPane($, surface)
    await ui.select({ key: 'row-beforeCold', value: 'off' })
    await ui.unmount()
    await h.advance(8 * HOUR)
    expect(h.forks.length, 'no more pings').toBe(1)
    const log = h.files[LOG_PATH] ?? ''
    expect(log.split('keep warm stopped (Before the cache goes cold changed)').length - 1, 'followRow ran once').toBe(1)
  })

  test(`picking Profile draws every row again and changes what is in use (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await start($, on)
    const ui = await mountPane($, surface)
    await ui.select({ key: 'row-profile', value: 'Economy' })
    expect(await selectOf(ui, 'profile')).toMatchObject({ label: 'Profile (yours)', value: 'Economy' })
    expect(last(h.sets)).toMatchObject({ key: 'rightsize.profile', value: 'Economy' })
    expect(((await d.command('status')).text ?? '').startsWith('Profile: Economy')).toBe(true)
    // A rule row set to "not set" goes back to unset, not yours.
    await ui.select({ key: 'row-lowerRule', value: 'never lower' })
    expect(await selectOf(ui, 'lowerRule')).toMatchObject({ label: 'Lowering (yours)', value: 'never lower' })
    await ui.select({ key: 'row-lowerRule', value: 'not set' })
    expect(await selectOf(ui, 'lowerRule')).toMatchObject({ label: 'Lowering (default)', value: 'not set' })
    await ui.unmount()
  })

  test(`a change in /config while the pane is open draws it again (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { d } = await start($, on)
    const ui = await mountPane($, surface)
    await d.config('rater', 'haiku')
    expect(await selectOf(ui, 'rater')).toMatchObject({ label: 'Rater (yours)', value: 'haiku' })
    await ui.unmount()
  })

  const BAND_PAGE = [...Array<string>(7).fill('More…'), 'Band: when it acts']
  test(`with no pane placed it asks instead: pick a row shown as Row: value (paged), pick its value, back to the rows, until Done (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await start($, on)
    h.panePlaced = false
    h.answerQueue = { Setting: ['More…', 'Done'], 'More rows': BAND_PAGE, Value: ['off'] }
    const r = (await d.command('')).text ?? ''
    expect(h.paneCloses, 'the unplaced pane is closed, not left open').toEqual([PANE_ID])
    expect(h.asked[0]?.options, 'Done first, then the rows as Row: value, three to a page').toEqual(['Done', 'Profile: Balanced', 'Lowest effort: low', 'More…'])
    expect(h.asked[1]?.options).toEqual(['Highest effort: max', 'Lowering: not set', 'Raising: not set', 'More…'])
    const value = h.asked.find(a => a.options.includes('off (current)') || a.options.includes('when it acts (current)'))
    expect(value?.options, 'the values of the row, the current one marked').toEqual(['when it acts (current)', 'always', 'off'])
    expect(value?.question).toContain('Band: now when it acts (default)')
    expect(last(h.sets)).toMatchObject({ key: 'rightsize.band', value: 'off' })
    expect(h.stored.band).toBe('off')
    expect(h.asked.slice(-1)[0]?.options.slice(0, 1), 'back to the rows, which show the new value').toEqual(['Done'])
    expect(h.asked.slice(-1)[0]?.options.length).toBe(4)
    expect(r).toBe('Changed Band: off.')
    expect(((await d.command('status')).text ?? '')).toContain('  Band: off')
  })

  test(`the question loop ends on a dismissed question, and a dismissed value changes nothing (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { h, d } = await start($, on)
    h.panePlaced = false
    h.answers = {}
    expect((await d.command('')).text, 'dismissed at once').toBe('No setting changed.')
    h.answerQueue = { Setting: ['Profile: Balanced', 'Done'] }
    expect((await d.command('')).text, 'the value was dismissed: back to the rows').toBe('No setting changed.')
    h.answerQueue = { Setting: ['Profile: Balanced', 'Done'], Value: ['Balanced (current)'] }
    expect((await d.command('')).text, 'the current value again: nothing to write').toBe('No setting changed.')
    expect(h.sets.filter(x => x.key === 'rightsize.profile')).toEqual([])
    h.answerQueue = { Setting: ['Profile: Balanced', 'Done'], Value: ['Quality'] }
    expect((await d.command('')).text).toBe('Changed Profile: Quality.')
  })
}

test('on the mobile app, which has no picker, bare /rightsize asks at once, and the pane lists the rows with a button that asks', async ($, on) => {
  const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
  const d = drive($, h)
  await d.start('mobile')
  h.answerQueue = { Setting: ['Profile: Balanced', 'Done'], Value: ['Quality'] }
  expect((await d.command('')).text).toBe('Changed Profile: Quality.')
  expect(h.paneOpens, 'no pane for a surface with no picker').toEqual([])
  const ui = await mountPane($, 'mobile')
  expect(await ui.findAll({ type: 'Select' })).toEqual([])
  expect((await ui.find({ type: 'Text', text: /^Profile/ }))?.text).toBe('Profile (yours): Quality')
  expect((await ui.find({ type: 'Text', text: /^Band/ }))?.text).toBe('Band (default): when it acts')
  h.answerQueue = { Setting: ['Profile: Quality', 'Done'], Value: ['Economy'] }
  await ui.press({ key: 'change' })
  await ui.unmount()
  expect(last(h.sets)).toMatchObject({ key: 'rightsize.profile', value: 'Economy' })
})
