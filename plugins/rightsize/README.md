# rightsize

By [Archi Dubey](https://github.com/archid21), MIT license. Full guide: https://github.com/archid21/rightsize. Feedback: rightsize@aivalue.blog

Before a prompt is sent, rightsize asks Haiku (at low effort) which effort each model would need for it, or whether a model would struggle, and how big the work is. A cost model then prices each model at its own level, counting the work that model does at that level, and picks the cheapest route that fits, which can change the model and the effort together. The mod follows the answers you give the first time each case comes up in a session. Your setting wins: a value you set in `/config`, or answered when asked, is never changed or bypassed by the mod's own behaviour.

## Install

Needs Claude Code 2.1.287 or newer (2.1.286 in the desktop app). Inside a session:

```
/plugin install rightsize --marketplace archid21/rightsize
```

Then start a new session and type `/rightsize` to check that it works.

## The four questions

Each question is asked once, the first time its case comes up:

- **Q1 Lowering**, when a prompt needs less effort: Lower automatically · Ask me each time · Never lower.
- **Q2 Raising**, when it needs more effort on the same model: Raise automatically · Ask me each time · Never raise.
- **Q3 Stronger model**, when a stronger model than the current one fits better: Ask before sending it to a subagent · Send it automatically · Stay on the current model, raise effort only · Ask me each time.
- **Q4 Cheaper model**, when a task could run on a cheaper model: Send it to a cheaper subagent · Ask before sending it · Stay on the current model, lower effort only · Ask me each time.

After the first answer, it asks "Use these choices in every session?". Each question is also a row in `/config` (**Lowering**, **Raising**, **Stronger model**, **Cheaper model**), and **Remember choices** answers the follow-up ahead of time. A rule set in a row is used as it is, and its question is never asked.

## How it decides

- **Your setting wins.** Automatic adjustments act only on settings left at their default. Budget pacing moves a threshold only when you did not set it; a window nearly used up skips a raise or a stronger model only while its rule has no answer; rate limits never change **Reports** once you set it; "Ask" always asks. `/rightsize` lists the settings you changed; the rest are defaults, shown in `/config`.
- **Effort changes can cost a cache rewrite.** Anthropic's docs say that changing effort mid-conversation invalidates the conversation's prompt cache, unless the engine uses the per-message-effort beta. The mod counts that cost. In a long chat, lowering effort for one small prompt usually costs more than it saves, so the mod leaves it alone. It also measures whether switches really miss the cache. If they don't, lowering starts to pay and happens more often.
- **Auto-lowered turns step back up** to the normal level after 5 steps, or after a tool error.
- **A subagent is used only when the model changes.** The main chat keeps its model and cache. A hidden note beside your prompt asks the main chat to:
  1. write a brief with a "Done means" list
  2. check the subagent's result against that list
  3. send at most 2 rework notes
  4. report how it went

  On the way down, if the cheaper model still fails after 2 reworks, the main chat finishes the task itself.

  Steps only you can approve (push, publish, release, deploy, send) stay in the main chat: the subagent prepares the work and stops, since it can't see your approval, and rightsize blocks those steps if it tries them. A request that is mainly such a step isn't handed off.
- **Handing work down needs a clear saving.** A subagent is used only when the estimate is under 70% of the cost of staying at the level the work needs, counting the brief, the report and the check. The subagent runs at the level its model needs: rightsize sets it. Lowering effort needs the lower level to cost under 90% of staying. Both are defaults you can change in `/config`. **Highest effort** caps how high the mod raises effort, including the level a subagent runs at, and **Use Haiku** and **Use Fable** turn off the work sent to either model.
- **Close calls go to the model suited to the task.** When two cheaper models that fit are close in estimated cost, the mod picks by task type:
  - Haiku for lookups, searches, bulk edits, extraction and summaries.
  - Sonnet for writing, reviews, features, debugging, refactors and other work.
  - Opus for design.

  "Close" starts at 25% and shrinks to nothing by 20 measured runs. One close call in five takes the other model, so both get measured (**Explore close calls** turns that off). It never overrides the hand-off threshold.
- **Haiku's rating is scored against what happens.** Per task type and model, a hand-off that needed rework, a lowered turn that stepped back up or was raised mid-turn, an unchanged turn raised mid-turn, a 👎, and a Sonnet check that disagreed each count as a miss; a hand-off without rework, a lowered turn that held, a 👍 and an agreeing check count as hits. A type needs 5 outcomes on a model before its own rate counts, else the model's rate across types does (also from 5). Over the last 30 days, a rate at or over the **Pause after misses** line (30% by default) stops hand-downs to that model for that kind of work, and lowering effort on it. The starting-point comparison weighs the same rate. All of it is read from the run log on your machine.
- **Sonnet spot-checks Haiku.** On every 50th rated prompt (**Rater check** sets 25, 50 or 100) the mod sends the same prompt to Sonnet at low effort in the background, never delaying the prompt, and logs a `check` line with its cost. Where Haiku said a model fits and Sonnet says it would struggle, that is a miss. **Rater check** in `/config` turns it off.
- **Calibration.** After each rated turn, the mod reads the real cost from Claude Code's cost ledger (the `/cost` total), leaving out the Haiku rating call, and moves its estimates toward it. Where there is no ledger, it prices the API's token counts from `prices.json`. Each task type and route is tracked separately, and after 20 runs the measured average replaces the guess. A lowered turn that stepped back up is left out, and sessions running at the same time add to one shared record rather than overwriting each other. When the work-per-model estimates came in, calibration started over once: earlier learning is ignored, not deleted.

A one-row band above the prompt (CLI and desktop app) shows what the mod did, with buttons: Undo or Clear, a quicker rule for this case (Q1–Q4), ⋯ to choose when the band shows, and × to close it. After a hand-off it shows the result, for example: `Sent to Haiku: $0.04 vs about $0.31 staying on Fable (estimated), saved about 87%.` With the band off, that result is a line in the transcript. A hand-off's result and a lowering also show 👍 and 👎: pressing one logs a `feedback` line, removes the buttons, and tunes the mod's choices on this machine. Nothing is sent anywhere.

## Choosing a starting model

Start on Sonnet 5.5 at medium (cheapest for lookups, searches, edits and writing) or Opus 5.5 at medium (safer for features, debugging and design: hand-offs only go down, and Opus checks them). Avoid Opus at low (frequent raises re-write the cache) and Fable (the biggest saving percent, but the highest total).

Once a week (or a month) at session start, the mod estimates what the last 30 days of rated prompts would have cost from Sonnet and Opus at medium and high, its own changes counted and Haiku's miss rate on the start's model weighed in. The band suggests a switch when another start is at least 15% cheaper (25% while it has few measured runs) and sends no more than 1 prompt in 10 to a stronger model, or when over 15% of prompts needed a stronger model or a mid-turn raise. It needs 50 rated prompts in 30 days and 20 on the current start. **Not now** quiets it for 14 days; **Stop suggesting** turns it off. The estimate follows your Use Haiku, Use Fable and Highest effort settings. It never changes the model itself: switch with `/model`.

## Commands and settings

- `/rightsize` shows the settings you changed (the rest are defaults, shown in `/config`), the session switch and the measured runs.
- `/rightsize help` lists every command and what it does. An unknown command shows the same list.
- `/rightsize report` shows what the mod did, as plain text in the terminal and as Markdown in the desktop app (its tables in code blocks, so the columns line up). It opens with one sentence for the last 30 days (on a subscription: the share of your 5-hour window kept; on the API: the dollars saved), then a table of this session, the last 7 days and the last 30 days: savings first (Total saved after the cost of its rating calls, the window share saved on a subscription, the share of cost saved, and the extra spent on harder prompts), then prompts rated and what was kept, lowered, raised or sent to another model. On a subscription, the footer says dollar amounts are what the same use would cost on the API, and that you only pay for your subscription. Below that are sections for the last 30 days: Starting point (a comparison of starting models), Fixed context (the tokens sent with every request, a note that it adds to cost in every session and cutting it saves more, the least it cost as a share of what those turns cost, then each part largest first with the biggest MCP servers named), Accuracy (how often Haiku's judgement was wrong, how the Sonnet spot-checks went, hand-downs paused for misses, how far estimates were off), Not counted as savings (turns with no saving counted, and why) and Next steps (what to do about them, left out when there is nothing). Savings are estimates: what staying at your own model and effort would have cost.
- `/rightsize share` prints a message you can paste anywhere to tell others about rightsize, with your estimated saving for the last 30 days once there are 20 rated prompts and the saving is 5% or more. It sends nothing and is unrelated to the Share anonymous feedback setting.
- `/rightsize settings` asks the questions again, and sets their rows in `/config` from your answers.
- `/rightsize reset` asks what to reset (Settings, Cost measurement, Both or Cancel) and confirms, since it can't be undone. Settings puts every `/config` row back to its default and forgets the saved answers (a reset row counts as a default, not yours, until you set it again). Cost measurement clears the calibration and the close-call, spot-check and start-suggestion counts, and makes the run log before that moment teach nothing (the log and the report history stay). `/rightsize reset <setting>` resets one, named by key (`handOff`) or title (`hand-off threshold`).
- `/rightsize undo` puts the last auto-lowered prompt back in the box to run at the normal level.
- `/rightsize clear` drops a session-wide switch.
- `/mods` turns the mod on or off.
- Changing settings: in a terminal session, `/config` applies a change at once. The desktop app has no `/config` menu: change settings from a terminal (`/config` inside `claude`, or `echo '{"handOff":"60%"}' | claude plugin configure rightsize@archid21 --values-stdin`), then quit the app (⌘Q) and reopen it.
- `/config`, then rightsize. Every row is a picker, and in a terminal session each applies as soon as you change it:
  - **Lowest effort** (low, medium or high) sets how far it will lower. **Highest effort** (high, xhigh or max) sets how far it will raise: never above it, not mid-turn either, and not for a subagent's level.
  - **Lowering**, **Raising**, **Stronger model** and **Cheaper model** hold your answers to the four questions (the default is not set: ask the first time). A rule set here is used as it is and its question is never asked. **Remember choices** (ask, every session or this session) decides whether answers to the questions are kept.
  - **Reports** (api or subscription) sets whether reports show dollars or a share of usage. On a subscription, dollar amounts are marked API-equivalent: what the same tokens would cost at API prices. The mod reads this off each response's rate limits (a subscription shows five-hour and seven-day windows) and asks once only when they show nothing. A value you set here is final: the rate limits never change it, and `/rightsize` says when they disagree.
  - **Hand-off threshold** (50% to 90%, default 70%) and **Lowering threshold** (70% to 95%, default 90%): how much cheaper a subagent or a lower effort level must be before the mod uses it. Lower is stricter.
  - **Use Haiku** and **Use Fable** (on or off): off means no work is handed to that model, and Claude's subagents are not moved to it. Haiku still rates the prompts.
  - **Claude's subagents** (cheaper when it fits or off): whether a general-purpose subagent Claude starts without naming a model runs on the cheapest weaker model that fits, at that model's level.
  - **Workflows** (ask, pause rightsize, follow my rules or right-size every agent): what the mod does once Claude starts a workflow, which can start 10 or more agents at once. The mod asks once, before the first workflow starts, and saves your answer here. Pause: no hand-offs for the rest of the session. Follow my rules: hand-offs go on by your rules. Right-size every agent: also rates each workflow agent that names no model and may run it on a cheaper model (never when Claude's subagents is off). Measurement stays paused after a workflow whatever you pick.
  - **Explore close calls** (on or off): whether one close call in five takes the other model, so both get measured.
  - **Pause after misses** (off, 20% to 50%, default 30%): the miss rate at which hand-downs of a kind of work to a model, and lowering effort on it, stop.
  - **Budget pacing** (on or off): on a subscription, move the thresholds by how fast the 5-hour and 7-day windows are being used. Running out early, it hands off and lowers more readily; with much left near a reset, it puts quality first; over 90% used, it saves all it can and skips raises and stronger models while their rules have no answer. It moves only thresholds you left at their default.
  - **Raise when stuck** (on or off): raise effort one level for the rest of a turn when Claude looks stuck, following your Raising rule. **Stuck sensitivity** (relaxed, normal or sensitive) sets how soon: normal is a tool call failing twice, 3 failing, one call running 3 times, or 3x the rated steps (at least 15).
  - **Rate prompts from** (3, 6, 10 or 20 words): shorter prompts are sent without a rating.
  - **Rater check** (every 25, every 50, every 100 or off): on every that many rated prompts, ask Sonnet in the background for a second opinion on Haiku's rating, to measure how often Haiku is wrong. Off: no checks.
  - **Start suggestions** (weekly, monthly or off): suggest a different starting model and level in the band when your log shows one is clearly better. Off: `/rightsize report` still shows the comparison.
  - **Idle warning** (over $0.10, over $0.50, over $1 or off): ask before a prompt sent after the cache expired writes the whole conversation again, when that costs over this much (in API-equivalent dollars on a subscription). A subscriber sees the cost as a share of their 5-hour window once runs show the rate.
  - **Band** (when it acts, always or off): when the band above the prompt shows. "when it acts", the default, shows it only when the mod changes something.
  - **Share anonymous feedback** (off or on): send anonymous numbers to the rightsize author, at most once an hour, from when you turn it on: task types, models, effort levels, token guesses, costs, what went wrong, Sonnet checks and your 👍/👎, with a random install ID. Never prompts, code, file names, paths, tool or server names, or session IDs. The mod asks once, after 20 rated prompts. Nothing is sent while `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set. Each event carries the time it happened. Data goes to `feedback.aivalue.blog`, whose host keeps request IP addresses in its logs for a limited time (not saved with the numbers); to ask about it or have it deleted, email rightsize@aivalue.blog with your install ID.
  - **Price check** (monthly or off): whether `prices.json` is compared with Anthropic's pricing page every 30 days. `/rightsize prices` checks right away.
- `prices.json` holds the price table, in dollars per 1M tokens.
  - Every 30 days, at session start, the mod reads Anthropic's pricing page and writes in any changed price. It keeps the old file as `prices.json.bak` and adds a line to the transcript naming each change.
  - If the fetch fails, or the page no longer shows all four models, nothing changes and the check runs again at the next session start.
  - To check sooner, run `/rightsize prices`.

## Turn it off or remove it

- `/mods` pauses it; `/config` turns off single features.
- `claude plugin disable rightsize@archid21` stops it loading and keeps its settings and learning; `claude plugin enable rightsize@archid21` brings it back.
- `claude plugin uninstall rightsize@archid21` removes it and the settings saved in `/config`. Its stored data and logs stay on disk: `rm ~/.claude/plugins/store/rightsize_*.json ~/.claude/mods-logs/rightsize*` deletes them. If sharing was on, copy your install ID from `/rightsize` first and email rightsize@aivalue.blog to have shared data deleted.

## What it touches

rightsize is a mod: it runs inside Claude Code and hooks some of its events. This is everything it does outside the chat.

- **Hooks.**
  - `prompt.submit`: rates the prompt with Haiku, may change the effort level, and adds the hidden hand-off note. Your text is not changed.
  - `turn.step`: watches each step to see when Claude is stuck and raises effort under your Raising rule.
  - `agent.spawn`: may move a general-purpose subagent that names no model to a cheaper model (see **Claude's subagents**).
  - `tool.call`: asks before the first workflow starts, and denies steps only you can approve (push, publish, release, deploy, send) inside a hand-off subagent. It never approves a call and never changes a permission decision anywhere else.
  - `config.set`: watches its own `rightsize.*` rows in `/config`, to know which values you set. The write goes through as you made it.
  - `command.run` (`/rightsize`), `session.start`, `turn.complete` and `ui.render` (the band above the prompt) are for its own command, start-up, measuring and display.
- **Settings it writes.** Only its own `rightsize.*` rows in `/config`, when you answer one of its questions or run `/rightsize reset`. It never writes the permission mode or any other setting, and it sets no environment variables.
- **Programs it runs.** Only `mkdir` and `chmod`, with fixed arguments, to create `~/.claude/mods-logs` and make its log files readable by you alone (folder 700, files 600). It downloads and runs nothing.
- **Files it writes.** The logs listed under [Logs](#logs), its own store in Claude Code's plugin store, and `prices.json` (keeping `prices.json.bak`) in its own folder. Nothing in your project.
- **What it reads.** Your prompt, the session's usage and rate limits, your `model` and `effortLevel` settings, its own `/config` rows, and two environment variables (`HOME` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`), to rate and price each turn. It reads no credentials: model calls go through Claude Code with your existing sign-in.
- **Network.** It contacts two places, plus the Haiku and Sonnet calls Claude Code makes for it:
  - `platform.claude.com`, Anthropic's pricing page, every 30 days (**Price check**, can be turned off).
  - `feedback.aivalue.blog`, only when **Share anonymous feedback** is on (off by default). What it sends is listed under that setting. No prompt, code, path or conversation text is ever sent.

## Limits

- The app's effort picker does not move. The status line shows the level in use.
- Subagents keep their own model and effort unless the mod hands them work, or Claude started them as general-purpose without naming a model. Those the mod may move to a cheaper model.
- The rating is an estimate from Haiku. Calibration corrects the cost guesses, but it can't correct a wrong choice of model. The mod measures how often the rating was wrong and stops trusting it where it keeps missing, but only once enough outcomes are in.

## Logs

- Decisions: `~/.claude/mods-logs/rightsize.log`
- One JSON line per rated turn, with its session, an `id`, change, costs, rating-call cost and rate-limit windows: `~/.claude/mods-logs/rightsize-runs.jsonl`. It also holds a `check` line for each Sonnet spot-check and a `feedback` line for each 👍 or 👎.
