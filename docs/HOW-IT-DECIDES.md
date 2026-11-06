# How rightsize decides

The rules in full, with every number and default. The short version is in the [README](../README.md); every setting is in [SETTINGS.md](SETTINGS.md).

Terms used here, defined once:

- **Level**: an effort level: low, medium, high, xhigh or max.
- **Rating**: a quick, cheap judgement of one prompt by the **rater** (Sonnet at low effort by default): what kind of work it is, how much it reads and writes, which level each model needs for it (its **fit**, or "would struggle"), and whether it carries on the current **task** or starts a new goal. A task is one goal, from the prompt that starts it until the rater says a prompt starts a new goal.
- **Route**: where the work runs and at what level: on your model, switched to another model for one turn (a **switch**), or handed to a **helper**, a subagent on another model (a **hand-off**; a hand-down goes to a cheaper model).
- **Miss**: a task that failed after rightsize chose a cheaper route or a lower level for it.
- **Baseline**: rightsize's estimate, made when it chose the route, of what the task would have cost on your model at the level it needed. It is never changed afterward. See [METHOD.md](METHOD.md).
- **Prompt cache**: the stored copy of your conversation that makes the next request cheaper. It expires after an hour (or 5 minutes; `prices.json` says which).
- **Profile**: Quality, Balanced or Economy: how much evidence rightsize needs before it picks a cheaper route.

## Your setting wins

A value you set in `/config`, or set from the band or `/rightsize settings`, is never changed or bypassed by rightsize's own behavior. That covers the thresholds, the four rules, **Reports** and every other row, and it beats the value your profile would supply for that row. Budget pacing moves only the bars you left at their default. A window nearly used up skips raises and stronger models only while their rule is not set. Rate limits never change **Reports** once you set it; `/rightsize status` says when they disagree. A value counts as yours once you set it, even to the number that is the default. `/rightsize status` shows your profile on its first line and lists the settings you changed.

## The four cases, and what asks

The four cases are Lowering (a prompt needs less effort), Raising (more effort on the same model), Stronger model (a stronger model than yours fits better, or a review runs on Opus for one turn) and Cheaper model (a task could run on a cheaper model). Each has a rule row.

- **A row at "not set" means the profile decides, and nothing asks.** The band says so the first time each case comes up in a session: `Your Balanced profile decided (Cheaper model); ⋯ changes it.` The other rules for the case are in the band's ⋯ menu.
- **What each profile does while the rows are not set:**

  | | Quality | Balanced | Economy |
  |---|---|---|---|
  | Lowering | ask me | lower automatically | lower automatically |
  | Raising | raise automatically | raise automatically | raise automatically |
  | Stronger model | always send | always send | stay, raise effort only |
  | Cheaper model | ask first | always send | always send |

- **An "ask" rule opens its own timed dialog** before the prompt runs. This is Quality's Lowering and Cheaper model, and any row you set to ask me, ask first or ask each time. It waits **Question wait** (30 seconds, 1 minute or 2 minutes). With no answer, the prompt runs unchanged: no raise, no stronger model, no subagent, nothing saved.
- **`/rightsize settings`** still asks the four questions for anyone who wants to set rules that way, and sets the rows from the answers.
- **Remember choices** (the question of whether to keep rules in every session) follows only a rule you set yourself, from the band's ⋯ menu or `/rightsize settings`. A rule the profile supplied is never asked about.
- **Questions on the band do not hold up your work.** Remember choices and Reports show when the turn ends and stay until your next prompt. Reports is asked only when no response shows how you pay (as with an API key); the answer is kept across sessions. Stuck, for the main chat or a helper, shows during the turn and goes when it ends; the turn goes on at its effort, a Raise applies from its next request, and a helper whose Stuck question gets no answer goes on at its effort. Workflow is asked at each Workflow call until you answer, and rightsize is paused for that workflow meanwhile. Press a number key or click an option to answer, or × to dismiss. Unanswered, each keeps its safe default: no raise, this session only, API prices, rightsize paused for the workflow. Where the band cannot show (Band set to off, or another surface such as the mobile app), these are timed dialogs too.
- rightsize sends nothing to its author. See [PRIVACY.md](PRIVACY.md).

## Watch only

With **Mode** set to `watch only`, every prompt is rated and planned and nothing is applied: effort is not changed, no review is switched, no work is handed off, nothing is asked. The band says what would have happened, for example `Watching: would send this to a Sonnet subagent at medium effort. ... Mode in /config turns it on.` `/rightsize report` has a `Watch only:` line: how many prompts would have changed and what that was estimated to save against staying (estimates; nothing was applied). The rating calls still cost what they cost, and are counted.

## Reading the session and the prompt

- **It plans from the session you are in.** On every prompt, including the first of a session (one started with `--model`, switched with `/model`, or resumed), rightsize reads the model in use and the size of the conversation from Claude Code. A conversation of unknown size is planned at 20K tokens. If no source names a known model, rightsize plans as if it were Opus and writes a line to `rightsize.log` saying so.
- **Every prompt is rated as you enter it.** Short ones too: a one-word follow-up is rated in its task. The rater is told how the task in progress began (the first 600 characters of the prompt that started it, its type and how many prompts it has had), so a short "yes, go ahead" is read for what it carries on. A request over 6,000 characters is shown to the rater as its first 4,000 and last 2,000 characters with a marked cut between. The rater is told that a bulk edit, extraction or summary with a clear rule fits Haiku at medium.
- **Missing context is no reason to downgrade.** When the request was cut, or a task is in progress and Claude's last reply could not be read, the rater may see less than there is. Then rightsize does not lower effort or hand the prompt to a cheaper model: it runs as it is. Raising effort and a stronger model are not affected. `rightsize.log` says so, and the run's line in `runs.jsonl` carries `unsure`.
- **A prompt that can't be rated is left alone.** If the Sonnet rating times out, is refused or can't be read, rightsize asks Haiku once. If that fails too, the prompt runs on your model at your level, and `/rightsize report` counts it under Not counted as savings. The failed calls' cost still counts as rating cost. A rating may take at most 12 seconds in all: Sonnet gets at most 9 seconds, and Haiku gets what is left, or is skipped when under 2 seconds are left.
- **A follow-up keeps its task's type.** The rating says whether a prompt carries on the task in Claude's last reply or starts a new goal. A prompt that carries on is planned as the type of its task. In a review task, a follow-up that the rater itself types as something else (a lookup, a fix) is planned as what it is, not switched to Opus. A new goal starts a task of its own type. When the two types differ, `rightsize.log` and the run log show both.

## Effort changes

Anthropic's docs say effort changes keep the prompt cache on the current models. rightsize does not rely on that alone: every effort switch is logged with whether the cache survived. Until it has measured switches of your own, it assumes a small share miss. Once 20 or more measured switches have missed at most 5% of the time, a switch is priced as free, so lowering can happen on big conversations too. Before that, lowering happens only when the saving beats the expected cost of a rewrite. Auto-lowered turns step back up to your normal level after 5 steps, or after a tool error. A step-up on the 5-step rule alone does not count as a miss; one after a tool error does.

## Hand-offs

Changing the model, other than a review switch, always means a helper. The main chat keeps its model and its cache. A hidden note beside your prompt (your text is unchanged) asks it to:

1. write a brief with a "Done means" list;
2. check the helper's result against that list;
3. send rework notes, at most the task's chances (1 under Quality, 2 under Balanced, 3 under Economy);
4. tell you how it went.

When the work goes to a cheaper model and still fails once the chances are used, the main chat finishes it itself. rightsize sets the helper's effort itself, so the level does not depend on Claude passing it on.

**Steps only you can approve stay in the main chat.** A helper must not push, publish, release, deploy or merge, or send messages or act in your accounts, because a message from another agent is not your approval. Its brief tells it to prepare the work (edits, tests, notes) and stop. rightsize's `tool.call` hook denies, inside a hand-off helper: shell commands that push, publish, release, deploy or merge (such as `git push`, `gh release create`, `gh pr create` or `merge`, `npm publish`, `vercel deploy`), and MCP tools whose action name starts with send, publish, deploy, merge or post. It also denies the calls of a helper that was stopped and sent back (so it reports instead of trying again), and rework past the retry budget (the main chat then finishes the work). The main chat checks the work and does the approval steps itself. A request that is mainly such a step ("push and release it") isn't handed off: the rating marks it, and only effort can change. When Claude keeps a chosen hand-off in the main chat because it pushed, published, deployed or sent something, the band says so and the report doesn't count it as a skipped hand-off.

**Handing work down needs a clear saving.**

- Hand-downs start only from an Opus or Fable session. From Sonnet, the brief and the check cost more than Haiku saves, so a Sonnet session keeps the work and may change effort instead. A hand-up (a model stronger than yours) and Claude's own subagents are not affected.
- A helper is used only when its estimate is under the hand-off threshold (50% Quality, 70% Balanced, 85% Economy; or the **Hand-off threshold** row) of the cost of staying at the level the work needs on your model, counting the brief, report, check and likely rework. A raise counts with the cache it may rewrite.
- The main chat's part is priced from measured hand-offs: it reads your conversation several times (brief, report, check, answer), so a short task never clears the bar and a long, mechanical one can. Of the cheaper models that fit, the cheapest route wins unless two are close in cost.
- Because Sonnet costs half of Opus, an Opus-to-Sonnet hand-off rarely clears 70%. Hand-offs to Haiku, and hand-offs from Fable, clear it more often.
- Lowering effort needs the lower level to cost under 90% of staying (**Lowering threshold**), counting the cache it may rewrite.
- Under Quality a hand-down or a lowering also needs at least 10 logged tasks of that kind on that route with under 10% misses. Balanced and Economy use the rating alone for work the research did not cover; only Quality waits for 10 logged tasks.
- A model that needs a higher level than **Highest effort** allows does not fit, so it gets no hand-off, up or down. **Use Haiku** and **Use Fable** turn off work sent to either model (Haiku still rates your prompts).

**Close calls go to the model suited to the task.** Early on, estimates are guesses, so two models that fit can land close in cost by chance. When they are within a band of each other, rightsize picks by task type: Haiku for lookups, searches, bulk edits, extraction and summaries; Sonnet for writing, features, debugging, refactors and other work; Opus for design and reviews. The band starts at 25% and shrinks to nothing once both routes have 20 measured runs. By default a close call always takes the task-type pick. **Explore close calls** turns exploring on: one close call in five takes the other model, so both get measured. It only chooses between routes that already pass the hand-off threshold.

**Claude's own subagents are right-sized too.** When Claude starts a general-purpose subagent without naming a model, it would run on Claude's model (often Opus). rightsize rates its brief (with the rater) and runs it on the cheapest weaker model that fits, at that model's level, when that costs under the hand-off threshold. It never moves a subagent to a stronger model, to a model paused for that kind of work, or to a model that needs a level above **Highest effort**. It leaves alone subagents that name a model, other agent types, forks, workflow agents, resumes, teammates, and subagents started by other subagents. Each one it moves costs one rating call. **Claude's subagents** turns this off.

**Workflows are your call, asked until answered.** When Claude starts a workflow (ultracode, or asked for), it can start many helper agents at once, each picking its own model. rightsize asks on the band at each Workflow call until you answer, while the workflow runs with rightsize paused, and saves your answer as **Workflows**: pause rightsize (hand nothing off for the rest of the session, leave the agents alone), follow my rules (hand-offs follow your Stronger model and Cheaper model rules; agents left alone), or right-size every agent (each workflow agent that names no model gets one rating and may run on a cheaper model; **Claude's subagents** off keeps them alone). Whatever you pick, measurement stays paused after a workflow: calibration learns nothing and no saving is claimed.

## Reviews

A review runs on Opus at high effort or more. Below that, a review misses the subtle bugs it is for, and a rating can't tell that from the prompt. A review needs the whole conversation, so from a Haiku or Sonnet session it is not handed to a helper: the main chat switches to Opus for that one turn, then goes back to your model. Opus writes the conversation to its cache once for the switch, and the estimate counts it. On Opus, effort is raised to high and not lowered. From Fable, a review can go to an Opus helper; it is never handed below Opus. Your **Stronger model** rule decides whether the switch happens, is asked about or is skipped. A switched review runs at **Highest effort** at most under Quality and Balanced, and at high effort at most under Economy. The band shows the cost multiple before the turn. A switched review does not count toward a starting-model suggestion.

## How a route is scored

Every choice rests on one rating call, so rightsize checks how often that call was wrong, per task type and model.

- **Misses:** a hand-off that needed rework (more than one helper call); a lowered turn that stepped back up after a tool error, or was raised mid-turn (a step-up on the 5-step rule alone is not a miss); an unchanged turn raised mid-turn; a test run that fails at the end of a turn (main chat or its helper) after a lowering or a hand-down; a next prompt the rater marks as correcting the reply ("that broke X", "no, I meant"), which counts against the cheaper route before it; a 👎; a Sonnet check that disagreed.
- **Hits:** a hand-off without rework, a lowered turn that held, a 👍, and an agreeing check.
- **When a rate counts:** a task type needs 5 outcomes on a model before its own rate counts; before that, the model's rate across all task types counts once it has 5. Only the last 30 days of the log count.
- **Research priors.** Some work starts with a built-in miss rate, set from rightsize's own research and tuning, that counts as 10 tasks. Haiku on reviews starts at 0.8 and on writing at 0.5, and Sonnet on reviews at 0.3; the other kinds of work on Haiku and Sonnet (lookups, searches, bulk edits, debugging, refactors, features) start at 0. Each real outcome pushes one prior task out, so a few good outcomes of your own lift the pause, and after 10 only your own log counts. The first miss on a route is forgiven once: the band says so, and the next counts. A 👎 always counts. A task counts once, however many outcomes it has. Work the research did not cover (Opus and Fable are the reference and have no prior) uses the rating alone under Balanced and Economy; only Quality waits for 10 logged tasks.
- **The pause.** When a rate reaches the **Pause after misses** line (10% Quality, 20% Balanced, 30% Economy unless you set the row; the row offers 20% to 50% or off), rightsize stops handing that kind of work down to that model and stops lowering effort on it, until the rate falls back under the line. `/rightsize report` says when this is happening. Outcomes are read from the run log on your machine.
- **Sonnet spot-checks Haiku.** Sonnet is the default rater and is not checked against itself. On every 20th prompt Haiku rated under Balanced (because **Rater** is haiku, or Sonnet failed; every 10th under Quality, 30th under Economy, or what **Rater check** sets), rightsize sends the same prompt to Sonnet at low effort in the background. It never delays your prompt. Where Haiku said a model does the work and Sonnet says it would struggle, that counts as a miss; where both name a level, a hit. The check is logged as a `check` line with its cost, which the report counts with the rating calls.

## When Claude gets stuck

During a turn, rightsize watches the main chat's tool calls. At normal sensitivity, when the same call fails twice, 3 calls fail, the same call runs 3 times, or the turn passes 3x the steps the rating guessed (at least 15), it raises effort one level for the rest of the turn: at most twice a turn, never to max, never above **Highest effort**. **Stuck sensitivity** moves the numbers: relaxed waits for more (3 failures of one call, 4 failing calls, 4 runs, 4x the steps and at least 20), sensitive for less (2 failing calls, 2 runs, 2x the steps and at least 10). A failing test run needs one more repeat than any other call, since a red test run is often expected. It follows your Raising rule: automatic raises without asking; ask asks on the band while the turn goes on at its effort; never does nothing. A call you refused permission for does not count, and neither does an error from the environment (a denied permission or sandbox, no network, no login, a program that is not installed). The run log counts those as `blocked`. These turns teach calibration nothing and claim no saving. **Raise when stuck** turns it off. On a Sonnet session, a rating alone does not raise effort for debugging; effort goes up there when the turn shows it is stuck.

## The prompt cache: idle warning and keep warm

**Idle warning.** The cache lives an hour (or 5 minutes). When a session sat idle past that, the next prompt writes the whole conversation to the cache again. It remembers each session's last turn, so a `--resume` days later is caught too. When rewriting costs over the row's bar (**Idle warning**, default over $0.50), the band notes it beside what rightsize did with the prompt. It never holds the prompt. For example: `Idle 2 h: the cache went cold, so this prompt writes the conversation (~120K tokens) again, ~1.2% of your 5-hour window more than warm; /compact first would have cost ~0.3%.` On a subscription the cost is a range of your 5-hour window with API-equivalent dollars beside it (dollars alone, labelled API-equivalent, until runs show the rate).

**Keep warm.** When a session ends a turn (there is no size ceiling), and coming back after its cache expires would cost $0.50 or more (about 65K tokens on Opus, about 130K on Sonnet, never on Haiku; API-equivalent dollars on a subscription too), rightsize does what **Before the cache goes cold** says. While the row is not set, the profile decides:

- Quality keeps warm for 8 hours.
- Balanced keeps warm until your usual start time: the median time of your first prompt each day over the last 14 days, to 15 minutes, at most 8 hours (9:00 until 5 days of runs show it).
- Economy lets the cache go cold.

While the row is not set (the profile decided), keep warm gives way to a compact when that is cheaper over the time you usually stay away. rightsize takes the expected idle time E as the median of the last 20 idle gaps (5 minutes or more) in this project, at most 8 hours, and 8 hours until 5 gaps exist. Keeping warm for E costs one request per cache life, each reading the whole conversation from the cache. If that is at least 3 times a compact plus one cold read of its summary, it compacts instead; the log says both figures. A row you set yourself is never overridden. On a 1-hour cache, keep warm usually wins on Opus and Sonnet, because a cache read costs a tenth of an input read; on a 5-minute cache the compact can win.

Just before each expiry (3 minutes before on a 1-hour cache, 1 minute on a 5-minute cache) rightsize sends one small request, `Reply with the single word OK.`, which reads the conversation from the cache and so refreshes it. The band shows a status row, `Warm until 9:00 · ~0.3% so far` (dollars on the API; `$0.00 so far`, or `~0% used so far` on a subscription, before the first request), with **Stop keeping warm**. `Don't keep warm again` in ⋯ sets the row to off, as your own setting. It stops when you send a prompt, press Stop keeping warm, a request fails, the end time comes, or keeping warm would cost more than coming back cold. That cap is never passed: on a 5-minute cache it is about 96 minutes on Opus, and the log says when a longer choice was cut short. Each request is a `warm` line in the run log, and the report counts its cost as rightsize's own cost, so Total saved is lower by what the pings cost. A turn that starts before the timer fires skips it, and its end starts a new round.

The other values of the row:

- **ask**: the band offers the choices 5 minutes after the turn ends on a 1-hour cache (at once on a 5-minute cache), on a Cache row of its own, for example `Goes cold in 42 min (14:55) · coming back after costs about $0.63`, with the minutes counted down once a minute. One button is the choice you picked most in your last 10 answered offers, or the first keep-warm choice until you have answered some; the others are in ⋯ (keep warm 2 hours, 8 hours or until your usual start, each shown as the clock time it ends and its cost in one unit; Save a handoff, or Compact now without whatsnext; Let it go cold; Don't offer again). A choice that costs more than coming back cold is not offered. After you give the same answer three times in a row, the next offer asks `Always …?` (Yes sets the row); after five offers with no answer it asks `Stop offering to keep the cache warm?` once. Each answer is a `cold` line in the run log on this machine. No profile uses ask; it is there for anyone who sets it.
- **keep warm 2 h**, **keep warm 8 h**, **keep warm until my usual start**: as above, with a fixed end.
- **save a handoff**: before expiry, rightsize sends the prompt `wrap up` once. whatsnext's skill answers it and writes the handoff; rightsize writes none of whatsnext's files, and the prompt is not rated. whatsnext answers `wrap up` only in a project it says is its own (the `project` field of its `compact-instructions --json` answer); without whatsnext, or in a project it was not started in, rightsize compacts instead.
- **compact**: before expiry, rightsize compacts the conversation once. With whatsnext installed and started in the project, it asks whatsnext for its `/compact` instructions and runs `/compact` with them. When whatsnext wants a fresh handoff first, rightsize sends `wrap up` once, waits for that turn to end, then compacts; it never sends a second `wrap up`. A queued prompt may run before the wrap-up, so at the end of each main turn rightsize asks whatsnext again and compacts only once it no longer wants a handoff; after 2 turns without one it gives up and the band says so. With under 40,000 tokens of room left in the window a wrap-up turn could overflow it, so rightsize skips `wrap up`, compacts with the handoff that exists, and the band says "no fresh handoff". If whatsnext cannot be used (not found, an error, an answer rightsize cannot read), it compacts with Claude Code's own compaction instead, and the log says why. The same goes for **Compact now** on the advice to compact before your 5-hour limit.
- **off**: nothing.

**Keep warm is credited for what it prevents.** When you send a prompt during a keep-warm run (or within a cache life of its last request) and after the time the cache would have gone cold without it, rightsize looks at the prompt's first request. If it read at least about 80% of the conversation from the cache, one `warmSaved` line records what coming back cold would have cost: the conversation written to the cache again, less a read. If the cache missed, the log says so and no saving is counted. A prompt sent before the cache would have expired saves nothing, and a run you never come back to is pure cost. The report's Keep warm line shows runs, what they saved on your returns, what their requests cost, and the net.

## Compacting and context

rightsize decides when a compact pays; whatsnext decides what it keeps. Nothing here compacts until you press a button, except the rows above that you set yourself.

- **Context-size warning.** At the end of a main turn, when the conversation first reaches 40, 50, 60, 70, 80 or 90% of the window, the cache row says so with **Compact now**. Each step is said once per conversation (a compact starts the count over), and a jump past several steps says only the highest. A step whose token count is at or above Claude Code's own auto-compact point (`autoCompactThreshold`) is skipped. While keep warm runs, the warning joins its row: the warning first, then the keep-warm line, with **Compact now** beside **Stop keeping warm**; Compact now also stops keep warm. The usage-limit advice joins a keep-warm row the same way. An offer on the cache row, or the usage-limit advice already on it, comes first; the step is said at a later turn's end. ⋯ has **Why?** and **Don't show again**.
- **Advice to compact before your 5-hour limit.** With the 5-hour window at 90% or more, over 30,000 tokens of conversation and a reset further off than the cache lives, the row says a compact now would save money after the reset. Once per window.

## Pacing your usage windows

On a subscription, each response reports how much of the 5-hour and 7-day windows is used and when each resets. rightsize divides the share used by the share of time gone, and acts on whichever window would stop you first:

| Pace | Hand-off bar | Lowering bar | Also |
|---|---|---|---|
| Over 1.2 (on pace to run out early) | 70% → 85% | 90% → 97% | |
| Under 1.2 (including much of the window unused) | your setting | your setting | Nothing changes |
| Over 90% used, any time | 95% | lowers whenever it fits | Skips raises and stronger models while their rules are not set |

An underused window changes nothing: spending more is never a reason to act. The first 15% of a window is not paced. The numbers are what a bar left at its default moves to; a bar you set stays as you set it. When pacing moves a bar, the band says which: `hand-off bar 70% → 85%`. A window nearly used up skips a raise or a stronger model only while its rule is not set; "ask" always asks. **Budget pacing** turns it off.

## Costs, calibration and prices

- **Work per model.** The same task takes different work on different models and levels. Opus at low effort makes fewer tool calls than at medium, Haiku writes more than Sonnet, and Fable does more than Opus. rightsize scales each estimate's output and tool calls by model and level, with Sonnet as the baseline. The starting numbers come from published benchmarks, and calibration corrects them.
- **Long runs.** A run's cost grows more slowly than its step count. rightsize learns how much more slowly from your runs, scores each run with and without that, and uses it for routing only once it clearly cuts the estimate error. The report footer says whether it is still learning or applied since a date.
- **Real costs.** After each rated turn, rightsize reads what the turn cost from Claude Code's cost ledger (the `/cost` total), which prices cache writes at the TTL they were written at. The rating call is left out. Where there is no ledger, it prices the API's token counts from `prices.json`. It moves its estimates toward that cost, per task type and route, and per model and model-at-level, in the main chat, in hand-offs and for Claude's own subagents it moved. After 20 runs the measured average replaces the guess. A lowered turn that stepped back up is left out. Sessions running at the same time add to one shared record. When the work-per-model estimates came in, calibration started over once: earlier learning is ignored, not deleted.
- **How you pay.** Each response carries rate-limit windows: a subscription shows five-hour and seven-day windows, and a Claude gateway shows a spend limit. rightsize shows reports in dollars (API) or as a share of usage (subscription). Only when a response shows none does it ask you once. A **Reports** value you set is final.
- **Haiku is priced by prompt length.** A request whose prompt is over 100,000 tokens (input, cache reads and cache writes together) pays Haiku's higher prices: $0.50 input, $0.625 or $1.00 cache write, $0.05 cache read and $2.50 output per million, against $0.10, $0.125 or $0.20, $0.01 and $0.50. Each request is priced on its own prompt. rightsize applies this to Haiku's real responses, to the estimate for a Haiku helper whose prompt grows past 100K (the requests past it, not the whole job), and to a cold return or keep-warm request on a Haiku session. Other models have one price.
- **Prices stay current.** Every 30 days it compares `prices.json` with Anthropic's pricing page and writes in any change, keeping the old file as `prices.json.bak`. `/rightsize prices` checks right away; **Price check** turns the schedule off.

## Choosing a starting model

rightsize works from the model and effort level your session starts on, so the start changes what you spend. Start on Sonnet 5.5 at medium: it handles lookups, searches, edits, features, debugging and writing well, for much less than Opus. Start on Opus 5.5 at medium only when most of your work is design or review. Avoid Opus at low, which makes rightsize raise effort often (each raise may rewrite the cache), and Fable.

- **The day-one tip.** On the first session on an Opus start with fewer than 50 rated prompts, the band shows once: `Starting tip: most work runs as well on Sonnet 5.5 at medium for well under half the usage of Opus. Reviews still run on Opus, and work Sonnet would struggle with goes to a stronger helper. Switch with /model sonnet.` The button **Switch: /model sonnet** puts the command in the prompt box and you press Enter; **Not now** closes it. rightsize never changes the model itself.
- **The weekly suggestion.** Once a week (or a month: **Start suggestions**) at session start, rightsize estimates what the last 30 days of rated prompts would have cost from Sonnet and Opus at medium and high, with its hand-offs and effort changes counted. The band suggests a switch when another start is at least 15% cheaper (25% while rightsize has measured few runs on it) and would send no more than 1 prompt in 10 to a stronger model, or when over 15% of prompts needed a stronger model or Claude got stuck. Where Haiku's rating of a model has been wrong for a task type, that share is estimated as if the model had been rated unable. The estimate follows **Use Haiku**, **Use Fable** and **Highest effort**. It needs 50 rated prompts in 30 days, and 20 on your current start. **Not now** quiets the same suggestion for 14 days; **Stop suggesting** turns it off. `/rightsize report` always shows the comparison.

## The band

A band above the prompt (CLI and desktop app; VS Code and the mobile app keep the status line) has one labelled row per topic, at most three: **Prompt**, **Cache** and a question. Each row is a dim label, one line, and that row's buttons; with one row, it starts with `rightsize ·` and carries ⋯ and × at its end. A question waits while the band already shows a Prompt and a Cache row, unless it ends with the turn (Stuck).

- **Retry at original effort** puts the prompt back in the box, to run at your normal level (it does not undo file changes). **Clear** drops a session-wide switch. A hand-off or switch also has **Run on <your model>**, which runs the prompt once without rightsize.
- Each route says why (the rater's reason). A lowering or a hand-off to a cheaper model also gives confidence: `Confidence: low.` until 10 of your own tasks are logged on that route, then high or medium from how often it missed.
- **⋯** holds the other rules for the case (your current answer is not listed; picking one sets the row), the cache choices, **Mark this 👍 (right call)** and **Mark this 👎 (wrong call)**, and when the band shows. On a subscription it also gives a hand-off's API-equivalent dollars. **×** closes the band until your next prompt.
- After a hand-off the band shows the result, for example `Sent to Haiku. $0.04 vs ~$0.31 on Fable (~87% saved).` on the API or `Sent to Sonnet. ~28% of Opus usage.` on a subscription. With the band off, that result is a line in the transcript.
- From the session's 3rd rated prompt, every band ends with the session's running total, for example `Session: ~$0.84 saved` (on a subscription a range of your 5-hour window, `Session: ~10–17% saved`).
- A 👍 or 👎 is written to the run log on this machine and tunes rightsize's choices there. It is not sent anywhere. See [PRIVACY.md](PRIVACY.md).

## What the report shows

`/rightsize report` is plain text in the terminal and Markdown in the desktop app. A section with nothing to show is left out.

- **Headline** for the last 30 days. On a subscription, the share of your 5-hour window the saving kept, as a range (usage comes in whole percents, so a total is never exact), and about how many minutes that is.
- **Table** for this session, the last 7 days and the last 30 days: Total saved (after the cost of the rating calls), window shares saved, share of cost saved, Extra spent on harder prompts (what raising effort or a stronger model cost; not taken off Total saved), then prompts rated, kept, lowered, raised, sent to a cheaper or stronger model, suggestions you declined, Claude's subagents moved and close calls. On a subscription every dollar figure is labelled API-equivalent.
- **Watch only**: when Mode is watch only, how many prompts would have changed and what that was estimated to save.
- **Starting point**: what your last 30 days would have cost from Sonnet and Opus at medium and high.
- **Fixed context**: the tokens every request carried that rightsize can't trim, largest part first (MCP tools with the biggest servers named, skills and commands, agent descriptions, CLAUDE.md and memory).
- **Accuracy**: how often Haiku's judgement was wrong, how the spot-checks went, hand-downs paused, and how far the estimates were off.
- **Not counted as savings**: a count and a reason for each kind of turn that got no saving or went off course.
- **Keep warm**: runs, what they saved on your returns, what their requests cost, and the net.
- **Time**: for the last 30 days, per task: Claude's time (median and 90th percentile), time to done (from your first prompt to the last turn's end, including your own time), the rating's delay and how many prompts used up the 12-second budget, and Claude's time on tasks handed to a cheaper model against tasks that stayed. Time is reported and never used to choose a route.
- **Whole tasks**: what finished tasks cost against what rightsize estimated for them, from 5 finished tasks.
- **Next steps** and a **footer**: the saving is an estimate against the baseline and can be negative; what the rating calls cost; on a subscription, that dollars are what the same use would cost on the API and you only pay for your subscription.
