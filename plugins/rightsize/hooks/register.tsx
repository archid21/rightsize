import type { AgentSpawnInput, ConfigSetResult, EngineInterface, PromptSubmitInput, Register } from 'claude-code'
import type {
  RightsizeBand as Band,
  RightsizeBandMode as BandMode,
  RightsizeChoices as Choices,
  RightsizeLevel as Level,
  RightsizeTaskType as TaskType,
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
  isTaskType,
  levelRank,
  REVIEW_LEVEL,
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
import { howSure, missCounts, missMap, ownTasks, pauseRates } from './misses'
import { SHARE_ASK_AFTER, SHARE_EVERY_MS, SHARE_URL, newInstall, nextBatch } from './share'
import { START_CHECK_DAYS, START_SNOOZE_DAYS, adviseStart, startBlock, startKey, startTip } from './start'
import {
  KEYS,
  NOT_SET,
  PROFILES,
  RULE_KEYS,
  SETTINGS,
  type Profile,
  type SettingKey,
  type Values,
  afterSet,
  defaults,
  fieldsSet,
  inOptions,
  inUse,
  manifestGaps,
  mark,
  plainTitle,
  profileOf,
  resetKeys,
  ruleLabel,
  ruleValue,
  rulesOf,
  settingNamed,
  stillReset,
  valuesOf,
} from './settings'
import { BRIEF_MAX, cutRequest, parseRating, ratingPrompt, ratingSystem } from './rate'
import { isApprovalStep } from './approval'
import { LIMITS, type Limits, type Signals, type Struggle, blockedError, callKey, isSensitivity, isTestCommand, noSignals, noteCall, oneUp, struggle } from './struggle'
import { type Change, type HelperLine, type RunLine, type SwitchLine, type Windows, SESSION_TOTAL, buildReport, parseLines, sessionTotal, shareMessage, windowRates } from './report'

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
// level for the rest of the turn (tool.call, turn.step). The cheaper helpers are
// watched the same way: a struggling one is raised a level from the task's retry budget, or
// sent back to the main chat when none is left (watches, escalateHelper). Billing (API or subscription) is read off the rate limits each
// response carries; the person is asked only when they say nothing. A band
// above the prompt shows what it did, with buttons to undo it or change the rule.
// Your setting wins: every row in /config is a setting (settings.ts), and a value the
// person set, or answered, is never changed or bypassed by what rightsize does by itself.

const NAME = 'rightsize'
const CMD = 'rightsize'
/** The rater tried second, when the first is not available, and the one Rater row can pick first. */
const FALLBACK_RATER = 'haiku'
type Rater = 'sonnet' | 'haiku'
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
type Measured = Resized & { raw: number; parentRaw: number; spend: number; inWorkflow?: boolean; task?: string; run?: string; /** The rating's guess of its tool calls: what a long run is measured against. */ steps?: number }
/** A spawn the engine is starting: its first step can come before its id does. */
type Spawning = { description: string; type: string; run?: Run; size?: Omit<Measured, 'spend'>; id?: string }
type SubagentMode = 'cheaper when it fits' | 'off'
type Question<V> = { header: string; question: string; options: readonly (readonly [string, V])[] }

// The four questions list the answer the profile prefers first, marked (Recommended). The answer's
// value comes from its own option, so it is right whatever the order.
function recommend<V>(q: Question<V>, first: V): Question<V> {
  const at = q.options.findIndex(o => o[1] === first)
  if (at < 0) return q
  const [label, value] = q.options[at] as readonly [string, V]
  return { ...q, options: [[`${label} (Recommended)`, value], ...q.options.filter((_, i) => i !== at)] }
}

const qLower = (): Question<Lower> =>
  recommend(
    {
      header: 'Lowering',
      question: 'When a prompt needs less effort, what should I do?',
      options: [
        ['Lower automatically', 'auto'],
        ['Ask me each time', 'ask'],
        ['Never lower', 'never'],
      ],
    },
    answers.lower,
  )
const qRaise = (): Question<Raise> =>
  recommend(
    {
      header: 'Raising',
      question: 'When a prompt needs more effort on the same model, what should I do?',
      options: [
        ['Raise automatically', 'auto'],
        ['Ask me each time', 'ask'],
        ['Never raise', 'never'],
      ],
    },
    answers.raise,
  )
const qUp = (cur: string, to: string): Question<Route> =>
  recommend(
    {
      header: 'Stronger',
      question: `When a prompt needs a stronger model than ${cur} (such as ${to}), what should I do?`,
      options: [
        ['Use the stronger model automatically', 'auto'],
        ['Ask before using it', 'ask'],
        [`Stay on ${cur}, raise effort only`, 'stay'],
        ['Ask me each time', 'each'],
      ],
    },
    answers.up,
  )
const qDown = (cur: string, to: string): Question<Route> =>
  recommend(
    {
      header: 'Cheaper',
      question: `When a task could run on a cheaper model than ${cur} (such as ${to}), what should I do?`,
      options: [
        ['Send it to a cheaper subagent', 'auto'],
        ['Ask before sending it', 'ask'],
        [`Stay on ${cur}, lower effort only`, 'stay'],
        ['Ask me each time', 'each'],
      ],
    },
    answers.down,
  )
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

/** Why the rater may have seen too little: the request was cut, or a task is in progress and Claude's last reply could not be read. */
type Unsure = 'cut' | 'missing'

/** One rated prompt, from prompt.submit until its turn completes. */
type Run = {
  /** Unique to this run: its log line carries it, and 👍 and 👎 name it. */
  id: string
  /** The task this run belongs to: the id of the run that started it. */
  task: string
  /** The prompt as submitted, trimmed: a turn that starts with this text is the one this run is bound to. */
  text: string
  /** When the prompt was submitted, in ms. */
  submittedAt: number
  /** The turn that was running when the prompt was submitted: it was typed over that turn, or delivered into it. Absent when the session was idle. */
  during?: string
  /** True from the prompt's submit until the engine has answered it: it can still be dropped, so no idle submit unbinds it. */
  entering?: boolean
  /** The turn this run is bound to, once its turn has started. */
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
  /** The main chat runs this turn on another model, then goes back: a review on Opus. */
  switchTo?: { tier: Tier; level: Level }
  /** A fixed rule chose the route rather than the rating: reviews run on Opus at high or more. */
  rule?: 'review'
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
  /** Tool errors that came from the environment (blockedError): not struggling, so not in `errors`. */
  blocked: number
  /** The prompt continued its task: the type the rater gave it, when planning used the task's type instead. */
  ratedType?: TaskType
  /** The rating may rest on too little context, so no lowering or hand-down was made on it. */
  unsure?: Unsure
  steppedUp: boolean
  delegated: boolean
  change: Change
  offered: Change
  /** Calibrated estimates of the main-chat route and of the hand-off, as decided. */
  takenMain: number
  takenDelegate?: number
  /** The model that rated the prompt. */
  rater?: Rater
  /** The rating call's cost. */
  overhead: number
  /** Wall time of all this prompt's rating attempts, in ms. Measured and reported; never used to choose a route. */
  ratingMs?: number
  agentCalls: number
  /** Main-chat steps only the person can approve (push, publish, deploy, send). */
  approvalSteps: number
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
let rules: Rules = { ...DEFAULT_RULES, handOff: PROFILES.Balanced.handOff }
let checking: Promise<string> | null = null
let prices: Prices = DEFAULT_PRICES
let cal: Calibration = {}
/** Rated prompts whose turn has not started, oldest first. A turn takes the first one with its text (turn.start). */
let pending: Run[] = []
let active: Run | null = null
/** Main-chat turns that have ended in this session: a prompt delivered into one of them never gets a turn of its own. */
const completed = new Set<string>()
let lastApplied: Level | undefined
/** The last main-chat step ran on a model rightsize rewrote. */
let lastSwitched = false
let lastContext = 0
/**
 * The last prompt's route, for the band's one-click overrides: a lowering (Undo) or a hand-off or switch-run (Run on
 * the current model). `back` finishes "run it ...": where the prompt runs once the override is pressed. One slot: a
 * prompt takes one route.
 */
let lastAuto: { text: string; back: string; kind: 'lower'; level: Level; normal: Level } | { text: string; back: string; kind: 'route'; model: string } | null = null
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
/** Models rightsize sends no work to (Use Haiku, Use Fable off). The rater is set apart: Rater picks it. */
let without: Tier[] = []
/** The profile in use (Profile). It supplies the defaults of the values below it, where their rows are not yours (settings.ts inUse). */
let profile: Profile = 'Balanced'
/** The miss rate at which hand-downs and lowering pause; null: never. */
let missBlock: number | null = MISS_BLOCK
/** The tasks a kind of work must have logged on a model before a cheaper route to it is used; 0: no minimum. */
let minTasks = 0
/** The outcomes logged per task type and model (misses.ts): minTasks is counted against these. */
// Before the log is read, the research priors alone.
let counts: Record<string, number> = missCounts([])
/** The tasks the log itself holds per type and model, research priors left out: what "How sure" in the band counts. */
let ownCounts: Record<string, number> = {}
/**
 * Chances a task has to retry: a helper raised a level, or the main chat reworking a hand-off. When they
 * are used up, the helper goes back to the main chat and the main chat finishes the task itself.
 */
let chances = PROFILES.Balanced.chances
/** The first option of each of the four questions. */
let answers = PROFILES.Balanced.answers
/** One close call in five takes the route the guide did not pick. Off in every profile. */
let explore = false
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
/** Ask Sonnet for a second opinion on every this many Haiku ratings, in the background; null: off. */
let spotEvery: number | null = PROFILES.Balanced.raterEvery
/** The model that rates first (Rater). The other one is the fallback. */
let rater: Rater = 'sonnet'
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

/** What rightsize has seen of one helper (the hand-off's subagent, or a moved one): its signs, steps and time, and what it did about them. */
type Watch = {
  kind: 'handoff' | 'moved'
  /** The run whose turn started it: that run's log line lists it. */
  run?: string
  /** The task whose retry budget it draws on. */
  task: string
  /** The level it was sent at, and the level of its later steps after a raise. */
  level: Level
  raisedTo?: Level
  /** The rating's guess of its tool calls. */
  rated: number
  signals: Signals
  steps: number
  startedAt: number
  /** When it answered; undefined while it runs. */
  ms?: number
  blocked: number
  raises: { step: number; from: Level; to: Level; why: string }[]
  stall?: 'struggling' | 'blocked'
  /** Stopped and sent back: its tool calls are refused from here on. */
  returned?: true
  /** The can't-tell and blocked cases are logged once. */
  said?: boolean
}
/** Every helper watched this session, by agent id. */
const watches = new Map<string, Watch>()
/** One spend of the retry budget at a time: two helpers asking together never both take the last chance. */
let spending: Promise<unknown> = Promise.resolve()

const fromPerson = (e: PromptSubmitInput) => e.origin.kind === 'composer' || e.origin.kind === 'bridge'
const names = (tiers: readonly Tier[]) => tiers.map(t => TIER_NAME[t]).join(' or ')

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

// Every session writes its own folder, ~/.claude/mods-logs/rightsize/<session>/, and nobody else's, so two
// sessions never overwrite each other's lines. Readers merge every folder (and the old shared files).
const LEGACY_RUNS = 'rightsize-runs.jsonl'
const LEGACY_SWITCHES = 'rightsize-switches.jsonl'
/** A session folder nobody has written to for this long is removed at the next session start. */
const PRUNE_AFTER_DAYS = 45

const logsDir = () => `${home}/.claude/mods-logs`
const sessionsDir = () => `${logsDir()}/rightsize`
/** The session id as a folder name: nothing but letters, digits, "_" and "-", so it cannot reach outside the logs. */
const folderOf = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, '_') || 'unknown'
const sessionDir = () => `${sessionsDir()}/${folderOf(sessionId)}`

/** The tail of each file's writes, by path: a write starts when the one before it has ended. */
const writing = new Map<string, Promise<unknown>>()

async function writeLine($: EngineInterface, path: string, line: string, max: number) {
  try {
    const old = await readText($, path)
    // New folders 700, new file 600; chmod only when the file is new.
    if (!old) await $.process.run(['mkdir', '-m', '700', '-p', path.slice(0, path.lastIndexOf('/'))])
    let text = `${old}${line}\n`
    if (text.length > max) text = text.slice(text.indexOf('\n', text.length - max) + 1)
    await $.fs.write(path, text)
    if (!old) {
      const dir = path.slice(0, path.lastIndexOf('/'))
      // mkdir -m sets the mode of the last folder only; the two above it are ours too.
      await $.process.run(['chmod', '700', logsDir(), sessionsDir(), dir])
      await $.process.run(['chmod', '600', path])
    }
  } catch {
    // Logging must never hold up a prompt.
  }
}

// The only way a log is written. A write reads the file, adds a line and writes it back, so two writes
// at once would both start from the same old text and one line would be lost: each waits for the one before.
function append($: EngineInterface, name: string, line: string, max: number) {
  const path = `${sessionDir()}/${name}`
  const turn = (writing.get(path) ?? Promise.resolve()).then(() => writeLine($, path, line, max))
  writing.set(path, turn)
  void turn.then(() => {
    if (writing.get(path) === turn) writing.delete(path)
  })
  return turn
}

const log = ($: EngineInterface, line: string) => append($, 'rightsize.log', `${new Date().toISOString()} ${line}`, 50_000)

const atOf = (l: { at: string }) => Date.parse(l.at) || 0

// Every line of one kind from every session's folder and from the old shared file, oldest first. A file that
// cannot be read or parsed leaves the others whole.
async function readAll<T extends { at: string }>($: EngineInterface, name: string, legacy: string): Promise<T[]> {
  const files = [`${logsDir()}/${legacy}`]
  try {
    for (const d of await $.fs.list(sessionsDir())) if (d.kind === 'dir') files.push(`${sessionsDir()}/${d.name}/${name}`)
  } catch {
    // No session folders yet.
  }
  const parts = await Promise.all(files.map(f => readText($, f).then(t => parseLines<T>(t)).catch(() => [] as T[])))
  return parts.flat().sort((a, b) => atOf(a) - atOf(b))
}

const readRuns = ($: EngineInterface) => readAll<RunLine>($, 'runs.jsonl', LEGACY_RUNS)
const readSwitchLines = ($: EngineInterface) => readAll<SwitchLine>($, 'switches.jsonl', LEGACY_SWITCHES)

// Removes the folders of sessions that have not written for 45 days. Only a folder inside the
// sessions folder, never this session's, and only when every entry in it is a file that old.
async function pruneSessions($: EngineInterface) {
  try {
    const now = await $.clock.now()
    const own = folderOf(sessionId)
    const folderName = /^[A-Za-z0-9_-]+$/
    const fileName = /^[A-Za-z0-9_.-]+$/
    for (const d of await $.fs.list(sessionsDir())) {
      if (d.kind !== 'dir' || d.name === own || !folderName.test(d.name)) continue
      const folder = `${sessionsDir()}/${d.name}`
      const files = await $.fs.list(folder)
      if (!files.length || files.some(f => f.kind !== 'file' || !fileName.test(f.name) || now - f.mtimeMs <= PRUNE_AFTER_DAYS * 24 * 60 * 60_000)) continue
      for (const f of files) await $.process.run(['rm', '-f', `${folder}/${f.name}`])
      await $.process.run(['rmdir', folder])
    }
  } catch {
    // A folder that stays is tried again at the next start.
  }
}

// The routes whose first automatic miss was forgiven, across sessions (misses.ts pauseRates): each is forgiven once, ever.
const FORGIVEN_STORE = 'forgivenRoutes'

async function forgivenSeen($: EngineInterface): Promise<string[]> {
  const v = await $.store.get(FORGIVEN_STORE).catch(() => undefined)
  return Array.isArray(v) && v.every(x => typeof x === 'string') ? v : []
}

// Scores the rater again from the last 30 days of the run log (misses.ts). With `announce`, a forgiven miss
// also shows in the band: the turn that had it is the one that just ended.
async function refreshMisses($: EngineInterface, announce = false) {
  try {
    const now = await $.clock.now()
    runLog = runLog.filter(l => now - Date.parse(l.at) <= MISS_WINDOW_DAYS * 24 * 60 * 60_000)
    // Lines from before Cost measurement was restarted teach nothing.
    const measured = runLog.filter(l => Date.parse(l.at) >= measureFrom)
    const { rates, forgiven } = pauseRates(measured, new Set(await forgivenSeen($)))
    misses = missMap(rates)
    counts = missCounts(measured)
    ownCounts = ownTasks(measured)
    if (!forgiven.length) return
    // Read again just before writing, so the routes another session forgave are kept.
    await $.store.set(FORGIVEN_STORE, [...new Set([...(await forgivenSeen($)), ...forgiven])]).catch(() => undefined)
    const routes = forgiven.map(key => key.split(':') as [TaskType, Tier])
    for (const [type, tier] of routes) await log($, `forgave the first miss on ${type} on ${TIER_NAME[tier]}: the next miss counts`)
    if (announce) {
      bandNote = routes.map(([type, tier]) => `${TIER_NAME[tier]} missed once on ${type} work; that one is forgiven, and the next miss pauses it.`).join(' ')
      await setBand($, { text: bandNote, acted: true })
    }
  } catch {
    // The old rates stand.
  }
}

/** Adds a line to the run log, and to the rater's record in memory. */
async function appendRun($: EngineInterface, line: RunLine) {
  await append($, 'runs.jsonl', JSON.stringify(line), RUNS_LOG_MAX)
  runLog.push(line)
  await refreshMisses($, true)
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

// The task in progress, kept from the last rating that started one. A follow-up that continues the task
// is planned as its type, so a one-line "yes, go ahead" is not typed as a new kind of work, and carries its
// id, so the log ties the brief, the follow-ups, the repairs and the subagents to one task. It also keeps how the task
// began (the first 600 characters of its prompt) and how many prompts it has had, which the rater is told so that a
// short follow-up is read in its task. A task stored before those were kept reads as one prompt with no brief.
async function currentTask($: EngineInterface) {
  const v = (await $.state.get({ plugin: 'rightsize', key: 'task' }).catch(() => undefined))?.value
  if (!v || typeof v.id !== 'string' || !isTaskType(v.type)) return null
  return { id: v.id, type: v.type, brief: typeof v.brief === 'string' ? v.brief : '', prompts: Number.isInteger(v.prompts) && v.prompts > 0 ? v.prompts : 1 }
}

// The text of a failed tool call, as the model read it.
function errorText(result: unknown): string {
  const r = result as { text?: unknown; result?: unknown }
  if (typeof r.text === 'string') return r.text
  if (typeof r.result === 'string') return r.result
  try {
    return r.result === undefined ? '' : JSON.stringify(r.result)
  } catch {
    return ''
  }
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
  const v = await askWithin($, withWait(qBilling, 'reports use API prices for now'), late => answerBilling($, late))
  if (v === TIMED_OUT) {
    // Not saved: it is asked again next session.
    billing = 'api'
    await logTimeout($, 'Billing', 'reports use API prices for this session; not saved')
  } else if (v !== undefined) await answerBilling($, v)
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

/** How long a question waits for the person before rightsize takes the choice that changes nothing and costs nothing. */
const QUESTION_WAIT_MS = 120_000
const WAIT_MINUTES = QUESTION_WAIT_MS / 60_000
const TIMED_OUT: unique symbol = Symbol('timed out')

/** A question's text with the sentence that says what happens when nobody answers. */
const withWait = <V,>(q: Question<V>, what: string): Question<V> => ({ ...q, question: `${q.question} No answer in ${WAIT_MINUTES} minutes: ${what}.` })

// Asks, and waits QUESTION_WAIT_MS for the answer. Past that it returns TIMED_OUT, so the caller takes its
// safe default, and an answer that comes later goes to `onLate` (without one, a toast says it came too late).
// A dismissed question stays undefined, as with pick().
async function askWithin<V>($: EngineInterface, q: Question<V>, onLate?: (v: V) => void | Promise<void>): Promise<V | undefined | typeof TIMED_OUT> {
  let late = false
  const asked = pick($, q).then(v => {
    if (late && v !== undefined) {
      void Promise.resolve(onLate ? onLate(v) : $.ui.toast('rightsize: that answer came too late; nothing changed.')).catch(() => undefined)
    }
    return v
  })
  const waited = $.clock.sleep(QUESTION_WAIT_MS).then((): typeof TIMED_OUT => TIMED_OUT, (): typeof TIMED_OUT => TIMED_OUT)
  const a = await Promise.race([asked, waited])
  if (a === TIMED_OUT) late = true
  return a
}

/** One log line for a question nobody answered in time. */
const logTimeout = ($: EngineInterface, header: string, did: string) => log($, `no answer in ${WAIT_MINUTES} minutes to ${header}: ${did}`)

const RULE_IDS = Object.keys(RULE_KEYS) as (keyof Choices)[]

// The directory reads a settings write only as { key: 'fixed text', value: ... }, so each row has its own call.
// The return type makes a new row without a case here fail the type check.
function writeSetting($: EngineInterface, key: SettingKey, value: string): Promise<ConfigSetResult> {
  switch (key) {
    case 'profile': return $.config.set({ key: 'rightsize.profile', value: value })
    case 'floor': return $.config.set({ key: 'rightsize.floor', value: value })
    case 'ceiling': return $.config.set({ key: 'rightsize.ceiling', value: value })
    case 'lowerRule': return $.config.set({ key: 'rightsize.lowerRule', value: value })
    case 'raiseRule': return $.config.set({ key: 'rightsize.raiseRule', value: value })
    case 'upRule': return $.config.set({ key: 'rightsize.upRule', value: value })
    case 'downRule': return $.config.set({ key: 'rightsize.downRule', value: value })
    case 'remember': return $.config.set({ key: 'rightsize.remember', value: value })
    case 'handOff': return $.config.set({ key: 'rightsize.handOff', value: value })
    case 'lowering': return $.config.set({ key: 'rightsize.lowering', value: value })
    case 'useHaiku': return $.config.set({ key: 'rightsize.useHaiku', value: value })
    case 'useFable': return $.config.set({ key: 'rightsize.useFable', value: value })
    case 'subagents': return $.config.set({ key: 'rightsize.subagents', value: value })
    case 'workflows': return $.config.set({ key: 'rightsize.workflows', value: value })
    case 'explore': return $.config.set({ key: 'rightsize.explore', value: value })
    case 'missPause': return $.config.set({ key: 'rightsize.missPause', value: value })
    case 'pacing': return $.config.set({ key: 'rightsize.pacing', value: value })
    case 'escalation': return $.config.set({ key: 'rightsize.escalation', value: value })
    case 'stuck': return $.config.set({ key: 'rightsize.stuck', value: value })
    case 'rater': return $.config.set({ key: 'rightsize.rater', value: value })
    case 'raterCheck': return $.config.set({ key: 'rightsize.raterCheck', value: value })
    case 'startTips': return $.config.set({ key: 'rightsize.startTips', value: value })
    case 'idleWarning': return $.config.set({ key: 'rightsize.idleWarning', value: value })
    case 'billing': return $.config.set({ key: 'rightsize.billing', value: value })
    case 'band': return $.config.set({ key: 'rightsize.band', value: value })
    case 'share': return $.config.set({ key: 'rightsize.share', value: value })
    case 'priceCheck': return $.config.set({ key: 'rightsize.priceCheck', value: value })
  }
}

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
  await writeSetting($, key, value).catch(() => undefined)
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
  const v = await askWithin($, withWait(qWorkflow, 'rightsize pauses for this workflow'), late => putConfig($, 'workflows', late))
  if (v === TIMED_OUT) {
    await logTimeout($, 'Workflow', 'rightsize paused for this workflow; not saved')
    return
  }
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
  // A late answer is applied as an on-time one would be, to the choices as they stand then.
  const yes = await askWithin($, withWait(qRemember, 'this session only'), async late => {
    if (late !== true) return
    await $.store.set('remember', true).catch(() => undefined)
    await keepChoices($, await choices($))
    await putConfig($, 'remember', 'every session')
  })
  if (yes === TIMED_OUT) {
    await logTimeout($, 'Remember', 'these choices stay for this session only')
  } else if (yes === true) {
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
  // No answer in time: this prompt runs with no change, nothing is saved, and the question comes back next time.
  // An answer that comes later is saved as the rule, unless a newer answer is already there.
  const v = await askWithin($, withWait(q, 'this prompt runs as it is'), async late => {
    if ((await choices($))[key]) return void $.ui.toast('rightsize: that answer came too late; nothing changed.')
    await saveChoices($, { ...(await choices($)), [key]: late })
    $.ui.toast('rightsize: saved your answer for next time.')
  })
  if (v === TIMED_OUT) {
    await logTimeout($, q.header, 'this prompt ran with no change; nothing saved')
    return undefined
  }
  if (v !== undefined) await saveChoices($, { ...(await choices($)), [key]: v })
  return v
}

// ---- Deciding --------------------------------------------------------------

async function situation($: EngineInterface): Promise<Situation> {
  // The model in use now comes first: a session started with --model or /model has run no step yet, so seenModel is empty.
  const live = await $.session.model().catch(() => undefined)
  const seen = (await $.state.get({ plugin: 'rightsize', key: 'seenModel' }).catch(() => undefined))?.value
  let tier = tierOf(typeof live === 'string' ? live : undefined) ?? tierOf(typeof seen === 'string' ? seen : undefined)
  if (!tier) tier = tierOf(String((await $.settings.read({ key: 'model' }).catch(() => '')) ?? ''))
  if (!tier) {
    // No source names a known tier: plan as Opus, the model a session starts on, but say so in the log.
    tier = 'opus'
    await log($, `session model unknown (live ${JSON.stringify(live ?? null)}, seen ${JSON.stringify(seen ?? null)}, no usable model setting): planned as Opus`)
  }
  let level = (await sessionEffort($)) ?? (await seenEffort($))
  if (!level) {
    const set = await $.settings.read({ key: 'effortLevel' }).catch(() => undefined)
    level = isLevel(set) ? set : DEFAULT_LEVEL[tier]
  }
  const kept = (await $.state.get({ plugin: 'rightsize', key: 'context' }).catch(() => undefined))?.value
  // Nothing kept yet (the first prompt, or a resumed session): the live window's fill, as the engine reports it.
  const have = typeof kept === 'number' && kept > 0
  const reported = have ? undefined : (await usageNow($))?.context?.tokens
  const context = have ? kept : typeof reported === 'number' && reported > 0 ? reported : DEFAULT_CONTEXT
  return { tier, level, context, prices, cal, rules, ties: await tiesSeen($), misses, missBlock, minTasks, counts, ceiling, without, explore }
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

// `unsure` says why the rater may have seen too little: the request was cut, or a task is in progress and its last reply could not be read.
async function rate($: EngineInterface, text: string, s: Situation): Promise<{ rating?: Rating; overhead: number; ratingMs: number; prompt: string; by: Rater; failed?: string; task: Awaited<ReturnType<typeof currentTask>>; unsure?: Unsure }> {
  const task = await currentTask($)
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
  const prompt = ratingPrompt(text, lastReply, task)
  const unsure: Unsure | undefined = cutRequest(text).cut ? 'cut' : task && !lastReply.trim() ? 'missing' : undefined
  return { ...(await rateWithFallback($, s.tier, s.level, prompt)), prompt, task, ...(unsure ? { unsure } : {}) }
}

// A rating must never hold the prompt long. One budget covers every rating attempt of one prompt: Sonnet gets at most
// SONNET_RATING_MS of it, and a fallback or retry gets what is left, or is skipped when under MIN_ATTEMPT_MS is left.
// No rating means no change (the safe route), so running out of time costs a saving, never a wrong route.
const RATING_BUDGET_MS = 12_000
const SONNET_RATING_MS = 9_000
const MIN_ATTEMPT_MS = 2_000
const BUDGET_USED_UP = 'rating budget used up'

/**
 * Rates a prompt: the chosen rater first. Sonnet (the default) that times out, is refused or answers
 * something unreadable is followed by one Haiku attempt, and no more: two attempts at most, never a
 * retry of each. Haiku chosen in Rater keeps its one retry after a timeout or an unreadable answer.
 * All attempts fit in RATING_BUDGET_MS; an attempt with under MIN_ATTEMPT_MS left is not made, and the prompt is unrated.
 * `by` is the model whose call ended the rating: the one that rated, or the last that failed.
 * `ratingMs` is the wall time of all the attempts: measured, never used to choose a route.
 */
async function rateWithFallback($: EngineInterface, tier: Tier, level: Level, prompt: string): Promise<{ rating?: Rating; overhead: number; ratingMs: number; by: Rater; failed?: string }> {
  const started = await $.clock.now()
  const spent = async () => Math.max(0, (await $.clock.now()) - started)
  const left = async () => Math.floor(RATING_BUDGET_MS - (await spent()))
  if (rater === 'sonnet') {
    const first = await askRater($, 'sonnet', tier, level, prompt, SONNET_RATING_MS).catch((err): Awaited<ReturnType<typeof askRater>> => ({ overhead: 0, failed: `rating call threw: ${err instanceof Error ? err.message : String(err)}`, retry: false }))
    if (first.rating) return { rating: first.rating, overhead: first.overhead, ratingMs: await spent(), by: 'sonnet' }
    const remaining = await left()
    if (remaining < MIN_ATTEMPT_MS) {
      await log($, `rating by sonnet failed (${first.failed ?? 'no rating'}); ${BUDGET_USED_UP}: not rated`)
      return { overhead: first.overhead, ratingMs: await spent(), by: 'sonnet', failed: BUDGET_USED_UP }
    }
    await log($, `rating by sonnet failed (${first.failed ?? 'no rating'}): trying ${FALLBACK_RATER}`)
    const second = await askRater($, FALLBACK_RATER, tier, level, prompt, remaining)
    return { rating: second.rating, overhead: first.overhead + second.overhead, ratingMs: await spent(), by: FALLBACK_RATER, ...(second.rating ? {} : { failed: second.failed ?? first.failed ?? 'no rating' }) }
  }
  // A timeout or an answer that cannot be read may pass on a second try; a rater that is not there will not.
  // The first try leaves room for the retry, so a timeout does not use up the whole budget.
  let first = await askRater($, 'haiku', tier, level, prompt, RATING_BUDGET_MS - MIN_ATTEMPT_MS)
  let overhead = first.overhead
  if (!first.rating && first.retry) {
    const remaining = await left()
    if (remaining < MIN_ATTEMPT_MS) {
      await log($, `rating by haiku failed (${first.failed ?? 'no rating'}); ${BUDGET_USED_UP}: not rated`)
      return { overhead, ratingMs: await spent(), by: 'haiku', failed: BUDGET_USED_UP }
    }
    await log($, `rating retried once: ${first.failed ?? 'no rating'}`)
    first = await askRater($, 'haiku', tier, level, prompt, remaining)
    overhead += first.overhead
  }
  return { rating: first.rating, overhead, ratingMs: await spent(), by: 'haiku', ...(first.rating ? {} : { failed: first.failed ?? 'no rating' }) }
}

// ---- Rater check -------------------------------------------------------------

// Every 50th Haiku rating (Rater check sets it; only when Haiku rated: the Rater row picked it, or Sonnet failed), Sonnet rates the same prompt in the background. Where it says a
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
      if (overhead > 0) await append($, 'runs.jsonl', JSON.stringify({ at: new Date().toISOString(), kind: 'overhead', session, overhead: round(overhead) } satisfies RunLine), RUNS_LOG_MAX)
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

/** Why a rating did not come, and whether a second try may help (a timeout or an unreadable answer; not a rater that is unavailable). */
type RaterFailure = { failed: string; retry: boolean }

async function askRater($: EngineInterface, model: Rater, tier: Tier, level: Level, prompt: string, timeoutMs: number): Promise<{ rating?: Rating; overhead: number } & Partial<RaterFailure>> {
  const r = await $.model.complete({
    model,
    system: ratingSystem(tier, level),
    prompt,
    maxTokens: 300,
    effort: 'low',
    timeoutMs,
  })
  const usage = (r as { usage?: Usage }).usage
  const overhead = usage ? usageCost(prices, model, usage) : 0
  if (!r.isAnswered) {
    await log($, `rating by ${model} failed: ${r.reason}`)
    // 'aborted' is the timeout; an API error with no status is a dropped connection or provider timeout. Any other
    // API error (a refusal, a missing login, a limit) says the rater is not available now.
    const timedOut = r.reason === 'aborted' || (r.reason === 'api-error' && r.status === null)
    return { overhead, failed: r.reason === 'api-error' ? `rating call failed (${r.status === null ? 'no response' : `status ${r.status}`})` : r.reason === 'aborted' ? 'rating call timed out' : 'rating call came back empty', retry: timedOut || r.reason === 'empty-reply' }
  }
  const rating = parseRating(r.text, tier)
  if (!rating) {
    await log($, `rating by ${model} unreadable: ${JSON.stringify(r.text.slice(0, 80))}`)
    return { overhead, failed: 'rating unreadable', retry: true }
  }
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
  const { rating: r, overhead } = await rateWithFallback($, parent, s.level, ratingPrompt(`${e.description}\n\n${e.prompt}`, ''))
  if (run) run.overhead += overhead
  if (!r) return undefined
  const size = sizeSubagent(r, { ...s, tier: parent }, parent, floor)
  if (size?.tie) await countTie($)
  const fit = TIERS.map(t => `${t[0]}:${r.fit[t] ?? (r.fit[t] === null ? 'no' : '?')}`).join(' ')
  await log($, `subagent "${e.description}" on ${parent}: rated ${fit}, ${size ? `sent to ${size.tier}/${size.level}${size.tie ? `, tie ${size.tie.by} over ${size.tie.over}` : ''}` : 'kept'}`)
  return size
    ? { from: parent, tier: size.tier, level: size.level, type: r.type, steps: r.steps, raw: size.raw, parentRaw: size.parentRaw, ...(size.tie ? { tie: size.tie } : {}), ...(e.workflow ? { inWorkflow: true } : {}) }
    : undefined
}

const costLine = (d: number, stay: number, cur: string) =>
  billing === 'api'
    ? `About ${money(d)} that way vs ${money(stay)} staying on ${cur} (estimated).`
    : `That uses ${share(d, stay)} the usage vs staying on ${cur} (estimated).`

type Decision = { level?: Level; session?: Level; auto?: boolean; delegate?: Run['delegate']; model?: Run['switchTo'] }

async function resolveEffort($: EngineInterface, p: Plan, r: Rating, s: Situation): Promise<Decision> {
  if (p.kind !== 'effort') return {}
  // A window nearly used up skips a raise, unless Raising is yours: then it follows your rule.
  if (p.dir === 'raise' && paceNow.mode === 'max' && (await choices($)).raise === undefined) return {}
  const c = p.dir === 'lower' ? await choice($, 'lower', qLower()) : await choice($, 'raise', qRaise())
  if (c === 'auto') return { level: p.level, auto: p.dir === 'lower' }
  if (c !== 'ask') return {}
  const verb = p.dir === 'lower' ? 'Lower' : 'Raise'
  const why = r.reason ? ` (${r.reason})` : ''
  const a = await askWithin($, withWait({
    header: 'Effort',
    question: `This looks like a ${p.level}-effort task${why}. ${verb} from ${s.level} to ${p.level}?`,
    options: [
      [`${verb} for this prompt`, 'prompt'],
      [`${verb} for this session`, 'session'],
      [`Keep ${s.level}`, 'keep'],
    ],
  }, 'it stays as it is'))
  if (a === TIMED_OUT) await logTimeout($, 'Effort', `kept ${s.level}`)
  if (a === 'prompt') return { level: p.level }
  if (a === 'session') return { session: p.level }
  return {}
}

async function resolve($: EngineInterface, p: Plan, r: Rating, s: Situation): Promise<Decision> {
  if (p.kind === 'none') return {}
  if (p.kind === 'effort') return resolveEffort($, p, r, s)
  const cur = TIER_NAME[s.tier]
  const to = TIER_NAME[p.tier]
  if (p.kind === 'switch') {
    const c = await choice($, 'up', qUp(cur, to))
    const send: Decision = { model: { tier: p.tier, level: p.level } }
    const stay = () => resolveEffort($, effortPlan(r, s, floor), r, s)
    if (c === 'auto') return send
    if (c === 'stay') return stay()
    if (c !== 'ask' && c !== 'each') return {}
    const question = `This is a review: reviews run on ${to} at ${REVIEW_LEVEL} effort or more. Run this prompt on ${to} at ${p.level}, then go back to ${cur}? ${costLine(p.cost, p.mainCost, cur)}`
    const a = await askWithin($, withWait({ header: 'Stronger', question, options: [[`Run it on ${to}`, 'send'], [`Stay on ${cur}`, 'stay']] }, 'it stays as it is'))
    if (a === TIMED_OUT) await logTimeout($, 'Stronger', `stayed on ${cur}`)
    return a === 'send' ? send : a === 'stay' ? stay() : {}
  }
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
    const a = await askWithin($, withWait({ header: 'Subagent', question, options: [[`Send it to a ${to} subagent`, 'send'], [`Stay on ${cur}`, 'stay']] }, 'it stays as it is'))
    if (a === TIMED_OUT) await logTimeout($, 'Subagent', `stayed on ${cur}`)
    return a === 'send' ? send : a === 'stay' ? stay() : {}
  }
  const ep = effortPlan(r, s, floor)
  const options: (readonly [string, 'send' | 'effort' | 'keep'])[] = [[`Send it to a ${to} subagent`, 'send']]
  if (ep.kind === 'effort') options.push([`${ep.dir === 'lower' ? 'Lower' : 'Raise'} effort on ${cur} to ${ep.level}`, 'effort'])
  options.push([ep.kind === 'effort' ? 'Keep as is' : `Stay on ${cur}`, 'keep'])
  const a = await askWithin($, withWait({ header: 'Subagent', question, options }, 'it stays as it is'))
  if (a === TIMED_OUT) await logTimeout($, 'Subagent', `stayed on ${cur}`)
  if (a === 'send') return send
  if (a === 'effort' && ep.kind === 'effort') return { level: ep.level }
  return {}
}

/** The hidden note that hands the request to a subagent and has the main chat check it. */
export function delegateNote(d: NonNullable<Run['delegate']>, rounds = PROFILES.Balanced.chances) {
  // The task's chances are its rework rounds: the profile sets how many.
  const n = rounds === 1 ? '1 rework' : `${rounds} reworks`
  const name = TIER_NAME[d.tier]
  const why = d.dir === 'up' ? 'it needs a stronger model' : 'a cheaper model can do it for less'
  return [
    `[rightsize] The person has chosen to hand this request to a ${name} subagent, because ${why}. Do it this way:`,
    `1. Start one subagent with the Agent tool, model "${d.tier}", effort "${d.level}". Give it a complete brief: the goal, the files, facts and decisions it needs from this conversation, and a "Done means" list of 3 to 6 items that can be checked.`,
    '   If the request includes steps only the person can approve (pushing, publishing, releasing, deploying, sending messages, acting in their accounts), the subagent prepares everything (edits, tests, notes) and stops before those steps. It cannot see the person\'s approval, so it would refuse them. You do those steps yourself after step 2.',
    '2. When it reports back, check its result against every Done-means item yourself. Use real proof where you can (run the tests, read the changed files), not its summary.',
    `3. If an item fails, send that subagent a specific fix-up note (continue it with SendMessage where you can; otherwise start it again with the note and its last result). At most ${rounds === 1 ? '1 rework round' : `${rounds} rework rounds`}.`,
    d.dir === 'down'
      ? `4. If an item still fails after ${n}, finish the task yourself.`
      : `4. If an item still fails after ${n}, stop and say where it stands.`,
    `5. Answer the person with the result and one line on how it went: "Done in 1 round", "Passed after N rework(s) (what was missed)", or ${
      d.dir === 'down' ? `"Finished it myself after ${n} (what was missed)"` : `"Still failing <item> after ${n}"`
    }.`,
  ].join('\n')
}

const planChange = (p: Plan): Change => (p.kind === 'none' ? 'none' : p.kind === 'effort' ? p.dir : p.kind === 'switch' ? 'switch-up' : `delegate-${p.dir}`)

/** `base` is the person's own level, before any session switch rightsize made: the level savings are counted against. */
function startRun(r: Rating, s: Situation, d: Decision, p: Plan, base: Level, overhead: number, entered: { text: string; at: number; during?: string }): Run {
  const sw = d.model
  const level = sw?.level ?? d.level ?? d.session ?? s.level
  const change: Change = d.delegate
    ? `delegate-${d.delegate.dir}`
    : sw
      ? 'switch-up'
      : level === base
        ? 'none'
        : levelRank(level) < levelRank(base)
          ? 'lower'
          : 'raise'
  // The turn on another model: its work at that level, plus writing the conversation to that model's cache once.
  const swOn: Situation | undefined = sw ? { ...s, tier: sw.tier } : undefined
  const swCost = sw && swOn ? mainCost(r, swOn, sw.level, 0) + (s.context * s.prices[sw.tier].cacheWrite) / 1e6 : 0
  // A per-prompt switch goes and comes back; a session switch goes once.
  const switches = d.level && d.level !== s.level ? 2 : d.session ? 1 : 0
  const id = `${sessionId}:${Date.now()}-${++runSeq}`
  return {
    id,
    // A run starts a task of its own until the prompt is found to continue one.
    task: id,
    text: entered.text,
    submittedAt: entered.at,
    ...(entered.during !== undefined ? { during: entered.during } : {}),
    rating: r,
    tier: s.tier,
    normal: s.level,
    level: d.level,
    ranAt: level,
    context: s.context,
    workflows: 0,
    auto: d.auto === true,
    delegate: d.delegate,
    ...(sw ? { switchTo: sw } : {}),
    rawMain: rawMainCost(r, swOn ?? s, level),
    rawDelegate: d.delegate ? rawDelegateCost(r, s, d.delegate.tier, d.delegate.level) : undefined,
    stay: mainCost(r, s, base, 0),
    change,
    offered: planChange(p),
    takenMain: sw ? swCost : mainCost(r, s, level, switches),
    takenDelegate: d.delegate ? delegateCost(r, s, d.delegate.tier, d.delegate.level) : undefined,
    overhead,
    agentCalls: 0,
    approvalSteps: 0,
    subAgents: [],
    resized: [],
    mainCost: 0,
    subCost: 0,
    missCost: 0,
    sideCost: 0,
    errors: 0,
    blocked: 0,
    steppedUp: false,
    delegated: false,
    pace: paceNow,
    signals: noSignals(),
    escalations: [],
    requests: 0,
    ...('rule' in p && p.rule ? { rule: p.rule } : {}),
  }
}

// ---- Reporting -------------------------------------------------------------

async function showStatus($: EngineInterface) {
  const run = active ?? pending[0] ?? null
  if (run?.delegate) return $.ui.status(`Handing this to a ${TIER_NAME[run.delegate.tier]} subagent`)
  if (run?.switchTo) return $.ui.status(`Running this review on ${TIER_NAME[run.switchTo.tier]} at ${run.switchTo.level} effort`)
  if (run?.raisedTo) return $.ui.status(`Effort: ${run.raisedTo} (raised mid-turn)`)
  if (run?.steppedUp) return $.ui.status(`Effort: back to ${run.normal} (the task got harder)`)
  if (run?.level) return $.ui.status(run.auto ? `Effort: ${run.level} (auto) · /rightsize undo` : `Effort: ${run.level} (this prompt)`)
  if (!run && lastAuto?.kind === 'lower') return $.ui.status(`Last prompt ran at ${lastAuto.level} (auto) · /rightsize undo`)
  const session = await sessionEffort($)
  $.ui.status(session ? `Effort: ${session} (this session)` : undefined)
}

// ---- Band ------------------------------------------------------------------

const BAND = { plugin: 'rightsize', key: 'band' } as const
const BAND_MODE = { plugin: 'rightsize', key: 'bandMode' } as const

const isBandMode = (v: unknown): v is BandMode => v === 'when it acts' || v === 'always' || v === 'off'

/** A line every band of this turn carries, so a later band (a hand-off's result) does not hide it: a miss just forgiven. */
let bandNote: string | null = null
const setBand = ($: EngineInterface, band: Band | null) => {
  if (!band) return $.state.set(BAND, null).catch(() => undefined)
  // A band built from an earlier band's text already carries a total: drop it, and add the current one last.
  let text = band.text.replace(SESSION_TOTAL, '')
  if (bandNote && !text.includes(bandNote)) text = `${text} ${bandNote}`
  const total = sessionTotal(runLog, sessionId, billing === 'subscription')
  return $.state.set(BAND, { ...band, text: total ? `${text} · ${total}` : text }).catch(() => undefined)
}

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

/** The rater's reason as a sentence for the band: "Why: Simple lookup in one file."; nothing when it gave none. */
const whyText = (reason: string) => {
  const r = reason.trim().replace(/[.\s]+$/, '')
  return r ? `Why: ${r[0]!.toUpperCase()}${r.slice(1)}.` : ''
}

/** What the band shows for a rated prompt: what was done, or what was suggested and not done. */
export function bandFor(run: Pick<Run, 'id' | 'tier' | 'normal' | 'auto' | 'delegate' | 'stay' | 'takenDelegate'> & Partial<Pick<Run, 'switchTo' | 'takenMain'>> & { rating?: Pick<Rating, 'reason' | 'type'> }, d: Decision, p: Plan): Band {
  const cur = TIER_NAME[run.tier]
  // Why this route, and for a move to a cheaper model (a lowering or a hand-off down: the routes the miss rate scores) how sure rightsize is.
  const why = run.rating ? whyText(run.rating.reason) : ''
  const sure = (tier: Tier) => (run.rating ? howSure(run.rating.type, tier, ownCounts, misses) : '')
  const more = (...parts: string[]) => parts.filter(Boolean).map(x => ` ${x}`).join('')
  if (run.switchTo) {
    return { text: `Running this review on ${TIER_NAME[run.switchTo.tier]} at ${run.switchTo.level} effort, then back to ${cur}. ${costLine(run.takenMain ?? 0, run.stay, cur)}${more(why)}`, acted: true, rule: 'up', canStay: true }
  }
  if (run.delegate) {
    const to = `${TIER_NAME[run.delegate.tier]} subagent at ${run.delegate.level} effort`
    const instead = p.kind === 'delegate' && p.instead && levelRank(p.instead) > levelRank(run.normal) ? ` instead of raising ${cur} to ${p.instead}` : ''
    return { text: `Sending this to a ${to}${instead}. ${costLine(run.takenDelegate ?? 0, run.stay, cur)}${more(why, run.delegate.dir === 'down' ? sure(run.delegate.tier) : '')}`, acted: true, rule: run.delegate.dir, canStay: true }
  }
  const level = d.level ?? d.session
  if (level) {
    const lower = levelRank(level) < levelRank(run.normal)
    const scope = d.level ? `this prompt${run.auto ? ' (automatically)' : ''}` : 'this session'
    return {
      text: `Effort ${lower ? 'lowered' : 'raised'}: ${run.normal} → ${level} for ${scope}.${more(why, lower ? sure(run.tier) : '')}`,
      acted: true,
      rule: lower ? 'lower' : 'raise',
      // A lowering can be marked right or wrong: it was a bet on the rating.
      ...(lower ? { rate: run.id } : {}),
      ...(run.auto && d.level ? { canUndo: true } : {}),
      ...(d.session ? { canClear: true } : {}),
    }
  }
  if (p.kind === 'none') return { text: `No change: ${run.normal} on ${cur} fits this prompt.`, acted: false }
  const what = p.kind === 'effort' ? `${p.level} effort` : p.kind === 'switch' ? `${TIER_NAME[p.tier]} at ${p.level}` : `a ${TIER_NAME[p.tier]} subagent at ${p.level}`
  const rule = p.kind === 'effort' ? (p.dir === 'lower' ? 'lower' : 'raise') : p.kind === 'switch' ? 'up' : p.dir
  const down = p.kind === 'effort' ? (p.dir === 'lower' ? run.tier : undefined) : p.kind === 'delegate' && p.dir === 'down' ? p.tier : undefined
  return { text: `No change: ${what} would fit, kept ${run.normal} on ${cur}.${more(why, down ? sure(down) : '')}`, acted: false, rule }
}

async function setRule($: EngineInterface, key: keyof Choices, value: string) {
  await saveChoices($, { ...(await choices($)), [key]: value } as Choices, true)
  const label = RULES[key].find(r => r[0] === value)?.[1] ?? value
  $.ui.toast(`Rightsize: ${RULE_NAME[key]} is now "${label}".`)
}

/**
 * Puts the last prompt back in the box and lets it run once as it would have without rightsize: not rated, not
 * changed. Undo does it for a lowering, "Run on <model>" for a hand-off or a switch-run.
 */
async function runAsIs($: EngineInterface, kind: 'lower' | 'route', none: string) {
  if (lastAuto?.kind !== kind) return none
  const { text, back } = lastAuto
  lastAuto = null
  skipOnce = text.trim()
  const filled = await $.prompt.fill({ text, mode: 'replace' }).catch(() => null)
  await setBand($, null)
  await showStatus($)
  return filled?.isFilled
    ? `The prompt is back in the box. Press Enter to run it ${back}.`
    : `Could not fill the prompt box. Send the prompt again and it runs ${back}.`
}

const undo = ($: EngineInterface) => runAsIs($, 'lower', 'Nothing to undo: the last prompt was not lowered automatically.')
const runOnCurrent = ($: EngineInterface) => runAsIs($, 'route', 'Nothing to run again: the last prompt was not handed off or run on another model.')

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
      // A switched turn teaches the switched model's keys, with the one cache write the switch costs taken out.
      const written = run.switchTo ? (run.context * prices[run.switchTo.tier].cacheWrite) / 1e6 : 0
      const sample = ratioSample(Math.max(0, actual - run.missCost - written), run.rawMain)
      for (const key of mainKeys(r.type, run.switchTo?.tier ?? run.tier, run.ranAt)) teach(key, sample)
    }
    await saveCal($)
  }
  // Every rated turn is logged, changed or not and stopped or not, for /rightsize report.
  if (actual > 0 || run.overhead > 0) {
    const fixed = await fixedContext($)
    const now = await $.clock.now()
    const helpers = [...watches].filter(([, w]) => w.run === run.id).map(([agent, w]) => ({ agent, kind: w.kind, ...helperLine(w, now) }))
    const retries = await retriesUsed($, run.task)
    const line: RunLine & Record<string, unknown> = {
      at: new Date().toISOString(),
      kind: 'run',
      id: run.id,
      session: sessionId,
      task: run.task,
      ...(run.turnId ? { turnId: run.turnId } : {}),
      // Typed while another turn was running, and waited for its own.
      ...(run.during !== undefined ? { queued: true } : {}),
      type: r.type,
      continues: r.continues === true,
      ...(run.ratedType ? { ratedType: run.ratedType } : {}),
      ...(run.unsure ? { unsure: run.unsure } : {}),
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
      ...(run.rule ? { rule: run.rule } : {}),
      ...(run.switchTo ? { switched: run.switchTo.tier, switchedLevel: run.switchTo.level } : {}),
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
      ...(run.rater ? { rater: run.rater } : {}),
      overhead: round(run.overhead),
      ...(run.ratingMs !== undefined ? { ratingMs: Math.round(run.ratingMs) } : {}),
      // When the prompt was submitted (before its rating); `at` is when its turn ended.
      submittedAt: new Date(run.submittedAt).toISOString(),
      missCost: round(run.missCost),
      agentCalls: run.agentCalls,
      ...(run.approvalSteps ? { approvalSteps: run.approvalSteps } : {}),
      ...(run.blocked ? { blocked: run.blocked } : {}),
      ...(helpers.length ? { helpers } : {}),
      ...(retries > 0 ? { retries } : {}),
      requests: run.requests,
      // Each request reads the fixed context from the cache, at least.
      ...(fixed ? { fixed: { ...fixed, cost: round((run.requests * fixed.tokens * prices[run.switchTo?.tier ?? run.tier].cacheRead) / 1e6) } } : {}),
      ...(run.workflows ? { workflows: run.workflows } : {}),
      ...(workflowSeen ? { afterWorkflow: true } : {}),
      durationMs,
      ...(run.before ? { before: run.before } : {}),
      ...(windows(u?.rateLimits) ? { after: windows(u?.rateLimits) } : {}),
    }
    await appendRun($, line)
  }
  if (run.delegate && (!delegated || !aborted)) {
    const cost = `${money(actual)}${billing === 'subscription' ? ' API-equivalent' : ''}`
    const text = !delegated && run.approvalSteps
      ? `rightsize: Claude kept this in the main chat for steps only you can approve (push, publish, deploy, send); it ran on ${TIER_NAME[run.tier]} (${cost}).`
      : !delegated
      ? `rightsize: Claude did not hand this to a ${TIER_NAME[run.delegate.tier]} subagent; it ran on ${TIER_NAME[run.tier]} (${cost}).`
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
    const a = await askWithin($, withWait({
      header: 'Stuck',
      question: `Claude looks stuck: ${sign.why}. Raise effort from ${cur} to ${to} for the rest of this turn?`,
      options: [
        [`Raise to ${to} for this turn`, 'yes'],
        [`Keep ${cur}`, 'no'],
      ],
    }, `it keeps ${cur}`))
    if (a === TIMED_OUT) await logTimeout($, 'Stuck', `kept ${cur}`)
    if (a !== 'yes') return
  }
  run.raisedTo = to
  run.escalations.push({ step, from: cur, to, why: sign.why })
  await setBand($, { text: `Effort raised mid-turn: ${cur} → ${to} (${sign.why}).`, acted: true, rule: 'raise' })
  await showStatus($)
  await log($, `raised mid-turn ${cur} → ${to} at step ${step}: ${sign.why}`)
}

// A helper is struggling: only more effort for struggling helps, and only from the task's retry
// budget. Raising decides as it does for the main chat: automatic raises, Never leaves it alone, and
// otherwise the person is asked; no answer in QUESTION_WAIT_MS sends the helper back, so a helper running
// while nobody watches does not wait for ever. When no chance or no level is left, it goes back to the
// main chat. Blocked errors are not struggling; a sign with only blocked errors behind it can't be told apart
// from them, so it neither raises nor counts as a miss. Each sign is weighed once, as in escalate().
async function escalateHelper($: EngineInterface, id: string, w: Watch, sign: Struggle) {
  w.signals = { ...w.signals, fired: [...w.signals.fired, sign.kind] }
  if (w.blocked > 0 && !Object.values(w.signals.calls).some(c => c.errors > 0)) {
    await log($, `helper ${id} looks stuck (${sign.why}) but only the environment failed: can't tell, no raise`)
    return
  }
  const rule = (await choices($)).raise
  if (rule === 'never') return
  if (paceNow.mode === 'max' && rule === undefined) {
    await log($, `raise of helper ${id} skipped (${sign.why}): the usage window is nearly used up`)
    return
  }
  const cur = w.raisedTo ?? w.level
  const to = oneUp(cur, ceiling)
  let why = ''
  if (!to) why = `${cur} is as high as it goes`
  // No chance left: nothing to ask about.
  else if ((await retriesUsed($, w.task)) >= chances) why = 'the task has no retry left'
  else if (rule !== 'auto') {
    const a = await askHelper($, sign, cur, to)
    if (a === 'no') {
      await log($, `helper ${id} struggling (${sign.why}): kept at ${cur}, as you chose`)
      return
    }
    if (a === 'timeout') why = `no answer in ${WAIT_MINUTES} minutes`
  }
  if (to && !why && !(await useChance($, w.task))) why = 'the task has no retry left'
  if (to && !why) {
    w.raisedTo = to
    w.raises.push({ step: w.steps, from: cur, to, why: sign.why })
    w.stall = 'struggling'
    await setBand($, { text: `Helper effort raised: ${cur} → ${to} (${sign.why}).`, acted: true, rule: 'raise' })
    await log($, `raised helper ${id} ${cur} → ${to} at step ${w.steps}: ${sign.why}`)
    return
  }
  w.returned = true
  w.stall = 'struggling'
  await setBand($, { text: `Helper stopped and sent back to the main chat: ${sign.why}, and ${why}.`, acted: true })
  await log($, `returned helper ${id} to the main chat at step ${w.steps}: ${sign.why}, and ${why}`)
}

// The Stuck question for a helper. A dismissed question is a no, as for the main chat. An answer
// that comes after the wait is too late: the helper is already back with the main chat.
async function askHelper($: EngineInterface, sign: Struggle, cur: Level, to: Level): Promise<'yes' | 'no' | 'timeout'> {
  const a = await askWithin(
    $,
    {
      header: 'Stuck',
      question: `A helper looks stuck: ${sign.why}. Raise its effort from ${cur} to ${to}? It uses one of this task's ${chances} retries. With no answer in ${WAIT_MINUTES} minutes it goes back to the main chat.`,
      options: [
        [`Raise to ${to}`, 'yes'],
        [`Keep ${cur}`, 'no'],
      ],
    },
    late => {
      if (late === 'yes') $.ui.toast('rightsize: too late, the helper already went back to the main chat.')
    },
  )
  return a === TIMED_OUT ? 'timeout' : a === 'yes' ? 'yes' : 'no'
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
  const lines = await readRuns($)
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
  // Not timed: sending would cost more than a warm cache, so the prompt stays held until the person answers.
  // After the wait the band says so; the question stays open.
  const cost = usageCostText(c.resend, perDollar)
  let answered = false
  let shown = false
  void $.clock.sleep(QUESTION_WAIT_MS).then(async () => {
    if (answered) return
    shown = true
    const text = `Held: sending now costs about ${cost} more than a warm cache. Answer to go on.`
    await setBand($, { acted: true, text })
    await log($, `no answer in ${WAIT_MINUTES} minutes to Idle: the prompt stays held; band: ${text}`)
  }, () => undefined)
  const a = await pick($, {
    header: 'Idle',
    question: `This session sat idle for ${idleFor(idle)}, so its cache has likely expired. Sending writes the whole conversation (~${Math.round(context / 1000)}K tokens) to the cache again: about ${usageCostText(c.resend, perDollar)} more on ${TIER_NAME[s.tier]} than a warm cache. /clear costs nothing; /compact about ${usageCostText(c.compact, perDollar)}.`,
    options: [
      ['Send it', false],
      ['Hold it: I will /clear or /compact first', true],
    ],
  })
  answered = true
  if (shown) await setBand($, null)
  await log($, `idle ${idleFor(idle)} with ${context} tokens: ${a ? 'held' : 'sent'}`)
  return a === true
}

const APPROVAL_DENY =
  'rightsize: a hand-off subagent cannot push, publish, release, deploy or send, because a message from the main chat is not the person\'s approval. Stop before this step and report what is ready; the main chat does it.'

const HELPER_RETURN =
  'rightsize: stop now. You are stuck, and this task\'s retry budget is used up, so more effort or more tries will not help. Do not make more tool calls: report what you tried, what failed, and where you are stuck. The main chat takes it from here.'
const REWORK_DENY =
  'rightsize: this task\'s retry budget is used up, so the helper gets no more rework rounds. Finish the task yourself in the main chat, from what the helper did.'

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

const RETRIES = { plugin: 'rightsize', key: 'retries' } as const

/** How many of the task's chances are used; a task that has none recorded has used none. */
async function retriesUsed($: EngineInterface, task: string) {
  const v = (await $.state.get(RETRIES).catch(() => undefined))?.value
  return v && v.task === task ? v.used : 0
}

/** Uses one of the task's chances; false when none is left. */
function useChance($: EngineInterface, task: string): Promise<boolean> {
  const spend = spending.then(async () => {
    const used = await retriesUsed($, task)
    if (used >= chances) return false
    await $.state.set(RETRIES, { task, used: used + 1 }).catch(() => undefined)
    return true
  })
  spending = spend.catch(() => undefined)
  return spend
}

// The watch on a helper: the hand-off's subagent, or one rightsize moved to a cheaper
// model. Any other agent is left alone. It starts at the helper's spawn or first step.
async function helperWatch($: EngineInterface, id: string): Promise<Watch | undefined> {
  const had = watches.get(id)
  if (had) return had
  await claim($, id)
  const run = active
  const sized = resizedRuns.get(id)
  const startedAt = await $.clock.now()
  let w: Watch | undefined
  if (run?.delegate && run.subAgents.includes(id)) {
    w = { kind: 'handoff', run: run.id, task: run.task, level: run.delegate.level, rated: run.rating.steps, signals: noSignals(), steps: 0, startedAt, blocked: 0, raises: [] }
  } else if (sized) {
    const task = sized.task ?? (await currentTask($))?.id ?? sessionId
    w = { kind: 'moved', ...(sized.run ? { run: sized.run } : {}), task, level: sized.level, rated: sized.steps ?? 5, signals: noSignals(), steps: 0, startedAt, blocked: 0, raises: [] }
  }
  const raced = watches.get(id)
  if (raced) return raced
  if (w) watches.set(id, w)
  return w
}

/** What the log keeps of a watched helper. `ms` runs to its answer, or to now while it has not answered. */
const helperLine = (w: Watch, now: number): HelperLine => ({
  steps: w.steps,
  ms: w.ms ?? Math.max(0, now - w.startedAt),
  errors: Object.values(w.signals.calls).reduce((n, c) => n + c.errors, 0),
  blocked: w.blocked,
  ...(w.stall ? { stall: w.stall } : {}),
  ...(w.raises.length ? { raises: w.raises } : {}),
  ...(w.returned ? { returned: true as const } : {}),
})

// A helper's tool call, after it ran. An error from the environment is a Blocked stall: more effort
// would not fix it, so it is counted apart and is not a sign. A refused call says nothing about the work.
async function noteHelperCall($: EngineInterface, id: string, w: Watch, e: Record<string, unknown>, result: unknown) {
  const r = result as { deny?: string; isError?: boolean }
  if (r.deny) return
  const isError = r.isError === true
  if (isError && blockedError(errorText(result))) {
    w.blocked += 1
    if (w.stall !== 'struggling') w.stall = 'blocked'
    if (w.blocked === 1) await log($, `helper ${id} blocked by the environment: more effort will not help`)
    return
  }
  const tool = String(e.tool)
  w.signals = noteCall(w.signals, callKey(tool, e), isError, isTestCommand(tool, e))
}

// A moved subagent's answer: what its own requests cost teaches the estimate for its
// model and level, and the log keeps it for the report. A background one often
// answers after the turn that started it ended, so this is its own line. A
// resumed subagent starts counting again.
async function finishSubagent($: EngineInterface, m: Measured, aborted: boolean, w?: Watch) {
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
    ...(m.task ? { task: m.task } : {}),
    ...(m.run ? { run: m.run } : {}),
    type: m.type,
    from: m.from,
    tier: m.tier,
    level: m.level,
    estimate: round(m.raw),
    parentEstimate: round(m.parentRaw),
    actual: round(spend),
    aborted,
    ...(w ? helperLine(w, await $.clock.now()) : {}),
  }
  await append($, 'runs.jsonl', JSON.stringify(line), RUNS_LOG_MAX)
}

async function summary($: EngineInterface) {
  const c = await choices($)
  const session = await sessionEffort($)
  // One run teaches its type:route key and, for a hand-off, finer keys too: count the first only.
  const runs = Object.entries(cal).filter(([k]) => k !== SWITCH_KEY && k.split(':').length === 2).reduce((n, [, e]) => n + e.n, 0)
  const sw = cal[SWITCH_KEY]
  const sees = detectedBilling === 'subscription' ? 'a subscription' : 'API billing'
  const install = sharing ? await $.store.get('shareInstall').catch(() => undefined) : undefined
  // Only the settings you set in /config or answered: the rest are defaults, and /config shows them.
  const changed: string[] = []
  const cur = inUse(profile, cfg, yours)
  for (const key of KEYS) {
    const rule = RULE_IDS.find(r => RULE_KEYS[r] === key)
    if (rule) {
      if (c[rule] !== undefined) changed.push(`  ${plainTitle(SETTINGS[key].title)}: ${ruleLabel(rule, c[rule])}`)
    } else if (key === 'billing' ? billingYours() : yours.has(key)) changed.push(`  ${plainTitle(SETTINGS[key].title)}: ${cfg[key]}`)
  }
  const n = changed.length
  return [
    // Claude Code shows the output under "rightsize:", so the line leaves the name out.
    `Profile: ${profile}`,
    off ? 'Off. Turn it on with /mods.' : 'On.',
    '',
    n
      ? `You changed ${n} setting${n === 1 ? '' : 's'}. The other ${KEYS.length - n} are defaults (list them with claude plugin configure rightsize@archid21).`
      : `All ${KEYS.length} settings are at their defaults (list them with claude plugin configure rightsize@archid21).`,
    ...changed,
    '',
    'Now',
    `  In use: hand-off threshold ${Math.round(cur.handOff * 100)}%, pause at ${cur.maxMiss === null ? 'no' : `${Math.round(cur.maxMiss * 100)}%`} misses${cur.minTasks ? ` and ${cur.minTasks} logged tasks` : ''}, rater check ${cur.raterEvery === null ? 'off' : `every ${cur.raterEvery}`}, ${cur.chances} ${cur.chances === 1 ? 'chance' : 'chances'} per task`,
    `  Session switch: ${session ?? 'none'}`,
    ...(billingYours() ? [] : [`  Reports: ${billing} (${billingBy ?? 'default'})`]),
    ...(billingYours() && detectedBilling && detectedBilling !== billing ? [`  Rate limits look like ${sees}; Reports is set to ${billing} by you.`] : []),
    ...(pacing && paceNow.mode !== 'normal' ? [`  ${paceNote(paceNow)}`] : []),
    `  Measured runs: ${runs}`,
    ...(sw ? [`  Effort switches that missed the cache: ${Math.round(sw.ratio * 100)}% of ${sw.n} (each one in ~/.claude/mods-logs/rightsize/<session>/switches.jsonl)`] : []),
    ...(typeof install === 'string' ? [`  Sharing install ID: ${install} (quote it to rightsize@aivalue.blog to ask about or delete your shared data)`] : []),
    '',
    'Commands: /rightsize help',
  ].join('\n')
}

// ---- Help --------------------------------------------------------------------------

const COMMANDS: readonly (readonly [string, string])[] = [
  ['', 'show your changed settings and current state'],
  ['settings', 'answer the questions again'],
  ['report', 'what it saved and what went wrong'],
  ['undo', 're-run the last auto-lowered prompt'],
  ['clear', 'drop the session switch'],
  ['prices', 'check prices now'],
  ['share', 'message you can paste to tell others'],
  ['reset', 'settings back to defaults, or restart cost measurement (reset <setting> resets one)'],
  ['help', 'this list'],
]

function helpText() {
  const width = Math.max(...COMMANDS.map(([c]) => `/${CMD} ${c}`.trim().length))
  return ['rightsize commands', '', ...COMMANDS.map(([c, what]) => `  ${`/${CMD} ${c}`.trim().padEnd(width)}  ${what}`), '', 'All settings are in /config.'].join('\n')
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
  return `Reset ${plainTitle(SETTINGS[what].title)}? It goes back to its default, ${SETTINGS[what].default}.${rule} ${UNDONE}`
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
  const blocked: SettingKey[] = []
  let listed = resetFields
  for (const key of keys) {
    const dflt = SETTINGS[key].default
    const changes = cfg[key] !== dflt
    if (changes) {
      const r = await writeSetting($, key, dflt).catch((err: unknown) => ({ deny: err instanceof Error ? err.message : String(err) }))
      if (r.deny !== undefined) {
        await log($, `reset ${key}: Claude Code refused to write it: ${r.deny}`)
        blocked.push(key)
        // Listed now, so the row counts as a default once it is set to the default some other way.
        listed = mark(listed, key, true)
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
  if (!blocked.length) return all ? 'Every setting is back to its default, and the saved answers are forgotten.' : `${plainTitle(SETTINGS[keys[0] ?? 'floor'].title)} is back to its default, ${SETTINGS[keys[0] ?? 'floor'].default}.`
  // Claude Code would not write these here (the desktop app has no /config menu): say how to reset them from a terminal.
  const names = blocked.map(k => plainTitle(SETTINGS[k].title)).join(', ')
  const json = JSON.stringify(Object.fromEntries(blocked.map(k => [k, SETTINGS[k].default])))
  const fix = `To reset ${blocked.length === 1 ? 'it' : 'them'}, run this in a terminal, then restart Claude Code: echo '${json}' | claude plugin configure rightsize@archid21 --values-stdin`
  const done = all && blocked.length < keys.length ? 'The other settings are back to their defaults, and the saved answers are forgotten. ' : ''
  return `${done}${names} could not be changed from here. ${fix}`
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

async function setShare($: EngineInterface, enabled: boolean) {
  sharing = enabled
  if (!enabled) {
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
  const a = adviseStart(await readRuns($), await startContext($), now)
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

// Sets what the profile governs: its own values, each replaced by its row where the row is yours. It runs
// again whenever the profile or `yours` changes, so a profile switched in /config applies at once.
function applyProfile() {
  profile = profileOf(cfg.profile)
  const u = inUse(profile, cfg, yours)
  rules = { handOff: u.handOff, lower: parseShare(cfg.lowering, DEFAULT_RULES.lower) }
  missBlock = u.maxMiss
  minTasks = u.minTasks
  spotEvery = u.raterEvery
  chances = u.chances
  answers = u.answers
}

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
    case 'profile':
    case 'handOff':
    case 'lowering':
    case 'missPause':
    case 'raterCheck':
      applyProfile()
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
    case 'pacing':
      pacing = v !== 'off'
      return
    case 'escalation':
      escalation = v !== 'off'
      return
    case 'stuck':
      if (isSensitivity(v)) limits = LIMITS[v]
      return
    case 'rater':
      rater = v === 'haiku' ? 'haiku' : 'sonnet'
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

// ---- Prompt queue ------------------------------------------------------------

// A rated prompt waits in `pending` until its turn starts. Making it the active run reads the ledger and
// the rate-limit windows then, after the rating call, so the ledger's difference is the turn's own cost.
async function bind($: EngineInterface, run: Run, turnId: string) {
  const u = await usageNow($)
  run.turnId = turnId
  run.ledgerStart = u?.cost?.usd
  run.before = windows(u?.rateLimits)
  active = run
}

// A prompt that gets no turn of its own is logged with what its rating cost, so the report counts that
// as overhead, and it is never given another prompt's turn.
async function unbind($: EngineInterface, run: Run, reason: string) {
  await log($, `prompt got no turn of its own (${reason}): its rating cost counts as overhead`)
  const line: RunLine = { at: new Date().toISOString(), kind: 'unbound', id: run.id, session: sessionId, task: run.task, reason, overhead: round(run.overhead) }
  await append($, 'runs.jsonl', JSON.stringify(line), RUNS_LOG_MAX)
}

// The session is idle: a prompt still waiting for its turn is not going to get one. A prompt the engine is still
// answering is not waiting, it is entering.
async function releaseStale($: EngineInterface) {
  const stale = pending.filter(r => !r.entering)
  pending = pending.filter(r => r.entering)
  for (const r of stale) await unbind($, r, r.during !== undefined ? 'delivered into the running turn' : 'cancelled before its turn started')
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
    pending = []
    active = null
    completed.clear()
    await $.state.set({ plugin: 'rightsize', key: 'task' }, null).catch(() => undefined)
    await $.state.set(RETRIES, null).catch(() => undefined)
    watches.clear()
    lastApplied = undefined
    lastSwitched = false
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
    // What the profile governs depends on which rows are yours, now known.
    applyProfile()
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
    // Clearing out old sessions never holds up the start.
    void pruneSessions($)
    runLog = await readRuns($)
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
      const runs = await readRuns($)
      const switches = await readSwitchLines($)
      const now = await $.clock.now()
      const start = startBlock(adviseStart(runs, await startContext($), now), billing === 'subscription', money)
      // The desktop app (any surface but the terminal) renders the report as Markdown.
      const markdown = (await $.session.surfaces()).some(x => x !== 'terminal')
      return { text: buildReport(runs, switches, { now, session: sessionId, subscription: billing === 'subscription', start, pause: missBlock, markdown, ...(measureFrom ? { measureFrom: new Date(measureFrom).toISOString() } : {}) }) }
    }
    if (arg === 'share') {
      const runs = await readRuns($)
      return { text: shareMessage(runs, { now: await $.clock.now(), subscription: billing === 'subscription', ...(measureFrom ? { measureFrom: new Date(measureFrom).toISOString() } : {}) }) }
    }
    if (arg === 'clear') return { text: await clearSession($) }
    if (arg === 'help') return { text: helpText() }
    if (arg !== '' && arg !== 'settings') return { text: `Unknown command "${arg}".\n\n${helpText()}` }
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
      next.lower = await pick($, qLower())
      next.raise = await pick($, qRaise())
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
    bandNote = null
    await setBand($, null)
    const text = e.text.trim()
    if (skipOnce !== null && text === skipOnce) {
      skipOnce = null
      return next(e)
    }
    if (text.startsWith('/')) return next(e)
    // When the prompt came in, before any rating or question: the start of the task's time to done.
    const submittedAt = await $.clock.now()
    if (await holdIdle($)) {
      await $.prompt.fill({ text: e.text, mode: 'replace' }).catch(() => null)
      return { drop: 'rightsize held this prompt and put it back in the box. Run /clear or /compact, then send it.' }
    }
    // The session is idle, so no running turn can still take a prompt that has not started: it never will.
    if (e.turnId === undefined) await releaseStale($)

    await knowBilling($, true)
    $.ui.status('Rating the prompt...')
    let out = e
    let run: Run | null = null
    // The task as it stood before this prompt changed it, and what this prompt wrote: a dropped prompt puts it back.
    let prevTask: Awaited<ReturnType<typeof currentTask>> | undefined
    let wroteTask: { id: string; prompts: number } | undefined
    try {
      const base = await situation($)
      paceNow = pacing ? paceOf((await usageNow($))?.rateLimits ?? [], await $.clock.now()) : NORMAL_PACE
      // Pacing moves only a threshold left at its default: one you set stays as you set it.
      const set = { handOff: yours.has('handOff'), lower: yours.has('lowering') }
      const movedRules = pacedRules(base.rules ?? DEFAULT_RULES, paceNow, set)
      const s: Situation = { ...base, rules: movedRules }
      const { rating: rated, overhead, ratingMs, prompt, failed, by, task: kept, unsure } = await rate($, text, s)
      // A rating that continues the task is planned as the task's type; any other starts a task of its own type.
      const follows = rated !== undefined && rated.continues === true && kept !== null
      const ratedType = follows && kept.type !== rated.type ? rated.type : undefined
      const r = rated && follows && kept.type !== rated.type ? { ...rated, type: kept.type } : rated
      if (r) {
        // While Claude fans work out to workflows, a single hand-off would only cut across it. After one,
        // Workflows says whether hand-offs go on (follow my rules, right-size every agent) or wait (the default).
        const planned = plan(r, s, floor)
        const fanned = workflowSeen && planned.kind === 'delegate' && (workflows === 'ask' || workflows === 'pause rightsize') ? effortPlan(r, s, floor) : planned
        // A request that was cut, or a task whose last reply the rater could not read, may be harder than it looks:
        // that is no ground to lower effort or hand work to a cheaper model. Raising and stronger models are left alone.
        const noDowngrade = unsure !== undefined && ((fanned.kind === 'effort' && fanned.dir === 'lower') || (fanned.kind === 'delegate' && fanned.dir === 'down'))
        const unfanned: Plan = noDowngrade ? { kind: 'none', why: 'the context was cut or missing, so no downgrade' } : fanned
        // A window nearly used up: nothing that costs more than staying, unless the matching rule
        // (Raising for more effort, Stronger model for a stronger one) is yours: then it follows your rule.
        const costlier = (unfanned.kind === 'effort' && unfanned.dir === 'raise') || unfanned.kind === 'switch' || (unfanned.kind === 'delegate' && unfanned.dir === 'up')
        const mine = await choices($)
        const followsYou = unfanned.kind === 'effort' ? mine.raise !== undefined : mine.up !== undefined
        const skipped = paceNow.mode === 'max' && costlier && !followsYou
        const p: Plan = skipped ? { kind: 'none', why: 'the usage window is nearly used up' } : unfanned
        const d = await resolve($, p, r, s)
        if (d.session) await $.state.set({ plugin: 'rightsize', key: 'sessionEffort' }, d.session)
        if (d.delegate) out = { ...e, context: [...(e.context ?? []), delegateNote(d.delegate, chances)] }
        run = startRun(r, s, d, p, (await seenEffort($)) ?? s.level, overhead, { text, at: submittedAt, ...(e.turnId !== undefined ? { during: e.turnId } : {}) })
        prevTask = kept
        if (follows) {
          run.task = kept.id
          wroteTask = { id: kept.id, prompts: kept.prompts + 1 }
          await $.state.set({ plugin: 'rightsize', key: 'task' }, { ...kept, prompts: kept.prompts + 1 }).catch(() => undefined)
        } else {
          wroteTask = { id: run.task, prompts: 1 }
          await $.state.set({ plugin: 'rightsize', key: 'task' }, { id: run.task, type: r.type, brief: text.slice(0, BRIEF_MAX), prompts: 1 }).catch(() => undefined)
        }
        if (ratedType) run.ratedType = ratedType
        if (unsure) run.unsure = unsure
        run.rater = by
        run.ratingMs = ratingMs
        // A close call the guide broke: kept on the run for the log, and counted so every fifth explores.
        if (planned.kind === 'delegate' && planned.tie) {
          run.tie = planned.tie
          await countTie($)
        }
        const was = base.rules ?? DEFAULT_RULES
        const note = paceNote(paceNow, skipped || movedRules.handOff !== was.handOff || movedRules.lower !== was.lower)
        const band = noDowngrade
          ? { text: 'No change: the context was cut or missing, so rightsize did not lower this or hand it to a cheaper model.', acted: false }
          : p !== unfanned
          ? { text: `Kept ${s.level} on ${TIER_NAME[s.tier]} instead of ${unfanned.kind === 'delegate' ? `a ${TIER_NAME[unfanned.tier]} subagent` : unfanned.kind === 'switch' ? `running on ${TIER_NAME[unfanned.tier]}` : `raising to ${unfanned.kind === 'effort' ? unfanned.level : ''}`}.`, acted: true }
          : bandFor(run, d, p)
        await setBand($, note ? { ...band, text: `${band.text} ${note}` } : band)
        const did = d.delegate ? `delegate ${d.delegate.tier}` : d.model ? `switch to ${d.model.tier} at ${d.model.level} for the turn` : d.level ? `${d.auto ? 'auto ' : ''}${d.level} for the prompt` : d.session ? `${d.session} for the session` : 'no change'
        const fit = TIERS.map(t => `${t[0]}:${r.fit[t] ?? (r.fit[t] === null ? 'no' : '?')}`).join(' ')
        if (noDowngrade) await log($, `no downgrade: context ${unsure}`)
        if (fanned !== planned) await log($, `hand-off to ${planned.kind === 'delegate' ? planned.tier : '?'} skipped: a workflow ran this session`)
        const paced = paceNow.mode === 'normal' ? '' : `, ${paceNow.mode} pace on ${paceNow.window}${paceNow.pace === undefined ? '' : ` (${paceNow.pace.toFixed(2)})`}`
        await log($, `${r.type}${ratedType ? ` (rated ${ratedType}, continues the ${r.type} task)` : ''} on ${s.tier}/${s.level}${paced}: rated ${fit}, plan ${p.kind}${'dir' in p ? ` ${p.dir}` : ''}${run.tie ? ` (tie ${run.tie.by} over ${run.tie.over})` : ''}: ${did}`)
        // Every 50th Haiku rating gets Sonnet's second opinion, in the background. A Sonnet rating is not checked
        // (Sonnet would only be asked to agree with itself), and does not count toward the 50.
        if (by === 'haiku' && (await dueCheck($))) void spotCheck($, sessionId, s.tier, s.level, prompt, r)
      } else {
        // No rating, even after a second try: the session stays as it is, the safe route. The log line says so, and carries
        // what the rating calls cost; /rightsize report counts the prompt as not counted, and the cost as overhead.
        const reason = failed ?? 'no rating'
        await log($, `prompt not rated (${reason}): kept ${s.level} on ${TIER_NAME[s.tier]}`)
        // An unrated prompt is planned as nothing, but it is still part of the task in progress, and counts as one of its prompts.
        const task = kept?.id
        if (kept) await $.state.set({ plugin: 'rightsize', key: 'task' }, { ...kept, prompts: kept.prompts + 1 }).catch(() => undefined)
        const line: RunLine = { at: new Date().toISOString(), kind: 'unrated', session: sessionId, ...(task ? { task } : {}), reason, rater: by, overhead: round(overhead), ratingMs: Math.round(ratingMs) }
        await append($, 'runs.jsonl', JSON.stringify(line), RUNS_LOG_MAX)
      }
    } catch (err) {
      await log($, `rating threw: ${err instanceof Error ? err.message : String(err)}`)
    }
    // The run waits for its turn before the prompt goes down: the turn can start before next() answers.
    if (run) {
      run.entering = true
      pending.push(run)
    }
    const auto: typeof lastAuto = !run
      ? null
      : run.auto && run.level
      ? { kind: 'lower', text: e.text, level: run.level, normal: run.normal, back: `at ${run.normal}` }
      : run.delegate || run.switchTo
      ? { kind: 'route', text: e.text, model: TIER_NAME[run.tier], back: `on ${TIER_NAME[run.tier]} at ${run.normal}` }
      : null
    lastAuto = auto
    await showStatus($)
    const result = await next(out)
    if (!run) return result
    run.entering = false
    if (result.drop !== undefined) {
      // The prompt never entered: nothing is waiting for it, and what it set for itself goes. A session
      // switch it set stays: that was the person's answer.
      pending = pending.filter(r => r !== run)
      if (lastAuto === auto) lastAuto = null
      const now = await currentTask($)
      if (wroteTask && now?.id === wroteTask.id && now.prompts === wroteTask.prompts) await $.state.set({ plugin: 'rightsize', key: 'task' }, prevTask ?? null).catch(() => undefined)
      await setBand($, null)
      await showStatus($)
      await log($, `prompt dropped (${result.drop}): its rating cost counts as overhead`)
      const line: RunLine = { at: new Date().toISOString(), kind: 'dropped', id: run.id, session: sessionId, task: run.task, reason: result.drop, overhead: round(run.overhead) }
      await append($, 'runs.jsonl', JSON.stringify(line), RUNS_LOG_MAX)
    }
    return result
  }).catch(($, e, next) => next(e))

  // A turn starting is how a prompt finds its turn. Prompts typed while a turn runs wait in line, and the turn
  // that starts for one carries its text, so each run is bound to its own turn, not to whichever starts next.
  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const text = e.text.trim()
    // A plugin beneath may have rewritten the text. The engine starts a prompt's turn before its submit answers,
    // so a turn starting while exactly one prompt from an idle session is still entering is that prompt's.
    const entering = pending.filter(r => r.entering && r.during === undefined)
    const mine = pending.find(r => r.text === text) ?? (entering.length === 1 ? entering[0] : undefined)
    // The line is first in, first out. A prompt typed during a turn that has ended, and passed over by a turn that
    // started for a later prompt or for other text, was read by the turn it was typed in: it has no turn of its own
    // coming. An empty text is a continuation: it says nothing about the line.
    const passed = mine ? pending.slice(0, pending.indexOf(mine)) : text ? pending : []
    const gone = passed.filter(r => r !== mine && r.during !== undefined && completed.has(r.during) && !r.entering)
    pending = pending.filter(r => r !== mine && !gone.includes(r))
    if (mine) await bind($, mine, e.turnId)
    for (const r of gone) await unbind($, r, 'delivered into the running turn')
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) {
      // The hand-off's subagent, and a subagent moved to a cheaper model, run at the
      // level their model needs, whatever Claude asked for.
      await claim($, e.agentId)
      const run = active
      const ours = run?.delegate && run.subAgents.includes(e.agentId) ? run.delegate : undefined
      const sized = resizedRuns.get(e.agentId)
      // A helper that shows the signs of struggling is raised from the task's budget, or sent back.
      const watch = await helperWatch($, e.agentId)
      if (watch) {
        watch.steps += 1
        if (escalation && !off && !watch.returned) {
          const sign = struggle(watch.signals, watch.steps, watch.rated, limits, Infinity)
          if (sign) await escalateHelper($, e.agentId, watch, sign)
        }
      }
      const level = watch?.raisedTo ?? ours?.level ?? sized?.level
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
    // A host with no turn.start hook (or a turn whose text matched nothing): the one prompt that was
    // submitted while the session was idle is this turn's. With more than one, nothing says which.
    if (active?.turnId !== e.turnId) {
      const idle = pending.filter(r => r.during === undefined)
      const only = idle.length === 1 ? idle[0] : undefined
      if (only) {
        pending = pending.filter(r => r !== only)
        await bind($, only, e.turnId)
      }
    }
    const run = active?.turnId === e.turnId ? active : null
    if (isLevel(e.effort)) await $.state.set({ plugin: 'rightsize', key: 'seenEffort' }, e.effort)
    const session = await sessionEffort($)
    const own = session ?? (isLevel(e.effort) ? e.effort : undefined)
    // A switched turn (a review on Opus) runs every step on that model at its level, and only that turn.
    const sw = run?.switchTo
    let level: Level | undefined = sw?.level ?? run?.level ?? session ?? undefined
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
    const send = sw && level ? { ...e, model: sw.tier, effort: level } : level && e.effort !== undefined ? { ...e, effort: level } : e
    const applied = isLevel(send.effort) ? send.effort : undefined
    const out = yield* next(send)
    const u = out.usage
    if (u) {
      // An effort switch may make this request re-write the conversation: measure it.
      // A model rewritten on this step or the last one makes the cache miss the model's, not an effort switch's: not measured.
      if (!sw && !lastSwitched && applied && lastApplied && applied !== lastApplied && lastContext > 5000) {
        const missed = u.cache_read_input_tokens < lastContext * 0.5
        teach(SWITCH_KEY, missed ? 1 : 0)
        // One line per measured switch: the evidence for whether the engine keeps the cache.
        await append(
          $,
          'switches.jsonl',
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
      lastSwitched = sw !== undefined
      lastContext = contextOf(u)
      await $.state.set({ plugin: 'rightsize', key: 'context' }, lastContext)
      // The session's own model stays the one the next prompt is planned on.
      if (!sw) await $.state.set({ plugin: 'rightsize', key: 'seenModel' }, u.model)
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
    // The hand-off's subagent never does a step only the person can approve: a message
    // from the main chat is not their approval. The note asks it to stop; this makes sure.
    if (e.agentId !== undefined && active?.delegate && isApprovalStep(String(e.tool), e as Record<string, unknown>)) {
      await claim($, e.agentId)
      if (active.subAgents.includes(e.agentId)) {
        await log($, `blocked ${String(e.tool)} in the hand-off's subagent: only the main chat does steps the person approves`)
        return { deny: APPROVAL_DENY }
      }
    }
    // A helper that was sent back stays stopped, so that it reports instead of trying again.
    const helper = e.agentId === undefined ? undefined : await helperWatch($, e.agentId)
    if (helper?.returned) return { deny: HELPER_RETURN }
    // The main chat reworking a hand-off (a message to the subagent, or a second one started on its model) uses a chance of the task's budget.
    if (active?.delegate && e.agentId === undefined) {
      const model = (e as { model?: unknown }).model
      const again = String(e.tool) === 'Agent' && active.delegated && tierOf(typeof model === 'string' ? model : undefined) === active.delegate.tier
      if (String(e.tool) === 'SendMessage' || again) {
        if (!(await useChance($, active.task))) {
          await log($, `rework refused: the task's retry budget is used up, so the main chat finishes it`)
          return { deny: REWORK_DENY }
        }
        await log($, `rework round: used one of the task's ${chances} retries`)
      }
    }
    const result = await next(e)
    if (helper && e.agentId !== undefined) await noteHelperCall($, e.agentId, helper, e as Record<string, unknown>, result)
    if (String(e.tool) === 'Workflow') {
      workflowSeen = true
      if (active) active.workflows += 1
    }
    if (active && e.agentId === undefined) {
      const model = (e as { model?: unknown }).model
      if (String(e.tool) === 'Agent' && active.delegate && tierOf(typeof model === 'string' ? model : undefined) === active.delegate.tier) active.delegated = true
      if (String(e.tool) === 'Agent' || String(e.tool) === 'SendMessage') active.agentCalls += 1
      const isError = (result as { isError?: boolean }).isError === true
      // An error from the environment (no network, no login, a denied sandbox, a missing program) is a Blocked
      // stall: more effort would not fix it, so it is neither an error nor a sign of struggling.
      const blocked = isError && blockedError(errorText(result))
      if (blocked) active.blocked += 1
      else if (isError) active.errors += 1
      if (!(result as { deny?: string }).deny && isApprovalStep(String(e.tool), e as Record<string, unknown>)) active.approvalSteps += 1
      // A refused call (a denied permission) says nothing about the work.
      if (!(result as { deny?: string }).deny && !blocked) active.signals = noteCall(active.signals, callKey(String(e.tool), e as Record<string, unknown>), isError, isTestCommand(String(e.tool), e as Record<string, unknown>))
    }
    return result
  }).catch(($, e, next) => next(e))

  // The main chat starting the hand-off's subagent: the Agent call names its model.
  // Remember its id, so its steps run at the hand-off's level. A subagent Claude
  // starts on its own with no model named goes to the cheapest model that fits.
  on('agent.spawn', async ($, e, next) => {
    const run = active ?? pending[0] ?? null
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
      if (!resizedRuns.has(id)) resizedRuns.set(id, { ...size, spend: 0, ...(run ? { task: run.task, run: run.id } : {}) })
      run?.resized.push({ from: size.from, tier: size.tier, level: size.level, type: size.type, ...(size.tie ? { tie: size.tie } : {}) })
    } else if (id) resizedRuns.delete(id)
    // Its watch starts at its spawn.
    if (id && (ours || size)) await helperWatch($, id)
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
    if (band.canStay && lastAuto?.kind === 'route') buttons.push({ key: 'stay', label: `Run on ${lastAuto.model}`, press: async () => $.ui.toast(await runOnCurrent($)) })
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
    const watched = e.agentId === undefined ? undefined : watches.get(e.agentId)
    if (watched) watched.ms = Math.max(0, (await $.clock.now()) - watched.startedAt)
    if (sized) await finishSubagent($, sized, e.isAborted, watched)
    if (e.agentId === undefined) {
      completed.add(e.turnId)
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

