import { autoAmount, turnCosts } from './bigturn'
import { type LifeAdvice, lifeOffer } from './cachelife'
import { type Ttl, TTL_MS, ttlText } from './cost'
import { type RunLine, keepWarm } from './report'

// /rightsize optimize (P-38, ADR 0084): rightsize's own settings that the last 30 days of the run log say should change, each
// with that period priced under the current setting and under the new one, so the person can judge the change. Only
// rightsize's rows (and the cache life it already offers): no advice on habits or on Claude Code's /model. Nothing changes
// here; register.tsx applies the ones the person picks. Pure functions.

const DAY = 24 * 60 * 60_000

export const OPT_DAYS = 30
/** Enough of the person's own use to judge from: rated prompts, over at least this many days. */
export const OPT_MIN_PROMPTS = 30
export const OPT_MIN_DAYS = 7
/** A suggestion the person left unpicked is not shown again for this long. */
export const OPT_SKIP_DAYS = 30
/** Keep warm is judged only on this many of its requests or more. */
export const OPT_MIN_PINGS = 5

/** What a suggestion changes: a rightsize row, or the cache life (Claude Code's promptCacheTtl, which rightsize offers and sets). */
export type OptId = 'beforeCold' | 'bigTurn' | 'promptCacheTtl'

/**
 * One suggestion: the row's title, the value now and the one suggested; `now` and `after` the last 30 days under each;
 * `basis` how the `after` figure was found; `saving` dollars over the 30 days, absent when no dollar figure is honest.
 */
export type Suggestion = { id: OptId; title: string; from: string; to: string; now: string; after: string; basis: string; saving?: number }

export type OptInput = {
  lines: readonly RunLine[]
  now: number
  subscription: boolean
  /** The rows' values now. */
  beforeCold: string
  bigTurn: string
  /** The cache-life check, when rightsize may set the life (cachelife.ts lifeEligible, and no variable fixes it); undefined otherwise. */
  life?: { advice: LifeAdvice; current: Ttl }
  /** When each suggestion was last left unpicked, ms. */
  skipped: Partial<Record<OptId, number>>
}

export type OptResult = { enough: boolean; prompts: number; days: number; suggestions: Suggestion[] }

const usd = (x: number) => `$${(Math.round(Math.abs(x) * 100) / 100).toFixed(2)}`
const isRated = (l: RunLine) => (l.kind ?? 'run') === 'run'

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

  // Before the cache goes cold: keep warm that cost more than it saved, measured on its own requests and returns.
  const warm = keepWarm(month)
  const pings = month.filter(l => l.kind === 'warm').length
  if (i.beforeCold !== 'off' && warm && pings >= OPT_MIN_PINGS && warm.net <= -0.005 && !hidden('beforeCold')) {
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

  // Big-turn warning: off, while turns reached the amount auto would warn at. What a warning saves depends on the answer.
  if (i.bigTurn === 'off' && !hidden('bigTurn')) {
    const amount = autoAmount(i.lines, i.now)
    const big = turnCosts(i.lines, i.now).filter(c => c >= amount)
    if (big.length) {
      const total = big.reduce((n, c) => n + c, 0)
      out.push({
        id: 'bigTurn',
        title: 'Big-turn warning',
        from: 'off',
        to: 'auto',
        now: 'no warning',
        after: `would have warned before ${big.length} ${big.length === 1 ? 'turn' : 'turns'} of ${usd(amount)} or more, ${usd(total)} in all`,
        basis: 'No saving is promised: it depends on what you choose when warned.',
      })
    }
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
export const suggestionBody = (s: Suggestion) => [`Now:  ${s.now}`, `With ${s.to}:  ${s.after}`, s.basis]

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
