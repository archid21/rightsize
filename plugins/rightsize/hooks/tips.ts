// rightsize tips (ADR 0039): the tip list, and the state that survives sessions in `$.store`. Modeled on whatsnext's
// hooks/tips.ts. Pure: register.tsx reads and writes the state in `$.store` (the engine follows `$` only into its
// top-level functions).

export const FEATURES = 'https://github.com/archid21/rightsize/blob/main/docs/FEATURES.md'

export type Tip = {
  id: string
  /** The one line the band shows. */
  text: string
  /** Where the docs explain it. */
  link: string
  /** The band shows this tip's own two buttons (Star on GitHub, No thanks), not Next tip and Stop tips. */
  action?: 'star'
}

// Order matters: Next tip walks this list. The star tip is last, so a person who said No thanks can still find it.
export const TIPS: readonly Tip[] = [
  {
    id: 'report',
    text: 'See what rightsize saved you: /rightsize report.',
    link: `${FEATURES}#seeing-and-controlling-it`,
  },
  {
    id: 'retry',
    text: 'A turn ran at lower effort and you want the original? Press Retry at original effort on the band.',
    link: `${FEATURES}#seeing-and-controlling-it`,
  },
  {
    id: 'rate',
    text: "Right or wrong call? Mark it 👍 or 👎 in the band's ⋯ menu. rightsize learns from it.",
    link: `${FEATURES}#learning`,
  },
  {
    id: 'watch',
    text: "Want to see rightsize's choices before it acts? Set Mode to watch only in /rightsize.",
    link: `${FEATURES}#seeing-and-controlling-it`,
  },
  {
    id: 'helpers',
    text: 'Helpers that run long ask before going past their spend limit; with no answer they go on while they make progress, up to a cap. Change this with Long helpers in /config: ask, continue while making progress, or stop at the limit.',
    link: `${FEATURES}#routing`,
  },
  {
    // The band replaces this text with the repos still to star (./star.ts askText).
    id: 'star',
    text: 'Finding rightsize useful? Star it on GitHub so other people can find it.',
    link: 'https://github.com/archid21/rightsize',
    action: 'star',
  },
]

export type TipsState = { tipsOff: boolean; seen: string[] }

export const STORE_KEY = 'tips'

/** What an older or damaged value reads as: tips on, nothing seen. */
export function parseState(raw: unknown): TipsState {
  const value = (raw ?? {}) as { tipsOff?: unknown; seen?: unknown }
  const known = new Set(TIPS.map(t => t.id))
  const seen = Array.isArray(value.seen) ? value.seen.filter((id): id is string => typeof id === 'string' && known.has(id)) : []
  return { tipsOff: value.tipsOff === true, seen: [...new Set(seen)] }
}

/** `state` with `id` seen. */
export const withSeen = (state: TipsState, id: string): TipsState => (state.seen.includes(id) ? state : { ...state, seen: [...state.seen, id] })

/**
 * The first tip in list order that is not seen and not skipped, starting after `afterId` when given and wrapping no
 * further. `skip` holds tips that do not apply now (the star tip once the repo is starred).
 */
export function nextTip(seen: readonly string[], afterId?: string, skip: readonly string[] = []): Tip | undefined {
  const start = afterId === undefined ? 0 : TIPS.findIndex(t => t.id === afterId) + 1
  return TIPS.slice(start).find(t => !seen.includes(t.id) && !skip.includes(t.id))
}

export const tipById = (id: string) => TIPS.find(t => t.id === id)
