# rightsize

By [Archi Dubey](https://github.com/archid21), MIT license. Full guide: https://github.com/archid21/rightsize. Feedback: rightsize@aivalue.blog

Before a prompt is sent, rightsize asks a rater (Sonnet at low effort by default, or Haiku: see **Rater**) which effort each model would need for it, or whether a model would struggle, and how big the work is. A cost model then prices each model at its own level, counting the work that model does at that level, and picks the cheapest route that fits, which can change the model and the effort together. Savings are estimates against a baseline: rightsize's own estimate of staying on your model and effort, made when it chose the route and never changed afterward.

Your setting wins: a value you set in `/config`, or set from the band, is never changed or bypassed by the mod's own behavior. A profile (**Profile**, the first row in `/config`) supplies the defaults of a few rows, and decides each of the four cases while its rule row is not set; a row you set beats it. **Mode** (the second row) can be set to watch only, which rates and plans every prompt and applies nothing.

## Install

Needs Claude Code 2.1.287 or newer (2.1.286 in the desktop app). rightsize states this requirement and does not check it. In a terminal:

```
claude plugin marketplace add archid21/rightsize
claude plugin install rightsize@archid21 --scope user
```

Or inside a session: `/plugin install rightsize --marketplace archid21/rightsize`. Then start a new session and type `/rightsize`. If the settings pane opens, it works. Or paste this into any Claude Code session: "Install the rightsize plugin from GitHub. Run `claude plugin marketplace add archid21/rightsize`, then `claude plugin install rightsize@archid21 --scope user`, and tell me if either fails."

## The four cases

There are four cases, and each has a rule row in `/config`:

- **Lowering**, when a prompt needs less effort: ask me · lower automatically · never lower.
- **Raising**, when it needs more effort on the same model: ask me · raise automatically · never raise.
- **Stronger model**, when a stronger model than yours fits better, or a review runs on Opus for one turn: ask first · always send · stay, raise effort only · ask each time.
- **Cheaper model**, when a task could run on a cheaper model: ask first · always send · stay, lower effort only · ask each time.

**A row left at not set means your profile decides, and nothing asks.** The band says so the first time each case comes up in a session, for example `Your Balanced profile decided (Cheaper model); ⋯ changes it.` The other rules for that case are in the band's ⋯ menu; picking one sets the row. What each profile does while the rows are not set:

| | Quality | Balanced | Economy |
|---|---|---|---|
| Lowering | ask me | lower automatically | lower automatically |
| Raising | raise automatically | raise automatically | raise automatically |
| Stronger model | always send | always send | stay, raise effort only |
| Cheaper model | ask first | always send | always send |

**An "ask" rule opens its own dialog** (Quality's Lowering and Cheaper model do, and so does any row you set to an ask value). It is the only kind of question that holds your prompt. It waits **Question wait** (30 seconds, 1 minute or 2 minutes). With no answer, the prompt runs unchanged: no raise, no stronger model, no subagent, nothing saved. `/rightsize settings` still asks the four questions, one after another, for anyone who wants to set rules that way, and sets the rows from the answers.

**The Remember question follows only a rule you set yourself,** from the band's ⋯ menu or `/rightsize settings`. After your first such rule it asks on the band whether to keep your rules in every session. A rule the profile supplied is never asked about.

Every other question is a row on the band, and the work does not wait for it. Remember choices and Reports (asked only when no response shows how you pay) show when the turn ends and stay until your next prompt. Stuck shows during the turn and goes when it ends; the turn goes on at its effort, a Raise applies from its next request, and a stuck helper whose Stuck question gets no answer goes on at its effort too. Workflow is asked at each Workflow call until you answer, with rightsize paused for that workflow. Press a number key or click an option to answer, or × to dismiss. Unanswered, each keeps its safe default: no raise, this session only, API prices, rightsize paused. Where the band cannot show (Band set to off, or the mobile app), these are timed dialogs. rightsize never asks you to share data.

## How it decides

- **Your setting wins.** Automatic adjustments, and the values your profile supplies, act only on settings left at their default. Budget pacing moves a bar only when you did not set it; a window nearly used up skips a raise or a stronger model only while its rule is not set; rate limits never change **Reports** once you set it; an "ask" rule always asks. `/rightsize status` shows your profile on its first line and lists the settings you changed.
- **Watch only.** With **Mode** set to watch only, every prompt is rated and planned and nothing is applied. The band says what would have happened, for example `Watching: would send this to a Sonnet subagent at medium effort. ... Mode in /config turns it on.` `/rightsize report` has a `Watch only:` line: how many prompts would have changed and what that was estimated to save.
- **It plans from the session you are in.** The model in use and the conversation's size are read from Claude Code on every prompt, the first of a session included. A conversation of unknown size is planned at 20K tokens. If no source names a known model, it plans as Opus and logs that the model was unknown.
- **Every prompt is rated as you enter it.** Short ones too: a one-word follow-up is rated in its task. The rater is told how the task began (the first 600 characters of the prompt that started it, its type, how many prompts it has had). A request over 6,000 characters is shown as its first 4,000 and last 2,000 characters with a marked cut. The rater is told that a bulk edit, extraction or summary with a clear rule fits Haiku at medium.
- **Missing context is no reason to downgrade.** When the request was cut, or a task is in progress and Claude's last reply could not be read, no lowering or hand-down is made, and the prompt runs as it is. Raising effort and a stronger model are not affected. The run log carries `unsure`.
- **A prompt that can't be rated is left alone.** A Sonnet rating that times out, is refused or can't be read is tried once on Haiku. If that fails too, the prompt runs unchanged and the report counts it under Not counted as savings. A rating may take at most 12 seconds in all (Sonnet at most 9; Haiku gets what is left, or is skipped under 2 seconds).
- **Effort changes can cost a cache rewrite, or nothing.** Anthropic's docs say effort changes keep the prompt cache on the current models. rightsize logs every switch with whether the cache survived. Until it has measured switches of your own it assumes a small share miss. Once 20 or more measured switches have missed at most 5% of the time, a switch is priced as free, so lowering can happen on big conversations too. Auto-lowered turns step back up to your normal level after 5 steps, or after a tool error.
- **Changing the model means a helper, except for a review switch.** The main chat keeps its model and cache. A hidden note beside your prompt asks it to: (1) write a brief with a "Done means" list, (2) check the helper's result against it, (3) send rework notes, at most the task's chances (1 under Quality, 2 under Balanced, 3 under Economy), (4) report how it went. If the helper still fails after its chances, the main chat finishes the work.
- **Steps only you can approve stay in the main chat.** A helper must not push, publish, release, deploy or merge from the shell, or call an MCP tool whose name starts with send, publish, deploy, merge or post, because another agent's message is not your approval. rightsize denies those calls (`tool.call`). It also denies the calls of a helper that was stopped and sent back, and rework past the chances. A request that is mainly such a step isn't handed off.
- **Reviews run on Opus at high effort or more.** A review needs the whole conversation, so from Haiku or Sonnet the main chat switches to Opus for that one turn, then goes back to your model (Opus writes the conversation to its cache once, which the estimate counts). On Opus, effort is raised to high and not lowered. From Fable a review can go to an Opus helper; it is never handed below Opus. **Stronger model** decides whether the switch happens. A switched review runs at **Highest effort** at most under Quality and Balanced, and at high effort at most under Economy. The band shows the cost multiple before the turn. A switched review does not count toward a starting-model suggestion.
- **A follow-up keeps its task's type.** A prompt the rater types as carrying on the task is planned as that task's type, so a one-line follow-up in a feature task is not sent to Opus as a review. In a review task, a follow-up the rater itself types as something else (a lookup, a fix) is planned as what it is, not switched to Opus.
- **Handing work down needs a clear saving.** A helper is used only when its estimate, counting the brief, report, check and likely rework, is under the hand-off threshold (50%, 70% or 85% by profile) of the cost of staying at the level the work needs. Lowering effort needs the lower level under 90% of staying. Under Quality a hand-down or lowering also needs at least 10 logged tasks of that kind on that route with under 10% misses. Balanced and Economy use the rating alone for work the research did not cover; only Quality waits for 10 logged tasks. **Highest effort** caps every raise, including a helper's level; **Use Haiku** and **Use Fable** turn off work sent there.
- **Close calls go to the model suited to the task.** When two models that fit are within a band of each other in cost, rightsize picks by task type: Haiku for lookups, searches, bulk edits, extraction and summaries; Sonnet for writing, features, debugging and refactors; Opus for design and reviews. The band starts at 25% and shrinks to nothing at 20 measured runs. **Explore close calls** makes one close call in five take the other model.
- **The rating is scored against what happens.** Per task type and model, these count as misses: a hand-off that needed rework, a lowered turn that stepped back up or was raised mid-turn, an unchanged turn raised mid-turn, a test run that fails at the end of a turn (main chat or helper) after a lowering or hand-down, a next prompt the rater marks as correcting the reply (the cheaper route before it is the miss), a 👎, and a Sonnet check that disagreed. Hits are the same without the problem, a 👍, and an agreeing check. A type needs 5 outcomes on a model before its own rate counts, else the model's rate across types does. Research priors start some work with a built-in doubt that counts as 10 tasks (Haiku on reviews 0.8, Haiku on writing 0.5, Sonnet on reviews 0.3 as miss rates); each real outcome pushes one out. Over the last 30 days, a rate at or over the **Pause after misses** line (10%, 20% or 30% by profile) stops hand-downs and lowering for that kind of work on that model.
- **Sonnet spot-checks Haiku.** On every 20th prompt rated by Haiku (every 10th under Quality, 30th under Economy, or what **Rater check** sets), Sonnet rates the same prompt in the background. A disagreement that Haiku said a model does the work and Sonnet says it would struggle counts as a miss. It never delays your prompt.
- **It raises effort when Claude gets stuck.** Normal: the same call fails twice, 3 calls fail, the same call runs 3 times, or the turn passes 3x the rated steps (at least 15). It raises one level for the rest of the turn, at most twice, never to max and never above **Highest effort**, following your Raising rule. Errors from the environment (a denied permission or sandbox, no network, no login, a missing program) and calls you refused don't count.
- **Keep warm is decided by your profile while the row is not set.** When a turn ends in a session under 200K tokens where a cold return would cost $0.50 or more (about 65K tokens on Opus, 130K on Sonnet; API-equivalent dollars on a subscription too), rightsize acts on **Before the cache goes cold**. Quality keeps warm for 8 hours. Balanced keeps warm until your usual start time (the median time of your first prompt over 14 days, at most 8 hours; 9:00 until 5 days of data). Economy lets it go cold. Just before each expiry rightsize sends one small request (`Reply with the single word OK.`), which refreshes the cache. The band shows a status row, `Keeping warm until 9:00 · ~0.3% so far`, with **Stop keeping warm**, and `Don't keep warm again` in ⋯ (sets the row to off). It stops when you send a prompt, press Stop, a request fails, the end time comes, or keeping warm would cost more than coming back cold: that cap is never passed. The `ask` value (an offer on the band 5 minutes after the turn, with a learned button, `Always …?` and `Stop offering?`) is still there for anyone who sets it; no profile uses it. **save a handoff** sends `wrap up` once for Groundwork (compacts without it); **compact** compacts once.
- **Keep warm is credited for what it prevents.** When you send a prompt after the time the cache would have gone cold and its first request read at least about 80% of the conversation from the cache, one `warmSaved` line records what coming back cold would have cost. A run you never come back to is pure cost. The report's Keep warm line shows runs, what they saved, what the requests cost and the net.
- **An idle warning never holds your prompt.** When a prompt is sent after the cache expired (1 hour, or 5 minutes per `prices.json`) in a session under 200K tokens, and rewriting costs over the row's bar (default over $0.50), the band notes it beside what rightsize did: `Idle 2 h: the cache went cold, so this prompt writes the conversation (~120K tokens) again, ~1.2% of your 5-hour window more than warm; /compact first would have cost ~0.3%.`
- **It paces your usage windows.** On a subscription, rightsize divides the share of a window used by the share of time gone, and acts on the window that would stop you first. Over 1.2: the hand-off bar moves from 70% to 85% and lowering from 90% to 97%. Over 90% used: hand-off 95%, lowering whenever it fits, and raises and stronger models skipped while their rules are not set. Under 1.2 nothing changes, and the first 15% of a window is not paced. A bar you set stays as set. When pacing moves a bar the band says which, for example `hand-off bar 70% → 85%`.
- **Claude's own subagents are right-sized too.** A general-purpose subagent started without a model is rated and may run on the cheapest weaker model that fits, under the hand-off threshold. It never moves to a stronger or paused model. **Claude's subagents** turns it off.
- **Workflows are your call.** When Claude starts a workflow (ultracode), rightsize asks at each Workflow call until you answer, with rightsize paused meanwhile, and saves the answer as **Workflows**. After a workflow, calibration learns nothing and no saving is claimed.
- **Long runs and whole tasks.** A run's cost grows more slowly than its steps; rightsize learns by how much from your runs and applies it only once it clearly cuts the estimate error. The report compares each finished task's cost with the sum of its estimates, from 5 finished tasks.
- **Calibration.** After each rated turn, rightsize reads the real cost from Claude Code's cost ledger (the `/cost` total), leaving out the rating call, and moves its estimates toward it, per task type, route, model and level. After 20 runs the measured average replaces the guess. `prices.json` is compared with Anthropic's pricing page every 30 days.

### The band

A band above the prompt (CLI and desktop app) shows one labelled row per topic, at most three: **Prompt**, **Cache** (the keep-warm status or offer) and a question. Buttons: **Retry at original effort** or **Clear**; **Run on <your model>** after a hand-off or a switch (runs that prompt once without rightsize); **⋯** for the rest; **×** to close. Each route says why, and a move to a cheaper model gives rightsize's confidence (`Confidence: low.` until 10 of your own tasks are logged on that route).

The **⋯** menu holds the other rules for the case that just came up (picking one sets the row), the cache choices, **Mark this 👍 (right call)** and **Mark this 👎 (wrong call)**, and when the band shows. A mark is written to the run log on this machine and tunes rightsize's choices there; it is shared only as a number, and only when **Share anonymous feedback** is on. After a hand-off the band shows the result, for example `Sent to Haiku. $0.04 vs ~$0.31 on Fable (~87% saved).` on the API or `Sent to Sonnet. ~28% of Opus usage.` on a subscription. From the session's 3rd rated prompt, every band ends with the session's running total, for example `Session: ~$0.84 saved`.

## Choosing a starting model

Start on Sonnet 5.5 at medium. It handles lookups, searches, edits, features, debugging and writing well, for much less than Opus. rightsize moves what Sonnet is weaker at to Opus: a review runs that one turn on Opus at high effort or more, then the chat goes back to Sonnet; a prompt the rating says Sonnet would struggle with goes to an Opus helper. Start on Opus 5.5 at medium only if most of your work is design or review. Avoid Opus at low (frequent raises re-write the cache) and Fable (the highest total).

**A day-one tip.** On your first session on an Opus start with fewer than 50 rated prompts, the band shows once: `Starting tip: most work runs as well on Sonnet 5.5 at medium for well under half the usage of Opus. Reviews still run on Opus, and work Sonnet would struggle with goes to a stronger helper. Switch with /model sonnet.` The button **Switch: /model sonnet** puts the command in the prompt box and you press Enter; **Not now** closes it. rightsize never changes the model itself.

**A weekly suggestion from your log.** Once a week (or a month: **Start suggestions**) at session start, rightsize estimates what the last 30 days of rated prompts would have cost from Sonnet and Opus at medium and high, its own changes counted and Haiku's miss rate on the start's model weighed in. The band suggests a switch when another start is at least 15% cheaper (25% while it has few measured runs) and sends no more than 1 prompt in 10 to a stronger model, or when over 15% of prompts needed a stronger model or a mid-turn raise. It needs 50 rated prompts in 30 days and 20 on the current start. **Not now** quiets it for 14 days; **Stop suggesting** turns it off. Switch with `/model`.

## Profiles

**Profile** is the first row in `/config`. It sets how much evidence rightsize needs before it picks a cheaper route. Balanced is the default.

| | Quality | Balanced | Economy |
|---|---|---|---|
| Evidence for a cheaper route (hand-down, a Claude subagent moved down, lowering) | The rating says it fits, and at least 10 logged tasks of that kind on that route with under 10% misses | The rating says it fits; the kind of work pauses at 20% misses | The rating says it fits; the kind of work pauses at 30% misses |
| Hand-off threshold: a helper must cost under this share of staying | 50% | 70% | 85% |
| Rater check: Sonnet checks every Nth Haiku rating | every 10 | every 20 | every 30 |
| Chances per task for a struggling helper | 1 | 2 | 3 |
| Keep warm, while **Before the cache goes cold** is not set | 8 hours | until your usual start (at most 8 hours) | let it go cold |
| A review switched to Opus runs at most at | Highest effort | Highest effort | high effort |
| The four cases, while their rows are not set | see The four cases | see The four cases | see The four cases |

**Every profile starts from rightsize's research.** Before your own log says anything, each kind of work on Haiku and Sonnet starts from a built-in miss rate that counts as 10 tasks. Quality can use a cheaper route from the first day where the research found it reliable (lookups, searches, routine edits, features, refactors, debugging) and holds back where it did not (reviews on Haiku or Sonnet, writing on Haiku). Each task you run takes the place of one of the 10; after 10, only your log counts. The first miss on a route is forgiven once: the band says so, and the next counts. A 👎 always counts. Work the research did not cover uses the rating alone under Balanced and Economy; Quality waits for 10 logged tasks.

A row you set under Advanced replaces what the profile supplies for it: **Hand-off threshold**, **Pause after misses** (it replaces the whole evidence rule), **Rater check** and **Before the cache goes cold**. A row you did not set takes the profile's value. The chances, the review cap and the answers of the four cases have no row of their own (the case rules are rows, and a rule you set wins), so they follow the profile. Switching the profile applies at once.

## Commands and settings

- `/rightsize` opens a settings pane that lists every setting in `/config` with its value (Profile first, then Mode, then the Advanced ones). A row you set is marked `(yours)`, one you have not `(default)`. A pick takes effect at once. Where no pane can be drawn, or on the mobile app, it asks instead.
- `/rightsize status` shows your profile on its first line, the settings you changed, what your profile and settings add up to, the session switch, the measured runs and the cache-switch results. When Share is on it shows your install ID.
- `/rightsize help` lists every command. `/rightsize share` prints a message you can paste to tell others about rightsize; it sends nothing.
- `/rightsize report` shows what rightsize did, as plain text in the terminal and as Markdown in the desktop app. Sections, left out when empty: a headline for the last 30 days; a table for this session, 7 days and 30 days (Total saved after rating costs, window shares on a subscription as ranges, share of cost saved, Extra spent on harder prompts, then what was kept, lowered, raised and sent); Watch only (when Mode is watch only: how many prompts would have changed and the estimated saving); Starting point; Fixed context (the tokens every request carries, largest part first); Accuracy (miss rate, spot-checks, paused hand-downs, estimate error); Not counted as savings; Keep warm; Time (per task: Claude's time, time to done, the rating's delay, cheaper routes against staying; reported, never used to choose a route); Whole tasks (from 5 finished tasks); Next steps; and a footer. Savings are estimates against the baseline, can be negative, and on a subscription dollar amounts are API-equivalent: what the same use would cost on the API, not your bill. The footer also shows how Share anonymous feedback is set.
- `/rightsize settings` asks the four questions and sets their rows from your answers. `/rightsize retry` puts the last lowered prompt back in the box at normal effort (file changes are not undone). `/rightsize clear` drops a session switch. `/rightsize prices` checks prices now.
- `/rightsize reset` asks what to reset (Settings, Cost measurement, Both or Cancel) and confirms. `/rightsize reset <setting>` resets one, named by key (`handOff`) or title.
- `/mods` turns the mod on or off.
- Changing settings: in a terminal, `/config` applies a change at once. The desktop app has no `/config` menu: change settings from a terminal (`echo '{"handOff":"60%"}' | claude plugin configure rightsize@archid21 --values-stdin`), then quit the app and reopen it.
- `/config`, then rightsize. Every row is a picker. Every row except Profile and Mode is titled "Advanced · ..." in `/config`; the list gives the name.
  - **Profile** (Quality, Balanced or Economy, default Balanced): how much evidence a cheaper route needs; what the four cases do while their rows are not set. See **Profiles**.
  - **Mode** (act or watch only, default act): watch only rates and plans every prompt, applies nothing, and the band says what it would have done. Use it for a week to see rightsize's calls on your own work.
  - **Lowest effort** (low, medium or high, default low): how far rightsize lowers.
  - **Highest effort** (high, xhigh or max, default max): never raises above it: not for a prompt, not mid-turn, not for a helper. A model whose rated level is above it gets no route (a review still runs on Opus, at this level at most). A level you are already on above it is left alone.
  - **Lowering** (ask me, lower automatically, never lower or not set, default not set): not set means your profile decides.
  - **Raising** (ask me, raise automatically, never raise or not set, default not set): also decides raises mid-turn when Claude looks stuck.
  - **Stronger model** (ask first, always send, stay, raise effort only, ask each time or not set, default not set): includes the review switch.
  - **Cheaper model** (ask first, always send, stay, lower effort only, ask each time or not set, default not set): a hand-off to a cheaper model.
  - **Remember choices** (ask, every session or this session, default ask): whether rules you set from the band or `/rightsize settings` are kept for later sessions. A rule set in its own row is always kept.
  - **Hand-off threshold** (50%, 60%, 70%, 80% or 90%, default 70%): a helper must cost under this share of staying. Left alone, your profile sets it: 50%, 70% or 85%.
  - **Lowering threshold** (70%, 80%, 90% or 95%, default 90%): a lower level must cost under this share of staying, counting the cache it may rewrite.
  - **Use Haiku** (on or off, default on): off means no work goes to Haiku, for a hand-off or a Claude subagent. Haiku still rates prompts.
  - **Use Fable** (on or off, default on): off means no work goes to Fable.
  - **Claude's subagents** (cheaper when it fits or off, default cheaper when it fits): whether a general-purpose subagent started without a model runs on the cheapest weaker model that fits.
  - **Workflows** (ask, pause rightsize, follow my rules or right-size every agent, default ask): what rightsize does once Claude starts a workflow. Whichever you pick, measurement stays paused afterward.
  - **Explore close calls** (on or off, default off): on means one close call in five takes the other model, so both get measured.
  - **Pause after misses** (off, 20%, 30%, 40% or 50%): the miss rate at which a kind of work stops going down to a model. Left alone, your profile sets it (10%, 20% or 30%). A value you set replaces the whole evidence rule.
  - **Budget pacing** (on or off, default on): on a subscription, moves the bars by how fast the 5-hour and 7-day windows are used.
  - **Raise when stuck** (on or off, default on): raises effort one level for the rest of a turn when Claude looks stuck.
  - **Stuck sensitivity** (relaxed, normal or sensitive, default normal): how soon Claude counts as stuck.
  - **Rater** (sonnet or haiku, default sonnet): the model that rates each prompt, at low effort. Sonnet reads more reliably; Haiku costs less.
  - **Rater check** (every 25, every 50, every 100 or off): how often Sonnet re-rates a prompt Haiku rated. Left alone, your profile sets it (every 10, 20 or 30).
  - **Start suggestions** (weekly, monthly or off, default weekly): the log-based suggestion of another starting model. Off: the report still shows the comparison.
  - **Idle warning** (over $0.10, over $0.50, over $1 or off, default over $0.50): the bar for the band's note on what a cold cache costs. It never holds the prompt.
  - **Before the cache goes cold** (ask, keep warm 2 h, keep warm 8 h, keep warm until my usual start, save a handoff, compact or off): what happens when a big session ends a turn. Not set, your profile decides: Quality keeps warm 8 hours, Balanced until your usual start, Economy lets it go cold. Keeping warm never costs more than coming back cold.
  - **Reports** (api or subscription, default api): dollars, or a share of usage. A value you set is final.
  - **Band** (when it acts, always or off, default when it acts): when the band shows.
  - **Question wait** (30 seconds, 1 minute or 2 minutes, default 30 seconds): how long a dialog waits before rightsize takes the choice that changes nothing.
  - **Share anonymous feedback** (off or on, default off): send anonymous numbers to the author, at most once an hour. rightsize never asks; this row, `/rightsize status` and the report footer are where it shows. See [Privacy](#privacy).
  - **Price check** (monthly or off, default monthly): compare `prices.json` with Anthropic's pricing page every 30 days. `/rightsize prices` checks right away.

Every row in full, with the profile table: [docs/SETTINGS.md](../../docs/SETTINGS.md).

## Turn it off or remove it

- `/mods` pauses it; `/config` turns off single features.
- `claude plugin disable rightsize@archid21` stops it loading and keeps its settings and learning; `claude plugin enable rightsize@archid21` brings it back.
- `claude plugin uninstall rightsize@archid21` removes it and the settings saved in `/config`. Its stored data and logs stay on disk: `rm -r ~/.claude/plugins/store/rightsize_*.json ~/.claude/mods-logs/rightsize*` deletes them. If sharing was on, copy your install ID from `/rightsize status` first and email rightsize@aivalue.blog to have shared data deleted.

## What it touches

rightsize is a mod: it runs inside Claude Code and hooks some of its events. This is everything it does outside the chat.

- **Hooks.**
  - `prompt.submit`: rates the prompt, may change the effort level, and adds the hidden hand-off note. Your text is not changed. In watch only, it plans and logs and applies nothing.
  - `turn.start`: matches a turn that is starting to the prompt it was rated for. It changes nothing.
  - `turn.step`: watches each step to see when Claude is stuck and raises effort under your Raising rule.
  - `agent.spawn`: may move a general-purpose subagent that names no model to a cheaper model.
  - `tool.call`: notes whether a test command passed or failed (for the miss rate and for stuck turns), asks before the first workflow starts (at each Workflow call until answered), and denies steps only you can approve inside a hand-off helper, the calls of a helper that was stopped and sent back, and rework past the retry budget. It never approves a call and never changes a permission decision anywhere else.
  - `config.set`: watches its own `rightsize.*` rows, to know which values you set.
  - `turn.complete` may start a keep-warm timer, which sends one small request through Claude Code over the same conversation, submits `wrap up` for Groundwork, or compacts the conversation. It starts nothing while a turn runs.
  - `command.run`, `session.start`, `turn.complete` and `ui.render` serve its own command, start-up, measuring and the band.
- **Settings it writes.** Only its own `rightsize.*` rows, when you answer a question, pick a rule in the band, or run `/rightsize reset`. It never writes the permission mode or any other setting, and sets no environment variables.
- **Programs it runs.** Only `mkdir` and `chmod` with fixed arguments (log folders readable by you alone), and `rm -f` and `rmdir` on a session's log folder once nothing in it has changed for 45 days. It downloads and runs nothing.
- **Files it writes.** The logs below, its store in Claude Code's plugin store, and `prices.json` (keeping `prices.json.bak`). Nothing in your project.
- **What it reads.** Your prompt, the session's usage and rate limits, your `model` and `effortLevel` settings, its own rows, and the environment variables `HOME` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`. It reads no credentials. For each tool call in a turn it reads the tool, its arguments and whether it failed, to spot a stuck turn, a blocked step or a failing test run.
- **Network.** `platform.claude.com` (Anthropic's pricing page) every 30 days, and `feedback.aivalue.blog` only when Share is on, plus the Sonnet and Haiku calls Claude Code makes for it.

## Limits

- The app's effort picker does not move. The status line shows the level in use.
- Helpers keep their own model and effort unless rightsize hands them work, or Claude started them as general-purpose without naming a model.
- The rating is an estimate from a model. Calibration corrects cost guesses, not a wrong choice of model. rightsize measures how often the rating was wrong and stops trusting it where it keeps missing, but only once enough outcomes are in.
- Hand-offs usually take longer than staying, because of the brief and the check. The band says so; the report's Time section compares them.
- This is an independent project, not made or endorsed by Anthropic.

## Logs

Each session writes its own folder, `~/.claude/mods-logs/rightsize/<session ID>/`, and no other session writes to it. `/rightsize report`, the start suggestion and the miss rates read every session's folder together. A folder unchanged for 45 days is removed when a session starts. In each folder:

- `rightsize.log`: each decision.
- `runs.jsonl`: one JSON line per rated turn (the change made and suggested, estimated and actual cost, rating cost, rate-limit windows, duration, subagent calls, each model's rated level, whether it continued its task or corrected the last reply, keep-warm and workflow data), plus `unrated`, `dropped` and `unbound` lines for prompts that never ran, `check` lines for spot-checks, `feedback` lines for each 👍 or 👎, `warm` lines for keep-warm requests and `warmSaved` lines for what they saved. Lines such as `cold` (your answers to keep-warm offers) and `warmSaved` are never shared.
- `switches.jsonl`: each measured effort switch, and whether the cache was kept.

## Privacy

Logs stay on your machine. Nothing is sent to the author unless you turn **Share anonymous feedback** on. The rating call carries your prompt to Anthropic through Claude Code, as your prompts go anyway. The full field list, what is never sent, 👍/👎 and how to delete data: [docs/PRIVACY.md](../../docs/PRIVACY.md).
