import type { AgentSpawnInput, EngineInterface, PromptSubmitInput, Register } from 'claude-code'
import type {
  RightsizeBand as Band,
  RightsizeBandMode as BandMode,
  RightsizeChoices as Choices,
  RightsizeLevel as Level,
  RightsizeTier as Tier,
} from '../types'
import {
  DEFAULT_LEVEL,
  DEFAULT_PRICES,
  DEFAULT_RULES,
  IDLE_MAX_CONTEXT,
  NORMAL_PACE,
  SWITCH_KEY,
  TIERS,
  TIER_NAME,
  type Calibration,
  type Pace,
  type Plan,
  type Prices,
  type Rating,
  type Rules,
  type Situation,
  type Tie,
  cacheTtlMs,
  contextOf,
  idleCost,
  MISS_BLOCK,
  parseIdleWarning,
  delegateCost,
  delegateKeys,
  mainKeys,
  effortPlan,
  isLevel,
  levelRank,
  learn,
  mainCost,
  money,
  parseCalibration,
  parsePrices,
  parseShare,
  paceNote,
  paceOf,
  pacedRules,
  plan,
  ratioSample,
  rawDelegateCost,
  rawMainCost,
  share,
  sizeSubagent,
  subagentKeys,
  tierOf,
  tierRank,
  usageCost,
  type Usage,
  CAL_STORE,
} from './cost'
import { PRICING_URL, applyPrices, diffPrices, isDue, parsePricingPage } from './prices'
import { missMap, missRates } from './misses'
import { SHARE_ASK_AFTER, SHARE_EVERY_MS, SHARE_URL, newInstall, nextBatch } from './share'
import { START_CHECK_DAYS, START_SNOOZE_DAYS, adviseFromLog, startKey, startLines, startTip } from './start'
import {
  KEYS,
  NOT_SET,
  RULE_KEYS,
  SETTINGS,
  type SettingKey,
  type Values,
  afterSet,
  defaults,
  fieldsSet,
  inOptions,
  manifestGaps,
  mark,
  minWordsOf,
  missPauseOf,
  raterEvery,
  resetKeys,
  ruleLabel,
  ruleValue,
  rulesOf,
  settingNamed,
  stillReset,
  valuesOf,
} from './settings'
import { parseRating, ratingPrompt, ratingSystem } from './rate'
import { LIMITS, type Limits, type Signals, type Struggle, callKey, isSensitivity, noSignals, noteCall, oneUp, struggle } from './struggle'
import { type Change, type RunLine, type SwitchLine, type Windows, buildReport, parseLines, shareMessage, windowRates } from './report'

// Before a prompt is sent, a quick Haiku call rates the effort, the model and
// the work needs on each model, and the cost model prices each route that fits. The first time
// each situation comes up in a session the person picks how to handle it
// (Q1 lowering, Q2 raising, Q3 a stronger model, Q4 a cheaper model), then the
// mod follows that answer. Effort changes rewrite each main-thread request
// (turn.step); a model change hands the work to a subagent through a hidden
// note beside the prompt (prompt.submit context), and that subagent's requests
// run at the level its model needs (turn.step). A subagent Claude starts on its
// own with no model named has its brief rated too, and runs on the cheapest model
// that fits, at that model's level (agent.spawn, turn.step). After each rated turn the
// real cost is read off the session's cost ledger (/cost) and fed back into the
// estimates. When a turn shows it is struggling (tools failing, the same call
// failing again or going round, far more steps than rated), effort goes up a
// level for the rest of the turn (tool.call, turn.step). Billing (API or subscription) is read off the rate limits each
// response carries; the person is asked only when they say nothing. A band
// above the prompt shows what it did, with buttons to undo it or change the rule.
// Your setting wins: every row in /config is a setting (settings.ts), and a value the
// person set, or answered, is never changed or bypassed by what rightsize does by itself.

const NAME = 'rightsize'
const CMD = 'rightsize'
const RATER = 'haiku'
const BRAIN_DUMP_WORDS = 120
/** An auto-lowered turn steps back up from this step on. */
const STEP_UP_AFTER = 5
/** Claude Code's own system prompt and tools, before the first request is seen. */
const DEFAULT_CONTEXT = 20_000
/** About 30 days of heavy use, for /rightsize report. */
const RUNS_LOG_MAX = 1_000_000
const SPOT_CHECKER = 'sonnet'
const MISS_WINDOW_DAYS = 30

type Lower = NonNullable<Choices['lower']>
type Raise = NonNullable<Choices['raise']>
type Route = NonNullable<Choices['up']>
type Billing = 'api' | 'subscription'
type Resized = { from: Tier; tier: Tier; level: Level; type: Rating['type']; tie?: Tie }
/** A moved subagent: its estimates on the model it runs on and on its parent's, and what its own requests cost so far. */
type Measured = Resized & { raw: number; parentRaw: number; spend: number; inWorkflow?: boolean }
/** A spawn the engine is starting: its first step can come before its id does. */
type Spawning = { description: string; type: string; run?: Run; size?: Omit<Measured, 'spend'>; id?: string }
type SubagentMode = 'cheaper when it fits' | 'off'
type Question<V> = { header: string; question: string; options: readonly (readonly [string, V])[] }

const qLower: Question<Lower> = {
  header: 'Lowering',
  question: 'When a prompt needs less effort, what should I do?',
  options: [
    ['Lower automatically', 'auto'],
    ['Ask me each time', 'ask'],
    ['Never lower', 'never'],
  ],
}
const qRaise: Question<Raise> = {
  header: 'Raising',
  question: 'When a prompt needs more effort on the same model, what should I do?',
  options: [
    ['Raise automatically (Recommended)', 'auto'],
    ['Ask me each time', 'ask'],
    ['Never raise', 'never'],
  ],
}
const qUp = (cur: string, to: string): Question<Route> => ({
  header: 'Stronger',
  question: `When a prompt needs a stronger model than ${cur} (such as ${to}), what should I do?`,
  options: [
    ['Ask before sending it to a subagent (Recommended)', 'ask'],
    ['Send it to a subagent automatically', 'auto'],
    [`Stay on ${cur}, raise effort only`, 'stay'],
    ['Ask me each time', 'each'],
  ],
})
const qDown = (cur: string, to: string): Question<Route> => ({
  header: 'Cheaper',
  question: `When a task could run on a cheaper model than ${cur} (such as ${to}), what should I do?`,
  options: [
    ['Send it to a cheaper subagent (Recommended)', 'auto'],
    ['Ask before sending it', 'ask'],
    [`Stay on ${cur}, lower effort only`, 'stay'],
    ['Ask me each time', 'each'],
  ],
})
const qBilling: Question<Billing> = {
  header: 'Billing',
  question: 'I could not tell how you pay for Claude Code. Reports show dollars for the API, or a share of your usage for a subscription. Which is it?',
  options: [
    ['Subscription (Pro, Max, Team or Enterprise)', 'subscription'],
    ['API (pay per token)', 'api'],
  ],
}
const qBand: Question<BandMode> = {
  header: 'Band',
  question: 'When should the rightsize band show above the prompt?',
  options: [
    ['Only when it changes something (Recommended)', 'when it acts'],
    ['On every rated prompt', 'always'],
    ['Never (status line only)', 'off'],
  ],
}
type WorkflowMode = 'pause rightsize' | 'follow my rules' | 'right-size every agent'
const qWorkflow: Question<WorkflowMode> = {
  header: 'Workflow',
  question:
    'Claude is starting a workflow. It may start many helper agents at once, often 10 or more, and each picks its own model. What should rightsize do during workflows? You can change this any time with Workflows in /config.',
  options: [
    ['Pause rightsize for workflows (recommended)', 'pause rightsize'],
    ['Follow my rules for the main chat', 'follow my rules'],
    ['Also right-size every workflow agent (one Haiku rating per agent; many may run on cheaper models at once)', 'right-size every agent'],
  ],
}
const qRemember: Question<boolean> = {
  header: 'Remember',
  question: 'Use these choices in every session?',
  options: [
    ['Yes, from now on', true],
    ['Just this session', false],
  ],
}

/** One rated prompt, from prompt.submit until its turn completes. */
type Run = {
  /** Unique to this run: its log line carries it, and 👍 and 👎 name it. */
  id: string
  turnId?: string
  rating: Rating
  tier: Tier
  /** The level the turn runs at with no change. */
  normal: Level
  /** The level for this turn only. */
  level?: Level
  /** The level the main chat runs at with rightsize's change: the estimate's level. */
  ranAt: Level
  /** Workflow calls (ultracode's fan-out) in the turn. */
  workflows: number
  /** Lowered without asking: steps back up when the turn gets hard. */
  auto: boolean
  delegate?: { tier: Tier; level: Level; dir: 'up' | 'down' }
  /** The hand-off's subagents, by the id their steps carry. */
  subAgents: string[]
  /** The effort the hand-off's subagent really ran at, as sent. */
  subLevel?: Level
  /** Claude's own subagents moved to a cheaper model this turn. */
  resized: Resized[]
  /** The hand-off was a close call that the task-type guide broke. */
  tie?: Tie
  /** Uncalibrated estimates of the route taken, for calibration. */
  rawMain: number
  rawDelegate?: number
  /** Calibrated estimate of staying at the normal level, for the report. */
  stay: number
  /** The session's cost ledger (/cost) when the turn's first request went out; undefined where the host keeps none. */
  ledgerStart?: number
  /** Token counts priced from prices.json: the fallback when there is no ledger. */
  mainCost: number
  subCost: number
  /** What effort-switch cache misses cost this turn. */
  missCost: number
  /** A rater check's cost that landed in the ledger while the turn ran: not the turn's own. */
  sideCost: number
  errors: number
  steppedUp: boolean
  delegated: boolean
  change: Change
  offered: Change
  /** Calibrated estimates of the main-chat route and of the hand-off, as decided. */
  takenMain: number
  takenDelegate?: number
  /** The rating call's cost. */
  overhead: number
  agentCalls: number
  /** Rate-limit windows when the turn's first request went out. */
  before?: Windows
  /** How fast the tighter usage window was being used when the prompt was rated. */
  pace: Pace
  /** The main chat's tool calls so far: the signs it is struggling. */
  signals: Signals
  /** The level the rest of the turn runs at after a mid-turn raise. */
  raisedTo?: Level
  escalations: { step: number; from: Level; to: Level; why: string }[]
  /** Main-chat requests in the turn: each re-reads the fixed context. */
  requests: number
  /** Tokens in the main conversation when the prompt was rated. */
  context: number
}

let home = ''
let sessionId = ''
let off = false
let floor: Level = 'low'
let billing: Billing = 'api'
/**
 * Where `billing` came from: read off this session's rate limits, the person's
 * answer (the question or Reports in /config), a reading saved by an earlier
 * session, or nothing yet (the Reports default).
 */
let billingBy: 'detected' | 'answered' | 'saved' | null = null
let billingAsked = false
/** What this session's rate limits showed, even when Reports is yours and they change nothing. */
let detectedBilling: Billing | undefined
let priceCheck: 'monthly' | 'off' = 'monthly'
let bandMode: BandMode = 'when it acts'
let rules: Rules = DEFAULT_RULES
let checking: Promise<string> | null = null
let prices: Prices = DEFAULT_PRICES
let cal: Calibration = {}
let pending: Run | null = null
let active: Run | null = null
let lastApplied: Level | undefined
let lastContext = 0
let lastAuto: { text: string; level: Level; normal: Level } | null = null
let skipOnce: string | null = null
/**
 * A workflow ran in this session (ultracode, or asked for). Claude is then fanning
 * work out itself. What rightsize does about it is the Workflows setting: by default it
 * hands nothing off until the session ends. A workflow runs on in the background, so its
 * agents' cost lands in later turns too: from here on no turn teaches calibration or
 * claims a saving, whatever the setting says.
 */
let workflowSeen = false
/** Workflows: `ask` counts as `pause rightsize` until the person answers. */
let workflows: 'ask' | 'pause rightsize' | 'follow my rules' | 'right-size every agent' = 'ask'
/** Workflow calls already asked about, by tool_use_id: a call is asked about once, even if its hook runs again. */
const askedWorkflows = new Set<string>()
let askingWorkflow: Promise<void> | null = null
let subagentMode: SubagentMode = 'cheaper when it fits'
/** Budget pacing: move the thresholds by how fast the usage windows are being used. */
let pacing = true
/** Every row's value as /config holds it now: the value set, else the default. The variables above and below follow it. */
let cfg: Values = defaults()
/** The rows you set (see settings.ts): rightsize's own behaviour never changes or bypasses these. */
let yours: ReadonlySet<SettingKey> = new Set()
/** Rows reset to their default: Claude Code cannot unset a stored value, so they stay off `yours` while it is the default. */
let resetFields: ReadonlySet<SettingKey> = new Set()
/** When Cost measurement was restarted (ms; 0: never). The run log before it teaches rightsize nothing. */
let measureFrom = 0
/** The options Claude Code passed at load, to check plugin.json against the table. */
let declared: Readonly<Record<string, unknown>> = {}
/** The highest effort rightsize raises to. */
let ceiling: Level = 'max'
/** Models rightsize sends no work to (Use Haiku, Use Fable off). The rater still runs on Haiku. */
let without: Tier[] = []
/** The miss rate at which hand-downs and lowering pause; null: never. */
let missBlock: number | null = MISS_BLOCK
/** Prompts shorter than this many words are not rated. */
let minWords = 6
/** One close call in five takes the route the guide did not pick. */
let explore = true
/** What happens to the answers to the four questions: ask whether to keep them, keep them, or forget them at the end of the session. */
let rememberMode: 'ask' | 'every session' | 'this session' = 'ask'
/** How soon Claude counts as stuck. */
let limits: Limits = LIMITS.normal
/** The pace the prompt being rated was decided at. */
let paceNow: Pace = NORMAL_PACE
/** Raise effort mid-turn when the turn shows it is struggling. */
let escalation = true
/** Days between suggestions of a different starting model and level; null: off. */
let startEvery: number | null = START_CHECK_DAYS.weekly
/** Ask Sonnet for a second opinion on every this many ratings, in the background; null: off. */
let spotEvery: number | null = 50
/** Send anonymous numbers to the rightsize author: off until the person says yes. */
let sharing = false
/** When this process last sent, or tried to: at most one send an hour. */
let sharedAt = 0
/** The mod's version, sent with each batch. */
let version = ''
/** The run log's last 30 days, kept in memory to score the rater (misses.ts) without re-reading the file. */
let runLog: RunLine[] = []
/** How often the rater was wrong, by `${type}:${tier}`: what plan() skips hand-downs and lowerings on. */
let misses: Record<string, number> = {}
/** Runs already given a 👍 or 👎, so a double press counts once. */
const ratedRuns = new Set<string>()
let runSeq = 0
/** Warn before sending into an expired cache when that costs over this many dollars; null: off. */
let idleWarning: number | null = 0.1
let cacheTtl = 60 * 60_000
/** When this session's last main turn ended, in this process; 0 before one did (a resume reads the store). */
let lastTurnAt = 0
/** The idle gap already warned about: the person's answer stands for it. */
let idleWarnedFor = 0
/** Claude's own subagents moved to a cheaper model, by id: the level their steps run at, past the turn that started them. */
const resizedRuns = new Map<string, Measured>()
const spawning: Spawning[] = []

const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length
const fromPerson = (e: PromptSubmitInput) => e.origin.kind === 'composer' || e.origin.kind === 'bridge'
const names = (tiers: readonly Tier[]) => tiers.map(t => TIER_NAME[t]).join(' or ')

// A prompt brain-dump is about to offer to shape: leave it to brain-dump, and
// rate the brief it writes instead.
const brainDumpWillCatch = (text: string, switches: Record<string, unknown>) =>
  switches['brain-dump'] !== false && words(text) >= BRAIN_DUMP_WORDS && !text.includes('THE JOB')

// ---- Files -----------------------------------------------------------------

async function readText($: EngineInterface, path: string) {
  try {
    if (!(await $.fs.exists(path))) return ''
    return String(await $.fs.read(path))
  } catch {
    return ''
  }
}

async function readSwitches($: EngineInterface): Promise<Record<string, unknown>> {
  try {
    const json = JSON.parse((await readText($, `${home}/.claude/mods/switches.json`)) || '{}') as unknown
    return json && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

async function append($: EngineInterface, name: string, line: string, max: number) {
  try {
    const dir = `${home}/.claude/mods-logs`
    const path = `${dir}/${name}`
    const old = await readText($, path)
    if (!old) await $.process.run(['mkdir', '-p', dir])
    let text = `${old}${line}\n`
    if (text.length > max) text = text.slice(text.indexOf('\n', text.length - max) + 1)
    await $.fs.write(path, text)
  } catch {
    // Logging must never hold up a prompt.
  }
}

const log = ($: EngineInterface, line: string) => append($, 'rightsize.log', `${new Date().toISOString()} ${line}`, 50_000)

// Scores the rater again from the last 30 days of the run log (misses.ts).
async function refreshMisses($: EngineInterface) {
  try {
    const now = await $.clock.now()
    runLog = runLog.filter(l => now - Date.parse(l.at) <= MISS_WINDOW_DAYS * 24 * 60 * 60_000)
    // Lines from before Cost measurement was restarted teach nothing.
    misses = missMap(missRates(runLog.filter(l => Date.parse(l.at) >= measureFrom)))
  } catch {
    // The old rates stand.
  }
}

/** Adds a line to the run log, and to the rater's record in memory. */
async function appendRun($: EngineInterface, line: RunLine) {
  await append($, 'rightsize-runs.jsonl', JSON.stringify(line), RUNS_LOG_MAX)
  runLog.push(line)
  await refreshMisses($)
}

// ---- Prices ----------------------------------------------------------------

// Reads Anthropic's pricing page and writes any changed price into prices.json,
// keeping the old file as prices.json.bak. A failed fetch or an unreadable page
// changes nothing and is tried again at the next session start. `claimedFrom` is
// the check time a monthly check replaced when it claimed the check; a failed
// check puts it back so the check stays due.
async function checkPrices($: EngineInterface, why: 'monthly' | 'manual', claimedFrom?: unknown): Promise<string> {
  const path = `${$.plugin.root}/prices.json`
  const failed = async (msg: string) => {
    if (why === 'monthly') await $.store.set('pricesCheckedAt', typeof claimedFrom === 'number' ? claimedFrom : 0).catch(() => undefined)
    await log($, `${why} ${msg}`)
    return msg
  }
  let text = ''
  try {
    const res = await $.http.fetch(PRICING_URL)
    if (!res.ok) throw new Error(`the pricing page answered ${res.status}`)
    text = res.text
  } catch (err) {
    return failed(`Price check failed: ${err instanceof Error ? err.message : String(err)}. prices.json is unchanged.`)
  }
  const page = parsePricingPage(text)
  const found = Object.keys(page).length
  if (found < 4) {
    return failed(`Price check found ${found} of 4 models on the pricing page; its layout may have changed. prices.json is unchanged.`)
  }
  const now = await $.clock.now()
  await $.store.set('pricesCheckedAt', now).catch(() => undefined)
  const old = await readText($, path)
  const changes = diffPrices(old, page)
  if (!changes.length) {
    await log($, `${why} price check: no change`)
    return 'Prices checked: no change since the last check.'
  }
  if (old) await $.fs.write(`${path}.bak`, old)
  const next = applyPrices(old, page, new Date(now).toISOString().slice(0, 10))
  await $.fs.write(path, next)
  prices = parsePrices(next)
  const msg = `Prices updated from Anthropic's pricing page (old file kept as prices.json.bak): ${changes.join('; ')}.`
  await log($, `${why} ${msg}`)
  $.ui.log(`rightsize: ${msg}`)
  return msg
}

// One check at a time; a second ask waits for the first.
const runCheck = ($: EngineInterface, why: 'monthly' | 'manual', claimedFrom?: unknown) => {
  checking ??= checkPrices($, why, claimedFrom).finally(() => {
    checking = null
  })
  return checking
}

// ---- State -----------------------------------------------------------------

async function sessionEffort($: EngineInterface) {
  const v = (await $.state.get({ plugin: 'rightsize', key: 'sessionEffort' }).catch(() => undefined))?.value
  return isLevel(v) ? v : null
}

async function seenEffort($: EngineInterface) {
  const v = (await $.state.get({ plugin: 'rightsize', key: 'seenEffort' }).catch(() => undefined))?.value
  return isLevel(v) ? v : null
}

async function choices($: EngineInterface): Promise<Choices> {
  const v = (await $.state.get({ plugin: 'rightsize', key: 'choices' }).catch(() => undefined))?.value
  return v && typeof v === 'object' ? v : {}
}

// Whether the answers to the four questions are kept for later sessions: always or never
// when Remember choices says so; otherwise once the person has said yes to the question.
async function remembers($: EngineInterface) {
  if (rememberMode !== 'ask') return rememberMode === 'every session'
  return (await $.store.get('remember').catch(() => undefined)) === true
}

// Samples learned since the last save. Other sessions save calibration too, so a
// save applies these to the stored copy rather than writing this session's over it.
let unsaved: { key: string; sample: number }[] = []
let saving: Promise<void> = Promise.resolve()

function teach(key: string, sample: number) {
  cal = learn(cal, key, sample)
  unsaved.push({ key, sample })
}

async function mergeCal($: EngineInterface) {
  const batch = unsaved
  if (!batch.length) return
  unsaved = []
  try {
    let stored = parseCalibration(await $.store.get(CAL_STORE))
    for (const s of batch) stored = learn(stored, s.key, s.sample)
    await $.store.set(CAL_STORE, stored)
    // Samples learned while this save ran stay pending, on top of the merged copy.
    cal = unsaved.reduce((c, s) => learn(c, s.key, s.sample), stored)
  } catch {
    unsaved = [...batch, ...unsaved]
  }
}

// One save at a time, so two saves in this session never read the same stored copy.
const saveCal = ($: EngineInterface) => {
  saving = saving.then(() => mergeCal($))
  return saving
}

const isBilling = (v: unknown): v is Billing => v === 'api' || v === 'subscription'

async function usageNow($: EngineInterface) {
  return $.session.usage().catch(() => undefined)
}

// A subscription's responses carry its five-hour and seven-day windows; a Claude
// gateway's carry only a spend limit, billed per token. None: an API key, or no
// response read yet, so it can't tell.
export function billingOf(limits: readonly { kind: string }[]): Billing | undefined {
  if (limits.some(l => l.kind === 'five_hour' || l.kind === 'seven_day')) return 'subscription'
  if (limits.some(l => l.kind === 'spend_limit')) return 'api'
  return undefined
}

async function saveBilling($: EngineInterface, v: Billing, by: 'detected' | 'answered') {
  billing = v
  billingBy = by
  await $.store.set('billing', { value: v, by }).catch(() => undefined)
}

/** Reports is yours: set in /config, or answered. Rate limits never change it. */
const billingYours = () => yours.has('billing') || billingBy === 'answered'

/** The person's answer to the billing question: it is Reports in /config too. */
async function answerBilling($: EngineInterface, v: Billing) {
  await saveBilling($, v, 'answered')
  await putConfig($, 'billing', v)
}

// Reads the billing off the last response's rate limits, unless Reports is yours: then
// they change nothing (/rightsize notes when they disagree). When they say nothing after
// a response, it keeps the earlier reading, or (`mayAsk`) asks once a session.
async function knowBilling($: EngineInterface, mayAsk: boolean) {
  if (billingBy === 'detected' || (billingYours() && detectedBilling)) return
  const u = await usageNow($)
  const seen = billingOf(u?.rateLimits ?? [])
  if (seen) detectedBilling = seen
  if (billingYours()) return
  if (seen) return saveBilling($, seen, 'detected')
  if (!mayAsk || billingAsked || lastContext === 0) return
  billingAsked = true
  const v = await pick($, qBilling)
  if (v !== undefined) await answerBilling($, v)
}

// ---- Questions -------------------------------------------------------------

// Asks in the engine's dialog. Dismissed, typed under Other, or no one to ask: undefined.
async function pick<V>($: EngineInterface, q: Question<V>): Promise<V | undefined> {
  try {
    const answer = await $.ui.ask(q.question, { options: q.options.map(o => o[0]), header: q.header })
    return q.options.find(o => o[0] === answer)?.[1]
  } catch {
    return undefined
  }
}

const RULE_IDS = Object.keys(RULE_KEYS) as (keyof Choices)[]

/**
 * Writes a setting to its /config row, as the person's: an answer to a question they were asked,
 * or a button they pressed. The row then shows what rightsize follows, and next session counts it as theirs.
 * rightsize's own hooks do not see its own `$.config.set`, so the value is applied here.
 */
async function putConfig($: EngineInterface, key: SettingKey, value: string) {
  const unset = value === NOT_SET
  if (cfg[key] === value && yours.has(key) === !unset) return
  cfg = { ...cfg, [key]: value }
  yours = mark(yours, key, !unset)
  if (!unset) await forgetReset($, key)
  applyOption(key)
  await $.config.set({ key: `rightsize.${key}`, value }).catch(() => undefined)
}

// The four rule rows follow the rules: a rule not answered shows as "not set".
async function mirrorRules($: EngineInterface, c: Choices) {
  for (const rule of RULE_IDS) await putConfig($, RULE_KEYS[rule], ruleLabel(rule, c[rule]))
}

// Keeps the answers for later sessions: in the store, and in the /config rows.
async function keepChoices($: EngineInterface, next: Choices) {
  await $.store.set('choices', next).catch(() => undefined)
  await mirrorRules($, next)
}

// `explicit`: the person set these rules on purpose (a band button, /rightsize settings), so the
// rows show them at once; an answer to a question is kept only the way Remember choices says.
// A Workflow call the person has not been asked about yet: asked before it starts, once per call. The answer is
// Workflows in /config, and the person's. Closed without an answer: paused for this workflow, asked at the next.
async function askWorkflow($: EngineInterface, id: string | undefined) {
  if (id !== undefined) {
    if (askedWorkflows.has(id)) return
    askedWorkflows.add(id)
  }
  const v = await pick($, qWorkflow)
  await log($, `workflow question: ${v ?? 'dismissed'}`)
  if (v !== undefined) await putConfig($, 'workflows', v)
}

async function saveChoices($: EngineInterface, next: Choices, explicit = false) {
  await $.state.set({ plugin: 'rightsize', key: 'choices' }, next)
  if (rememberMode === 'this session') return
  if (explicit) await mirrorRules($, next)
  if (await remembers($)) {
    await keepChoices($, next)
    return
  }
  const asked = (await $.state.get({ plugin: 'rightsize', key: 'rememberAsked' }).catch(() => undefined))?.value
  if (asked === true) return
  await $.state.set({ plugin: 'rightsize', key: 'rememberAsked' }, true)
  const yes = await pick($, qRemember)
  if (yes === true) {
    await $.store.set('remember', true).catch(() => undefined)
    await keepChoices($, next)
    await putConfig($, 'remember', 'every session')
  } else if (yes === undefined) {
    // Dismissed: ask again after the next answer.
    await $.state.set({ plugin: 'rightsize', key: 'rememberAsked' }, false)
  }
}

// A rule row changed in /config: the rule follows it at once. "not set" clears the rule, so its question comes back.
async function followRuleRow($: EngineInterface, rule: keyof Choices, label: string) {
  const value = ruleValue(rule, label)
  const change = (c: Choices): Choices => {
    const next: Record<string, string> = { ...c }
    if (value === undefined) delete next[rule]
    else next[rule] = value
    return next as Choices
  }
  await $.state.set({ plugin: 'rightsize', key: 'choices' }, change(await choices($)))
  // An earlier session's saved copy stays in step: left alone, it would bring a cleared rule back.
  const saved = await $.store.get('choices').catch(() => undefined)
  if (saved && typeof saved === 'object' && !Array.isArray(saved)) await $.store.set('choices', change(saved as Choices)).catch(() => undefined)
}

// The answer for one situation: a rule you set, or the saved answer, or the question, the first time it comes up.
async function choice<K extends keyof Choices>($: EngineInterface, key: K, q: Question<NonNullable<Choices[K]>>) {
  const have = (await choices($))[key]
  if (have) return have
  const v = await pick($, q)
  if (v !== undefined) await saveChoices($, { ...(await choices($)), [key]: v })
  return v
}

// ---- Deciding --------------------------------------------------------------

async function situation($: EngineInterface): Promise<Situation> {
  const model = (await $.state.get({ plugin: 'rightsize', key: 'seenModel' }).catch(() => undefined))?.value
  let tier = tierOf(model)
  if (!tier) tier = tierOf(String((await $.settings.read({ key: 'model' }).catch(() => '')) ?? '')) ?? 'opus'
  let level = (await sessionEffort($)) ?? (await seenEffort($))
  if (!level) {
    const set = await $.settings.read({ key: 'effortLevel' }).catch(() => undefined)
    level = isLevel(set) ? set : DEFAULT_LEVEL[tier]
  }
  const context = (await $.state.get({ plugin: 'rightsize', key: 'context' }).catch(() => undefined))?.value
  return { tier, level, context: typeof context === 'number' && context > 0 ? context : DEFAULT_CONTEXT, prices, cal, rules, ties: await tiesSeen($), misses, missBlock, ceiling, without, explore }
}

// Close calls seen so far, kept in the store so the one-in-five exploration holds across sessions.
const TIES_STORE = 'ties'

async function tiesSeen($: EngineInterface) {
  const v = await $.store.get(TIES_STORE).catch(() => undefined)
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : 0
}

// Counts one close call. It reads the stored count again, so another session's calls are not lost.
async function countTie($: EngineInterface) {
  await $.store.set(TIES_STORE, (await tiesSeen($)) + 1).catch(() => undefined)
}

async function rate($: EngineInterface, text: string, s: Situation): Promise<{ rating?: Rating; overhead: number; prompt: string }> {
  let lastReply = ''
  try {
    const rows = await $.session.messages()
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i]
      if (row?.role === 'assistant' && row.text.trim()) {
        lastReply = row.text
        break
      }
    }
  } catch {
    // Rated on the prompt alone.
  }
  const prompt = ratingPrompt(text, lastReply)
  return { ...(await askRater($, s.tier, s.level, prompt)), prompt }
}

// ---- Rater check -------------------------------------------------------------

// Every 50th rating (Rater check sets it), Sonnet rates the same prompt in the background. Where it says a
// model would struggle that Haiku said does the work, Haiku missed (misses.ts). The
// check never holds up the prompt, and its cost is logged as overhead.

const SPOT_STORE = 'spotChecks'

/** Counts one rating; true when it is every Rater check'th one (50th, 100th and so on by default). Off: not counted. */
async function dueCheck($: EngineInterface) {
  if (spotEvery === null) return false
  const v = await $.store.get(SPOT_STORE).catch(() => undefined)
  const n = (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : 0) + 1
  await $.store.set(SPOT_STORE, n).catch(() => undefined)
  return n % spotEvery === 0
}

async function spotCheck($: EngineInterface, session: string, tier: Tier, level: Level, prompt: string, first: Rating) {
  try {
    const r = await $.model.complete({
      model: SPOT_CHECKER,
      system: ratingSystem(tier, level),
      prompt,
      maxTokens: 300,
      effort: 'low',
      timeoutMs: 15_000,
    })
    const usage = (r as { usage?: Usage }).usage
    const overhead = usage ? usageCost(prices, SPOT_CHECKER, usage) : 0
    // The check ran beside a turn, so the ledger counts it in that turn: take it out of the turn's cost.
    if (active) active.sideCost += overhead
    const second = r.isAnswered ? parseRating(r.text, tier) : undefined
    if (!second) {
      await log($, r.isAnswered ? 'rater check unreadable' : `rater check failed: ${r.reason}`)
      if (overhead > 0) await append($, 'rightsize-runs.jsonl', JSON.stringify({ at: new Date().toISOString(), kind: 'overhead', session, overhead: round(overhead) } satisfies RunLine), RUNS_LOG_MAX)
      return
    }
    const line: RunLine = { at: new Date().toISOString(), kind: 'check', session, type: first.type, fit: first.fit, check: { by: SPOT_CHECKER, fit: second.fit }, overhead: round(overhead) }
    await appendRun($, line)
    const fit = (f: Rating['fit']) => TIERS.map(t => `${t[0]}:${f[t] ?? (f[t] === null ? 'no' : '?')}`).join(' ')
    await log($, `rater check on ${first.type}: haiku ${fit(first.fit)}; sonnet ${fit(second.fit)}`)
  } catch (err) {
    await log($, `rater check threw: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function askRater($: EngineInterface, tier: Tier, level: Level, prompt: string): Promise<{ rating?: Rating; overhead: number }> {
  const r = await $.model.complete({
    model: RATER,
    system: ratingSystem(tier, level),
    prompt,
    maxTokens: 300,
    effort: 'low',
    timeoutMs: 10_000,
  })
  const usage = (r as { usage?: Usage }).usage
  const overhead = usage ? usageCost(prices, RATER, usage) : 0
  if (!r.isAnswered) {
    await log($, `rating failed: ${r.reason}`)
    return { overhead }
  }
  const rating = parseRating(r.text, tier)
  if (!rating) await log($, `rating unreadable: ${JSON.stringify(r.text.slice(0, 80))}`)
  return { rating, overhead }
}

// A general-purpose subagent the main chat starts with no model named runs on the
// main chat's model. Other types may set their own model, which a spawn does not show,
// so they are left as they are; so are forks, resumes and teammates, and workflow agents
// unless Workflows says to right-size every agent.
async function sizeSpawn($: EngineInterface, e: AgentSpawnInput, run: Run | null) {
  if (off || subagentMode === 'off') return undefined
  if (e.parentAgentId !== undefined || e.fork || e.isTeammate || e.resume) return undefined
  if (e.workflow && workflows !== 'right-size every agent') return undefined
  if (e.subagentType !== 'general-purpose' || (e.model !== undefined && e.model !== 'inherit')) return undefined
  const s = await situation($)
  const parent = tierOf(e.parentModel) ?? s.tier
  if (parent === TIERS[0]) return undefined
  const { rating: r, overhead } = await askRater($, parent, s.level, ratingPrompt(`${e.description}\n\n${e.prompt}`, ''))
  if (run) run.overhead += overhead
  if (!r) return undefined
  const size = sizeSubagent(r, { ...s, tier: parent }, parent, floor)
  if (size?.tie) await countTie($)
  const fit = TIERS.map(t => `${t[0]}:${r.fit[t] ?? (r.fit[t] === null ? 'no' : '?')}`).join(' ')
  await log($, `subagent "${e.description}" on ${parent}: rated ${fit}, ${size ? `sent to ${size.tier}/${size.level}${size.tie ? `, tie ${size.tie.by} over ${size.tie.over}` : ''}` : 'kept'}`)
  return size
    ? { from: parent, tier: size.tier, level: size.level, type: r.type, raw: size.raw, parentRaw: size.parentRaw, ...(size.tie ? { tie: size.tie } : {}), ...(e.workflow ? { inWorkflow: true } : {}) }
    : undefined
}

const costLine = (d: number, stay: number, cur: string) =>
  billing === 'api'
    ? `About ${money(d)} that way vs ${money(stay)} staying on ${cur} (estimated).`
    : `That uses ${share(d, stay)} the usage vs staying on ${cur} (estimated).`

type Decision = { level?: Level; session?: Level; auto?: boolean; delegate?: Run['delegate'] }

async function resolveEffort($: EngineInterface, p: Plan, r: Rating, s: Situation): Promise<Decision> {
  if (p.kind !== 'effort') return {}
  // A window nearly used up skips a raise, unless Raising is yours: then it follows your rule.
  if (p.dir === 'raise' && paceNow.mode === 'max' && (await choices($)).raise === undefined) return {}
  const c = p.dir === 'lower' ? await choice($, 'lower', qLower) : await choice($, 'raise', qRaise)
  if (c === 'auto') return { level: p.level, auto: p.dir === 'lower' }
  if (c !== 'ask') return {}
  const verb = p.dir === 'lower' ? 'Lower' : 'Raise'
  const why = r.reason ? ` (${r.reason})` : ''
  const a = await pick($, {
    header: 'Effort',
    question: `This looks like a ${p.level}-effort task${why}. ${verb} from ${s.level} to ${p.level}?`,
    options: [
      [`${verb} for this prompt`, 'prompt'],
      [`${verb} for this session`, 'session'],
      [`Keep ${s.level}`, 'keep'],
    ],
  })
  if (a === 'prompt') return { level: p.level }
  if (a === 'session') return { session: p.level }
  return {}
}

async function resolve($: EngineInterface, p: Plan, r: Rating, s: Situation): Promise<Decision> {
  if (p.kind === 'none') return {}
  if (p.kind === 'effort') return resolveEffort($, p, r, s)
  const cur = TIER_NAME[s.tier]
  const to = TIER_NAME[p.tier]
  const c = p.dir === 'up' ? await choice($, 'up', qUp(cur, to)) : await choice($, 'down', qDown(cur, to))
  const send: Decision = { delegate: { tier: p.tier, level: p.level, dir: p.dir } }
  const stay = () => resolveEffort($, effortPlan(r, s, floor), r, s)
  if (c === 'auto') return send
  if (c === 'stay') return stay()
  if (c !== 'ask' && c !== 'each') return {}
  const why = r.reason ? ` (${r.reason})` : ''
  const lead = p.dir === 'up' ? `This needs a stronger model${why}.` : `${to} at ${p.level} effort could do this${why}${p.instead ? `, where ${cur} needs ${p.instead}` : ''}.`
  const question = `${lead} Send it to a ${to} subagent? ${costLine(p.delegateCost, p.mainCost, cur)}`
  if (c === 'ask') {
    const a = await pick($, { header: 'Subagent', question, options: [[`Send it to a ${to} subagent`, 'send'], [`Stay on ${cur}`, 'stay']] })
    return a === 'send' ? send : a === 'stay' ? stay() : {}
  }
  const ep = effortPlan(r, s, floor)
  const options: (readonly [string, 'send' | 'effort' | 'keep'])[] = [[`Send it to a ${to} subagent`, 'send']]
  if (ep.kind === 'effort') options.push([`${ep.dir === 'lower' ? 'Lower' : 'Raise'} effort on ${cur} to ${ep.level}`, 'effort'])
  options.push([ep.kind === 'effort' ? 'Keep as is' : `Stay on ${cur}`, 'keep'])
  const a = await pick($, { header: 'Subagent', question, options })
  if (a === 'send') return send
  if (a === 'effort' && ep.kind === 'effort') return { level: ep.level }
  return {}
}

/** The hidden note that hands the request to a subagent and has the main chat check it. */
export function delegateNote(d: NonNullable<Run['delegate']>) {
  const name = TIER_NAME[d.tier]
  const why = d.dir === 'up' ? 'it needs a stronger model' : 'a cheaper model can do it for less'
  return [
    `[rightsize] The person has chosen to hand this request to a ${name} subagent, because ${why}. Do it this way:`,
    `1. Start one subagent with the Agent tool, model "${d.tier}", effort "${d.level}". Give it a complete brief: the goal, the files, facts and decisions it needs from this conversation, and a "Done means" list of 3 to 6 items that can be checked.`,
    '2. When it reports back, check its result against every Done-means item yourself. Use real proof where you can (run the tests, read the changed files), not its summary.',
    '3. If an item fails, send that subagent a specific fix-up note (continue it with SendMessage where you can; otherwise start it again with the note and its last result). At most 2 rework rounds.',
    d.dir === 'down'
      ? '4. If an item still fails after 2 reworks, finish the task yourself.'
      : '4. If an item still fails after 2 reworks, stop and say where it stands.',
    `5. Answer the person with the result and one line on how it went: "Done in 1 round", "Passed after N rework(s) (what was missed)", or ${
      d.dir === 'down' ? '"Finished it myself after 2 reworks (what was missed)"' : '"Still failing <item> after 2 reworks"'
    }.`,
  ].join('\n')
}

const planChange = (p: Plan): Change => (p.kind === 'none' ? 'none' : p.kind === 'effort' ? p.dir : `delegate-${p.dir}`)

/** `base` is the person's own level, before any session switch rightsize made: the level savings are counted against. */
function startRun(r: Rating, s: Situation, d: Decision, p: Plan, base: Level, overhead: number): Run {
  const level = d.level ?? d.session ?? s.level
  const change: Change = d.delegate
    ? `delegate-${d.delegate.dir}`
    : level === base
      ? 'none'
      : levelRank(level) < levelRank(base)
        ? 'lower'
        : 'raise'
  // A per-prompt switch goes and comes back; a session switch goes once.
  const switches = d.level && d.level !== s.level ? 2 : d.session ? 1 : 0
  return {
    id: `${sessionId}:${Date.now()}-${++runSeq}`,
    rating: r,
    tier: s.tier,
    normal: s.level,
    level: d.level,
    ranAt: level,
    context: s.context,
    workflows: 0,
    auto: d.auto === true,
    delegate: d.delegate,
    rawMain: rawMainCost(r, s, level),
    rawDelegate: d.delegate ? rawDelegateCost(r, s, d.delegate.tier, d.delegate.level) : undefined,
    stay: mainCost(r, s, base, 0),
    change,
    offered: planChange(p),
    takenMain: mainCost(r, s, level, switches),
    takenDelegate: d.delegate ? delegateCost(r, s, d.delegate.tier, d.delegate.level) : undefined,
    overhead,
    agentCalls: 0,
    subAgents: [],
    resized: [],
    mainCost: 0,
    subCost: 0,
    missCost: 0,
    sideCost: 0,
    errors: 0,
    steppedUp: false,
    delegated: false,
    pace: paceNow,
    signals: noSignals(),
    escalations: [],
    requests: 0,
  }
}

// ---- Reporting -------------------------------------------------------------

async function showStatus($: EngineInterface) {
  const run = active ?? pending
  if (run?.delegate) return $.ui.status(`Rightsize: handing this to a ${TIER_NAME[run.delegate.tier]} subagent`)
  if (run?.raisedTo) return $.ui.status(`Effort: ${run.raisedTo} (raised mid-turn)`)
  if (run?.steppedUp) return $.ui.status(`Effort: back to ${run.normal} (the task got harder)`)
  if (run?.level) return $.ui.status(run.auto ? `Effort: ${run.level} (auto) · /rightsize undo` : `Effort: ${run.level} (this prompt)`)
  if (!run && lastAuto) return $.ui.status(`Last prompt ran at ${lastAuto.level} (auto) · /rightsize undo`)
  const session = await sessionEffort($)
  $.ui.status(session ? `Effort: ${session} (this session, by rightsize)` : undefined)
}

// ---- Band ------------------------------------------------------------------

const BAND = { plugin: 'rightsize', key: 'band' } as const
const BAND_MODE = { plugin: 'rightsize', key: 'bandMode' } as const

const isBandMode = (v: unknown): v is BandMode => v === 'when it acts' || v === 'always' || v === 'off'

const setBand = ($: EngineInterface, band: Band | null) => $.state.set(BAND, band).catch(() => undefined)

async function setBandMode($: EngineInterface, v: BandMode) {
  bandMode = v
  await $.state.set(BAND_MODE, v).catch(() => undefined)
}

const RULE_NAME: Record<keyof Choices, string> = { lower: 'Lowering', raise: 'Raising', up: 'Stronger model', down: 'Cheaper model' }

// Short labels for the band's rule buttons. "Ask me each time" for a model
// change stays in /rightsize settings, to keep the band to one row.
const RULES: Record<keyof Choices, readonly (readonly [string, string])[]> = {
  lower: [['auto', 'Lower automatically'], ['ask', 'Ask me each time'], ['never', 'Never lower']],
  raise: [['auto', 'Raise automatically'], ['ask', 'Ask me each time'], ['never', 'Never raise']],
  up: [['auto', 'Always send'], ['ask', 'Ask first'], ['stay', 'Stay, raise effort only']],
  down: [['auto', 'Always send'], ['ask', 'Ask first'], ['stay', 'Stay, lower effort only']],
}

/** What the band shows for a rated prompt: what was done, or what was suggested and not done. */
export function bandFor(run: Pick<Run, 'id' | 'tier' | 'normal' | 'auto' | 'delegate' | 'stay' | 'takenDelegate'>, d: Decision, p: Plan): Band {
  const cur = TIER_NAME[run.tier]
  if (run.delegate) {
    const to = `${TIER_NAME[run.delegate.tier]} subagent at ${run.delegate.level} effort`
    const instead = p.kind === 'delegate' && p.instead && levelRank(p.instead) > levelRank(run.normal) ? ` instead of raising ${cur} to ${p.instead}` : ''
    return { text: `Sending this to a ${to}${instead}. ${costLine(run.takenDelegate ?? 0, run.stay, cur)}`, acted: true, rule: run.delegate.dir }
  }
  const level = d.level ?? d.session
  if (level) {
    const lower = levelRank(level) < levelRank(run.normal)
    const scope = d.level ? `this prompt${run.auto ? ' (automatically)' : ''}` : 'this session'
    return {
      text: `Effort ${lower ? 'lowered' : 'raised'}: ${run.normal} → ${level} for ${scope}.`,
      acted: true,
      rule: lower ? 'lower' : 'raise',
      // A lowering can be marked right or wrong: it was a bet on the rating.
      ...(lower ? { rate: run.id } : {}),
      ...(run.auto && d.level ? { canUndo: true } : {}),
      ...(d.session ? { canClear: true } : {}),
    }
  }
  if (p.kind === 'none') return { text: `No change: ${run.normal} on ${cur} fits this prompt.`, acted: false }
  const what = p.kind === 'effort' ? `${p.level} effort` : `a ${TIER_NAME[p.tier]} subagent at ${p.level}`
  const rule = p.kind === 'effort' ? (p.dir === 'lower' ? 'lower' : 'raise') : p.dir
  return { text: `No change: ${what} would fit, kept ${run.normal} on ${cur}.`, acted: false, rule }
}

async function setRule($: EngineInterface, key: keyof Choices, value: string) {
  await saveChoices($, { ...(await choices($)), [key]: value } as Choices, true)
  const label = RULES[key].find(r => r[0] === value)?.[1] ?? value
  $.ui.toast(`Rightsize: ${RULE_NAME[key]} is now "${label}".`)
}

async function undo($: EngineInterface) {
  if (!lastAuto) return 'Nothing to undo: the last prompt was not lowered automatically.'
  const { text, normal } = lastAuto
  lastAuto = null
  skipOnce = text.trim()
  const filled = await $.prompt.fill({ text, mode: 'replace' }).catch(() => null)
  await setBand($, null)
  await showStatus($)
  return filled?.isFilled
    ? `The prompt is back in the box. Press Enter to run it at ${normal}.`
    : `Could not fill the prompt box. Send the prompt again and it runs at ${normal}.`
}

async function clearSession($: EngineInterface) {
  const level = await sessionEffort($)
  await $.state.set({ plugin: 'rightsize', key: 'sessionEffort' }, null)
  await setBand($, null)
  await showStatus($)
  return level ? `Cleared the session switch to ${level}.` : 'No session switch was set.'
}

// 👍 or 👎 on a hand-off or a lowering: one line in the run log, read back on this machine only.
async function giveFeedback($: EngineInterface, ref: string, value: 'up' | 'down') {
  if (ratedRuns.has(ref)) return
  ratedRuns.add(ref)
  await appendRun($, { at: new Date().toISOString(), kind: 'feedback', session: sessionId, ref, value })
  const band = (await $.state.get(BAND).catch(() => undefined))?.value
  if (band?.rate === ref) {
    const { rate: _, ...rest } = band
    await setBand($, rest)
  }
  $.ui.toast('Rightsize: thanks — this tunes its choices on this machine.')
}

async function chooseBandMode($: EngineInterface) {
  const v = await pick($, qBand)
  if (v === undefined) return
  await setBandMode($, v)
  await putConfig($, 'band', v)
}

/** "Ran 2 of Claude's subagents on Haiku (low) instead of Opus." */
export function resizedText(xs: readonly Resized[]) {
  const to = [...new Set(xs.map(x => `${TIER_NAME[x.tier]} (${x.level})`))].join(' and ')
  const from = [...new Set(xs.map(x => TIER_NAME[x.from]))].join(' and ')
  const n = xs.length === 1 ? "Claude's subagent" : `${xs.length} of Claude's subagents`
  return `Ran ${n} on ${to} instead of ${from}.`
}

export function report(run: Pick<Run, 'tier' | 'stay'> & { delegate: NonNullable<Run['delegate']> }, actual: number, mode: 'api' | 'subscription') {
  const to = TIER_NAME[run.delegate.tier]
  const cur = TIER_NAME[run.tier]
  const vs = `${money(actual)} vs about ${money(run.stay)} staying on ${cur} (estimated)`
  if (mode === 'subscription') return `rightsize: Sent to ${to}: used ${share(actual, run.stay)} the usage vs staying on ${cur}. API-equivalent: ${vs}.`
  const diff = actual <= run.stay ? `saved about ${Math.round((1 - actual / Math.max(run.stay, 1e-9)) * 100)}%` : `cost ${share(actual, run.stay)} vs staying`
  return `rightsize: Sent to ${to}: ${vs}, ${diff}.`
}

const round = (n: number) => Number(n.toFixed(5))

function windows(limits: readonly { kind: string; percentUsed: number }[] | undefined): Windows | undefined {
  if (!limits?.length) return undefined
  return Object.fromEntries(limits.map(l => [l.kind, l.percentUsed]))
}

/** What every request carries that the person can trim and rightsize can't: MCP tools, memory files, agents, skills and commands. */
async function fixedContext($: EngineInterface) {
  const b = (await $.session.usage({ breakdown: 'summary' }).catch(() => undefined))?.context.breakdown
  if (!b) return undefined
  const sum = (xs: readonly { tokens: number }[]) => xs.reduce((n, x) => n + x.tokens, 0)
  const loaded = b.mcpTools.filter(t => t.isLoaded)
  const byServer = new Map<string, number>()
  for (const t of loaded) byServer.set(t.serverName, (byServer.get(t.serverName) ?? 0) + t.tokens)
  const mcp = sum(loaded)
  const memory = sum(b.memoryFiles)
  const agents = sum(b.agents)
  const skills = (b.skills?.tokens ?? 0) + (b.slashCommands?.tokens ?? 0)
  const servers = Object.fromEntries([...byServer.entries()].sort((a, c) => c[1] - a[1]).slice(0, 3))
  return { tokens: mcp + memory + agents + skills, mcp, memory, agents, skills, servers }
}

async function finish($: EngineInterface, run: Run, aborted: boolean, durationMs: number) {
  const r = run.rating
  const delegated = run.delegate !== undefined && run.delegated
  const tokens = run.mainCost + run.subCost
  // The ledger prices each response as /cost does, with the cache TTL it was really
  // written at; a background agent from an earlier turn finishing now counts in it too.
  const u = await usageNow($)
  const end = run.ledgerStart === undefined ? undefined : u?.cost?.usd
  const ledger = end === undefined || run.ledgerStart === undefined ? 0 : end - run.ledgerStart - run.sideCost
  const actual = ledger > 0 ? ledger : tokens
  // A workflow's agents say nothing about one route's estimate, in this turn or the ones after it.
  if (!aborted && actual > 0 && !workflowSeen) {
    if (delegated && run.delegate && run.rawDelegate) {
      const sample = ratioSample(actual, run.rawDelegate)
      for (const key of delegateKeys(r.type, run.delegate.tier, run.delegate.level)) teach(key, sample)
    }
    // A turn that stepped back up, or was raised mid-turn, ran at more than one
    // level, so its cost says nothing about one level's estimate: it teaches nothing.
    else if (!run.delegate && !run.steppedUp && !run.escalations.length) {
      const sample = ratioSample(Math.max(0, actual - run.missCost), run.rawMain)
      for (const key of mainKeys(r.type, run.tier, run.ranAt)) teach(key, sample)
    }
    await saveCal($)
  }
  // Every rated turn is logged, changed or not and stopped or not, for /rightsize report.
  if (actual > 0 || run.overhead > 0) {
    const fixed = await fixedContext($)
    const line: RunLine & Record<string, unknown> = {
      at: new Date().toISOString(),
      kind: 'run',
      id: run.id,
      session: sessionId,
      type: r.type,
      route: delegated ? `delegate:${run.delegate?.tier}` : 'main',
      tier: run.tier,
      level: run.steppedUp ? run.normal : (run.level ?? run.normal),
      // The session's own level and size: what the starting-point check replays from.
      normal: run.normal,
      context: run.context,
      fit: r.fit,
      // The rater's guesses behind the estimate, to tell a bad guess from a bad cost model.
      read: r.read,
      write: r.write,
      steps: r.steps,
      ...(delegated ? { subLevel: run.subLevel ?? null } : {}),
      ...(run.resized.length ? { resized: run.resized } : {}),
      ...(run.tie ? { tie: run.tie } : {}),
      ...(run.pace.mode !== 'normal' ? { pace: { ...run.pace, ...(run.pace.pace === undefined ? {} : { pace: Number(run.pace.pace.toFixed(2)) }) } } : {}),
      auto: run.auto,
      steppedUp: run.steppedUp,
      ...(run.escalations.length ? { escalations: run.escalations } : {}),
      estimate: Number((delegated ? (run.rawDelegate ?? 0) : run.rawMain).toFixed(5)),
      actual: round(actual),
      measured: ledger > 0 ? 'ledger' : 'tokens',
      tokens: round(tokens),
      stay: round(run.stay),
      taken: round(delegated ? (run.takenDelegate ?? run.takenMain) : run.takenMain),
      change: run.change,
      offered: run.offered,
      aborted,
      overhead: round(run.overhead),
      missCost: round(run.missCost),
      agentCalls: run.agentCalls,
      requests: run.requests,
      // Each request reads the fixed context from the cache, at least.
      ...(fixed ? { fixed: { ...fixed, cost: round((run.requests * fixed.tokens * prices[run.tier].cacheRead) / 1e6) } } : {}),
      ...(run.workflows ? { workflows: run.workflows } : {}),
      ...(workflowSeen ? { afterWorkflow: true } : {}),
      durationMs,
      ...(run.before ? { before: run.before } : {}),
      ...(windows(u?.rateLimits) ? { after: windows(u?.rateLimits) } : {}),
    }
    await appendRun($, line)
  }
  if (run.delegate && (!delegated || !aborted)) {
    const text = !delegated
      ? `rightsize: Claude did not hand this to a ${TIER_NAME[run.delegate.tier]} subagent; it ran on ${TIER_NAME[run.tier]} (${money(actual)}${billing === 'subscription' ? ' API-equivalent' : ''}).`
      : report({ tier: run.tier, stay: run.stay, delegate: run.delegate }, actual, billing)
    // The band shows the result in place of a transcript line; with the band off, the line stays.
    if (bandMode === 'off') $.ui.log(text)
    else await setBand($, { text: text.replace(/^rightsize: /, ''), acted: true, rule: run.delegate.dir, ...(delegated ? { rate: run.id } : {}) })
  }
  if (run.resized.length && bandMode !== 'off') {
    const text = resizedText(run.resized)
    const band = (await $.state.get(BAND).catch(() => undefined))?.value
    await setBand($, band?.acted ? { ...band, text: `${band.text} ${text}` } : { text, acted: true })
  }
  await showStatus($)
}

// The turn is struggling: one level up for the rest of it (never above Highest effort),
// the way the person's Raising rule says (asked mid-turn unless it is automatic). Each sign
// is weighed once, raised or not, so a "Keep" is not asked again for the same sign.
// A window nearly used up skips the raise only while Raising is left at its default.
async function escalate($: EngineInterface, run: Run, sign: Struggle, from: Level | undefined, step: number) {
  run.signals = { ...run.signals, fired: [...run.signals.fired, sign.kind] }
  const cur = run.raisedTo ?? from
  const to = cur ? oneUp(cur, ceiling) : undefined
  if (!cur || !to) return
  const rule = (await choices($)).raise
  if (paceNow.mode === 'max' && rule === undefined) {
    await log($, `mid-turn raise to ${to} skipped (${sign.why}): the usage window is nearly used up`)
    return
  }
  if (rule === 'never') return
  if (rule !== 'auto') {
    const a = await pick($, {
      header: 'Stuck',
      question: `Claude looks stuck: ${sign.why}. Raise effort from ${cur} to ${to} for the rest of this turn?`,
      options: [
        [`Raise to ${to} for this turn`, 'yes'],
        [`Keep ${cur}`, 'no'],
      ],
    })
    if (a !== 'yes') return
  }
  run.raisedTo = to
  run.escalations.push({ step, from: cur, to, why: sign.why })
  await setBand($, { text: `Effort raised mid-turn: ${cur} → ${to} (${sign.why}).`, acted: true, rule: 'raise' })
  await showStatus($)
  await log($, `raised mid-turn ${cur} → ${to} at step ${step}: ${sign.why}`)
}

// ---- Idle resume -------------------------------------------------------------

/** Each recent session's last turn, so a resume days later knows how long it sat. */
const LAST_TURNS = 'lastTurns'
type LastTurn = { at: number; context: number }

async function lastTurns($: EngineInterface): Promise<Record<string, LastTurn>> {
  const v = await $.store.get(LAST_TURNS).catch(() => undefined)
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, LastTurn>) : {}
}

async function rememberTurn($: EngineInterface) {
  lastTurnAt = await $.clock.now()
  if (!sessionId) return
  const all = { ...(await lastTurns($)), [sessionId]: { at: lastTurnAt, context: lastContext } }
  const recent = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, 20)
  await $.store.set(LAST_TURNS, Object.fromEntries(recent)).catch(() => undefined)
}

const idleFor = (ms: number) => {
  const m = Math.round(ms / 60_000)
  const n = (v: number, unit: string) => `${v} ${unit}${v === 1 ? '' : 's'}`
  return m < 120 ? n(m, 'minute') : m < 48 * 60 ? n(Math.round(m / 60), 'hour') : n(Math.round(m / 1440), 'day')
}

/** A subscriber's 5-hour window used per API-equivalent dollar over the last 30 days of runs; undefined until runs show it. */
async function windowPerDollar($: EngineInterface) {
  const now = await $.clock.now()
  const lines = parseLines<RunLine>(await readText($, `${home}/.claude/mods-logs/rightsize-runs.jsonl`))
  return windowRates(lines.filter(l => now - Date.parse(l.at) <= 30 * 24 * 60 * 60_000 && Date.parse(l.at) >= measureFrom), 'five_hour')?.perDollar
}

/** "$0.16" on the API; on a subscription, "0.8% of your 5-hour window ($0.16 API-equivalent)" once runs show the rate. */
function usageCostText(d: number, perDollar: number | undefined) {
  if (billing === 'api') return money(d)
  if (perDollar === undefined) return `${money(d)} API-equivalent`
  const pct = d * perDollar
  return `${pct < 0.1 ? 'under 0.1' : pct.toFixed(1)}% of your 5-hour window (${money(d)} API-equivalent)`
}

// After the cache expired, the next request writes the whole conversation again. Past
// 200K tokens Claude Code compacts an idle session before the cache expires, so this is
// for sessions under that. A subscriber is told the cost in their 5-hour window.
async function holdIdle($: EngineInterface): Promise<boolean> {
  if (idleWarning === null || billingBy === null) return false
  const last: LastTurn | undefined = lastTurnAt ? { at: lastTurnAt, context: lastContext } : (await lastTurns($))[sessionId]
  if (!last || last.at === idleWarnedFor) return false
  const idle = (await $.clock.now()) - last.at
  const context = lastContext || last.context
  if (idle < cacheTtl || !context || context >= IDLE_MAX_CONTEXT) return false
  const s = await situation($)
  const c = idleCost(prices[s.tier], context)
  if (c.resend < idleWarning) return false
  idleWarnedFor = last.at
  const perDollar = billing === 'subscription' ? await windowPerDollar($) : undefined
  const a = await pick($, {
    header: 'Idle',
    question: `This session sat idle for ${idleFor(idle)}, so its cache has likely expired. Sending writes the whole conversation (~${Math.round(context / 1000)}K tokens) to the cache again: about ${usageCostText(c.resend, perDollar)} more on ${TIER_NAME[s.tier]} than a warm cache. /clear costs nothing; /compact about ${usageCostText(c.compact, perDollar)}.`,
    options: [
      ['Send it', false],
      ['Hold it: I will /clear or /compact first', true],
    ],
  })
  await log($, `idle ${idleFor(idle)} with ${context} tokens: ${a ? 'held' : 'sent'}`)
  return a === true
}

// A subagent's step whose id no spawn has answered yet: the engine started it before
// next(e) settled. Match it to the spawn by what $.agent.list() shows of it.
async function claim($: EngineInterface, id: string) {
  if (!spawning.length || resizedRuns.has(id) || active?.subAgents.includes(id)) return
  const row = (await $.agent.list().catch(() => [])).find(a => a.id === id)
  if (!row || row.parentId !== undefined) return
  const w = spawning.find(x => !x.id && x.description === row.description && x.type === row.type)
  if (!w) return
  w.id = id
  if (w.run && !w.run.subAgents.includes(id)) w.run.subAgents.push(id)
  if (w.size) resizedRuns.set(id, { ...w.size, spend: 0 })
}

// A moved subagent's answer: what its own requests cost teaches the estimate for its
// model and level, and the log keeps it for the report. A background one often
// answers after the turn that started it ended, so this is its own line. A
// resumed subagent starts counting again.
async function finishSubagent($: EngineInterface, m: Measured, aborted: boolean) {
  const spend = m.spend
  m.spend = 0
  if (spend <= 0) return
  // A workflow's agents say nothing about one route's estimate: they teach nothing, and the report counts no saving for them.
  if (!aborted && !m.inWorkflow) {
    const sample = ratioSample(spend, m.raw)
    for (const key of subagentKeys(m.type, m.tier, m.level)) teach(key, sample)
    await saveCal($)
  }
  const line: RunLine = {
    at: new Date().toISOString(),
    kind: 'subagent',
    ...(m.inWorkflow ? { afterWorkflow: true } : {}),
    session: sessionId,
    type: m.type,
    from: m.from,
    tier: m.tier,
    level: m.level,
    estimate: round(m.raw),
    parentEstimate: round(m.parentRaw),
    actual: round(spend),
    aborted,
  }
  await append($, 'rightsize-runs.jsonl', JSON.stringify(line), RUNS_LOG_MAX)
}

async function summary($: EngineInterface) {
  const c = await choices($)
  const session = await sessionEffort($)
  // One run teaches its type:route key and, for a hand-off, finer keys too: count the first only.
  const runs = Object.entries(cal).filter(([k]) => k !== SWITCH_KEY && k.split(':').length === 2).reduce((n, [, e]) => n + e.n, 0)
  const sw = cal[SWITCH_KEY]
  // Each setting with its value, and whose it is: yours when you set it in /config or answered it.
  const row = (key: SettingKey, shown: string = cfg[key], by: string = yours.has(key) ? 'yours' : 'default') => `${SETTINGS[key].title}: ${shown} (${by})`
  const rule = (r: keyof Choices) => row(RULE_KEYS[r], ruleLabel(r, c[r]), c[r] === undefined ? 'default' : 'yours')
  const reports = row('billing', billing, billingYours() ? 'yours' : (billingBy ?? 'default'))
  const sees = detectedBilling === 'subscription' ? 'a subscription' : 'API billing'
  const install = sharing ? await $.store.get('shareInstall').catch(() => undefined) : undefined
  return [
    `Rightsize is ${off ? 'off (turn it on with /mods)' : 'on'}. Each setting is yours when you set it in /config or answered its question, and rightsize never changes or bypasses what is yours; the rest are defaults.`,
    `Effort: ${[row('floor'), row('ceiling'), row('escalation'), row('stuck')].join('. ')}.`,
    `Rules: ${[rule('lower'), rule('raise'), rule('up'), rule('down'), row('remember')].join('. ')}.`,
    `Models: ${[row('useHaiku'), row('useFable'), row('subagents'), row('workflows'), row('explore')].join('. ')}.`,
    `Thresholds: ${[row('handOff'), row('lowering'), row('missPause'), row('pacing')].join('. ')}.${pacing && paceNow.mode !== 'normal' ? ` ${paceNote(paceNow)}` : ''}`,
    `Prompts: ${[row('minWords'), row('raterCheck'), row('startTips'), row('idleWarning')].join('. ')}.`,
    `Reporting: ${[reports, row('band'), row('priceCheck'), row('share')].join('. ')}.`,
    ...(billingYours() && detectedBilling && detectedBilling !== billing ? [`Rate limits look like ${sees}; Reports is set to ${billing} by you.`] : []),
    ...(typeof install === 'string' ? [`Sharing install ID: ${install} (quote it to rightsize@aivalue.blog to ask about or delete your shared data).`] : []),
    session ? `Session switch: ${session}.` : 'No session switch.',
    `Calibration: ${runs} measured run(s).${sw ? ` Effort switches that missed the cache: ${Math.round(sw.ratio * 100)}% of ${sw.n} (each one in ~/.claude/mods-logs/rightsize-switches.jsonl).` : ''}`,
    '/rightsize report shows what it saved and what went wrong; settings asks the questions again; undo re-runs the last auto-lowered prompt; clear drops the session switch; prices checks prices now; share prints a message you can paste to tell others about rightsize; reset [setting] puts settings back to their defaults and/or restarts cost measurement.',
  ].join('\n')
}

// ---- Reset -------------------------------------------------------------------------

// /rightsize reset: settings back to their defaults, and/or cost measurement started over. Both ask first.

type ResetWhat = 'settings' | 'measurement' | 'both'
const qReset: Question<ResetWhat | 'cancel'> = {
  header: 'Reset',
  question: 'What should I reset?',
  options: [
    ['Settings', 'settings'],
    ['Cost measurement', 'measurement'],
    ['Both', 'both'],
    ['Cancel', 'cancel'],
  ],
}
const qConfirm = (question: string): Question<boolean> => ({
  header: 'Confirm',
  question,
  options: [
    ['Yes', true],
    ['No', false],
  ],
})
const SETTINGS_GO = 'Every rightsize setting in /config goes back to its default, and your saved answers to the four questions are forgotten.'
const MEASURE_GO = 'rightsize goes back to its starting estimates and relearns from your next prompts.'
const UNDONE = "This can't be undone."

function confirmText(what: ResetWhat | SettingKey) {
  if (what === 'settings') return `Reset settings? ${SETTINGS_GO} ${UNDONE}`
  if (what === 'measurement') return `Reset cost measurement? ${MEASURE_GO} ${UNDONE}`
  if (what === 'both') return `Reset settings and cost measurement? ${SETTINGS_GO} ${MEASURE_GO} ${UNDONE}`
  const rule = RULE_IDS.some(r => RULE_KEYS[r] === what) ? ' Its question is asked again the next time it comes up.' : ''
  return `Reset ${SETTINGS[what].title}? It goes back to its default, ${SETTINGS[what].default}.${rule} ${UNDONE}`
}

/** Keeps the list of reset rows (see settings.ts stillReset) in memory and in the store. */
async function keepReset($: EngineInterface, next: ReadonlySet<SettingKey>) {
  resetFields = next
  await $.store.set('resetFields', [...next]).catch(() => undefined)
}

/** The row is yours again (set after a reset): it leaves the list. */
async function forgetReset($: EngineInterface, key: SettingKey) {
  if (resetFields.has(key)) await keepReset($, mark(resetFields, key, false))
}

// Reports back to its default: the answer goes, and the next response's rate limits read the billing again.
async function resetBilling($: EngineInterface) {
  const saved = (await $.store.get('billing').catch(() => undefined)) as { by?: unknown } | undefined
  if (saved?.by === 'answered') await $.store.set('billing', null).catch(() => undefined)
  if (billingBy === 'answered') billingBy = null
  billingAsked = false
}

// Each row goes back to its default through `$.config.set`. A stored value cannot be unset, so the rows reset
// are listed in the store, and count as defaults, not yours, while what is stored is the default.
async function resetSettings($: EngineInterface, keys: readonly SettingKey[], all: boolean) {
  const blocked: string[] = []
  let listed = resetFields
  for (const key of keys) {
    const dflt = SETTINGS[key].default
    const changes = cfg[key] !== dflt
    if (changes) {
      const r = await $.config.set({ key: `rightsize.${key}`, value: dflt }).catch(() => ({ deny: 'it could not be written' }))
      if (r.deny !== undefined) {
        blocked.push(SETTINGS[key].title)
        continue
      }
    }
    if (changes || yours.has(key)) listed = mark(listed, key, true)
    cfg = { ...cfg, [key]: dflt }
    yours = mark(yours, key, false)
    applyOption(key)
    const rule = RULE_IDS.find(r => RULE_KEYS[r] === key)
    if (rule) await followRuleRow($, rule, dflt)
    else if (changes || key === 'remember') await followRow($, key, dflt)
    if (key === 'billing') await resetBilling($)
  }
  if (all) {
    await $.state.set({ plugin: 'rightsize', key: 'choices' }, {})
    await $.store.set('choices', null).catch(() => undefined)
  }
  await keepReset($, listed)
  const what = all ? 'Every setting is back to its default, and the saved answers are forgotten.' : `${SETTINGS[keys[0] ?? 'floor'].title} is back to its default, ${SETTINGS[keys[0] ?? 'floor'].default}.`
  return blocked.length ? `${what} Not reset, because something else owns them: ${blocked.join(', ')}.` : what
}

// Cost measurement starts over: the calibration, the close-call and spot-check counts and the start checks go,
// and the run log before now teaches rightsize nothing. The log itself, and the report's history, stay.
async function resetMeasurement($: EngineInterface) {
  await saving.catch(() => undefined)
  cal = {}
  unsaved = []
  for (const key of [CAL_STORE, TIES_STORE, SPOT_STORE, 'startCheckedAt', 'startSnooze']) await $.store.set(key, null).catch(() => undefined)
  measureFrom = await $.clock.now()
  await $.store.set('measureFrom', new Date(measureFrom).toISOString()).catch(() => undefined)
  await refreshMisses($)
  return 'Cost measurement restarted: rightsize is back to its starting estimates and relearns from your next prompts. The run log and the report history are kept.'
}

async function runReset($: EngineInterface, name: string): Promise<string> {
  let what: ResetWhat | SettingKey
  name = name.trim()
  if (name) {
    const key = settingNamed(name)
    if (!key) return `No setting called "${name}". Settings: ${KEYS.join(', ')}. /rightsize reset with no name resets all settings, the cost measurement, or both.`
    what = key
  } else {
    const a = await pick($, qReset)
    if (a === undefined || a === 'cancel') return 'Nothing was reset.'
    what = a
  }
  if ((await pick($, qConfirm(confirmText(what)))) !== true) return 'Nothing was reset.'
  const out: string[] = []
  if (what === 'settings' || what === 'both') out.push(await resetSettings($, KEYS, true))
  else if (what !== 'measurement') out.push(await resetSettings($, [what], false))
  if (what === 'measurement' || what === 'both') out.push(await resetMeasurement($))
  return out.join(' ')
}

// ---- Sharing -------------------------------------------------------------------

// Opt-in only. After 20 rated prompts, rightsize asks once whether to share anonymous
// numbers (share.ts says exactly which) with its author. On a yes it sends what the
// log gains from then on, at most once an hour; it never sends what came before.

const qShare: Question<boolean> = {
  header: 'Share',
  question:
    'Help improve rightsize? Share anonymous numbers with its author: task types, models, effort levels, estimated and real costs, what went wrong, and your 👍 and 👎. Never your prompts, code, file names or paths. Turn it off any time with Share anonymous feedback in /config.',
  options: [
    ['Share anonymous numbers', true],
    ["Don't share", false],
  ],
}

async function setShare($: EngineInterface, on: boolean) {
  sharing = on
  if (!on) {
    // A new yes later starts a new install id.
    await $.store.set('shareInstall', null).catch(() => undefined)
    return
  }
  const install = await $.store.get('shareInstall').catch(() => undefined)
  if (typeof install === 'string' && /^[a-f0-9]{32}$/.test(install)) return
  await $.store.set('shareInstall', newInstall()).catch(() => undefined)
  await $.store.set('sharedUpTo', new Date(await $.clock.now()).toISOString()).catch(() => undefined)
}

async function askShare($: EngineInterface) {
  if (sharing || (await $.store.get('shareAsked').catch(() => undefined)) === true) return
  if (runLog.filter(l => (l.kind ?? 'run') === 'run').length < SHARE_ASK_AFTER) return
  await $.store.set('shareAsked', true).catch(() => undefined)
  const yes = await pick($, qShare)
  await log($, `share question: ${yes === true ? 'yes' : yes === false ? 'no' : 'dismissed'}`)
  if (yes !== true) return
  await setShare($, true)
  await putConfig($, 'share', 'on')
  $.ui.toast('Rightsize: thanks. Anonymous numbers will be shared; Share anonymous feedback in /config turns it off.')
}

async function sendShare($: EngineInterface) {
  try {
    if (!sharing || off) return
    const now = await $.clock.now()
    if (now - sharedAt < SHARE_EVERY_MS) return
    if (await $.env.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC').catch(() => undefined)) return
    const install = await $.store.get('shareInstall').catch(() => undefined)
    if (typeof install !== 'string') return
    const after = await $.store.get('sharedUpTo').catch(() => undefined)
    const { events, upTo } = nextBatch(runLog, install, typeof after === 'string' ? after : undefined)
    if (!upTo) return
    sharedAt = now
    if (events.length) {
      const body = JSON.stringify({ install, version, billing, events })
      const res = await $.http.fetch(SHARE_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
      if (!res.ok) return log($, `share: the server answered ${res.status}; sent again later`)
      await log($, `share: sent ${events.length} event(s)`)
    }
    await $.store.set('sharedUpTo', upTo).catch(() => undefined)
  } catch (err) {
    await log($, `share failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// ---- Starting point ----------------------------------------------------------

// Once a week at session start, replay the last 30 days of rated prompts from each
// starting model and level; when another start is clearly better, the band says so.
// rightsize never changes the default model itself: the person switches with /model.

const DAY_MS = 24 * 60 * 60_000

const startContext = async ($: EngineInterface) => ({ prices, cal, rules, floor, choices: await choices($), ceiling, without, from: measureFrom })

async function checkStart($: EngineInterface) {
  if (off || startEvery === null) return
  const now = await $.clock.now()
  const last = await $.store.get('startCheckedAt').catch(() => undefined)
  if (typeof last === 'number' && now - last < startEvery * DAY_MS) return
  await $.store.set('startCheckedAt', now).catch(() => undefined)
  const a = adviseFromLog(await readText($, `${home}/.claude/mods-logs/rightsize-runs.jsonl`), await startContext($), now)
  await log($, `start check: ${a.kind}${a.kind === 'switch' ? ` ${startKey(a.current)} -> ${startKey(a.to)} (${a.why}, ${Math.round(a.saving * 100)}%)` : ''}`)
  if (a.kind !== 'switch') return
  const key = startKey(a.to)
  const snooze = (await $.store.get('startSnooze').catch(() => undefined)) as { key?: unknown; until?: unknown } | undefined
  if (snooze?.key === key && typeof snooze.until === 'number' && now < snooze.until) return
  const text = startTip(a, billing === 'subscription')
  if (bandMode === 'off') $.ui.log(`rightsize: ${text}`)
  else await setBand($, { text, acted: true, tip: key })
}

async function snoozeStart($: EngineInterface, key: string) {
  await $.store.set('startSnooze', { key, until: (await $.clock.now()) + START_SNOOZE_DAYS * DAY_MS }).catch(() => undefined)
  await setBand($, null)
}

async function stopStartTips($: EngineInterface) {
  await putConfig($, 'startTips', 'off')
  await setBand($, null)
  $.ui.toast('Rightsize: no more starting-model suggestions. Start suggestions in /config turns them back on.')
}

// ---- Hooks -----------------------------------------------------------------

// Sets the module's variable for one row from `cfg`: at load, when /config changes it, and when rightsize writes it itself.
function applyOption(key: SettingKey) {
  const v = cfg[key]
  switch (key) {
    case 'floor':
      if (isLevel(v)) floor = v
      return
    case 'ceiling':
      if (isLevel(v)) ceiling = v
      return
    case 'lowerRule':
    case 'raiseRule':
    case 'upRule':
    case 'downRule':
      // The rules follow their rows through the session's choices (session start, followRuleRow).
      return
    case 'remember':
      rememberMode = v === 'every session' || v === 'this session' ? v : 'ask'
      return
    case 'handOff':
    case 'lowering':
      rules = { handOff: parseShare(cfg.handOff, DEFAULT_RULES.handOff), lower: parseShare(cfg.lowering, DEFAULT_RULES.lower) }
      return
    case 'useHaiku':
    case 'useFable':
      without = [...(cfg.useHaiku === 'off' ? ['haiku' as const] : []), ...(cfg.useFable === 'off' ? ['fable' as const] : [])]
      return
    case 'subagents':
      subagentMode = v === 'off' ? 'off' : 'cheaper when it fits'
      return
    case 'workflows':
      workflows = v === 'pause rightsize' || v === 'follow my rules' || v === 'right-size every agent' ? v : 'ask'
      return
    case 'explore':
      explore = v !== 'off'
      return
    case 'missPause':
      missBlock = missPauseOf(v)
      return
    case 'pacing':
      pacing = v !== 'off'
      return
    case 'escalation':
      escalation = v !== 'off'
      return
    case 'stuck':
      if (isSensitivity(v)) limits = LIMITS[v]
      return
    case 'minWords':
      minWords = minWordsOf(v)
      return
    case 'raterCheck':
      spotEvery = raterEvery(v)
      return
    case 'startTips':
      startEvery = v === 'weekly' || v === 'monthly' ? START_CHECK_DAYS[v] : null
      return
    case 'idleWarning':
      idleWarning = parseIdleWarning(v)
      return
    case 'billing':
      billing = v === 'subscription' ? 'subscription' : 'api'
      return
    case 'band':
      if (isBandMode(v)) bandMode = v
      return
    case 'share':
      sharing = v === 'on'
      return
    case 'priceCheck':
      if (v === 'monthly' || v === 'off') priceCheck = v
      return
    default: {
      const unhandled: never = key
      return unhandled
    }
  }
}

// What a row's change does besides setting its variable, once /config has written it.
async function followRow($: EngineInterface, key: SettingKey, value: string) {
  switch (key) {
    case 'band':
      await setBandMode($, bandMode)
      return
    case 'share':
      await setShare($, value === 'on')
      return
    case 'billing':
      // Reports set in /config by the person counts as the answer to the billing question.
      if (isBilling(value) && yours.has('billing')) await saveBilling($, value, 'answered')
      return
    case 'lowerRule':
      await followRuleRow($, 'lower', value)
      return
    case 'raiseRule':
      await followRuleRow($, 'raise', value)
      return
    case 'upRule':
      await followRuleRow($, 'up', value)
      return
    case 'downRule':
      await followRuleRow($, 'down', value)
      return
    case 'remember': {
      if (value === 'every session') {
        const have = await choices($)
        if (Object.keys(have).length) await keepChoices($, have)
      } else if (value === 'ask') {
        // Ask again: the question comes back after the next answer.
        await $.store.set('remember', false).catch(() => undefined)
        await $.state.set({ plugin: 'rightsize', key: 'rememberAsked' }, false)
      }
      return
    }
    default:
      return
  }
}

export const register: Register = (on, options) => {
  declared = (options ?? {}) as Record<string, unknown>
  cfg = valuesOf(declared)
  for (const key of KEYS) applyOption(key)

  // Every setting takes effect the moment /config changes it, not at the next start. A change
  // by the person marks the row as theirs (settings.ts), so rightsize's own behaviour leaves it be.
  for (const key of KEYS) {
    on('config.set', { key: `rightsize.${key}` }, async ($, e, next) => {
      if (e.key !== `rightsize.${key}`) return next(e)
      const result = await next(e)
      if (result.deny !== undefined || !inOptions(key, result.value)) return result
      cfg = { ...cfg, [key]: result.value }
      yours = afterSet(yours, e.key, result.value, e.origin)
      if (yours.has(key)) await forgetReset($, key)
      applyOption(key)
      await followRow($, key, result.value)
      return result
    })
  }

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    // The plugin can live anywhere (a clone, ~/Projects), so ask for HOME rather than reading it off the path.
    home = (await $.env.get('HOME').catch(() => undefined)) || ($.plugin.root.split('/.claude/')[0] ?? '')
    sessionId = await $.session.id().catch(() => '')
    pending = null
    active = null
    lastApplied = undefined
    lastContext = 0
    workflowSeen = false
    askedWorkflows.clear()
    resizedRuns.clear()
    spawning.length = 0
    lastTurnAt = 0
    idleWarnedFor = 0
    await $.command.register({ name: CMD, description: 'Rightsize: status, report, share, settings, undo or clear' })
    // Claude Code hands over every value with its default filled in; only settings.json tells which ones are yours.
    const configs = await $.settings.read({ key: 'pluginConfigs' }).catch(() => undefined)
    const resetBefore = resetKeys(await $.store.get('resetFields').catch(() => undefined))
    yours = fieldsSet(configs, declared, resetBefore)
    resetFields = new Set(stillReset(configs, declared, resetBefore))
    if (resetFields.size !== resetBefore.length) await $.store.set('resetFields', [...resetFields]).catch(() => undefined)
    const from = await $.store.get('measureFrom').catch(() => undefined)
    measureFrom = typeof from === 'string' && Number.isFinite(Date.parse(from)) ? Date.parse(from) : 0
    const gaps = manifestGaps(declared, yours)
    if (gaps.length) await log($, `settings: plugin.json and the settings table disagree: ${gaps.join('; ')}`)
    await setBandMode($, bandMode)
    await setBand($, null)
    const priceFile = await readText($, `${$.plugin.root}/prices.json`)
    prices = parsePrices(priceFile)
    cacheTtl = cacheTtlMs(priceFile)
    if (priceCheck === 'monthly') {
      const lastChecked = await $.store.get('pricesCheckedAt').catch(() => undefined)
      const now = await $.clock.now()
      if (isDue(lastChecked, now)) {
        // Claim the check before fetching: a second session starting at the same
        // moment then finds it done. A failed check gives the claim back.
        await $.store.set('pricesCheckedAt', now).catch(() => undefined)
        void runCheck($, 'monthly', lastChecked)
      }
    }
    cal = parseCalibration(await $.store.get(CAL_STORE).catch(() => undefined))
    // Until this session's first response shows its rate limits, an earlier session's reading stands.
    const saved = (await $.store.get('billing').catch(() => undefined)) as { value?: unknown; by?: unknown } | undefined
    billingAsked = false
    billingBy = null
    detectedBilling = undefined
    billing = cfg.billing === 'subscription' ? 'subscription' : 'api'
    if (isBilling(saved?.value)) {
      billing = saved.value
      billingBy = saved.by === 'answered' ? 'answered' : 'saved'
    }
    // Reports set in /config is the person's answer: it stands over a saved reading and over the rate limits.
    if (yours.has('billing')) {
      billing = cfg.billing === 'subscription' ? 'subscription' : 'api'
      billingBy = 'answered'
    }
    // The rules: answers saved by an earlier session, then this session's, then any rule set in /config.
    const kept = (await remembers($)) ? await $.store.get('choices').catch(() => undefined) : undefined
    const given = await choices($)
    const followed: Choices = { ...(kept && typeof kept === 'object' ? (kept as Choices) : {}), ...given, ...rulesOf(cfg) }
    await $.state.set({ plugin: 'rightsize', key: 'choices' }, followed)
    // Answers an earlier session saved show in /config too, so the rows say what rightsize follows.
    if (kept && typeof kept === 'object') await mirrorRules($, followed)
    runLog = parseLines<RunLine>(await readText($, `${home}/.claude/mods-logs/rightsize-runs.jsonl`))
    ratedRuns.clear()
    await refreshMisses($)
    off = (await readSwitches($))[NAME] === false
    await checkStart($).catch(() => undefined)
    try {
      version = String((JSON.parse(await readText($, `${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: unknown }).version ?? '')
    } catch {
      version = ''
    }
    sharedAt = 0
    void sendShare($)
    $.clock.every(3000, () => {
      void readSwitches($).then(json => {
        off = json[NAME] === false
      })
    })
    await showStatus($)
    return result
  })

  on('command.run', { command: CMD }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'undo') return { text: await undo($) }
    if (arg === 'reset' || arg.startsWith('reset ')) return { text: await runReset($, e.args.trim().slice('reset'.length)) }
    if (arg === 'prices') return { text: await runCheck($, 'manual') }
    if (arg === 'report') {
      const dir = `${home}/.claude/mods-logs`
      const runs = parseLines<RunLine>(await readText($, `${dir}/rightsize-runs.jsonl`))
      const switches = parseLines<SwitchLine>(await readText($, `${dir}/rightsize-switches.jsonl`))
      const now = await $.clock.now()
      const start = startLines(adviseFromLog(await readText($, `${dir}/rightsize-runs.jsonl`), await startContext($), now), billing === 'subscription', money)
      return { text: buildReport(runs, switches, { now, session: sessionId, subscription: billing === 'subscription', start, pause: missBlock, ...(measureFrom ? { measureFrom: new Date(measureFrom).toISOString() } : {}) }) }
    }
    if (arg === 'share') {
      const runs = parseLines<RunLine>(await readText($, `${home}/.claude/mods-logs/rightsize-runs.jsonl`))
      return { text: shareMessage(runs, { now: await $.clock.now(), subscription: billing === 'subscription', ...(measureFrom ? { measureFrom: new Date(measureFrom).toISOString() } : {}) }) }
    }
    if (arg === 'clear') return { text: await clearSession($) }
    if (arg === 'settings') {
      const s = await situation($)
      const cur = TIER_NAME[s.tier]
      const up = TIERS.filter(t => tierRank(t) > tierRank(s.tier))
      const down = TIERS.filter(t => tierRank(t) < tierRank(s.tier))
      billingAsked = false
      if (billingYours()) {
        const v = await pick($, qBilling)
        if (v !== undefined) await answerBilling($, v)
      } else await knowBilling($, true)
      const next: Choices = {}
      next.lower = await pick($, qLower)
      next.raise = await pick($, qRaise)
      if (up.length) next.up = await pick($, qUp(cur, names(up)))
      if (down.length) next.down = await pick($, qDown(cur, names(down)))
      for (const k of Object.keys(next) as (keyof Choices)[]) if (next[k] === undefined) delete next[k]
      await $.state.set({ plugin: 'rightsize', key: 'rememberAsked' }, false)
      await $.store.set('remember', false).catch(() => undefined)
      await saveChoices($, next, true)
      return { text: await summary($) }
    }
    return { text: await summary($) }
  })

  on('prompt.submit', async ($, e, next) => {
    if (off || !fromPerson(e) || e.command || e.isMeta) return next(e)
    // A new prompt replaces the last one's band.
    await setBand($, null)
    const text = e.text.trim()
    if (skipOnce !== null && text === skipOnce) {
      skipOnce = null
      return next(e)
    }
    if (text.startsWith('/')) return next(e)
    if (await holdIdle($)) {
      await $.prompt.fill({ text: e.text, mode: 'replace' }).catch(() => null)
      return { drop: 'rightsize held this prompt and put it back in the box. Run /clear or /compact, then send it.' }
    }
    if (words(text) < minWords) return next(e)
    if (brainDumpWillCatch(text, await readSwitches($))) return next(e)

    await knowBilling($, true)
    $.ui.status('Rightsize: rating the prompt...')
    let out = e
    let run: Run | null = null
    try {
      const base = await situation($)
      paceNow = pacing ? paceOf((await usageNow($))?.rateLimits ?? [], await $.clock.now()) : NORMAL_PACE
      // Pacing moves only a threshold left at its default: one you set stays as you set it.
      const set = { handOff: yours.has('handOff'), lower: yours.has('lowering') }
      const movedRules = pacedRules(base.rules ?? DEFAULT_RULES, paceNow, set)
      const s: Situation = { ...base, rules: movedRules }
      const { rating: r, overhead, prompt } = await rate($, text, s)
      if (r) {
        // While Claude fans work out to workflows, a single hand-off would only cut across it. After one,
        // Workflows says whether hand-offs go on (follow my rules, right-size every agent) or wait (the default).
        const planned = plan(r, s, floor)
        const unfanned = workflowSeen && planned.kind === 'delegate' && (workflows === 'ask' || workflows === 'pause rightsize') ? effortPlan(r, s, floor) : planned
        // A window nearly used up: nothing that costs more than staying, unless the matching rule
        // (Raising for more effort, Stronger model for a stronger one) is yours: then it follows your rule.
        const costlier = (unfanned.kind === 'effort' && unfanned.dir === 'raise') || (unfanned.kind === 'delegate' && unfanned.dir === 'up')
        const mine = await choices($)
        const followsYou = unfanned.kind === 'effort' ? mine.raise !== undefined : mine.up !== undefined
        const skipped = paceNow.mode === 'max' && costlier && !followsYou
        const p: Plan = skipped ? { kind: 'none', why: 'the usage window is nearly used up' } : unfanned
        const d = await resolve($, p, r, s)
        if (d.session) await $.state.set({ plugin: 'rightsize', key: 'sessionEffort' }, d.session)
        if (d.delegate) out = { ...e, context: [...(e.context ?? []), delegateNote(d.delegate)] }
        run = startRun(r, s, d, p, (await seenEffort($)) ?? s.level, overhead)
        // A close call the guide broke: kept on the run for the log, and counted so every fifth explores.
        if (planned.kind === 'delegate' && planned.tie) {
          run.tie = planned.tie
          await countTie($)
        }
        const was = base.rules ?? DEFAULT_RULES
        const note = paceNote(paceNow, skipped || movedRules.handOff !== was.handOff || movedRules.lower !== was.lower)
        const band = p !== unfanned
          ? { text: `Kept ${s.level} on ${TIER_NAME[s.tier]} instead of ${unfanned.kind === 'delegate' ? `a ${TIER_NAME[unfanned.tier]} subagent` : `raising to ${unfanned.kind === 'effort' ? unfanned.level : ''}`}.`, acted: true }
          : bandFor(run, d, p)
        await setBand($, note ? { ...band, text: `${band.text} ${note}` } : band)
        const did = d.delegate ? `delegate ${d.delegate.tier}` : d.level ? `${d.auto ? 'auto ' : ''}${d.level} for the prompt` : d.session ? `${d.session} for the session` : 'no change'
        const fit = TIERS.map(t => `${t[0]}:${r.fit[t] ?? (r.fit[t] === null ? 'no' : '?')}`).join(' ')
        if (unfanned !== planned) await log($, `hand-off to ${planned.kind === 'delegate' ? planned.tier : '?'} skipped: a workflow ran this session`)
        const paced = paceNow.mode === 'normal' ? '' : `, ${paceNow.mode} pace on ${paceNow.window}${paceNow.pace === undefined ? '' : ` (${paceNow.pace.toFixed(2)})`}`
        await log($, `${r.type} on ${s.tier}/${s.level}${paced}: rated ${fit}, plan ${p.kind}${'dir' in p ? ` ${p.dir}` : ''}${run.tie ? ` (tie ${run.tie.by} over ${run.tie.over})` : ''}: ${did}`)
        // Every 50th rating gets Sonnet's second opinion, in the background.
        if (await dueCheck($)) void spotCheck($, sessionId, s.tier, s.level, prompt, r)
      } else if (overhead > 0) {
        // A rating that came to nothing still cost something: the report counts it.
        const line: RunLine = { at: new Date().toISOString(), kind: 'overhead', session: sessionId, overhead: round(overhead) }
        await append($, 'rightsize-runs.jsonl', JSON.stringify(line), RUNS_LOG_MAX)
      }
    } catch (err) {
      await log($, `rating threw: ${err instanceof Error ? err.message : String(err)}`)
    }
    pending = run
    lastAuto = run?.auto && run.level ? { text: e.text, level: run.level, normal: run.normal } : null
    await showStatus($)
    return next(out)
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) {
      // The hand-off's subagent, and a subagent moved to a cheaper model, run at the
      // level their model needs, whatever Claude asked for.
      await claim($, e.agentId)
      const run = active
      const ours = run?.delegate && run.subAgents.includes(e.agentId) ? run.delegate : undefined
      const sized = resizedRuns.get(e.agentId)
      const level = ours?.level ?? sized?.level
      const send = level && e.effort !== undefined ? { ...e, effort: level } : e
      if (run && ours && isLevel(send.effort)) run.subLevel = send.effort
      const out = yield* next(send)
      if (out.usage) {
        const cost = usageCost(prices, out.usage.model, out.usage)
        if (run) run.subCost += cost
        if (sized) sized.spend += cost
      }
      return out
    }
    if (pending && active?.turnId !== e.turnId) {
      // Read after the rating call, so the ledger's difference is the turn's own cost.
      const u = await usageNow($)
      active = { ...pending, turnId: e.turnId, ledgerStart: u?.cost?.usd, before: windows(u?.rateLimits) }
      pending = null
    }
    const run = active?.turnId === e.turnId ? active : null
    if (isLevel(e.effort)) await $.state.set({ plugin: 'rightsize', key: 'seenEffort' }, e.effort)
    const session = await sessionEffort($)
    const own = session ?? (isLevel(e.effort) ? e.effort : undefined)
    let level: Level | undefined = run?.level ?? session ?? undefined
    if (run?.auto && (e.index >= STEP_UP_AFTER || run.errors > 0)) {
      level = own
      if (!run.steppedUp) {
        run.steppedUp = true
        await setBand($, { text: `Effort back to ${run.normal}: the task got harder.`, acted: true, rule: 'lower' })
        await showStatus($)
      }
    }
    // A hand-off's main chat only briefs and checks: its struggle is the subagent's.
    if (run && !run.delegate && escalation && !off) {
      const sign = struggle(run.signals, e.index, run.rating.steps, limits)
      if (sign) await escalate($, run, sign, level ?? own, e.index)
    }
    if (run?.raisedTo && (!level || levelRank(run.raisedTo) > levelRank(level))) level = run.raisedTo
    const send = level && e.effort !== undefined ? { ...e, effort: level } : e
    const applied = isLevel(send.effort) ? send.effort : undefined
    const out = yield* next(send)
    const u = out.usage
    if (u) {
      // An effort switch may make this request re-write the conversation: measure it.
      if (applied && lastApplied && applied !== lastApplied && lastContext > 5000) {
        const missed = u.cache_read_input_tokens < lastContext * 0.5
        teach(SWITCH_KEY, missed ? 1 : 0)
        // One line per measured switch: the evidence for whether the engine keeps the cache.
        await append(
          $,
          'rightsize-switches.jsonl',
          JSON.stringify({
            at: new Date().toISOString(),
            model: u.model,
            from: lastApplied,
            to: applied,
            context: lastContext,
            cacheRead: u.cache_read_input_tokens,
            cacheWrite: u.cache_creation_input_tokens,
            kept: !missed,
          }),
          RUNS_LOG_MAX,
        )
        const t = tierOf(u.model)
        if (missed && run && t) run.missCost += (u.cache_creation_input_tokens * (prices[t].cacheWrite - prices[t].cacheRead)) / 1e6
        void saveCal($)
      }
      if (applied) lastApplied = applied
      lastContext = contextOf(u)
      await $.state.set({ plugin: 'rightsize', key: 'context' }, lastContext)
      await $.state.set({ plugin: 'rightsize', key: 'seenModel' }, u.model)
      if (run) {
        run.mainCost += usageCost(prices, u.model, u)
        run.requests += 1
      }
    }
    return out
  })

  on('tool.call', async ($, e, next) => {
    // Ultracode's fan-out runs through the Workflow tool, from the main chat or a subagent.
    // Until Workflows is answered, the person is asked before the workflow starts.
    if (String(e.tool) === 'Workflow' && !off) {
      if (askingWorkflow) await askingWorkflow
      if (workflows === 'ask') {
        const id = (e as { tool_use_id?: unknown }).tool_use_id
        askingWorkflow = askWorkflow($, typeof id === 'string' && id ? id : undefined).finally(() => {
          askingWorkflow = null
        })
        await askingWorkflow
      }
    }
    const result = await next(e)
    if (String(e.tool) === 'Workflow') {
      workflowSeen = true
      if (active) active.workflows += 1
    }
    if (active && e.agentId === undefined) {
      const model = (e as { model?: unknown }).model
      if (String(e.tool) === 'Agent' && active.delegate && tierOf(typeof model === 'string' ? model : undefined) === active.delegate.tier) active.delegated = true
      if (String(e.tool) === 'Agent' || String(e.tool) === 'SendMessage') active.agentCalls += 1
      const isError = (result as { isError?: boolean }).isError === true
      if (isError) active.errors += 1
      // A refused call (a denied permission) says nothing about the work.
      if (!(result as { deny?: string }).deny) active.signals = noteCall(active.signals, callKey(String(e.tool), e as Record<string, unknown>), isError)
    }
    return result
  }).catch(($, e, next) => next(e))

  // The main chat starting the hand-off's subagent: the Agent call names its model.
  // Remember its id, so its steps run at the hand-off's level. A subagent Claude
  // starts on its own with no model named goes to the cheapest model that fits.
  on('agent.spawn', async ($, e, next) => {
    const run = active ?? pending
    const size = await sizeSpawn($, e, run).catch(() => undefined)
    const ours = run?.delegate && e.parentAgentId === undefined && !e.fork && tierOf(e.model) === run.delegate.tier
    const wait: Spawning | undefined = ours || size ? { description: e.description, type: e.subagentType, ...(ours && run ? { run } : {}), ...(size ? { size } : {}) } : undefined
    if (wait) spawning.push(wait)
    let result: Awaited<ReturnType<typeof next>>
    try {
      result = await next(size ? { ...e, model: size.tier } : e)
    } finally {
      if (wait) spawning.splice(spawning.indexOf(wait), 1)
    }
    const id = result.agentId
    if (run && ours && id && !run.subAgents.includes(id)) run.subAgents.push(id)
    if (size && id && tierOf(result.model) === size.tier) {
      if (!resizedRuns.has(id)) resizedRuns.set(id, { ...size, spend: 0 })
      run?.resized.push({ from: size.from, tier: size.tier, level: size.level, type: size.type, ...(size.tie ? { tie: size.tie } : {}) })
    } else if (id) resizedRuns.delete(id)
    return result
  }).catch(($, e, next) => next(e))

  // One row above the prompt: what rightsize did, then buttons to undo it, change
  // the rule for this situation, choose when the band shows, or close it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (off || e.props.hasSurvey) return next(e)
    const mode = (await $.state.get(BAND_MODE).catch(() => undefined))?.value ?? bandMode
    const band = (await $.state.get(BAND).catch(() => undefined))?.value
    if (!band || mode === 'off' || (mode === 'when it acts' && !band.acted)) return next(e)
    const rule = band.rule
    const have = rule ? (await choices($))[rule] : undefined
    const buttons: { key: string; label: string; press: () => Promise<unknown> }[] = []
    if (band.canUndo) buttons.push({ key: 'undo', label: 'Undo', press: async () => $.ui.toast(await undo($)) })
    if (band.canClear) buttons.push({ key: 'clear', label: 'Clear', press: async () => $.ui.toast(await clearSession($)) })
    if (band.tip) {
      const tip = band.tip
      buttons.push({ key: 'tip-later', label: 'Not now', press: () => snoozeStart($, tip) })
      buttons.push({ key: 'tip-stop', label: 'Stop suggesting', press: () => stopStartTips($) })
    }
    if (band.rate) {
      const ref = band.rate
      buttons.push({ key: 'good', label: '👍', press: () => giveFeedback($, ref, 'up') })
      buttons.push({ key: 'bad', label: '👎', press: () => giveFeedback($, ref, 'down') })
    }
    if (rule) {
      for (const [value, label] of RULES[rule]) {
        if (value !== have) buttons.push({ key: `rule-${value}`, label, press: () => setRule($, rule, value) })
      }
    }
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        <Text>
          <Text dimColor>rightsize: </Text>
          {band.text}
        </Text>
        {buttons.map((b, i) => (
          <Button key={b.key} label={b.label} hotkey={String(i + 1)} onPress={() => void b.press()} />
        ))}
        <Button key="mode" label="⋯" onPress={() => void chooseBandMode($)} />
        <Button key="close" label="×" role="dismiss" onPress={() => void setBand($, null)} />
      </Box>
    )
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const sized = e.agentId === undefined ? undefined : resizedRuns.get(e.agentId)
    if (sized) await finishSubagent($, sized, e.isAborted)
    if (e.agentId === undefined) {
      await knowBilling($, false)
      await rememberTurn($)
    }
    if (e.agentId === undefined && active && active.turnId === e.turnId) {
      const run = active
      active = null
      await finish($, run, e.isAborted, e.durationMs)
      await askShare($).catch(() => undefined)
    }
    if (e.agentId === undefined) void sendShare($)
    return result
  })
}

