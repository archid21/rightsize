# What rightsize touches

rightsize is a mod: it runs inside Claude Code and hooks some of its events. This is everything it does outside the chat. rightsize writes no file in your project itself (only Claude Code does, for the Output style row below), and none of its files is opened by rightsize: whatsnext's script answers instead.

## Hooks

- `prompt.submit`: rates the prompt (Sonnet by default), may change the effort level, and adds the hidden hand-off note. Your text is not changed. With **Mode** set to watch only, it rates and plans the prompt, logs the plan, and applies nothing.
- `turn.start`: matches a turn that is starting to the prompt it was rated for (by its text), so a prompt typed while another turn runs is measured in its own turn. It changes nothing.
- `turn.step`: watches each step to see when Claude is stuck and raises effort under your Raising rule.
- `agent.spawn`: passes the event on with `next(e)` and never denies. It changes only the `model` of a general-purpose subagent that names none, moving it to a cheaper model (see **Claude's subagents**).
- `tool.call`: passes every call on unchanged with `next(e)`. It notes whether each tool call failed and whether a test command passed or failed (for stuck turns and for the miss rate), and asks before a workflow starts, at each Workflow call until you answer. It denies four things:
  - steps only you can approve (shell commands that push, publish, release, deploy or merge; MCP tools whose action name starts with send, publish, deploy, merge or post) inside a hand-off helper;
  - the calls of a helper that was stopped and sent back to the main chat;
  - rework past the task's retry budget (the main chat then finishes the work);
  - the calls of a helper on a cheaper model once it has made its **Helper call cap** (25 for Haiku, 40 for Sonnet by default). The helper is sent back to the main chat.

  It never approves a call and never changes a permission decision anywhere else.
- `config.set`: passes every event on with `next(e)` and never denies. It ignores rows that are not its own, and watches its own `rightsize.*` rows in `/config`, to know which values you set. The write goes through as you made it.
- `turn.complete`: measures the turn. Before a big session's cache goes cold (see **Before the cache goes cold**), it may start a timer. The timer sends one small request through Claude Code over the same conversation, submits the prompt `wrap up` for whatsnext, or compacts the conversation (with whatsnext installed, using the instructions whatsnext prints; see **Programs it runs**). It lists the session's commands to find whatsnext. It starts nothing while a turn runs.
- `command.run` (`/rightsize`), `session.start` and `ui.render` (the band above the prompt) serve its own command, start-up and display.

The **Routing**, **Hand-offs** and **Cache** rows turn off the matching actions of these hooks: Routing the effort changes, the review switch and the mid-turn raises, Hand-offs the hand-off note and the move of Claude's subagents, Cache the keep-warm requests, the offer, the handoff or compaction and the idle warning. With Routing and Hand-offs both off, `prompt.submit` rates nothing and passes the prompt through.

## Settings it writes

Its own `rightsize.*` rows in `/config`: when you answer one of its questions, pick a rule in the band's ⋯ menu, choose "Don't keep warm again", or run `/rightsize reset`. The one other row is Claude Code's Output style: set to Concise, in the project's local settings, when you answer **This session** or **This project** to the Concise question; **This session** sets it back when the session ends. It never writes the permission mode or any other setting, and it sets no environment variables.

## Programs it runs

Four programs for its logs, started by name with no shell. The only part of a command that changes is a path inside its own log folders.

- `mkdir -m 700 -p` and `chmod`, to create its log folders under `~/.claude/mods-logs` and make them readable by you alone (folders 700, files 600).
- `rm -f` and `rmdir` on a session's folder inside `~/.claude/mods-logs/rightsize/` once nothing in it has changed for 45 days (never the current session's).

With whatsnext installed it starts two more, only to compact: `git rev-parse --show-toplevel` (to find your project's folder; it prints a path) and `python3 <whatsnext's folder>/skills/whatsnext/scripts/whatsnext.py` (whatsnext's own script) with one fixed command: `compact-instructions --session <session ID> --json` (the text to compact with, whether a handoff should come first and whether the folder is a whatsnext project). It changes nothing, and rightsize writes no whatsnext file or setting. rightsize finds whatsnext's folder in Claude Code's list of installed plugins and never runs a script from anywhere else.

For the star ask (ADR 0039; see **Network**) it starts `gh api user/starred/<repo>` (at most once a session) and, only when you press **Star on GitHub**, `gh api -X PUT user/starred/<repo>`, where `<repo>` is `archid21/rightsize` or `archid21/whatsnext`. When starring fails it opens the repo page with `open` (macOS) or `xdg-open` (Linux).

It starts no other program, and fetches no code.

## Prompts it submits

One, and only one fixed text: `wrap up`, submitted once before a big session's cache goes cold, when **Before the cache goes cold** is set to save a handoff and whatsnext is installed and started in the project. When whatsnext wants a handoff before a compaction, the same `wrap up` is submitted once for that. The keep-warm request is the fixed text `Reply with the single word OK.`, sent through Claude Code over the same conversation, and the compaction is Claude Code's own `/compact` (with whatsnext installed and started in the project, run with the instructions whatsnext printed). rightsize never submits text taken from your conversation. Two band buttons only put text in the prompt box for you to send yourself: your last prompt again (Retry, Run on your model) and `/model sonnet` (the start suggestion).

## Files it writes

- The logs listed below.
- Its own store in Claude Code's plugin store (your answers, calibration, counters, and the lifetime roll-up of the report: sums of cost and saving for runs older than 30 days, no prompt text), `~/.claude/plugins/store/rightsize_*.json`.
- `prices.json` in its own plugin folder, keeping the old file as `prices.json.bak` (the monthly price check).
- `~/.config/archid21/stars.json`, shared with whatsnext: which of the two plugins are installed, which repos you starred, when you answered the star ask, and which plugin is asking now. No prompt text, no usage.

These are all the places it writes. rightsize writes no file in your project itself (only Claude Code does, for the Output style row below), and none of its files is opened by rightsize: it only checks that `.whatsnext/config.json` exists, the sign that whatsnext was started there.

## What it reads

Your prompt, the session's usage and rate limits, your `model` and `effortLevel` settings, its own `/config` rows, and three environment variables (the `HOME` variable, to place its logs, `CLAUDE_CONFIG_DIR` where Claude Code keeps its folder, and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`), to rate and price each turn. With whatsnext installed it also reads Claude Code's list of installed plugins (`installed_plugins.json` in Claude Code's folder) to find whatsnext's folder. With trim installed, `/rightsize report` also reads trim's two savings files, `savings.jsonl` and `savings-totals.json` in `~/.claude/trim` (or the folder `TRIM_HOME` names), read only: it never writes, prunes or creates them. For each tool call in a turn it reads the tool, its arguments and whether it failed, to spot a stuck turn, a blocked step or a failing test run. It reads no credentials (no API key, token, keychain or sign-in file): model calls go through Claude Code with your existing sign-in. From Claude Code's settings it reads `model`, `effortLevel` and its own `pluginConfigs` rows.

## Network

It makes one web request of its own and one through `gh`, plus the Sonnet and Haiku calls Claude Code makes for it:

- `https://platform.claude.com/docs/en/about-claude/pricing.md`, Anthropic's pricing page, a plain GET every 30 days (**Price check**, can be turned off). It sends nothing of yours.
- GitHub, through your own `gh` sign-in: whether you starred rightsize (and whatsnext, when installed), at most once a session, only after rightsize has saved you something, and never again once you answer the star ask. **Stop tips** stops it too.

It sends nothing to its author: no analytics, no feedback upload. [PRIVACY.md](PRIVACY.md) has the detail. rightsize makes no request while Claude Code's `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set.

## Logs

Each session writes its own folder, `~/.claude/mods-logs/rightsize/<session ID>/`, and no other session writes to it. Two sessions running at once never overwrite each other's lines. `/rightsize report`, the start suggestion and the miss rates read every session's folder together. A folder whose files have all gone unchanged for 45 days is removed when a session starts. Logs that older versions wrote to `~/.claude/mods-logs/rightsize-runs.jsonl` and `rightsize-switches.jsonl` are still read, and no longer written. In each session's folder:

- `rightsize.log`: each decision.
- `runs.jsonl`: each rated turn, changed or not and stopped or not. Each line has an `id`, the session ID, the change made and the change suggested, the estimated and actual cost (and whether the actual cost came from the `ledger` or from `tokens`), the rating call's cost, the rate-limit windows before and after, the turn's duration and its subagent calls, each model's rated level (`fit`), whether the prompt carried on its task (`continues`) and, when it was planned as its task's type, the type the rater gave it (`ratedType`), tool errors from the environment (`blocked`), the rater's guesses of tokens read and written and tool calls (`read`, `write`, `steps`), for a hand-off the level its helper ran at (`subLevel`), Claude's own subagents it moved (`resized`), how a close call was decided (`tie`), the usage pace when it moved the bars (`pace`), mid-turn raises with their step and reason (`escalations`), main-chat requests (`requests`), the fixed context every request carried (`fixed`), and its workflow calls (`workflows`, and `afterWorkflow`). A turn's line carries its turn (`turnId`) and, when the prompt was typed while another turn was running, `queued`. The turn's duration (`durationMs`), how long the rating attempts took (`ratingMs`) and when the prompt was submitted (`submittedAt`) feed the report's Time section.
- Other lines in `runs.jsonl`: `unrated` (a prompt that could not be rated, with its `reason` and the rating calls' cost as `overhead`); `dropped` (something else in Claude Code refused a rated prompt) and `unbound` (it was delivered into a turn already running, or cancelled before it started); `check` (one per Sonnet spot-check: Haiku's `fit`, Sonnet's `fit` and Sonnet's cost); `feedback` (one per 👍 or 👎, with the run's `id` as `ref` and `value` up or down); `warm` (each keep-warm request: its model, the conversation's size, its task, its run and its cost as `overhead`); `warmSaved` (a return the keep-warm run earned and the cache proved, with what coming back cold would have cost as `saved`); `cold` (your answer, or none, to a keep-warm offer); `subagent` (each of Claude's subagents rightsize moved, when it answers). The report counts rating, check and keep-warm costs as rightsize's own cost.
- `switches.jsonl`: each measured effort switch, and whether the cache was kept.

To delete everything rightsize stored: see "Turn it off or remove it" in the [README](../README.md) and [PRIVACY.md](PRIVACY.md).
