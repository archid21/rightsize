# rightsize

**A Claude Code mod that picks the right effort level and model for each prompt, and counts the cost of every switch.**

Created by [Archi Dubey](https://github.com/archid21). MIT license.

Before a prompt is sent, rightsize makes one cheap Haiku call to rate it:
- for each model (Haiku, Sonnet, Opus, Fable), the lowest reasoning effort (`low` to `max`) at which it would do the work well, or that it would struggle
- how much the work reads, writes and how many steps it takes

A cost model then prices each model at its own level, using Anthropic's current prices, and picks the cheapest route that fits. That can change the model and the effort together: on Opus at medium, work that Opus needs high for may go to Haiku at high instead. rightsize does what you chose the first time each case came up: it lowers or raises effort, or hands the work to a subagent on another model, at that model's level, and has the main chat check the result.

## Install

You need Claude Code 2.1.287 or newer in the terminal, or 2.1.286 or newer in the desktop app (`claude --version`).

In Claude Code, run:

```
/plugin marketplace add archid21/rightsize
/plugin install rightsize@archid21
```

Pick the user scope so it loads in every session, then start a new session.

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
- **The subagent runs at the level its model needs.** rightsize sets the effort of the hand-off's subagent itself, so the level does not depend on Claude passing it on. Other subagents keep their own level.
- **Handing work down needs a clear saving.** A cheaper subagent is used only when its estimate is under 70% of the cost of staying at the level the work needs on your model (a raise counted with the cache it may rewrite), counting the brief, report, check and likely rework. Of the cheaper models that fit, the cheapest route wins. Because Sonnet costs half of Opus, an Opus-to-Sonnet hand-off rarely clears 70%. Hand-offs to Haiku, and hand-offs from Fable, clear it more often. Lowering effort needs the lower level to cost under 90% of staying, counting the cache it may rewrite. Both are defaults you can change in `/config`.
- **It learns from real costs.** After each rated turn, rightsize reads what the turn really cost from Claude Code's own cost ledger (the `/cost` total), which prices cache writes at the TTL they were written at. The Haiku rating call is left out. Where there is no ledger, it prices the API's token counts from `prices.json` instead. It moves its estimates toward that cost, for each task type and route, and for hand-offs also for each model and each model at each level. A model and level with few runs leans on what the task type as a whole has shown. After 20 runs, the measured average replaces the guess. A lowered turn that stepped back up is left out, since part of it ran at your normal level. Sessions running at the same time add to one shared record, so none overwrites another's runs.
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
  - How many prompts it rated and changed, and how often you kept your level.
  - The estimated saving after the cost of its own Haiku rating calls. Extra spending from raising effort or using stronger models is shown on its own line.
  - On a subscription, the share of your 5-hour (and 7-day) window that saving kept, and about how many more minutes that is at the current pace.
  - What went wrong: lowered turns that stepped back up, hand-offs that cost more or needed rework, hand-offs Claude skipped, effort switches that missed the cache, turns you stopped, and how far its estimates are off.

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
  - **Band**: when it acts (the default: only when rightsize changes something), always (every rated prompt, "No change" included), or off (status line only).
  - **Price check**: monthly, check now, or off.

## Logs

These are in `~/.claude/mods-logs/`:
- `rightsize.log`: each decision.
- `rightsize-runs.jsonl`: each rated turn, changed or not and stopped or not. Each line has the session ID, the change made and the change suggested, the estimated and actual cost (and whether the actual cost came from the `ledger` or from `tokens`), the rating call's cost, the rate-limit windows before and after, the turn's duration and its subagent calls, each model's rated level (`fit`) and, for a hand-off, the level its subagent ran at (`subLevel`). A rating that came to nothing is logged as an `overhead` line. `/rightsize report` reads this file.
- `rightsize-switches.jsonl`: each measured effort switch, and whether the cache was kept.

## Limits

- The app's effort picker does not move. The status line shows the level in use.
- The rating is an estimate from Haiku. Calibration corrects cost guesses, but it can't correct a wrong choice of model.
- Model facts (names, default effort levels, which models can switch effort mid-conversation) are built in for Claude Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 5.5. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to update them when models change.
- This is an independent project, not made or endorsed by Anthropic.

## Contributing

Improvements are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © 2026 Archi Dubey
