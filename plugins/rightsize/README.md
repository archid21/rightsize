# rightsize

By [Archi Dubey](https://github.com/archid21), MIT license. Full guide: https://github.com/archid21/rightsize

Before a prompt is sent, rightsize asks Haiku (at low effort) which effort each model would need for it, or whether a model would struggle, and how big the work is. A cost model then prices each model at its own level, counting the work that model does at that level, and picks the cheapest route that fits, which can change the model and the effort together. The mod follows the answers you give the first time each case comes up in a session.

## The four questions

Each question is asked once, the first time its case comes up:

- **Q1 Lowering**, when a prompt needs less effort: Lower automatically · Ask me each time · Never lower.
- **Q2 Raising**, when it needs more effort on the same model: Raise automatically · Ask me each time · Never raise.
- **Q3 Stronger model**, when a stronger model than the current one fits better: Ask before sending it to a subagent · Send it automatically · Stay on the current model, raise effort only · Ask me each time.
- **Q4 Cheaper model**, when a task could run on a cheaper model: Send it to a cheaper subagent · Ask before sending it · Stay on the current model, lower effort only · Ask me each time.

After the first answer, it asks "Use these choices in every session?".

## How it decides

- **Effort changes can cost a cache rewrite.** Anthropic's docs say that changing effort mid-conversation invalidates the conversation's prompt cache, unless the engine uses the per-message-effort beta. The mod counts that cost. In a long chat, lowering effort for one small prompt usually costs more than it saves, so the mod leaves it alone. It also measures whether switches really miss the cache. If they don't, lowering starts to pay and happens more often.
- **Auto-lowered turns step back up** to the normal level after 5 steps, or after a tool error.
- **A subagent is used only when the model changes.** The main chat keeps its model and cache. A hidden note beside your prompt asks the main chat to:
  1. write a brief with a "Done means" list
  2. check the subagent's result against that list
  3. send at most 2 rework notes
  4. report how it went

  On the way down, if the cheaper model still fails after 2 reworks, the main chat finishes the task itself.
- **Handing work down needs a clear saving.** A subagent is used only when the estimate is under 70% of the cost of staying at the level the work needs, counting the brief, the report and the check. The subagent runs at the level its model needs: rightsize sets it. Lowering effort needs the lower level to cost under 90% of staying. Both are defaults you can change in `/config`.
- **Close calls go to the model suited to the task.** When two cheaper models that fit are close in estimated cost, the mod picks by task type:
  - Haiku for lookups, searches, bulk edits, extraction and summaries.
  - Sonnet for writing, reviews, features, debugging, refactors and other work.
  - Opus for design.

  "Close" starts at 25% and shrinks to nothing by 20 measured runs. One close call in five takes the other model, so both get measured. It never overrides the hand-off threshold.
- **Haiku's rating is scored against what happens.** Per task type and model, a hand-off that needed rework, a lowered turn that stepped back up or was raised mid-turn, an unchanged turn raised mid-turn, a 👎, and a Sonnet check that disagreed each count as a miss; a hand-off without rework, a lowered turn that held, a 👍 and an agreeing check count as hits. A type needs 5 outcomes on a model before its own rate counts, else the model's rate across types does (also from 5). Over the last 30 days, a rate of 30% or more stops hand-downs to that model for that kind of work, and lowering effort on it. The starting-point comparison weighs the same rate. All of it is read from the run log on your machine.
- **Sonnet spot-checks Haiku.** On every 50th rated prompt the mod sends the same prompt to Sonnet at low effort in the background, never delaying the prompt, and logs a `check` line with its cost. Where Haiku said a model fits and Sonnet says it would struggle, that is a miss. **Rater check** in `/config` turns it off.
- **Calibration.** After each rated turn, the mod reads the real cost from Claude Code's cost ledger (the `/cost` total), leaving out the Haiku rating call, and moves its estimates toward it. Where there is no ledger, it prices the API's token counts from `prices.json`. Each task type and route is tracked separately, and after 20 runs the measured average replaces the guess. A lowered turn that stepped back up is left out, and sessions running at the same time add to one shared record rather than overwriting each other. When the work-per-model estimates came in, calibration started over once: earlier learning is ignored, not deleted.

A one-row band above the prompt (CLI and desktop app) shows what the mod did, with buttons: Undo or Clear, a quicker rule for this case (Q1–Q4), ⋯ to choose when the band shows, and × to close it. After a hand-off it shows the result, for example: `Sent to Haiku: $0.04 vs about $0.31 on Fable (estimated), saved about 87%.` With the band off, that result is a line in the transcript. A hand-off's result and a lowering also show 👍 and 👎: pressing one logs a `feedback` line, removes the buttons, and tunes the mod's choices on this machine. Nothing is sent anywhere.

## Choosing a starting model

Start on Sonnet 5.5 at medium (cheapest for lookups, searches, edits and writing) or Opus 5.5 at medium (safer for features, debugging and design: hand-offs only go down, and Opus checks them). Avoid Opus at low (frequent raises re-write the cache) and Fable (the biggest saving percent, but the highest total).

Once a week at session start, the mod estimates what the last 30 days of rated prompts would have cost from Sonnet and Opus at medium and high, its own changes counted and Haiku's miss rate on the start's model weighed in. The band suggests a switch when another start is at least 15% cheaper (25% while it has few measured runs) and sends no more than 1 prompt in 10 to a stronger model, or when over 15% of prompts needed a stronger model or a mid-turn raise. It needs 50 rated prompts in 30 days and 20 on the current start. **Not now** quiets it for 14 days; **Stop suggesting** turns it off. It never changes the model itself: switch with `/model`.

## Commands and settings

- `/rightsize` shows the state, the answers and the calibration.
- `/rightsize report` shows what the mod did this session, in the last 7 days and in the last 30 days: prompts rated and changed, the estimated saving after the cost of its rating calls (on a subscription: the share of your 5-hour window kept first, then the share of usage saved, with dollars marked API-equivalent), close calls decided by the task-type guide, a starting-point comparison, how often Haiku's judgement was wrong (with any hand-downs paused for it), and what went wrong. Savings are estimates.
- `/rightsize settings` asks the questions again.
- `/rightsize undo` puts the last auto-lowered prompt back in the box to run at the normal level.
- `/rightsize clear` drops a session-wide switch.
- `/mods` turns the mod on or off.
- `/config`, then rightsize:
  - **Lowest effort** (low, medium or high) sets how far it will lower.
  - **Reports** (api or subscription) sets whether reports show dollars or a share of usage. On a subscription, dollar amounts are marked API-equivalent: what the same tokens would cost at API prices. The mod reads this off each response's rate limits (a subscription shows five-hour and seven-day windows) and asks once only when they show nothing. Setting it here counts as your answer.
  - **Hand-off threshold** (50% to 90%, default 70%) and **Lowering threshold** (70% to 95%, default 90%): how much cheaper a subagent or a lower effort level must be before the mod uses it. Lower is stricter.
  - **Claude's subagents** (cheaper when it fits or off): whether a general-purpose subagent Claude starts without naming a model runs on the cheapest weaker model that fits, at that model's level.
  - **Budget pacing** (on or off): on a subscription, move the thresholds by how fast the 5-hour and 7-day windows are being used. Running out early, it hands off and lowers more readily; with much left near a reset, it puts quality first; over 90% used, it saves all it can and skips raises.
  - **Raise when stuck** (on or off): raise effort one level for the rest of a turn when Claude looks stuck (a tool call failing twice, 3 failing, one call running 3 times, or 3x the rated steps), following your Raising rule.
  - **Idle warning** (over $0.10, over $0.50, over $1 or off): ask before a prompt sent after the cache expired writes the whole conversation again, when that costs over this much (in API-equivalent dollars on a subscription). A subscriber sees the cost as a share of their 5-hour window once runs show the rate.
  - **Start suggestions** (on or off): once a week, suggest a different starting model and level in the band when your log shows one is clearly better. Off: `/rightsize report` still shows the comparison.
  - **Share anonymous feedback** (off or on): send anonymous numbers to the rightsize author, at most once an hour, from when you turn it on: task types, models, effort levels, token guesses, costs, what went wrong, Sonnet checks and your 👍/👎, with a random install ID. Never prompts, code, file names, paths, tool or server names, or session IDs. The mod asks once, after 20 rated prompts. Nothing is sent while `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set.
  - **Rater check** (on or off): on every 50th rated prompt, ask Sonnet in the background for a second opinion on Haiku's rating, to measure how often Haiku is wrong. Off: no checks.
  - **Band** (when it acts, always or off): when the band above the prompt shows. "when it acts", the default, shows it only when the mod changes something.
  - **Price check** (monthly, check now or off): how often `prices.json` is compared with Anthropic's pricing page.
- `prices.json` holds the price table, in dollars per 1M tokens.
  - Every 30 days, at session start, the mod reads Anthropic's pricing page and writes in any changed price. It keeps the old file as `prices.json.bak` and adds a line to the transcript naming each change.
  - If the fetch fails, or the page no longer shows all four models, nothing changes and the check runs again at the next session start.
  - To check sooner, pick **check now** for Price check in `/config` (the row goes back to monthly), or run `/rightsize prices`.

## Limits

- The app's effort picker does not move. The status line shows the level in use.
- Subagents keep their own model and effort unless the mod hands them work, or Claude started them as general-purpose without naming a model. Those the mod may move to a cheaper model.
- The rating is an estimate from Haiku. Calibration corrects the cost guesses, but it can't correct a wrong choice of model. The mod measures how often the rating was wrong and stops trusting it where it keeps missing, but only once enough outcomes are in.

## Logs

- Decisions: `~/.claude/mods-logs/rightsize.log`
- One JSON line per rated turn, with its session, an `id`, change, costs, rating-call cost and rate-limit windows: `~/.claude/mods-logs/rightsize-runs.jsonl`. It also holds a `check` line for each Sonnet spot-check and a `feedback` line for each 👍 or 👎.
