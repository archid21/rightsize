// The context-size warning (ADR 0013, decision 1): a band row at 40, 50, 60, 70, 80 and 90% of the window, once per step per
// conversation, with a Compact now button. It skips every step at or above the point where Claude Code compacts by itself
// (`autoCompactThreshold`). This file is the pure part; register.tsx reads the usage, draws the row and compacts on the button.

export const SIZE_STEPS = [40, 50, 60, 70, 80, 90] as const

/**
 * The step to warn about: the highest step the conversation has reached that is above `shown` (the last step already said)
 * and whose token count is under `autoCompactThreshold` (absent: auto-compaction is off, so no step is skipped).
 * Undefined when there is none, or a figure is not a usable number.
 */
export function sizeStep(tokens: number | undefined, window: number | undefined, autoCompactThreshold: number | undefined, shown: number): number | undefined {
  if (typeof tokens !== 'number' || typeof window !== 'number' || !Number.isFinite(tokens) || !Number.isFinite(window) || window <= 0 || tokens <= 0) return undefined
  const percent = (tokens / window) * 100
  const auto = typeof autoCompactThreshold === 'number' && autoCompactThreshold > 0 ? autoCompactThreshold : Infinity
  const reached = SIZE_STEPS.filter(s => s > shown && percent >= s && (window * s) / 100 < auto)
  return reached.at(-1)
}

export const SIZE_COMPACT = 'size-compact'
export const SIZE_WHY_ID = 'size-why'
export const SIZE_HIDE = 'size-hide'
export const SIZE_BUTTON = { id: SIZE_COMPACT, label: 'Compact now' }
export const SIZE_MORE: readonly { id: string; label: string }[] = [
  { id: SIZE_WHY_ID, label: 'Why?' },
  { id: SIZE_HIDE, label: "Don't show again" },
]
export const isSizeId = (id: string) => id === SIZE_COMPACT || id === SIZE_WHY_ID || id === SIZE_HIDE

export const SIZE_WHY =
  'Every request re-reads the whole conversation, so a bigger one costs more on each turn, and a cold cache writes all of it again. A compact now leaves a short summary instead.'

/** "Context is 60% full (120K of 200K tokens). A compact now makes every later turn cheaper." */
export function sizeText(step: number, tokens: number, window: number) {
  const k = (n: number) => `${Math.round(n / 1000)}K`
  return `Context is ${step}% full (${k(tokens)} of ${k(window)} tokens). A compact now makes every later turn cheaper.`
}
