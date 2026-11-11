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

// Start fresh (ADR 0051): a second button on the same row, offered only when whatsnext can start a fresh chat. It saves the
// handoff note if needed, then the row shows the text to paste into a new session (revised 2026-11-11).
export const SIZE_FRESH = 'size-fresh'
export const SIZE_FRESH_BUTTON = { id: SIZE_FRESH, label: 'Start fresh' }
/** The paste row's buttons: Copy puts whatsnext's `continue_prompt` on the clipboard; Compact now compacts this session; Not now takes the row away. */
export const SIZE_FRESH_COPY = 'size-fresh-copy'
export const SIZE_FRESH_NOT_NOW = 'size-fresh-not-now'
/** Compact now on the paste row: keeps going in this session (same compaction as the warning's button). */
export const SIZE_FRESH_COMPACT = 'size-fresh-compact'
export const SIZE_FRESH_PASTE_BUTTONS: readonly { id: string; label: string }[] = [
  { id: SIZE_FRESH_COPY, label: 'Copy' },
  { id: SIZE_FRESH_COMPACT, label: 'Compact now' },
  { id: SIZE_FRESH_NOT_NOW, label: 'Not now' },
]
/** The desktop paste row: whatsnext's `continue_prompt` follows this text. */
export const sizeFreshPaste = (prompt: string) => `Paste this in a new session in this project to continue fresh: ${prompt}`
/** The terminal cannot copy for you: the row shows the command (whatsnext's own text) to run in a new window. */
export const sizeFreshNotice = (command: string) => `In a new terminal window, in this project's folder, run: ${command}`
/** Said while the wrap-up turn runs. */
export const SIZE_FRESH_SAVING = 'Saving a handoff with whatsnext. The text to start fresh shows here when it is done.'
/** Said when the wrap-up turn ended and the note was still not written. */
export const sizeFreshNotWritten = (turns: number) => `whatsnext's handoff was not written after ${turns} turns, so there is nothing to start fresh from yet.`
/** Added to the paste row when the copy did not work: the text stays on screen to select. */
export const SIZE_FRESH_COPY_FAILED = 'Copy did not work. Select the text above and copy it by hand.'

export const isSizeId = (id: string) =>
  id === SIZE_COMPACT || id === SIZE_WHY_ID || id === SIZE_HIDE || id === SIZE_FRESH || id === SIZE_FRESH_COPY || id === SIZE_FRESH_COMPACT || id === SIZE_FRESH_NOT_NOW

export const SIZE_WHY =
  'Every request re-reads the whole conversation, so a bigger one costs more on each turn, and a cold cache writes all of it again. A compact now leaves a short summary instead.'
/** Added to Why? when the row offers Start fresh. */
export const SIZE_WHY_FRESH =
  ' Start fresh has whatsnext save a handoff note, then gives you a line to paste into a new session in this project, which begins small instead of carrying a summary. Compact now keeps this conversation.'

/** "Context is 60% full (120K of 200K tokens). A compact now makes every later turn cheaper." */
export function sizeText(step: number, tokens: number, window: number) {
  const k = (n: number) => `${Math.round(n / 1000)}K`
  return `Context is ${step}% full (${k(tokens)} of ${k(window)} tokens). A compact now makes every later turn cheaper.`
}
