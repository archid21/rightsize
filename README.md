# rightsize

**A Claude Code mod that matches each prompt to the right model and effort level, so you don't pay Opus prices for Haiku work.**

Created by [Archi Dubey](https://github.com/archid21). MIT license.

## Before you use it

rightsize is a work in progress. It changes how Claude Code spends your tokens, and its choices are estimates. Savings are not guaranteed: some turns can cost more, not less, and a cheaper model can sometimes do weaker work. Use it at your own risk, and check `/rightsize report` to see what it really did for you.

Feedback and feature requests are welcome. If you find a bug, a wrong call, or a saving that didn't show up, or you have an idea for a feature, [open an issue](https://github.com/archid21/rightsize/issues). What you report shapes what gets built next.

## What it does

Not every prompt needs your strongest model thinking its hardest. "Rename this variable" and "redesign the auth flow" get the same treatment by default. rightsize looks at each prompt before it is sent and picks a better fit.

### It sizes each prompt

- Before each prompt goes out, a quick, cheap check rates how hard the work is.
- Simple work runs at lower effort. Hard work gets more.
- If Claude gets stuck partway through (the same command keeps failing, or it goes in circles), rightsize turns the effort up for the rest of that turn.

### It hands work to cheaper helpers

- When a smaller model can do a task well, rightsize sends the task to a helper (a subagent) on that model. Your main chat stays as it is.
- The main chat writes the helper a clear brief, checks the result, and asks for fixes if needed. If the helper still can't get it right, the main chat does the work itself.
- When Claude starts its own helpers, rightsize moves them to a cheaper model too, if that model can do the job.

### It looks after your budget

- On a subscription, it watches your 5-hour and weekly limits. If you are using them up too fast, it saves harder. If you will have plenty left over, it lets Claude work harder.
- It warns you before an old, idle session would cost you a lot to pick up again, and shows cheaper options. On a subscription it gives the cost as a share of your 5-hour window.
- It keeps its price list up to date with Anthropic's pricing page.

### It learns and shows its work

- After each prompt, it compares what it expected to spend with what you really spent, and it adjusts its guesses next time.
- `/rightsize report` shows what it changed, about how much it saved, and what went wrong, for this session, the last 7 days, and the last 30 days.
- The report also shows the fixed overhead that comes with every message (tools, instructions, plugins) and how to cut it.

### You stay in charge

- The first time each kind of change comes up, rightsize asks you what to do: do it automatically, ask each time, or never.
- A small bar above the prompt tells you what it changed, with buttons to undo it or change your rule.
- Every limit and feature can be changed or turned off in `/config`.

## Install

You need Claude Code 2.1.287 or newer in the terminal, or 2.1.286 or newer in the desktop app. Installing takes about 2 minutes.

### Install it yourself

1. Open a terminal (on a Mac, the Terminal app).
2. Check your Claude Code version:

   ```bash
   claude --version
   ```

   If the number is lower than 2.1.287, update Claude Code first:

   ```bash
   claude update
   ```

3. Add the rightsize marketplace, so Claude Code knows where to find it:

   ```bash
   claude plugin marketplace add archid21/rightsize
   ```

   It should end with `Successfully added marketplace: archid21`.
4. Install rightsize for all your projects:

   ```bash
   claude plugin install rightsize@archid21 --scope user
   ```

   It should end with `Successfully installed plugin: rightsize@archid21 (scope: user)`. A note that some options are not set yet is normal: every option has a default.
5. Start a new Claude Code session (type `claude`, or open a new session in the desktop app). Sessions that were already open don't load it.
6. Type `/rightsize` and press Enter. If it shows its status, it works.

Already inside Claude Code? You can type `/plugin marketplace add archid21/rightsize` and then `/plugin install rightsize@archid21` instead of steps 3 and 4. When it asks where to install, pick the user scope.

### Ask Claude to install it

Paste this into any Claude Code session:

```
Install the rightsize plugin from GitHub for me. Run these two commands in the terminal:
1. claude plugin marketplace add archid21/rightsize
2. claude plugin install rightsize@archid21 --scope user
Tell me if either one fails and why. When both succeed, tell me to start a new session and type /rightsize to check that it works.
```

Claude asks your permission before it runs each command. When it is done, start a new session and type `/rightsize`.

## The four questions

Each question is asked once, the first time its case comes up:

| Case | Choices |
|---|---|
| **Q1** A prompt needs less effort | Lower automatically · Ask me each time · Never lower |
| **Q2** It needs more effort on the same model | Raise automatically · Ask me each time · Never raise |
| **Q3** A stronger model would do better | Ask before sending it to a subagent · Send it automatically · Stay on this model, raise effort only · Ask me each time |
| **Q4** A task could run on a cheaper model | Send it to a cheaper subagent · Ask before sending it · Stay on this model, lower effort only · Ask me each time |

After your first answer, rightsize asks whether to use your choices in every session.

## How it decides

- **Effort changes can cost a cache rewrite.** Anthropic's docs say that changing effort at the top level of a request resets the conversation's prompt cache. A per-message change (beta) keeps it. rightsize counts that cost, and it measures what Claude Code really does: every effort switch is logged with whether the cache survived. Lowering effort happens only when it pays.
- **Changing the model always means a subagent.** The main chat keeps its model and its cache. A hidden note beside your prompt (your text is unchanged) asks it to:
  1. write a brief with a "Done means" list
  2. check the subagent's result against that list
  3. send at most 2 rework notes
  4. tell you how it went

  When the work goes to a cheaper model and still fails after 2 reworks, the main chat finishes it itself.
- **The subagent runs at the level its model needs.** rightsize sets the effort of the hand-off's subagent itself, so the level does not depend on Claude passing it on.
- **Claude's own subagents are right-sized too.** When Claude starts a general-purpose subagent without naming a model, it would run on Claude's model (often Opus). rightsize rates the subagent's brief with Haiku and runs it on the cheapest weaker model that fits, at that model's level, when that costs under the hand-off threshold. It never moves a subagent to a stronger model. It leaves alone subagents that name a model, other agent types (they may set their own model, which rightsize can't see), forks, workflow agents, resumes, teammates, and subagents started by other subagents. Each one it moves costs one Haiku rating call. **Claude's subagents** in `/config` turns this off.
- **Handing work down needs a clear saving.** A cheaper subagent is used only when its estimate is under 70% of the cost of staying at the level the work needs on your model (a raise counted with the cache it may rewrite), counting the brief, report, check and likely rework. Of the cheaper models that fit, the cheapest route wins, unless two are close in cost (see the next point). Because Sonnet costs half of Opus, an Opus-to-Sonnet hand-off rarely clears 70%. Hand-offs to Haiku, and hand-offs from Fable, clear it more often. Lowering effort needs the lower level to cost under 90% of staying, counting the cache it may rewrite. Both are defaults you can change in `/config`.
- **Close calls go to the model suited to the task.** Early on, the estimates are guesses, so two models that fit can land close in cost by chance. When they are within a band of each other, rightsize picks by task type instead:
  - Haiku for lookups, searches, bulk edits, extraction and summaries.
  - Sonnet for writing, reviews, features, debugging, refactors and other work.
  - Opus for design.

  The band starts at 25% and shrinks to nothing once both routes have 20 measured runs. One close call in five takes the other model, so both get measured. It only chooses between routes that already pass the hand-off threshold, so it never makes a hand-off happen. Close calls are most common in Fable sessions.
- **It raises effort when Claude gets stuck.** During a turn, rightsize watches the main chat's tool calls. When the same call fails twice, 3 calls fail, the same call runs 3 times, or the turn passes 3x the steps the rating guessed (at least 15), it raises effort one level for the rest of the turn: at most twice a turn, and never to max. It follows your Raising rule (Q2): automatic raises without asking, "Ask" asks mid-turn, never does nothing. A call you refused permission for does not count. These turns teach calibration nothing and claim no saving. **Raise when stuck** in `/config` turns it off.
- **It warns before an expensive resume.** The cache lives an hour (or 5 minutes, per `prices.json`). When a session under 200K tokens sat idle past that, the next prompt writes the whole conversation to the cache again. rightsize asks first, for example: `This session sat idle for 3 days, so its cache has likely expired. Sending writes the whole conversation (~120K tokens) to the cache again: about $0.94 more on Opus than a warm cache. /clear costs nothing; /compact about $0.48.` Hold it and the prompt goes back in the box. It remembers each session's last turn, so a `--resume` days later is caught too. On a subscription the question gives the cost as a share of your 5-hour window, with API-equivalent dollars beside it (dollars alone until runs show the rate). Sessions over 200K get Claude Code's idle compaction, so rightsize leaves those alone. **Idle warning** in `/config` sets the bar.
- **It paces your usage windows.** On a subscription, each response reports how much of the 5-hour and 7-day windows is used and when each resets. rightsize divides the share used by the share of time gone, and acts on whichever window would stop you first:

  | Pace | Hand-off threshold | Lowering threshold | Also |
  |---|---|---|---|
  | Over 1.2 (on pace to run out early) | 85% | 97% | |
  | 0.6 to 1.2 | 70% (your setting) | 90% (your setting) | |
  | Under 0.6 (much will go unused) | 50% | 80% | Raises effort without asking when the rule is "Ask" |
  | Over 90% used, any time | 95% | lowers whenever it fits | Skips raises and stronger models |

  The first 15% of a window is not paced, since a few prompts there look like a flood. Thresholds you set in `/config` move by the same amounts. Choices set to never or stay are kept. The band says when pacing changed a decision. **Budget pacing** in `/config` turns it off.
- **It counts the work each model does.** The same task takes different work on different models and effort levels. Opus at low effort makes fewer tool calls than at medium, Haiku writes more than Sonnet, and Fable does more than Opus. rightsize scales each estimate's output and tool calls by model and level, with Sonnet as the baseline. The starting numbers come from published benchmarks, and calibration corrects them.
- **It learns from real costs.** After each rated turn, rightsize reads what the turn really cost from Claude Code's own cost ledger (the `/cost` total), which prices cache writes at the TTL they were written at. The Haiku rating call is left out. Where there is no ledger, it prices the API's token counts from `prices.json` instead. It moves its estimates toward that cost, for each task type and route, and also for each model and each model at each level, in the main chat, in hand-offs, and for Claude's own subagents it moved to a cheaper model (measured when each one answers). A model and level with few runs leans on what the task type as a whole has shown. After 20 runs, the measured average replaces the guess. A lowered turn that stepped back up is left out, since part of it ran at your normal level. Sessions running at the same time add to one shared record, so none overwrites another's runs. When the work-per-model estimates came in, calibration started over once: what it learned before is ignored, not deleted.
- **It knows how you pay.** Each response carries rate-limit windows: a subscription shows five-hour and seven-day windows, and a Claude gateway shows a spend limit. rightsize reads them and shows reports in dollars (API) or as a share of usage (subscription). Only when a response shows none, as with an API key, does it ask you once. The answer is kept across sessions.
- **Prices stay current.** Every 30 days it compares `prices.json` with Anthropic's pricing page and writes in any change, keeping the old file as `prices.json.bak`.

## The band

A one-row band above the prompt shows what rightsize did, with buttons to act on it:

```
rightsize: Effort lowered: high → medium for this prompt (automatically).  [Undo] [Ask me each time] [Never lower] [⋯] [×]
```

- **Undo** puts the prompt back in the box, to run at your normal level. **Clear** drops a session-wide switch.
- The rule buttons change your answer for this case (Q1–Q4) in one press. Your current answer is not shown.
- **⋯** chooses when the band shows. **×** closes it until your next prompt.
- In the CLI, focus the band (ctrl+x tab or a click) and press a button's number.
- After a hand-off, the band shows the result, for example `Sent to Haiku: $0.04 vs about $0.31 on Fable (estimated), saved about 87%.` With the band off, that result is a line in the transcript instead.

The band shows in the CLI and the desktop app. VS Code and the mobile app keep the status line.

## Commands and settings

- `/rightsize`: the state, your answers, the calibration and the cache-switch results.
- `/rightsize report`: what rightsize did for you this session, in the last 7 days and in the last 30 days.
  - How many prompts it rated and changed, how often you kept your level, and how many of Claude's subagents ran on a cheaper model.
  - The estimated saving after the cost of its own Haiku rating calls. Extra spending from raising effort or using stronger models is shown on its own line.
  - On a subscription, the share of your 5-hour (and 7-day) window that saving kept, and about how many more minutes that is at the current pace. This comes first, and dollar amounts are marked API-equivalent.
  - Fixed context: the tokens every request carried that rightsize can't trim (MCP tools by server, CLAUDE.md and memory, skills and commands, agent descriptions), what re-reading them cost, and how to cut it.
  - Close calls, in the last 7 and 30 days: how many the task-type guide decided, and how many took the other model to measure it.
  - What went wrong: lowered turns that stepped back up, turns raised mid-turn because Claude looked stuck, hand-offs that cost more or needed rework, hand-offs Claude skipped, effort switches that missed the cache, turns you stopped, and how far its estimates are off.

  A saving is an estimate: what staying at your own level and model would have cost, scaled by what the turn really cost. Turns that stepped back up get no saving.
- `/rightsize settings`: ask the four questions again.
- `/rightsize undo`: put the last auto-lowered prompt back in the box, to run at the normal level.
- `/rightsize clear`: drop a session-wide effort switch.
- `/rightsize prices`: check prices now.
- `/config` → rightsize:
  - **Lowest effort**: low, medium or high.
  - **Reports**: dollars, or share of usage for subscriptions. Setting it counts as your answer; rate limits that show a subscription still win.
  - **Hand-off threshold**: 50%, 60%, 70% (default), 80% or 90%. A cheaper subagent must cost under this share of staying. Lower is stricter.
  - **Lowering threshold**: 70%, 80%, 90% (default) or 95%. A lower effort level must cost under this share of staying. Lower is stricter.
  - **Claude's subagents**: cheaper when it fits (default) or off.
  - **Budget pacing**: on (default) or off.
  - **Raise when stuck**: on (default) or off.
  - **Idle warning**: over $0.10 (default), over $0.50, over $1, or off.
  - **Band**: when it acts (the default: only when rightsize changes something), always (every rated prompt, "No change" included), or off (status line only).
  - **Price check**: monthly, check now, or off.

## Logs

These are in `~/.claude/mods-logs/`:
- `rightsize.log`: each decision.
- `rightsize-runs.jsonl`: each rated turn, changed or not and stopped or not. Each line has the session ID, the change made and the change suggested, the estimated and actual cost (and whether the actual cost came from the `ledger` or from `tokens`), the rating call's cost, the rate-limit windows before and after, the turn's duration and its subagent calls, each model's rated level (`fit`), the rater's guesses of the tokens read and written and the tool calls (`read`, `write`, `steps`), for a hand-off the level its subagent ran at (`subLevel`), Claude's own subagents it moved to a cheaper model (`resized`), how a close call was decided (`tie`, also on each `resized` entry), the usage pace when it moved the thresholds (`pace`), mid-turn raises with their step and reason (`escalations`), main-chat requests (`requests`), the fixed context every request carried and what re-reading it cost (`fixed`), and its workflow calls (`workflows`, and `afterWorkflow` once one has run in the session). A rating that came to nothing is logged as an `overhead` line. Each of Claude's subagents it moved to a cheaper model gets a `subagent` line when it answers: its models, level, real cost and the raw estimates on its model and on the parent's. `/rightsize report` reads this file.
- `rightsize-switches.jsonl`: each measured effort switch, and whether the cache was kept.

## Limits

- **Workflows (ultracode).** When Claude runs a workflow, it fans the work out to many agents. Once rightsize sees one in a session, it stops handing work off for the rest of that session, and later turns teach calibration nothing and claim no saving, since a workflow keeps running in the background and its cost lands in later turns. It still rates prompts and changes effort. It can't see that ultracode is on until the first workflow runs. `/rightsize report` lists these turns on their own line.

- The app's effort picker does not move. The status line shows the level in use.
- The rating is an estimate from Haiku. Calibration corrects cost guesses, but it can't correct a wrong choice of model.
- Model facts (names, default effort levels, which models can switch effort mid-conversation) are built in for Claude Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 5.5. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to update them when models change.
- This is an independent project, not made or endorsed by Anthropic.

## Contributing

Improvements are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © 2026 Archi Dubey
