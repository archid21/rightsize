# rightsize

By [Archi Dubey](https://github.com/archid21), MIT license. Full guide: https://github.com/archid21/rightsize. Feedback: rightsize@aivalue.blog

Before a prompt is sent, rightsize asks a rater (Sonnet at low effort by default, or Haiku: see **Rater**) which effort each model would need for it, or whether a model would struggle, and how big the work is. A cost model then prices each model at its own level, counting the work that model does at that level, and picks the cheapest route that fits, which can change the model and the effort together. The mod follows the answers you give the first time each case comes up in a session. Your setting wins: a value you set in `/config`, or answered when asked, is never changed or bypassed by the mod's own behaviour. A profile (**Profile**, the first row in `/config`) supplies the defaults of a few rows; a row you set beats it.

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
- **Q3 Stronger model**, when a stronger model than the current one fits better: Use the stronger model automatically · Ask before using it · Stay on the current model, raise effort only · Ask me each time.
- **Q4 Cheaper model**, when a task could run on a cheaper model: Send it to a cheaper subagent · Ask before sending it · Stay on the current model, lower effort only · Ask me each time.

Every profile asks all four, once each; the profile only changes which answer is listed first and marked (Recommended) (see **Profiles**).

After the first answer, it asks "Use these choices in every session?". Each question is also a row in `/config` (**Lowering**, **Raising**, **Stronger model**, **Cheaper model**), and **Remember choices** answers the follow-up ahead of time. A rule set in a row is used as it is, and its question is never asked.

## How it decides

- **Your setting wins.** Automatic adjustments, and the values your profile supplies, act only on settings left at their default. Budget pacing moves a threshold only when you did not set it; a window nearly used up skips a raise or a stronger model only while its rule has no answer; rate limits never change **Reports** once you set it; "Ask" always asks. `/rightsize` shows your profile on its first line and lists the settings you changed; the rest are defaults, shown in `/config`.
- **Effort changes can cost a cache rewrite.** Anthropic's docs say that changing effort mid-conversation invalidates the conversation's prompt cache, unless the engine uses the per-message-effort beta. The mod counts that cost, but measured switches have almost all kept the cache, so before it has your own measurements it assumes only a small share miss. Lowering effort for one small prompt still isn't worth a switch there and back, so the mod leaves it alone; for work long enough to save more than that, it lowers. It keeps measuring whether switches really miss the cache and replaces its guess with what it sees.
- **Auto-lowered turns step back up** to the normal level after 5 steps, or after a tool error.
- **A subagent is used only when the model changes.** The main chat keeps its model and cache. A hidden note beside your prompt asks the main chat to:
  1. write a brief with a "Done means" list
  2. check the subagent's result against that list
  3. send rework notes, at most the task's chances (2 under Balanced; see **Profiles**)
  4. report how it went

  On the way down, if the cheaper model still fails once the chances are used, the main chat finishes the task itself.

  Steps only you can approve (push, publish, release, deploy, send) stay in the main chat: the subagent prepares the work and stops, since it can't see your approval, and rightsize blocks those steps if it tries them. A request that is mainly such a step isn't handed off.
- **Reviews run on Opus at high effort or more.** Below that, a review misses the subtle bugs it is for, and a rating can't tell that from the prompt. A review needs the whole conversation, so it isn't handed to a subagent: from Haiku or Sonnet, the main chat switches to Opus for that one turn and then goes back to your model (Opus writes the conversation to its cache once, which the estimate counts). On Opus, effort is raised to high and not lowered; from Fable, a review is never handed below Opus. **Stronger model** still decides whether the switch happens, is asked about or is skipped. A switched review doesn't count toward a starting-model suggestion.
- **A follow-up keeps its task's type.** The rating also says whether a prompt carries on the task in Claude's last reply or starts a new goal. A prompt that carries on is planned as its task's type, so a one-line follow-up in a feature task is not typed as a review and sent to Opus; a prompt in a review task still gets the review rule.
- **It plans from the session you are in.** The model in use and the conversation's size are read from Claude Code on every prompt, the first of a session included (started with `--model`, switched with `/model`, or resumed). A conversation of unknown size is planned at 20K tokens. If no source names a known model, it plans as Opus and logs that the model was unknown.
- **Every prompt is rated as you enter it.** Short ones too: a one-word follow-up is rated in its task. The rater is also told how the task in progress began (the first 600 characters of the prompt that started it, its type and how many prompts it has had), so a short "yes, go ahead" is read for what it carries on. A request over 6,000 characters is shown to the rater as its first 4,000 and last 2,000 characters with a marked cut between, so a constraint at the end is not lost.
- **Missing context is no reason to downgrade.** When the request was cut, or a task is in progress and Claude's last reply could not be read, the rater may see less than there is. Then a lowering of effort or a hand-off to a cheaper model is not made, and the prompt runs as it is; raising effort and using a stronger model are not affected. The session's `rightsize.log` says so, and the run's line in its `runs.jsonl` carries `unsure`.
- **A prompt that can't be rated is left alone.** A Sonnet rating that times out, is refused or can't be read is tried once on Haiku. If that fails too, the prompt runs unchanged on your model and level, and `/rightsize report` counts it under Not counted as savings.
- **Handing work down needs a clear saving.** A subagent is used only when the estimate is under the hand-off threshold (70% under Balanced; the profile sets it) of the cost of staying at the level the work needs, counting the brief, the report and the check. The main chat's part is priced from measured hand-offs: it reads the conversation several times, so a short task never clears the bar and a long, mechanical one can. The subagent runs at the level its model needs: rightsize sets it. Lowering effort needs the lower level to cost under 90% of staying. Under Quality a hand-down or a lowering also needs at least 10 logged tasks of that kind on that route with under 10% misses. Both thresholds can be changed in `/config`, and a hand-off threshold you set beats your profile's. **Highest effort** caps how high the mod raises effort, including the level a subagent runs at, and **Use Haiku** and **Use Fable** turn off the work sent to either model.
- **Close calls go to the model suited to the task.** When two cheaper models that fit are close in estimated cost, the mod picks by task type:
  - Haiku for lookups, searches, bulk edits, extraction and summaries.
  - Sonnet for writing, features, debugging, refactors and other work.
  - Opus for design and reviews.

  "Close" starts at 25% and shrinks to nothing by 20 measured runs. By default a close call always takes the task-type pick, in every profile; **Explore close calls** turns exploring on, and then one close call in five takes the other model, so both get measured. It never overrides the hand-off threshold.
- **The rating is scored against what happens.** Per task type and model, a hand-off that needed rework, a lowered turn that stepped back up or was raised mid-turn, an unchanged turn raised mid-turn, a 👎, and a Sonnet check that disagreed each count as a miss; a hand-off without rework, a lowered turn that held, a 👍 and an agreeing check count as hits. A type needs 5 outcomes on a model before its own rate counts, else the model's rate across types does (also from 5). Haiku on reviews and on writing starts treated as already at the pause line, as pseudo-outcomes that fill those 5; each real outcome pushes one out. Over the last 30 days, a rate at or over the **Pause after misses** line (your profile's: 10% under Quality, 20% under Balanced, 30% under Economy, unless you set the row) stops hand-downs to that model for that kind of work, and lowering effort on it. The starting-point comparison weighs the same rate. All of it is read from the run log on your machine.
- **Sonnet spot-checks Haiku.** Sonnet is the default rater and is not checked against itself. On every 20th prompt that Haiku rated under Balanced (**Rater** is haiku, or Sonnet failed; every 10th under Quality, every 30th under Economy, or the number **Rater check** sets) the mod sends the same prompt to Sonnet at low effort in the background, never delaying the prompt, and logs a `check` line with its cost. Where Haiku said a model fits and Sonnet says it would struggle, that is a miss. **Rater check** in `/config` turns it off.
- **Calibration.** After each rated turn, the mod reads the real cost from Claude Code's cost ledger (the `/cost` total), leaving out the rating call, and moves its estimates toward it. Where there is no ledger, it prices the API's token counts from `prices.json`. Each task type and route is tracked separately, and after 20 runs the measured average replaces the guess. A lowered turn that stepped back up is left out, and sessions running at the same time add to one shared record rather than overwriting each other. When the work-per-model estimates came in, calibration started over once: earlier learning is ignored, not deleted.

A one-row band above the prompt (CLI and desktop app) shows what the mod did, with buttons: Undo or Clear, a quicker rule for this case (Q1–Q4), ⋯ to choose when the band shows, and × to close it. After a hand-off it shows the result, for example: `Sent to Haiku: $0.04 vs about $0.31 staying on Fable (estimated), saved about 87%.` With the band off, that result is a line in the transcript. A hand-off's result and a lowering also show 👍 and 👎: pressing one logs a `feedback` line, removes the buttons, and tunes the mod's choices on this machine. Nothing is sent anywhere.

## Choosing a starting model

Start on Sonnet 5.5 at medium. It handles lookups, searches, edits, features, debugging and writing well, for much less than Opus. rightsize moves what Sonnet is weaker at to Opus: a review runs that one turn on Opus at high effort or more, then the chat goes back to Sonnet; a prompt the rating says Sonnet would struggle with goes to an Opus subagent. Start on Opus 5.5 at medium only if most of your work is design or review. Avoid Opus at low (frequent raises re-write the cache) and Fable (the biggest saving percent, but the highest total).

Once a week (or a month) at session start, the mod estimates what the last 30 days of rated prompts would have cost from Sonnet and Opus at medium and high, its own changes counted and Haiku's miss rate on the start's model weighed in. The band suggests a switch when another start is at least 15% cheaper (25% while it has few measured runs) and sends no more than 1 prompt in 10 to a stronger model, or when over 15% of prompts needed a stronger model or a mid-turn raise. It needs 50 rated prompts in 30 days and 20 on the current start. **Not now** quiets it for 14 days; **Stop suggesting** turns it off. The estimate follows your Use Haiku, Use Fable and Highest effort settings. It never changes the model itself: switch with `/model`.

## Profiles

**Profile** is the first row in `/config`. It sets how much evidence the mod needs before it picks a cheaper route. Quality picks a cheaper route only with strong evidence and raises effort and models readily. Balanced is the default. Economy picks a cheaper route on fit alone and gives a struggling helper more retries.

| | Quality | Balanced | Economy |
|---|---|---|---|
| Evidence for a cheaper route (a hand-down to a cheaper model, a Claude subagent moved down, lowering effort) | The rating says it fits, and at least 10 logged tasks of that kind on that route with a miss rate under 10% | The rating says it fits, and the kind of work pauses at a 20% miss rate | The rating says it fits, and the kind of work pauses at a 30% miss rate |
| Hand-off threshold: a cheaper route must cost under this share of staying | 50% | 70% | 85% |
| Rater check: Sonnet checks every Nth Haiku rating | every 10 | every 20 | every 30 |
| Chances per task for a struggling helper | 1 | 2 | 3 |
| Answer listed first, marked (Recommended), in each of the four questions | Lowering: ask me. Raising: raise automatically. Stronger model: send automatically. Cheaper model: ask first | Lowering: lower automatically. Raising: raise automatically. Stronger model: send automatically. Cheaper model: send automatically | Lowering: lower automatically. Raising: raise automatically. Stronger model: stay, raise effort only. Cheaper model: send automatically |

**Every profile starts from rightsize's research.** Before your own log says anything, each kind of work on Haiku and Sonnet starts from a miss rate measured in rightsize's own testing, and that counts as 10 tasks. So Quality can use a cheaper route from the first day where the research found it reliable (lookups, searches, routine edits, features, refactors and debugging), and holds back where it did not (reviews on Haiku or Sonnet, writing on Haiku). Each task you run takes the place of one of those 10; after 10, only your own log counts. The first miss rightsize detects on a route is forgiven once: the band says so, and the next miss counts. A 👎 from you always counts. Work the research did not cover waits for your own tasks. A task counts once, however many outcomes it has.

Your own setting always wins. A row you set under Advanced replaces what the profile supplies for it: **Hand-off threshold**, **Pause after misses** (it replaces the whole evidence rule, so Quality's 10 logged tasks go too) and **Rater check**. A row you did not set takes the profile's value. The chances and the first answer of each question have no row of their own, so they always follow the profile. Every profile still asks the four questions, once each, and a rule set in a row is used without asking. Exploring close calls is off in every profile; **Explore close calls** turns it on. Switching the profile in `/config` applies at once, and `/rightsize` shows it on its first line.

## Commands and settings

- `/rightsize` shows your profile on its first line, the settings you changed (the rest are defaults, shown in `/config`), what your profile and your settings add up to, the session switch and the measured runs.
- `/rightsize help` lists every command and what it does. An unknown command shows the same list.
- `/rightsize report` shows what the mod did, as plain text in the terminal and as Markdown in the desktop app (its tables in code blocks, so the columns line up). It opens with one sentence for the last 30 days (on a subscription: the share of your 5-hour window kept; on the API: the dollars saved), then a table of this session, the last 7 days and the last 30 days: savings first (Total saved after the cost of its rating calls, the window share saved on a subscription, the share of cost saved, and the extra spent on harder prompts), then prompts rated and what was kept, lowered, raised or sent to another model. On a subscription, the footer says dollar amounts are what the same use would cost on the API, and that you only pay for your subscription. Below that are sections for the last 30 days: Starting point (a comparison of starting models), Fixed context (the tokens sent with every request, a note that it adds to cost in every session and cutting it saves more, the least it cost as a share of what those turns cost, then each part largest first with the biggest MCP servers named), Accuracy (how often Haiku's judgement was wrong, how the Sonnet spot-checks went, hand-downs paused for misses, how far estimates were off), Not counted as savings (turns with no saving counted, and why) and Next steps (what to do about them, left out when there is nothing). Savings are estimates: the baseline, the mod's estimate (made when it chose the route, never changed afterward) of what staying at your own model and effort would have cost, minus what the task cost. A task that cost more than its baseline shows as a negative saving. Prompts that could not be rated are counted under Not counted as savings.
- `/rightsize share` prints a message you can paste anywhere to tell others about rightsize, with your estimated saving for the last 30 days once there are 20 rated prompts and the saving is 5% or more. It sends nothing and is unrelated to the Share anonymous feedback setting.
- `/rightsize settings` asks the questions again, and sets their rows in `/config` from your answers.
- `/rightsize reset` asks what to reset (Settings, Cost measurement, Both or Cancel) and confirms, since it can't be undone. Settings puts every `/config` row back to its default and forgets the saved answers (a reset row counts as a default, not yours, until you set it again). Cost measurement clears the calibration and the close-call, spot-check and start-suggestion counts, and makes the run log before that moment teach nothing (the log and the report history stay). `/rightsize reset <setting>` resets one, named by key (`handOff`) or title (`hand-off threshold`).
- `/rightsize undo` puts the last auto-lowered prompt back in the box to run at the normal level.
- `/rightsize clear` drops a session-wide switch.
- `/mods` turns the mod on or off.
- Changing settings: in a terminal session, `/config` applies a change at once. The desktop app has no `/config` menu: change settings from a terminal (`/config` inside `claude`, or `echo '{"handOff":"60%"}' | claude plugin configure rightsize@archid21 --values-stdin`), then quit the app (⌘Q) and reopen it.
- `/config`, then rightsize. Every row is a picker, and in a terminal session each applies as soon as you change it. The list starts with **Profile**; every other row is Advanced, and its title in `/config` starts with "Advanced · ":
  - **Profile** (Quality, Balanced or Economy, default Balanced): how much evidence rightsize needs before it picks a cheaper route. See **Profiles**.
  - **Lowest effort** (low, medium or high) sets how far it will lower. **Highest effort** (high, xhigh or max) sets how far it will raise: never above it, not mid-turn either, and not for a subagent's level. A model that needs a higher level than it allows gets no route (a review still runs on Opus, at this level at most).
  - **Lowering**, **Raising**, **Stronger model** and **Cheaper model** hold your answers to the four questions (the default is not set: ask the first time). A rule set here is used as it is and its question is never asked. **Remember choices** (ask, every session or this session) decides whether answers to the questions are kept.
  - **Reports** (api or subscription) sets whether reports show dollars or a share of usage. On a subscription, dollar amounts are marked API-equivalent: what the same tokens would cost at API prices. The mod reads this off each response's rate limits (a subscription shows five-hour and seven-day windows) and asks once only when they show nothing. A value you set here is final: the rate limits never change it, and `/rightsize` says when they disagree.
  - **Hand-off threshold** (50% to 90%; left alone, your profile sets it: 50%, 70% or 85%) and **Lowering threshold** (70% to 95%, default 90%): how much cheaper a subagent or a lower effort level must be before the mod uses it. Lower is stricter.
  - **Use Haiku** and **Use Fable** (on or off): off means no work is handed to that model, and Claude's subagents are not moved to it. Haiku can still rate the prompts (see **Rater**).
  - **Claude's subagents** (cheaper when it fits or off): whether a general-purpose subagent Claude starts without naming a model runs on the cheapest weaker model that fits, at that model's level.
  - **Workflows** (ask, pause rightsize, follow my rules or right-size every agent): what the mod does once Claude starts a workflow, which can start 10 or more agents at once. The mod asks once, before the first workflow starts, and saves your answer here. Pause: no hand-offs for the rest of the session. Follow my rules: hand-offs go on by your rules. Right-size every agent: also rates each workflow agent that names no model and may run it on a cheaper model (never when Claude's subagents is off). Measurement stays paused after a workflow whatever you pick.
  - **Explore close calls** (on or off, default off): whether one close call in five takes the other model, so both get measured.
  - **Pause after misses** (off, 20% to 50%; left alone, your profile sets it: 10%, 20% or 30%): the miss rate at which hand-downs of a kind of work to a model, and lowering effort on it, stop. A value you set replaces the profile's whole evidence rule. Claude's own subagents are not moved to a paused model for that kind of work either.
  - **Budget pacing** (on or off): on a subscription, move the thresholds by how fast the 5-hour and 7-day windows are being used. Running out early, it hands off and lowers more readily; with much left near a reset, it puts quality first; over 90% used, it saves all it can and skips raises and stronger models while their rules have no answer. It moves only thresholds you left at their default.
  - **Raise when stuck** (on or off): raise effort one level for the rest of a turn when Claude looks stuck, following your Raising rule. **Stuck sensitivity** (relaxed, normal or sensitive) sets how soon: normal is a tool call failing twice, 3 failing, one call running 3 times, or 3x the rated steps (at least 15). Errors from the environment (a denied permission or sandbox, no network, no login, a missing program) don't count: more effort would not fix them. On a Sonnet session a rating alone does not raise effort for debugging; effort goes up there when the turn shows it is stuck.
  - **Rater** (sonnet or haiku): the model that rates each prompt, at low effort. Sonnet (default) reads prompts more reliably and costs more per rating; haiku is cheaper. A Sonnet rating that fails is tried once on Haiku.
  - **Rater check** (every 25, every 50, every 100 or off; left alone, your profile sets it: every 10, 20 or 30): on every that many prompts rated by Haiku, ask Sonnet in the background for a second opinion, to measure how often Haiku is wrong. Prompts Sonnet rated are not checked. Off: no checks.
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
- `claude plugin uninstall rightsize@archid21` removes it and the settings saved in `/config`. Its stored data and logs stay on disk: `rm -r ~/.claude/plugins/store/rightsize_*.json ~/.claude/mods-logs/rightsize*` deletes them. If sharing was on, copy your install ID from `/rightsize` first and email rightsize@aivalue.blog to have shared data deleted.

## What it touches

rightsize is a mod: it runs inside Claude Code and hooks some of its events. This is everything it does outside the chat.

- **Hooks.**
  - `prompt.submit`: rates the prompt (Sonnet by default), may change the effort level, and adds the hidden hand-off note. Your text is not changed.
  - `turn.start`: matches a turn that is starting to the prompt it was rated for (by its text), so a prompt typed while another turn runs is measured in its own turn. It changes nothing.
  - `turn.step`: watches each step to see when Claude is stuck and raises effort under your Raising rule.
  - `agent.spawn`: may move a general-purpose subagent that names no model to a cheaper model (see **Claude's subagents**).
  - `tool.call`: asks before the first workflow starts, and denies steps only you can approve (push, publish, release, deploy, send) inside a hand-off subagent. It never approves a call and never changes a permission decision anywhere else.
  - `config.set`: watches its own `rightsize.*` rows in `/config`, to know which values you set. The write goes through as you made it.
  - `command.run` (`/rightsize`), `session.start`, `turn.complete` and `ui.render` (the band above the prompt) are for its own command, start-up, measuring and display.
- **Settings it writes.** Only its own `rightsize.*` rows in `/config`, when you answer one of its questions or run `/rightsize reset`. It never writes the permission mode or any other setting, and it sets no environment variables.
- **Programs it runs.** Only `mkdir` and `chmod`, with fixed arguments, to create its log folders under `~/.claude/mods-logs` and make them readable by you alone (folders 700, files 600), and `rm -f` and `rmdir` on a session's folder inside `~/.claude/mods-logs/rightsize/` once nothing in it has changed for 45 days (never the current session's). It downloads and runs nothing.
- **Files it writes.** The logs listed under [Logs](#logs), its own store in Claude Code's plugin store, and `prices.json` (keeping `prices.json.bak`) in its own folder. Nothing in your project.
- **What it reads.** Your prompt, the session's usage and rate limits, your `model` and `effortLevel` settings, its own `/config` rows, and two environment variables (`HOME` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`), to rate and price each turn. It reads no credentials: model calls go through Claude Code with your existing sign-in.
- **Network.** It contacts two places, plus the Sonnet and Haiku calls Claude Code makes for it:
  - `platform.claude.com`, Anthropic's pricing page, every 30 days (**Price check**, can be turned off).
  - `feedback.aivalue.blog`, only when **Share anonymous feedback** is on (off by default). What it sends is listed under that setting. No prompt, code, path or conversation text is ever sent.

## Limits

- The app's effort picker does not move. The status line shows the level in use.
- Subagents keep their own model and effort unless the mod hands them work, or Claude started them as general-purpose without naming a model. Those the mod may move to a cheaper model.
- The rating is an estimate from a model. Calibration corrects the cost guesses, but it can't correct a wrong choice of model. The mod measures how often the rating was wrong and stops trusting it where it keeps missing, but only once enough outcomes are in.

## Logs

Each session writes its own folder, `~/.claude/mods-logs/rightsize/<session ID>/`, and no other session writes to it. `/rightsize report`, the start suggestion and the miss rates read every session's folder together. A folder whose files have all gone unchanged for 45 days is removed when a session starts. Logs from older versions in `~/.claude/mods-logs/rightsize-runs.jsonl` and `rightsize-switches.jsonl` are still read, and no longer written. In each session's folder:

- Decisions: `rightsize.log`
- One JSON line per rated turn, with its session, an `id`, its turn (`turnId`, and `queued` when the prompt was typed while another turn was running), change, costs, rating-call cost and rate-limit windows: `runs.jsonl`. It also holds a `check` line for each Sonnet spot-check and a `feedback` line for each 👍 or 👎. A prompt that was rated but never ran gets a line with its rating cost and a `reason`: `dropped` when something else in Claude Code refused it, `unbound` when it was delivered into a turn already running or cancelled before its turn started. The report counts that cost as overhead and nothing else.
- Each measured effort switch, and whether the cache was kept: `switches.jsonl`
