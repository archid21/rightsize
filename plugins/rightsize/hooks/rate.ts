import type { RightsizeLevel as Level, RightsizeTier as Tier } from '../types'
import { TIER_NAME, isLevel, isTaskType, isTier, type Rating } from './cost'

// The rating: one cheap Haiku call that reads the prompt (and the last reply,
// so "yes, go ahead" is rated as the task it continues) and returns JSON.

export const ratingSystem = (tier: Tier, level: Level) => `You route one request for an AI coding assistant (Claude Code). It now runs on ${TIER_NAME[tier]} at ${level} effort. Models from weakest to strongest: haiku, sonnet, opus, fable.

Return JSON only, no prose, no code fences:
{"level":"<low|medium|high|xhigh|max>","model":"<same|haiku|sonnet|opus|fable>","size":"<small|bulky>","type":"<type>","read":<tokens>,"write":<tokens>,"steps":<number>,"reason":"<at most 8 words>"}

level, the reasoning effort the work needs:
- low: quick lookups, one-line answers, renames, typo fixes, running one known command, simple questions.
- medium: ordinary single-file edits, short explanations, small scripts, routine tasks with a clear path.
- high: multi-file changes, debugging with an unknown cause, design choices with trade-offs, tests for real logic, careful reviews.
- xhigh: large refactors, tricky concurrency or security work, hard algorithms, long multi-step plans.
- max: the hardest problems only, where a wrong answer is costly and deep reasoning clearly pays off.

model: "same" unless you are sure. Name a stronger model only when the current one is likely to struggle (hard reasoning, subtle bugs, high-stakes design). Name a cheaper model only for routine or mechanical work: haiku for finding, listing, copying the same edit, pulling out data, formatting; sonnet for routine coding and writing that needs some judgement. When unsure between haiku and sonnet, pick sonnet.

size: "bulky" when the work reads or writes a lot compared with a short brief and report (searching a large codebase, the same edit across many files, summarising long logs or documents, sorting test output, pulling data from many files); otherwise "small".

type: one of lookup, search, bulk-edit, extract, summarize, feature, debug, refactor, review, design, writing, other.
read: your estimate of the tokens of files, logs and tool output the work will read. write: the tokens of code and text it will write, thinking left out. steps: the tool calls it will make.

Judge the work, not the length of the request. A short follow-up such as "yes, go ahead" continues the task in the last reply: rate that task. When unsure between two levels, pick the lower one.`

export function ratingPrompt(text: string, lastReply: string) {
  const reply = lastReply.trim() ? `<last_reply>\n${lastReply.slice(-1500)}\n</last_reply>\n\n` : ''
  return `${reply}<request>\n${text.slice(0, 6000)}\n</request>`
}

const count = (v: unknown, fallback: number, max: number) =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(max, Math.round(v)) : fallback

// Reads the rating's reply. Undefined when it holds no valid level.
export function parseRating(raw: string): Rating | undefined {
  const a = raw.indexOf('{')
  const b = raw.lastIndexOf('}')
  if (a < 0 || b <= a) return undefined
  let json: Record<string, unknown>
  try {
    json = JSON.parse(raw.slice(a, b + 1)) as Record<string, unknown>
  } catch {
    return undefined
  }
  const lower = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : '')
  const level = lower(json.level)
  if (!isLevel(level)) return undefined
  const model = lower(json.model)
  const type = lower(json.type)
  return {
    level,
    model: isTier(model) ? model : 'same',
    size: lower(json.size) === 'bulky' ? 'bulky' : 'small',
    type: isTaskType(type) ? type : 'other',
    read: count(json.read, 2000, 2_000_000),
    write: count(json.write, 500, 200_000),
    steps: count(json.steps, 1, 200),
    reason: typeof json.reason === 'string' ? json.reason.trim().replace(/[.\s]+$/, '').slice(0, 80) : '',
  }
}
