export type RightsizeLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type RightsizeTier = 'haiku' | 'sonnet' | 'opus' | 'fable'
export type RightsizeTaskType =
  | 'lookup'
  | 'search'
  | 'bulk-edit'
  | 'extract'
  | 'summarize'
  | 'feature'
  | 'debug'
  | 'refactor'
  | 'review'
  | 'design'
  | 'writing'
  | 'other'

/** The person's answers to Q1-Q4, or the rules they set in /config (Lowering, Raising, Stronger model, Cheaper model); a missing key is asked the first time it comes up. */
export type RightsizeChoices = {
  lower?: 'auto' | 'ask' | 'never'
  raise?: 'auto' | 'ask' | 'never'
  up?: 'auto' | 'ask' | 'stay' | 'each'
  down?: 'auto' | 'ask' | 'stay' | 'each'
}

/** When the band above the prompt shows (Band in /config). */
export type RightsizeBandMode = 'when it acts' | 'always' | 'off'

/** What the band above the prompt shows for the last rated prompt. */
export type RightsizeBand = {
  /** The one line: what rightsize did, or that it changed nothing. */
  text: string
  /** True when rightsize changed something: the band shows under "when it acts". */
  acted: boolean
  /** The situation whose rule the band's buttons change. */
  rule?: keyof RightsizeChoices
  /** The prompt was lowered on its own and can be run again at the normal level. */
  canUndo?: boolean
  /** A session switch can be dropped. */
  canClear?: boolean
  /** A suggested starting model and level (`sonnet:high`): the band offers Not now and Stop suggesting. */
  tip?: string
  /** The id of the run this band is about: the band offers 👍 and 👎, which tune rightsize on this machine only. */
  rate?: string
}

declare module 'claude-code' {
  interface PluginState {
    'rightsize': {
      /** The level chosen with "for this session"; null when none. */
      sessionEffort: RightsizeLevel | null
      /** The session's own level, as last seen on a main-thread request; null before the first. */
      seenEffort: RightsizeLevel | null
      /** The main thread's model id, as last reported by the API; null before the first. */
      seenModel: string | null
      /** Tokens in the main conversation's last request. */
      context: number
      /** Answers to Q1-Q4 for this session. */
      choices: RightsizeChoices
      /** True once "Use these choices in every session?" was answered this session. */
      rememberAsked: boolean
      /** The band above the prompt; null when there is nothing to show or it was closed. */
      band: RightsizeBand | null
      /** When the band shows. */
      bandMode: RightsizeBandMode
    }
  }
}
