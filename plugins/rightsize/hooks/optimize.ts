import { type LifeAdvice, lifeOffer } from './cachelife'
import { type Ttl, TTL_MS, ttlText } from './cost'
import { NOT_SET, RULE_LABELS, SETTINGS, type SettingKey, plainTitle } from './settings'
import { type HandDownKind, type RunLine, handDownNet, keepWarm, loweringNet } from './report'
import { IDLE_GAP_MIN, type Stretch, coldPlan, paysRun, pingEvery, planLength, usualStart, warmPlan } from './warm'

// /rightsize optimize (P-38, ADR 0084): rightsize's own settings that the last 30 days of the run log say should change, each
// with that period priced under the current setting and under the new one, so the person can judge the change. Only
// rightsize's rows (and the cache life it already offers): no advice on habits or on Claude Code's /model. Nothing changes
// here; register.tsx applies the ones the person picks. Pure functions.

/** The Lowering row's off-like option, as /config shows it. */
const NEVER_LOWER = RULE_LABELS.lower.find(l => l[1] === 'never')?.[0] ?? 'never lower'

const DAY = 24 * 60 * 60_000

export const OPT_DAYS = 30
/** Enough of the person's own use to judge from: rated prompts, over at least this many days. */
export const OPT_MIN_PROMPTS = 30
export const OPT_MIN_DAYS = 7
/** Lowering is judged only on this many lowered turns or more (P-78, ADR 0088), over at least OPT_MIN_DAYS days. Hand-downs (P-89) use the same bar. */
export const OPT_MIN_LOWERED = 30
/** Lowering off (or a hand-down off) is suggested when those turns saved this share of what they would have cost, or less. */
export const OPT_LOWER_SHARE = 0.01
/** A suggestion the person left unpicked is not shown again for this long. */
export const OPT_SKIP_DAYS = 30
/** Keep warm is judged only on this many of its requests or more. */
export const OPT_MIN_PINGS = 5
/** A keep-warm replay (P-90, ADR 0101) needs this many idle gaps or more, and OPT_MIN_PINGS requests under the current value. */
export const OPT_MIN_STRETCHES = 10
/** A replay must find "while it pays" cheaper by at least this many dollars. */
const OPT_MIN_GAIN = 0.005

/** What a suggestion changes: a rightsize row, or the cache life (Claude Code's promptCacheTtl, which rightsize offers and sets). */
export type OptId = 'beforeCold' | 'lowerRule' | 'useHaiku' | 'subagents' | 'downRule' | 'promptCacheTtl'

/**
 * One suggestion: the row's title, the value now and the one suggested; `now` and `after` the last 30 days under each;
 * `basis` how the `after` figure was found; `saving` dollars over the 30 days, absent when no dollar figure is honest;
 * `note` a line that informs and never decides (the share of hand-down turns that showed a failure sign).
 */
export type Suggestion = { id: OptId; title: string; from: string; to: string; now: string; after: string; basis: string; saving?: number; note?: string }

export type OptInput = {
  lines: readonly RunLine[]
  now: number
  subscription: boolean
  /** The rows' values now. */
  beforeCold: string
  /** The Lowering row's value now: "not set" until the person answers it; any other value is theirs, and is not suggested over. */
  lowerRule: string
  /** Use Haiku, Claude's subagents and Cheaper model now (their defaults when absent), and the rows the person set: a row they set is theirs and not suggested over (P-89). */
  useHaiku?: string
  subagents?: string
  downRule?: string
  yours?: ReadonlySet<SettingKey>
  /** What one keep-warm request costs on a conversation of this many tokens (the main model's cache read); absent: no keep-warm replay (P-90). */
  ping?: (context: number) => number
  /** The cache-life check, when rightsize may set the life (cachelife.ts lifeEligible, and no variable fixes it); undefined otherwise. */
  life?: { advice: LifeAdvice; current: Ttl }
  /** When each suggestion was last left unpicked, ms. */
  skipped: Partial<Record<OptId, number>>
}

export type OptResult = { enough: boolean; prompts: number; days: number; suggestions: Suggestion[] }

const usd = (x: number) => `$${(Math.round(Math.abs(x) * 100) / 100).toFixed(2)}`
const isRated = (l: RunLine) => (l.kind ?? 'run') === 'run'

// ---- Keep warm replay (P-90, ADR 0101) ---------------------------------------------

/** The Before the cache goes cold values that keep warm for a fixed time. */
const FIXED_KEEP_WARM: readonly string[] = ['keep warm 2 h', 'keep warm 8 h', 'keep warm until my usual start']

type Played = { requests: number; cost: number; saved: number; net: number }
const played = (): Played => ({ requests: 0, cost: 0, saved: 0, net: 0 })

/**
 * The month's idle gaps replayed under the current fixed keep warm and under "while it pays", each stretch priced on its own line
 * (its cache life, conversation and cold-return cost; `ping` prices a request). A request goes out each `pingEvery`, while the
 * person is still away; a return earns the cold cost when the cache would have expired without keep warm and the last request
 * kept it alive. The `history` lines, made from the log's earlier runs, carry no price and are not replayed, but they stay in the
 * record "while it pays" reads, as they do for the rule itself. The compaction step of "while it pays" is not replayed (it only adds to its net).
 * Undefined when the row is not a fixed keep warm, or there is no price.
 */
function replayKeepWarm(month: readonly RunLine[], i: OptInput): { now: Played; pays: Played; stretches: number } | undefined {
  const ping = i.ping
  if (!ping || !FIXED_KEEP_WARM.includes(i.beforeCold)) return undefined
  const billing = i.subscription ? 'subscription' : 'api'
  const idle = month
    .filter(l => l.kind === 'idle' && l.billing === billing && typeof l.gapMs === 'number' && Number.isFinite(l.gapMs) && l.gapMs >= IDLE_GAP_MIN && (l.ended === 'warm' || l.ended === 'cold' || l.ended === 'never'))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  const record: Stretch[] = idle.map(l => ({ gapMs: l.gapMs as number, ended: l.ended as Stretch['ended'] }))
  const plan = coldPlan(i.beforeCold, false)
  const start = usualStart(i.lines, i.now).minutes
  const out = { now: played(), pays: played(), stretches: 0 }
  const add = (p: Played, sent: number, s: Stretch, price: { ttl: number; cold: number; ping: number }) => {
    const earned = s.ended !== 'never' && sent > 0 && s.gapMs > price.ttl && s.gapMs <= sent * pingEvery(price.ttl) + price.ttl
    p.requests += sent
    p.cost += sent * price.ping
    if (earned) p.saved += price.cold
    p.net = p.saved - p.cost
  }
  idle.forEach((l, k) => {
    const s = record[k] as Stretch
    const ttl = l.ttl
    const cold = l.cold
    const context = l.context
    if (l.history || typeof ttl !== 'number' || !(ttl > 0) || typeof cold !== 'number' || !(cold > 0) || typeof context !== 'number' || !(context > 0)) return
    const cost = ping(context)
    if (!Number.isFinite(cost) || !(cost > 0)) return
    const price = { ttl, cold, ping: cost }
    out.stretches += 1
    // The fixed value: its requests (break-even cut included), as many as the person's absence lasted through.
    const endedAt = Date.parse(l.at) - s.gapMs
    const planned = warmPlan({ ms: planLength(plan, endedAt, start), ttl, cold, ping: cost, endedAt }).pings
    const away = (at: number) => (s.ended !== 'never' ? s.gapMs > at : s.gapMs >= at)
    let sent = 0
    while (sent < planned && away((sent + 1) * pingEvery(ttl))) sent += 1
    add(out.now, sent, s, price)
    add(out.pays, paysRun(s, record.slice(0, k), price).sent, s, price)
  })
  return out
}

/** "60 requests cost $30.00, saved $0.00  →  net $30.00 more". */
const replayText = (p: Played) =>
  `${p.requests} request${p.requests === 1 ? '' : 's'} cost ${usd(p.cost)}, saved ${usd(p.saved)}  →  ${Math.abs(p.net) < 0.005 ? 'net about even' : p.net > 0 ? `net ${usd(p.net)} saved` : `net ${usd(-p.net)} more`}`

/** The suggestions for the last 30 days, in the order shown. Empty, with `enough` false, until there is enough use to judge. */
export function optimize(i: OptInput): OptResult {
  const month = i.lines.filter(l => i.now - Date.parse(l.at) <= OPT_DAYS * DAY && Date.parse(l.at) <= i.now)
  const rated = month.filter(isRated)
  const days = new Set(rated.map(l => l.at.slice(0, 10))).size
  if (rated.length < OPT_MIN_PROMPTS || days < OPT_MIN_DAYS) return { enough: false, prompts: rated.length, days, suggestions: [] }
  const hidden = (id: OptId) => {
    const at = i.skipped[id]
    return typeof at === 'number' && i.now - at < OPT_SKIP_DAYS * DAY
  }
  const out: Suggestion[] = []

  // Before the cache goes cold. Off: keep warm that cost more than it saved, measured on its own requests and returns. While it pays (P-90):
  // a fixed keep warm that the person's own idle gaps, replayed, say costs more than while it pays. One suggestion for the row: when both
  // apply, the cheaper (off nets nothing, so while it pays only when its replayed net is above zero).
  const warm = keepWarm(month)
  const pings = month.filter(l => l.kind === 'warm').length
  const off = i.beforeCold !== 'off' && warm && pings >= OPT_MIN_PINGS && warm.net <= -0.005
  const rep = !hidden('beforeCold') ? replayKeepWarm(month, i) : undefined
  const pays = rep && rep.stretches >= OPT_MIN_STRETCHES && rep.now.requests >= OPT_MIN_PINGS && rep.pays.net - rep.now.net >= OPT_MIN_GAIN && !(off && rep.pays.net <= 0)
  if (pays && rep) {
    out.push({
      id: 'beforeCold',
      title: 'Before the cache goes cold',
      from: i.beforeCold,
      to: 'while it pays',
      now: replayText(rep.now),
      after: replayText(rep.pays),
      basis: `Estimated: your last ${rep.stretches} idle gaps replayed under each setting.`,
      saving: rep.pays.net - rep.now.net,
    })
  } else if (off && warm && !hidden('beforeCold')) {
    out.push({
      id: 'beforeCold',
      title: 'Before the cache goes cold',
      from: i.beforeCold,
      to: 'off',
      now: `keep warm cost ${usd(warm.cost)}, saved ${usd(warm.saved)}  →  net ${usd(-warm.net)} more`,
      after: `$0.00 spent, $0.00 saved  →  ${usd(-warm.net)} less`,
      basis: 'Measured from your keep-warm requests and the returns they saved.',
      saving: -warm.net,
    })
  }

  // Lowering: the automatic lowerings saved next to nothing (or cost more) over the month. Their cost is measured; staying is an estimate.
  // Applies to the Lowering row, "never lower". A row the person answered is theirs: not suggested over.
  if (i.lowerRule === NOT_SET && !hidden('lowerRule')) {
    const low = loweringNet(month)
    if (low.turns >= OPT_MIN_LOWERED && low.days >= OPT_MIN_DAYS && low.stay > 0 && low.saved <= OPT_LOWER_SHARE * low.stay) {
      const turns = `${low.turns} lowered turns`
      const miss = low.miss >= 0.005 ? `, including ${usd(low.miss)} on turns that stepped back up` : ''
      const lost = low.saved < 0
      out.push({
        id: 'lowerRule',
        title: 'Lowering',
        from: i.lowerRule,
        to: NEVER_LOWER,
        now: lost ? `${turns} cost ${usd(-low.saved)} more than staying${miss}` : `${turns} saved ${usd(low.saved)}, ${(Math.round((low.saved / low.stay) * 1000) / 10).toFixed(1)}% of the ${usd(low.stay)} they would have cost${miss}`,
        after: lost ? `$0.00 more  →  ${usd(-low.saved)} less spent` : `$0.00 saved  →  ${usd(low.saved)} less saved`,
        basis: 'Estimated: what those turns cost against an estimate of staying at your own effort.',
        ...(lost ? { saving: -low.saved } : {}),
      })
    }
  }

  // Hand-downs (P-89, ADR 0100): the same bar as Lowering, on the turns rightsize handed to a cheaper model and on Claude's subagents it
  // moved. Each only while its row is not the person's own. The failure share is a note and never decides.
  const yours = i.yours ?? new Set<SettingKey>()
  const useHaiku = i.useHaiku ?? SETTINGS.useHaiku.default
  const subagents = i.subagents ?? SETTINGS.subagents.default
  const downRule = i.downRule ?? NOT_SET
  const STAY = RULE_LABELS.down.find(l => l[1] === 'stay')?.[0] ?? 'stay, lower effort only'
  const OWN_BASIS = 'Estimated: what those turns cost against an estimate of staying on your own model.'
  const hands: { id: 'useHaiku' | 'subagents' | 'downRule'; title: string; kind: HandDownKind; from: string; to: string; open: boolean; what: string; noun: string; basis: string; signs: string }[] = [
    { id: 'useHaiku', title: plainTitle(SETTINGS.useHaiku.title), kind: 'haiku', from: useHaiku, to: 'off', open: useHaiku === SETTINGS.useHaiku.default && !yours.has('useHaiku'), what: 'Haiku hand-down turns', noun: 'turns', basis: OWN_BASIS, signs: 'a struggling or returned helper, rework, failed tests, or a 👎, correction or undo' },
    { id: 'subagents', title: plainTitle(SETTINGS.subagents.title), kind: 'subagent', from: subagents, to: 'off', open: subagents === SETTINGS.subagents.default && !yours.has('subagents'), what: 'moved subagent runs', noun: 'runs', basis: 'Estimated: what those runs cost against an estimate of the same work on your own model.', signs: 'a struggling or returned subagent, or a 👎, correction or undo on the run it came from' },
    { id: 'downRule', title: plainTitle(SETTINGS.downRule.title), kind: 'any', from: downRule, to: STAY, open: downRule === NOT_SET, what: 'hand-down turns', noun: 'turns', basis: OWN_BASIS, signs: 'a struggling or returned helper, rework, failed tests, or a 👎, correction or undo' },
  ]
  for (const h of hands) {
    if (!h.open || hidden(h.id)) continue
    const net = handDownNet(month, h.kind)
    if (!(net.turns >= OPT_MIN_LOWERED && net.days >= OPT_MIN_DAYS && net.stay > 0 && net.saved <= OPT_LOWER_SHARE * net.stay)) continue
    const label = `${net.turns} ${h.what}`
    const lost = net.saved < 0
    out.push({
      id: h.id,
      title: h.title,
      from: h.from,
      to: h.to,
      now: lost ? `${label} cost ${usd(-net.saved)} more than staying` : `${label} saved ${usd(net.saved)}, ${(Math.round((net.saved / net.stay) * 1000) / 10).toFixed(1)}% of the ${usd(net.stay)} they would have cost`,
      after: lost ? `$0.00 more  →  ${usd(-net.saved)} less spent` : `$0.00 saved  →  ${usd(net.saved)} less saved`,
      basis: h.basis,
      note: net.failed ? `Quality: ${net.failed} of ${net.turns} ${h.noun} (${Math.round((net.failed / net.turns) * 100)}%) showed a failure sign (${h.signs}).` : `Quality: none of the ${net.turns} ${h.noun} showed a failure sign.`,
      ...(lost ? { saving: -net.saved } : {}),
    })
  }

  // Cache life: the monthly comparison, on demand. Each life priced on the same turns.
  const life = i.life
  const to = life ? lifeOffer(life.advice, life.current) : undefined
  if (life && to && life.advice.ok && !hidden('promptCacheTtl')) {
    const c = life.advice.cost
    const cost = (t: Ttl) => (t === '5m' ? c.fiveMin : c.oneHour)
    const name = (t: Ttl) => ttlText(TTL_MS[t])
    out.push({
      id: 'promptCacheTtl',
      title: 'Cache life',
      from: name(life.current),
      to: name(to),
      now: `${usd(cost(life.current))} in cache writes${life.current === '5m' ? ' and keep warm' : ''}`,
      after: `${usd(cost(to))}  →  ${usd(life.advice.saving)} less`,
      basis: `Estimated: your last ${c.turns} turns priced at each cache life.`,
      saving: life.advice.saving,
    })
  }
  return { enough: true, prompts: rated.length, days, suggestions: out }
}

/** The checkbox, the row and the change, as the pane and the text show it. */
export const suggestionHead = (s: Suggestion, picked: boolean) => `${picked ? '☑' : '☐'} ${s.title}: ${s.from} → ${s.to}`

/** The lines under a suggestion's head. */
export const suggestionBody = (s: Suggestion) => [`Now:  ${s.now}`, `With ${s.to}:  ${s.after}`, s.basis, ...(s.note ? [s.note] : [])]

/** Apply selected with no row ticked. */
export const OPT_NONE_TICKED = 'Nothing ticked: press Enter on a row to tick it, or use Apply all.'
export const OPT_LEAD = 'Suggestions only: nothing changes until you apply them.'
export const optPeriod = (subscription: boolean) => `Last ${OPT_DAYS} days${subscription ? ', API-equivalent dollars (you pay only your subscription)' : ''}.`

/** The command's text: what the pane shows, for the transcript, -p and a surface with no pane. */
export function optimizeText(r: OptResult, subscription: boolean, pane: boolean) {
  if (!r.enough) return `Not enough use to judge yet (${r.prompts} rated prompts over ${r.days} days; needs ${OPT_MIN_PROMPTS} over ${OPT_MIN_DAYS} days).`
  if (!r.suggestions.length) return `No changes to suggest. Your settings fit your last ${OPT_DAYS} days.`
  const rows = r.suggestions.flatMap(s => ['', suggestionHead(s, false), ...suggestionBody(s).map(b => `    ${b}`)])
  const how = pane ? 'Pick the ones to apply in the pane: Enter ticks a row, then Apply selected or Apply all. Esc changes nothing.' : 'Change them in /rightsize (settings) or /config. Nothing was changed.'
  return [OPT_LEAD, optPeriod(subscription), ...rows, '', how].join('\n')
}

/** What the person sees after applying: the rows changed, and any Claude Code refused. */
export function appliedText(done: readonly Suggestion[], refused: readonly Suggestion[]) {
  if (!done.length && !refused.length) return 'Nothing changed.'
  const said = (list: readonly Suggestion[]) => list.map(s => `${s.title} → ${s.to}`).join('; ')
  return [done.length ? `Changed: ${said(done)}. Did it work? in /rightsize report measures each once there are enough prompts.` : '', refused.length ? `Not changed (Claude Code did not take it): ${said(refused)}.` : ''].filter(Boolean).join(' ')
}
