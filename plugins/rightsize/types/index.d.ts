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

/** The person's answers to Q1-Q4; a missing key is asked the first time it comes up. */
export type RightsizeChoices = {
  lower?: 'auto' | 'ask' | 'never'
  raise?: 'auto' | 'ask' | 'never'
  up?: 'auto' | 'ask' | 'stay' | 'each'
  down?: 'auto' | 'ask' | 'stay' | 'each'
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
    }
  }
}
