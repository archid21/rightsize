// Shared helpers for the register.*.test.ts files: the engine stand-in, the band and pane drivers and the constants.
import { type TestBody } from 'claude-code/testing'
import { KEYS, inOptions } from './settings'

declare const setTimeout: (fn: (...a: unknown[]) => void, ms: number) => unknown

// Typed loosely: the AskUserQuestion matcher's full type is too deep for tsc.
export type AskInput = { questions: { question: string; header?: string; options?: { label: string }[] }[] }
export type LooseOn = (event: 'tool.call', match: object, hook: (api: unknown, e: AskInput) => Promise<unknown>) => void
export type StepInput = { effort?: string; model?: string; turnId: string; index: number; agentId?: string }
export type LooseStep = (event: 'turn.step', hook: (api: unknown, e: StepInput) => AsyncGenerator<never, unknown>) => void
export type Run = { text?: string }
export type Engine = {
  session: { start: (x: unknown) => Promise<unknown> }
  prompt: { submit: (x: unknown) => Promise<unknown>; attachment: (x: unknown) => Promise<unknown> }
  turn: { start: (x: unknown) => Promise<unknown>; step: (x: unknown) => unknown; complete: (x: unknown) => Promise<unknown> }
  tool: { call: (x: unknown) => Promise<unknown> }
  agent: { spawn: (x: unknown) => Promise<unknown> }
  command: { run: (x: unknown) => Promise<Run> }
}

/** Where this session's logs go: its own folder, and only its own. */
export const LOGS = '/home/test/.claude/mods-logs'
export const SESSION_DIR = `${LOGS}/rightsize/sess-1`
export const RUNS_FILE = `${SESSION_DIR}/runs.jsonl`
export const SWITCHES_FILE = `${SESSION_DIR}/switches.jsonl`
export const LOG_PATH = `${SESSION_DIR}/rightsize.log`
/** whatsnext's plugin folder in the fake's list of installed plugins, and the project folder it is started in. */
export const WHATSNEXT_ROOT = '/plugins/whatsnext'
export const WHATSNEXT_SCRIPT = `${WHATSNEXT_ROOT}/skills/whatsnext/scripts/whatsnext.py`
export const WHATSNEXT_CMDS = [{ name: 'whatsnext:whatsnext', description: 'whatsnext', source: 'plugin', plugin: 'whatsnext' }]
/** The prompt whatsnext's `compact-instructions --json` hands over. */
export const WHATSNEXT_COMPACT = '/compact Keep: the task. Handoff: docs/project/HANDOFF.md says where the work stands.'
/** What follows `/compact ` there: the arguments the slash command runs with. */
export const WHATSNEXT_ARGS = WHATSNEXT_COMPACT.slice('/compact '.length)
/** What `compact-instructions --json` prints; the fields rightsize reads are the first two. */
export const wnAnswer = (wrapUpFirst: boolean, project = true) =>
  JSON.stringify({ instructions: WHATSNEXT_ARGS, compact_prompt: WHATSNEXT_COMPACT, handoff: 'docs/project/HANDOFF.md', handoff_exists: true, wrap_up_first: wrapUpFirst, wrap_up_state: wrapUpFirst ? 'none' : 'written', wrap_up_prompt: 'wrap up', project, session_found: true }, null, 2)
/** Makes whatsnext installed (its commands, its entry in installed_plugins.json, its script), and the project `whatsnext init`-ed unless `initialized` is false. */
export function installWhatsnext(h: { commands: { name: string; description: string; source: string; plugin?: string }[]; files: Record<string, string>; cwd: string; wnReply: { exitCode: number; stdout: string; stderr?: string } }, over: { initialized?: boolean; listed?: boolean } = {}) {
  h.commands = WHATSNEXT_CMDS
  if (over.listed !== false) {
    h.files['/home/test/.claude/plugins/installed_plugins.json'] = JSON.stringify({ version: 2, plugins: { 'whatsnext@whatsnext': [{ scope: 'user', installPath: WHATSNEXT_ROOT, version: '0.0.1', lastUpdated: '2026-11-01T00:00:00.000Z' }] } })
    h.files[WHATSNEXT_SCRIPT] = '#!/usr/bin/env python3\n'
  } else {
    delete h.files['/home/test/.claude/plugins/installed_plugins.json']
    delete h.files[WHATSNEXT_SCRIPT]
  }
  // Whether the folder is a whatsnext project is whatsnext's answer (`project` in compact-instructions --json), not a file rightsize reads.
  if (over.initialized === false) h.wnReply = { exitCode: 0, stdout: wnAnswer(false, false) }
}
/** What core returns when the person says no at the permission prompt. */
export const REJECTED = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed."
/** The shared files of 0.7 and before: still read, never written. */
export const LEGACY_RUNS = `${LOGS}/rightsize-runs.jsonl`
export const LEGACY_SWITCHES = `${LOGS}/rightsize-switches.jsonl`

export const LOOKUP = 'what does the parseConfig function in src/config.ts return exactly'
export const DEBUG = 'find and fix the race in token refresh across the auth services please'
/** An answer for h.answers: nobody is there, so the question is never answered. */
export const NO_ONE = '(no one answers)'
export const SEARCH = 'find every call site of the old logger across the whole repo and list them'
export const REVIEW = '{"level":"high","model":"opus","size":"small","type":"review","read":30000,"write":3000,"steps":10,"reason":"subtle bug hunt"}'
export const NO_CHANGE = '{"level":"medium","model":"same","size":"small","type":"lookup","read":2000,"write":300,"steps":1}'
/** Stored rows that turn Before the cache goes cold off. It has no size bar: a small session gets a keep-warm row too, so a test that is about something else on the band sets this. */
export const NO_COLD = { beforeCold: 'off' }
export const FREE_SWITCHES = { 'cache:effort-switch': { n: 20, ratio: 0 } }
/** A main request that read 80,500 tokens: on Opus a cold return costs $0.63, over the $0.50 bar for Before the cache goes cold. */
export const BIG_TURN = { input_tokens: 200, output_tokens: 400, cache_read_input_tokens: 80_000, cache_creation_input_tokens: 300 }
// A report table row's cells (session, 7 days, 30 days), by its label.
export const cellsOf = (text: string, label: string) => text.split('\n').find(l => l.startsWith(`  ${label}`))?.slice(2 + label.length).trim().split(/ {2,}/)

export function h$(api: { ui: { resolve: (e: never) => { Box: unknown } } }, e: unknown) {
  return h(api.ui.resolve(e as never).Box as never, {}) as never
}

// Stands for the engine beneath the plugin, and records what reaches it.
export function engine(reg: LooseOn & LooseStep & Parameters<TestBody>[1], start: { model: string; effort: string; store?: Record<string, unknown>; stored?: Record<string, string>; configKey?: string }) {
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
    /** The test's `$`, which `drive` hands over: band questions are answered by pressing their buttons through it. */
    test$: undefined as unknown,
    /** The question the band shows now, as rightsize last wrote it; the ids already answered from `answers`. */
    question: null as BandAsk | null,
    bandAnswered: new Set<number>(),
    /** Headers whose band answer came after the question had gone: the press found nothing to press. */
    tooLate: [] as string[],
    sent: [] as { effort?: string; model?: string; agentId?: string; turnId: string }[],
    submitted: [] as { text: string; context?: readonly string[] }[],
    logs: [] as string[],
    filled: [] as string[],
    /** startDayOne: the day-one tip was shown already, so a session on Opus does not open with its band (the tests of the tip clear it). */
    store: { startDayOne: true, ...(start.store ?? {}) } as Record<string, unknown>,
    ratings: 0,
    now: 1_800_000_000_000,
    page: '',
    fetches: 0,
    /** POST requests: rightsize sends none. */
    posts: [] as { url: string; body: string }[],
    /** The address of every GET: only the pricing page. */
    urls: [] as string[],
    // A session told to write the 1-hour cache everywhere, as Claude Code's own variables say it: the fixtures' prices and
    // times were set under one life. register.ttl.test.ts clears these to test how the life is read.
    env: { CLAUDE_CODE_PROMPT_CACHE_TTL: '1h', CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '1h' } as Record<string, string>,
    hold: null as Promise<void> | null,
    /** A Bash command that starts "slow" waits for this. */
    toolGate: null as Promise<void> | null,
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
    /** Other top-level settings a read of one key returns (`idleCompaction`, `autoCompactEnabled`). */
    settings: {} as Record<string, unknown>,
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
    /** The system text of every model.complete call, in order: what a separate call's own cache prefix is made of. */
    completionSystems: [] as string[],
    /** Every key each $.model.fork call was given, in order: a keep-warm request may carry only its prompt. */
    forkKeys: [] as string[][],
    /** The conversation as $.session.messages() reports it: Claude's last reply is what the rater is shown. */
    messages: [{ role: 'assistant', text: 'Done: the change is in.' }] as { role: string; text: string }[],
    /** The transcript file's tail as the cold-return check reads it (JSONL); undefined: this session has no transcript file. */
    transcript: undefined as string | undefined,
    /** How many times the transcript was looked for. */
    lookups: 0,
    /** True: finding or reading the transcript fails to start. */
    transcriptFails: false,
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
    /** What each $.session.compact() call was given. */
    compactCalls: [] as unknown[],
    compactSkip: undefined as string | undefined,
    /** The sizes a compaction reports (`tokensBefore`, `tokensAfter`); left out, the engine reports none. */
    compactTokens: undefined as { before: number; after: number } | undefined,
    /** Every $.state.set, in order: the key, the plugin it was given with (a bare name has none) and the value. */
    stateWrites: [] as { key: string; plugin?: string; value: unknown }[],
    /** What $.session.cwd() answers; `git rev-parse --show-toplevel` answers it too, so it is the project folder. */
    cwd: '/repo',
    /** Every slash command the plugin ran with $.command.run, and a reason to make the next one fail. */
    commandRuns: [] as { command: string; args?: string }[],
    commandRunFails: undefined as string | undefined,
    /** Every whatsnext.py run (python3 ...), as its arguments. */
    wnRuns: [] as string[][],
    /** What the next whatsnext.py runs answer, in order; when none is left, `wnReply`. */
    wnReplies: [] as { exitCode: number; stdout: string; stderr?: string }[],
    wnReply: { exitCode: 0, stdout: wnAnswer(false) } as { exitCode: number; stdout: string; stderr?: string },
    /** True: sleeps are on a virtual clock. They end only when `advance` reaches them, and the clock moves to each one's time. */
    virtual: false,
    sleepers: [] as { due: number; release: () => void }[],
    /** Every wait the plugin asked $.clock.sleep for, and every $.clock.after, in ms: a long wait has to be an `after`, which does not hang on a hook's budget. */
    sleeps: [] as number[],
    afters: [] as number[],
    /** Every repeating timer the plugin asked $.clock.every for, in ms. */
    everies: [] as number[],
    /** True: the repeating timer fires on the virtual clock. Off by default: a long advance would run every 3-second tick. */
    ticks: false,
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
  reg('session.start', async ($, e) => {
    h.surfaces = e.surface ? [e.surface] : []
    return { cwd: e.cwd } as never
  })
  reg('session.surfaces', async () => ({ value: h.surfaces }) as never)
  reg('ui.open', async ($, e) => {
    h.paneOpens.push(e as (typeof h.paneOpens)[number])
    return { value: h.panePlaced ? { isPlaced: true } : { isPlaced: false, reason: 'no surface draws panes' } } as never
  })
  reg('ui.close', async ($, e) => {
    h.paneCloses.push((e as { id: string }).id)
    return { value: undefined } as never
  })
  reg('command.register', async () => ({ value: undefined }) as never)
  // A repeating timer: on the virtual clock it ends each time `advance` reaches its next tick, so the plugin's callback runs once per tick.
  reg('clock.every', async ($, e) => {
    const ms = (e as { ms: number }).ms
    h.everies.push(ms)
    if (h.virtual && h.ticks) await new Promise<void>(release => h.sleepers.push({ due: h.now + ms, release }))
    return { value: undefined } as never
  })
  // The merged settings, as the engine holds them: a read of one key is this object, projected.
  reg('settings.read', async ($, e) => {
    if (h.settingsFail) throw new Error('settings could not be read')
    const all: Record<string, unknown> = { pluginConfigs: { other: { options: { floor: 'high' } }, ...(Object.keys(h.stored).length ? { [h.configKey]: { options: h.stored } } : {}) }, ...h.settings }
    const key = (e as { key?: string }).key
    return { value: key === undefined ? all : all[key] } as never
  })
  reg('session.messages', async () => {
    if (h.messagesFail) throw new Error('messages could not be read')
    return { value: h.messages } as never
  })
  reg('session.cwd', async () => ({ value: h.cwd }) as never)
  reg('session.id', async () => ({ value: h.sessionId }) as never)
  reg('session.model', async () => ({ value: h.liveModel ?? h.model }) as never)
  reg('session.usage', async ($, e) => {
    const breakdown = (e as { breakdown?: string }).breakdown && h.breakdown ? { breakdown: h.breakdown } : {}
    return { value: { startedAt: 0, context: { window: 200_000, ...(h.contextTokens === undefined ? {} : { tokens: h.contextTokens }), ...breakdown }, rateLimits: h.rateLimits, ...(h.ledger === undefined ? {} : { cost: { usd: h.ledger } }) } } as never
  })
  reg('fs.exists', async ($, e) => {
    const { path } = e as { path: string }
    return { value: path.endsWith('/prices.json') ? h.pricesFile !== '' : path in h.files } as never
  })
  reg('fs.read', async ($, e) => {
    const { path } = e as { path: string }
    return { value: path.endsWith('/prices.json') ? h.pricesFile : (h.files[path] ?? '') } as never
  })
  reg('fs.write', async ($, e) => {
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
  reg('fs.list', async ($, e) => {
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
  reg('clock.now', async () => ({ value: h.now }) as never)
  // A timer: the plugin keeps its callback and cancels it itself. Not on the virtual clock, it never fires.
  reg('clock.after', async ($, e) => {
    const ms = (e as { ms: number }).ms
    h.afters.push(ms)
    if (!h.virtual) await new Promise(() => {})
    await new Promise<void>(release => h.sleepers.push({ due: h.now + ms, release }))
    return { value: undefined } as never
  })
  reg('clock.sleep', async ($, e) => {
    h.sleeps.push((e as { ms: number }).ms)
    if (h.virtual) {
      await new Promise<void>(release => h.sleepers.push({ due: h.now + (e as { ms: number }).ms, release }))
      return { value: undefined } as never
    }
    if (!h.sleepEnds) await new Promise(() => {})
    await new Promise(r => setTimeout(r, 25))
    return { value: undefined } as never
  })
  reg('env.get', async ($, e) => {
    const name = (e as { name: string }).name
    return { value: name === 'HOME' ? '/home/test' : h.env[name] } as never
  })
  reg('http.fetch', async ($, e) => {
    const { url, init } = e as { url: string; init?: { method?: string; body?: string } }
    if (init?.method === 'POST') {
      h.posts.push({ url, body: init.body ?? '' })
      return { value: { status: 200, ok: true, headers: {}, text: '{"accepted":1}' } } as never
    }
    h.fetches += 1
    h.urls.push(url)
    if (h.hold) await h.hold
    if (h.fetchFails) return { value: { status: 503, ok: false, headers: {}, text: '' } } as never
    return { value: { status: 200, ok: true, headers: {}, text: h.page } } as never
  })
  reg('ui.toast', async ($, e) => {
    h.toasts.push((e as { text: string }).text)
    return { value: undefined } as never
  })
  // The writer: a value outside a row's options does not fit, so the row is left as it was; one that fits goes into settings.json.
  reg('config.set', async ($, e) => {
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
  reg('process.run', async ($, e) => {
    const { argv } = e as { argv: string[] }
    // The cold-return check looks for this session's transcript and reads its tail; it is not one of the programs the tests count.
    if (argv[0] === 'find' || argv[0] === 'tail') {
      if (h.transcriptFails) throw new Error('no such program')
      if (argv[0] === 'find') h.lookups += 1
      const path = `/home/test/.claude/projects/p/${h.sessionId}.jsonl`
      const out = argv[0] === 'find' ? (h.transcript === undefined ? '' : `${path}\n`) : (h.transcript ?? '')
      return { value: { exitCode: 0, stdout: out, stderr: '' } } as never
    }
    // Where whatsnext starts: git's top level of the session's folder.
    if (argv[0] === 'git' && argv[1] === 'rev-parse') return { value: { exitCode: 0, stdout: `${h.cwd}\n`, stderr: '' } } as never
    if (argv[0] === 'python3') {
      h.wnRuns.push(argv)
      const reply = h.wnReplies.shift() ?? h.wnReply
      return { value: { exitCode: reply.exitCode, stdout: reply.stdout, stderr: reply.stderr ?? '' } } as never
    }
    h.ran.push(argv)
    if (h.rmFails && (argv[0] === 'rm' || argv[0] === 'rmdir')) throw new Error('no such program')
    if (argv[0] === 'rm') for (const f of argv.slice(1).filter(a => !a.startsWith('-'))) delete h.files[f]
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
  })
  reg('ui.status', async ($, e) => {
    h.statuses.push((e as { text?: string }).text)
    return { value: undefined } as never
  })
  reg('ui.log', async ($, e) => {
    h.logs.push((e as { text: string }).text)
    return { value: undefined } as never
  })
  reg('store.get', async ($, e) => ({ value: h.store[(e as { key: string }).key] }) as never)
  reg('store.set', async ($, e) => {
    const { key, value } = e as { key: string; value: unknown }
    h.store[key] = value
    return { value: undefined } as never
  })
  reg('prompt.fill', async ($, e) => {
    h.filled.push((e as { text: string }).text)
    return { isFilled: true } as never
  })
  reg('model.complete', async ($, e) => {
    const model = String((e as { model?: unknown }).model ?? '')
    h.completions.push(model)
    h.completionSystems.push(String((e as { system?: unknown }).system ?? ''))
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
  reg('tool.call', { tool: 'AskUserQuestion' }, async ($, e) => {
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
  // A timed question on the band, answered from `answers` as the dialog's are.
  reg('state.set', async ($, e, next) => {
    const result = await next(e)
    const { key, value, plugin } = e as { key: string; value: unknown; plugin?: string }
    h.stateWrites.push({ key, ...(plugin ? { plugin } : {}), value })
    if (key === 'question') {
      h.question = (value as BandAsk | null) ?? null
      if (h.question && !h.bandAnswered.has(h.question.id)) {
        h.bandAnswered.add(h.question.id)
        // A press after the test ended finds nothing to press.
        void answerBand(h, h.question).catch(() => undefined)
      }
    }
    return result
  })
  reg('tool.call', { tool: 'Agent' }, async () => ({ result: { content: 'done' } }))
  reg('tool.call', { tool: 'SendMessage' }, async () => ({ result: { content: 'sent' } }))
  reg('tool.call', { tool: 'Workflow' }, async () => {
    h.events.push('workflow')
    return { result: { content: 'started in the background' } }
  })
  // A command starting "fail" fails, and so does one ending " --red" (a test run that is red); one starting "denied" is refused by a hook;
  // one starting "rejected" is refused by the person at the permission prompt, which core reports as an error result; one starting "env:" fails with the text after it.
  reg('tool.call', { tool: 'Bash' }, async ($, e) => {
    const command = String((e as unknown as { command: string }).command)
    // "slow …" runs until the test lets it go (h.toolGate): a long foreground call.
    if (command.startsWith('slow')) await h.toolGate
    if (command.startsWith('denied')) return { deny: 'permission denied' }
    if (command.startsWith('rejected')) return { result: REJECTED, text: REJECTED, isError: true }
    // "env:<text>" fails with that text, as the environment does (no network, a missing program); the text is part of the call.
    // A command ending " # exit1" ends with exit code 1, as core reports it: an error result that starts "Exit code 1".
    if (command.endsWith(' # exit1')) return { result: 'Exit code 1', text: 'Exit code 1', isError: true }
    if (command.startsWith('env:')) return { result: command.slice(4), text: command.slice(4), isError: true }
    return command.startsWith('fail') || command.endsWith(' --red') ? { result: { stdout: '', stderr: 'boom' }, text: 'boom', isError: true } : { result: { stdout: 'ok', stderr: '' }, text: 'ok' }
  })
  reg('agent.spawn', async ($, e) => {
    h.spawned.push({ description: e.description, model: e.model })
    const id = `agent-${e.description}`
    h.agents.push({ id, description: e.description, type: e.subagentType, status: 'running', ...(e.parentAgentId ? { parentId: e.parentAgentId } : {}) })
    if (h.spawnHold) await h.spawnHold
    return { model: e.model ?? h.subModel, agentId: id } as never
  })
  reg('agent.list', async () => ({ value: h.agents }) as never)
  reg('prompt.submit', async ($, e) => {
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
  // An attachment the engine raises: the text it would carry, unchanged.
  reg('prompt.attachment', async ($, e) => ({ text: e.text }) as never)
  reg('turn.start', async ($, e) => ({ turnId: e.turnId }) as never)
  reg('turn.step', async function* ($, e) {
    h.sent.push({ effort: e.effort, model: e.model, agentId: e.agentId, turnId: e.turnId })
    if (h.ledger !== undefined) h.ledger += h.stepCost
    if (!e.agentId && h.windowStep) h.rateLimits = h.rateLimits.map(l => ({ ...l, percentUsed: l.percentUsed + h.windowStep }))
    const usage = h.stepUsage
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: { ...usage, model: e.agentId ? h.subModel : (e.model ?? h.model) } } as never
  })
  reg('turn.complete', async () => ({ text: '' }) as never)
  reg('command.run', async ($, e) => {
    const { command, args } = e as { command: string; args?: string }
    if (h.commandRunFails !== undefined) {
      const why = h.commandRunFails
      h.commandRunFails = undefined
      throw new Error(why)
    }
    h.commandRuns.push({ command, args })
    return { value: { text: '' } } as never
  })
  reg('command.list', async () => {
    if (h.commandsFail) throw new Error('commands could not be listed')
    return { value: h.commands } as never
  })
  reg('model.fork', async ($, e) => {
    h.forks.push((e as { prompt: string }).prompt)
    h.forkKeys.push(Object.keys(e as object).sort())
    const queued = h.forkReplies.shift()
    if (queued !== undefined) return { value: queued } as never
    return { value: { isAnswered: true, text: 'OK', ...(h.forkUsage ? { usage: h.forkUsage } : {}) } } as never
  })
  reg('session.compact', async ($, e) => {
    h.compactions += 1
    h.compactCalls.push(e)
    return (h.compactSkip !== undefined ? { skip: h.compactSkip } : { messages: [{ role: 'user', text: 'Summary of the conversation.', toolUses: [] }], ...(h.compactTokens ? { tokensBefore: h.compactTokens.before, tokensAfter: h.compactTokens.after } : {}) }) as never
  })
  // The engine's own band above the prompt: an empty row.
  reg('ui.render', ($, e) => {
    return h$($, e)
  })
  return h
}

/** A timed question as the band shows it. */
export type BandAsk = { id: number; header: string; question: string; options: string[]; ifNone?: string }

// Answers a band question as the person would: presses the option `answers` names (× for none, or one not offered),
// after its gate. An answer whose question has gone by then (its wait ran out) presses nothing.
export async function answerBand(h: ReturnType<typeof engine>, q: BandAsk) {
  // The band draws what happens with no answer on a line of its own; the test reads it as the question's last sentence.
  h.asked.push({ header: q.header, question: q.ifNone ? `${q.question} No answer: ${q.ifNone}.` : q.question, options: q.options })
  h.events.push(`ask:${q.header}`)
  const answer = h.answerQueue[q.header]?.shift() ?? h.answers[q.header]
  if (answer === NO_ONE) return
  await h.answerGate[q.header]
  await flush()
  if (h.question?.id !== q.id || !h.test$) return void h.tooLate.push(q.header)
  const at = answer === undefined ? -1 : q.options.indexOf(answer)
  const ui = await mount(h.test$, h.surfaces[0] ?? 'terminal')
  // × is the question's own when it is alone on the band, else the band's.
  const close = (await ui.find({ type: 'Button', key: 'q-close' })) ? 'q-close' : 'close'
  await ui.press({ key: at < 0 ? close : `q-${at}` })
  await ui.unmount()
}

export const drive = (api: unknown, h: ReturnType<typeof engine>) => {
  const e = api as Engine
  h.test$ = api
  return {
    start: (surface: string) => e.session.start({ source: 'startup', cwd: '/tmp', surface, isInteractive: true }),
    /** `turnId`: the turn that was running when the prompt was typed; left out, the session was idle. */
    submit: (text: string, turnId?: string) => e.prompt.submit({ text, origin: { kind: 'composer' }, wait: false, ...(turnId ? { turnId } : {}) }),
    /** The engine raising an attachment for a request: `origin` says who wrote it (a SessionStart hook's output by default); `agentId` puts it on a helper's request. */
    attach: (text: string, origin: { kind: string; event?: string } = { kind: 'hook', event: 'SessionStart' }, agentId?: string) =>
      e.prompt.attachment({ type: 'hook_additional_context', text, origin, ...(agentId ? { agentId } : {}) }),
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
    /** `extra`: more of the Bash input, such as `timeout` (ms) and `run_in_background`. */
    bash: (command: string, agentId?: string, extra: Record<string, unknown> = {}) => e.tool.call({ tool: 'Bash', command, description: `try ${command} ${h.sent.length}`, ...(agentId ? { agentId } : {}), ...extra }),
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
export const timers = globalThis as unknown as { setTimeout: (f: () => void, ms: number) => unknown }
export const flush = () => new Promise<void>(resolve => timers.setTimeout(resolve, 20))
/** Lets a band question that just showed be answered: the test presses its button a moment later. */
export const settle = async () => {
  for (let i = 0; i < 5; i++) await flush()
}
/** Waits until a question was asked (more than `before` so far) and its answer was handled: the ⋯ menu asks through the engine, which takes a moment. */
export const untilAsked = async (h: { asked: unknown[] }, before: number, questions = 1) => {
  for (let i = 0; i < 50 && h.asked.length < before + questions; i++) await flush()
  await flush()
}
export const DAY = 24 * 60 * 60 * 1000
export const PAGE = [
  '| Claude Fable 5.2 | $8 / MTok | $10 / MTok | $16 / MTok | $0.20 / MTok | $40 / MTok |',
  '| Claude Opus 5.5 | $4 / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok | $20 / MTok |',
  '| Claude Sonnet 5.5 | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.10 / MTok | $10 / MTok |',
  '| Claude Haiku 5.5 (for prompts up to 100,000 tokens) | $0.10 / MTok | $0.125 / MTok | $0.20 / MTok | $0.01 / MTok | $0.50 / MTok |',
].join('\n')
export const OLD_PRICES = JSON.stringify({
  cacheTtl: '5m',
  models: {
    haiku: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite5m: 0.125, cacheWrite1h: 0.2 },
    sonnet: { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
    opus: { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 },
    fable: { input: 8, output: 40, cacheRead: 0.2, cacheWrite5m: 10, cacheWrite1h: 16 },
  },
})

export const last = <T>(xs: readonly T[]) => xs[xs.length - 1]

export const BAND = {
  plugin: 'rightsize',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const
export type Found = { type?: string; key?: string; text?: string; props?: { key?: string; label?: string; value?: string; options?: { value: string }[] }; children?: Found[] | string[] }
export type Mounted = {
  find: (q: object) => Promise<Found | undefined>
  findAll: (q: object) => Promise<Found[]>
  press: (t: object) => Promise<unknown>
  select: (t: { key: string; value: string }) => Promise<unknown>
  unmount: () => Promise<void>
}
/** The settings pane (bare /rightsize), as an engine asks for it. */
export const PANE = {
  plugin: 'rightsize',
  component: 'Pane',
  requestId: 'rightsize-menu',
  props: { title: 'Rightsize', isFocused: true, bodyColumns: 80, placement: 'inline', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const
export const mountPane = (api: unknown, surface: string) => (api as { ui: { mount: (x: unknown) => Promise<Mounted> } }).ui.mount({ ...PANE, surface })
export const mount = (api: unknown, surface: string) => (api as { ui: { mount: (x: unknown) => Promise<Mounted> } }).ui.mount({ ...BAND, surface })
/** A band row's line: the Text after its label ("Prompt", or "rightsize · Prompt" when it is the only row); '' when the row is not drawn. */
export async function rowText(ui: Mounted, label: string) {
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text ?? '')
  const at = texts.findIndex(t => t === label || t === `rightsize · ${label}`)
  return at < 0 ? '' : (texts[at + 1] ?? '')
}
// The band's line as drawn (the prompt's row, else the cache row when it is the only one), or '' when it draws nothing.
export async function bandText(api: unknown, surface: string) {
  const ui = await mount(api, surface)
  const text = (await rowText(ui, 'Prompt')) || (await rowText(ui, 'Cache'))
  await ui.unmount()
  return text
}
export const setBand = (api: unknown, value: string) => (api as { config: { set: (x: unknown) => Promise<unknown> } }).config.set({ key: 'rightsize.band', value })
export const LOWER = '{"level":"low","model":"same","size":"small","type":"lookup","read":2000,"write":3000,"steps":1,"reason":"one function lookup"}'
