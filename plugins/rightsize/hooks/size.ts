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

// Wrap up and start fresh (ADR 0051): a second button on the same row, offered only when whatsnext can start a fresh chat.
export const SIZE_FRESH = 'size-fresh'
export const SIZE_FRESH_BUTTON = { id: SIZE_FRESH, label: 'Wrap up and start fresh' }
/** The row's two choices when the handoff note is already fresh (whatsnext's band does not show then): ADR 0024's buttons. */
export const SIZE_FRESH_NEW = 'size-fresh-new'
export const SIZE_FRESH_CLEAR = 'size-fresh-clear'
export const SIZE_FRESH_NOT_NOW = 'size-fresh-not-now'
export const SIZE_FRESH_CHOICES: readonly { id: string; label: string }[] = [
  { id: SIZE_FRESH_NEW, label: 'New session' },
  { id: SIZE_FRESH_CLEAR, label: 'Clear and continue' },
  { id: SIZE_FRESH_NOT_NOW, label: 'Not now' },
]
export const SIZE_FRESH_TEXT = 'The handoff note is up to date. Start fresh with it:'
/** The terminal cannot open a window: the row shows the command (whatsnext's own text) to run in a new one. */
export const sizeFreshNotice = (command: string) => `In a new terminal window, in this project's folder, run: ${command}`
/** When Clear and continue cannot run: the two steps for the person to do (the texts are whatsnext's). */
export const sizeFreshByHand = (clear: string, prompt: string) => `Could not clear this chat. Type /${clear.replace(/^\//, '')}, then: ${prompt}`

export const isSizeId = (id: string) =>
  id === SIZE_COMPACT || id === SIZE_WHY_ID || id === SIZE_HIDE || id === SIZE_FRESH || id === SIZE_FRESH_NEW || id === SIZE_FRESH_CLEAR || id === SIZE_FRESH_NOT_NOW

export const SIZE_WHY =
  'Every request re-reads the whole conversation, so a bigger one costs more on each turn, and a cold cache writes all of it again. A compact now leaves a short summary instead.'
/** Added to Why? when the row offers Wrap up and start fresh. */
export const SIZE_WHY_FRESH =
  ' Wrap up and start fresh has whatsnext save a handoff note, then you start a new chat from it, which begins small instead of carrying a summary.'

/** "Context is 60% full (120K of 200K tokens). A compact now makes every later turn cheaper." */
export function sizeText(step: number, tokens: number, window: number) {
  const k = (n: number) => `${Math.round(n / 1000)}K`
  return `Context is ${step}% full (${k(tokens)} of ${k(window)} tokens). A compact now makes every later turn cheaper.`
}
