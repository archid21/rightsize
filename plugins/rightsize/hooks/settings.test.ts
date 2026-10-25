import { expect, test } from 'claude-code/testing'
import {
  KEYS,
  NOT_SET,
  RULE_KEYS,
  RULE_LABELS,
  SETTINGS,
  type SettingKey,
  afterSet,
  defaults,
  fieldsSet,
  inOptions,
  isKey,
  manifestGaps,
  mark,
  minWordsOf,
  missPauseOf,
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
} from './settings'

const set = (...keys: SettingKey[]) => new Set<SettingKey>(keys)

test('every row is a picker: a title, two or more options, and a default among them', async () => {
  expect(KEYS.length).toBe(26)
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
  expect(['3 words', '6 words', '10 words', '20 words'].map(minWordsOf)).toEqual([3, 6, 10, 20])
  expect(minWordsOf('words')).toBe(6)
  expect(['every 25', 'every 50', 'every 100'].map(raterEvery)).toEqual([25, 50, 100])
  expect(raterEvery('off')).toBeNull()
  expect(raterEvery('on'), 'the old on is not a row value').toBeNull()
  expect(['20%', '30%', '40%', '50%'].map(missPauseOf)).toEqual([0.2, 0.3, 0.4, 0.5])
  expect(missPauseOf('off')).toBeNull()
})

test('Workflows asks by default, and Price check is monthly or off', async () => {
  expect(SETTINGS.workflows.title).toBe('Workflows')
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
