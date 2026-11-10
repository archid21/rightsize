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
  canRetry?: boolean
  /** The prompt was handed to a subagent on another model, or runs one turn on another model: the band offers "Run on <current model>", which runs this prompt once as it would have without rightsize. The rules stay as they are. */
  canStay?: boolean
  /** A session switch can be dropped. */
  canClear?: boolean
  /** The person stepped up the model or effort and rightsize is paused: the band offers Resume rightsize. */
  canResume?: boolean
  /** A suggested starting model and level (`sonnet:high`): the band offers Not now and Stop suggesting. */
  tip?: string
  /** The command that makes the suggested switch (`/model sonnet`): the band offers a button that puts it in the prompt box. */
  tipSwitch?: string
  /** The id of the run this band is about: the band offers 👍 and 👎, which tune rightsize on this machine only. */
  rate?: string
  /** The confidence behind the band's `Confidence: high.`, for the ⋯ menu: `Confidence: high, 42 of your tasks, 4% missed.` Set only on a move to a cheaper model. */
  sure?: string
  /** The dollar amounts behind the line, for the ⋯ menu: the band itself shows one unit. */
  detail?: string
  /** The cache line, shown as a row of its own under `text`: the offer before the cache goes cold, or the keep-warm line. */
  coldText?: string
  /** The cache row's button (`id` says what pressing it does): the offer's first keep-warm choice, or the Stop of a keep-warm run. */
  cold?: { id: string; label: string }[]
  /** The offer's other choices, which the ⋯ menu lists; pressing one does what its `id` says, as a cache button does. */
  coldMore?: { id: string; label: string }[]
  /** A link the cache row draws after its buttons, for a note that points to a page (`href` opens it). */
  coldLink?: { label: string; href: string }
  /** A part of `coldText` drawn in a theme color: the keep-warm countdown. Found by its text, so words added around it keep it; absent there, nothing is colored. */
  coldTone?: { text: string; color: 'success' | 'warning' | 'error' }
}

/** A question the band asks while the work goes on: the next prompt, or the end of the turn, takes it away. */
export type RightsizeQuestion = {
  /** Which asking this is: a press of an older one's button does nothing. */
  id: number
  header: string
  question: string
  /** The options' labels, in order: the band numbers them after its own buttons. */
  options: string[]
  /** What happens with no answer, drawn dim under the question: "this session only". */
  ifNone?: string
}

declare module 'claude-code' {
  interface PluginState {
    'rightsize': {
      /** The level chosen with "for this session"; null when none. */
      sessionEffort: RightsizeLevel | null
      /** The session's own level, as last seen on a main-thread request; null before the first. */
      seenEffort: RightsizeLevel | null
      /** The person's effort as the first step of the last main-chat turn carried it (the engine's own setting, before any rewrite); null before the first. A rise from it is a manual step up. */
      personEffort: RightsizeLevel | null
      /** Set while rightsize is paused because the person stepped up the model or effort: what they stepped to (`model`, `effort`), what they had before (`fromModel`, `fromEffort`), when (`at`, ms) and which step it was (`by`). Rightsize changes neither model nor effort until they resume. Null when not paused. */
      manualPause: { model?: RightsizeTier; effort?: RightsizeLevel; fromModel?: RightsizeTier; fromEffort?: RightsizeLevel; at: number; by: 'model' | 'effort' } | null
      /** The main thread's model id, as last reported by the API; null before the first. */
      seenModel: string | null
      /** The task in progress, from the last rating that started one; null before the first. A prompt that continues it is planned as its type and carries its id. `brief` is the first 600 characters of the prompt that started it, and `prompts` how many prompts it has had (rated or not): the rater is told both. `tests` is how its last turn ended when a test runner ran in it; after a failed run the next prompt is not lowered or handed down (ADR 0021). */
      task: { id: string; type: RightsizeTaskType; brief: string; prompts: number; tests?: 'passed' | 'failed' } | null
      /** The task's retry budget: how many of its chances are used, by a helper raised a level or a rework round on a hand-off. Resets when a new task starts; null before the first. */
      retries: { task: string; used: number } | null
      /** Tokens in the main conversation's last request. */
      context: number
      /** Whether Claude Code will compact this session by itself while it sits idle (ADR 0019), as read at the last main turn's end: `context` is the size it was read at, `at` the time in ms. Absent before the first turn that ended with a conversation. */
      idleCompact: { on: boolean; context: number; at: number }
      /** Answers to Q1-Q4 for this session. */
      choices: RightsizeChoices
      /** True once "Use these choices in every session?" was answered this session. */
      rememberAsked: boolean
      /** The band above the prompt; null when there is nothing to show or it was closed. */
      band: RightsizeBand | null
      /** When the band shows. */
      bandMode: RightsizeBandMode
      /** The question the band shows now; null when none is waiting. */
      question: RightsizeQuestion | null
      /** Counts the changes made in the /rightsize settings pane: the pane reads it while it draws, so a change draws it again with the new values. */
      menu: number
      /** The tip the band's Tip row shows (ADR 0039), and for the star tip the repos it names; null when none. */
      tip: { id: string; repos?: string[] } | null
    }
  }
}
