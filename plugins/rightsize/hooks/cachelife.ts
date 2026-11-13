import { type Prices, type Ttl, TIERS, TTL_MS, atPrompt, money, ttlText } from './cost'
import type { RightsizeTier as Tier } from '../types'
import { pingCost, pingsFor } from './warm'
import type { RunLine } from './report'

// Cache-life advice (P-16, rightsize ADR 0063). Once a month, the last 30 days of main-chat turns are priced two ways:
// a 5-minute prompt cache with rightsize's keep warm, and a 1-hour prompt cache. If the cheaper one is not the life Claude Code
// reads now, the band asks once whether to set Claude Code's `promptCacheTtl` to it. Pure functions here (run lines in, numbers
// and words out); register.tsx reads the setting, the provider and the billing, and writes the setting on the person's answer.
//
// Only what the cache life changes is priced; reads, input and output are the same either way and cancel out:
//   - the new tokens each turn writes to the cache, at the life's write price (1.25x input for 5 minutes, 2x for 1 hour);
//   - each idle gap between two turns of a session that is longer than the life: on 5 minutes, the cheaper of rightsize's keep-warm
//     requests (one read of the conversation each `pingEvery`) and coming back cold (the conversation written again, less a read);
//     on 1 hour, coming back cold.
// Not priced: Claude Code's own idle compaction (a 1-hour session of 200K tokens or more is compacted after 54 minutes, which makes
// a cold return cheaper than priced here), the plan hours keep warm is limited to, and the 5-minute gaps inside one turn.
// The Claude Code version (2.1.242 or later, where promptCacheTtl exists) is not checked: hooks cannot read it, and rightsize's
// mod API needs a newer Claude Code than that.

/** Days of turns priced, and the least a check needs: turns and days with a turn. Starting values; can be tuned. */
export const LIFE_DAYS = 30
export const LIFE_MIN_TURNS = 30
export const LIFE_MIN_DAYS = 7
/** Under this many dollars apart the two lives tie and nothing is asked. */
export const LIFE_TIE = 0.005
/** How many responses with cache writes are looked at, after a switch to 1 hour on a cloud provider or gateway, before it is set back. */
export const PROBE_RESPONSES = 3
/** The share of a response's cache writes that must be 1-hour writes for it to count. */
export const PROBE_SHARE = 0.9

const DAY = 24 * 60 * 60 * 1000
const on = (v: unknown) => v === '1' || v === 'true'

// ---- Provider ---------------------------------------------------------------------------------------------------------

export type Provider = 'anthropic' | 'bedrock' | 'vertex' | 'gateway'

/**
 * Where the requests go, from the environment variables Claude Code reads: Bedrock, Vertex, or an ANTHROPIC_BASE_URL on a host
 * that is not Anthropic's (a gateway). There is no direct detection; an unreadable variable counts as not set.
 */
export function providerOf(env: { bedrock?: string; vertex?: string; baseUrl?: string }): Provider {
  if (on(env.bedrock)) return 'bedrock'
  if (on(env.vertex)) return 'vertex'
  const url = env.baseUrl?.trim()
  if (url) {
    const host = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/@?#]*@)?([^/:?#]+)/i.exec(url)?.[1]?.toLowerCase()
    return host === 'anthropic.com' || host?.endsWith('.anthropic.com') ? 'anthropic' : 'gateway'
  }
  return 'anthropic'
}

/** "Amazon Bedrock", "Google Vertex AI" or "gateway": the provider as the band names it. */
export const providerName = (p: Provider) => (p === 'bedrock' ? 'Amazon Bedrock' : p === 'vertex' ? 'Google Vertex AI' : 'gateway')

/**
 * Whether cache-life advice may show: on a cloud provider or a gateway (billed per token), on an API key, or on a subscription
 * drawing on usage credits. A subscription inside its plan pays no per-token price, so it is silent there, 1-hour read life or not.
 * `billing` is what the rate limits or the person's answer showed; undefined (not known) is silent on Anthropic's own endpoint.
 */
export function lifeEligible(i: { provider: Provider; billing: 'api' | 'subscription' | undefined; onCredits: boolean }): boolean {
  if (i.provider !== 'anthropic') return true
  if (i.billing === 'api') return true
  return i.billing === 'subscription' && i.onCredits
}

/**
 * The settings write takes effect only when nothing above `promptCacheTtl` in Claude Code's order decides the life:
 * FORCE_PROMPT_CACHING_5M and CLAUDE_CODE_PROMPT_CACHE_TTL do. `by` is what decided the life now (`resolveTtl`).
 */
export const settingDecides = (by: string) => by !== 'FORCE_PROMPT_CACHING_5M' && by !== 'CLAUDE_CODE_PROMPT_CACHE_TTL'

// ---- Pricing ----------------------------------------------------------------------------------------------------------

/** One main-chat turn, as its run line says: when it was sent and ended, its model's tier and the conversation's size before and after. */
export type LifeTurn = { session: string; sentAt: number; endedAt: number; tier: Tier; start: number; end: number }

const isTier = (v: unknown): v is Tier => (TIERS as readonly unknown[]).includes(v)

/** The main-chat turns of the run lines in the last 30 days that carry the size they ended at (`contextEnd`, from 0.13); oldest first. */
export function lifeTurns(lines: readonly RunLine[], now: number): LifeTurn[] {
  const out: LifeTurn[] = []
  for (const l of lines) {
    if ((l.kind ?? 'run') !== 'run') continue
    const row = l as RunLine & { switched?: unknown }
    const endedAt = Date.parse(l.at)
    if (!(now - endedAt <= LIFE_DAYS * DAY) || !(endedAt <= now)) continue
    const end = l.contextEnd
    const tier = isTier(row.switched) ? row.switched : isTier(l.tier) ? l.tier : undefined
    if (typeof end !== 'number' || !(end > 0) || !tier || typeof l.session !== 'string') continue
    const sent = l.submittedAt ? Date.parse(l.submittedAt) : endedAt - (typeof l.durationMs === 'number' ? l.durationMs : 0)
    out.push({ session: l.session, sentAt: Number.isFinite(sent) ? sent : endedAt, endedAt, tier, start: typeof l.context === 'number' && l.context > 0 ? l.context : 0, end })
  }
  return out.sort((a, b) => a.endedAt - b.endedAt)
}

export type LifeCost = {
  /** Dollars of what the cache life changes, over the turns, on each life. */
  fiveMin: number
  oneHour: number
  turns: number
  /** Days with a turn. */
  days: number
}

/** The two lives priced over the turns. `p5` and `p1` are the same prices with cache writes at 1.25x and at 2x input. */
export function priceLives(turns: readonly LifeTurn[], p5: Prices, p1: Prices): LifeCost {
  const cost: LifeCost = { fiveMin: 0, oneHour: 0, turns: turns.length, days: new Set(turns.map(t => new Date(t.endedAt).toISOString().slice(0, 10))).size }
  const bySession = new Map<string, LifeTurn[]>()
  for (const t of turns) bySession.set(t.session, [...(bySession.get(t.session) ?? []), t])
  for (const list of bySession.values()) {
    list.sort((a, b) => a.endedAt - b.endedAt)
    list.forEach((t, i) => {
      // What this turn added to the conversation: its size now less the size the session's last turn ended at (a first turn here
      // starts from the size the run line says it began at). A conversation that got smaller (a compact) was written again whole.
      const from = list[i - 1]?.end ?? t.start
      const added = t.end >= from ? t.end - from : t.end
      const a = atPrompt(p5[t.tier], t.end)
      const b = atPrompt(p1[t.tier], t.end)
      cost.fiveMin += (added * a.cacheWrite) / 1e6
      cost.oneHour += (added * b.cacheWrite) / 1e6
      const next = list[i + 1]
      if (!next) return
      const gap = next.sentAt - t.endedAt
      if (gap > TTL_MS['5m']) cost.fiveMin += Math.min(pingsFor(gap, TTL_MS['5m']) * pingCost(a, t.end), (t.end * (a.cacheWrite - a.cacheRead)) / 1e6)
      if (gap > TTL_MS['1h']) cost.oneHour += (t.end * (b.cacheWrite - b.cacheRead)) / 1e6
    })
  }
  return cost
}

export type LifeAdvice =
  | { ok: false; turns: number; days: number }
  /** `cheaper`: the life that costs less by at least LIFE_TIE; undefined when they tie. `saving`: what it saves over the other, in dollars. */
  | { ok: true; cost: LifeCost; cheaper: Ttl | undefined; saving: number }

/** The check: not enough turns or days yet, or the priced lives and which one is cheaper. */
export function adviseLife(lines: readonly RunLine[], now: number, p5: Prices, p1: Prices): LifeAdvice {
  const turns = lifeTurns(lines, now)
  const cost = priceLives(turns, p5, p1)
  if (cost.turns < LIFE_MIN_TURNS || cost.days < LIFE_MIN_DAYS) return { ok: false, turns: cost.turns, days: cost.days }
  const diff = cost.fiveMin - cost.oneHour
  return { ok: true, cost, cheaper: Math.abs(diff) < LIFE_TIE ? undefined : diff > 0 ? '1h' : '5m', saving: Math.abs(diff) }
}

/** The life to offer: the cheaper one, when it is not the life read now. */
export const lifeOffer = (a: LifeAdvice, current: Ttl): Ttl | undefined => (a.ok && a.cheaper !== undefined && a.cheaper !== current ? a.cheaper : undefined)

// ---- Words ------------------------------------------------------------------------------------------------------------

export const LIFE_HEADER = 'Cache life'
export const LIFE_YES = 'yes'
export const LIFE_NO = 'no'

const LIFE_NAME: Record<Ttl, string> = { '5m': 'a 5-minute prompt cache with keep warm', '1h': 'a 1-hour prompt cache' }

/** The band's question: what the last 30 days say, what is counted, and the one change that is asked about. */
export function lifeQuestion(to: Ttl, a: Extract<LifeAdvice, { ok: true }>) {
  const other: Ttl = to === '1h' ? '5m' : '1h'
  return `Over your last 30 days (${a.cost.turns} prompts), ${LIFE_NAME[to]} would have cost about ${money(a.saving)} less than ${LIFE_NAME[other]}. This counts only what cache life changes: cache writes, keep-warm requests and cold returns. Set Claude Code's cache life to ${ttlText(TTL_MS[to])} for this project?`
}

/** The label of the answer that makes the change. */
export const lifeYes = (to: Ttl) => `Use ${ttlText(TTL_MS[to])}`

/** What the band says after the change was made. */
export const lifeSetText = (to: Ttl) => `Cache life set to ${ttlText(TTL_MS[to])}. Did it work? in /rightsize report measures it once there are enough prompts.`

/** What the band says when Claude Code did not take the change. */
export const lifeRefusedText = (to: Ttl) => `Cache life stays as it was: Claude Code did not take ${ttlText(TTL_MS[to])}.`

/** What the band says when the change was set back because the cache writes were not 1-hour writes. */
export const lifeRevertedText = (p: Provider, back: Ttl) =>
  `Cache life set back to ${ttlText(TTL_MS[back])}: your ${providerName(p)} did not write 1-hour cache entries, so the change gave no longer cache.`

/** What the band says when the setting should go back but Claude Code would not take it. */
export const lifeStuckText = (back: Ttl) => `The 1-hour cache was not written, and Claude Code would not set the cache life back. Set promptCacheTtl to ${back} in your Claude settings.`

// ---- Checking the writes after a switch to 1 hour ---------------------------------------------------------------------

/** The 1-hour part of what a response wrote to the cache, when its usage says (`cache_creation.ephemeral_1h_input_tokens`); undefined when it does not. */
export function writtenFor1h(usage: unknown): number | undefined {
  const cc = (usage as { cache_creation?: { ephemeral_1h_input_tokens?: unknown } } | null | undefined)?.cache_creation
  const n = cc?.ephemeral_1h_input_tokens
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined
}

/** How one response with cache writes reads: 'one-hour' (at least PROBE_SHARE of the writes are 1-hour writes), 'short' (they are not), 'unknown' (the usage has no 1-hour field). */
export function probeRead(usage: { cache_creation_input_tokens: number }): 'one-hour' | 'short' | 'unknown' {
  const h = writtenFor1h(usage)
  if (h === undefined) return 'unknown'
  return h >= usage.cache_creation_input_tokens * PROBE_SHARE ? 'one-hour' : 'short'
}
