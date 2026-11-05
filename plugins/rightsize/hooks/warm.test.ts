import { expect, test } from 'claude-code/testing'
import { DEFAULT_PRICES, idleCost } from './cost'
import { COMPACT_VALUE, IDLE_CAP, addGap, compactWorth, idleEstimate, ALWAYS_AFTER, BACK_OFF_AFTER, LEARN_OVER, OFFER_AFTER_MS, DEFAULT_START, ROW_OF, breakEvenMs, breakEvenPings, clockText, coldPlan, alwaysText, ignoredLately, keepWarmChoices, leadMs, learnedChoice, netSaving, nextStart, offerAt, offerText, pingCost, pingEvery, pingsFor, standingChoice, usualStart, warmEndText, warmPlan, warmReturned, warmingText, WARM_PROOF, cacheHeld } from './warm'

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
  expect(choices.map(c => c.label)).toEqual(['Keep warm to 20:00 ($0.03)', 'Keep warm to 2:00 tomorrow ($0.13)', 'Keep warm to 9:00 tomorrow ($0.24)'])
  expect(choices.map(c => c.id)).toEqual(['2h', '8h', 'start'])
  expect(choices[2]?.endsAt).toBe(local(16, 9))
  // Pricier pings: 15 of them cost more than a cold return.
  expect(keepWarmChoices({ ...o, ping: 0.05 }).map(c => c.id), '15 x $0.05 is $0.75, over $0.63').toEqual(['2h', '8h'])
  expect(keepWarmChoices({ ...o, ping: 0.1 }).map(c => c.id), '8 x $0.10 is $0.80').toEqual(['2h'])
  expect(keepWarmChoices({ ...o, ping: 0.4 }), 'two pings cost more than a cold return').toEqual([])
  // A turn that ends at 5 a.m.: the usual 9:00 is 4 hours away, labelled with no "tomorrow".
  expect(keepWarmChoices({ ...o, endedAt: local(15, 5) }).map(c => c.label)).toEqual(['Keep warm to 7:00 ($0.03)', 'Keep warm to 13:00 ($0.13)', 'Keep warm to 9:00 ($0.06)'])
  // "tomorrow" whenever the end is on a later calendar day than the turn's end: 22:00 to 9:00 is 11 hours, 20:00 to 9:00 is 13.
  expect(keepWarmChoices({ ...o, endedAt: local(15, 22) }).map(c => c.label)[2], '11 hours').toBe('Keep warm to 9:00 tomorrow ($0.18)')
  expect(keepWarmChoices({ ...o, endedAt: local(15, 20) }).map(c => c.label)[2], '13 hours').toBe('Keep warm to 9:00 tomorrow ($0.21)')
  // A turn that ends at 8 a.m.: 9:00 is inside the 2 h choice.
  expect(keepWarmChoices({ ...o, endedAt: local(15, 8) }).map(c => c.id)).toEqual(['2h', '8h'])
})

test('the offer on a 5-minute cache: only 30 min and 1 h, and only when they cost less than coming back cold', async () => {
  const o = { ttl: 5 * MIN, endedAt: local(15, 18), cold: 0.72, ping: 0.03, startMinutes: 9 * 60, tag: usd }
  expect(keepWarmChoices(o).map(c => c.label), '7 and 14 pings').toEqual(['Keep warm to 18:30 ($0.21)', 'Keep warm to 19:00 ($0.42)'])
  expect(keepWarmChoices({ ...o, ping: 0.06 }).map(c => c.id), '14 x $0.06 is $0.84, over $0.72').toEqual(['30m'])
  expect(keepWarmChoices({ ...o, ping: 0.12 }), '7 x $0.12 is $0.84').toEqual([])
})

test('the offer text counts the minutes left and names the clock time the cache goes cold, with the cold cost; a 5-minute cache adds the time keeping warm stops paying', async () => {
  const ended = local(15, 13, 55)
  const one = { ttl: HOUR, endedAt: ended, cost: 'about $0.63', breakEven: 39 * 57 * MIN }
  expect(offerText({ ...one, now: local(15, 14, 13) }), '42 min left at 14:13').toBe('Goes cold in 42 min (14:55) · coming back after costs about $0.63')
  expect(offerText({ ...one, now: local(15, 14, 54) + 30_000 }), 'under a minute left: 1 min, rounded up').toBe('Goes cold in 1 min (14:55) · coming back after costs about $0.63')
  expect(offerText({ ...one, now: local(15, 14, 55) }), 'never 0 min while the cache is warm').toBe('Goes cold in 1 min (14:55) · coming back after costs about $0.63')
  expect(offerText({ ...one, now: local(15, 14, 13), cost: '~2% ($1.10)' })).toBe('Goes cold in 42 min (14:55) · coming back after costs ~2% ($1.10)')
  expect(offerText({ ...one, ttl: 5 * MIN, endedAt: local(15, 13), breakEven: 96 * MIN, now: local(15, 13) })).toBe(
    'Goes cold in 5 min (13:05) · coming back after costs about $0.63. Keeping warm past 14:36 costs more.',
  )
  expect(offerText({ ...one, ttl: 5 * MIN, endedAt: local(15, 13), breakEven: 96 * MIN, now: local(15, 13) + 30_000 }), 'the short-cache tail stays; 4 min 30 s left is 5 min').toBe(
    'Goes cold in 5 min (13:05) · coming back after costs about $0.63. Keeping warm past 14:36 costs more.',
  )
})

test('keep-warm buttons: clock times counted from the turn end, in API and subscription words; one button per end minute', async () => {
  const o = { ttl: HOUR, endedAt: local(15, 14), cold: 0.63, ping: 0.016, startMinutes: 9 * 60 }
  const sub = (d: number) => `~${(d * 2).toFixed(1)}% usage`
  expect(keepWarmChoices({ ...o, tag: usd }).map(c => c.label)).toEqual(['Keep warm to 16:00 ($0.03)', 'Keep warm to 22:00 ($0.13)', 'Keep warm to 9:00 tomorrow ($0.30)'])
  expect(keepWarmChoices({ ...o, tag: sub }).map(c => c.label)).toEqual(['Keep warm to 16:00 (~0.1% usage)', 'Keep warm to 22:00 (~0.3% usage)', 'Keep warm to 9:00 tomorrow (~0.6% usage)'])
  expect(keepWarmChoices({ ...o, tag: d => `~$${d.toFixed(2)}` })[0]?.label).toBe('Keep warm to 16:00 (~$0.03)')
  // The usual start at 16:00 is the 2 h choice's own end: one button.
  const same = keepWarmChoices({ ...o, startMinutes: 16 * 60, tag: usd })
  expect(same.map(c => c.id), 'same clock minute: the first stays').toEqual(['2h', '8h'])
  // The end is the turn's end plus the choice, whatever time it is pressed.
  expect(keepWarmChoices({ ...o, tag: usd }).map(c => c.endsAt)).toEqual([local(15, 16), local(15, 22), local(16, 9)])
})

test('the offer shows 5 minutes after the turn on a cache of 1 hour or more, and at once on a shorter one', async () => {
  const ended = local(15, 18)
  expect(offerAt(ended, HOUR)).toBe(ended + 5 * MIN)
  expect(offerAt(ended, HOUR)).toBe(ended + OFFER_AFTER_MS)
  expect(offerAt(ended, 5 * MIN)).toBe(ended)
})

test('the keep-warm line says until when and what it used so far, with no ping count', async () => {
  const until = local(15, 22, 5)
  expect(warmingText({ until, used: '$0.00' })).toBe('Warm until 22:05 · $0.00 so far')
  expect(warmingText({ until, used: '~0% used' })).toBe('Warm until 22:05 · ~0% used so far')
  expect(warmingText({ until, used: '~0.1% used' })).toBe('Warm until 22:05 · ~0.1% used so far')
  expect(warmingText({ until, used: '~$0.04' })).toBe('Warm until 22:05 · ~$0.04 so far')
  expect(warmingText({ until, used: '$0.04' })).toBe('Warm until 22:05 · $0.04 so far')
  expect(warmEndText('Stopped keeping warm', '~0.1% used')).toBe('Stopped keeping warm · ~0.1% used.')
  expect(warmEndText('Kept the cache warm until 22:05', '$0.04')).toBe('Kept the cache warm until 22:05 · $0.04.')
  expect(warmEndText('Stopped keeping warm', undefined)).toBe('Stopped keeping warm · nothing used.')
})

test('each row value is a plan: a handoff without whatsnext is a compaction, and an unknown value asks', async () => {
  expect(coldPlan('ask', true)).toEqual({ action: 'ask' })
  expect(coldPlan('keep warm 2 h', false)).toEqual({ action: 'warm', hours: 2 })
  expect(coldPlan('keep warm 8 h', true)).toEqual({ action: 'warm', hours: 8 })
  expect(coldPlan('save a handoff', true)).toEqual({ action: 'handoff' })
  expect(coldPlan('save a handoff', false)).toEqual({ action: 'compact' })
  expect(coldPlan('compact', true)).toEqual({ action: 'compact' })
  expect(coldPlan('off', true)).toEqual({ action: 'off' })
  expect(coldPlan('something else', true)).toEqual({ action: 'ask' })
})

test('there is no size bar: a row acts when its action nets above zero, the action\'s own cost taken off the cold cost', async () => {
  const p = DEFAULT_PRICES.opus
  // 20K tokens on Opus: $0.156 to come back cold, under the old $0.50 bar.
  const cold = (20_000 * (p.cacheWrite - p.cacheRead)) / 1e6
  const ping = pingCost(p, 20_000)
  const compact = (20_000 * p.input) / 1e6
  const cents = (n: number) => Math.round(n * 1e6) / 1e6
  expect(cents(cold)).toBe(0.156)
  expect(cents(netSaving('warm', { cold, ping, compact })), 'one request against the cold cost').toBe(cents(cold - ping))
  expect(cents(netSaving('handoff', { cold, ping, compact }))).toBe(cents(cold - ping))
  expect(cents(netSaving('compact', { cold, ping, compact })), 'a compaction reads the conversation as input').toBe(cents(cold - compact))
  expect(cents(netSaving('ask', { cold, ping, compact })), 'ask is judged by its cheapest choice').toBe(cents(cold - Math.min(ping, compact)))
  for (const action of ['warm', 'handoff', 'compact', 'ask'] as const) expect(netSaving(action, { cold, ping, compact }), `${action}: a saving of any size counts`).toBeGreaterThan(0)
  // An action that costs as much as, or more than, coming back cold nets nothing: the row does not act.
  expect(netSaving('compact', { cold: 0.1, ping: 0.01, compact: 0.1 })).toBe(0)
  expect(netSaving('compact', { cold: 0.1, ping: 0.01, compact: 0.12 })).toBeLessThan(0)
  expect(netSaving('warm', { cold: 0.005, ping: 0.01, compact: 0.1 })).toBeLessThan(0)
  expect(netSaving('off', { cold: 1, ping: 0.01, compact: 0.1 }), 'off does nothing').toBe(0)
  expect(DAY).toBe(86_400_000)
})

/** Cold lines, oldest first, a day apart. */
const answers = (...choices: string[]) => choices.map((choice, i) => ({ at: new Date(local(1 + i, 12)).toISOString(), kind: 'cold', choice }))
const HERE = ['2h', '8h', 'start', 'handoff', 'let-go', 'off']

test('the one button is the choice picked most in the last 10 answered offers; a tie goes to the most recent', async () => {
  expect(LEARN_OVER).toBe(10)
  expect(learnedChoice([], HERE), 'no history').toBeUndefined()
  expect(learnedChoice(answers('8h', '8h', '2h'), HERE)).toBe('8h')
  expect(learnedChoice(answers('8h', '2h'), HERE), 'a tie: the 2 hours was picked last').toBe('2h')
  expect(learnedChoice(answers('2h', '8h'), HERE)).toBe('8h')
  expect(learnedChoice(answers('8h', 'ignored', 'ignored', 'ignored', '2h', 'ignored'), HERE), 'ignored offers are no answers').toBe('2h')
  // Only the last 10 answers count: 8 hours leads over all 14, 2 hours over the last 10.
  const long = answers('8h', '8h', '8h', '8h', '2h', '8h', '2h', '8h', '2h', 'let-go', '2h', '8h', '2h', 'let-go')
  expect(learnedChoice(long, HERE)).toBe('2h')
  expect(learnedChoice(long.slice(-9), HERE), 'ignored lines do not use up the 10').toBe('2h')
  expect(learnedChoice(answers('handoff', 'handoff', '8h'), ['2h', '8h', 'compact']), 'only choices this offer has').toBe('8h')
  expect(learnedChoice(answers('handoff', 'handoff'), ['2h', 'compact']), 'no match: the default stands').toBeUndefined()
  expect(learnedChoice([{ at: new Date(local(1, 12)).toISOString(), kind: 'run', choice: '8h' }, { at: new Date(local(2, 12)).toISOString(), kind: 'cold' }], HERE), 'only cold lines with a choice').toBeUndefined()
  // Lines out of order in the log are read by time.
  expect(learnedChoice([...answers('2h', '2h', '8h', '8h', '8h')].reverse(), HERE)).toBe('8h')
  expect(learnedChoice([...answers('8h', '8h', '2h', '2h')].reverse(), HERE), 'a tie by time, not by position').toBe('2h')
})

test('3 answers of one choice with a row value make an "Always …?" offer, once per choice', async () => {
  expect(ALWAYS_AFTER).toBe(3)
  expect(ROW_OF).toEqual({ '2h': 'keep warm 2 h', '8h': 'keep warm 8 h', handoff: 'save a handoff', compact: 'compact' })
  expect(standingChoice(answers('2h', '2h', '2h'), HERE, [])).toBe('2h')
  expect(standingChoice(answers('let-go', '8h', '8h', '8h'), HERE, []), 'the last 3').toBe('8h')
  expect(standingChoice(answers('handoff', 'handoff', 'handoff'), HERE, [])).toBe('handoff')
  expect(standingChoice(answers('compact', 'compact', 'compact'), ['2h', 'compact'], [])).toBe('compact')
  expect(standingChoice(answers('2h', '2h'), HERE, []), 'two is not three').toBeUndefined()
  expect(standingChoice(answers('2h', '8h', '2h'), HERE, [])).toBeUndefined()
  expect(standingChoice(answers('2h', '2h', 'ignored', '2h'), HERE, []), 'ignored offers are no answers').toBe('2h')
  expect(standingChoice(answers('let-go', 'let-go', 'let-go'), HERE, []), 'no row value').toBeUndefined()
  expect(standingChoice(answers('start', 'start', 'start'), HERE, []), 'no row value').toBeUndefined()
  expect(standingChoice(answers('2h', '2h', '2h'), HERE, ['2h']), 'asked once already').toBeUndefined()
  expect(standingChoice(answers('2h', '2h', '2h'), HERE, ['8h']), 'another choice\'s question does not count').toBe('2h')
  expect(standingChoice(answers('8h', '8h', '8h'), ['2h', 'compact'], []), 'this offer does not have it').toBeUndefined()
  expect(alwaysText('2h')).toBe('Always keep warm 2 hours?')
  expect(alwaysText('8h')).toBe('Always keep warm 8 hours?')
  expect(alwaysText('handoff')).toBe('Always save a handoff?')
  expect(alwaysText('compact')).toBe('Always compact?')
})

test('5 offers in a row with no answer make the back-off offer', async () => {
  expect(BACK_OFF_AFTER).toBe(5)
  expect(ignoredLately(answers('ignored', 'ignored', 'ignored', 'ignored', 'ignored'))).toBe(true)
  expect(ignoredLately(answers('2h', 'ignored', 'ignored', 'ignored', 'ignored', 'ignored'))).toBe(true)
  expect(ignoredLately(answers('ignored', 'ignored', 'ignored', 'ignored'))).toBe(false)
  expect(ignoredLately(answers('ignored', 'ignored', 'let-go', 'ignored', 'ignored'))).toBe(false)
  expect(ignoredLately(answers('ignored', 'ignored', 'ignored', 'ignored', 'ignored', '2h'))).toBe(false)
  expect(ignoredLately([])).toBe(false)
})

test('a return is earned by keeping warm only after the time the cache would have gone cold, and while a request still kept it alive', async () => {
  const ended = 1_000 * HOUR
  const ping = ended + 57 * MIN
  const base = { endedAt: ended, lastWarmAt: ping, ttl: HOUR }
  expect(warmReturned({ ...base, now: ended + 62 * MIN }), 'during the run, after the would-be expiry').toBe(true)
  expect(warmReturned({ ...base, now: ping + HOUR }), 'at the last request\'s life').toBe(true)
  expect(warmReturned({ ...base, now: ended + 60 * MIN }), 'exactly at the would-be expiry: the cache was still warm').toBe(false)
  expect(warmReturned({ ...base, now: ended + 59 * MIN }), 'before it: it would have been warm anyway').toBe(false)
  expect(warmReturned({ ...base, now: ping + HOUR + 1 }), 'after the last request\'s life: cold anyway').toBe(false)
  expect(warmReturned({ endedAt: ended, lastWarmAt: 0, ttl: HOUR, now: ended + 3 * HOUR }), 'no request answered').toBe(false)
  expect(warmReturned({ endedAt: ended, lastWarmAt: ended - MIN, ttl: HOUR, now: ended + 62 * MIN }), 'a request of an earlier turn').toBe(false)
  // A 5-minute cache: requests every 4 minutes.
  expect(warmReturned({ endedAt: ended, lastWarmAt: ended + 4 * MIN, ttl: 5 * MIN, now: ended + 6 * MIN })).toBe(true)
})

test('the cache held when the first request read at least 80% of the kept conversation', async () => {
  expect(WARM_PROOF).toBe(0.8)
  expect(cacheHeld(80_000, 80_500)).toBe(true)
  expect(cacheHeld(64_400, 80_500), 'exactly 80%').toBe(true)
  expect(cacheHeld(64_399, 80_500)).toBe(false)
  expect(cacheHeld(0, 80_500), 'a whole rewrite').toBe(false)
  expect(cacheHeld(10, 0), 'no known context').toBe(false)
})

test('keep warm until my usual start is a warm plan of at most 8 hours, cut to the usual start by the caller', async () => {
  expect(coldPlan('keep warm until my usual start', false)).toEqual({ action: 'warm', hours: 8, untilStart: true })
})

test('idle gaps: only absences of 5 minutes or more are kept, the latest 20', async () => {
  expect(addGap([], 4 * MIN), 'a pause, not an absence').toEqual([])
  expect(addGap([HOUR], 5 * MIN)).toEqual([HOUR, 5 * MIN])
  const many = Array.from({ length: 20 }, (_, i) => (i + 1) * MIN * 10)
  const next = addGap(many, HOUR)
  expect(next.length).toBe(20)
  expect(next.at(-1)).toBe(HOUR)
  expect(next[0], 'the oldest goes').toBe(20 * MIN)
})

test('expected idle time E: the median of the gaps, at most 8 hours, and 8 hours with fewer than 5 gaps', async () => {
  expect(idleEstimate([]), 'no gaps').toBe(IDLE_CAP)
  expect(idleEstimate([HOUR, HOUR, HOUR, HOUR]), 'four gaps say nothing yet').toBe(IDLE_CAP)
  expect(idleEstimate([HOUR, 2 * HOUR, 3 * HOUR, 4 * HOUR, 5 * HOUR])).toBe(3 * HOUR)
  expect(idleEstimate([HOUR, 2 * HOUR, 3 * HOUR, 4 * HOUR, 5 * HOUR, 6 * HOUR]), 'even count: the middle two').toBe(3.5 * HOUR)
  expect(idleEstimate([10 * HOUR, 11 * HOUR, 12 * HOUR, 13 * HOUR, 14 * HOUR]), 'capped').toBe(IDLE_CAP)
})

test('compact only when keeping warm over E costs at least 3 times the compaction and its summary\'s cold read', async () => {
  expect(COMPACT_VALUE).toBe(3)
  const base = { ttl: HOUR, ping: 0.1, compact: 0.5, summaryCold: 0.1 }
  // 8 hours on a 1-hour cache is 8 requests: $0.80 against 3 x $0.60 = $1.80.
  expect(compactWorth({ ...base, estimate: 8 * HOUR }).worth).toBe(false)
  const w = compactWorth({ ...base, estimate: 8 * HOUR, ping: 0.3 })
  expect(Math.abs(w.keepWarm - 2.4)).toBeLessThan(1e-9)
  expect(Math.abs(w.cost - 0.6)).toBeLessThan(1e-9)
  expect(w.worth, '$2.40 is at least $1.80').toBe(true)
  expect(compactWorth({ ...base, estimate: 30 * MIN, ping: 0.3 }).keepWarm, 'under one cache life is one request').toBe(0.3)
  expect(compactWorth({ ...base, estimate: 6 * HOUR, ping: 0.4 }).worth, '6 x 0.40 = $2.40 clears $1.80').toBe(true)
})
