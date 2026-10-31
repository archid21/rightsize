# rightsize

**Make your Claude plan go further, and keep Opus where it matters.**

rightsize is a Claude Code mod: a plugin that runs inside Claude Code and hooks its events. Before each prompt is sent, it rates how hard the work is, then runs it on the cheapest model and effort level (how hard Claude thinks) that will do it well. Reviews go to Opus, and routine work goes to a cheaper helper (a subagent) that your main chat briefs and checks. A band above the prompt shows what it did and what it saved, as a share of your usage window on a subscription.

Created by [Archi Dubey](https://github.com/archid21). MIT license. Feedback: [open an issue](https://github.com/archid21/rightsize/issues) or email [rightsize@aivalue.blog](mailto:rightsize@aivalue.blog).

![rightsize in Claude Code: it hands a refactor of Express's lib/ folder to a Sonnet subagent and reports the cost](docs/images/rightsize-demo.gif)

*One demo run in the [Express](https://github.com/expressjs/express) repository. rightsize's choice depends on the task, your model and your settings, so yours may differ.*

## Start here

1. Install. You need Claude Code 2.1.287 or newer (2.1.286 in the desktop app); rightsize states this and does not check it. In a terminal:

   ```bash
   claude plugin marketplace add archid21/rightsize
   claude plugin install rightsize@archid21 --scope user
   ```

   Or, inside a Claude Code session: `/plugin install rightsize --marketplace archid21/rightsize`.

2. Start a new session and type `/rightsize`. If the settings pane opens, it works.
3. If your session runs on an Opus start, the band shows a starting tip once: most work runs as well on **Sonnet 5.5 at medium** as on Opus. Reviews still run on Opus, and work Sonnet would struggle with goes to a stronger helper. Press **Switch: /model sonnet**; it puts the command in your prompt box and you press Enter. rightsize never changes your model itself.
4. Work as usual. The band says what rightsize did and why. Type `/rightsize report` after a few sessions to see what it saved.

That is the whole setup: Balanced is the default profile, and nothing holds your prompt. To see its calls on your own work before it changes anything, set **Mode** to watch only in `/config`.

## What you get

- **The right model and effort for each prompt.** A cheap rating (about one second, on Sonnet at low effort) says what kind of work it is and which models would do it well. rightsize lowers or raises effort on your model, or hands the work off, only when the estimate says it pays.
- **Opus where it matters.** A review runs on Opus at high effort or more for that one turn, then your chat goes back to your model. If Claude gets stuck mid-turn, rightsize raises effort for the rest of the turn.
- **Checked hand-offs.** When a cheaper model fits, the work goes to a helper on that model. Your main chat writes the brief with a "done means" list, checks the result against it, and sends it back for fixes if needed. Steps only you can approve (push, publish, deploy) stay in your chat.
- **A plan that lasts.** On a subscription it watches your 5-hour and weekly windows and saves harder when you run low. While you step away, it can keep a big session's prompt cache (the stored conversation that makes the next prompt cheap) warm, never at more than coming back cold would cost.
- **A report you can check.** `/rightsize report` shows what was kept, lowered, raised or handed off, what each saved against staying on your own model, how often its calls were wrong, and where the extra went when a task cost more than estimated.

## What it does not do

- It never changes your model for you. It suggests, and a review switch goes back after one turn.
- It never approves a tool call or changes a permission.
- It never sends your prompts, code or paths anywhere. Model calls go through Claude Code with your sign-in. Anonymous usage numbers are sent only if you turn Share on; the exact fields are in [docs/PRIVACY.md](docs/PRIVACY.md).

## Does it work?

Savings are estimates: the cost of the route rightsize chose, against its own estimate of staying on your model and effort, made when it chose and never changed afterward. A task that cost more than staying shows as a negative saving. On a subscription the figure is a share of your usage window, shown as a range; dollar amounts are what the same tokens would cost on the API, not your bill.

rightsize was tuned and tested on real tasks from open-source repositories with hidden tests, with the mod off and on. The method is in [docs/METHOD.md](docs/METHOD.md). Your own results depend on your work, your model and your settings. Judge it after a few sessions, not a few prompts, or run it in watch only mode first.

## It asks once

rightsize keeps questions off your prompt. What it asks, and when:

| When | What | Where |
|---|---|---|
| First session on an Opus start | A starting tip: `/model sonnet` or Not now | Band, two buttons |
| First time each case comes up (lowering, raising, a stronger model, a cheaper helper) | Nothing: your profile decides. The band says so once per session, for example "Your Balanced profile decided (Cheaper model); ⋯ changes it." The other rules are in ⋯ | Band |
| A big session ends and the cache is about to expire | Nothing: keeps warm as your profile says, with a Stop button | Band |
| A rule you set to "ask" | That question, before the prompt runs, with a 30-second wait | Dialog |
| Claude gets stuck, a workflow starts, or no rate limit shows how you pay | One question each, on the band; the work does not wait | Band |

Change any of it in `/config` (Profile and Mode first; the rest are Advanced) or with `/rightsize settings`, which still asks the four questions for anyone who prefers to set rules that way.

## Profiles

| | Quality | Balanced (default) | Economy |
|---|---|---|---|
| A cheaper route needs | Strong evidence from your own log | The rating says it fits | Fit alone |
| A hand-off must cost under | 50% of staying | 70% | 85% |
| Keep warm when you step away | 8 hours | Until your usual start time | Let it go cold |
| A review switched to Opus runs at most at | Highest effort | Highest effort | high effort |

Full table and every setting: [docs/SETTINGS.md](docs/SETTINGS.md).

## Commands

- `/rightsize` settings pane · `/rightsize status` · `/rightsize report` · `/rightsize help`
- `/rightsize retry` runs the last lowered prompt at normal effort · `/rightsize clear` drops a session switch
- `/rightsize settings` asks the four questions · `/rightsize reset` resets settings, measurements or both
- `/mods` turns the mod on or off

## How it decides

The rules in full, with every number and default: [docs/HOW-IT-DECIDES.md](docs/HOW-IT-DECIDES.md). The short version:

- Your setting wins. Anything automatic acts only on settings you left at their default.
- A hand-off needs a clear saving (under the profile's share of staying, counting the brief and the check) and a model the rating says fits. Reviews and writing never go to Haiku.
- Each route is scored against what happened: rework, step-ups, a failing test at the turn's end, a next prompt that corrects the reply, your 👍/👎 and spot-checks. A route that keeps missing is paused for that kind of work.
- Estimates are corrected from the real cost of every turn, per task type and route.

## Commands and settings

Every row below is a picker in `/config`. Every row except Profile and Mode is titled "Advanced · ..." there. Options and defaults are those of the plugin; the full text of each row is in [docs/SETTINGS.md](docs/SETTINGS.md).

- **Profile** (Quality, Balanced or Economy, default Balanced): how much evidence a cheaper route needs, and what the four cases do while their rows are not set.
- **Mode** (act or watch only, default act): watch only rates and plans every prompt, applies nothing, and the band and report say what it would have done.
- **Lowest effort** (low, medium or high, default low): how far rightsize lowers effort.
- **Highest effort** (high, xhigh or max, default max): the most it raises to, for a prompt, mid-turn and for a helper.
- **Lowering** (ask me, lower automatically, never lower or not set, default not set): the rule for a prompt that needs less effort. Not set: your profile decides.
- **Raising** (ask me, raise automatically, never raise or not set, default not set): the rule for more effort on the same model, including mid-turn.
- **Stronger model** (ask first, always send, stay, raise effort only, ask each time or not set, default not set): the rule for a stronger model, including a review switch.
- **Cheaper model** (ask first, always send, stay, lower effort only, ask each time or not set, default not set): the rule for a hand-off to a cheaper model.
- **Remember choices** (ask, every session or this session, default ask): whether rules you set from the band or `/rightsize settings` last past the session.
- **Hand-off threshold** (50% to 90%, default 70%): a helper must cost under this share of staying; left alone, your profile sets it.
- **Lowering threshold** (70% to 95%, default 90%): a lower effort level must cost under this share of staying.
- **Use Haiku** (on or off, default on): whether work may go to Haiku. Haiku still rates prompts.
- **Use Fable** (on or off, default on): whether work may go to Fable.
- **Claude's subagents** (cheaper when it fits or off, default cheaper when it fits): whether helpers Claude starts without a model move to a cheaper one.
- **Workflows** (ask, pause rightsize, follow my rules or right-size every agent, default ask): what rightsize does once Claude starts a workflow.
- **Explore close calls** (on or off, default off): whether one close call in five takes the other model so both get measured.
- **Pause after misses** (off, 20%, 30%, 40% or 50%): the miss rate at which a kind of work stops going down to a model; left alone, your profile sets it.
- **Budget pacing** (on or off, default on): on a subscription, moves the bars by how fast your windows are used.
- **Raise when stuck** (on or off, default on): raises effort one level for the rest of a turn when Claude looks stuck.
- **Stuck sensitivity** (relaxed, normal or sensitive, default normal): how soon Claude counts as stuck.
- **Rater** (sonnet or haiku, default sonnet): the model that rates each prompt.
- **Rater check** (every 25, every 50, every 100 or off): how often Sonnet re-rates a Haiku rating; left alone, your profile sets it.
- **Start suggestions** (weekly, monthly or off, default weekly): the log-based suggestion of a better starting model.
- **Idle warning** (over $0.10, over $0.50, over $1 or off, default over $0.50): the bar for noting the cost of a cold cache on the band.
- **Before the cache goes cold** (ask, keep warm 2 h, keep warm 8 h, keep warm until my usual start, save a handoff, compact or off): what happens when a big session ends a turn; left alone, your profile decides.
- **Reports** (api or subscription, default api): dollars, or a share of usage.
- **Band** (when it acts, always or off, default when it acts): when the band shows.
- **Question wait** (30 seconds, 1 minute or 2 minutes, default 30 seconds): how long a dialog waits for an answer.
- **Share anonymous feedback** (off or on, default off): send anonymous numbers to the author; rightsize never asks.
- **Price check** (monthly or off, default monthly): refresh `prices.json` from Anthropic's pricing page.

## What it touches

Hooks on prompt submit, turn start, turn step, tool call, agent spawn and turn complete. Its own `/config` rows. Logs under `~/.claude/mods-logs/rightsize/`, readable by you alone. `prices.json` in its own folder, refreshed from Anthropic's pricing page every 30 days. Nothing in your project. Details: [docs/WHAT-IT-TOUCHES.md](docs/WHAT-IT-TOUCHES.md).

## Privacy

Logs stay on your machine. Nothing is sent to the author unless you turn **Share anonymous feedback** on. What is sent, what is not, and how to delete it: [docs/PRIVACY.md](docs/PRIVACY.md).

## Turn it off or remove it

- `/mods` pauses it. `claude plugin disable rightsize@archid21` keeps your settings and what it learned.
- `claude plugin uninstall rightsize@archid21` removes it. `rm -r ~/.claude/plugins/store/rightsize_*.json ~/.claude/mods-logs/rightsize*` deletes its data. If Share was on, copy your install ID from `/rightsize status` first; see [docs/PRIVACY.md](docs/PRIVACY.md).

## Update

```bash
claude plugin update rightsize@archid21
```

Or turn on auto-update in `/plugin`. `claude plugin marketplace update` alone does not update the plugin.

## Limits

- The effort picker in the app does not move; the status line shows the level in use.
- The rating is a model's estimate. Calibration corrects costs, not a wrong choice of model; the miss tracking catches that over time, not on the first try.
- Hand-offs usually take longer than staying on your model, because the helper adds a brief and a check. The band says so, and the report's Time section compares them.
- This is an independent project, not made or endorsed by Anthropic.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © 2026 Archi Dubey
