import { expect, test } from 'claude-code/testing'
import { ADVANCED, AREA_KEYS, KEYS, PANE_KEYS, SETTINGS, SAME_AS_CHANGES, type SettingKey, areaMode, changesFromStored, defaults, fieldsSet, plainTitle, settingNamed, valueOf } from './settings'

// P-81 step 1 (ADR 0094): one global Changes row (Auto or Ask), three area overrides (Prompt, Cache, Compact),
// and one resolver the code asks, so a mode is read in one place.

const set = (...keys: SettingKey[]) => new Set<SettingKey>(keys)
const with_ = (over: Record<string, string>) => ({ ...defaults(), ...over })

test('Changes is the fourth row, a plain row: Auto or Ask, Auto by default; Ask before changing has no row any more', async () => {
  expect(KEYS.slice(0, 6)).toEqual(['mode', 'routing', 'handOffs', 'changes', 'cache', 'band'])
  expect(KEYS as readonly string[]).not.toContain('askFirst')
  expect(SETTINGS.changes.title).toBe('Changes')
  expect([...SETTINGS.changes.options]).toEqual(['Auto', 'Ask'])
  expect(SETTINGS.changes.default).toBe('Auto')
  expect(plainTitle(SETTINGS.changes.title)).toBe('Changes')
  expect(settingNamed('changes')).toBe('changes')
  expect(valueOf('changes', 'on'), 'an old Ask before changing value is not an option of this row').toBe('Auto')
  expect(PANE_KEYS.filter(k => !SETTINGS[k].title.startsWith(ADVANCED))).toEqual(['mode', 'routing', 'handOffs', 'changes', 'cache', 'band'])
})

test('the three area rows are Advanced rows: Same as Changes, Auto, Ask or Off, Same as Changes by default', async () => {
  expect(AREA_KEYS).toEqual({ prompt: 'promptMode', cache: 'cacheMode', compact: 'compactMode' })
  expect(SAME_AS_CHANGES).toBe('Same as Changes')
  for (const k of Object.values(AREA_KEYS)) {
    const row = SETTINGS[k]
    expect([...row.options], k).toEqual(['Same as Changes', 'Auto', 'Ask', 'Off'])
    expect(row.default, k).toBe('Same as Changes')
    expect(row.title.startsWith(ADVANCED), `${k} is an Advanced row`).toBe(true)
    expect(PANE_KEYS, k).toContain(k)
  }
  // The Cache row (the feature switch) keeps its name: the area row's title tells them apart.
  expect(SETTINGS.cache.title).toBe('Cache')
  expect(SETTINGS.cacheMode.title).not.toBe('Cache')
  expect(settingNamed('cache')).toBe('cache')
  expect(settingNamed(plainTitle(SETTINGS.cacheMode.title))).toBe('cacheMode')
  expect(settingNamed(plainTitle(SETTINGS.promptMode.title))).toBe('promptMode')
  expect(settingNamed(plainTitle(SETTINGS.compactMode.title))).toBe('compactMode')
  // The four rule rows stay, with their values.
  expect([...SETTINGS.lowerRule.options]).toEqual(['ask me', 'lower automatically', 'never lower', 'not set'])
  expect(SETTINGS.lowerRule.default).toBe('not set')
})

test('areaMode: with default settings every area is auto', async () => {
  for (const area of ['prompt', 'cache', 'compact'] as const) expect(areaMode(area, defaults(), set()), area).toBe('auto')
})

test('areaMode: Same as Changes follows Changes, for each area', async () => {
  for (const area of ['prompt', 'cache', 'compact'] as const) {
    expect(areaMode(area, with_({ changes: 'Ask' }), set('changes')), `${area}: Changes Ask`).toBe('ask')
    expect(areaMode(area, with_({ changes: 'Auto' }), set('changes')), `${area}: Changes Auto`).toBe('auto')
  }
})

test('areaMode: an area row that is not Same as Changes wins over Changes, for its area only', async () => {
  for (const changes of ['Auto', 'Ask']) {
    for (const [value, mode] of [['Auto', 'auto'], ['Ask', 'ask'], ['Off', 'off']] as const) {
      const v = with_({ changes, promptMode: value })
      expect(areaMode('prompt', v, set('changes', 'promptMode')), `Prompt ${value} over Changes ${changes}`).toBe(mode)
      expect(areaMode('cache', v, set('changes', 'promptMode')), 'Cache is not Prompt').toBe(changes === 'Ask' ? 'ask' : 'auto')
      expect(areaMode('compact', v, set('changes', 'promptMode')), 'Compact is not Prompt').toBe(changes === 'Ask' ? 'ask' : 'auto')
    }
  }
  expect(areaMode('cache', with_({ cacheMode: 'Off' }), set('cacheMode'))).toBe('off')
  expect(areaMode('compact', with_({ compactMode: 'Ask' }), set('compactMode'))).toBe('ask')
})

test('areaMode: a Quality profile an older release stored reads as Changes Ask until Changes is yours', async () => {
  expect(areaMode('prompt', defaults(), set(), true)).toBe('ask')
  expect(areaMode('cache', defaults(), set(), true)).toBe('ask')
  expect(areaMode('prompt', with_({ changes: 'Auto' }), set('changes'), true), 'your Changes wins over the old profile').toBe('auto')
  expect(areaMode('prompt', with_({ promptMode: 'Auto' }), set('promptMode'), true), 'an area row wins over it too').toBe('auto')
})

test('changesFromStored: an Ask before changing value an older release stored maps to Changes; nothing else does', async () => {
  const stored = (o: Record<string, unknown>) => ({ rightsize: { options: o } })
  expect(changesFromStored(stored({ askFirst: 'on' }))).toBe('Ask')
  expect(changesFromStored(stored({ askFirst: 'off' }))).toBe('Auto')
  expect(changesFromStored({ 'rightsize@archid21': { options: { askFirst: 'on' } } }), 'under a marketplace key too').toBe('Ask')
  expect(changesFromStored(stored({}))).toBeUndefined()
  expect(changesFromStored(stored({ askFirst: 'maybe' }))).toBeUndefined()
  expect(changesFromStored(undefined)).toBeUndefined()
  expect(changesFromStored({ other: { options: { askFirst: 'on' } } }), 'another plugin\'s row').toBeUndefined()
})

test('the stale askFirst value is never a setting: it is not yours and not a value', async () => {
  expect(fieldsSet({ rightsize: { options: { askFirst: 'on' } } })).toEqual(set())
  expect(valueOf('changes', 'Ask')).toBe('Ask')
})
