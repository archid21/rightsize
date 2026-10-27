import { expect, test } from 'claude-code/testing'
import { DEFAULT_PRICES, idleCost } from './cost'
import { COLD_MIN, DEFAULT_START, breakEvenMs, breakEvenPings, clockText, coldPlan, isCacheClock, isGroundwork, keepWarmChoices, leadMs, nextStart, offerText, pingCost, pingEvery, pingsFor, usualStart, warmPlan, warmingText } from './warm'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const OPUS = DEFAULT_PRICES.opus
/** Local time, so the tests hold in any time zone. */
const local = (day: number, h: number, m = 0) => new Date(2027, 0, day, h, m, 0, 0).getTime()
const usd = (d: number) => `$${d.toFixed(2)}`

test('the lead is 3 minutes before a 1-hour cache expires and 1 minute before a 5-minute one, and pings come each cache life less the lead', async () => {
  expect(leadMs(HOUR)).toBe(3 * MIN)
  expect(leadMs(5 * MIN)).toBe(MIN)
  expect(pingEvery(HOUR)).toBe(57 * MIN)
  expect(pingEvery(5 * MIN)).toBe(4 * MIN)
})

test('a ping is priced from its usage, and from a cache read of the whole conversation when the usage is missing', async () => {
  expect(Number(pingCost(OPUS, 80_000).toFixed(6))).toBe(0.016)
  expect(Number(pingCost(OPUS, 80_000, { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 80_000, cache_creation_input_tokens: 0 }).toFixed(6))).toBe(0.016128)
  // A ping that found the cache gone wrote the conversation again: that is what it cost.
  expect(pingCost(OPUS, 80_000, { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 80_000 })).toBeGreaterThan(0.6)
})

test('the number of pings is the number of times one falls before the end', async () => {
  expect(pingsFor(2 * HOUR, HOUR), 'at 57 and 114 minutes; the next, at 171, is past 2 hours').toBe(2)
  expect(pingsFor(8 * HOUR, HOUR)).toBe(8)
  expect(pingsFor(57 * MIN, HOUR), 'the cache itself lives that long: the first ping would land at the end').toBe(0)
  expect(pingsFor(0, HOUR)).toBe(0)
  expect(pingsFor(30 * MIN, 5 * MIN), 'every 4 minutes').toBe(7)
  expect(pingsFor(HOUR, 5 * MIN)).toBe(14)
})

test('break-even: how many pings cost no more than coming back cold, and how long that lasts', async () => {
  const context = 150_500
  const p5 = { ...OPUS, cacheWrite: 5 }
  const cold = idleCost(p5, context).resend
  const ping = pingCost(p5, context)
  expect(breakEvenPings(cold, ping), 'a write costs 24 reads more than a read on Opus with a 5-minute write: floating point does not cost the last one').toBe(24)
  expect(breakEvenMs(cold, ping, 5 * MIN) / MIN, '24 pings, 4 minutes apart').toBe(96)
  const c1 = idleCost(OPUS, 80_500).resend
  expect(breakEvenPings(c1, pingCost(OPUS, 80_500)), 'a 1-hour write: 39 reads').toBe(39)
  expect(breakEvenPings(1, 0), 'a free ping never stops').toBe(Infinity)
})

test('a keep-warm plan is capped at break-even, and says where the cache stays warm until', async () => {
  const base = { ttl: HOUR, endedAt: 1000, cold: 0.63, ping: 0.016 }
  const two = warmPlan({ ...base, ms: 2 * HOUR })
  expect(two).toMatchObject({ pings: 2, wanted: 2, capped: false })
  expect(Number(two.cost.toFixed(6))).toBe(0.032)
  expect(two.endsAt, 'the chosen end: the last ping keeps it warm past that').toBe(1000 + 2 * HOUR)
  // 8 hours at a ping costing a quarter of a cold return: 4 pings is as many as pay.
  const capped = warmPlan({ ...base, ping: 0.63 / 4, ms: 8 * HOUR })
  expect(capped).toMatchObject({ pings: 4, wanted: 8, capped: true })
  expect(capped.endsAt, 'the last ping at 4 x 57 minutes, and an hour after it').toBe(1000 + 4 * 57 * MIN + HOUR)
  expect(warmPlan({ ...base, ping: 1, ms: 2 * HOUR }), 'one ping costs more than a cold return: none').toMatchObject({ pings: 0, capped: true })
})

test('the usual start time is the median first prompt of each day over 14 days, rounded to 15 minutes', async () => {
  const now = local(20, 15)
  const day = (d: number, h: number, m: number, more: Record<string, unknown> = {}) => ({ at: new Date(local(d, h, m + 40)).toISOString(), submittedAt: new Date(local(d, h, m)).toISOString(), kind: 'run', ...more })
  const lines = [
    // Five days; each day's first prompt counts, not its later ones.
    day(15, 8, 20), day(15, 13, 0), day(16, 9, 5), day(17, 8, 50), day(18, 9, 40), day(19, 8, 30), day(19, 17, 45),
  ]
  // 8:20, 9:05, 8:50, 9:40, 8:30: the median is 8:50, which rounds to 8:45.
  expect(usualStart(lines, now)).toEqual({ minutes: 8 * 60 + 45, days: 5, fallback: false })
  // An even number of days: the middle two average (8:50 and 9:05 make 8:57.5, which rounds to 9:00).
  expect(usualStart([...lines, day(14, 9, 50)], now)).toMatchObject({ minutes: 9 * 60, days: 6 })
  // Rounded to the nearest 15 minutes.
  const early = [day(15, 6, 5), day(16, 6, 5), day(17, 6, 5), day(18, 6, 5), day(19, 6, 5)]
  expect(usualStart(early, now).minutes).toBe(6 * 60)
  const late = [day(15, 7, 53), day(16, 7, 53), day(17, 7, 53), day(18, 7, 53), day(19, 7, 53)]
  expect(usualStart(late, now).minutes, '7:53 is 8:00').toBe(8 * 60)
})

test('the usual start time is 9:00 with fewer than 5 days of data, and the log lines it ignores', async () => {
  const now = local(20, 15)
  const at = (d: number, h: number) => ({ at: new Date(local(d, h)).toISOString(), kind: 'run' })
  expect(usualStart([], now)).toEqual({ minutes: DEFAULT_START, days: 0, fallback: true })
  expect(DEFAULT_START).toBe(540)
  expect(usualStart([at(15, 6), at(16, 6), at(17, 6), at(18, 6)], now), 'four days say nothing').toMatchObject({ minutes: 540, days: 4, fallback: true })
  // Two lines on one day are one day; older than 14 days, or not a run, do not count.
  const five = [at(15, 6), at(15, 7), at(16, 6), at(17, 6), at(18, 6), at(19, 6)]
  expect(usualStart(five, now)).toMatchObject({ minutes: 360, days: 5, fallback: false })
  const four = [at(15, 6), at(16, 6), at(17, 6), at(18, 6)]
  expect(usualStart([...four, { at: new Date(local(1, 6)).toISOString(), kind: 'run' }], now), 'over 14 days ago').toMatchObject({ days: 4, fallback: true })
  expect(usualStart([...four, { ...at(19, 6), kind: 'warm' }], now), 'a keep-warm line is no prompt').toMatchObject({ days: 4, fallback: true })
  // `at` is when a turn ended: the day starts when its prompt was submitted.
  const submitted = [15, 16, 17, 18, 19].map(d => ({ at: new Date(local(d, 10)).toISOString(), submittedAt: new Date(local(d, 8, 0)).toISOString() }))
  expect(usualStart(submitted, now).minutes).toBe(8 * 60)
})

test('the next start: the next time the clock reads that, with whether it is tomorrow', async () => {
  const evening = nextStart(local(15, 18), 9 * 60 + 15)
  expect(evening).toEqual({ at: local(16, 9, 15), tomorrow: true })
  const earlyHours = nextStart(local(15, 2), 9 * 60)
  expect(earlyHours, 'at 2 a.m. the next 9:00 is the same day').toEqual({ at: local(15, 9), tomorrow: false })
  expect(nextStart(local(15, 9), 9 * 60).tomorrow, 'at 9:00 sharp the next one is tomorrow').toBe(true)
  expect(clockText(local(16, 9, 5))).toBe('9:05')
  expect(clockText(local(16, 14, 30))).toBe('14:30')
})

test('the offer on a 1-hour cache: 2 h, 8 h and until the usual start, each priced; the usual start hidden when it costs more than coming back cold', async () => {
  const ping = 0.016
  const o = { ttl: HOUR, endedAt: local(15, 18), cold: 0.63, ping, startMinutes: 9 * 60, tag: usd }
  const choices = keepWarmChoices(o)
  // 18:00 to 9:00 is 15 hours: 15 pings.
  expect(choices.map(c => c.label)).toEqual(['Keep warm 2 h · $0.03', 'Keep warm 8 h · $0.13', 'Until 9:00 tomorrow · $0.24'])
  expect(choices.map(c => c.id)).toEqual(['2h', '8h', 'start'])
  expect(choices[2]?.endsAt).toBe(local(16, 9))
  // Pricier pings: 15 of them cost more than a cold return.
  expect(keepWarmChoices({ ...o, ping: 0.05 }).map(c => c.id), '15 x $0.05 is $0.75, over $0.63').toEqual(['2h', '8h'])
  expect(keepWarmChoices({ ...o, ping: 0.1 }).map(c => c.id), '8 x $0.10 is $0.80').toEqual(['2h'])
  expect(keepWarmChoices({ ...o, ping: 0.4 }), 'two pings cost more than a cold return').toEqual([])
  // A turn that ends at 5 a.m.: the usual 9:00 is 4 hours away, labelled with no "tomorrow".
  expect(keepWarmChoices({ ...o, endedAt: local(15, 5) }).map(c => c.label)).toEqual(['Keep warm 2 h · $0.03', 'Keep warm 8 h · $0.13', 'Until 9:00 · $0.06'])
  // A turn that ends at 8 a.m.: 9:00 is inside the 2 h choice.
  expect(keepWarmChoices({ ...o, endedAt: local(15, 8) }).map(c => c.id)).toEqual(['2h', '8h'])
})

test('the offer on a 5-minute cache: only 30 min and 1 h, and only when they cost less than coming back cold', async () => {
  const o = { ttl: 5 * MIN, endedAt: local(15, 18), cold: 0.72, ping: 0.03, startMinutes: 9 * 60, tag: usd }
  expect(keepWarmChoices(o).map(c => c.label), '7 and 14 pings').toEqual(['Keep warm 30 min · $0.21', 'Keep warm 1 h · $0.42'])
  expect(keepWarmChoices({ ...o, ping: 0.06 }).map(c => c.id), '14 x $0.06 is $0.84, over $0.72').toEqual(['30m'])
  expect(keepWarmChoices({ ...o, ping: 0.12 }), '7 x $0.12 is $0.84').toEqual([])
})

test('the offer text names the time, the size, the model and the cold cost; a 5-minute cache adds where keeping warm stops paying', async () => {
  const one = { ttl: HOUR, context: 80_500, model: 'Opus', coldText: 'about $0.63', breakEven: 39 * 57 * MIN }
  expect(offerText(one)).toBe('Cache goes cold in ~60 min (81K tokens on Opus). Coming back cold: about $0.63.')
  expect(offerText({ ...one, ttl: 5 * MIN, breakEven: 96 * MIN })).toBe(
    'Cache goes cold in ~5 min (81K tokens on Opus). Coming back cold: about $0.63. Keeping warm past about 96 min costs more than coming back cold.',
  )
  expect(offerText({ ...one, coldText: '~0.8–1.6% of your 5-hour window ($0.63 API-equivalent)' })).toContain('Coming back cold: ~0.8–1.6% of your 5-hour window ($0.63 API-equivalent).')
})

test('the keep-warm line says until when, and how many pings so far', async () => {
  const until = local(15, 22, 5)
  expect(warmingText({ until, pings: 0, spentText: '$0.00' })).toBe('Keeping warm until 22:05 · no pings yet')
  expect(warmingText({ until, pings: 1, spentText: '$0.02' })).toBe('Keeping warm until 22:05 · 1 ping, $0.02 so far')
  expect(warmingText({ until, pings: 3, spentText: '$0.05' })).toBe('Keeping warm until 22:05 · 3 pings, $0.05 so far')
})

test('each row value is a plan: a handoff without Groundwork is a compaction, and an unknown value asks', async () => {
  expect(coldPlan('ask', true)).toEqual({ action: 'ask' })
  expect(coldPlan('keep warm 2 h', false)).toEqual({ action: 'warm', hours: 2 })
  expect(coldPlan('keep warm 8 h', true)).toEqual({ action: 'warm', hours: 8 })
  expect(coldPlan('save a handoff', true)).toEqual({ action: 'handoff' })
  expect(coldPlan('save a handoff', false)).toEqual({ action: 'compact' })
  expect(coldPlan('compact', true)).toEqual({ action: 'compact' })
  expect(coldPlan('off', true)).toEqual({ action: 'off' })
  expect(coldPlan('something else', true)).toEqual({ action: 'ask' })
})

test('Cache Clock and Groundwork are found by plugin name', async () => {
  for (const name of ['cache-clock', 'cache_clock', 'Cache Clock', 'cacheclock', 'cache-clock@ben-ai']) expect(isCacheClock(name), name).toBe(true)
  for (const name of ['groundwork', 'cache', 'clock', undefined]) expect(isCacheClock(name), String(name)).toBe(false)
  expect(isGroundwork('groundwork')).toBe(true)
  expect(isGroundwork('groundwork@archid21')).toBe(true)
  expect(isGroundwork('groundwork-lite')).toBe(false)
  expect(isGroundwork(undefined)).toBe(false)
})

test('the cold cost that triggers it is $0.50: about 64K tokens on Opus and 128K on Sonnet with a 1-hour cache, and never on Haiku', async () => {
  expect(COLD_MIN).toBe(0.5)
  const tokensFor = (p: typeof OPUS) => Math.ceil((COLD_MIN * 1e6) / (p.cacheWrite - p.cacheRead) / 1000)
  expect(tokensFor(DEFAULT_PRICES.opus)).toBe(65)
  expect(tokensFor(DEFAULT_PRICES.sonnet)).toBe(129)
  // Haiku would need 2.6 million tokens: past the window.
  expect(tokensFor(DEFAULT_PRICES.haiku)).toBeGreaterThan(2_000)
  expect(DAY).toBe(86_400_000)
})
