import { expect, test } from 'claude-code/testing'
import {
  ADVANCED,
  KEYS,
  NOT_SET,
  FIXED,
  RULE_KEYS,
  RULE_LABELS,
  SETTINGS,
  type SettingKey,
  afterSet,
  defaults,
  fieldsSet,
  inOptions,
  inUse,
  isKey,
  manifestGaps,
  mark,
  missPauseOf,
  answersOf,
  askFirstOn,
  legacyAskFirst,
  plainTitle,
  raterEvery,
  ruleLabel,
  ruleValue,
  resetKeys,
  rulesOf,
  settingNamed,
  stillReset,
  storedOptions,
  valueOf,
  valuesOf,
  watchOnly,
} from './settings'

const set = (...keys: SettingKey[]) => new Set<SettingKey>(keys)

test('every row is a picker: a title, two or more options, and a default among them', async () => {
  expect(KEYS.length).toBe(32)
  for (const k of KEYS) {
    const row = SETTINGS[k]
    expect(row.title.length, k).toBeGreaterThan(0)
    expect(row.options.length, k).toBeGreaterThanOrEqual(2)
    expect(new Set(row.options).size, `${k} options are distinct`).toBe(row.options.length)
    expect(row.options as readonly string[], `${k} default`).toContain(row.default)
  }
  expect(new Set(KEYS.map(k => SETTINGS[k].title)).size, 'titles are distinct').toBe(KEYS.length)
  expect(isKey('floor') && isKey('priceCheck')).toBe(true)
  expect(isKey('toString') || isKey('nope') || isKey(7)).toBe(false)
})

test('a value outside the options counts as unset: the default applies', async () => {
  expect(valueOf('floor', 'medium')).toBe('medium')
  expect(valueOf('floor', 'ultra')).toBe('low')
  expect(valueOf('floor', undefined)).toBe('low')
  expect(valueOf('floor', 7)).toBe('low')
  // "on" was the value of two rows that became lists: it falls outside, and the default is the old "on".
  expect(valueOf('raterCheck', 'on'), 'a stored on').toBe('every 50')
  expect(valueOf('startTips', 'on'), 'a stored on').toBe('weekly')
  expect(inOptions('raterCheck', 'off')).toBe(true)
  expect(inOptions('startTips', 'off')).toBe(true)
  expect(valuesOf({ floor: 'high', ceiling: 'max2', raterCheck: 'on' }).floor).toBe('high')
  expect(valuesOf({ floor: 'high', ceiling: 'max2', raterCheck: 'on' }).ceiling).toBe('max')
  expect(valuesOf(undefined)).toEqual(defaults())
})

test('the rule rows hold the four questions, default "not set"', async () => {
  for (const r of ['lower', 'raise', 'up', 'down'] as const) {
    const row = SETTINGS[RULE_KEYS[r]]
    expect(row.default).toBe(NOT_SET)
    expect([...row.options], r).toEqual([...RULE_LABELS[r].map(l => l[0]), NOT_SET])
  }
  expect(RULE_LABELS.lower.map(l => l[1])).toEqual(['ask', 'auto', 'never'])
  expect(RULE_LABELS.up.map(l => l[1])).toEqual(['ask', 'auto', 'stay', 'each'])
  expect(ruleValue('down', 'stay, lower effort only')).toBe('stay')
  expect(ruleValue('raise', 'raise automatically')).toBe('auto')
  expect(ruleValue('lower', NOT_SET), 'not set stands for no rule').toBeUndefined()
  expect(ruleValue('lower', 'raise automatically'), 'a label of another rule').toBeUndefined()
  expect(ruleLabel('up', 'each')).toBe('ask each time')
  expect(ruleLabel('up', undefined)).toBe(NOT_SET)
  const values = { ...defaults(), lowerRule: 'never lower', upRule: 'ask first' }
  expect(rulesOf(values)).toEqual({ lower: 'never', up: 'ask' })
  expect(rulesOf(defaults())).toEqual({})
})

test('reads the options stored under rightsize and under rightsize@<marketplace>', async () => {
  for (const key of ['rightsize', 'rightsize@archid21', 'rightsize@inline']) {
    const configs = { [key]: { options: { floor: 'high', billing: 'subscription' } } }
    expect(fieldsSet(configs), key).toEqual(set('floor', 'billing'))
  }
  // Another plugin's options, and keys that only look like it, are not ours.
  const others = { other: { options: { floor: 'high' } }, rightsizer: { options: { floor: 'high' } }, 'rightsize-fork@x': { options: { floor: 'high' } }, 'other@rightsize': { options: { floor: 'high' } } }
  expect(fieldsSet(others)).toEqual(set())
  expect(storedOptions(others)).toEqual({})
  // Stored under two keys (installed and inline): both count.
  const two = { rightsize: { options: { floor: 'high' } }, 'rightsize@inline': { options: { handOff: '50%' } } }
  expect(fieldsSet(two)).toEqual(set('floor', 'handOff'))
  expect(storedOptions({ rightsize: { options: { floor: 'high' } } })).toEqual({ floor: 'high' })
})

test('a stored value outside the options, or a key rightsize does not have, is not yours', async () => {
  const configs = { 'rightsize@archid21': { options: { raterCheck: 'on', startTips: 'on', floor: 'ultra', nope: 'x', pacing: 'off', lowerRule: NOT_SET } } }
  expect(fieldsSet(configs), 'only what fits a row').toEqual(set('pacing', 'lowerRule'))
  // An entry with no options, or options that are not an object.
  expect(fieldsSet({ rightsize: {} })).toEqual(set())
  expect(fieldsSet({ rightsize: { options: ['floor'] } })).toEqual(set())
  expect(fieldsSet({ rightsize: null })).toEqual(set())
  // Stored as the default: still set by you.
  expect(fieldsSet({ rightsize: { options: { floor: 'low' } } })).toEqual(set('floor'))
})

test('when settings cannot be read, a value that differs from its default can only have been set', async () => {
  const options = { floor: 'high', ceiling: 'max', billing: 'api', raterCheck: 'on', pacing: 'off' }
  for (const unreadable of [undefined, null, 'x', 7, []]) expect(fieldsSet(unreadable, options), String(unreadable)).toEqual(set('floor', 'pacing'))
  expect(fieldsSet(undefined), 'nothing to go on').toEqual(set())
  // Readable but with no entry for rightsize: nothing was set, whatever the options say.
  expect(fieldsSet({}, options)).toEqual(set())
})

test('a change by the person marks the row as yours; another plugin\'s change does not', async () => {
  const none = set()
  expect(afterSet(none, 'rightsize.billing', 'api', { kind: 'composer' }), 'the menu').toEqual(set('billing'))
  expect(afterSet(none, 'rightsize.billing', 'api', { kind: 'bridge' }), 'a phone').toEqual(set('billing'))
  expect(afterSet(none, 'rightsize.billing', 'api', { kind: 'plugin' }), 'another plugin').toEqual(set())
  expect(afterSet(none, 'rightsize.billing', 'api', undefined), 'no origin named').toEqual(set())
  expect(afterSet(none, 'rightsize.billing', 'gold', { kind: 'composer' }), 'not an option').toEqual(set())
  expect(afterSet(none, 'rightsize.nope', 'api', { kind: 'composer' }), 'not a row').toEqual(set())
  expect(afterSet(none, 'theme', 'dark', { kind: 'composer' }), "another row of the menu").toEqual(set())
  expect(afterSet(none, 'other.billing', 'api', { kind: 'composer' }), "another plugin's row").toEqual(set())
  // Set to its default value: still set by you.
  expect(afterSet(none, 'rightsize.floor', 'low', { kind: 'composer' })).toEqual(set('floor'))
  // The rows already set stay; the set given is not changed.
  const had = set('floor')
  expect(afterSet(had, 'rightsize.ceiling', 'high', { kind: 'composer' })).toEqual(set('floor', 'ceiling'))
  expect(had).toEqual(set('floor'))
})

test('a rule row set back to "not set" is unset again', async () => {
  const yours = afterSet(set(), 'rightsize.lowerRule', 'never lower', { kind: 'composer' })
  expect(yours).toEqual(set('lowerRule'))
  expect(afterSet(yours, 'rightsize.lowerRule', NOT_SET, { kind: 'composer' })).toEqual(set())
  expect(mark(set('floor'), 'floor', false)).toEqual(set())
  expect(mark(set(), 'floor', true)).toEqual(set('floor'))
})

test('plugin.json is checked against the table: a missing or unlisted field, or a default that moved', async () => {
  expect(manifestGaps(defaults(), set())).toEqual([])
  // A value you set may differ from the default: that is not a gap.
  expect(manifestGaps({ ...defaults(), floor: 'high' }, set('floor'))).toEqual([])
  expect(manifestGaps({ ...defaults(), floor: 'high' }, set())).toEqual(['floor defaults to "high", not "low"'])
  const { ceiling: _, ...short } = defaults()
  expect(manifestGaps(short, set())).toEqual(['ceiling is not declared'])
  expect(manifestGaps({ ...defaults(), extra: 'x' }, set())).toEqual(['extra is not in the table'])
  expect(manifestGaps(undefined, set()).length, 'nothing declared').toBe(KEYS.length)
})

test('the rows stand for plain values', async () => {
  expect(['every 25', 'every 50', 'every 100'].map(raterEvery)).toEqual([25, 50, 100])
  expect(raterEvery('off')).toBeNull()
  expect(raterEvery('on'), 'the old on is not a row value').toBeNull()
  expect(['20%', '30%', '40%', '50%'].map(missPauseOf)).toEqual([0.2, 0.3, 0.4, 0.5])
  expect(missPauseOf('off')).toBeNull()
})

test('Workflows asks by default, and Price check is monthly or off', async () => {
  expect(SETTINGS.workflows.title).toBe('Advanced · Workflows')
  expect([...SETTINGS.workflows.options]).toEqual(['ask', 'pause rightsize', 'follow my rules', 'right-size every agent'])
  expect(SETTINGS.workflows.default).toBe('ask')
  expect([...SETTINGS.priceCheck.options]).toEqual(['monthly', 'off'])
  // "check now" was a row value once: it is outside the options now, so it counts as unset and monthly applies.
  expect(valueOf('priceCheck', 'check now')).toBe('monthly')
  expect(fieldsSet({ rightsize: { options: { priceCheck: 'check now' } } }), 'a stored check now is not yours').toEqual(set())
})

test('a setting is named by its key or its title, in any case', async () => {
  expect(settingNamed('handOff')).toBe('handOff')
  expect(settingNamed('HANDOFF'), 'a key, in any case').toBe('handOff')
  expect(settingNamed('hand-off threshold')).toBe('handOff')
  expect(settingNamed('  Hand-Off   Threshold ')).toBe('handOff')
  expect(settingNamed("claude's subagents")).toBe('subagents')
  expect(settingNamed('Pause after misses')).toBe('missPause')
  expect(settingNamed('lowering'), 'the threshold row, by its key as spelled').toBe('lowering')
  expect(settingNamed('Lowering'), 'the rule row, by its title').toBe('lowerRule')
  expect(settingNamed('LOWERING'), 'the rule row, by its title').toBe('lowerRule')
  expect(settingNamed('lowering threshold')).toBe('lowering')
  expect(settingNamed('lowerRule')).toBe('lowerRule')
  expect(settingNamed('nope')).toBeUndefined()
  expect(settingNamed('')).toBeUndefined()
  expect(settingNamed('   ')).toBeUndefined()
  for (const k of KEYS) expect(settingNamed(k), `${k} by key`).toBe(k)
  for (const k of KEYS) expect(settingNamed(SETTINGS[k].title), `${k} by title`).toBe(k)
  for (const k of KEYS) expect(settingNamed(plainTitle(SETTINGS[k].title)), `${k} by its title without the prefix`).toBe(k)
  expect(settingNamed('advanced · hand-off threshold'), 'the title as /config shows it, in any case').toBe('handOff')
})

test('a reset field is not yours while its stored value is the default, and is again once it is anything else', async () => {
  const stored = (options: Record<string, string>) => ({ 'rightsize@archid21': { options } })
  // Reset: the default was written, and the field is on the list.
  expect(fieldsSet(stored({ floor: 'low', handOff: '50%' }), undefined, ['floor'])).toEqual(set('handOff'))
  expect(stillReset(stored({ floor: 'low' }), undefined, ['floor'])).toEqual(['floor'])
  // Set again, in /config or by hand: its value is not the default, so it is yours and leaves the list.
  expect(fieldsSet(stored({ floor: 'high' }), undefined, ['floor'])).toEqual(set('floor'))
  expect(stillReset(stored({ floor: 'high' }), undefined, ['floor'])).toEqual([])
  // Not stored at all (the person removed it): default, and still on the list until it is set.
  expect(fieldsSet(stored({}), undefined, ['floor'])).toEqual(set())
  expect(stillReset(stored({}), undefined, ['floor'])).toEqual(['floor'])
  // Not on the list: a stored default counts as set, as before.
  expect(fieldsSet(stored({ floor: 'low' }))).toEqual(set('floor'))
  // The list is read off the store's value, and nothing else in it counts.
  expect(resetKeys(['floor', 'nope', 7, 'floor', 'handOff'])).toEqual(['floor', 'handOff'])
  expect(resetKeys(undefined)).toEqual([])
  expect(resetKeys('floor')).toEqual([])
  // Settings unreadable: the options stand in, and a reset field at its default is not yours either way.
  expect(fieldsSet(undefined, { floor: 'low', ceiling: 'high' }, ['floor'])).toEqual(set('ceiling'))
})

test('there is no Profile row (ADR 0021): Ask before changing is the fourth row, off or on, off by default', async () => {
  expect(isKey('profile')).toBe(false)
  expect(KEYS[3]).toBe('askFirst')
  expect(SETTINGS.askFirst.title).toBe('Ask before changing')
  expect([...SETTINGS.askFirst.options]).toEqual(['off', 'on'])
  expect(SETTINGS.askFirst.default).toBe('off')
  expect(plainTitle(SETTINGS.askFirst.title)).toBe('Ask before changing')
  expect(settingNamed('ask before changing')).toBe('askFirst')
  expect(settingNamed('askFirst')).toBe('askFirst')
  expect([askFirstOn('on'), askFirstOn('off'), askFirstOn(undefined)]).toEqual([true, false, false])
  expect(answersOf(false)).toEqual({ lower: 'auto', raise: 'auto', up: 'auto', down: 'auto' })
  expect(answersOf(true)).toEqual({ lower: 'ask', raise: 'ask', up: 'ask', down: 'ask' })
  // A Profile row an older release stored: Quality reads as on, the others and nothing stored as off.
  expect(legacyAskFirst({ rightsize: { options: { profile: 'Quality' } } })).toBe(true)
  expect(legacyAskFirst({ rightsize: { options: { profile: 'Balanced' } } })).toBe(false)
  expect(legacyAskFirst({ rightsize: { options: { profile: 'Economy' } } })).toBe(false)
  expect(legacyAskFirst({ 'rightsize@archid21': { options: { profile: 'Quality' } } }), 'under a marketplace key too').toBe(true)
  expect(legacyAskFirst(undefined)).toBe(false)
  // The stored row is not a setting: it is never yours and never a value.
  expect(fieldsSet({ rightsize: { options: { profile: 'Quality' } } })).toEqual(set())
})

test('Mode is the first row: act or watch only, act by default, a plain row without the Advanced prefix', async () => {
  expect(KEYS[0]).toBe('mode')
  expect(SETTINGS.mode.title).toBe('Mode')
  expect([...SETTINGS.mode.options]).toEqual(['act', 'watch only'])
  expect(SETTINGS.mode.default).toBe('act')
  expect(plainTitle(SETTINGS.mode.title)).toBe('Mode')
  expect(settingNamed('mode')).toBe('mode')
  expect(settingNamed('Mode')).toBe('mode')
  expect(valueOf('mode', 'watch only')).toBe('watch only')
  expect(valueOf('mode', 'off'), 'not an option: act').toBe('act')
})

test('Routing, Hand-offs and Cache are rows 2, 3 and 5: on or off, on by default, plain rows without the Advanced prefix', async () => {
  expect(KEYS.slice(0, 5)).toEqual(['mode', 'routing', 'handOffs', 'askFirst', 'cache'])
  const titles = { routing: 'Routing', handOffs: 'Hand-offs', cache: 'Cache' } as const
  for (const [k, title] of Object.entries(titles) as [keyof typeof titles, string][]) {
    expect(SETTINGS[k].title).toBe(title)
    expect([...SETTINGS[k].options], k).toEqual(['on', 'off'])
    expect(SETTINGS[k].default, k).toBe('on')
    expect(plainTitle(SETTINGS[k].title), k).toBe(title)
    expect(settingNamed(title), `${k} by title`).toBe(k)
    expect(settingNamed(k), `${k} by key`).toBe(k)
    expect(valueOf(k, 'maybe'), `${k}: not an option, on`).toBe('on')
  }
  expect(settingNamed('hand-off threshold'), 'the threshold row keeps its own name').toBe('handOff')
})

test('every other row is titled Advanced, so /config lists the five plain rows first and the rest as advanced', async () => {
  expect(ADVANCED).toBe('Advanced · ')
  for (const k of KEYS.filter(k => !['mode', 'routing', 'handOffs', 'askFirst', 'cache'].includes(k))) {
    expect(SETTINGS[k].title.startsWith(ADVANCED), k).toBe(true)
    expect(plainTitle(SETTINGS[k].title).length, `${k} has a title after the prefix`).toBeGreaterThan(0)
  }
  expect(SETTINGS.floor.title).toBe('Advanced · Lowest effort')
  expect(plainTitle(SETTINGS.floor.title)).toBe('Lowest effort')
  expect(plainTitle('Mode'), 'no prefix to take off').toBe('Mode')
})

test('exploring close calls is off by default', async () => {
  expect(SETTINGS.explore.default).toBe('off')
  expect(defaults().explore).toBe('off')
})

test('the fixed values are what the Balanced profile held (ADR 0021)', async () => {
  expect(FIXED).toEqual({ evidence: { minTasks: 0, maxMiss: 0.2 }, handOff: 0.7, raterEvery: 20, chances: 2, beforeCold: 'keep warm until my usual start', reviewCeiling: 'max' })
})

test('a row you set wins over the fixed value; a row you did not set takes the fixed value', async () => {
  const values = { ...defaults(), handOff: '60%', missPause: '40%', raterCheck: 'every 100' }
  // Nothing set: the fixed values.
  expect(inUse(values, set())).toMatchObject({ handOff: 0.7, minTasks: 0, maxMiss: 0.2, raterEvery: 20, chances: 2 })
  // Each row set replaces only its own value.
  expect(inUse(values, set('handOff'))).toMatchObject({ handOff: 0.6, maxMiss: 0.2, raterEvery: 20 })
  expect(inUse(values, set('raterCheck'))).toMatchObject({ handOff: 0.7, raterEvery: 100 })
  // The evidence rule is one value, held by Pause after misses: set, it is the whole rule.
  expect(inUse(values, set('missPause'))).toMatchObject({ minTasks: 0, maxMiss: 0.4, handOff: 0.7 })
  expect(inUse({ ...values, missPause: 'off' }, set('missPause')).maxMiss, 'off is never').toBeNull()
  expect(inUse({ ...values, raterCheck: 'off' }, set('raterCheck')).raterEvery, 'off is never').toBeNull()
  // Chances and the review cap have no row: always the fixed value.
  expect(inUse(values, set('handOff', 'missPause', 'raterCheck')).chances).toBe(2)
  expect(inUse(values, set('handOff')).reviewCeiling).toBe('max')
  // The questions' first options follow Ask before changing: the row, or the value passed for an old Quality profile.
  expect(inUse(values, set()).answers).toEqual(answersOf(false))
  expect(inUse({ ...values, askFirst: 'on' }, set('askFirst')).answers).toEqual(answersOf(true))
  expect(inUse(values, set(), true).answers, 'an old Quality profile').toEqual(answersOf(true))
})

test('Before the cache goes cold is a row: seven options, asking by default, and /config names it', async () => {
  expect(SETTINGS.beforeCold.options).toEqual(['ask', 'keep warm 2 h', 'keep warm 8 h', 'keep warm until my usual start', 'save a handoff', 'compact', 'off'])
  expect(SETTINGS.beforeCold.default).toBe('ask')
  expect(SETTINGS.beforeCold.title).toBe('Advanced · Before the cache goes cold')
  expect(settingNamed('before the cache goes cold')).toBe('beforeCold')
  expect(settingNamed('beforeCold')).toBe('beforeCold')
})

test('Before the cache goes cold: the fixed value applies until you set the row, and then your row wins', async () => {
  expect(FIXED.beforeCold).toBe('keep warm until my usual start')
  const values = { ...defaults(), beforeCold: 'compact' }
  // Not set: the row's own value (here compact) is only the default's stand-in, and the fixed value applies.
  expect(inUse(defaults(), set()).beforeCold).toBe('keep warm until my usual start')
  expect(inUse(values, set()).beforeCold, 'a value that is not yours changes nothing').toBe('keep warm until my usual start')
  // Set: yours.
  expect(inUse(values, set('beforeCold')).beforeCold).toBe('compact')
  expect(inUse({ ...defaults(), beforeCold: 'off' }, set('beforeCold')).beforeCold).toBe('off')
  expect(inUse({ ...defaults(), beforeCold: 'keep warm 2 h' }, set('beforeCold')).beforeCold, 'your setting wins over the fixed value').toBe('keep warm 2 h')
  // Set back to the default "ask", it is still yours: it asks.
  expect(inUse(defaults(), set('beforeCold')).beforeCold).toBe('ask')
})

test('Mode: watch only is read off its value', async () => {
  expect(watchOnly('watch only')).toBe(true)
  expect(watchOnly('act')).toBe(false)
})
