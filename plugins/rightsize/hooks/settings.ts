import type { RightsizeChoices as Choices } from '../types'
import { MISS_BLOCK, parseShare } from './cost'

// The settings in /config, in one table: each row's title, its options and its
// default. plugin.json declares the same rows (every one a string picker), and a
// test checks that the two agree. Your setting wins: a value you set is never
// changed or bypassed by rightsize's own behaviour, so it has to know which
// values are yours. Claude Code hands the module every value with defaults filled
// in, so it cannot tell them apart; it reads them off settings.json instead, and
// follows the changes made in /config. Pure functions, no engine calls.

type Spec = { title: string; options: readonly string[]; default: string }

/** The four questions, as /config rows: each choice's label, and the value it stands for. */
export const RULE_LABELS: { [K in keyof Choices]-?: readonly (readonly [string, NonNullable<Choices[K]>])[] } = {
  lower: [['ask me', 'ask'], ['lower automatically', 'auto'], ['never lower', 'never']],
  raise: [['ask me', 'ask'], ['raise automatically', 'auto'], ['never raise', 'never']],
  up: [['ask first', 'ask'], ['always send', 'auto'], ['stay, raise effort only', 'stay'], ['ask each time', 'each']],
  down: [['ask first', 'ask'], ['always send', 'auto'], ['stay, lower effort only', 'stay'], ['ask each time', 'each']],
}

/** What a rule row holds while the question has not been answered. */
export const NOT_SET = 'not set'
const ruleOptions = (rule: keyof Choices) => [...RULE_LABELS[rule].map(l => l[0]), NOT_SET]

/** The /config row that holds each rule. */
export const RULE_KEYS = { lower: 'lowerRule', raise: 'raiseRule', up: 'upRule', down: 'downRule' } as const

export const SETTINGS = {
  floor: { title: 'Lowest effort', options: ['low', 'medium', 'high'], default: 'low' },
  ceiling: { title: 'Highest effort', options: ['high', 'xhigh', 'max'], default: 'max' },
  lowerRule: { title: 'Lowering', options: ruleOptions('lower'), default: NOT_SET },
  raiseRule: { title: 'Raising', options: ruleOptions('raise'), default: NOT_SET },
  upRule: { title: 'Stronger model', options: ruleOptions('up'), default: NOT_SET },
  downRule: { title: 'Cheaper model', options: ruleOptions('down'), default: NOT_SET },
  remember: { title: 'Remember choices', options: ['ask', 'every session', 'this session'], default: 'ask' },
  handOff: { title: 'Hand-off threshold', options: ['50%', '60%', '70%', '80%', '90%'], default: '70%' },
  lowering: { title: 'Lowering threshold', options: ['70%', '80%', '90%', '95%'], default: '90%' },
  useHaiku: { title: 'Use Haiku', options: ['on', 'off'], default: 'on' },
  useFable: { title: 'Use Fable', options: ['on', 'off'], default: 'on' },
  subagents: { title: "Claude's subagents", options: ['cheaper when it fits', 'off'], default: 'cheaper when it fits' },
  workflows: { title: 'Workflows', options: ['ask', 'pause rightsize', 'follow my rules', 'right-size every agent'], default: 'ask' },
  explore: { title: 'Explore close calls', options: ['on', 'off'], default: 'on' },
  missPause: { title: 'Pause after misses', options: ['off', '20%', '30%', '40%', '50%'], default: '30%' },
  pacing: { title: 'Budget pacing', options: ['on', 'off'], default: 'on' },
  escalation: { title: 'Raise when stuck', options: ['on', 'off'], default: 'on' },
  stuck: { title: 'Stuck sensitivity', options: ['relaxed', 'normal', 'sensitive'], default: 'normal' },
  minWords: { title: 'Rate prompts from', options: ['3 words', '6 words', '10 words', '20 words'], default: '6 words' },
  raterCheck: { title: 'Rater check', options: ['every 25', 'every 50', 'every 100', 'off'], default: 'every 50' },
  startTips: { title: 'Start suggestions', options: ['weekly', 'monthly', 'off'], default: 'weekly' },
  idleWarning: { title: 'Idle warning', options: ['over $0.10', 'over $0.50', 'over $1', 'off'], default: 'over $0.10' },
  billing: { title: 'Reports', options: ['api', 'subscription'], default: 'api' },
  band: { title: 'Band', options: ['when it acts', 'always', 'off'], default: 'when it acts' },
  share: { title: 'Share anonymous feedback', options: ['off', 'on'], default: 'off' },
  priceCheck: { title: 'Price check', options: ['monthly', 'off'], default: 'monthly' },
} as const satisfies Record<string, Spec>

export type SettingKey = keyof typeof SETTINGS
export type Values = Record<SettingKey, string>

export const KEYS = Object.keys(SETTINGS) as SettingKey[]
export const isKey = (k: unknown): k is SettingKey => typeof k === 'string' && Object.hasOwn(SETTINGS, k)

/** True when `v` is one of the row's options: anything else counts as unset, and the default applies. */
export const inOptions = (key: SettingKey, v: unknown): v is string => typeof v === 'string' && (SETTINGS[key].options as readonly string[]).includes(v)

/** The row's value: `v` when it is one of its options, else the default. */
export const valueOf = (key: SettingKey, v: unknown): string => (inOptions(key, v) ? v : SETTINGS[key].default)

export const defaults = (): Values => Object.fromEntries(KEYS.map(k => [k, SETTINGS[k].default])) as Values

/** Every row's value from the options Claude Code passes the module. */
export const valuesOf = (options: Readonly<Record<string, unknown>> | undefined): Values =>
  Object.fromEntries(KEYS.map(k => [k, valueOf(k, options?.[k])])) as Values

// ---- Whose value it is ---------------------------------------------------------

/** The plugin keys settings.json files its options under: `rightsize`, or `rightsize@<marketplace>`. */
const isPluginKey = (k: string) => k === 'rightsize' || k.startsWith('rightsize@')

/**
 * The options stored for this plugin in settings.json (`pluginConfigs[<plugin key>].options`),
 * merged when it is stored under more than one key. Undefined when `configs` is not an object.
 */
export function storedOptions(configs: unknown): Record<string, unknown> | undefined {
  if (!configs || typeof configs !== 'object' || Array.isArray(configs)) return undefined
  const out: Record<string, unknown> = {}
  for (const [k, entry] of Object.entries(configs as Record<string, unknown>)) {
    if (!isPluginKey(k)) continue
    const options = entry && typeof entry === 'object' ? (entry as { options?: unknown }).options : undefined
    if (options && typeof options === 'object' && !Array.isArray(options)) Object.assign(out, options)
  }
  return out
}

/**
 * The fields you set: those stored in settings.json with a value among the row's options
 * (a stored value outside them counts as unset). When settings cannot be read at all,
 * a value that differs from its default can only have been set, so those count.
 */
export function fieldsSet(configs: unknown, options?: Readonly<Record<string, unknown>>, reset: readonly SettingKey[] = []): ReadonlySet<SettingKey> {
  const stored = storedOptions(configs)
  const src = stored ?? options ?? {}
  const held = new Set(stillReset(configs, options, reset))
  return new Set(KEYS.filter(k => inOptions(k, src[k]) && (stored !== undefined || src[k] !== SETTINGS[k].default) && !held.has(k)))
}

/** The rows in the store's list of fields reset to their defaults, from the store's value; anything else is ignored. */
export const resetKeys = (v: unknown): SettingKey[] => (Array.isArray(v) ? [...new Set(v.filter(isKey))] : [])

/**
 * The reset fields still at their default. Claude Code cannot unset a stored value, so a reset writes the default
 * and keeps a list: a field on it is not yours while its stored value is the default. Once the stored value is
 * anything else (you set it again, in /config or by hand), it is yours again and leaves the list.
 */
export function stillReset(configs: unknown, options: Readonly<Record<string, unknown>> | undefined, reset: readonly SettingKey[]): SettingKey[] {
  const src = storedOptions(configs) ?? options ?? {}
  return [...new Set(reset)].filter(k => !inOptions(k, src[k]) || src[k] === SETTINGS[k].default)
}

/**
 * The row `name` means: its key as spelled ("handOff"), else its title in any case ("hand-off threshold"), else its
 * key in any case ("handoff"). The first wins, since "Lowering" is the title of one row and the key of another:
 * `lowering` is the threshold, `Lowering` the rule.
 */
export function settingNamed(name: string): SettingKey | undefined {
  const exact = KEYS.find(k => k === name.trim())
  if (exact) return exact
  const want = name.trim().toLowerCase().replace(/\s+/g, ' ')
  if (!want) return undefined
  return KEYS.find(k => SETTINGS[k].title.toLowerCase() === want) ?? KEYS.find(k => k.toLowerCase() === want)
}

/** A change made in /config by the person: the menu (`composer`) or a `/config key=value` from their phone (`bridge`). */
const byPerson = (origin: { kind: string } | undefined) => origin?.kind === 'composer' || origin?.kind === 'bridge'

/**
 * The fields you set, after a `config.set` on `key` (as `<plugin>.<field>`): a change by the person marks
 * its field as yours. A rule row set back to "not set" is unset again. A value outside the row's options,
 * a change by another plugin, or one that names no origin, changes nothing.
 */
export function afterSet(yours: ReadonlySet<SettingKey>, key: string, value: unknown, origin: { kind: string } | undefined): ReadonlySet<SettingKey> {
  const name = key.startsWith('rightsize.') ? key.slice('rightsize.'.length) : ''
  if (!isKey(name) || !inOptions(name, value) || !byPerson(origin)) return yours
  return mark(yours, name, value !== NOT_SET)
}

/** The fields you set with `key` added, or taken out. */
export function mark(yours: ReadonlySet<SettingKey>, key: SettingKey, set: boolean): ReadonlySet<SettingKey> {
  const next = new Set(yours)
  if (set) next.add(key)
  else next.delete(key)
  return next
}

/**
 * What a manifest's `userConfig` has to change to match SETTINGS. Claude Code fills every declared field's
 * default into the options the module gets, so a missing field is not declared, and an unlisted one is not
 * in the table; a field you did not set must hold the table's default.
 */
export function manifestGaps(options: Readonly<Record<string, unknown>> | undefined, yours: ReadonlySet<SettingKey>): string[] {
  const out: string[] = []
  for (const k of KEYS) {
    if (options?.[k] === undefined) out.push(`${k} is not declared`)
    else if (!yours.has(k) && options[k] !== SETTINGS[k].default) out.push(`${k} defaults to ${JSON.stringify(options[k])}, not ${JSON.stringify(SETTINGS[k].default)}`)
  }
  for (const k of Object.keys(options ?? {})) if (!isKey(k)) out.push(`${k} is not in the table`)
  return out
}

// ---- Rules ---------------------------------------------------------------------

const RULES = Object.keys(RULE_KEYS) as (keyof Choices)[]

/** The value a rule row's label stands for; undefined for "not set", or a label the row does not have. */
export function ruleValue<K extends keyof Choices>(rule: K, label: string): NonNullable<Choices[K]> | undefined {
  return RULE_LABELS[rule].find(l => l[0] === label)?.[1] as NonNullable<Choices[K]> | undefined
}

/** The row's label for a rule's value; "not set" when there is none. */
export function ruleLabel(rule: keyof Choices, value: string | undefined) {
  return RULE_LABELS[rule].find(l => l[1] === value)?.[0] ?? NOT_SET
}

/** The rules the rule rows hold: those not left at "not set". */
export function rulesOf(values: Readonly<Record<string, string>>): Choices {
  const out: Choices = {}
  for (const rule of RULES) {
    const v = ruleValue(rule, values[RULE_KEYS[rule]] ?? NOT_SET)
    if (v !== undefined) (out as Record<string, string>)[rule] = v
  }
  return out
}

// ---- Values the rows stand for -------------------------------------------------

/** "6 words" as 6. */
export const minWordsOf = (v: string) => Number.parseInt(v, 10) || 6

/** "every 50" as 50; "off" as null. */
export function raterEvery(v: string): number | null {
  const m = /^every (\d+)$/.exec(v)
  return m ? Number(m[1]) : null
}

/** "30%" as 0.3; "off" as null. */
export const missPauseOf = (v: string): number | null => (v === 'off' ? null : parseShare(v, MISS_BLOCK))
