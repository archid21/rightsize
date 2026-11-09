import type { AgentSpawnInput, ConfigSetResult, EngineInterface, PromptSubmitInput, Register, Timer } from 'claude-code'
import type {
  RightsizeBand as Band,
  RightsizeBandMode as BandMode,
  RightsizeChoices as Choices,
  RightsizeLevel as Level,
  RightsizeQuestion as BandQuestion,
  RightsizeTaskType as TaskType,
  RightsizeTier as Tier,
} from '../types'
import {
  DEFAULT_LEVEL,
  DEFAULT_PRICES,
  DEFAULT_RULES,
  COMPACT_SUMMARY_TOKENS,
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
  atPrompt,
  cacheTtlMs,
  coldCost,
  limitSaving,
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
  usageVs,
  sizeSubagent,
  subagentKeys,
  tierOf,
  tierRank,
  usageCost,
  type Usage,
  CAL_STORE,
  routeFactor,
  rebaseCal,
} from './cost'
import { type FreshRun, type HandedOff, NO_STEPS, type StepState, actingExp, mergeSteps, medians, parseStepState, STEP_PROVE, typicalShrink } from './steps'
import { type LearningNote, learningNote } from './learning'
import { applyPrices, diffPrices, isDue, parsePricingPage } from './prices'
import { confidence, missCounts, missMap, ownTasks, pauseRates } from './misses'
import { START_CHECK_DAYS, START_MIN_PROMPTS, START_SNOOZE_DAYS, adviseStart, startBlock, startKey, startTip } from './start'
import {
  ADVANCED,
  KEYS,
  NOT_SET,
  FIXED,
  RULE_KEYS,
  SETTINGS,
  type SettingKey,
  type Values,
  afterSet,
  answersOf,
  askFirstOn,
  defaults,
  fieldsSet,
  inOptions,
  inUse,
  legacyAskFirst,
  manifestGaps,
  mark,
  plainTitle,
  resetKeys,
  ruleLabel,
  ruleValue,
  rulesOf,
  settingNamed,
  stillReset,
  valuesOf,
  watchOnly,
} from './settings'
import { BRIEF_MAX, cutRequest, parseRating, ratingPrompt, ratingSystem } from './rate'
import { isApprovalStep } from './approval'
import { LIMITS, type CapSetting, type Signals, type Struggle, blockedError, callKey, isEditTool, isCapSetting, helperCap, isTestCommand, noSignals, noteCall, oneUp, refusedByPerson, struggle, testsOutcome } from './struggle'
import { type Change, type HelperLine, type Lifetime, type RunLine, type SwitchLine, type Windows, SESSION_TOTAL, SESSION_TOTAL_FROM, bandShareText, buildReport, costTag, foldLifetime, parseLifetime, parseLines, ratedInSession, sessionTotal, shareMessage, shareOf, usedTag, windowCostText, windowRates } from './report'
import { LIMIT_BUTTON, LIMIT_COMPACT, LIMIT_HIDE, LIMIT_MORE, LIMIT_WHY, LIMIT_WHY_ID, isLimitId, limitDue, limitText } from './limit'
import { SIZE_BUTTON, SIZE_COMPACT, SIZE_HIDE, SIZE_MORE, SIZE_WHY, SIZE_WHY_ID, isSizeId, sizeStep, sizeText } from './size'
import { COMPACT_BASE, NO_FRESH_HANDOFF, WRAP_HEADROOM, WRAP_TURNS, isWhatsnext } from './whatsnext'
import { COMPACT_GAP_MIN, PING_PROMPT, ROW_OF, WRAP_UP, addGap, alwaysText, compactBoundary, compactWorth, compactedText, idleCompactState, idleEstimate, breakEvenMs, cacheHeld, clockText, coldPlan, ignoredLately, keepWarmChoices, leadMs, learnedChoice, COLD_MIN, netSaving, nextStart, offerAt, offerText, pingCost, pingEvery, standingChoice, usualStart, warmEndText, warmPlan, warmReturned, warmingText } from './warm'

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
// above the prompt shows what it did, with buttons to retry it at the original effort or change the rule.
// Your setting wins: every row in /config is a setting (settings.ts), and a value the
// person set, or answered, is never changed or bypassed by what rightsize does by itself.

const NAME = 'rightsize'
const CMD = 'rightsize'
/** The rater tried second, when the first is not available, and the one Rater row can pick first. */
const FALLBACK_RATER = 'haiku'
type Rater = 'sonnet' | 'haiku'
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
type Question<V> = { header: string; question: string; options: readonly (readonly [string, V])[]; ifNone?: string }

// The four questions list the answer Ask before changing prefers first, marked (Recommended). The answer's
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
const isWorkflowMode = (v: unknown): v is WorkflowMode => v === 'pause rightsize' || v === 'follow my rules' || v === 'right-size every agent'
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
/** Remember choices, naming the rules set so far: "Keep your rules (Lowering: lower automatically) in every session?" */
const qRemember = (c: Choices): Question<boolean> => {
  const set = (Object.keys(RULE_NAME) as (keyof Choices)[]).filter(r => c[r] !== undefined).map(r => `${RULE_NAME[r]}: ${ruleLabel(r, c[r])}`)
  return {
    header: 'Remember',
    question: `Keep your rules${set.length ? ` (${set.join('; ')})` : ''} in every session?`,
    options: [
      ['Every session', true],
      ['This session', false],
    ],
  }
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
  /** Learning mode: the plan the learned step exponent would have made, beside the real one (learning.ts). */
  learning?: LearningNote
  /** The learned step exponent when the learning plan was made (steps.ts scoreRun). */
  learnG?: number
  /** Set when this hand-off is one the learned exponent would have stopped: the saving bar it was held to (steps.ts scoreRun). */
  handedOff?: HandedOff
  /** The step exponent this turn's estimates were priced with. */
  stepExp: number
  /** Watch only: the change rightsize would have made, and the estimate of that route. Nothing was applied. */
  would?: Change
  wouldTaken?: number
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
  /** Why the turn stepped back up: the 5-step rule alone ('steps'), or a tool error ('error', which counts as a miss). */
  steppedUpBy?: 'steps' | 'error'
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
let rules: Rules = { ...DEFAULT_RULES, handOff: FIXED.handOff }
let checking: Promise<string> | null = null
let prices: Prices = DEFAULT_PRICES
let cal: Calibration = {}
/** The learned step exponent (steps.ts), and the runs it has not been saved with yet. */
let stepState: StepState = NO_STEPS
let unsavedSteps: FreshRun[] = []
const STEP_STORE = 'step-exponent-v1'
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
 * The last prompt's route, for the band's one-click overrides: a lowering (Retry at original effort) or a hand-off or switch-run (Run on
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
/**
 * The person stepped up (a stronger model or a higher effort): rightsize changes neither until they resume. The same value is in
 * $.state ('manualPause') for the session; this copy is what the hooks read without awaiting. See manualCheck() and noteEffort().
 */
type ManualPause = { model?: Tier; effort?: Level; fromModel?: Tier; fromEffort?: Level; at: number; by: 'model' | 'effort' }
let manualPause: ManualPause | null = null
/** The pause row of this prompt's band, until the next prompt, a × or a resume: a later band of the turn (a cache offer) carries it. */
let pauseRow: string | null = null
/** The last main-chat turn whose first step was read for the person's effort. */
let effortTurn: string | undefined
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
/** Ask before changing: on, every move rightsize would make on its own asks first while the case's rule row is not set. */
let askFirst = false
/** A Profile row a release before ADR 0021 stored as Quality: Ask before changing on, while that row is not yours. */
let legacyQuality = false
/** The miss rate at which hand-downs and lowering pause; null: never. */
let missBlock: number | null = MISS_BLOCK
/** The tasks a kind of work must have logged on a model before a cheaper route to it is used; 0: no minimum. */
let minTasks = 0
/** The outcomes logged per task type and model (misses.ts): minTasks is counted against these. */
// Before the log is read, the research priors alone.
let counts: Record<string, number> = missCounts([])
/** The tasks the log itself holds per type and model, research priors left out: what the confidence in the band counts. */
let ownCounts: Record<string, number> = {}
/**
 * Chances a task has to retry: a helper raised a level, or the main chat reworking a hand-off. When they
 * are used up, the helper goes back to the main chat and the main chat finishes the task itself.
 */
let chances = FIXED.chances
/** The first option of each of the four questions. */
let answers = answersOf(false)
/** The highest level a review switched to Opus runs at. */
let reviewCeiling: Level = FIXED.reviewCeiling
/** Mode: watch only rates and plans every prompt, applies nothing, and says what it would have done. */
let watching = false
/**
 * The three feature switches (Routing, Hand-offs, Cache), on unless the row says off. Routing: effort changes on the main chat,
 * the review switch to Opus and mid-turn raises. Hand-offs: a helper subagent, and right-sizing Claude's own subagents.
 * Cache: keep warm, the cold offer, what runs before the cache goes cold, and the idle warning. With Routing and Hand-offs
 * both off no prompt is rated.
 */
let routing = true
let handOffs = true
let cacheOn = true
/** The cases decided with no rule set for the prompt being rated (the default, or Ask before changing), and those the band has already said so for this session. */
let profileChose: (keyof Choices)[] = []
const profileNoted = new Set<keyof Choices>()
/** A note for the prompt's band: the cache went cold, so this prompt writes the conversation again. */
let idleNote = ''
/** Claude Code compacted the session while it sat idle: what the return says. `shown` is true once the band has said it. Cleared by the returning turn's first request. */
let compactedAway: { before: number; after?: number; handoff?: string; shown: boolean } | null = null
/** The person or a plugin compacted the session since the last turn ended: a drop in context after that is not Claude's idle compact. */
let manualCompact = false
/** The next main-chat request is the first since a turn ended: the idle gap and the context are checked on it. */
let boundaryCheck = false
/** One close call in five takes the route the guide did not pick. Off by default. */
let explore = false
/** What happens to the answers to the four questions: ask whether to keep them, keep them, or forget them at the end of the session. */
let rememberMode: 'ask' | 'every session' | 'this session' = 'ask'
/** The most tool calls a helper on a cheaper tier may make for one task. */
let callCap: CapSetting = 'normal'
/** The pace the prompt being rated was decided at. */
let paceNow: Pace = NORMAL_PACE
/** The pace note, for a subscription only: it quotes how full a usage window is, and a window share is never shown on the API. */
/** The band's pacing note, with the bars it moved ("hand-off bar 70% → 85%, lowering 90% → 97%") when it moved them. */
const paceText = (acts: boolean, moved?: { from: Rules; to: Rules }) => {
  if (billing !== 'subscription') return ''
  const note = paceNote(paceNow, acts)
  if (!note || !moved) return note
  const pct = (x: number) => `${Math.round(x * 100)}%`
  const bars = [
    ...(moved.from.handOff !== moved.to.handOff ? [`hand-off bar ${pct(moved.from.handOff)} → ${pct(moved.to.handOff)}`] : []),
    ...(moved.from.lower !== moved.to.lower ? [`lowering bar ${pct(moved.from.lower)} → ${pct(moved.to.lower)}`] : []),
  ]
  return bars.length ? `${note} (${bars.join(', ')})` : note
}
/** Raise effort mid-turn when the turn shows it is struggling. */
let escalation = true
/** A stuck turn is raised: Raise when stuck is on, and so is Routing. */
const raising = () => escalation && routing
/** Days between suggestions of a different starting model and level; null: off. */
let startEvery: number | null = START_CHECK_DAYS.weekly
/** Ask Sonnet for a second opinion on every this many Haiku ratings, in the background; null: off. */
let spotEvery: number | null = FIXED.raterEvery
/** The model that rates first (Rater). The other one is the fallback. */
let rater: Rater = 'sonnet'
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
/** What a big session does before its cache goes cold (Before the cache goes cold, or the fixed value while that row is not yours). */
let coldMode: string = FIXED.beforeCold
/** What whatsnext last said about this folder (`project` in compact-instructions --json), and when. */
let projectFlag: { at: number; value: boolean } | null = null
/** True when the Before the cache goes cold row is the person's own (a row they set always wins over the fixed value). */
let coldYours = false
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
  /** The tier it runs on when that is a cheaper one than the session's (a hand-down or a moved subagent): the call cap applies to these. */
  tier?: Tier
  /** Tool calls it has made, counted as they go out. */
  calls: number
  /** The call cap that sent it back, when that is why. */
  capped?: number
  /** The can't-tell and blocked cases are logged once. */
  said?: boolean
}
/** Every helper watched this session, by agent id. */
const watches = new Map<string, Watch>()
/** One spend of the retry budget at a time: two helpers asking together never both take the last chance. */
let spending: Promise<unknown> = Promise.resolve()
/** The plugin's folder, read once at the session start. */
let pluginRoot = ''

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

function log($: EngineInterface, line: string) {
  return append($, 'rightsize.log', `${new Date().toISOString()} ${line}`, 50_000)
}

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

function readRuns($: EngineInterface): Promise<RunLine[]> {
  return readAll($, 'runs.jsonl', LEGACY_RUNS)
}
function readSwitchLines($: EngineInterface): Promise<SwitchLine[]> {
  return readAll($, 'switches.jsonl', LEGACY_SWITCHES)
}

// The lifetime roll-up: totals of every run line older than 30 days, kept in the plugin's own store (~/.claude/plugins/store,
// outside any repository) so the report's Lifetime column survives the logs being trimmed and pruned. It holds sums only.
const LIFETIME_STORE = 'lifetime'
const ROLLUP_AFTER_DAYS = 30

async function readLifetime($: EngineInterface): Promise<Lifetime | undefined> {
  return parseLifetime(await $.store.get(LIFETIME_STORE).catch(() => undefined))
}

// Folds the lines older than 30 days into the roll-up once. It runs before pruneSessions, which only removes folders idle for 45 days.
// The store is read again just before the write, so a session that started at the same moment does not fold the same lines twice.
async function rollUpLifetime($: EngineInterface) {
  try {
    const now = await $.clock.now()
    const cutoff = now - ROLLUP_AFTER_DAYS * 24 * 60 * 60_000
    const before = await readLifetime($)
    const next = foldLifetime(before, await readRuns($), cutoff)
    // Another session folded while this one read the logs: its fold stands, and this one's lines are in it too.
    if (next && next !== before && (await readLifetime($))?.through === before?.through) await $.store.set(LIFETIME_STORE, next)
  } catch {
    // The lines stay in the logs and are folded at the next start.
  }
}

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

// Compares prices.json with the published price list and updates the numbers in it,
// keeping the old file as prices.json.bak. A check that fails changes nothing and is
// tried again at the next session start. `claimedFrom` is
// the check time a monthly check replaced when it claimed the check; a failed
// check puts it back so the check stays due.
async function checkPrices($: EngineInterface, why: 'monthly' | 'manual', claimedFrom?: unknown): Promise<string> {
  const path = `${pluginRoot}/prices.json`
  const failed = async (msg: string) => {
    if (why === 'monthly') await $.store.set('pricesCheckedAt', typeof claimedFrom === 'number' ? claimedFrom : 0).catch(() => undefined)
    await log($, `${why} ${msg}`)
    return msg
  }
  let text = ''
  try {
    // The address is written out at the call so a reader sees where it goes; prices.ts PRICING_URL holds the same text (scripts/check-settings.mjs checks they match).
    const res = await $.http.fetch('https://platform.claude.com/docs/en/about-claude/pricing.md')
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
function runCheck($: EngineInterface, why: 'monthly' | 'manual', claimedFrom?: unknown) {
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

/** The session switch in force: none while Routing is off (a switch made earlier is left stored, and applies again when Routing is back on). */
async function sessionEffortInUse($: EngineInterface) {
  return routing ? sessionEffort($) : null
}

/** The person's effort as the first step of the last turn carried it: the engine's own setting, before rightsize rewrote any step. */
async function personEffort($: EngineInterface) {
  const v = (await $.state.get({ plugin: 'rightsize', key: 'personEffort' }).catch(() => undefined))?.value
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
type CurrentTask = { id: string; type: TaskType; brief: string; prompts: number; tests?: 'passed' | 'failed' }
async function currentTask($: EngineInterface): Promise<CurrentTask | null> {
  const v = (await $.state.get({ plugin: 'rightsize', key: 'task' }).catch(() => undefined))?.value
  if (!v || typeof v.id !== 'string' || !isTaskType(v.type)) return null
  return {
    id: v.id,
    type: v.type,
    brief: typeof v.brief === 'string' ? v.brief : '',
    prompts: Number.isInteger(v.prompts) && v.prompts > 0 ? v.prompts : 1,
    // How the task's last turn ended, when a test runner ran in it: a red run means the next prompt is not lowered (ADR 0021).
    ...(v.tests === 'failed' || v.tests === 'passed' ? { tests: v.tests } : {}),
  }
}

// Notes on the task in progress how its turn ended, when a test runner ran in the turn. A turn that is not the task's writes nothing.
async function noteTests($: EngineInterface, task: string, tests: 'passed' | 'failed' | undefined) {
  if (!tests) return
  const kept = await currentTask($)
  if (!kept || kept.id !== task) return
  await $.state.set({ plugin: 'rightsize', key: 'task' }, { ...kept, tests }).catch(() => undefined)
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

/**
 * The step exponent was applied or stopped: the calibration ratios were learned against the other basis, so they are
 * rescaled by the typical shrink (steps.ts typicalShrink), and the flip is logged.
 */
async function flipSteps($: EngineInterface, before: StepState, after: StepState) {
  const factor = after.applied ? 1 / typicalShrink(after) : typicalShrink(before)
  // The new state is already stored, so a rebase that fails here is not retried (that would rebase twice): the
  // ratios stay on the old basis and the moving average brings them over.
  try {
    await $.store.set(CAL_STORE, rebaseCal(parseCalibration(await $.store.get(CAL_STORE)), factor))
    cal = rebaseCal(cal, factor)
  } catch {
    // Left on the old basis.
  }
  if (after.applied) {
    const { inc, cand } = medians(after)
    const cut = inc > 0 ? Math.round((1 - cand / inc) * 100) : 0
    await log($, `step estimates applied: they cut estimate error by ${cut}% on your last ${after.scores.length} runs`)
  } else await log($, 'step estimates paused: they stopped beating the plain estimate')
}

async function mergeCal($: EngineInterface) {
  const batch = unsaved
  const runs = unsavedSteps
  if (runs.length) {
    unsavedSteps = []
    try {
      const stored = parseStepState(await $.store.get(STEP_STORE))
      const next = mergeSteps(stored, runs, await $.clock.now())
      // The state is stored before the rebase: a failed save is retried with the same runs and rebases once, when it lands.
      await $.store.set(STEP_STORE, next)
      stepState = next
      if (next.applied !== stored.applied) await flipSteps($, stored, next)
    } catch {
      unsavedSteps = [...runs, ...unsavedSteps]
    }
  }
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
function saveCal($: EngineInterface) {
  saving = saving.then(() => mergeCal($))
  return saving
}

const isBilling = (v: unknown): v is Billing => v === 'api' || v === 'subscription'

async function usageNow($: EngineInterface) {
  return $.session.usage().catch(() => undefined)
}

// A subscription's responses carry its five-hour and seven-day windows; a Claude
// gateway's carry only a spend limit, billed per token. None: no window shown, or no
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
  // It changes only the reports, so it waits on the band and the prompt goes on. Not answered: not saved, and asked again next session.
  if (await bandCanAsk($)) return askBand($, withNextPrompt(qBilling, 'reports use API prices for now'), 'prompt', false, { kind: 'billing' })
  const v = await askWithin($, withWait(qBilling, 'reports use API prices for now'), late => answerBilling($, late))
  if (v === TIMED_OUT) {
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

/** $.ui.ask takes at most this many options. */
const ASK_MAX = 4

// Like pick(), for a list of any length: past ASK_MAX options it shows the first ones and "More…", which asks for the rest.
async function pickFrom<V>($: EngineInterface, q: Question<V>, header = q.header, moreHeader = 'More cache'): Promise<V | undefined> {
  if (q.options.length <= ASK_MAX) return pick($, { ...q, header })
  const more = Symbol('more')
  const asking: Question<V | typeof more> = { ...q, header, options: [...q.options.slice(0, ASK_MAX - 1), ['More…', more]] }
  const v = await pick($, asking)
  return v === more ? pickFrom($, { ...q, options: q.options.slice(ASK_MAX - 1) }, moreHeader, moreHeader) : v
}

/** Question wait in /config: how long a question waits before rightsize takes the choice that changes nothing and costs nothing. */
const QUESTION_WAITS = { '30 seconds': 30_000, '1 minute': 60_000, '2 minutes': 120_000 } as const
type QuestionWait = keyof typeof QUESTION_WAITS
const isQuestionWait = (v: unknown): v is QuestionWait => typeof v === 'string' && Object.hasOwn(QUESTION_WAITS, v)
let questionWait: QuestionWait = '30 seconds'
const TIMED_OUT: unique symbol = Symbol('timed out')

/** A band question's text with the sentence that says what happens when nobody answers before the next prompt. */
const withNextPrompt = <V,>(q: Question<V>, what: string): Question<V> => ({ ...q, ifNone: what })
/** A dialog question's text with the sentence that says what happens when nobody answers. */
const withWait = <V,>(q: Question<V>, what: string): Question<V> => ({ ...q, question: `${q.question} No answer in ${questionWait}: ${what}.` })

// Asks in the engine's dialog, and waits Question wait for the answer. Past that it returns TIMED_OUT, so the caller
// takes its safe default; the dialog, which nothing can close, stays, and an answer that comes later goes to `onLate`
// (without one, a toast says it came too late). A dismissed question stays undefined, as with pick().
// For the questions that must be answered before the work goes on: the band cannot draw while the hook waits.
async function askWithin<V>($: EngineInterface, q: Question<V>, onLate?: (v: V) => void | Promise<void>): Promise<V | undefined | typeof TIMED_OUT> {
  let late = false
  const asked = pick($, q).then(v => {
    if (late && v !== undefined) {
      void Promise.resolve(onLate ? onLate(v) : $.ui.toast('rightsize: that answer came too late; nothing changed.')).catch(() => undefined)
    }
    return v
  })
  const waited = $.clock.sleep(QUESTION_WAITS[questionWait]).then((): typeof TIMED_OUT => TIMED_OUT, (): typeof TIMED_OUT => TIMED_OUT)
  const a = await Promise.race([asked, waited])
  if (a === TIMED_OUT) late = true
  return a
}

// ---- Questions on the band ----------------------------------------------------

// A question that need not stop the work is a row on the band, under what rightsize did, and nobody waits for it:
// the work goes on with the question's safe default, and the answer is applied when it comes. Nothing has a hook
// open then, so the band can draw it and its buttons answer it. A question lasts until the main chat's turn ends
// (`turn`: Stuck, a stuck helper) or until the next prompt (`prompt`: Remember choices, Reports, Workflow).
// Unanswered by then, its `gone` applies the default. Without the band (Band "Never", or a surface that does not
// draw it, such as the mobile app) the caller asks in the engine's dialog, as before.

const QUESTION = { plugin: 'rightsize', key: 'question' } as const

/** What a band question is about, with what its answer needs. */
type BandWhy =
  | { kind: 'billing' }
  | { kind: 'remember' }
  | { kind: 'workflow' }
  | { kind: 'stuck'; run: Run; cur: Level; to: Level; sign: Struggle; step: number }
  | { kind: 'helper'; id: string; w: Watch; cur: Level; to: Level; sign: Struggle }

type BandAsk = {
  q: BandQuestion
  values: readonly unknown[]
  until: 'turn' | 'prompt'
  /** False until it may show: a question asked while a prompt is sent shows once the turn ends. */
  ready: boolean
  /** True once the band has shown it: a `prompt` question that never showed waits for a later band. */
  shown?: boolean
  why: BandWhy
}

/** The band's questions, oldest first: the band shows the first one that is ready. */
const bandAsks: BandAsk[] = []
let questionIds = 0

/** The band can ask: it is on (not Band "Never") and every surface draws it (the terminal and the desktop app). */
async function bandCanAsk($: EngineInterface) {
  if (bandMode === 'off') return false
  const surfaces = await $.session.surfaces().catch(() => [])
  return surfaces.length > 0 && surfaces.every(x => x === 'terminal' || x === 'desktop')
}

/** Puts a question on the band; `now` false waits for the main chat's turn to end. */
async function askBand<V>($: EngineInterface, q: Question<V>, until: BandAsk['until'], now: boolean, why: BandWhy) {
  bandAsks.push({
    q: { id: ++questionIds, header: q.header, question: q.question, options: q.options.map(o => o[0]), ...(q.ifNone ? { ifNone: q.ifNone } : {}) },
    values: q.options.map(o => o[1]),
    until,
    ready: now,
    why,
  })
  await showQuestion($)
}

/** True when a question with this header waits on the band. */
const onBand = (header: string) => bandAsks.some(x => x.q.header === header)

/** Question `id` answered with option `at` (undefined: ×); the next one shows. A press on one already gone does nothing. */
async function answerBand($: EngineInterface, id: number, at: number | undefined) {
  const i = bandAsks.findIndex(x => x.q.id === id)
  if (i < 0) return
  const [done] = bandAsks.splice(i, 1)
  if (!done) return
  await showQuestion($)
  await bandAnswered($, done.why, at === undefined ? undefined : done.values[at]).catch(() => undefined)
}

/** The main chat's turn ended (`turn`), or a prompt came (`prompt`): those questions go, unanswered. */
async function endBand($: EngineInterface, until: BandAsk['until']) {
  const going = bandAsks.filter(x => x.until === until && (until === 'turn' || (x.ready && x.shown)))
  for (const x of going) bandAsks.splice(bandAsks.indexOf(x), 1)
  if (until === 'turn') for (const x of bandAsks) x.ready = true
  await showQuestion($)
  for (const x of going) await bandUnanswered($, x.why).catch(() => undefined)
}

/** A band question's answer (undefined: ×), applied to things as they stand now. */
async function bandAnswered($: EngineInterface, why: BandWhy, v: unknown) {
  switch (why.kind) {
    case 'billing':
      if (isBilling(v)) await answerBilling($, v)
      return
    case 'remember':
      if (v === true) await rememberAlways($)
      // ×: asked again after the next answer.
      else if (v === undefined) await $.state.set({ plugin: 'rightsize', key: 'rememberAsked' }, false)
      return
    case 'workflow':
      await log($, `workflow question: ${v ?? 'dismissed'}`)
      if (isWorkflowMode(v)) await putConfig($, 'workflows', v)
      return
    case 'stuck': {
      const { run, cur, to, sign, step } = why
      // Raised only while that turn still runs; it applies from its next request.
      if (v !== 'yes' || active !== run || run.raisedTo === to) return
      return raiseRun($, run, cur, to, sign, step)
    }
    case 'helper': {
      const { id, w, cur, to, sign } = why
      if (v === 'no') return log($, `helper ${id} struggling (${sign.why}): kept at ${cur}, as you chose`)
      // Gone back, or done: nothing left to raise.
      if (v !== 'yes' || w.returned || watches.get(id) !== w || w.raisedTo === to) return
      if (!(await useChance($, w.task))) return log($, `helper ${id} not raised: the task has no retry left`)
      return raiseHelper($, id, w, cur, to, sign)
    }
  }
}

/** A band question that went unanswered: its default stands. */
async function bandUnanswered($: EngineInterface, why: BandWhy) {
  switch (why.kind) {
    case 'billing':
      // Not saved: asked again next session.
      billing = 'api'
      return logUnanswered($, 'Billing', 'reports use API prices for this session; not saved')
    case 'remember':
      return logUnanswered($, 'Remember', 'these choices stay for this session only')
    case 'workflow':
      return logUnanswered($, 'Workflow', 'rightsize paused for this workflow; not saved')
    case 'stuck':
      return logUnanswered($, 'Stuck', `kept ${why.cur}`)
    case 'helper':
      return logUnanswered($, 'Stuck', `helper ${why.id} kept at ${why.cur}`)
  }
}

/**
 * Shows the first ready question. The band keeps to three rows: while it shows both the prompt's row and the cache
 * row, only a question that ends with the turn (Stuck) shows; the others wait, and do not go at the next prompt unseen.
 */
async function showQuestion($: EngineInterface) {
  const band = (await $.state.get(BAND).catch(() => undefined))?.value
  const mode = (await $.state.get(BAND_MODE).catch(() => undefined))?.value ?? bandMode
  const rows = bandRows(band, mode)
  const full = rows.route && rows.cold
  const ask = bandAsks.find(x => x.ready && (!full || x.until === 'turn'))
  if (ask) ask.shown = true
  await $.state.set(QUESTION, ask?.q ?? null).catch(() => undefined)
}

/** One log line for a band question that went unanswered. */
function logUnanswered($: EngineInterface, header: string, did: string) {
  return log($, `no answer on the band to ${header}: ${did}`)
}

/** One log line for a dialog question nobody answered in time. */
function logTimeout($: EngineInterface, header: string, did: string) {
  return log($, `no answer in ${questionWait} to ${header}: ${did}`)
}

const RULE_IDS = Object.keys(RULE_KEYS) as (keyof Choices)[]

// The directory reads a settings write only as { key: 'fixed text', value: ... }, so each row has its own call.
// The return type makes a new row without a case here fail the type check.
function writeSetting($: EngineInterface, key: SettingKey, value: string): Promise<ConfigSetResult> {
  switch (key) {
    case 'mode': return $.config.set({ key: 'rightsize.mode', value: value })
    case 'routing': return $.config.set({ key: 'rightsize.routing', value: value })
    case 'handOffs': return $.config.set({ key: 'rightsize.handOffs', value: value })
    case 'askFirst': return $.config.set({ key: 'rightsize.askFirst', value: value })
    case 'cache': return $.config.set({ key: 'rightsize.cache', value: value })
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
    case 'rater': return $.config.set({ key: 'rightsize.rater', value: value })
    case 'raterCheck': return $.config.set({ key: 'rightsize.raterCheck', value: value })
    case 'startTips': return $.config.set({ key: 'rightsize.startTips', value: value })
    case 'idleWarning': return $.config.set({ key: 'rightsize.idleWarning', value: value })
    case 'beforeCold': return $.config.set({ key: 'rightsize.beforeCold', value: value })
    case 'billing': return $.config.set({ key: 'rightsize.billing', value: value })
    case 'band': return $.config.set({ key: 'rightsize.band', value: value })
    case 'questionWait': return $.config.set({ key: 'rightsize.questionWait', value: value })
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
  if (cfg[key] === value && yours.has(key) === !unset) return false
  cfg = { ...cfg, [key]: value }
  yours = mark(yours, key, !unset)
  if (!unset) await forgetReset($, key)
  applyOption(key)
  await writeSetting($, key, value).catch(() => undefined)
  return true
}

/**
 * A row the person changes in rightsize's own words (a button, the settings pane): `putConfig`, and then what the
 * config.set hook does after it. `putConfig` runs none of `followRow`, so it runs here, once, and only for a change.
 */
async function changeRow($: EngineInterface, key: SettingKey, value: string) {
  if (await putConfig($, key, value)) await followRow($, key, value)
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
// A Workflow call the person has not been asked about yet, once per call. The answer is Workflows in /config, and the
// person's. Not answered: paused for this workflow, asked at the next. On the band the workflow starts at once,
// paused, and an answer applies from then on; in the dialog it is asked before the workflow starts.
async function askWorkflow($: EngineInterface, id: string | undefined) {
  if (id !== undefined) {
    if (askedWorkflows.has(id)) return
    askedWorkflows.add(id)
  }
  if (await bandCanAsk($)) {
    if (onBand('Workflow')) return
    return askBand($, withNextPrompt(qWorkflow, 'rightsize stays paused for this workflow'), 'prompt', true, { kind: 'workflow' })
  }
  const v = await askWithin($, withWait(qWorkflow, 'rightsize pauses for this workflow'), async late => void (await putConfig($, 'workflows', late)))
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
  // It changes nothing about this prompt, so it waits on the band; an answer applies to the choices as they stand then.
  if (await bandCanAsk($)) return askBand($, withNextPrompt(qRemember(next), 'this session only'), 'prompt', false, { kind: 'remember' })
  // A late answer is applied as an on-time one would be, to the choices as they stand then.
  const yes = await askWithin($, withWait(qRemember(next), 'this session only'), async late => {
    if (late === true) await rememberAlways($)
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

/** Remember choices: every session, from the choices as they stand now. */
async function rememberAlways($: EngineInterface) {
  await $.store.set('remember', true).catch(() => undefined)
  await keepChoices($, await choices($))
  await putConfig($, 'remember', 'every session')
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

// The answer for one situation: a rule you set, or the saved answer, else the default (act, or ask while Ask before changing
// is on). Nothing is saved: a rule row left at "not set" means the default decides, and the band says so the first time each case comes up
// in a session, with the other rules in its ⋯ menu. The question itself (`q`) is kept for /rightsize settings.
async function choice<K extends keyof Choices>($: EngineInterface, key: K, _q: Question<NonNullable<Choices[K]>>) {
  const have = (await choices($))[key]
  if (have) return have
  const v = answers[key] as NonNullable<Choices[K]>
  if (!profileChose.includes(key)) profileChose.push(key)
  await log($, `${RULE_NAME[key]}: no rule set, ${askFirst ? 'Ask before changing' : 'the default'} decides (${ruleLabel(key, v)})`)
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
  let level = (await sessionEffortInUse($)) ?? (await seenEffort($))
  if (!level) {
    const set = await $.settings.read({ key: 'effortLevel' }).catch(() => undefined)
    level = isLevel(set) ? set : DEFAULT_LEVEL[tier]
  }
  const kept = (await $.state.get({ plugin: 'rightsize', key: 'context' }).catch(() => undefined))?.value
  // Nothing kept yet (the first prompt, or a resumed session): the live window's fill, as the engine reports it.
  const have = typeof kept === 'number' && kept > 0
  const reported = have ? undefined : (await usageNow($))?.context?.tokens
  const context = have ? kept : typeof reported === 'number' && reported > 0 ? reported : DEFAULT_CONTEXT
  return { tier, level, context, prices, cal, rules, ties: await tiesSeen($), misses, missBlock, minTasks, counts, ceiling, reviewCeiling, without, explore, stepExp: actingExp(stepState) }
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

async function spotCheck($: EngineInterface, session: string, task: string, tier: Tier, level: Level, prompt: string, first: Rating) {
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
      if (overhead > 0) {
        const line: RunLine = { at: new Date().toISOString(), kind: 'overhead', session, task, overhead: round(overhead) }
        await append($, 'runs.jsonl', JSON.stringify(line), RUNS_LOG_MAX)
      }
      return
    }
    const line: RunLine = { at: new Date().toISOString(), kind: 'check', session, task, type: first.type, fit: first.fit, check: { by: SPOT_CHECKER, fit: second.fit }, overhead: round(overhead) }
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
    // API error (a refusal, an unavailable account, a limit) says the rater is not available now.
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
  if (off || manualPause || !handOffs || subagentMode === 'off') return undefined
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

/** The band's short form of `costLine`: "~28% of Opus usage." on a subscription, "$0.45 vs ~$1.61 on Opus." on the API. */
const bandCost = (d: number, stay: number, cur: string) =>
  billing === 'api' ? `${money(d)} vs ~${money(stay)} on ${cur}.` : `${usageVs(d, stay, cur)}.`

type Decision = { level?: Level; session?: Level; auto?: boolean; delegate?: Run['delegate']; model?: Run['switchTo'] }

/** The effort-only plan a hand-off falls back to (Workflows, Hand-offs off, a declined question): nothing while Routing is off. */
const effortOnly = (r: Rating, s: Situation): Plan => (routing ? effortPlan(r, s, floor) : { kind: 'none', why: 'Routing is off' })

/**
 * A plan after the feature switches. Routing off: an effort change and a review switch become no change. Hand-offs off: a hand-off
 * becomes the effort-only plan (no change while Routing is off). `dropped` is the log line for a plan that was dropped, else undefined.
 * Pure but for the switches themselves: the learning note runs it too, so only the real plan logs.
 */
function gate(p: Plan, r: Rating, s: Situation): { plan: Plan; dropped?: string } {
  if (p.kind === 'delegate' && !handOffs) return { plan: effortOnly(r, s), dropped: 'hand-off skipped: Hand-offs is off' }
  if (!routing && p.kind === 'switch') return { plan: { kind: 'none', why: 'Routing is off' }, dropped: 'review switch skipped: Routing is off' }
  if (!routing && p.kind === 'effort') return { plan: { kind: 'none', why: 'Routing is off' }, dropped: 'effort change skipped: Routing is off' }
  return { plan: p }
}

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
    const stay = () => resolveEffort($, effortOnly(r, s), r, s)
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
  const stay = () => resolveEffort($, effortOnly(r, s), r, s)
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
  const ep = effortOnly(r, s)
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
export function delegateNote(d: NonNullable<Run['delegate']>, rounds = FIXED.chances) {
  // The task's chances are its rework rounds: a fixed count.
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

/** What the plan's route is estimated to cost, for watch-only mode: what rightsize would have taken. */
function wouldCost(p: Plan, r: Rating, s: Situation) {
  if (p.kind === 'delegate') return p.delegateCost
  if (p.kind === 'switch') return p.cost
  if (p.kind === 'effort') return mainCost(r, s, p.level, 2)
  return mainCost(r, s, s.level, 0)
}

/** The band in watch-only mode: what rightsize would have done, and what that would have used. */
export function watchBand(run: Pick<Run, 'tier' | 'normal' | 'stay' | 'rating'>, p: Plan, s: Situation): Band {
  const cur = TIER_NAME[run.tier]
  const off = 'Mode in /config turns it on.'
  if (p.kind === 'none') return { text: `Watching: ${run.normal} on ${cur} fits this prompt; nothing to change. ${off}`, acted: false }
  if (p.kind === 'delegate') return { text: `Watching: would send this to a ${TIER_NAME[p.tier]} subagent at ${p.level} effort. ${bandCost(p.delegateCost, p.mainCost, cur)} ${off}`, acted: true }
  if (p.kind === 'switch') return { text: `Watching: would run this review on ${TIER_NAME[p.tier]} at ${p.level} effort, then go back to ${cur}. ${bandCost(p.cost, p.mainCost, cur)} ${off}`, acted: true }
  const what = p.dir === 'lower' ? `lower effort to ${p.level}` : `raise effort to ${p.level}`
  const cost = p.dir === 'lower' ? ` ${bandCost(mainCost(run.rating, s, p.level, 2), run.stay, cur)}` : ''
  return { text: `Watching: would ${what} on ${cur}.${cost} ${off}`, acted: true }
}

/** The person's prompt says the last reply was wrong: one `corrected` line for the task's last run on a cheaper route, once. */
async function noteCorrection($: EngineInterface, task: string) {
  const last = [...runLog].reverse().find(l => (l.kind ?? 'run') === 'run' && l.task === task && (l.change === 'lower' || l.change === 'delegate-down'))
  if (!last?.id || runLog.some(l => l.kind === 'corrected' && l.ref === last.id)) return
  await appendRun($, { at: new Date().toISOString(), kind: 'corrected', session: sessionId, task, ref: last.id })
  await log($, `the prompt corrects the last reply: counted as a miss for run ${last.id} (${last.change})`)
}

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
  const swCost = sw && swOn ? mainCost(r, swOn, sw.level, 0) + (s.context * atPrompt(s.prices[sw.tier], s.context).cacheWrite) / 1e6 : 0
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
    stepExp: s.stepExp ?? 0,
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
  if (manualPause) return $.ui.status(pauseStatus(manualPause))
  const run = active ?? pending[0] ?? null
  if (run?.delegate) return $.ui.status(`Handing this to a ${TIER_NAME[run.delegate.tier]} subagent`)
  if (run?.switchTo) return $.ui.status(`Running this review on ${TIER_NAME[run.switchTo.tier]} at ${run.switchTo.level} effort`)
  if (run?.raisedTo) return $.ui.status(`Effort: ${run.raisedTo} (raised mid-turn)`)
  if (run?.steppedUp) return $.ui.status(`Effort: back to ${run.normal} (the task got harder)`)
  if (run?.level) return $.ui.status(run.auto ? `Effort: ${run.level} (auto) · /rightsize retry` : `Effort: ${run.level} (this prompt)`)
  if (!run && lastAuto?.kind === 'lower') return $.ui.status(`Last prompt ran at ${lastAuto.level} (auto) · /rightsize retry`)
  const session = await sessionEffortInUse($)
  $.ui.status(session ? `Effort: ${session} (this session)` : undefined)
}

// ---- Band ------------------------------------------------------------------

const BAND = { plugin: 'rightsize', key: 'band' } as const
const BAND_MODE = { plugin: 'rightsize', key: 'bandMode' } as const

const isBandMode = (v: unknown): v is BandMode => v === 'when it acts' || v === 'always' || v === 'off'

/** Which of the band's rows show: the prompt's row (also when there is nothing else to show) and the cache row. */
function bandRows(band: Band | null | undefined, mode: BandMode) {
  const shows = !!band && mode !== 'off' && (mode === 'when it acts' ? band.acted : true)
  return { route: shows && (band.text !== '' || !band.coldText), cold: shows && !!band.coldText }
}

/** A line every band of this turn carries, so a later band (a hand-off's result) does not hide it: a miss just forgiven. */
let bandNote: string | null = null

/** `rating` is true for the band of a prompt being rated now: its run line is not in the log yet, so it counts as one more rated prompt toward SESSION_TOTAL_FROM. */
function setBand($: EngineInterface, from: Band | null, rating = false) {
  if (!from) return $.state.set(BAND, null).catch(() => undefined).then(() => showQuestion($))
  const band: Band = from
  // A band built from an earlier band's text already carries a total: drop it, and add the current one last.
  let text = band.text.replace(SESSION_TOTAL, '')
  let coldText = band.coldText?.replace(SESSION_TOTAL, '')
  if (bandNote && !text.includes(bandNote)) text = `${text} ${bandNote}`
  // The pause row stays on the band of the prompt it began on, with its Resume button, when a later band of the turn is set.
  const held = pauseRow !== null && manualPause !== null
  if (held && !text.includes(pauseRow)) text = `${pauseRow} ${text}`.trim()
  // Not before the session's 3rd rated prompt (SESSION_TOTAL_FROM); the report counts from the first.
  const total = ratedInSession(runLog, sessionId) + (rating ? 1 : 0) >= SESSION_TOTAL_FROM ? sessionTotal(runLog, sessionId, billing === 'subscription') : undefined
  // The total goes after the route's text; a band with only the cache line carries it there.
  const after = (t: string) => `${t}${/[.!?]$/.test(t) ? '' : '.'} ${total}`
  if (held) {
    // A pause claims no saving: no total on it.
  } else if (total && text) text = after(text)
  else if (total && coldText) coldText = after(coldText)
  const { coldText: droppedCold, ...rest } = band
  return $.state.set(BAND, { ...rest, text, ...(coldText ? { coldText } : {}), ...(held ? { acted: true, canResume: true } : {}) }).catch(() => undefined).then(() => showQuestion($))
}

async function setBandMode($: EngineInterface, v: BandMode) {
  bandMode = v
  await $.state.set(BAND_MODE, v).catch(() => undefined)
  await showQuestion($)
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
  // Why this route, and for a move to a cheaper model (a lowering or a hand-off down: the routes the miss rate scores) how confident rightsize is: the level on the band, the detail in the ⋯ menu.
  const why = run.rating ? whyText(run.rating.reason) : ''
  const conf = (tier: Tier) => (run.rating ? confidence(run.rating.type, tier, ownCounts, misses) : undefined)
  const sure = (tier: Tier) => {
    const c = conf(tier)
    return c ? `Confidence: ${c.level}.` : ''
  }
  const sureDetail = (tier: Tier | undefined) => {
    const c = tier ? conf(tier) : undefined
    return c ? { sure: `Confidence: ${c.level}, ${c.detail}.` } : {}
  }
  const more = (...parts: string[]) => parts.filter(Boolean).map(x => ` ${x}`).join('')
  if (run.switchTo) {
    return { text: `Running this review on ${TIER_NAME[run.switchTo.tier]} at ${run.switchTo.level} effort, then back to ${cur}. ${bandCost(run.takenMain ?? 0, run.stay, cur)}${more(why)}`, acted: true, rule: 'up', canStay: true }
  }
  if (run.delegate) {
    const to = `${TIER_NAME[run.delegate.tier]} subagent at ${run.delegate.level} effort`
    const instead = p.kind === 'delegate' && p.instead && levelRank(p.instead) > levelRank(run.normal) ? ` instead of raising ${cur} to ${p.instead}` : ''
    return { text: `Sending this to a ${to}${instead}. ${bandCost(run.takenDelegate ?? 0, run.stay, cur)}${more(why, run.delegate.dir === 'down' ? sure(run.delegate.tier) : '')}`, acted: true, rule: run.delegate.dir, canStay: true, ...sureDetail(run.delegate.dir === 'down' ? run.delegate.tier : undefined) }
  }
  const level = d.level ?? d.session
  if (level) {
    const lower = levelRank(level) < levelRank(run.normal)
    const scope = d.level ? `this prompt${run.auto ? ' (automatically)' : ''}` : 'this session'
    return {
      text: `Effort ${lower ? 'lowered' : 'raised'}: ${run.normal} → ${level} for ${scope}.${more(why, lower ? sure(run.tier) : '')}`,
      acted: true,
      rule: lower ? 'lower' : 'raise',
      ...sureDetail(lower ? run.tier : undefined),
      // A lowering can be marked right or wrong: it was a bet on the rating.
      ...(lower ? { rate: run.id } : {}),
      ...(run.auto && d.level ? { canRetry: true } : {}),
      ...(d.session ? { canClear: true } : {}),
    }
  }
  if (p.kind === 'none') return { text: `No change: ${run.normal} on ${cur} fits this prompt.`, acted: false }
  const what = p.kind === 'effort' ? `${p.level} effort` : p.kind === 'switch' ? `${TIER_NAME[p.tier]} at ${p.level}` : `a ${TIER_NAME[p.tier]} subagent at ${p.level}`
  const rule = p.kind === 'effort' ? (p.dir === 'lower' ? 'lower' : 'raise') : p.kind === 'switch' ? 'up' : p.dir
  const down = p.kind === 'effort' ? (p.dir === 'lower' ? run.tier : undefined) : p.kind === 'delegate' && p.dir === 'down' ? p.tier : undefined
  return { text: `No change: ${what} would fit, kept ${run.normal} on ${cur}.${more(why, down ? sure(down) : '')}`, acted: false, rule, ...sureDetail(down) }
}

async function setRule($: EngineInterface, key: keyof Choices, value: string) {
  await saveChoices($, { ...(await choices($)), [key]: value } as Choices, true)
  const label = RULES[key].find(r => r[0] === value)?.[1] ?? value
  $.ui.toast(`Rightsize: ${RULE_NAME[key]} is now "${label}".`)
}

/**
 * Puts the last prompt back in the box and lets it run once as it would have without rightsize: not rated, not
 * changed. Retry at original effort does it for a lowering, "Run on <model>" for a hand-off or a switch-run.
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

function retry($: EngineInterface) {
  return runAsIs($, 'lower', 'Nothing to retry: the last prompt was not lowered automatically.')
}
function runOnCurrent($: EngineInterface) {
  return runAsIs($, 'route', 'Nothing to run again: the last prompt was not handed off or run on another model.')
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
    const { rate: droppedRate, ...rest } = band
    await setBand($, rest)
  }
  $.ui.toast('Rightsize: thanks — this tunes its choices on this machine.')
}

// 👍 and 👎 are for the result in front of the person: their next prompt takes them off the band.
async function dropRate($: EngineInterface) {
  const band = (await $.state.get(BAND).catch(() => undefined))?.value
  if (!band?.rate) return
  const { rate: droppedRate, ...rest } = band
  await setBand($, rest)
}

async function chooseBandMode($: EngineInterface) {
  const v = await pick($, qBand)
  if (v === undefined) return
  await setBandMode($, v)
  await putConfig($, 'band', v)
}

type MenuChoice = { rule: string } | { cold: string } | { tip: string } | { cache: true } | { mode: true } | { rate: 'up' | 'down' }

const MENU_NOTE = 'Dollar amounts on a subscription are API-equivalent: what the same use would cost on the API.'

// The ⋯ menu: this band's rule options, the tip's Stop suggesting, the offer's other cache choices, and the band setting.
// Dismissed: nothing changes. $.ui.ask takes 4 options at most, so when the list is longer the cache choices go one level down.
async function bandMenu($: EngineInterface, band: Band) {
  const rule = band.rule
  const have = rule ? (await choices($))[rule] : undefined
  // The marks come first on a result band (they are what the band is for), then the rules, the cache choices and the band setting.
  const own: (readonly [string, MenuChoice])[] = []
  if (band.rate) own.push(['Mark this 👍 (right call)', { rate: 'up' }], ['Mark this 👎 (wrong call)', { rate: 'down' }])
  if (rule) for (const [value, label] of RULES[rule]) if (value !== have) own.push([label, { rule: value }])
  if (band.tip) own.push(['Stop suggesting', { tip: band.tip }])
  const cache: (readonly [string, MenuChoice])[] = (band.coldMore ?? []).map(c => [c.label, { cold: c.id }])
  const mode: readonly [string, MenuChoice] = ['When the band shows…', { mode: true }]
  const all = [...own, ...cache, mode]
  const header = 'Options'
  const question = `${band.sure ? `${band.sure} ` : ''}${band.detail ? `${band.detail} ` : ''}Options for this band. ${MENU_NOTE}`
  // $.ui.ask takes 4 options at most: a longer list is paged, three at a time with More….
  const v = await pickFrom($, { header, question, options: all }, header, 'More options')
  if (!v) return
  if ('rule' in v && rule) await setRule($, rule, v.rule)
  else if ('rate' in v && band.rate) await giveFeedback($, band.rate, v.rate)
  else if ('tip' in v) await stopStartTips($)
  else if ('cold' in v) await pressCold($, v.cold)
  else if ('mode' in v) await chooseBandMode($)
}

/** "Ran 2 of Claude's subagents on Haiku (low) instead of Opus." */
export function resizedText(xs: readonly Resized[]) {
  const to = [...new Set(xs.map(x => `${TIER_NAME[x.tier]} (${x.level})`))].join(' and ')
  const from = [...new Set(xs.map(x => TIER_NAME[x.from]))].join(' and ')
  const n = xs.length === 1 ? "Claude's subagent" : `${xs.length} of Claude's subagents`
  return `Ran ${n} on ${to} instead of ${from}.`
}

/** The hand-off's result line. `short`, for the band: on a subscription the share only, as the ⋯ menu gives the dollars. */
export function report(run: Pick<Run, 'tier' | 'stay'> & { delegate: NonNullable<Run['delegate']> }, actual: number, mode: 'api' | 'subscription', short = false) {
  const to = TIER_NAME[run.delegate.tier]
  const cur = TIER_NAME[run.tier]
  if (mode === 'subscription') return `rightsize: Sent to ${to}. ${usageVs(actual, run.stay, cur)}${short ? '' : ` (${money(actual)} vs ${money(run.stay)})`}.`
  const x = actual / Math.max(run.stay, 1e-9)
  const diff = actual <= run.stay ? `~${Math.round((1 - x) * 100)}% saved` : `~${x.toFixed(1)}x the cost`
  return `rightsize: Sent to ${to}. ${money(actual)} vs ~${money(run.stay)} on ${cur} (${diff}).`
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
  const tests = testsOutcome(run.signals) ?? run.subAgents.map(id => watches.get(id)).map(w => (w ? testsOutcome(w.signals) : undefined)).find(t => t !== undefined)
  await noteTests($, run.task, tests)
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
      // A hand-off the learned exponent would have stopped is scored against its real cost. It teaches g nothing.
      if (run.handedOff) unsavedSteps.push({ steps: r.steps, actual, taken: run.takenDelegate ?? 0, stepExpUsed: run.stepExp, g: run.learnG ?? stepState.g, handedOff: run.handedOff })
    }
    // A turn that stepped back up, or was raised mid-turn, ran at more than one
    // level, so its cost says nothing about one level's estimate: it teaches nothing.
    else if (!run.delegate && !run.steppedUp && !run.escalations.length) {
      // A switched turn teaches the switched model's keys, with the one cache write the switch costs taken out.
      const written = run.switchTo ? (run.context * atPrompt(prices[run.switchTo.tier], run.context).cacheWrite) / 1e6 : 0
      const spent = Math.max(0, actual - run.missCost - written)
      const sample = ratioSample(spent, run.rawMain)
      const keys = mainKeys(r.type, run.switchTo?.tier ?? run.tier, run.ranAt)
      // The step exponent learns from what the estimate would have been with no shrink: calibrated, then the shrink taken back out.
      // Scored with the same run: what the estimate was, and how close it would have been with the learned exponent.
      unsavedSteps.push({
        steps: r.steps,
        actual: spent,
        taken: run.takenMain,
        stepExpUsed: run.stepExp,
        g: run.learnG ?? stepState.g,
        estimated: (run.rawMain * routeFactor(cal, keys)) / Math.max(1, r.steps) ** run.stepExp,
      })
      for (const key of keys) teach(key, sample)
    }
    await saveCal($)
  }
  // Every rated turn is logged, changed or not and stopped or not, for /rightsize report.
  if (actual > 0 || run.overhead > 0) {
    const fixed = await fixedContext($)
    const now = await $.clock.now()
    const helpers = [...watches].filter(([, w]) => w.run === run.id).map(([agent, w]) => ({ agent, kind: w.kind, ...helperLine(w, now) }))
    const stored = await $.state.get(RETRIES).catch(() => undefined)
    const retries = usedOf(stored?.value, run.task)
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
      ...(run.learning ? { learning: run.learning } : {}),
      ...(run.switchTo ? { switched: run.switchTo.tier, switchedLevel: run.switchTo.level } : {}),
      ...(run.pace.mode !== 'normal' ? { pace: { ...run.pace, ...(run.pace.pace === undefined ? {} : { pace: Number(run.pace.pace.toFixed(2)) }) } } : {}),
      auto: run.auto,
      steppedUp: run.steppedUp,
      ...(run.steppedUpBy ? { steppedUpBy: run.steppedUpBy } : {}),
      ...(run.escalations.length ? { escalations: run.escalations } : {}),
      estimate: Number((delegated ? (run.rawDelegate ?? 0) : run.rawMain).toFixed(5)),
      actual: round(actual),
      measured: ledger > 0 ? 'ledger' : 'tokens',
      tokens: round(tokens),
      stay: round(run.stay),
      taken: round(delegated ? (run.takenDelegate ?? run.takenMain) : run.takenMain),
      change: run.change,
      offered: run.offered,
      ...(run.would ? { would: run.would, wouldTaken: round(run.wouldTaken ?? 0) } : {}),
      // The objective outcome: how the last test run ended, in the main chat, else in one of the turn's helpers.
      ...(tests ? { tests } : {}),
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
      ...(fixed ? { fixed: { ...fixed, cost: round((run.requests * fixed.tokens * atPrompt(prices[run.switchTo?.tier ?? run.tier], run.context).cacheRead) / 1e6) } } : {}),
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
      : report({ tier: run.tier, stay: run.stay, delegate: run.delegate }, actual, billing, bandMode !== 'off')
    const detail = delegated && billing === 'subscription' ? { detail: `${money(actual)} vs ${money(run.stay)} on ${TIER_NAME[run.tier]}, API-equivalent.` } : {}
    // The band shows the result in place of a transcript line; with the band off, the line stays.
    if (bandMode === 'off') $.ui.log(text)
    else await setBand($, { text: text.replace(/^rightsize: /, ''), acted: true, rule: run.delegate.dir, ...(delegated ? { rate: run.id } : {}), ...detail })
  }
  if (run.resized.length && bandMode !== 'off') {
    const text = resizedText(run.resized)
    const band = (await $.state.get(BAND).catch(() => undefined))?.value
    await setBand($, band?.acted ? { ...band, text: band.text ? `${band.text} ${text}` : text } : { text, acted: true })
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
  const set = (await choices($)).raise
  if (paceNow.mode === 'max' && set === undefined) {
    await log($, `mid-turn raise to ${to} skipped (${sign.why}): the usage window is nearly used up`)
    return
  }
  // No rule set: the default Raising answer decides, as for a rated raise.
  const rule = set ?? answers.raise
  if (rule === 'never') return
  if (rule !== 'auto') {
    const q: Question<'yes' | 'no'> = {
      header: 'Stuck',
      question: `Claude looks stuck: ${sign.why}. Raise effort from ${cur} to ${to} for the rest of this turn?`,
      options: [
        [`Raise to ${to} for this turn`, 'yes'],
        [`Keep ${cur}`, 'no'],
      ],
    }
    // The turn goes on at its effort while the band asks; a Raise applies from its next request, while the turn still runs.
    if (await bandCanAsk($)) {
      if (onBand('Stuck')) return
      return askBand($, { ...q, ifNone: `the turn goes on at ${cur}` }, 'turn', true, { kind: 'stuck', run, cur, to, sign, step })
    }
    const a = await askWithin($, withWait(q, `it keeps ${cur}`))
    if (a === TIMED_OUT) await logTimeout($, 'Stuck', `kept ${cur}`)
    if (a !== 'yes') return
  }
  await raiseRun($, run, cur, to, sign, step)
}

async function raiseRun($: EngineInterface, run: Run, cur: Level, to: Level, sign: Struggle, step: number) {
  run.raisedTo = to
  run.escalations.push({ step, from: cur, to, why: sign.why })
  await setBand($, { text: `Effort raised mid-turn: ${cur} → ${to} (${sign.why}).`, acted: true, rule: 'raise' })
  await showStatus($)
  await log($, `raised mid-turn ${cur} → ${to} at step ${step}: ${sign.why}`)
}

// A helper is struggling: only more effort for struggling helps, and only from the task's retry
// budget. Raising decides as it does for the main chat: automatic raises, Never leaves it alone, and
// otherwise the person is asked. On the band the helper goes on at its effort while it asks, and a Raise applies while
// it still runs; in the dialog no answer within Question wait sends the helper back, so a helper does not wait for ever. When no chance or no level is left, it goes back to the
// main chat. Blocked errors are not struggling; a sign with only blocked errors behind it can't be told apart
// from them, so it neither raises nor counts as a miss. Each sign is weighed once, as in escalate().
async function escalateHelper($: EngineInterface, id: string, w: Watch, sign: Struggle) {
  w.signals = { ...w.signals, fired: [...w.signals.fired, sign.kind] }
  if (w.blocked > 0 && !Object.values(w.signals.calls).some(c => c.errors > 0)) {
    await log($, `helper ${id} looks stuck (${sign.why}) but only the environment failed: can't tell, no raise`)
    return
  }
  const set = (await choices($)).raise
  const rule = set ?? answers.raise
  if (rule === 'never') return
  if (paceNow.mode === 'max' && set === undefined) {
    await log($, `raise of helper ${id} skipped (${sign.why}): the usage window is nearly used up`)
    return
  }
  const cur = w.raisedTo ?? w.level
  const to = oneUp(cur, ceiling)
  let why = ''
  const stored = to ? await $.state.get(RETRIES).catch(() => undefined) : undefined
  const usedNow = usedOf(stored?.value, w.task)
  if (!to) why = `${cur} is as high as it goes`
  // No chance left: nothing to ask about.
  else if (usedNow >= chances) why = 'the task has no retry left'
  else if (rule !== 'auto' && (await bandCanAsk($))) {
    if (onBand('Stuck')) return
    const q: Question<'yes' | 'no'> = {
      header: 'Stuck',
      question: `A helper looks stuck: ${sign.why}. Raise its effort from ${cur} to ${to}? It uses one of this task's ${chances} retries.`,
      options: [
        [`Raise to ${to}`, 'yes'],
        [`Keep ${cur}`, 'no'],
      ],
      ifNone: `it goes on at ${cur}`,
    }
    return askBand($, q, 'turn', true, { kind: 'helper', id, w, cur, to, sign })
  } else if (rule !== 'auto') {
    const a = await askHelper($, sign, cur, to)
    if (a === 'no') {
      await log($, `helper ${id} struggling (${sign.why}): kept at ${cur}, as you chose`)
      return
    }
    // No answer: the helper goes on at its effort, as on the band. Sending it back on silence would make a quality risk out of a missed dialog.
    if (a === 'timeout') {
      await log($, `helper ${id} struggling (${sign.why}): no answer in ${questionWait}, goes on at ${cur}`)
      return
    }
  }
  if (to && !why && !(await useChance($, w.task))) why = 'the task has no retry left'
  if (to && !why) return raiseHelper($, id, w, cur, to, sign)
  w.returned = true
  w.stall = 'struggling'
  await setBand($, { text: `Helper stopped and sent back to the main chat: ${sign.why}, and ${why}.`, acted: true })
  await log($, `returned helper ${id} to the main chat at step ${w.steps}: ${sign.why}, and ${why}`)
}

async function raiseHelper($: EngineInterface, id: string, w: Watch, cur: Level, to: Level, sign: Struggle) {
  w.raisedTo = to
  w.raises.push({ step: w.steps, from: cur, to, why: sign.why })
  w.stall = 'struggling'
  await setBand($, { text: `Helper effort raised: ${cur} → ${to} (${sign.why}).`, acted: true, rule: 'raise' })
  await log($, `raised helper ${id} ${cur} → ${to} at step ${w.steps}: ${sign.why}`)
}

// The Stuck question for a helper, in the dialog. A dismissed question is a no, as for the main chat. An answer
// that comes after the wait is too late: the helper went on at its effort.
async function askHelper($: EngineInterface, sign: Struggle, cur: Level, to: Level): Promise<'yes' | 'no' | 'timeout'> {
  const a = await askWithin(
    $,
    {
      header: 'Stuck',
      question: `A helper looks stuck: ${sign.why}. Raise its effort from ${cur} to ${to}? It uses one of this task's ${chances} retries. With no answer in ${questionWait} it goes on at ${cur}.`,
      options: [
        [`Raise to ${to}`, 'yes'],
        [`Keep ${cur}`, 'no'],
      ],
    },
    late => {
      if (late === 'yes') $.ui.toast(`rightsize: too late, the helper went on at ${cur}.`)
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

/** The idle gaps of each project (ms from a turn's end to the person's next prompt, at least IDLE_GAP_MIN), the latest 20 per project. */
const IDLE_GAPS = 'idleGaps'

async function idleGaps($: EngineInterface): Promise<number[]> {
  const all = await $.store.get(IDLE_GAPS).catch(() => undefined)
  const v = all && typeof all === 'object' && !Array.isArray(all) ? (all as Record<string, unknown>)[await projectFolder($)] : undefined
  return Array.isArray(v) ? v.filter((n): n is number => typeof n === 'number') : []
}

/** The person's prompt arrived: the time since this session's last turn ended, when it is long enough to be an absence, joins the project's gaps. */
async function recordGap($: EngineInterface) {
  try {
    const last = lastTurnAt || (await lastTurns($))[sessionId]?.at
    if (!last) return
    const gaps = addGap(await idleGaps($), (await $.clock.now()) - last)
    const project = await projectFolder($)
    const all = await $.store.get(IDLE_GAPS).catch(() => undefined)
    const rest = all && typeof all === 'object' && !Array.isArray(all) ? (all as Record<string, unknown>) : {}
    await $.store.set(IDLE_GAPS, { ...rest, [project]: gaps }).catch(() => undefined)
  } catch {
    // A missing gap only makes the estimate rougher.
  }
}

const idleFor = (ms: number) => {
  const m = Math.round(ms / 60_000)
  const n = (v: number, unit: string) => `${v} ${unit}${v === 1 ? '' : 's'}`
  return m < 120 ? n(m, 'minute') : m < 48 * 60 ? n(Math.round(m / 60), 'hour') : n(Math.round(m / 1440), 'day')
}

/** A subscriber's 5-hour window used per API-equivalent dollar over the last 30 days of runs, as a range; undefined until runs show it. */
async function windowPerDollar($: EngineInterface) {
  const now = await $.clock.now()
  const lines = await readRuns($)
  return windowRates(lines.filter(l => now - Date.parse(l.at) <= 30 * 24 * 60 * 60_000 && Date.parse(l.at) >= measureFrom), 'five_hour')
}

/** "about $0.16" on the API; on a subscription, "~0.8–1.6% of your 5-hour window ($0.16 API-equivalent)" once runs show the rate. */
function usageCostText(d: number, rates: Awaited<ReturnType<typeof windowPerDollar>>) {
  return billing === 'api' ? `about ${money(d)}` : windowCostText(d, rates)
}

/** What coming back cold costs, for the band's offer: "about $1.10" on the API; on a subscription "~2%" once runs show the rate, else the dollars, labelled. */
function coldCostText(d: number, rates: Awaited<ReturnType<typeof windowPerDollar>>) {
  if (billing === 'api') return `about ${money(d)}`
  return rates === undefined ? `about ${money(d)} API-equivalent` : bandShareText(shareOf(d, rates))
}

// After the cache expired, the next request writes the whole conversation again. Past
// 200K tokens Claude Code compacts an idle session before the cache expires, so this is
// for sessions under that. The prompt is never held: the band notes the cost (as a share of
// the 5-hour window on a subscription) beside what rightsize did with the prompt, and what
// /compact would have cost, so the person knows for next time.
async function noteIdle($: EngineInterface) {
  idleNote = ''
  if (cacheOn && !compactedAway) await detectCompact($)
  // Claude compacted the session while it was idle: the cache did not simply go cold, the conversation is small now.
  if (compactedAway) {
    idleNote = compactedAway.after === undefined ? '' : compactedText({ before: compactedAway.before, after: compactedAway.after, ...(compactedAway.handoff ? { handoff: compactedAway.handoff } : {}) })
    compactedAway.shown = idleNote !== ''
    idleWarnedFor = lastTurnAt
    return
  }
  if (!cacheOn || idleWarning === null || billingBy === null) return
  const last: LastTurn | undefined = lastTurnAt ? { at: lastTurnAt, context: lastContext } : (await lastTurns($))[sessionId]
  if (!last || last.at === idleWarnedFor) return
  // Keep-warm requests refreshed the cache after the turn ended: it went cold an hour after the last of them.
  const idle = (await $.clock.now()) - Math.max(last.at, lastWarmAt)
  const context = lastContext || last.context
  if (idle < cacheTtl || !context) return
  const s = await situation($)
  const c = idleCost(prices[s.tier], context)
  if (c.resend < idleWarning) return
  idleWarnedFor = last.at
  const rates = billing === 'subscription' ? await windowPerDollar($) : undefined
  idleNote = `Idle ${idleFor(idle)}: the cache went cold, so this prompt writes the conversation (~${Math.round(context / 1000)}K tokens) again, ${usageCostText(c.resend, rates)} more than warm; /compact first would have cost ${usageCostText(c.compact, rates)}.`
  await log($, `idle ${idleFor(idle)} with ${context} tokens: noted on the band (${money(c.resend)} to write again)`)
}

// ---- Claude Code's idle auto-compact (ADR 0019) -------------------------------------------------------------------
//
// With idleCompaction on (the default), Claude Code compacts a session 54 minutes after its last request when the context is
// at or above CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS. Keep-warm pings do not reset that timer and, after the compact, each pays
// for the uncached summary. So above the threshold on a 1-hour cache rightsize sends no pings, makes no offer and compacts
// nothing itself (coldCheck), and it notices the compact when it has happened (the signals below).

const IDLE_COMPACT = { plugin: 'rightsize', key: 'idleCompact' } as const

/** True when Claude Code will compact this session by itself while it sits idle. The result, with the context it was read at, is kept in $.state. */
async function idleCompactNow($: EngineInterface, context: number): Promise<boolean> {
  const idleCompaction = await $.settings.read({ key: 'idleCompaction' }).catch(() => undefined)
  const autoCompactEnabled = await $.settings.read({ key: 'autoCompactEnabled' }).catch(() => undefined)
  const disableAutoCompact = await $.env.get('DISABLE_AUTO_COMPACT').catch(() => undefined)
  const minTokens = await $.env.get('CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS').catch(() => undefined)
  const idle = idleCompactState({ idleCompaction, autoCompactEnabled, disableAutoCompact: typeof disableAutoCompact === 'string' ? disableAutoCompact : undefined, ttl: cacheTtl, context, minTokens: typeof minTokens === 'string' ? minTokens : undefined })
  await $.state.set(IDLE_COMPACT, { on: idle, context, at: await $.clock.now() }).catch(() => undefined)
  return idle
}

/** The conversation is `tokens` now (a compact): the stored size, in memory, in $.state and in the session's last-turn record. */
async function replaceContext($: EngineInterface, tokens: number) {
  lastContext = tokens
  await $.state.set({ plugin: 'rightsize', key: 'context' }, tokens).catch(() => undefined)
  const all = await lastTurns($)
  const had = all[sessionId]
  if (had) await $.store.set(LAST_TURNS, { ...all, [sessionId]: { ...had, context: tokens } }).catch(() => undefined)
}

/** The handoff whatsnext says this session has, as it shows the path; undefined when whatsnext is not there, has none, or the one it has is another session's. */
async function reportedHandoff($: EngineInterface): Promise<string | undefined> {
  if ((await whatsnextInstalled($)) !== true || !/^[A-Za-z0-9_-]+$/.test(sessionId)) return undefined
  const got = await whatsnextRun($, ['compact-instructions', '--session', sessionId, '--json'])
  if ('why' in got || got.run.exitCode !== 0) return undefined
  try {
    const out = JSON.parse(got.run.stdout) as { handoff?: unknown; handoff_exists?: unknown; handoff_foreign?: unknown }
    return out.handoff_exists === true && out.handoff_foreign !== true && typeof out.handoff === 'string' && out.handoff ? out.handoff : undefined
  } catch {
    return undefined
  }
}

/**
 * A compact boundary was seen: Claude compacted the session while it was idle. Pings stop, the cache path is dropped, the stored
 * size is replaced (when the new size is known), and the return is remembered so that it is never counted as a cache miss.
 */
async function noteCompacted($: EngineInterface, before: number, after?: number) {
  await dropCache($, 'Claude compacted the session')
  const handoff = await reportedHandoff($)
  compactedAway = { before, ...(after ? { after } : {}), ...(handoff ? { handoff } : {}), shown: false }
  if (after) await replaceContext($, after)
  await log($, `idle compact: Claude compacted this session while it was idle (${before} to ${after ?? 'an unknown number of'} tokens): keep warm stopped, and the return is not counted as a cache miss${handoff ? `; handoff ${handoff}` : ''}`)
}

/** At the person's prompt: the live context, against the size when the turn ended. A drop after an idle gap of 50 minutes or more, with no /compact, is Claude's idle compact. */
async function detectCompact($: EngineInterface) {
  const last: LastTurn | undefined = lastTurnAt ? { at: lastTurnAt, context: lastContext } : (await lastTurns($))[sessionId]
  if (!last || last.context <= 0) return
  const tokens = (await usageNow($))?.context?.tokens
  if (typeof tokens !== 'number') return
  if (compactBoundary({ gap: (await $.clock.now()) - last.at, before: last.context, after: tokens, manual: manualCompact })) await noteCompacted($, last.context, tokens)
}

/** True when whatsnext's commands or skills are listed (so it is installed and on); false when they are not; undefined when the list cannot be read. */
async function whatsnextInstalled($: EngineInterface): Promise<boolean | undefined> {
  try {
    return (await $.command.list()).some(c => isWhatsnext(c.plugin))
  } catch {
    return undefined
  }
}

// ---- whatsnext's interfaces ---------------------------------------------------------------------------------------
//
// Two, all through whatsnext's own script (`python3 <plugin folder>/skills/whatsnext/scripts/whatsnext.py`):
//  1. Wrap up: submit exactly `wrap up`. Its hook answers it only in a project that went through `whatsnext init`.
//  2. Compaction in an OPEN session (rightsize's): `compact-instructions --session <id> --json` gives `compact_prompt`
//     (`/compact <instructions>`) and `wrap_up_first`. When that is true, submit `wrap up`, wait for the end of its turn,
//     ask again, then submit `compact_prompt` (run through `$.command.run`: a prompt that begins with `/` is refused). Once: the second answer is followed whatever `wrap_up_first` says.

/** whatsnext's script, below its plugin folder. */
const WHATSNEXT_SCRIPT = 'skills/whatsnext/scripts/whatsnext.py'

/** Claude Code's own folder: `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
async function claudeDir($: EngineInterface) {
  return (await $.env.get('CLAUDE_CONFIG_DIR').catch(() => undefined)) || `${home}/.claude`
}

/** The folder whatsnext treats as the project: git's top level from the session's folder, else that folder. Empty when the session's folder is unknown. */
async function projectFolder($: EngineInterface): Promise<string> {
  const cwd = await $.session.cwd().catch(() => '')
  if (!cwd) return ''
  const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd }).catch(() => undefined)
  return (top && top.exitCode === 0 ? top.stdout.trim() : '') || cwd
}

/**
 * True when whatsnext says this folder is one of its projects (`project` in `compact-instructions --json`): the owner of
 * `wrap up` says whether `wrap up` will work here. rightsize looks at no whatsnext file itself.
 */
async function whatsnextInitialized($: EngineInterface): Promise<boolean> {
  const got = await whatsnextSteps($)
  return 'steps' in got && got.steps.project
}

/** One whatsnext command: `python3 <plugin folder>/skills/whatsnext/scripts/whatsnext.py <args>` in the project folder. Never throws. */
async function whatsnextRun($: EngineInterface, args: string[]): Promise<{ run: { exitCode: number; stdout: string; stderr: string } } | { why: string }> {
  try {
    const project = await projectFolder($)
    if (!project) return { why: 'the session\'s folder is unknown' }
    const root = await whatsnextRoot($, project)
    if (!root) return { why: 'whatsnext\'s plugin folder was not found in the list of installed plugins' }
    return { run: await $.process.run(['python3', `${root}/${WHATSNEXT_SCRIPT}`, ...args], { cwd: project, timeoutMs: 60_000 }) }
  } catch (err) {
    return { why: `whatsnext could not run (${err instanceof Error ? err.message : String(err)})` }
  }
}

/**
 * whatsnext's plugin folder, from Claude Code's list of installed plugins (`<config>/plugins/installed_plugins.json`: each
 * `name@marketplace` has entries with an `installPath`). The newest entry that has the script wins; an entry installed for
 * another project is passed over. Undefined when there is none: a plugin loaded by `--plugin-dir` is not in the list.
 */
async function whatsnextRoot($: EngineInterface, project: string): Promise<string | undefined> {
  let plugins: unknown
  try {
    plugins = (JSON.parse(await readText($, `${await claudeDir($)}/plugins/installed_plugins.json`)) as { plugins?: unknown }).plugins
  } catch {
    return undefined
  }
  if (!plugins || typeof plugins !== 'object') return undefined
  const found: { path: string; at: number }[] = []
  for (const [key, list] of Object.entries(plugins as Record<string, unknown>)) {
    if (!isWhatsnext(key) || !Array.isArray(list)) continue
    for (const x of list as { installPath?: unknown; projectPath?: unknown; lastUpdated?: unknown }[]) {
      if (typeof x?.installPath !== 'string' || !x.installPath) continue
      if (typeof x.projectPath === 'string' && x.projectPath !== project) continue
      found.push({ path: x.installPath, at: typeof x.lastUpdated === 'string' ? Date.parse(x.lastUpdated) || 0 : 0 })
    }
  }
  for (const f of found.sort((a, b) => b.at - a.at)) if ((await $.fs.exists(`${f.path}/${WHATSNEXT_SCRIPT}`).catch(() => false)) === true) return f.path
  return undefined
}

/** What `compact-instructions --json` says: the prompt that compacts, whether a wrap-up has to come first, and whether this folder is a whatsnext project. */
type WhatsnextSteps = { prompt: string; wrapUpFirst: boolean; project: boolean }

/** Asks whatsnext how to compact this open session: its steps, or why it cannot (not found, an error, an answer that is not JSON). Never throws. */
async function whatsnextSteps($: EngineInterface): Promise<{ steps: WhatsnextSteps } | { why: string }> {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return { why: 'the session has no usable id' }
  const got = await whatsnextRun($, ['compact-instructions', '--session', sessionId, '--json'])
  if ('why' in got) return got
  const { run } = got
  if (run.exitCode !== 0) return { why: `compact-instructions exited ${run.exitCode}${run.stderr.trim() ? `: ${run.stderr.trim().split('\n')[0]}` : ''}` }
  let out: { compact_prompt?: unknown; wrap_up_first?: unknown; project?: unknown }
  try {
    out = JSON.parse(run.stdout) as typeof out
  } catch {
    return { why: 'compact-instructions did not answer in JSON' }
  }
  if (typeof out?.compact_prompt !== 'string' || !out.compact_prompt.startsWith('/compact ') || typeof out.wrap_up_first !== 'boolean' || typeof out.project !== 'boolean') {
    return { why: 'compact-instructions answered without compact_prompt, wrap_up_first or project' }
  }
  return { steps: { prompt: out.compact_prompt, wrapUpFirst: out.wrap_up_first, project: out.project } }
}

/**
 * A compaction that goes through whatsnext: how it ends well (`compacted`; `noFresh` is true when it went ahead without a new
 * handoff), and what compacts instead when whatsnext cannot (`fallback`). `label` starts its log lines.
 */
type WhatsnextCompact = { label: string; compacted: (noFresh?: boolean) => Promise<void>; fallback: () => Promise<void> }
/** whatsnext asked for a wrap-up first and it was submitted: the compaction follows the end of that turn. At most one per compaction. */
let wrapThenCompact: WhatsnextCompact | null = null
/** Main-turn ends since `wrap up` was submitted at which whatsnext still said the handoff was missing. */
let wrapTurns = 0

/** rightsize's own compaction, for when whatsnext is not there or cannot compact: one text for every path. Resolves to the reason when it was skipped. */
async function ownCompact($: EngineInterface): Promise<string | undefined> {
  return (await $.session.compact({ instructions: COMPACT_BASE })).skip
}

/** `text` with " no fresh handoff" said when the compaction went ahead without one. */
const withHandoffNote = (text: string, noFresh: boolean | undefined) => (noFresh ? `${text.replace(/\.$/, '')}; ${NO_FRESH_HANDOFF}.` : text)

/** Submits rightsize's own prompt, which its hook lets through unrated. Resolves to the reason when it is refused. */
async function submitOwn($: EngineInterface, text: string): Promise<string | undefined> {
  coldPrompt = text.trim()
  try {
    return (await $.prompt.submit({ text })).drop
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`
  } finally {
    coldPrompt = null
  }
}

async function whatsnextFallback($: EngineInterface, w: WhatsnextCompact, why: string) {
  await log($, `${w.label}: whatsnext could not compact (${why}); compacting with rightsize's own instructions`)
  await w.fallback()
}

/**
 * Submits whatsnext's `compact_prompt` (`/compact <instructions>`). A prompt that begins with `/` is refused by `$.prompt.submit`,
 * so the slash command runs through `$.command.run`, the way the person's own `/compact` would; a failure falls back.
 */
async function submitWhatsnextCompact($: EngineInterface, w: WhatsnextCompact, prompt: string, noFresh?: boolean) {
  try {
    await $.command.run({ command: 'compact', args: prompt.slice('/compact '.length) })
  } catch (err) {
    return whatsnextFallback($, w, `"/compact" could not run: ${err instanceof Error ? err.message : String(err)}`)
  }
  await w.compacted(noFresh)
}

/**
 * Compacts the open session the way whatsnext says. When it wants a handoff first, `wrap up` goes now and the compaction
 * follows a main-turn end at which whatsnext no longer wants one (resumeCompact); otherwise `compact_prompt` goes now. With
 * less than WRAP_HEADROOM tokens left in the window a wrap-up turn could overflow it: no `wrap up`, the compaction goes
 * ahead with the handoff there is, and the band says so. Any failure falls back, and says why.
 */
async function compactWithWhatsnext($: EngineInterface, w: WhatsnextCompact) {
  const got = await whatsnextSteps($)
  if ('why' in got) return whatsnextFallback($, w, got.why)
  if (!got.steps.project) return whatsnextFallback($, w, 'this project has not been through "whatsnext init"')
  if (!got.steps.wrapUpFirst) return submitWhatsnextCompact($, w, got.steps.prompt)
  const ctx = (await usageNow($))?.context
  if (typeof ctx?.window === 'number' && typeof ctx.tokens === 'number' && ctx.window - ctx.tokens < WRAP_HEADROOM) {
    await log($, `${w.label}: ${Math.round(ctx.window - ctx.tokens)} tokens left in the window, under ${WRAP_HEADROOM}: no "${WRAP_UP}"; compacting with the existing handoff`)
    return submitWhatsnextCompact($, w, got.steps.prompt, true)
  }
  wrapThenCompact = w
  wrapTurns = 0
  const drop = await submitOwn($, WRAP_UP)
  if (drop !== undefined) {
    wrapThenCompact = null
    return whatsnextFallback($, w, `"${WRAP_UP}" was refused: ${drop}`)
  }
  await log($, `${w.label}: whatsnext wants a handoff first; submitted "${WRAP_UP}", the compaction follows once whatsnext no longer asks for one`)
  await showCold($, 'Saving a handoff with whatsnext, then compacting.')
}

/**
 * A main turn ended after `wrap up` was submitted (the turn may be a prompt queued ahead of it): ask whatsnext again. Compact
 * only when `wrap_up_first` is false; otherwise wait for the next turn's end, and after WRAP_TURNS of them give up with a band note.
 */
async function resumeCompact($: EngineInterface, w: WhatsnextCompact) {
  const got = await whatsnextSteps($)
  if ('why' in got) return whatsnextFallback($, w, got.why)
  if (got.steps.wrapUpFirst) {
    wrapTurns += 1
    if (wrapTurns < WRAP_TURNS) {
      wrapThenCompact = w
      await log($, `${w.label}: the handoff is not written yet (turn ${wrapTurns} of ${WRAP_TURNS}); waiting for the next turn`)
      return
    }
    wrapTurns = 0
    await log($, `${w.label}: no handoff after ${WRAP_TURNS} turns; not compacting`)
    await showCold($, `whatsnext's handoff was not written after ${WRAP_TURNS} turns, so nothing was compacted.`)
    return
  }
  wrapTurns = 0
  await submitWhatsnextCompact($, w, got.steps.prompt)
}

// ---- Before the usage limit ----------------------------------------------------------------------------------------

// Near the 5-hour limit with a big conversation, when the reset is further off than the cache lives, the whole
// conversation is read again at full price after the reset. A compaction now, while the cache is warm, leaves a short
// summary instead. rightsize only advises: the row shows at the end of a main turn, once per 5-hour window, and the
// compaction runs when the person presses "Compact now" and never otherwise. Its figures are limit.ts and cost.ts (limitSaving).

/** The store keys: true once the person hid the advice, and the `resetsAt` of the window it was last shown (or logged) for. */
const LIMIT_HIDDEN = 'limitAdviceHidden'
const LIMIT_WINDOW = 'limitAdviceWindow'

/** The turn ended: shows the advice when it is due. Skipped while rightsize or Cache is off. Watch-only mode logs it. Never throws. */
async function limitCheck($: EngineInterface) {
  try {
    if (off || !cacheOn) return
    if ((await $.store.get(LIMIT_HIDDEN).catch(() => undefined)) === true) return
    const u = await usageNow($)
    const context = lastContext || u?.context?.tokens
    const now = await $.clock.now()
    const due = limitDue(u?.rateLimits ?? [], context, now, cacheTtl)
    if (!due || typeof context !== 'number') return
    if ((await $.store.get(LIMIT_WINDOW).catch(() => undefined)) === due.resetsAt) return
    const tier = (await situation($)).tier
    const saving = limitSaving(prices, tier, context)
    if (saving <= 0) return
    // An offer up owns the cache row; a keep-warm run takes the advice beside its own line (showAdvice).
    if (coldTurn?.offer || warming?.note) {
      await log($, 'usage-limit advice: not shown, the cache row is in use')
      return
    }
    const subscription = billing === 'subscription'
    const text = limitText(due.resetAt, saving, subscription, subscription ? await windowPerDollar($) : undefined)
    if (!text) return
    if (watching) {
      await $.store.set(LIMIT_WINDOW, due.resetsAt).catch(() => undefined)
      await log($, `watch only: would advise compacting before the 5-hour limit (${money(saving)} saved after the reset, ${Math.round(context / 1000)}K tokens on ${TIER_NAME[tier]}, resets ${clockText(due.resetAt)})`)
      return
    }
    if (bandMode === 'off') return
    await $.store.set(LIMIT_WINDOW, due.resetsAt).catch(() => undefined)
    await showAdvice($, { text, button: LIMIT_BUTTON, more: LIMIT_MORE })
    await log($, `usage-limit advice: shown, compacting now saves ${money(saving)} after the reset (${Math.round(context / 1000)}K tokens on ${TIER_NAME[tier]}, resets ${clockText(due.resetAt)})`)
  } catch {
    // Advice must never hold up a turn.
  }
}

// ---- Context-size warning ------------------------------------------------------------------------------------------

// ADR 0013, decision 1. At the end of a main turn, when the conversation first reaches 40, 50, 60, 70, 80 or 90% of the window
// (a step that Claude Code's own auto-compaction would reach first is skipped), the cache row says so, with Compact now. It
// advises: the compaction runs on the button and never otherwise. Once per step per conversation; a compaction starts it over.

/** The store key: true once the person hid the warning. */
const SIZE_HIDDEN = 'sizeWarningHidden'
/** The highest step already said in this conversation (0: none). */
let sizeShown = 0

async function sizeCheck($: EngineInterface) {
  try {
    if (off) return
    if ((await $.store.get(SIZE_HIDDEN).catch(() => undefined)) === true) return
    const ctx = (await $.session.usage({ breakdown: 'summary' }).catch(() => undefined))?.context
    const tokens = ctx?.tokens
    const window = ctx?.window
    if (typeof tokens === 'number' && typeof window === 'number' && window > 0 && (tokens / window) * 100 < sizeShown) sizeShown = 0 // compacted: start over
    const step = sizeStep(tokens, window, ctx?.breakdown?.autoCompactThreshold, sizeShown)
    if (step === undefined || typeof tokens !== 'number' || typeof window !== 'number') return
    // An offer, or advice with its own button (the usage-limit advice, alone or on a keep-warm row), owns the cache row: this
    // step is said at a later turn's end. A keep-warm run takes the warning beside its own line (showAdvice).
    const had = (await $.state.get(BAND).catch(() => undefined))?.value
    if (coldTurn?.offer || warming?.note || (!warming && had?.cold?.length)) {
      await log($, `context warning: ${step}% not shown, the cache row is in use`)
      return
    }
    sizeShown = step
    const text = sizeText(step, tokens, window)
    if (watching) {
      await log($, `watch only: would warn that the context is ${step}% full (${Math.round(tokens / 1000)}K of ${Math.round(window / 1000)}K tokens)`)
      return
    }
    if (bandMode === 'off') return
    await showAdvice($, { text, button: SIZE_BUTTON, more: SIZE_MORE })
    await log($, `context warning: shown at ${step}% (${Math.round(tokens / 1000)}K of ${Math.round(window / 1000)}K tokens)`)
  } catch {
    // A warning must never hold up a turn.
  }
}

/** The warning's button and ⋯ entries. */
async function pressSize($: EngineInterface, id: string): Promise<void> {
  try {
    if (id === SIZE_WHY_ID) {
      $.ui.log(SIZE_WHY)
      return
    }
    if (id === SIZE_HIDE) {
      await $.store.set(SIZE_HIDDEN, true).catch(() => undefined)
      await clearAdvice($)
      $.ui.toast('Rightsize: the context-size warning is hidden.')
      await log($, 'context warning: hidden for good ("Don\'t show again")')
      return
    }
    if (id !== SIZE_COMPACT) return
    if (mainBusy) {
      $.ui.toast('Rightsize: a turn is running. Press Compact now again when it ends.')
      return
    }
    await compactForSize($)
  } catch (err) {
    await log($, `context warning failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Runs the compaction the person asked for with "Compact now" on the warning: whatsnext's way when it is installed, else rightsize's own. */
async function compactForSize($: EngineInterface) {
  cancelCold($, 'Compact now pressed')
  coldDone = true
  const done = (noFresh?: boolean) => async () => {
    sizeShown = 0
    idleWarnedFor = lastTurnAt
    await log($, `context warning: compacted on the person's button${noFresh ? ` (${NO_FRESH_HANDOFF})` : ''}`)
    await showCold($, withHandoffNote('Compacted. Later turns read a short summary, not the whole conversation.', noFresh))
  }
  const own = async () => {
    const skip = await ownCompact($)
    if (skip !== undefined) {
      await log($, `context warning: compact skipped: ${skip}`)
      await clearColdRow($)
      $.ui.toast(`Rightsize: the conversation was not compacted (${skip}).`)
      return
    }
    await done()()
  }
  if ((await whatsnextInstalled($)) !== true) return own()
  await compactWithWhatsnext($, { label: 'context warning', compacted: async noFresh => done(noFresh)(), fallback: own })
}

/** The advice's button and ⋯ entries: "Compact now" compacts, "Why?" explains, "Don't show again" hides this row for good. */
async function pressLimit($: EngineInterface, id: string): Promise<void> {
  try {
    if (id === LIMIT_WHY_ID) {
      $.ui.log(LIMIT_WHY)
      return
    }
    if (id === LIMIT_HIDE) {
      await $.store.set(LIMIT_HIDDEN, true).catch(() => undefined)
      await clearAdvice($)
      $.ui.toast('Rightsize: the usage-limit advice is hidden.')
      await log($, 'usage-limit advice: hidden for good ("Don\'t show again")')
      return
    }
    if (id !== LIMIT_COMPACT) return
    if (mainBusy) {
      $.ui.toast('Rightsize: a turn is running. Press Compact now again when it ends.')
      return
    }
    await compactForLimit($)
  } catch (err) {
    await log($, `usage-limit advice failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Runs the compaction the person asked for with "Compact now" on the advice. Only the button calls it. */
async function compactForLimit($: EngineInterface) {
  cancelCold($, 'Compact now pressed')
  coldDone = true
  const own = async () => {
    const skip = await ownCompact($)
    if (skip !== undefined) {
      await log($, `usage-limit advice: compact skipped: ${skip}`)
      await clearColdRow($)
      $.ui.toast(`Rightsize: the conversation was not compacted (${skip}).`)
      return
    }
    // The conversation is small now: the idle question would quote the old size.
    idleWarnedFor = lastTurnAt
    await log($, 'usage-limit advice: compacted before the reset, on the person\'s button')
    await showCold($, 'Compacted. After the reset a short summary is read, not the whole conversation.')
  }
  if ((await whatsnextInstalled($)) !== true) return own()
  await compactWithWhatsnext($, {
    label: 'usage-limit advice',
    compacted: async noFresh => {
      idleWarnedFor = lastTurnAt
      await log($, `usage-limit advice: compacted with whatsnext before the reset, on the person's button${noFresh ? ` (${NO_FRESH_HANDOFF})` : ''}`)
      await showCold($, withHandoffNote('Compacted. After the reset a short summary is read, not the whole conversation.', noFresh))
    },
    fallback: own,
  })
}

// ---- Before the cache goes cold ----------------------------------------------

// A session whose action saves something (its own cost taken off what coming back after the cache
// expired would cost, API-equivalent dollars on a subscription too) gets one of these at the end of a main-chat turn, by the row:
// an offer in the band (ask), keep-warm requests until a chosen time, a whatsnext handoff, a compaction, or nothing.
// The offer is a row of its own under the band's route line, with one button; the other choices are in the ⋯ menu. On a
// cache of 1 hour or more it shows OFFER_AFTER_MS after the turn ended, not at its end (the timer below); on a shorter
// cache it shows at once.
// It is rightsize's own: the prices and the cache's life are cost.ts and prices.json, the cost the report counts as
// overhead (a `warm` line), the words the band's. A session has one timer, a `$.clock.after` that waits for the next
// thing to do (the expiry action, or the next ping, which schedules the one after it). A newer turn's end replaces it,
// and a prompt from the person, Stop, turning rightsize off or the row changing cancels it; `coldGen` is the second
// guard, for a callback already on its way. Nothing fires during a turn. rightsize never writes whatsnext's files: it
// sends the prompt its skill answers.

/** Every cancel and every new turn bumps this: a callback that wakes up under an older number does nothing. */
let coldGen = 0
/** The one pending timer: the expiry action, or the next ping. Cancelled with `cancelCold`. */
let coldTimer: Timer | null = null
/** The big turn the offer or the keep-warm run is about: what its buttons act on. */
type ColdTurn = {
  endedAt: number
  context: number
  tier: Tier
  /** What coming back cold would cost: the conversation written to the cache again, less a read. */
  cold: number
  /** whatsnext is installed and this project went through `whatsnext init`: it can write the handoff. */
  whatsnext: boolean
  /** The task in progress when the turn ended: the keep-warm requests are counted in its total. */
  task?: string
  /** Where each offered keep-warm choice ends, by its id. */
  ends: Record<string, number>
  /** The offer as it shows without a question: its line, its one button and the choices of the ⋯ menu. `args` are what the line is made of, so a minute tick can redraw it. */
  offer?: { text: string; first: ColdButton; more: ColdButton[]; args: Omit<Parameters<typeof offerText>[0], 'now'> }
  /** The question the cache row asks instead, until it is answered. */
  ask?: ColdAsk
}
type ColdButton = { id: string; label: string }
/** "Always …?" for a choice that has a row value, or whether to stop offering. */
type ColdAsk = { kind: 'always'; choice: string } | { kind: 'stop' }
let coldTurn: ColdTurn | null = null
/** An offer is on the band and nobody has answered it: its outcome goes in the run log when it is. */
let offerOpen = false
type Warming = { until: number; pings: number; spent: number; rates: Awaited<ReturnType<typeof windowPerDollar>>; note?: CacheNote }
/** Advice said on the keep-warm row while it runs (the usage-limit advice or the context warning): its text goes first, its button beside Stop. */
type CacheNote = { text: string; button: { id: string; label: string }; more: readonly { id: string; label: string }[] }
let warming: Warming | null = null
/** A handoff or a compaction ran since the person's last prompt: the turn it caused does not start another round. */
let coldDone = false
/** The prompt rightsize itself is submitting: its own prompt.submit hook lets it through unrated. */
let coldPrompt: string | null = null
/** A main-chat turn is running: nothing here fires meanwhile. */
let mainBusy = false
/** When the last keep-warm request was answered: the cache is warm from then, whatever the last turn's end says. */
let lastWarmAt = 0
/** The keep-warm run's turn, while the person's returning prompt waits for its first request: that request shows whether the cache held (settleWarm). */
let warmReturn: ColdTurn | null = null

const pingsText = (n: number) => `${n} ping${n === 1 ? '' : 's'}`

/** Cancels the pending timer. */
function stopColdTimer() {
  coldTimer?.cancel()
  coldTimer = null
}

/** Cancels what waits or pings: the pending timer, and a callback already on its way (`coldGen`). */
function cancelCold($: EngineInterface, why: string) {
  coldGen += 1
  stopColdTimer()
  const w = warming
  warming = null
  if (w) void log($, `keep warm stopped (${why}): ${pingsText(w.pings)}, ${money(w.spent)}`)
}

/** Takes the Cache row off the band, and leaves the prompt's row as it was. */
async function clearColdRow($: EngineInterface) {
  const band = (await $.state.get(BAND).catch(() => undefined))?.value
  if (!band || (!band.coldText && !band.cold && !band.coldMore && !band.coldLink)) return
  const { coldText: _t, cold: _c, coldMore: _m, coldLink: _l, ...route } = band
  await setBand($, route.text ? route : null)
}

/** Everything of the cache path stops: the pending timer or keep-warm run, the offer (closed with no outcome: nobody answered it) and its row. */
async function dropCache($: EngineInterface, why: string) {
  cancelCold($, why)
  coldTurn = null
  offerOpen = false
  warmReturn = null
  wrapThenCompact = null
  idleNote = ''
  await clearColdRow($)
}

/**
 * The band for this turn's offer or keep-warm line: `text` goes on the cache row, with `cold` as its button and `more`
 * as the offer's other choices (the ⋯ menu lists them). With `join`, the row sits under what the band said before (a
 * lowering's Retry and 👍 👎 stay); without it, it is the only row.
 */
async function showCold($: EngineInterface, text: string, cold?: { id: string; label: string }[], join = false, more?: { id: string; label: string }[], link?: { label: string; href: string }) {
  if (bandMode === 'off') return
  const had = join ? (await $.state.get(BAND).catch(() => undefined))?.value : undefined
  const { coldText: _t, cold: _c, coldMore: _m, coldLink: _l, ...route } = had ?? { text: '', acted: false }
  const lead = had && (had.acted || bandMode === 'always') ? route : { text: '' }
  await setBand($, { ...lead, acted: true, coldText: text, ...(cold?.length ? { cold } : {}), ...(more?.length ? { coldMore: more } : {}), ...(link ? { coldLink: link } : {}) })
}

/**
 * The other plugin that matters: whatsnext writes the handoff, but only in a project that went through `whatsnext init`
 * (its hook answers `wrap up` there alone). A listing that fails says it is not installed.
 */
async function neighbours($: EngineInterface) {
  const installed = await whatsnextInstalled($)
  if (installed === undefined) {
    await log($, 'before the cache goes cold: could not list the commands; whatsnext taken as not installed')
    return { whatsnext: false }
  }
  if (!installed) return { whatsnext: false }
  // whatsnext answers whether this is its project; the answer is kept for 10 minutes so a session's turn ends do not each start it.
  const now = await $.clock.now()
  if (!projectFlag || now - projectFlag.at > 10 * 60_000) projectFlag = { at: now, value: await whatsnextInitialized($) }
  const ready = projectFlag.value
  if (!ready && coldMode === 'save a handoff') await log($, 'before the cache goes cold: whatsnext is installed but this project has not been through "whatsnext init"; compacting instead of saving a handoff')
  return { whatsnext: ready }
}

// Arms the session's one timer for `at` (ms): `fn` runs then, unless the timer was cancelled, a newer round began or
// rightsize is off. `$.clock.after` is the engine's API for a long wait: its callback is kept in the plugin's
// environment, so it does not hang on the budget of the hook that scheduled it. An earlier timer is replaced.
async function armCold($: EngineInterface, gen: number, at: number, fn: () => Promise<void>) {
  const wait = Math.max(0, at - (await $.clock.now()))
  if (gen !== coldGen) return
  stopColdTimer()
  coldTimer = $.clock.after(wait, () => {
    coldTimer = null
    if (gen !== coldGen || off) return
    void fn().catch(err => log($, `before the cache goes cold failed: ${err instanceof Error ? err.message : String(err)}`))
  })
}

// At a main turn's end, in the session's own model's prices. Skipped: rightsize off, Cache or the row off, no conversation,
// one whose action would not save anything (netSaving), one over 200K tokens (Claude Code compacts those itself),
// and a round already done after the person's last prompt.
async function coldCheck($: EngineInterface) {
  await closeOffer($, 'ignored')
  cancelCold($, 'a newer turn ended')
  coldTurn = null
  // An offer for an earlier turn is stale now: this turn gets its own, or none.
  if ((await $.state.get(BAND).catch(() => undefined))?.value?.cold) await setBand($, null)
  if (off || !cacheOn || coldDone || coldMode === 'off') return
  const context = lastContext
  if (!context) return
  // Claude Code compacts this session by itself while it sits idle: no pings (they do not reset its timer and would pay for the
  // uncached summary after it), no offer, no rightsize compact; whatsnext's wrapup.autoIdle saves the handoff.
  if (await idleCompactNow($, context)) {
    await log($, `before the cache goes cold: nothing to do, Claude Code compacts this session by itself 54 minutes after the last request (${context} tokens, at or above its idle-compact threshold)`)
    return
  }
  const tier = (await situation($)).tier
  const idle = idleCost(prices[tier], context)
  const cold = idle.resend
  const { whatsnext } = await neighbours($)
  let plan = coldPlan(coldMode, whatsnext)
  // A row the person did not set is the fixed keep warm: when keeping warm over the idle time this project usually shows
  // costs at least 3 times a compaction and its summary's cold read, compact instead. A row they set is theirs.
  if (!coldYours && plan.action === 'warm') {
    const estimate = idleEstimate(await idleGaps($))
    const v = compactWorth({ estimate, ttl: cacheTtl, ping: pingCost(prices[tier], context), compact: idle.compact, summaryCold: coldCost(prices, tier, COMPACT_SUMMARY_TOKENS) })
    await log($, `before the cache goes cold: expected idle ${idleFor(estimate)}; keeping warm ${money(v.keepWarm)} against a compaction and its summary ${money(v.cost)}: ${v.worth ? 'compact' : 'keep warm'}`)
    if (v.worth) plan = { action: 'compact' }
  }
  // The row acts only on a conversation big enough to matter, by the Idle warning amount (COLD_MIN while that is off), and
  // when its action saves something: its own cost taken off coming back cold.
  if (cold < (idleWarning ?? COLD_MIN)) return
  const net = netSaving(plan.action, { cold, ping: pingCost(prices[tier], context), compact: idle.compact })
  if (plan.action !== 'off' && net <= 0) {
    await log($, `before the cache goes cold: ${plan.action} skipped, it would cost ${money(cold - net)} against ${money(cold)} cold`)
    return
  }
  const task = (await currentTask($))?.id
  const turn: ColdTurn = { endedAt: lastTurnAt || (await $.clock.now()), context, tier, cold, whatsnext, ...(task ? { task } : {}), ends: {} }
  coldTurn = turn
  const gen = coldGen
  if (plan.action === 'warm') {
    // Until the usual start: to the next time the person usually sends their first prompt, at most 8 hours.
    const hours = (plan.hours ?? 8) * 60 * 60_000
    const ms = plan.untilStart ? Math.min(hours, nextStart(turn.endedAt, usualStart(runLog, await $.clock.now()).minutes).at - turn.endedAt) : hours
    await startWarm($, turn, ms, coldMode)
  } else if (plan.action === 'handoff' || plan.action === 'compact') {
    await log($, `before the cache goes cold: ${plan.action} ${Math.round(leadMs(cacheTtl) / 60_000)} min before it expires (${money(cold)} cold, ${Math.round(context / 1000)}K tokens on ${TIER_NAME[tier]})`)
    await armCold($, gen, turn.endedAt + cacheTtl - leadMs(cacheTtl), () => atCold($, turn, plan.action as 'handoff' | 'compact'))
  } else if (plan.action === 'ask') {
    // A cache of 1 hour or more has time: the offer waits, so it does not sit on the band while the person reads the answer.
    if (cacheTtl >= 60 * 60_000) await armCold($, gen, offerAt(turn.endedAt, cacheTtl), () => offerCold($, turn))
    else await offerCold($, turn)
  }
}

// The offer: the cache row shows when the cache goes cold and what coming back cold costs, with one button: the choice
// the person picked most often in their last 10 answered offers, else the first priced keep-warm choice (or the handoff
// or the compaction). The other choices are in the ⋯ menu, in a fixed order. After 3 of the same answer the row asks
// whether to make it a standing rule; after 5 offers with no answer, whether to stop offering. Nobody presses a button:
// nothing happens, and the cache goes cold.
async function offerCold($: EngineInterface, turn: ColdTurn) {
  if (bandMode === 'off') {
    await log($, 'before the cache goes cold: no offer, the band is off')
    return
  }
  const now = await $.clock.now()
  if (mainBusy) {
    await log($, 'before the cache goes cold: no offer, a turn is running')
    return
  }
  // The usage-limit advice is on the cache row: it says more about this session's cache than the offer would.
  if (((await $.state.get(BAND).catch(() => undefined))?.value?.coldMore ?? []).some(m => m.id === LIMIT_WHY_ID)) {
    await log($, 'before the cache goes cold: no offer, the usage-limit advice is on the band')
    return
  }
  if (turn.endedAt + cacheTtl <= now) {
    await log($, 'before the cache goes cold: no offer, the cache already went cold')
    return
  }
  const rates = billing === 'subscription' ? await windowPerDollar($) : undefined
  const ping = pingCost(prices[turn.tier], turn.context)
  const usual = usualStart(runLog, now)
  const warmChoices = keepWarmChoices({ ttl: cacheTtl, endedAt: turn.endedAt, cold: turn.cold, ping, startMinutes: usual.minutes, tag: d => (billing === 'subscription' && rates ? bandShareText(shareOf(d, rates)) : costTag(d, billing === 'subscription', rates)) })
  for (const c of warmChoices) if (c.endsAt !== undefined) turn.ends[c.id] = c.endsAt
  const args = { ttl: cacheTtl, endedAt: turn.endedAt, cost: coldCostText(turn.cold, rates), breakEven: breakEvenMs(turn.cold, ping, cacheTtl) }
  const text = offerText({ ...args, now })
  const all: ColdButton[] = [
    ...warmChoices.map(c => ({ id: c.id, label: c.label })),
    turn.whatsnext ? { id: 'handoff', label: 'Save a handoff' } : { id: 'compact', label: 'Compact now' },
    { id: 'let-go', label: 'Let it go cold' },
    { id: 'off', label: "Don't offer again" },
  ]
  const ids = all.map(c => c.id)
  const learned = learnedChoice(runLog, ids)
  const first = all.find(c => c.id === learned) ?? (all[0] as ColdButton)
  turn.offer = { text, first, more: all.filter(c => c !== first), args }
  // At most one question, each at most once: the back-off first, as a person who ignores the offer has no standing rule to make.
  const asked = await coldAsked($)
  const standing = standingChoice(runLog, ids, asked)
  if (ignoredLately(runLog) && !asked.includes(STOP_ASKED)) {
    turn.ask = { kind: 'stop' }
    await markAsked($, STOP_ASKED)
  } else if (standing) {
    turn.ask = { kind: 'always', choice: standing }
    await markAsked($, standing)
  }
  offerOpen = true
  await showOffer($, turn)
  // The cache goes cold with the offer unanswered: that is its outcome.
  await armCold($, coldGen, turn.endedAt + cacheTtl, () => closeOffer($, 'ignored'))
  await log($, `before the cache goes cold: offered ${warmChoices.map(c => c.id).join(', ') || 'no keep-warm time'}, button ${first.id}${learned ? ' (the one picked most)' : ''}${turn.ask ? `, asked ${turn.ask.kind === 'stop' ? 'whether to stop offering' : alwaysText(turn.ask.choice)}` : ''} (${money(turn.cold)} cold, ${Math.round(turn.context / 1000)}K tokens on ${TIER_NAME[turn.tier]}${usual.fallback ? `, usual start 9:00 by default, ${usual.days} days of runs` : ''})`)
}

/** Once a minute, from the 3-second timer: redraws the offer's line when its minute has changed. Not while a question is on the row. */
async function tickOffer($: EngineInterface) {
  const turn = coldTurn
  if (!offerOpen || !turn?.offer || turn.ask) return
  const text = offerText({ ...turn.offer.args, now: await $.clock.now() })
  if (text === turn.offer.text) return
  turn.offer.text = text
  await showOffer($, turn)
}

/** Puts the turn's offer on the cache row: its line and one button, or the question it asks instead. */
async function showOffer($: EngineInterface, turn: ColdTurn) {
  const o = turn.offer
  if (!o) return
  const yesNo: ColdButton[] = [{ id: 'ask-yes', label: 'Yes' }, { id: 'ask-no', label: 'No' }]
  if (turn.ask?.kind === 'always') await showCold($, alwaysText(turn.ask.choice), [...yesNo, o.first], true, o.more)
  else if (turn.ask?.kind === 'stop') await showCold($, 'Stop offering to keep the cache warm?', yesNo, true, [o.first, ...o.more])
  else await showCold($, o.text, [o.first], true, o.more)
}

/** The offers a question was already asked about, in the store: a choice's id, or `stop`. Each is asked once, whatever the answer. */
const COLD_ASKED = 'coldAsked'
const STOP_ASKED = 'stop'

async function coldAsked($: EngineInterface): Promise<string[]> {
  const v = await $.store.get(COLD_ASKED).catch(() => undefined)
  return Array.isArray(v) && v.every(x => typeof x === 'string') ? v : []
}

async function markAsked($: EngineInterface, key: string) {
  await $.store.set(COLD_ASKED, [...new Set([...(await coldAsked($)), key])]).catch(() => undefined)
}

/** The offer's outcome goes in the run log, once: the choice pressed, or `ignored`. After that the offer has none to give. */
async function closeOffer($: EngineInterface, picked: string) {
  if (!offerOpen) return
  offerOpen = false
  const line: RunLine = { at: new Date(await $.clock.now()).toISOString(), kind: 'cold', session: sessionId, choice: picked }
  await append($, 'runs.jsonl', JSON.stringify(line), RUNS_LOG_MAX)
  runLog.push(line)
}

/** What the run has used, in the band's one unit; undefined before the first request. */
const usedText = (w: Warming) => (w.pings === 0 && w.spent === 0 ? undefined : usedTag(w.spent, billing === 'subscription', w.rates))

/** The keep-warm status row: one Stop button; "Don't keep warm again" (the row set to off) waits in the ⋯ menu. Before the first request it shows the zero text in the band's unit. */
function showWarming($: EngineInterface, w: Warming) {
  const text = warmingText({ until: w.until, used: usedText(w) ?? (billing === 'subscription' ? '~0% used' : '$0.00') })
  const stop = { id: 'stop', label: 'Stop keeping warm' }
  const off = { id: 'off', label: "Don't keep warm again" }
  const n = w.note
  return n ? showCold($, `${n.text} ${text}`, [n.button, stop], true, [...n.more, off]) : showCold($, text, [stop], true, [off])
}

/**
 * Puts advice on the cache row. While keep warm runs it joins that row (keep warm goes on, and Stop stays); a run that already
 * carries advice, or an offer up, keeps the row, and the advice waits for a later turn's end. False when it was not shown.
 */
async function showAdvice($: EngineInterface, note: CacheNote): Promise<boolean> {
  if (coldTurn?.offer) return false
  if (warming) {
    if (warming.note) return false
    warming.note = note
    await showWarming($, warming)
    return true
  }
  await showCold($, note.text, [note.button], true, [...note.more])
  return true
}

/** Takes advice off the cache row: off the keep-warm row while it runs, else the whole row. */
async function clearAdvice($: EngineInterface) {
  if (warming?.note) {
    warming.note = undefined
    await showWarming($, warming)
    return
  }
  await clearColdRow($)
}

/** The keep-warm run ends: `what` is the band's last word on it, without a full stop. */
async function endWarm($: EngineInterface, w: Warming, what: string) {
  if (warming === w) {
    warming = null
    stopColdTimer()
  }
  await showCold($, warmEndText(what, usedText(w)))
}

/** Writes one `warm` line to the run log: the report counts its cost as rightsize's own, so it lowers Total saved. It carries the task the cache belongs to, whose total counts it. */
async function logWarm($: EngineInterface, c: ColdTurn, cost: number) {
  const line: RunLine = { at: new Date().toISOString(), kind: 'warm', session: sessionId, ...(c.task ? { task: c.task } : {}), warmRun: new Date(c.endedAt).toISOString(), tier: c.tier, context: c.context, overhead: round(cost) }
  await append($, 'runs.jsonl', JSON.stringify(line), RUNS_LOG_MAX)
  runLog.push(line)
}

/**
 * The person's returning prompt arrived at `now`: when keep warm earned it (warm.ts warmReturned), the prompt's first request
 * is checked next (settleWarm). Any other prompt clears the check. Called before the run is cancelled.
 */
async function noteReturn($: EngineInterface) {
  const c = coldTurn
  warmReturn = c && warmReturned({ now: await $.clock.now(), endedAt: c.endedAt, lastWarmAt, ttl: cacheTtl }) ? c : null
}

/**
 * The first request of a prompt that came back to a kept-warm cache: it must have read at least ~80% of the kept conversation
 * from the cache. Then one `warmSaved` line records what coming back cold would have cost (the requests stay their own cost
 * lines); otherwise the log says the cache missed and nothing is saved.
 */
async function settleWarm($: EngineInterface, c: ColdTurn, u: Usage) {
  if (!cacheHeld(u.cache_read_input_tokens, c.context)) {
    await log($, `keep warm: the cache missed on return (the first request read ${u.cache_read_input_tokens} of ${c.context} tokens), so no saving is counted`)
    return
  }
  const line: RunLine = { at: new Date().toISOString(), kind: 'warmSaved', session: sessionId, ...(c.task ? { task: c.task } : {}), tier: c.tier, context: c.context, saved: round(c.cold) }
  await append($, 'runs.jsonl', JSON.stringify(line), RUNS_LOG_MAX)
  runLog.push(line)
  await log($, `keep warm: the cache held on return (read ${u.cache_read_input_tokens} of ${c.context} tokens); coming back cold would have cost ${money(c.cold)}`)
  // The band's session total counts it now.
  const band = (await $.state.get(BAND).catch(() => undefined))?.value
  if (band) await setBand($, band)
}

// Keeps the cache warm for `ms` after the turn ended: one request through $.model.fork each (cache life - lead), which
// re-reads the conversation from the cache and so refreshes it. Never past the point where the requests cost more than
// coming back cold.
async function startWarm($: EngineInterface, c: ColdTurn, ms: number, how: string) {
  const ping = pingCost(prices[c.tier], c.context)
  const plan = warmPlan({ ms, ttl: cacheTtl, cold: c.cold, ping, endedAt: c.endedAt })
  if (plan.capped) await log($, `keep warm capped at ${plan.pings} ping${plan.pings === 1 ? '' : 's'}: more would cost more than coming back cold (${money(c.cold)})`)
  if (plan.pings < 1) {
    await log($, `keep warm not started: one request costs more than coming back cold (${money(ping)} against ${money(c.cold)})`)
    return
  }
  const gen = ++coldGen
  const w: Warming = { until: plan.endsAt, pings: 0, spent: 0, rates: billing === 'subscription' ? await windowPerDollar($) : undefined }
  warming = w
  await log($, `keeping warm until ${clockText(plan.endsAt)} (${how}): ${plan.pings} request${plan.pings === 1 ? '' : 's'} planned, about ${money(plan.cost)}, one every ${Math.round(pingEvery(cacheTtl) / 60_000)} min`)
  await showWarming($, w)
  await armPing($, gen, c, w, 1, plan.pings)
}

/** Arms the timer for ping `k` of `count`: the first is one cache life less the lead after the turn ended, and each one arms the next. */
function armPing($: EngineInterface, gen: number, c: ColdTurn, w: Warming, k: number, count: number) {
  return armCold($, gen, c.endedAt + k * pingEvery(cacheTtl), () => sendPing($, gen, c, w, k, count))
}

// Ping `k` of `count`, when its timer fires. A turn running keeps the cache warm itself, and its end starts the next round.
async function sendPing($: EngineInterface, gen: number, c: ColdTurn, w: Warming, k: number, count: number) {
  try {
    if (mainBusy) {
      await log($, 'keep warm skipped: a turn is running')
      if (warming === w) warming = null
      return
    }
    const r = await $.model.fork({ prompt: PING_PROMPT }).catch((err: unknown) => ({ isAnswered: false as const, reason: `error: ${err instanceof Error ? err.message : String(err)}`, usage: undefined }))
    const usage = 'usage' in r ? r.usage : undefined
    // A request that came back with no usage still read the conversation from the cache.
    const cost = r.isAnswered || usage ? pingCost(prices[c.tier], c.context, usage) : 0
    w.pings += r.isAnswered ? 1 : 0
    w.spent += cost
    if (r.isAnswered || cost > 0) await logWarm($, c, cost)
    if (r.isAnswered) lastWarmAt = await $.clock.now()
    if (gen !== coldGen) return
    if (!r.isAnswered) {
      const why = 'status' in r ? `${r.reason}${r.status === null ? '' : ` ${r.status}`}, ${r.error}` : r.reason
      await log($, `keep warm stopped: the request failed (${why})`)
      await endWarm($, w, 'Stopped keeping warm: a request failed')
      return
    }
    // The planned last request may end a little over: it is the end anyway. Before it, a run that costs more than planned stops.
    if (k < count && w.spent >= c.cold) {
      await log($, `keep warm stopped: ${money(w.spent)} spent, as much as coming back cold`)
      await endWarm($, w, 'Stopped keeping warm: it cost as much as coming back cold')
      return
    }
    if (k < count) {
      await showWarming($, w)
      await armPing($, gen, c, w, k + 1, count)
      return
    }
    await log($, `keep warm ended at ${clockText(w.until)}: ${pingsText(w.pings)}, ${money(w.spent)}`)
    await endWarm($, w, `Kept the cache warm until ${clockText(w.until)}`)
  } catch (err) {
    await log($, `keep warm failed: ${err instanceof Error ? err.message : String(err)}`)
    if (gen === coldGen && warming === w) warming = null
  }
}

// Before expiry: the handoff or the compaction, once. Not while a turn runs.
async function atCold($: EngineInterface, c: ColdTurn, action: 'handoff' | 'compact') {
  try {
    if (mainBusy) {
      await log($, `${action} skipped: a turn is running`)
      return
    }
    await (action === 'handoff' ? saveHandoff($, c) : compactNow($))
  } catch (err) {
    await log($, `${action} failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// whatsnext's skill answers "wrap up" with its wrap-up flow. The prompt is rightsize's own: rated by nobody, and its
// hook lets it through. Without whatsnext (or in a project it was not started in) it is a compaction.
async function saveHandoff($: EngineInterface, c: ColdTurn) {
  if (!c.whatsnext) return compactNow($)
  coldDone = true
  coldPrompt = WRAP_UP
  try {
    const sent = await $.prompt.submit({ text: WRAP_UP })
    if (sent.drop !== undefined) {
      await log($, `handoff: "${WRAP_UP}" was refused (${sent.drop})`)
      return
    }
    await log($, `handoff: submitted "${WRAP_UP}" to whatsnext before the cache went cold`)
    await showCold($, 'Saved a handoff with whatsnext before the cache went cold.')
  } catch (err) {
    await log($, `handoff failed: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    coldPrompt = null
  }
}

async function compactNow($: EngineInterface) {
  coldDone = true
  try {
    const own = async () => {
      const skip = await ownCompact($)
      if (skip !== undefined) {
        await log($, `compact skipped: ${skip}`)
        return
      }
      // The conversation is small now: the idle question would quote the old size.
      idleWarnedFor = lastTurnAt
      await log($, 'compact: compacted before the cache went cold')
      await showCold($, 'Compacted while the cache was warm.')
    }
    if ((await whatsnextInstalled($)) !== true) return await own()
    await compactWithWhatsnext($, {
      label: 'compact',
      compacted: async noFresh => {
        idleWarnedFor = lastTurnAt
        await log($, `compact: compacted with whatsnext before the cache went cold${noFresh ? ` (${NO_FRESH_HANDOFF})` : ''}`)
        await showCold($, withHandoffNote('Compacted while the cache was warm.', noFresh))
      },
      fallback: own,
    })
  } catch (err) {
    await log($, `compact failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// A band button. Offer buttons act on the turn that ended; the cache is still warm, so a handoff or a compaction runs
// right away, and a keep-warm time counts from the turn's end. Each answer to an offer goes in the run log.
async function pressCold($: EngineInterface, id: string): Promise<void> {
  if (isLimitId(id)) return pressLimit($, id)
  if (isSizeId(id)) return pressSize($, id)
  if (id === 'stop') {
    const w = warming
    cancelCold($, 'Stop pressed')
    if (w) await showCold($, warmEndText('Stopped keeping warm', usedText(w)))
    return
  }
  if (id === 'ask-yes' || id === 'ask-no') return answerAsk($, id === 'ask-yes')
  await closeOffer($, id)
  if (id === 'off') {
    cancelCold($, 'turned off')
    await putConfig($, 'beforeCold', 'off')
    await setBand($, null)
    $.ui.toast('Rightsize: Before the cache goes cold is now "off". It is the row in /config; set it back any time.')
    await log($, 'before the cache goes cold: turned off from the band; saved as your setting')
    return
  }
  if (id === 'let-go') {
    cancelCold($, 'let it go cold')
    await setBand($, null)
    await log($, 'before the cache goes cold: let it go cold')
    return
  }
  const c = coldTurn
  if (c) await runCold($, c, id)
}

/** A keep-warm time, the handoff or the compaction, for the offered turn `c`. */
async function runCold($: EngineInterface, c: ColdTurn, id: string) {
  cancelCold($, 'a new choice')
  if (id === 'handoff' || id === 'compact') {
    await setBand($, null)
    await (id === 'handoff' ? saveHandoff($, c) : compactNow($))
    return
  }
  const end = c.ends[id]
  if (end === undefined) return
  if ((await $.clock.now()) - c.endedAt >= cacheTtl) {
    $.ui.toast('Rightsize: the cache already went cold, so there is nothing to keep warm.')
    await setBand($, null)
    return
  }
  await startWarm($, c, end - c.endedAt, `button ${id}`)
}

// Yes or No to the question on the cache row. Yes to "Always …?" writes the choice to its /config row, with what a
// change in /config does, and does it for this offer too. Yes to stopping is Don't offer again. No drops the question and
// leaves the offer; neither question is asked again.
async function answerAsk($: EngineInterface, yes: boolean): Promise<void> {
  const c = coldTurn
  const ask = c?.ask
  if (!c || !ask) return
  c.ask = undefined
  if (!yes) {
    await log($, `before the cache goes cold: answered No to ${ask.kind === 'stop' ? 'stop offering' : alwaysText(ask.choice)}`)
    await showOffer($, c)
    return
  }
  if (ask.kind === 'stop') return pressCold($, 'off')
  const value = ROW_OF[ask.choice] ?? ''
  await closeOffer($, ask.choice)
  await changeRow($, 'beforeCold', value)
  $.ui.toast(`Rightsize: Before the cache goes cold is now "${value}". It is the row in /config; set it back any time.`)
  await log($, `before the cache goes cold: answered Yes to ${alwaysText(ask.choice)}; saved as your setting`)
  await runCold($, c, ask.choice)
}

const APPROVAL_DENY =
  'rightsize: a hand-off subagent cannot push, publish, release, deploy or send, because a message from the main chat is not the person\'s approval. Stop before this step and report what is ready; the main chat does it.'

const HELPER_RETURN =
  'rightsize: stop now. You are stuck, and this task\'s retry budget is used up, so more effort or more tries will not help. Do not make more tool calls: report what you tried, what failed, and where you are stuck. The main chat takes it from here.'
const capReturn = (cap: number) =>
  `rightsize: stop now. You have used the ${cap} tool calls this task allows a helper. Do not make more tool calls: report what you did, what is left and where you are. The main chat takes it from here.`
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

/** How many of the task's chances are used, from the stored value; a task that has none recorded has used none. */
function usedOf(v: { task: string; used: number } | null | undefined, task: string): number {
  return v && v.task === task ? v.used : 0
}

/** Uses one of the task's chances; false when none is left. Calls run one after another, so two at once cannot spend the same chance. */
async function useChance($: EngineInterface, task: string): Promise<boolean> {
  const before = spending
  let release: () => void = () => undefined
  spending = new Promise<void>(unlock => {
    release = unlock
  })
  try {
    await before.catch(() => undefined)
    const stored = await $.state.get(RETRIES).catch(() => undefined)
    const used = usedOf(stored?.value, task)
    if (used >= chances) return false
    await $.state.set(RETRIES, { task, used: used + 1 }).catch(() => undefined)
    return true
  } finally {
    release()
  }
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
    w = { kind: 'handoff', run: run.id, task: run.task, level: run.delegate.level, rated: run.rating.steps, signals: noSignals(), steps: 0, startedAt, blocked: 0, raises: [], calls: 0, ...(run.delegate.dir === 'down' ? { tier: run.delegate.tier } : {}) }
  } else if (sized) {
    const task = sized.task ?? (await currentTask($))?.id ?? sessionId
    w = { kind: 'moved', ...(sized.run ? { run: sized.run } : {}), task, level: sized.level, rated: sized.steps ?? 5, signals: noSignals(), steps: 0, startedAt, blocked: 0, raises: [], calls: 0, tier: sized.tier }
  }
  const raced = watches.get(id)
  if (raced) return raced
  if (w) watches.set(id, w)
  return w
}

/** What the log keeps of a watched helper. `ms` runs to its answer, or to now while it has not answered. */
const helperLine = (w: Watch, now: number): HelperLine => ({
  steps: w.steps,
  calls: w.calls,
  ms: w.ms ?? Math.max(0, now - w.startedAt),
  errors: Object.values(w.signals.calls).reduce((n, c) => n + c.errors, 0),
  blocked: w.blocked,
  ...(w.stall ? { stall: w.stall } : {}),
  ...(w.raises.length ? { raises: w.raises } : {}),
  ...(w.returned ? { returned: true as const } : {}),
  ...(w.capped ? { capped: w.capped } : {}),
})

// A helper's tool call, after it ran. An error from the environment is a Blocked stall: more effort
// would not fix it, so it is counted apart and is not a sign. A refused call says nothing about the work.
async function noteHelperCall($: EngineInterface, id: string, w: Watch, e: Record<string, unknown>, result: unknown) {
  const r = result as { deny?: string; isError?: boolean }
  if (r.deny) return
  const isError = r.isError === true
  if (isError && refusedByPerson(errorText(result))) return
  if (isError && blockedError(errorText(result))) {
    w.blocked += 1
    if (w.stall !== 'struggling') w.stall = 'blocked'
    if (w.blocked === 1) await log($, `helper ${id} blocked by the environment: more effort will not help`)
    return
  }
  const tool = String(e.tool)
  w.signals = noteCall(w.signals, callKey(tool, e), isError, isTestCommand(tool, e), isEditTool(tool))
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
  // Only the settings you set in /config or answered: the rest are defaults, and /config shows them.
  const changed: string[] = []
  const cur = inUse(cfg, yours, askFirst)
  for (const key of KEYS) {
    const rule = RULE_IDS.find(r => RULE_KEYS[r] === key)
    if (rule) {
      if (c[rule] !== undefined) changed.push(`  ${plainTitle(SETTINGS[key].title)}: ${ruleLabel(rule, c[rule])}`)
    } else if (key === 'billing' ? billingYours() : yours.has(key)) changed.push(`  ${plainTitle(SETTINGS[key].title)}: ${cfg[key]}`)
  }
  const n = changed.length
  return [
    // Claude Code shows the output under "rightsize:", so the line leaves the name out.
    `Ask before changing: ${askFirst ? 'on' : 'off'}${legacyQuality && !yours.has('askFirst') ? ' (from your old Quality profile)' : ''}`,
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
    ...(manualPause ? [`  Paused: ${pauseStatus(manualPause).replace(/^Rightsize paused /, '')}`] : []),
    ...(billingYours() ? [] : [`  Reports: ${billing} (${billingBy ?? 'default'})`]),
    ...(billingYours() && detectedBilling && detectedBilling !== billing ? [`  Rate limits look like ${sees}; Reports is set to ${billing} by you.`] : []),
    ...(pacing && paceText(true) ? [`  ${paceText(true)}`] : []),
    `  Measured runs: ${runs}`,
    ...(sw ? [`  Effort switches that missed the cache: ${Math.round(sw.ratio * 100)}% of ${sw.n} (each one in ~/.claude/mods-logs/rightsize/<session>/switches.jsonl)`] : []),
    `  Mode: ${watching ? 'watch only (rates and plans every prompt, changes nothing; Mode in /config turns it on)' : 'act'}`,
    `  Features: Routing ${routing ? 'on' : 'off'} · Hand-offs ${handOffs ? 'on' : 'off'} · Cache ${cacheOn ? 'on' : 'off'}`,
    '',
    'Commands: /rightsize help',
  ].join('\n')
}

// ---- Settings pane -------------------------------------------------------------------

// Bare /rightsize opens a pane that lists every row of /config, in the table's order, each a picker. A pick takes effect
// at once, as a change in /config does. Where no pane can be drawn (none placed, or the mobile app, which has no picker
// element), a loop of questions does the same: pick a row, pick its value, back to the rows.

const MENU_ID = 'rightsize-menu'
const MENU = { plugin: 'rightsize', key: 'menu' } as const
let menuTicks = 0

/** The pane draws again: it reads this key while it draws, so a write to it is a redraw. */
async function bumpMenu($: EngineInterface) {
  menuTicks += 1
  await $.state.set(MENU, menuTicks).catch(() => undefined)
}

/** A row is yours when you set it or answered it; Reports also when its question was answered. Every other row is on its default. */
const rowYours = (key: SettingKey) => (key === 'billing' ? billingYours() : yours.has(key))

/** The row's picker in the pane: "Lowest effort (yours)" or "Lowest effort (default)", then its value. */
const rowLabel = (key: SettingKey) => `${plainTitle(SETTINGS[key].title)} (${rowYours(key) ? 'yours' : 'default'})`

/** A change made in the pane or the loop: the row is written as yours and followed, then the pane draws the new values. */
async function setFromMenu($: EngineInterface, key: SettingKey, value: string) {
  if (!inOptions(key, value)) return
  await changeRow($, key, value)
  await bumpMenu($)
}

/**
 * The words of /rightsize: opens the pane, or, with none to open, asks. Every surface is the mobile app, or the pane
 * is not placed: the questions.
 */
async function openSettings($: EngineInterface) {
  const surfaces = await $.session.surfaces().catch(() => [])
  if (surfaces.length === 0 || !surfaces.every(x => x === 'mobile')) {
    const opened = await $.ui.open({ id: MENU_ID, title: 'Rightsize', focus: true, closeOnEscape: true, holdToasts: true }).catch(() => undefined)
    if (opened?.isPlaced) return 'Rightsize settings are open in a pane. A change takes effect at once. Esc closes it.'
    // An unplaced pane stays open and undrawn: close it, so it does not appear later on its own.
    if (opened) await $.ui.close({ id: MENU_ID }).catch(() => undefined)
  }
  return askSettings($)
}

/** The fallback: "Setting: value" rows, then the row's values, until Done or a dismissed question. */
async function askSettings($: EngineInterface) {
  const changed: string[] = []
  for (;;) {
    const asking: Question<SettingKey | 'done'> = { header: 'Setting', question: 'Which setting? A change takes effect at once.', options: [['Done', 'done'], ...KEYS.map(k => [`${plainTitle(SETTINGS[k].title)}: ${cfg[k]}`, k] as const)] }
    const rows = await pickFrom($, asking, 'Setting', 'More rows')
    if (rows === undefined || rows === 'done') break
    const key = rows
    const title = plainTitle(SETTINGS[key].title)
    const value = await pickFrom(
      $,
      { header: 'Value', question: `${title}: now ${cfg[key]} (${rowYours(key) ? 'yours' : 'default'}).`, options: SETTINGS[key].options.map(o => [o === cfg[key] ? `${o} (current)` : o, o] as const) },
      'Value',
      'More values',
    )
    if (value === undefined || value === cfg[key]) continue
    await setFromMenu($, key, value)
    changed.push(`${title}: ${value}`)
  }
  return changed.length ? `Changed ${changed.join('; ')}.` : 'No setting changed.'
}

// ---- Help --------------------------------------------------------------------------

const COMMANDS: readonly (readonly [string, string])[] = [
  ['', 'open the settings pane: change any setting, and see which you set'],
  ['status', 'show your changed settings and current state'],
  ['settings', 'answer the questions again'],
  ['report', 'what it saved and what went wrong'],
  ['retry', 're-run the last auto-lowered prompt at the original effort'],
  ['clear', 'drop the session switch'],
  ['resume', 'start changing the model and effort again, after you stepped up and rightsize paused'],
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
  const rule = RULE_IDS.some(r => RULE_KEYS[r] === what) ? ' The default decides that case again.' : ''
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
  const fix = `To reset ${blocked.length === 1 ? 'it' : 'them'}, run this in a terminal, then restart Claude Code: claude plugin configure rightsize@archid21 --values-stdin <<< '${json}'`
  const done = all && blocked.length < keys.length ? 'The other settings are back to their defaults, and the saved answers are forgotten. ' : ''
  return `${done}${names} could not be changed from here. ${fix}`
}

// Cost measurement starts over: the calibration, the close-call and spot-check counts and the start checks go,
// and the run log before now teaches rightsize nothing. The log itself, and the report's history, stay.
async function resetMeasurement($: EngineInterface) {
  await saving.catch(() => undefined)
  cal = {}
  unsaved = []
  stepState = NO_STEPS
  unsavedSteps = []
  for (const key of [CAL_STORE, STEP_STORE, TIES_STORE, SPOT_STORE, 'startCheckedAt', 'startSnooze']) await $.store.set(key, null).catch(() => undefined)
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

// ---- Starting point ----------------------------------------------------------

// Once a week at session start, replay the last 30 days of rated prompts from each
// starting model and level; when another start is clearly better, the band says so.
// rightsize never changes the default model itself: the person switches with /model.

const DAY_MS = 24 * 60 * 60_000

async function startContext($: EngineInterface) {
  return { prices, cal, rules, floor, choices: await choices($), ceiling, without, from: measureFrom }
}

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

/** The day-one tip is shown once per install; the store remembers it. */
const DAY_ONE_KEY = 'startDayOne'

// On the first session on an Opus start, before the log can say anything (fewer than START_MIN_PROMPTS rated prompts),
// the band gives the research-backed recommendation once: start on Sonnet 5.5 at medium. The weekly check (checkStart)
// confirms or reverses it later from the person's own log. rightsize never switches the model itself.
async function dayOneTip($: EngineInterface) {
  if (off || startEvery === null || bandMode === 'off') return
  if ((await $.store.get(DAY_ONE_KEY).catch(() => undefined)) === true) return
  if (runLog.filter(l => (l.kind ?? 'run') === 'run').length >= START_MIN_PROMPTS) return
  const s = await situation($)
  if (s.tier !== 'opus') return
  await $.store.set(DAY_ONE_KEY, true).catch(() => undefined)
  const text = `Starting tip: most work runs as well on Sonnet 5.5 at medium for well under half the usage of ${TIER_NAME[s.tier]}. Reviews still run on Opus, and work Sonnet would struggle with goes to a stronger helper. Switch with /model sonnet.`
  await log($, 'day-one start tip shown: Sonnet 5.5 at medium')
  await setBand($, { text, acted: true, tip: 'sonnet:medium', tipSwitch: '/model sonnet' })
}

/** The tip's Switch button: puts the command in the prompt box; the person presses Enter. */
async function fillSwitch($: EngineInterface, cmd: string) {
  const filled = await $.prompt.fill({ text: cmd, mode: 'replace' }).catch(() => null)
  await setBand($, null)
  $.ui.toast(filled?.isFilled ? `Rightsize: press Enter to run ${cmd}.` : `Rightsize: could not fill the prompt box; type ${cmd}.`)
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

// Sets what the fixed values govern, each replaced by its row where the row is yours, and the questions' first
// options from Ask before changing. It runs again whenever one of those rows or `yours` changes, so a change in
// /config applies at once. A Quality profile stored by an older release reads as Ask before changing on, until the row is yours.
function applyFixed() {
  askFirst = yours.has('askFirst') ? askFirstOn(cfg.askFirst) : askFirstOn(cfg.askFirst) || legacyQuality
  const u = inUse(cfg, yours, askFirst)
  rules = { handOff: u.handOff, lower: parseShare(cfg.lowering, DEFAULT_RULES.lower) }
  missBlock = u.maxMiss
  minTasks = u.minTasks
  spotEvery = u.raterEvery
  chances = u.chances
  answers = u.answers
  coldMode = u.beforeCold
  coldYours = yours.has('beforeCold')
  reviewCeiling = u.reviewCeiling
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
    case 'mode':
      watching = watchOnly(v)
      return
    case 'routing':
      routing = v !== 'off'
      return
    case 'handOffs':
      handOffs = v !== 'off'
      return
    case 'cache':
      cacheOn = v !== 'off'
      return
    case 'askFirst':
    case 'handOff':
    case 'lowering':
    case 'missPause':
    case 'raterCheck':
    case 'beforeCold':
      applyFixed()
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
    case 'helperCap':
      if (isCapSetting(v)) callCap = v
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
    case 'questionWait':
      if (isQuestionWait(v)) questionWait = v
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
    case 'beforeCold':
      // The row changed: what was waiting or pinging under the old value stops. The next big turn's end follows the new one.
      cancelCold($, 'Before the cache goes cold changed')
      coldTurn = null
      return
    case 'cache':
      // Cache off: a keep-warm run, a waiting offer and a timed handoff or compaction stop at once, and the Cache row goes. Back on, the next big turn's end follows it.
      if (value === 'off') await dropCache($, 'Cache turned off')
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

// ---- Manual step up: rightsize holds ------------------------------------------

// When the person steps up (a stronger model with /model, or a higher effort with /effort), they have said what this work needs.
// Rightsize then changes neither until they resume: no rating, no plan, no hand-off, no effort change, no review switch, no
// mid-turn raise, and no subagent moved to another model. Cost tracking, the report, keep-warm and the context and usage-limit
// warnings go on. A held prompt claims no saving and teaches no calibration: it has no run.
// A step down never pauses: rightsize plans from the new base.
//
// Order: models by tierRank, effort by levelRank. Two detections:
//  - Model, at prompt.submit before the rating (manualCheck): the model in use now ($.session.model()) against `seenModel`, the model
//    of the last main-chat step that was not rightsize's own review switch. An empty seenModel (a new session, or one started with
//    --model) is no switch, and neither is the review switch itself: it never reaches seenModel and does not change /model.
//  - Effort, on the first main-chat step of a turn (noteEffort): the engine gives a hook no read of the person's effort at prompt time
//    (settings.effortLevel is only the saved default: /effort max, --effort and a model's own default are not in it), and the effort
//    that arrives on a step is the engine's setting before rightsize rewrites it. So the person's effort is read there, against
//    `personEffort` (the first step of the last turn). That prompt has been rated by then: the pause drops its run (logged as
//    dropped, its rating cost counted as overhead), and nothing of it is applied from that step on. The hand-off note a plan may have
//    added to the prompt cannot be taken back. Following prompts are held at prompt.submit, as for a model.
// An effort that moved only because the model changed, to that model's default level, is not the person's step.

const PAUSE = { plugin: 'rightsize', key: 'manualPause' } as const
const HOLD_NOTE = "Rightsize won't change the model or effort until you resume."

function pauseText(p: ManualPause) {
  return p.by === 'model' && p.model ? `Paused: you switched to ${TIER_NAME[p.model]}. ${HOLD_NOTE}` : `Paused: you raised effort to ${p.effort}. ${HOLD_NOTE}`
}

function pauseStatus(p: ManualPause) {
  return `Rightsize paused (${p.by === 'model' && p.model ? `you picked ${TIER_NAME[p.model]}` : `you raised effort to ${p.effort}`}) · /${CMD} resume`
}

/** The person is back at the model and the effort they had before the pause, or below them (what is not known counts as back). */
function backDown(p: ManualPause, model: Tier | undefined, effort: Level | undefined) {
  const modelOk = !p.fromModel || !model || tierRank(model) <= tierRank(p.fromModel)
  const effortOk = !p.fromEffort || !effort || levelRank(effort) <= levelRank(p.fromEffort)
  return modelOk && effortOk
}

async function seenTier($: EngineInterface) {
  const v = (await $.state.get({ plugin: 'rightsize', key: 'seenModel' }).catch(() => undefined))?.value
  return tierOf(typeof v === 'string' ? v : undefined)
}

/** Starts the pause, or moves a running one up to what the person stepped to now (the model and effort before the first step stay). */
async function holdFor($: EngineInterface, now: ManualPause, why: string) {
  manualPause = now
  pauseRow = pauseText(now)
  await $.state.set(PAUSE, now).catch(() => undefined)
  await log($, `paused: ${why}; no rating, plan, effort change, switch or subagent move until the person resumes`)
}

/** Rightsize takes over again, from the person's model and effort now: the last seen model and effort are set to them, so the resume does not read as a step. */
async function resumeRightsize($: EngineInterface, how: 'asked' | 'back') {
  const was = manualPause
  if (!was) return 'Rightsize is not paused.'
  manualPause = null
  pauseRow = null
  await $.state.set(PAUSE, null).catch(() => undefined)
  const live = await $.session.model().catch(() => undefined)
  if (typeof live === 'string' && live) await $.state.set({ plugin: 'rightsize', key: 'seenModel' }, live).catch(() => undefined)
  // A session switch from before the pause would stand over the person's effort as the base.
  await $.state.set({ plugin: 'rightsize', key: 'sessionEffort' }, null).catch(() => undefined)
  lastApplied = undefined
  lastSwitched = false
  const band = (await $.state.get(BAND).catch(() => undefined))?.value
  if (band?.canResume) await setBand($, null)
  await showStatus($)
  await log($, how === 'back' ? 'resumed: the person is back at the model and effort they had before the pause' : 'resumed: the person asked')
  if (how === 'back') await $.ui.toast('Rightsize resumed: you switched back.')
  return 'Rightsize resumed.'
}

/** At a prompt, before any rating. Resumes when the person is back down; pauses when the model is stronger than the last step's. Says whether rightsize is held for this prompt, and whether the pause row shows now. */
async function manualCheck($: EngineInterface): Promise<{ held: boolean; row: boolean }> {
  const live = tierOf(await $.session.model().catch(() => undefined))
  const seen = await seenTier($)
  const effort = (await personEffort($)) ?? undefined
  if (manualPause && backDown(manualPause, live, effort)) await resumeRightsize($, 'back')
  if (!live || !seen || tierRank(live) <= tierRank(seen)) return { held: manualPause !== null, row: false }
  const was = manualPause
  const fromEffort = was ? was.fromEffort : effort
  const now: ManualPause = {
    model: live,
    ...(effort ? { effort } : was?.effort ? { effort: was.effort } : {}),
    fromModel: was?.fromModel ?? seen,
    ...(fromEffort ? { fromEffort } : {}),
    at: await $.clock.now(),
    by: 'model',
  }
  await holdFor($, now, `the person switched to ${TIER_NAME[live]} from ${TIER_NAME[was?.fromModel ?? seen]}`)
  return { held: true, row: true }
}

/** The first main-chat step of a turn: reads the person's effort, and pauses or resumes rightsize by it. */
async function noteEffort($: EngineInterface, now: Level, model: string | undefined): Promise<void> {
  const prev = await personEffort($)
  await $.state.set({ plugin: 'rightsize', key: 'personEffort' }, now).catch(() => undefined)
  if (off || (!routing && !handOffs)) return
  const live = tierOf(await $.session.model().catch(() => undefined))
  const seen = await seenTier($)
  const stepModel = tierOf(model)
  const byDefault = seen !== undefined && stepModel !== undefined && stepModel !== seen && now === DEFAULT_LEVEL[stepModel]
  const raised = prev !== null && levelRank(now) > levelRank(prev) && !byDefault
  const was = manualPause
  if (!raised) {
    if (was && backDown(was, live, now)) await resumeRightsize($, 'back')
    return
  }
  const next: ManualPause = {
    effort: now,
    ...(live ? { model: live } : {}),
    ...(was ? (was.fromModel ? { fromModel: was.fromModel } : {}) : live ? { fromModel: live } : {}),
    fromEffort: was?.fromEffort ?? prev,
    at: await $.clock.now(),
    by: 'effort',
  }
  await holdFor($, next, `the person raised effort from ${prev} to ${now}`)
  await setBand($, { text: pauseText(next), acted: true })
  await showStatus($)
}

/** A run rated before the person's step up showed: it is dropped, and nothing of it applies. */
async function dropForPause($: EngineInterface, run: Run) {
  if (active === run) active = null
  pending = pending.filter(r => r !== run)
  if (lastAuto) lastAuto = null
  await log($, `prompt dropped (the person stepped up, rightsize is paused): its rating cost counts as overhead`)
  const line: RunLine = { at: new Date().toISOString(), kind: 'dropped', id: run.id, session: sessionId, task: run.task, reason: 'the person stepped up', overhead: round(run.overhead) }
  await append($, 'runs.jsonl', JSON.stringify(line), RUNS_LOG_MAX)
}

export const register: Register = (on, options) => {
  declared = (options ?? {}) as Record<string, unknown>
  cfg = valuesOf(declared)
  for (const key of KEYS) applyOption(key)

  // Every setting takes effect the moment /config changes it, not at the next start. A change
  // by the person marks the row as theirs (settings.ts), so rightsize's own behaviour leaves it be.
  // One hook for all rows: it passes on every event that is not one of rightsize's own rows.
  on('config.set', async ($, e, next) => {
    const name = e.key.startsWith('rightsize.') ? e.key.slice('rightsize.'.length) : ''
    const key = KEYS.find(k => k === name)
    if (key === undefined) return next(e)
    const result = await next(e)
    if (result.deny !== undefined || !inOptions(key, result.value)) return result
    cfg = { ...cfg, [key]: result.value }
    yours = afterSet(yours, e.key, result.value, e.origin)
    if (yours.has(key)) await forgetReset($, key)
    applyOption(key)
    await followRow($, key, result.value)
    await bumpMenu($)
    return result
  }).catch((_, e, next) => next(e))

  // Claude Code's idle auto-compact: the engine's own compaction (trigger `auto`) after an idle gap of 50 minutes or more, between
  // turns. The person's /compact and a plugin's compact are not it; they only say the drop in context that follows is not one.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (off || e.agentId !== undefined || result.skip !== undefined) return result
    if (e.trigger === 'manual' || e.trigger === 'plugin') {
      manualCompact = true
      return result
    }
    if (e.trigger !== 'auto' || mainBusy || !lastTurnAt || manualCompact || (await $.clock.now()) - lastTurnAt < COMPACT_GAP_MIN) return result
    const after = result.tokensAfter ?? (await usageNow($))?.context?.tokens
    await noteCompacted($, result.tokensBefore ?? lastContext, typeof after === 'number' && after > 0 ? after : undefined)
    return result
  }).catch((_, e, next) => next(e))

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    // The plugin can live anywhere (a clone, ~/Projects), so ask for HOME rather than reading it off the path.
    const fromEnv = await $.env.get('HOME').catch(() => undefined)
    const root = $.plugin.root
    pluginRoot = root
    home = fromEnv || (root.split('/.claude/')[0] ?? '')
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
    manualPause = null
    pauseRow = null
    effortTurn = undefined
    await $.state.set(PAUSE, null).catch(() => undefined)
    await $.state.set({ plugin: 'rightsize', key: 'personEffort' }, null).catch(() => undefined)
    askedWorkflows.clear()
    // A question an earlier session left on the band goes, unanswered: its default applies.
    await endBand($, 'turn')
    await endBand($, 'prompt')
    resizedRuns.clear()
    spawning.length = 0
    lastTurnAt = 0
    idleWarnedFor = 0
    cancelCold($, 'a session started')
    offerOpen = false
    coldTurn = null
    coldDone = false
    coldPrompt = null
    wrapThenCompact = null
    projectFlag = null
    sizeShown = 0
    mainBusy = false
    lastWarmAt = 0
    warmReturn = null
    compactedAway = null
    manualCompact = false
    boundaryCheck = false
    await $.command.register({ name: CMD, description: 'Rightsize: settings, status, report, share, retry or clear' })
    // Claude Code hands over every value with its default filled in; only settings.json tells which ones are yours.
    const configs = await $.settings.read({ key: 'pluginConfigs' }).catch(() => undefined)
    const resetBefore = resetKeys(await $.store.get('resetFields').catch(() => undefined))
    yours = fieldsSet(configs, declared, resetBefore)
    legacyQuality = legacyAskFirst(configs)
    // What the fixed values govern depends on which rows are yours, now known.
    applyFixed()
    resetFields = new Set(stillReset(configs, declared, resetBefore))
    if (resetFields.size !== resetBefore.length) await $.store.set('resetFields', [...resetFields]).catch(() => undefined)
    const from = await $.store.get('measureFrom').catch(() => undefined)
    measureFrom = typeof from === 'string' && Number.isFinite(Date.parse(from)) ? Date.parse(from) : 0
    const gaps = manifestGaps(declared, yours)
    if (gaps.length) await log($, `settings: plugin.json and the settings table disagree: ${gaps.join('; ')}`)
    await setBandMode($, bandMode)
    await setBand($, null)
    const priceFile = await readText($, `${pluginRoot}/prices.json`)
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
    stepState = parseStepState(await $.store.get(STEP_STORE).catch(() => undefined))
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
    void rollUpLifetime($).finally(() => pruneSessions($))
    runLog = await readRuns($)
    ratedRuns.clear()
    await refreshMisses($)
    off = (await readSwitches($))[NAME] === false
    profileNoted.clear()
    await checkStart($).catch(() => undefined)
    await dayOneTip($).catch(() => undefined)
    $.clock.every(3000, () => {
      void readSwitches($).then(json => {
        off = json[NAME] === false
        if (off && (warming || coldTurn)) {
          cancelCold($, 'rightsize was turned off')
          coldTurn = null
        }
      })
      void tickOffer($)
    })
    await showStatus($)
    return result
  })

  on('command.run', { command: CMD }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'retry') return { text: await retry($) }
    if (arg === 'reset' || arg.startsWith('reset ')) return { text: await runReset($, e.args.trim().slice('reset'.length)) }
    if (arg === 'prices') return { text: await runCheck($, 'manual') }
    if (arg === 'report') {
      const runs = await readRuns($)
      const switches = await readSwitchLines($)
      const lifetime = await readLifetime($)
      const now = await $.clock.now()
      const start = startBlock(adviseStart(runs, await startContext($), now), billing === 'subscription', money)
      // The desktop app (any surface but the terminal) renders the report as Markdown.
      const surfaces = await $.session.surfaces()
      const markdown = surfaces.some(x => x !== 'terminal')
      return { text: buildReport(runs, switches, { now, session: sessionId, subscription: billing === 'subscription', start, pause: missBlock, markdown, watching, ...(lifetime ? { lifetime } : {}), ...(measureFrom ? { measureFrom: new Date(measureFrom).toISOString() } : {}) }) }
    }
    if (arg === 'share') {
      const runs = await readRuns($)
      return { text: shareMessage(runs, { now: await $.clock.now(), subscription: billing === 'subscription', ...(measureFrom ? { measureFrom: new Date(measureFrom).toISOString() } : {}) }) }
    }
    if (arg === 'clear') return { text: await clearSession($) }
    if (arg === 'resume') return { text: await resumeRightsize($, 'asked') }
    if (arg === 'help') return { text: helpText() }
    if (arg === 'status') return { text: await summary($) }
    if (arg === '') return { text: await openSettings($) }
    if (arg !== 'settings') return { text: `Unknown command "${arg}".\n\n${helpText()}` }
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
  }).catch((_, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    // rightsize's own prompt (the handoff's "wrap up"): not rated, and it does not count as the person coming back.
    if (coldPrompt !== null && e.text.trim() === coldPrompt) {
      coldPrompt = null
      return next(e)
    }
    // The person is back: keep-warm requests, a waiting handoff and a waiting offer stop, and the next big turn's end starts afresh.
    if (!off && fromPerson(e) && !e.command && !e.isMeta) {
      coldDone = false
      wrapThenCompact = null
      await recordGap($)
      await closeOffer($, 'ignored')
      await noteReturn($)
      cancelCold($, 'a prompt was submitted')
      // The band's questions that wait for the next prompt go, unanswered.
      await endBand($, 'prompt')
    }
    // 👍 and 👎 go with the next prompt, whatever it is.
    if (!off && fromPerson(e) && !e.isMeta) await dropRate($)
    if (off || !fromPerson(e) || e.command || e.isMeta) return next(e)
    // A new prompt replaces the last one's band.
    bandNote = null
    pauseRow = null
    await setBand($, null)
    const text = e.text.trim()
    if (skipOnce !== null && text === skipOnce) {
      skipOnce = null
      return next(e)
    }
    if (text.startsWith('/')) return next(e)
    // When the prompt came in, before any rating or question: the start of the task's time to done.
    const submittedAt = await $.clock.now()
    await noteIdle($).catch(() => undefined)
    profileChose = []
    // The session is idle, so no running turn can still take a prompt that has not started: it never will.
    if (e.turnId === undefined) await releaseStale($)

    // Routing and Hand-offs both off: there is nothing to plan, so the prompt is not rated (no rating call, no run line, no
    // task) and goes through as typed. The cache path does not need a rating: it reads the conversation's size from the
    // main chat's steps (lastContext) and the turn's end (rememberTurn), and the idle note is shown here, on a band of its own.
    if (!routing && !handOffs) {
      if (cacheOn) await knowBilling($, true)
      lastAuto = null
      const idle = idleNote
      idleNote = ''
      if (idle) await setBand($, { text: idle, acted: true })
      await showStatus($)
      return next(e)
    }
    // The person stepped up (or is back down): see manualCheck(). Held, the prompt goes through as typed, like the case above: no
    // rating call, no run line, no task. The pause row shows on the prompt the pause began on, and not again.
    const manual = await manualCheck($).catch(() => ({ held: false, row: false }))
    if (manual.held) {
      if (cacheOn) await knowBilling($, true)
      lastAuto = null
      const idle = idleNote
      idleNote = ''
      if (manual.row) await setBand($, { text: idle ? `${pauseRow ?? ''} ${idle}` : (pauseRow ?? ''), acted: true })
      else if (idle) await setBand($, { text: idle, acted: true })
      await showStatus($)
      return next(e)
    }
    await knowBilling($, true)
    $.ui.status('Rating the prompt...')
    let out = e
    let run: Run | null = null
    // The task as it stood before this prompt changed it, and what this prompt wrote: a dropped prompt puts it back.
    let prevTask: Awaited<ReturnType<typeof currentTask>> | undefined
    let wroteTask: { id: string; prompts: number } | undefined
    try {
      const base = await situation($)
      const usage = pacing ? await usageNow($) : undefined
      const clockNow = pacing ? await $.clock.now() : 0
      paceNow = pacing ? paceOf(usage?.rateLimits ?? [], clockNow) : NORMAL_PACE
      // Pacing moves only a threshold left at its default: one you set stays as you set it.
      const set = { handOff: yours.has('handOff'), lower: yours.has('lowering') }
      const movedRules = pacedRules(base.rules ?? DEFAULT_RULES, paceNow, set)
      const s: Situation = { ...base, rules: movedRules }
      const { rating: rated, overhead, ratingMs, prompt, failed, by, task: kept, unsure } = await rate($, text, s)
      // A rating that continues the task is planned as the task's type; any other starts a task of its own type.
      const follows = rated !== undefined && rated.continues === true && kept !== null
      // Except in a review task: a follow-up the rater typed as something else (a lookup, a fix) is planned as what it
      // is. The review rule is for the review, not for the prompts around it, and the switch costs several times the turn.
      const reviewAside = follows && kept.type === 'review' && rated.type !== 'review'
      const retyped = follows && kept.type !== rated.type && !reviewAside
      const ratedType = retyped ? rated.type : undefined
      const r = rated && retyped ? { ...rated, type: kept.type } : rated
      // The prompt says the last reply was wrong: an outcome for the cheaper route that made it, if one did.
      if (rated?.corrects && kept) await noteCorrection($, kept.id).catch(() => undefined)
      if (r) {
        if (reviewAside) await log($, `the prompt continues a review task but is a ${r.type}: planned as that, no review switch`)
        // While Claude fans work out to workflows, a single hand-off would only cut across it. After one,
        // Workflows says whether hand-offs go on (follow my rules, right-size every agent) or wait (the default).
        const planned = plan(r, s, floor)
        const afterWorkflow = workflowSeen && planned.kind === 'delegate' && (workflows === 'ask' || workflows === 'pause rightsize') ? effortPlan(r, s, floor) : planned
        // A switched-off feature (Routing, Hand-offs) drops its plans: nothing of it is asked, applied or described on the band.
        const gated = gate(afterWorkflow, r, s)
        const fanned = gated.plan
        // A request that was cut, or a task whose last reply the rater could not read, may be harder than it looks:
        // that is no ground to lower effort or hand work to a cheaper model. Raising and stronger models are left alone.
        const downgrade = (fanned.kind === 'effort' && fanned.dir === 'lower') || (fanned.kind === 'delegate' && fanned.dir === 'down')
        const noDowngrade = unsure !== undefined && downgrade
        // The task's last turn ended on a failing test run: the work is harder than it looked, so a prompt that continues it is not lowered or handed down either.
        const afterRed = follows && kept.tests === 'failed' && downgrade
        const unfanned: Plan = noDowngrade ? { kind: 'none', why: 'the context was cut or missing, so no downgrade' } : afterRed ? { kind: 'none', why: 'the last turn of this task ended with a failing test run, so no downgrade' } : fanned
        // A window nearly used up: nothing that costs more than staying, unless the matching rule
        // (Raising for more effort, Stronger model for a stronger one) is yours: then it follows your rule.
        const costlier = (unfanned.kind === 'effort' && unfanned.dir === 'raise') || unfanned.kind === 'switch' || (unfanned.kind === 'delegate' && unfanned.dir === 'up')
        const mine = await choices($)
        const followsYou = unfanned.kind === 'effort' ? mine.raise !== undefined : mine.up !== undefined
        const skipped = paceNow.mode === 'max' && costlier && !followsYou
        const p: Plan = skipped ? { kind: 'none', why: 'the usage window is nearly used up' } : unfanned
        // Watch only: the plan is made and logged, nothing is applied and nothing is asked.
        const d = watching ? {} : await resolve($, p, r, s)
        if (d.session) await $.state.set({ plugin: 'rightsize', key: 'sessionEffort' }, d.session)
        if (d.delegate) out = { ...e, context: [...(e.context ?? []), delegateNote(d.delegate, chances)] }
        run = startRun(r, s, d, p, (await seenEffort($)) ?? s.level, overhead, { text, at: submittedAt, ...(e.turnId !== undefined ? { during: e.turnId } : {}) })
        if (watching && p.kind !== 'none') {
          run.would = planChange(p)
          run.wouldTaken = wouldCost(p, r, s)
        }
        // Learning mode: the same plan with the learned step exponent applied, logged beside the real one. Nothing acts on it.
        try {
          const learnG = stepState.g
          run.learnG = learnG
          const learnS = { ...s, stepExp: learnG }
          run.learning = learningNote(gate(planned, r, s).plan, gate(plan(r, learnS, floor), r, learnS).plan, learnG, stepState.applied)
          const note = run.learning
          if (run.change === 'delegate-down' && note.differs && !note.plan.startsWith('delegate-down')) {
            run.handedOff = { actingStay: run.stay / Math.max(1, r.steps) ** run.stepExp, ruleShare: (s.rules ?? DEFAULT_RULES).handOff }
          }
        } catch {
          // A failed learning note is left out; the prompt runs as it would have.
        }
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
        if (handOffs && planned.kind === 'delegate' && planned.tie) {
          run.tie = planned.tie
          await countTie($)
        }
        const was = base.rules ?? DEFAULT_RULES
        const moved = movedRules.handOff !== was.handOff || movedRules.lower !== was.lower
        const note = paceText(skipped || moved, moved ? { from: was, to: movedRules } : undefined)
        const band = watching
          ? watchBand(run, p, s)
          : noDowngrade
          ? { text: 'No change: the context was cut or missing, so rightsize did not lower this or hand it to a cheaper model.', acted: false }
          : p !== unfanned
          ? { text: `Kept ${s.level} on ${TIER_NAME[s.tier]} instead of ${unfanned.kind === 'delegate' ? `a ${TIER_NAME[unfanned.tier]} subagent` : unfanned.kind === 'switch' ? `running on ${TIER_NAME[unfanned.tier]}` : `raising to ${unfanned.kind === 'effort' ? unfanned.level : ''}`}.`, acted: true }
          : bandFor(run, d, p)
        // The first time a case comes up in a session with no rule set, the band says what decided it.
        const fresh = profileChose.filter(k => !profileNoted.has(k))
        for (const k of fresh) profileNoted.add(k)
        const byProfile = fresh.length ? `${askFirst ? 'Ask before changing' : 'The default'} decided (${fresh.map(k => RULE_NAME[k]).join(', ')}); ⋯ changes it.` : ''
        const extras = [note, byProfile, idleNote].filter(Boolean).join(' ')
        const hadIdle = idleNote !== ''
        idleNote = ''
        await setBand($, extras ? { ...band, text: `${band.text} ${extras}`, acted: band.acted || hadIdle } : band, true)
        const did = d.delegate ? `delegate ${d.delegate.tier}` : d.model ? `switch to ${d.model.tier} at ${d.model.level} for the turn` : d.level ? `${d.auto ? 'auto ' : ''}${d.level} for the prompt` : d.session ? `${d.session} for the session` : 'no change'
        const fit = TIERS.map(t => `${t[0]}:${r.fit[t] ?? (r.fit[t] === null ? 'no' : '?')}`).join(' ')
        if (noDowngrade) await log($, `no downgrade: context ${unsure}`)
        if (afterWorkflow !== planned) await log($, `hand-off to ${planned.kind === 'delegate' ? planned.tier : '?'} skipped: a workflow ran this session`)
        if (gated.dropped) await log($, gated.dropped)
        const paced = paceNow.mode === 'normal' ? '' : `, ${paceNow.mode} pace on ${paceNow.window}${paceNow.pace === undefined ? '' : ` (${paceNow.pace.toFixed(2)})`}`
        await log($, `${r.type}${ratedType ? ` (rated ${ratedType}, continues the ${r.type} task)` : ''} on ${s.tier}/${s.level}${paced}: rated ${fit}, plan ${p.kind}${'dir' in p ? ` ${p.dir}` : ''}${run.tie ? ` (tie ${run.tie.by} over ${run.tie.over})` : ''}: ${did}`)
        // Every 50th Haiku rating gets Sonnet's second opinion, in the background. A Sonnet rating is not checked
        // (Sonnet would only be asked to agree with itself), and does not count toward the 50.
        const spotDue = by === 'haiku' ? await dueCheck($) : false
        if (spotDue) void spotCheck($, sessionId, run.task, s.tier, s.level, prompt, r)
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
  }).catch((_, e, next) => next(e))

  // A turn starting is how a prompt finds its turn. Prompts typed while a turn runs wait in line, and the turn
  // that starts for one carries its text, so each run is bound to its own turn, not to whichever starts next.
  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    mainBusy = true
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
  }).catch((_, e, next) => next(e))

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
        if (raising() && !off && !manualPause && !watch.returned) {
          const sign = struggle(watch.signals, watch.steps, watch.rated, LIMITS, Infinity)
          if (sign) await escalateHelper($, e.agentId, watch, sign)
        }
      }
      // Held (the person stepped up): a subagent from before runs at the effort Claude asked for.
      const level = manualPause ? undefined : watch?.raisedTo ?? ours?.level ?? sized?.level
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
    let run = active?.turnId === e.turnId ? active : null
    // The person's effort is read on the first step of a turn: a step up pauses rightsize from here, for this turn too.
    if (isLevel(e.effort) && e.turnId !== effortTurn) {
      effortTurn = e.turnId
      await noteEffort($, e.effort, e.model)
    }
    if (isLevel(e.effort)) await $.state.set({ plugin: 'rightsize', key: 'seenEffort' }, e.effort)
    // Held: the step goes as the engine made it, on the person's model and effort. Nothing below rewrites it. A run rated before
    // the pause (this turn's, or one still running when the person stepped up) is dropped: it claims no saving and teaches nothing.
    const held = manualPause !== null
    if (held && run) {
      await dropForPause($, run)
      run = null
    }
    const session = held ? null : await sessionEffortInUse($)
    const own = session ?? (isLevel(e.effort) ? e.effort : undefined)
    // A switched turn (a review on Opus) runs every step on that model at its level, and only that turn.
    const sw = run?.switchTo
    let level: Level | undefined = sw?.level ?? run?.level ?? session ?? undefined
    // An auto-lowered turn stays lowered for its whole length (ADR 0021: a step count is size, not difficulty). A tool error
    // is a sign the work is harder than rated: the session's level comes back, and the misses log counts it.
    if (run?.auto && run.errors > 0) {
      level = own
      if (!run.steppedUp) {
        run.steppedUp = true
        run.steppedUpBy = 'error'
        await setBand($, { text: `Effort back to ${run.normal}: the task got harder.`, acted: true, rule: 'lower' })
        await showStatus($)
      }
    }
    // A hand-off's main chat only briefs and checks: its struggle is the subagent's.
    if (run && !run.delegate && raising() && !off) {
      const sign = struggle(run.signals, e.index, run.rating.steps, LIMITS)
      if (sign) await escalate($, run, sign, level ?? own, e.index)
    }
    if (run?.raisedTo && (!level || levelRank(run.raisedTo) > levelRank(level))) level = run.raisedTo
    const send = sw && level ? { ...e, model: sw.tier, effort: level } : level && e.effort !== undefined ? { ...e, effort: level } : e
    const applied = !held && isLevel(send.effort) ? send.effort : undefined
    if (held) lastApplied = undefined
    const out = yield* next(send)
    const u = out.usage
    if (u) {
      // An effort switch may make this request re-write the conversation: measure it.
      // A model rewritten on this step or the last one makes the cache miss the model's, not an effort switch's: not measured.
      // The first request after a turn ended: a drop in context after an idle gap of 50 minutes or more, with no /compact, is Claude's
      // idle compact. It is never a cache miss: the conversation is small and its summary is not in the cache.
      if (boundaryCheck) {
        boundaryCheck = false
        if (!compactedAway && lastTurnAt && compactBoundary({ gap: (await $.clock.now()) - lastTurnAt, before: lastContext, after: contextOf(u), manual: manualCompact })) await noteCompacted($, lastContext, contextOf(u))
        manualCompact = false
      }
      if (!sw && !lastSwitched && !compactedAway && applied && lastApplied && applied !== lastApplied && lastContext > 5000) {
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
        if (missed && run && t) run.missCost += (u.cache_creation_input_tokens * (atPrompt(prices[t], contextOf(u)).cacheWrite - atPrompt(prices[t], contextOf(u)).cacheRead)) / 1e6
        void saveCal($)
      }
      if (applied) lastApplied = applied
      lastSwitched = sw !== undefined
      // The first request of a prompt that came back to a kept-warm cache shows whether the cache held.
      if (compactedAway) warmReturn = null
      if (warmReturn) {
        const c = warmReturn
        warmReturn = null
        await settleWarm($, c, u)
      }
      // A compact seen only now, or one the band has not said yet: say it, in the prompt's place.
      if (compactedAway) {
        const gone = compactedAway
        compactedAway = null
        if (!gone.shown) await setBand($, { text: compactedText({ before: gone.before, after: gone.after ?? contextOf(u), ...(gone.handoff ? { handoff: gone.handoff } : {}) }), acted: true })
      }
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
    // Until Workflows is answered, the person is asked: on the band while it runs, paused, or in the dialog before it starts.
    if (String(e.tool) === 'Workflow' && !off) {
      if (askingWorkflow) await askingWorkflow
      // With Routing and Hand-offs both off, rightsize has nothing to pause or follow: no question.
      if (workflows === 'ask' && (routing || handOffs) && !manualPause) {
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
    if (helper?.returned) return { deny: helper.capped ? capReturn(helper.capped) : HELPER_RETURN }
    // A helper on a cheaper tier gets a fixed number of tool calls, however well they go. At the cap it is struggling:
    // it goes back to the main chat, the way a helper with no retry left does.
    if (helper && e.agentId !== undefined && !off) {
      const cap = helper.tier ? helperCap(callCap, helper.tier) : undefined
      if (cap !== undefined && helper.calls >= cap) {
        helper.returned = true
        helper.stall = 'struggling'
        helper.capped = cap
        await setBand($, { text: `Helper stopped and sent back to the main chat: it used its ${cap} tool calls.`, acted: true })
        await log($, `returned helper ${e.agentId} to the main chat at step ${helper.steps}: it reached the ${cap}-call cap for ${helper.tier}`)
        return { deny: capReturn(cap) }
      }
      helper.calls += 1
    }
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
      // A call the person said no to at the permission prompt comes back as an error: it is their steering, not a failure.
      const refused = (result as { isError?: boolean }).isError === true && refusedByPerson(errorText(result))
      const isError = (result as { isError?: boolean }).isError === true && !refused
      // An error from the environment (no network, a denied sandbox, a missing program) is a Blocked
      // stall: more effort would not fix it, so it is neither an error nor a sign of struggling.
      const blocked = isError && blockedError(errorText(result))
      if (blocked) active.blocked += 1
      else if (isError) active.errors += 1
      if (!(result as { deny?: string }).deny && !refused && isApprovalStep(String(e.tool), e as Record<string, unknown>)) active.approvalSteps += 1
      // A refused call (a hook's deny, or the person's no) says nothing about the work.
      if (!(result as { deny?: string }).deny && !refused && !blocked) active.signals = noteCall(active.signals, callKey(String(e.tool), e as Record<string, unknown>), isError, isTestCommand(String(e.tool), e as Record<string, unknown>), isEditTool(String(e.tool)))
    }
    return result
  }).catch((_, e, next) => next(e))

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
  }).catch((_, e, next) => next(e))

  // Above the prompt, one row per topic: what rightsize did with the prompt, the cache, and a question. Each row
  // is a dim label (Prompt, Cache, the question's header), one line, and that row's buttons. With two rows or
  // more, a header line carries ⋯ and × for all of them; a single row carries them at its end.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (off || e.props.hasSurvey) return next(e)
    const question = (await $.state.get(QUESTION).catch(() => undefined))?.value
    const mode = (await $.state.get(BAND_MODE).catch(() => undefined))?.value ?? bandMode
    const band = (await $.state.get(BAND).catch(() => undefined))?.value
    const shown = bandRows(band, mode)
    if (!shown.route && !shown.cold && !question) return next(e)
    const { Box, Button, Link, Text } = $.ui.resolve(e)
    type Row = { key: string; label: string; text: string; buttons: ReturnType<typeof Button>[]; note?: string; link?: { label: string; href: string } }
    const rows: Row[] = []
    const buttons: { key: string; label: string; press: () => Promise<unknown> }[] = []
    if (band && shown.route) {
      if (band.canRetry) {
        buttons.push({
          key: 'retry',
          label: 'Retry at original effort',
          press: async () => {
            const text = await retry($)
            return $.ui.toast(text)
          },
        })
      }
      if (band.canStay && lastAuto?.kind === 'route') {
        buttons.push({
          key: 'stay',
          label: `Run on ${lastAuto.model}`,
          press: async () => {
            const text = await runOnCurrent($)
            return $.ui.toast(text)
          },
        })
      }
      if (band.canResume) {
        buttons.push({
          key: 'resume',
          label: 'Resume rightsize',
          press: async () => {
            const text = await resumeRightsize($, 'asked')
            return $.ui.toast(text)
          },
        })
      }
      if (band.canClear) {
        buttons.push({
          key: 'clear',
          label: 'Clear',
          press: async () => {
            const text = await clearSession($)
            return $.ui.toast(text)
          },
        })
      }
      if (band.tip) {
        const tip = band.tip
        buttons.push({ key: 'tip-later', label: 'Not now', press: () => snoozeStart($, tip) })
      }
      if (band.tipSwitch) {
        const cmd = band.tipSwitch
        buttons.push({ key: 'tip-switch', label: `Switch: ${cmd}`, press: () => fillSwitch($, cmd) })
      }
      // 👍 and 👎 wait in the ⋯ menu: the outcomes rightsize measures itself (rework, tests, corrections) carry the weight.
    }
    // Number keys 1-9 run down the rows in order.
    let keys = 0
    const numbered = (list: typeof buttons) =>
      list.map(b => {
        const n = ++keys
        return <Button key={b.key} label={b.label} {...(n <= 9 ? { hotkey: String(n) } : {})} onPress={() => void b.press()} />
      })
    if (band && shown.route) rows.push({ key: 'route', label: 'Prompt', text: band.text, buttons: numbered(buttons) })
    if (band && shown.cold && band.coldText) {
      const cold = (band.cold ?? []).map(c => ({ key: `cold-${c.id}`, label: c.label, press: () => pressCold($, c.id) }))
      rows.push({ key: 'cold', label: 'Cache', text: band.coldText, buttons: numbered(cold), ...(band.coldLink ? { link: band.coldLink } : {}) })
    }
    if (question) {
      const options = question.options.map((label, i) => ({ key: `q-${i}`, label, press: () => answerBand($, question.id, i) }))
      rows.push({ key: 'question', label: question.header, text: question.question, buttons: numbered(options), ...(question.ifNone ? { note: `No answer: ${question.ifNone}.` } : {}) })
    }
    // × closes every row: a question closed this way gets its no-answer default. A question alone has no ⋯.
    const close = async () => {
      // × hides the pause row; the pause itself stays (the status line still says it).
      pauseRow = null
      if (band && (shown.route || shown.cold)) await setBand($, null)
      if (question) await answerBand($, question.id, undefined)
    }
    const ends = [
      ...(band && (shown.route || shown.cold) ? [<Button key="mode" label="⋯" onPress={() => void bandMenu($, band)} />] : []),
      <Button key={question && !shown.route && !shown.cold ? 'q-close' : 'close'} label="×" role="dismiss" onPress={() => void close()} />,
    ]
    const single = rows.length === 1
    // The labels line up in one column, as wide as the longest.
    const width = Math.max(...rows.map(r => r.label.length))
    const drawRow = (r: Row) => (
      <Box key={r.key} flexDirection="row" columnGap={1}>
        <Box flexShrink={0} {...(single ? {} : { width })}>
          <Text dimColor>{single ? `rightsize · ${r.label}` : r.label}</Text>
        </Box>
        <Box flexDirection="column" flexShrink={1}>
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            <Text>{r.text}</Text>
            {r.buttons}
            {r.link ? <Text><Link key="link" href={r.link.href} label={r.link.label} /></Text> : null}
            {single ? ends : null}
          </Box>
          {r.note ? <Text dimColor>{r.note}</Text> : null}
        </Box>
      </Box>
    )
    return (
      <Box flexDirection="column" rowGap="xs">
        {single ? null : (
          <Box key="head" flexDirection="row" justifyContent="space-between">
            <Text dimColor>rightsize</Text>
            <Box flexDirection="row" columnGap={1}>
              {ends}
            </Box>
          </Box>
        )}
        {rows.map(drawRow)}
      </Box>
    )
  })

  // The settings pane (bare /rightsize): every row of /config as a picker, Advanced rows under their own heading. The mobile
  // app has no picker element: it lists the rows and a button that asks.
  on('ui.render', { component: 'Pane', requestId: MENU_ID }, async ($, e) => {
    // Read while drawing: a change in the pane (or in /config) writes it, and the pane draws again.
    await $.state.get(MENU).catch(() => undefined)
    const line = (key: SettingKey) => `${rowLabel(key)}: ${cfg[key]}`
    const plain = KEYS.filter(k => !SETTINGS[k].title.startsWith(ADVANCED))
    const advanced = KEYS.filter(k => SETTINGS[k].title.startsWith(ADVANCED))
    if (e.surface === 'mobile') {
      const { Box, Button, Text } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          {plain.map(k => <Text key={k}>{line(k)}</Text>)}
          <Text bold>Advanced</Text>
          {advanced.map(k => <Text key={k}>{line(k)}</Text>)}
          <Button key="change" label="Change a setting" onPress={() => void askSettings($)} />
        </Box>
      )
    }
    const { Box, Select, Text } = $.ui.resolve(e)
    // The keys come first: Tab moving between rows is the engine's, and nothing else says so.
    // The first row takes the keys when the pane opens focused.
    const row = (key: SettingKey) => (
      <Select key={`row-${key}`} label={rowLabel(key)} options={SETTINGS[key].options.map(value => ({ value }))} value={cfg[key]} {...(key === KEYS[0] ? { autoFocus: true as const } : {})} onSelect={value => void setFromMenu($, key, value)} />
    )
    return (
      <Box flexDirection="column">
        <Text dimColor>Tab: next setting · ↑↓: choose a value · Enter: set · Esc: close. A change takes effect at once. (default) is a row you have not set.</Text>
        {plain.map(row)}
        <Text bold>Advanced</Text>
        {advanced.map(row)}
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
      mainBusy = false
      boundaryCheck = true
      manualCompact = false
      completed.add(e.turnId)
      await knowBilling($, false)
      await rememberTurn($)
    }
    if (e.agentId === undefined && active && active.turnId === e.turnId) {
      const run = active
      active = null
      await finish($, run, e.isAborted, e.durationMs)
    }
    // The turn's own questions go, unanswered; those asked while its prompt was sent show now. So does the whatsnext note.
    if (e.agentId === undefined) await endBand($, 'turn')
    // A person who interrupted is at the keyboard: no offer for an aborted turn.
    if (e.agentId === undefined && !e.isAborted) await coldCheck($).catch(err => log($, `before the cache goes cold failed: ${err instanceof Error ? err.message : String(err)}`))
    if (e.agentId === undefined && !e.isAborted) await limitCheck($)
    if (e.agentId === undefined && !e.isAborted) await sizeCheck($)
    // whatsnext's wrap-up before a compaction ended: the compaction follows (after coldCheck, which cancels timers), from a timer (the hook does not wait for it). An interrupted wrap-up stops it.
    if (e.agentId === undefined && wrapThenCompact) {
      const w = wrapThenCompact
      wrapThenCompact = null
      if (e.isAborted) await log($, `${w.label}: the wrap-up was interrupted; not compacting`)
      else if (!off) await armCold($, coldGen, await $.clock.now(), () => resumeCompact($, w))
    }
    return result
  })
}

