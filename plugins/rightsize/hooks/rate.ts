import type { RightsizeLevel as Level, RightsizeTier as Tier } from '../types'
import { TIERS, TIER_NAME, type Fit, isLevel, isTaskType, isTier, levelRank, needOn, tierRank, type Rating } from './cost'

// The rating: one cheap Haiku call that reads the prompt (and the last reply,
// so "yes, go ahead" is rated as the task it continues) and returns JSON.

export const ratingSystem = (tier: Tier, level: Level) => `You route one request for an AI coding assistant (Claude Code). It now runs on ${TIER_NAME[tier]} at ${level} effort. Models from weakest to strongest: haiku, sonnet, opus, fable.

Return JSON only, no prose, no code fences:
{"fit":{"haiku":"<level|no>","sonnet":"<level|no>","opus":"<level|no>","fable":"<level|no>"},"type":"<type>","read":<tokens>,"write":<tokens>,"steps":<number>,"approval":<true|false>,"reason":"<at most 8 words>"}

fit, for each model: the lowest reasoning effort at which that model would do this work well, or "no" when it would likely struggle at any effort. A weaker model needs the same or a higher level than a stronger one for the same work. The levels:
- low: quick lookups, one-line answers, renames, typo fixes, running one known command, simple questions.
- medium: ordinary single-file edits, short explanations, small scripts, routine tasks with a clear path.
- high: multi-file changes, debugging with an unknown cause, design choices with trade-offs, tests for real logic, careful reviews.
- xhigh: large refactors, tricky concurrency or security work, hard algorithms, long multi-step plans.
- max: the hardest problems only, where a wrong answer is costly and deep reasoning clearly pays off.

A stronger model fits whatever a weaker one fits. Say "no" for the current model only when it is likely to struggle (hard reasoning, subtle bugs, high-stakes design). A cheaper model fits routine or mechanical work: haiku for finding, listing, copying the same edit, pulling out data, formatting; sonnet for routine coding and writing that needs some judgement. When unsure whether a cheaper model fits, say "no" for it.

type: one of lookup, search, bulk-edit, extract, summarize, feature, debug, refactor, review, design, writing, other.
read: your estimate of the tokens of files, logs and tool output the work will read. write: the tokens of code and text it will write, thinking left out. steps: the tool calls it will make.
approval: true when the request is mainly a step only the person can approve: pushing, publishing, releasing, deploying, sending a message, or acting in their accounts, with little other work. Such a request stays with the current assistant, because a subagent cannot see the person's approval. Otherwise false.

Judge the work, not the length of the request. A short follow-up such as "yes, go ahead" continues the task in the last reply: rate that task. When unsure between two levels, pick the lower one.`

export function ratingPrompt(text: string, lastReply: string) {
  const reply = lastReply.trim() ? `<last_reply>\n${lastReply.slice(-1500)}\n</last_reply>\n\n` : ''
  return `${reply}<request>\n${text.slice(0, 6000)}\n</request>`
}

const count = (v: unknown, fallback: number, max: number) =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(max, Math.round(v)) : fallback

const lower = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : '')

// Each model's level, or null where it would struggle. A stronger model fits at no
// higher a level than a weaker one that fits, so the rater's gaps and slips are
// filled from the models below. The older {level, model} reply still reads: the
// level for the named model (or the current one), "no" for the current one when a
// stronger model was named.
function readFit(json: Record<string, unknown>, tier: Tier): Fit | undefined {
  const fit: Fit = {}
  const given = json.fit && typeof json.fit === 'object' ? (json.fit as Record<string, unknown>) : undefined
  if (given) {
    for (const t of TIERS) {
      const v = lower(given[t])
      if (isLevel(v)) fit[t] = v
      else if (v === 'no') fit[t] = null
    }
  } else {
    const level = lower(json.level)
    const model = lower(json.model)
    if (!isLevel(level)) return undefined
    const named = isTier(model) ? model : tier
    fit[named] = level
    if (named !== tier) fit[tier] = tierRank(named) > tierRank(tier) ? null : level
  }
  let below: Level | undefined
  for (const t of TIERS) {
    const v = fit[t]
    if (below && (!v || levelRank(v) > levelRank(below))) fit[t] = below
    below = fit[t] ?? below
  }
  return TIERS.some(t => fit[t]) ? fit : undefined
}

// Reads the rating's reply for a session on `tier`. Undefined when no model fits at any level.
export function parseRating(raw: string, tier: Tier): Rating | undefined {
  const a = raw.indexOf('{')
  const b = raw.lastIndexOf('}')
  if (a < 0 || b <= a) return undefined
  let json: Record<string, unknown>
  try {
    json = JSON.parse(raw.slice(a, b + 1)) as Record<string, unknown>
  } catch {
    return undefined
  }
  const fit = readFit(json, tier)
  if (!fit) return undefined
  const type = lower(json.type)
  return {
    level: needOn(fit, tier),
    fit,
    type: isTaskType(type) ? type : 'other',
    read: count(json.read, 2000, 2_000_000),
    write: count(json.write, 500, 200_000),
    steps: count(json.steps, 1, 200),
    ...(json.approval === true ? { approval: true } : {}),
    reason: typeof json.reason === 'string' ? json.reason.trim().replace(/[.\s]+$/, '').slice(0, 80) : '',
  }
}
