import { expect, test } from 'claude-code/testing'
import { fastGuess, nextFast, speedFromCost, speedSwitchCost, speedSwitchText } from './fast'
import { fastCreditsLines, type RunLine } from './report'
import { LOG_PATH, LOOKUP, REVIEW, RUNS_FILE, drive, engine, mount, rowText } from './testkit'

// Fast mode (P-29, ADR 0069): the main chat in fast mode is priced at fast rates; the fastMode setting is the first guess and
// each main-chat request's real cost (Claude Code's ledger) settles it; turning it on or off between prompts is priced on the band;
// on a subscription its spend is usage credits.

const logOf = (h: ReturnType<typeof engine>) => h.files[LOG_PATH] ?? ''
const runLines = (h: ReturnType<typeof engine>) =>
  (h.files[RUNS_FILE] ?? '')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as RunLine)
    .filter(l => (l.kind ?? 'run') === 'run')

test('the settings guess: on only with the setting, a model with fast prices, a first-party API, and nothing turning it off', () => {
  const base = { setting: true, perSession: undefined, disabled: undefined, supported: true, firstParty: true }
  expect(fastGuess(base)).toBe(true)
  expect(fastGuess({ ...base, setting: false })).toBe(false)
  expect(fastGuess({ ...base, setting: undefined }), 'never set').toBe(false)
  expect(fastGuess({ ...base, perSession: true }), 'per-session opt-in starts each session off').toBe(false)
  expect(fastGuess({ ...base, disabled: '1' }), 'CLAUDE_CODE_DISABLE_FAST_MODE').toBe(false)
  expect(fastGuess({ ...base, supported: false }), 'Sonnet, Haiku').toBe(false)
  expect(fastGuess({ ...base, firstParty: false }), 'the setting does nothing on a cloud provider').toBe(false)
})

test('a request\'s real cost says its speed only when it is near one price and nearer it than the other', () => {
  expect(speedFromCost({ ledger: 0.02, standard: 0.01, fast: 0.02 })).toBe(true)
  expect(speedFromCost({ ledger: 0.011, standard: 0.01, fast: 0.02 }), 'data residency adds 10%').toBe(false)
  expect(speedFromCost({ ledger: 0.03, standard: 0.01, fast: 0.02 }), 'another request overlapped').toBeUndefined()
  expect(speedFromCost({ ledger: 0, standard: 0.01, fast: 0.02 }), 'not counted yet').toBeUndefined()
  expect(speedFromCost({ ledger: 0.0004, standard: 0.0002, fast: 0.0004 }), 'too small to tell').toBeUndefined()
})

test('a standard reading against a guess of on wins at once; turning on, or against an earlier reading, needs a second in a row', () => {
  const guessed = { on: false, by: 'setting' as const }
  const first = nextFast(guessed, true)
  expect(first, 'one fast reading against the guess: pending only (ADR 0078)').toEqual({ on: false, by: 'setting', pending: true })
  expect(nextFast(first, true), 'the second in a row turns it on').toEqual({ on: true, by: 'cost' })
  expect(nextFast(first, false), 'a standard reading clears it').toEqual({ on: false, by: 'cost' })
  expect(nextFast(guessed, undefined), 'no reading: unchanged').toBe(guessed)
  expect(nextFast({ on: true, by: 'setting' }, false), 'a rate-limit fallback: off at once').toEqual({ on: false, by: 'cost' })
  const measured = { on: true, by: 'cost' as const }
  const once = nextFast(measured, false)
  expect(once).toEqual({ on: true, by: 'cost', pending: false })
  expect(nextFast(once, true), 'an agreeing reading clears it').toEqual({ on: true, by: 'cost' })
  expect(nextFast(once, false), 'the second in a row flips it').toEqual({ on: false, by: 'cost' })
})

test('a switch of speed writes the whole conversation again at the new speed, and the band says so', () => {
  expect(speedSwitchCost({ context: 100_000, write: 10 })).toBe(1)
  expect(speedSwitchText({ on: true, cost: 'about $1.00' })).toBe('Fast mode on: fast and standard speed keep separate caches, so this prompt reads the whole conversation again (about $1.00).')
  expect(speedSwitchText({ on: false, cost: 'about $0.50', model: 'Sonnet' })).toContain('Fast mode off with the switch to Sonnet:')
})

test('on a subscription the report says fast mode spend is usage credits, real money; without any, only the plan is paid', () => {
  const at = '2026-11-14T20:00:00Z'
  expect(fastCreditsLines([{ at, fast: 1.234 }, { at, fast: 0.5 }, { at }])).toEqual(['Fast mode: ~$1.73 in these 30 days, paid from your usage credits. That is real money, on top of your subscription; the other amounts are API-equivalent.'])
  expect(fastCreditsLines([{ at }])).toEqual(['You only pay for your subscription.'])
})

// The kit's main request: 200 input, 400 output, 20,000 read, 300 written. On Opus 5.5 at a 5-minute cache (API billing):
// standard $0.0143, fast $0.0286.
const FAST_COST = 0.0286
const STANDARD_COST = 0.0143

const turn = async (h: ReturnType<typeof engine>, d: ReturnType<typeof drive>, id: string) => {
  h.rating = REVIEW
  await d.submit(LOOKUP)
  await d.step(id)
  await d.complete(id)
}

test('with fastMode on, Opus 5.5\'s main-chat requests are priced at fast rates, and the run line carries the fast part', { timeoutMs: 30000 }, async ($, on) => {
  const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
  h.settings.fastMode = true
  h.ledger = undefined
  const d = drive($, h)
  await d.start('terminal')
  await turn(h, d, 't1')
  const line = runLines(h).at(-1)
  expect(line?.fast, 'the fast part of the main chat').toBeGreaterThan(0.02)
  expect(line?.fast).toBeLessThan(0.04)
})

test('fastMode on a model with no fast mode (Sonnet) prices at standard rates', { timeoutMs: 30000 }, async ($, on) => {
  const h = engine(on, { model: 'claude-sonnet-5-5', effort: 'medium' })
  h.settings.fastMode = true
  h.ledger = undefined
  const d = drive($, h)
  await d.start('terminal')
  await turn(h, d, 't1')
  expect(runLines(h).at(-1)?.fast).toBeUndefined()
})

test('the setting off but requests that cost the fast price: fast mode is on after the second, and logged', { timeoutMs: 30000 }, async ($, on) => {
  const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
  h.stepCost = FAST_COST
  const d = drive($, h)
  await d.start('terminal')
  await turn(h, d, 't1')
  expect(logOf(h), 'one reading is not enough to turn it on').not.toContain('fast mode on')
  await turn(h, d, 't2')
  expect(logOf(h)).toContain('fast mode on: a request cost')
  await turn(h, d, 't3')
  expect(runLines(h).at(-1)?.fast, 'the next turn is priced fast').toBeGreaterThan(0.02)
})

test('a helper request that ends during a main-chat request: that reading says nothing, however fast it looks', { timeoutMs: 30000 }, async ($, on) => {
  const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
  h.stepCost = STANDARD_COST
  const d = drive($, h)
  await d.start('terminal')
  for (const id of ['t1', 't2', 't3']) {
    // The helper's request lands in the ledger while the main chat's is out: together they cost the fast price.
    h.duringStep = async () => {
      h.ledger = (h.ledger ?? 0) + (FAST_COST - 2 * STANDARD_COST)
      await d.step(`${id}-helper`, 0, 'agent-bg')
    }
    await turn(h, d, id)
  }
  expect(logOf(h)).not.toContain('fast mode on')
  expect(runLines(h).at(-1)?.fast).toBeUndefined()
})

test('the setting on but requests at the standard price (a rate-limit fallback): one reading that overrules the guess turns it off', { timeoutMs: 30000 }, async ($, on) => {
  const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
  h.settings.fastMode = true
  h.stepCost = STANDARD_COST
  const d = drive($, h)
  await d.start('terminal')
  await turn(h, d, 't1')
  expect(logOf(h)).toContain('fast mode off: a request cost')
  await turn(h, d, 't2')
  expect(runLines(h).at(-1)?.fast).toBeUndefined()
})

for (const surface of ['desktop', 'terminal'] as const) {
  test(`/fast between prompts: the next prompt's band prices reading the conversation again at the new speed (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = engine(on, { model: 'claude-opus-5-5', effort: 'medium' })
    h.ledger = undefined
    const d = drive($, h)
    await d.start(surface)
    await turn(h, d, 't1')
    h.settings.fastMode = true
    h.rating = REVIEW
    await d.submit(LOOKUP)
    const ui = await mount($, surface)
    const text = (await rowText(ui, 'Prompt')) || (await rowText(ui, 'Cache'))
    await ui.unmount()
    expect(text).toContain('Fast mode on: fast and standard speed keep separate caches, so this prompt reads the whole conversation again (about $')
    expect(logOf(h)).toContain('fast mode on (the fastMode setting)')
  })
}
