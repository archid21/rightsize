import { expect, test } from 'claude-code/testing'
import { LIFE_MIN_DAYS, LIFE_MIN_TURNS, LIFE_TIE, adviseLife, lifeEligible, lifeOffer, lifeQuestion, lifeRevertedText, lifeSetText, lifeTurns, priceLives, probeRead, providerOf, settingDecides, writtenFor1h } from './cachelife'
import { parsePrices } from './cost'
import type { RunLine } from './report'

// Cache-life advice (P-16): the last 30 days priced on a 5-minute cache with keep warm and on a 1-hour cache, who may be asked,
// and how the writes after a switch to 1 hour are read. Opus prices: input $4, cache read $0.20; a write is $5 on 5 minutes, $8 on 1 hour.

const MIN = 60_000
const DAY = 24 * 60 * MIN
const NOW = Date.UTC(2027, 0, 20, 12, 0, 0)
const r6 = (n: number) => Math.round(n * 1e6) / 1e6
const P5 = parsePrices('{}', '5m')
const P1 = parsePrices('{}', '1h')

type Spec = { session: string; ago: number; start: number; end: number; tier?: string; extra?: Partial<RunLine> & Record<string, unknown> }
/** One run line: the turn ended `ago` ms before NOW and was sent a minute before it ended; it took the conversation from `start` to `end` tokens. */
const line = (s: Spec): RunLine =>
  ({
    kind: 'run',
    at: new Date(NOW - s.ago).toISOString(),
    submittedAt: new Date(NOW - s.ago - MIN).toISOString(),
    session: s.session,
    tier: s.tier ?? 'opus',
    context: s.start,
    contextEnd: s.end,
    ...s.extra,
  }) as RunLine

/** `days` days of `perDay` turns each, one session a day, `gap` between a turn's end and the next prompt, each turn adding `added` tokens to a conversation of `base`. */
function month(o: { days?: number; perDay?: number; gap: number; added: number; base?: number }): RunLine[] {
  const out: RunLine[] = []
  const perDay = o.perDay ?? 4
  for (let d = 0; d < (o.days ?? 10); d++) {
    for (let i = 0; i < perDay; i++) {
      const start = (o.base ?? 100_000) + i * o.added
      // The turn lasts a minute; the next one is sent `gap` after this one ends.
      const ended = (d + 1) * DAY - i * (o.gap + MIN)
      out.push(line({ session: `s${d}`, ago: ended, start, end: start + o.added }))
    }
  }
  return out
}

test('a 5-minute gap or shorter costs no cold return on either life; every turn writes its own tokens at the life\'s price', () => {
  // The second turn was sent 3 minutes after the first ended.
  const lines = [line({ session: 'a', ago: 20 * MIN, start: 0, end: 10_000 }), line({ session: 'a', ago: 16 * MIN, start: 10_000, end: 12_000 })]
  const c = priceLives(lifeTurns(lines, NOW), P5, P1)
  // 12,000 tokens written in all: $5 and $8 per million.
  expect(r6(c.fiveMin)).toBe(r6(0.06))
  expect(r6(c.oneHour)).toBe(r6(0.096))
  expect(c.turns).toBe(2)
})

test('both directions: long gaps under an hour make 1 hour cheaper; quick turns that add much make 5 minutes cheaper', () => {
  // 24-minute gaps: 5 minutes pays 4 keep-warm reads of 100K (about $0.02 each) or a cold return; 1 hour pays nothing for the gap.
  const long = adviseLife(month({ gap: 24 * MIN, added: 2_000 }), NOW, P5, P1)
  expect(long.ok && long.cheaper).toBe('1h')
  // Gaps of a minute: no gap costs anything, and 1 hour pays $3 per million more on 20K added every turn.
  const quick = adviseLife(month({ gap: MIN, added: 20_000 }), NOW, P5, P1)
  expect(quick.ok && quick.cheaper).toBe('5m')
  if (quick.ok) expect(r6(quick.saving)).toBe(r6(quick.cost.oneHour - quick.cost.fiveMin))
})

test('keep warm is capped by a cold return: past the break-even a long gap costs the cold return, not more', () => {
  // One gap of nearly 9 hours on 100K tokens: 5 minutes' pings (about $0.02 each) would cost more than a cold return, (5 - 0.2) x 0.1 = $0.48. 1 hour: (8 - 0.2) x 0.1 = $0.78.
  const lines = [line({ session: 'a', ago: 9 * 60 * MIN, start: 100_000, end: 100_000 }), line({ session: 'a', ago: 0, start: 100_000, end: 100_000 })]
  const c = priceLives(lifeTurns(lines, NOW), P5, P1)
  expect(r6(c.fiveMin)).toBe(r6(0.48))
  expect(r6(c.oneHour)).toBe(r6(0.78))
})

test('a gap over 5 minutes costs 5 minutes only keep-warm pings, and 1 hour nothing', () => {
  // A 12-minute gap on 100K tokens: 5 minutes pings twice (ceil(12 / 4) - 1) at $0.02; 1 hour pays nothing.
  const lines = [line({ session: 'a', ago: 20 * MIN, start: 100_000, end: 100_000 }), line({ session: 'a', ago: 7 * MIN, start: 100_000, end: 100_000 })]
  // The first turn ended 20 minutes ago and the second was sent 8 minutes ago: a 12-minute gap.
  const c = priceLives(lifeTurns(lines, NOW), P5, P1)
  expect(r6(c.fiveMin)).toBe(r6(2 * 0.02))
  expect(c.oneHour).toBe(0)
})

test('a turn adds its size less the last turn\'s end; a conversation that got smaller was written again whole', () => {
  // The second turn says it began at 1,000 but the session's first turn ended at 50,000: the size it began at is the last end.
  const lines = [line({ session: 'a', ago: 30 * MIN, start: 0, end: 50_000 }), line({ session: 'a', ago: 10 * MIN, start: 1_000, end: 8_000 })]
  const c = priceLives(lifeTurns(lines, NOW), P5, P1)
  expect(r6(c.oneHour)).toBe(r6((50_000 * 8 + 8_000 * 8) / 1e6))
})

test('a tie asks nothing; so does the life that is already the cheaper one', () => {
  // Nothing added and no gap: both cost nothing.
  const flat = adviseLife(month({ gap: MIN, added: 0 }), NOW, P5, P1)
  expect(flat.ok && flat.cheaper, 'a tie').toBeUndefined()
  expect(lifeOffer(flat, '5m')).toBeUndefined()
  expect(lifeOffer(flat, '1h')).toBeUndefined()
  // Under half a cent apart is a tie too.
  expect(LIFE_TIE).toBe(0.005)
  const long = adviseLife(month({ gap: 24 * MIN, added: 2_000 }), NOW, P5, P1)
  expect(lifeOffer(long, '5m'), 'on 5 minutes, 1 hour is cheaper: offered').toBe('1h')
  expect(lifeOffer(long, '1h'), 'already on the cheaper one').toBeUndefined()
  const quick = adviseLife(month({ gap: MIN, added: 20_000 }), NOW, P5, P1)
  expect(lifeOffer(quick, '1h'), 'on 1 hour, 5 minutes is cheaper: offered').toBe('5m')
  expect(lifeOffer(quick, '5m')).toBeUndefined()
})

test('too few turns or days is not a check', () => {
  const few = adviseLife(month({ gap: 24 * MIN, added: 2_000 }).slice(0, LIFE_MIN_TURNS - 1), NOW, P5, P1)
  expect(few).toMatchObject({ ok: false, turns: LIFE_MIN_TURNS - 1 })
  const short = adviseLife(month({ gap: 24 * MIN, added: 2_000, days: LIFE_MIN_DAYS - 1, perDay: 20 }), NOW, P5, P1)
  expect(short).toMatchObject({ ok: false, days: LIFE_MIN_DAYS - 1 })
})

test('only the last 30 days of run lines that carry the size they ended at, and only runs, are priced', () => {
  const old = line({ session: 'a', ago: 31 * DAY, start: 0, end: 10_000 })
  const noEnd = { ...line({ session: 'a', ago: DAY, start: 0, end: 10_000 }), contextEnd: undefined } as RunLine
  const warm = line({ session: 'a', ago: DAY, start: 0, end: 10_000, extra: { kind: 'warm' } })
  const noSession = { ...line({ session: 'a', ago: DAY, start: 0, end: 10_000 }), session: undefined } as RunLine
  const ok = line({ session: 'a', ago: DAY, start: 0, end: 10_000 })
  expect(lifeTurns([old, noEnd, warm, noSession, ok], NOW)).toHaveLength(1)
  // A turn that switched model is priced on the model it ran on.
  expect(lifeTurns([line({ session: 'a', ago: DAY, start: 0, end: 10_000, tier: 'sonnet', extra: { switched: 'opus' } })], NOW)[0]?.tier).toBe('opus')
})

test('provider: Bedrock, Vertex and a base URL that is not Anthropic\'s', () => {
  expect(providerOf({})).toBe('anthropic')
  expect(providerOf({ bedrock: '1' })).toBe('bedrock')
  expect(providerOf({ vertex: 'true' })).toBe('vertex')
  expect(providerOf({ bedrock: '0', vertex: '' })).toBe('anthropic')
  expect(providerOf({ baseUrl: 'https://llm-gateway.example.com/v1' })).toBe('gateway')
  expect(providerOf({ baseUrl: 'http://localhost:4000' })).toBe('gateway')
  expect(providerOf({ baseUrl: 'https://api.anthropic.com' })).toBe('anthropic')
  expect(providerOf({ baseUrl: 'https://anthropic.com.evil.example/' })).toBe('gateway')
  expect(providerOf({ baseUrl: '  ' })).toBe('anthropic')
})

test('who may be asked: an API key, a cloud provider or a gateway, usage credits; not a subscription inside its plan, nor an unknown billing on Anthropic\'s endpoint', () => {
  expect(lifeEligible({ provider: 'anthropic', billing: 'api', onCredits: false })).toBe(true)
  expect(lifeEligible({ provider: 'bedrock', billing: undefined, onCredits: false })).toBe(true)
  expect(lifeEligible({ provider: 'vertex', billing: 'api', onCredits: false })).toBe(true)
  expect(lifeEligible({ provider: 'gateway', billing: undefined, onCredits: false })).toBe(true)
  expect(lifeEligible({ provider: 'anthropic', billing: 'subscription', onCredits: true })).toBe(true)
  expect(lifeEligible({ provider: 'anthropic', billing: 'subscription', onCredits: false })).toBe(false)
  expect(lifeEligible({ provider: 'anthropic', billing: undefined, onCredits: true })).toBe(false)
  expect(lifeEligible({ provider: 'anthropic', billing: undefined, onCredits: false })).toBe(false)
})

test('the setting decides the life unless FORCE_PROMPT_CACHING_5M or the variable does', () => {
  expect(settingDecides('API billing')).toBe(true)
  expect(settingDecides('the promptCacheTtl setting')).toBe(true)
  expect(settingDecides('ENABLE_PROMPT_CACHING_1H')).toBe(true)
  expect(settingDecides('FORCE_PROMPT_CACHING_5M')).toBe(false)
  expect(settingDecides('CLAUDE_CODE_PROMPT_CACHE_TTL')).toBe(false)
})

test('reading the writes: the 1-hour field decides; no field is unknown', () => {
  expect(writtenFor1h({ cache_creation: { ephemeral_1h_input_tokens: 300, ephemeral_5m_input_tokens: 0 } })).toBe(300)
  expect(writtenFor1h({ cache_creation: {} })).toBeUndefined()
  expect(writtenFor1h(undefined)).toBeUndefined()
  const w = (cache_creation?: object) => ({ cache_creation_input_tokens: 1000, ...(cache_creation ? { cache_creation } : {}) })
  expect(probeRead(w({ ephemeral_1h_input_tokens: 1000, ephemeral_5m_input_tokens: 0 }))).toBe('one-hour')
  expect(probeRead(w({ ephemeral_1h_input_tokens: 900, ephemeral_5m_input_tokens: 100 }))).toBe('one-hour')
  expect(probeRead(w({ ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 1000 }))).toBe('short')
  expect(probeRead(w({ ephemeral_1h_input_tokens: 500, ephemeral_5m_input_tokens: 500 }))).toBe('short')
  expect(probeRead(w())).toBe('unknown')
})

test('the words are plain and say what is counted and for which project', () => {
  const a = adviseLife(month({ gap: 24 * MIN, added: 2_000 }), NOW, P5, P1)
  if (!a.ok) throw new Error('no advice')
  const q = lifeQuestion('1h', a)
  expect(q).toContain('Over your last 30 days (40 prompts), a 1-hour prompt cache would have cost about $')
  expect(q).toContain('less than a 5-minute prompt cache with keep warm.')
  expect(q).toContain('This counts only what cache life changes: cache writes, keep-warm requests and cold returns.')
  expect(q).toContain("Set Claude Code's cache life to 1 hour for this project?")
  expect(lifeQuestion('5m', a)).toContain('a 5-minute prompt cache with keep warm would have cost about')
  expect(lifeSetText('1h')).toBe('Cache life set to 1 hour. Did it work? in /rightsize report measures it once there are enough prompts.')
  expect(lifeRevertedText('bedrock', '5m')).toBe('Cache life set back to 5 minutes: your Amazon Bedrock did not write 1-hour cache entries, so the change gave no longer cache.')
  expect(lifeRevertedText('gateway', '5m')).toContain('your gateway did not write')
})
