import type { EngineInterface, PromptSubmitInput, Register } from 'claude-code'
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
  SWITCH_KEY,
  TIERS,
  TIER_NAME,
  type Calibration,
  type Plan,
  type Prices,
  type Rating,
  type Rules,
  type Situation,
  contextOf,
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
  plan,
  ratioSample,
  rawDelegateCost,
  rawMainCost,
  share,
  tierOf,
  tierRank,
  usageCost,
  type Usage,
} from './cost'
import { PRICING_URL, applyPrices, diffPrices, isDue, parsePricingPage } from './prices'
import { parseRating, ratingPrompt, ratingSystem } from './rate'
import { type Change, type RunLine, type SwitchLine, type Windows, buildReport, parseLines } from './report'

// Before a prompt is sent, a quick Haiku call rates the effort, the model and
// the work needs on each model, and the cost model prices each route that fits. The first time
// each situation comes up in a session the person picks how to handle it
// (Q1 lowering, Q2 raising, Q3 a stronger model, Q4 a cheaper model), then the
// mod follows that answer. Effort changes rewrite each main-thread request
// (turn.step); a model change hands the work to a subagent through a hidden
// note beside the prompt (prompt.submit context), and that subagent's requests
// run at the level its model needs (turn.step). After each rated turn the
// real cost is read off the session's cost ledger (/cost) and fed back into the
// estimates. Billing (API or subscription) is read off the rate limits each
// response carries; the person is asked only when they say nothing. A band
// above the prompt shows what it did, with buttons to undo it or change the rule.

const NAME = 'rightsize'
const CMD = 'rightsize'
const RATER = 'haiku'
const MIN_WORDS = 6
const BRAIN_DUMP_WORDS = 120
/** An auto-lowered turn steps back up from this step on. */
const STEP_UP_AFTER = 5
/** Claude Code's own system prompt and tools, before the first request is seen. */
const DEFAULT_CONTEXT = 20_000
/** About 30 days of heavy use, for /rightsize report. */
const RUNS_LOG_MAX = 1_000_000

type Lower = NonNullable<Choices['lower']>
type Raise = NonNullable<Choices['raise']>
type Route = NonNullable<Choices['up']>
type Billing = 'api' | 'subscription'
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
let priceCheck: 'monthly' | 'check now' | 'off' = 'monthly'
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
 * work out itself, so rightsize hands nothing off until the session ends. A workflow
 * runs on in the background, so its agents' cost lands in later turns too: from
 * here on no turn teaches calibration or claims a saving.
 */
let workflowSeen = false

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

async function remembers($: EngineInterface) {
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
    let stored = parseCalibration(await $.store.get('calibration'))
    for (const s of batch) stored = learn(stored, s.key, s.sample)
    await $.store.set('calibration', stored)
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

// Reads the billing off the last response's rate limits. When they say nothing
// after a response, it keeps the person's earlier answer, or (`mayAsk`) asks once a session.
async function knowBilling($: EngineInterface, mayAsk: boolean) {
  if (billingBy === 'detected') return
  const u = await usageNow($)
  const seen = billingOf(u?.rateLimits ?? [])
  if (seen) return saveBilling($, seen, 'detected')
  if (!mayAsk || billingAsked || billingBy === 'answered' || lastContext === 0) return
  billingAsked = true
  const v = await pick($, qBilling)
  if (v !== undefined) await saveBilling($, v, 'answered')
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

async function saveChoices($: EngineInterface, next: Choices) {
  await $.state.set({ plugin: 'rightsize', key: 'choices' }, next)
  if (await remembers($)) {
    await $.store.set('choices', next).catch(() => undefined)
    return
  }
  const asked = (await $.state.get({ plugin: 'rightsize', key: 'rememberAsked' }).catch(() => undefined))?.value
  if (asked === true) return
  await $.state.set({ plugin: 'rightsize', key: 'rememberAsked' }, true)
  const yes = await pick($, qRemember)
  if (yes === true) {
    await $.store.set('remember', true).catch(() => undefined)
    await $.store.set('choices', next).catch(() => undefined)
  } else if (yes === undefined) {
    // Dismissed: ask again after the next answer.
    await $.state.set({ plugin: 'rightsize', key: 'rememberAsked' }, false)
  }
}

// The saved answer for one situation, or the question, the first time it comes up.
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
  return { tier, level, context: typeof context === 'number' && context > 0 ? context : DEFAULT_CONTEXT, prices, cal, rules }
}

async function rate($: EngineInterface, text: string, s: Situation): Promise<{ rating?: Rating; overhead: number }> {
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
  const r = await $.model.complete({
    model: RATER,
    system: ratingSystem(s.tier, s.level),
    prompt: ratingPrompt(text, lastReply),
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
  const rating = parseRating(r.text, s.tier)
  if (!rating) await log($, `rating unreadable: ${JSON.stringify(r.text.slice(0, 80))}`)
  return { rating, overhead }
}

const costLine = (d: number, stay: number, cur: string) =>
  billing === 'api'
    ? `About ${money(d)} that way vs ${money(stay)} on ${cur} (estimated).`
    : `That uses ${share(d, stay)} the usage of staying on ${cur} (estimated).`

type Decision = { level?: Level; session?: Level; auto?: boolean; delegate?: Run['delegate'] }

async function resolveEffort($: EngineInterface, p: Plan, r: Rating, s: Situation): Promise<Decision> {
  if (p.kind !== 'effort') return {}
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
    rating: r,
    tier: s.tier,
    normal: s.level,
    level: d.level,
    ranAt: level,
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
    mainCost: 0,
    subCost: 0,
    missCost: 0,
    errors: 0,
    steppedUp: false,
    delegated: false,
  }
}

// ---- Reporting -------------------------------------------------------------

async function showStatus($: EngineInterface) {
  const run = active ?? pending
  if (run?.delegate) return $.ui.status(`Rightsize: handing this to a ${TIER_NAME[run.delegate.tier]} subagent`)
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
export function bandFor(run: Pick<Run, 'tier' | 'normal' | 'auto' | 'delegate' | 'stay' | 'takenDelegate'>, d: Decision, p: Plan): Band {
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
  await saveChoices($, { ...(await choices($)), [key]: value } as Choices)
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

async function chooseBandMode($: EngineInterface) {
  const v = await pick($, qBand)
  if (v === undefined) return
  await setBandMode($, v)
  await $.config.set({ key: 'rightsize.band', value: v }).catch(() => undefined)
}

export function report(run: Pick<Run, 'tier' | 'stay'> & { delegate: NonNullable<Run['delegate']> }, actual: number, mode: 'api' | 'subscription') {
  const to = TIER_NAME[run.delegate.tier]
  const cur = TIER_NAME[run.tier]
  const vs = `${money(actual)} vs about ${money(run.stay)} on ${cur} (estimated)`
  if (mode === 'subscription') return `rightsize: Sent to ${to}: used ${share(actual, run.stay)} the usage staying on ${cur} would. At API prices: ${vs}.`
  const diff = actual <= run.stay ? `saved about ${Math.round((1 - actual / Math.max(run.stay, 1e-9)) * 100)}%` : `cost ${share(actual, run.stay)} staying`
  return `rightsize: Sent to ${to}: ${vs}, ${diff}.`
}

const round = (n: number) => Number(n.toFixed(5))

function windows(limits: readonly { kind: string; percentUsed: number }[] | undefined): Windows | undefined {
  if (!limits?.length) return undefined
  return Object.fromEntries(limits.map(l => [l.kind, l.percentUsed]))
}

async function finish($: EngineInterface, run: Run, aborted: boolean, durationMs: number) {
  const r = run.rating
  const delegated = run.delegate !== undefined && run.delegated
  const tokens = run.mainCost + run.subCost
  // The ledger prices each response as /cost does, with the cache TTL it was really
  // written at; a background agent from an earlier turn finishing now counts in it too.
  const u = await usageNow($)
  const end = run.ledgerStart === undefined ? undefined : u?.cost?.usd
  const ledger = end === undefined || run.ledgerStart === undefined ? 0 : end - run.ledgerStart
  const actual = ledger > 0 ? ledger : tokens
  // A workflow's agents say nothing about one route's estimate, in this turn or the ones after it.
  if (!aborted && actual > 0 && !workflowSeen) {
    if (delegated && run.delegate && run.rawDelegate) {
      const sample = ratioSample(actual, run.rawDelegate)
      for (const key of delegateKeys(r.type, run.delegate.tier, run.delegate.level)) teach(key, sample)
    }
    // A turn that stepped back up ran partly at the normal level, so its cost says
    // nothing about the lowered estimate: it teaches nothing.
    else if (!run.delegate && !run.steppedUp) {
      const sample = ratioSample(Math.max(0, actual - run.missCost), run.rawMain)
      for (const key of mainKeys(r.type, run.tier, run.ranAt)) teach(key, sample)
    }
    await saveCal($)
  }
  // Every rated turn is logged, changed or not and stopped or not, for /rightsize report.
  if (actual > 0 || run.overhead > 0) {
    const line: RunLine & Record<string, unknown> = {
      at: new Date().toISOString(),
      kind: 'run',
      session: sessionId,
      type: r.type,
      route: delegated ? `delegate:${run.delegate?.tier}` : 'main',
      tier: run.tier,
      level: run.steppedUp ? run.normal : (run.level ?? run.normal),
      fit: r.fit,
      ...(delegated ? { subLevel: run.subLevel ?? null } : {}),
      auto: run.auto,
      steppedUp: run.steppedUp,
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
      ...(run.workflows ? { workflows: run.workflows } : {}),
      ...(workflowSeen ? { afterWorkflow: true } : {}),
      durationMs,
      ...(run.before ? { before: run.before } : {}),
      ...(windows(u?.rateLimits) ? { after: windows(u?.rateLimits) } : {}),
    }
    await append($, 'rightsize-runs.jsonl', JSON.stringify(line), RUNS_LOG_MAX)
  }
  if (run.delegate && (!delegated || !aborted)) {
    const text = !delegated
      ? `rightsize: Claude did not hand this to a ${TIER_NAME[run.delegate.tier]} subagent; it ran on ${TIER_NAME[run.tier]} (${money(actual)}).`
      : report({ tier: run.tier, stay: run.stay, delegate: run.delegate }, actual, billing)
    // The band shows the result in place of a transcript line; with the band off, the line stays.
    if (bandMode === 'off') $.ui.log(text)
    else await setBand($, { text: text.replace(/^rightsize: /, ''), acted: true, rule: run.delegate.dir })
  }
  await showStatus($)
}

async function summary($: EngineInterface) {
  const c = await choices($)
  const said = (v: string | undefined) => v ?? 'not asked yet'
  const session = await sessionEffort($)
  // One run teaches its type:route key and, for a hand-off, finer keys too: count the first only.
  const runs = Object.entries(cal).filter(([k]) => k !== SWITCH_KEY && k.split(':').length === 2).reduce((n, [, e]) => n + e.n, 0)
  const sw = cal[SWITCH_KEY]
  return [
    `Rightsize is ${off ? 'off (turn it on with /mods)' : 'on'}. Lowest level: ${floor}. Band: ${bandMode}. Billing: ${billingBy ? `${billing} (${billingBy === 'answered' ? 'your answer' : billingBy})` : 'not known yet'}.`,
    `Lowering: ${said(c.lower)}. Raising: ${said(c.raise)}. Stronger model: ${said(c.up)}. Cheaper model: ${said(c.down)}.${(await remembers($)) ? ' Saved for every session.' : ''}`,
    session ? `Session switch: ${session}.` : 'No session switch.',
    `Calibration: ${runs} measured run(s).${sw ? ` Effort switches that missed the cache: ${Math.round(sw.ratio * 100)}% of ${sw.n} (each one in ~/.claude/mods-logs/rightsize-switches.jsonl).` : ''}`,
    `Thresholds: hand off under ${Math.round(rules.handOff * 100)}% of staying, lower under ${Math.round(rules.lower * 100)}%${rules.handOff === DEFAULT_RULES.handOff && rules.lower === DEFAULT_RULES.lower ? ' (the defaults)' : ''}.`,
    `Prices: checked ${priceCheck === 'off' ? 'never (off)' : 'every 30 days'}; /rightsize prices checks now.`,
    '/rightsize report shows what it saved and what went wrong; settings asks the questions again; undo re-runs the last auto-lowered prompt; clear drops the session switch.',
  ].join('\n')
}

// ---- Hooks -----------------------------------------------------------------

export const register: Register = (on, options) => {
  const opts = (options ?? {}) as Record<string, unknown>
  if (isLevel(opts.floor)) floor = opts.floor
  if (opts.billing === 'subscription') billing = 'subscription'
  if (opts.priceCheck === 'off' || opts.priceCheck === 'check now') priceCheck = opts.priceCheck
  if (isBandMode(opts.band)) bandMode = opts.band
  rules = { handOff: parseShare(opts.handOff, DEFAULT_RULES.handOff), lower: parseShare(opts.lowering, DEFAULT_RULES.lower) }

  on('config.set', { key: 'rightsize.band' }, async ($, e, next) => {
    const result = await next(e)
    if (isBandMode(e.value)) await setBandMode($, e.value)
    return result
  })

  // Reports set in /config counts as the answer to the billing question.
  on('config.set', { key: 'rightsize.billing' }, async ($, e, next) => {
    const result = await next(e)
    if (isBilling(e.value)) await saveBilling($, e.value, 'answered')
    return result
  })

  // "check now" in /config runs a check and leaves the row on its usual value.
  on('config.set', { key: 'rightsize.priceCheck' }, async ($, e, next) => {
    if (e.value !== 'check now') return next(e)
    $.ui.toast('Checking prices against Anthropic’s pricing page...')
    void runCheck($, 'manual').then(msg => $.ui.toast(msg))
    return next({ ...e, value: e.previous === 'off' ? 'off' : 'monthly' })
  })

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
    await $.command.register({ name: CMD, description: 'Rightsize: status, report, settings, undo or clear' })
    await setBandMode($, bandMode)
    await setBand($, null)
    prices = parsePrices(await readText($, `${$.plugin.root}/prices.json`))
    if (priceCheck === 'check now') {
      // Set by hand in settings: check once, then back to monthly.
      void runCheck($, 'manual').then(msg => $.ui.toast(msg))
      void $.config.set({ key: 'rightsize.priceCheck', value: 'monthly' }).catch(() => undefined)
    } else if (priceCheck === 'monthly') {
      const lastChecked = await $.store.get('pricesCheckedAt').catch(() => undefined)
      const now = await $.clock.now()
      if (isDue(lastChecked, now)) {
        // Claim the check before fetching: a second session starting at the same
        // moment then finds it done. A failed check gives the claim back.
        await $.store.set('pricesCheckedAt', now).catch(() => undefined)
        void runCheck($, 'monthly', lastChecked)
      }
    }
    cal = parseCalibration(await $.store.get('calibration').catch(() => undefined))
    // Until this session's first response shows its rate limits, an earlier session's reading stands.
    const saved = (await $.store.get('billing').catch(() => undefined)) as { value?: unknown; by?: unknown } | undefined
    billingAsked = false
    billingBy = null
    if (isBilling(saved?.value)) {
      billing = saved.value
      billingBy = saved.by === 'answered' ? 'answered' : 'saved'
    }
    if (await remembers($)) {
      const saved = await $.store.get('choices').catch(() => undefined)
      if (saved && typeof saved === 'object') await $.state.set({ plugin: 'rightsize', key: 'choices' }, { ...(saved as Choices), ...(await choices($)) })
    }
    off = (await readSwitches($))[NAME] === false
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
    if (arg === 'prices') return { text: await runCheck($, 'manual') }
    if (arg === 'report') {
      const dir = `${home}/.claude/mods-logs`
      const runs = parseLines<RunLine>(await readText($, `${dir}/rightsize-runs.jsonl`))
      const switches = parseLines<SwitchLine>(await readText($, `${dir}/rightsize-switches.jsonl`))
      return { text: buildReport(runs, switches, { now: await $.clock.now(), session: sessionId, subscription: billing === 'subscription' }) }
    }
    if (arg === 'clear') return { text: await clearSession($) }
    if (arg === 'settings') {
      const s = await situation($)
      const cur = TIER_NAME[s.tier]
      const up = TIERS.filter(t => tierRank(t) > tierRank(s.tier))
      const down = TIERS.filter(t => tierRank(t) < tierRank(s.tier))
      billingAsked = false
      if (billingBy === 'answered') billingBy = 'saved'
      await knowBilling($, true)
      const next: Choices = {}
      next.lower = await pick($, qLower)
      next.raise = await pick($, qRaise)
      if (up.length) next.up = await pick($, qUp(cur, names(up)))
      if (down.length) next.down = await pick($, qDown(cur, names(down)))
      for (const k of Object.keys(next) as (keyof Choices)[]) if (next[k] === undefined) delete next[k]
      await $.state.set({ plugin: 'rightsize', key: 'rememberAsked' }, false)
      await $.store.set('remember', false).catch(() => undefined)
      await saveChoices($, next)
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
    if (text.startsWith('/') || words(text) < MIN_WORDS) return next(e)
    if (brainDumpWillCatch(text, await readSwitches($))) return next(e)

    await knowBilling($, true)
    $.ui.status('Rightsize: rating the prompt...')
    let out = e
    let run: Run | null = null
    try {
      const s = await situation($)
      const { rating: r, overhead } = await rate($, text, s)
      if (r) {
        // While Claude fans work out to workflows, a single hand-off would only cut across it.
        const planned = plan(r, s, floor)
        const p = workflowSeen && planned.kind === 'delegate' ? effortPlan(r, s, floor) : planned
        const d = await resolve($, p, r, s)
        if (d.session) await $.state.set({ plugin: 'rightsize', key: 'sessionEffort' }, d.session)
        if (d.delegate) out = { ...e, context: [...(e.context ?? []), delegateNote(d.delegate)] }
        run = startRun(r, s, d, p, (await seenEffort($)) ?? s.level, overhead)
        await setBand($, bandFor(run, d, p))
        const did = d.delegate ? `delegate ${d.delegate.tier}` : d.level ? `${d.auto ? 'auto ' : ''}${d.level} for the prompt` : d.session ? `${d.session} for the session` : 'no change'
        const fit = TIERS.map(t => `${t[0]}:${r.fit[t] ?? (r.fit[t] === null ? 'no' : '?')}`).join(' ')
        if (p !== planned) await log($, `hand-off to ${planned.kind === 'delegate' ? planned.tier : '?'} skipped: a workflow ran this session`)
        await log($, `${r.type} on ${s.tier}/${s.level}: rated ${fit} ${r.size}, plan ${p.kind}${'dir' in p ? ` ${p.dir}` : ''}: ${did}`)
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
      // The hand-off's subagent runs at the level its model needs, whatever Claude asked for.
      const run = active
      const ours = run?.delegate && run.subAgents.includes(e.agentId) ? run.delegate : undefined
      const send = ours && e.effort !== undefined ? { ...e, effort: ours.level } : e
      if (run && ours && isLevel(send.effort)) run.subLevel = send.effort
      const out = yield* next(send)
      if (run && out.usage) run.subCost += usageCost(prices, out.usage.model, out.usage)
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
      if (run) run.mainCost += usageCost(prices, u.model, u)
    }
    return out
  })

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    // Ultracode's fan-out runs through the Workflow tool, from the main chat or a subagent.
    if (String(e.tool) === 'Workflow') {
      workflowSeen = true
      if (active) active.workflows += 1
    }
    if (active && e.agentId === undefined) {
      const model = (e as { model?: unknown }).model
      if (String(e.tool) === 'Agent' && active.delegate && model === active.delegate.tier) active.delegated = true
      if (String(e.tool) === 'Agent' || String(e.tool) === 'SendMessage') active.agentCalls += 1
      if ((result as { isError?: boolean }).isError) active.errors += 1
    }
    return result
  }).catch(($, e, next) => next(e))

  // The main chat starting the hand-off's subagent: the Agent call names its model.
  // Remember its id, so its steps run at the hand-off's level.
  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    const run = active ?? pending
    const ours = run?.delegate && e.parentAgentId === undefined && !e.fork && tierOf(e.model) === run.delegate.tier
    if (run && ours && result.agentId) run.subAgents.push(result.agentId)
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
    if (e.agentId === undefined) await knowBilling($, false)
    if (e.agentId === undefined && active && active.turnId === e.turnId) {
      const run = active
      active = null
      await finish($, run, e.isAborted, e.durationMs)
    }
    return result
  })
}

