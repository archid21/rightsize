# Features

Every rightsize feature: how it works and what it gives you.

Current release: 0.10.1

**Since** is the release that added the feature. `Unreleased` means it is on `main` but not in a release yet. Every setting, with its options: [SETTINGS.md](SETTINGS.md). Every rule and number: [HOW-IT-DECIDES.md](HOW-IT-DECIDES.md).

## Update this file at each release

1. Add a row for each new feature, with **Since** set to `Unreleased`, when the feature lands. Change a row when a release changes how its feature works; remove the row when the feature is removed.
2. At release, change every `Unreleased` to the new version (for example `0.11`), and set `Current release:` above to the version in `plugins/rightsize/.claude-plugin/plugin.json`.
3. In the root `README.md`, update the `**Status:**` line under the install block and replace the `New in` section with this release's main changes.
4. Run `node scripts/check-features.mjs`. It fails when `Current release:` is not the plugin version, when a row does not have four filled cells, or when a release is out and `Unreleased` rows are left.

## Routing

| Feature | How it works | Value | Since |
|---|---|---|---|
| Prompt rating | Before each prompt runs, a hook asks Sonnet at low effort what kind of work it is, how hard its hardest step is, and which models at which effort would do it well. A failed or unreadable rating is tried once on Haiku; a prompt that still has no rating is left alone. **Rater** picks Sonnet or Haiku. | Every routing choice starts from what the prompt needs, for about one second and a small call. | 0.4 (Sonnet rater: 0.8) |
| Cost model | Prices each route from `prices.json`: input, output and thinking, cache reads and writes, the cost of an effort switch, and a helper's brief, check and rework. Estimates scale by the work each model does at each effort. | rightsize changes something only when its estimate says the change pays. | 0.4 |
| Model and effort together | The rating gives each model its own level, and the cheapest model and level that fits wins. | Work that needs Opus at high can go to a cheaper model at high, not only to a higher level on Opus. | 0.5 |
| Effort policy | On Opus or Fable every task but a review runs at low effort. On Sonnet a raise at prompt time needs a task rated high or more with 20 steps or more, and never for debugging. A lowered turn stays lowered for the whole turn. | Effort follows evidence: you stop paying for high effort that buys nothing. | 0.10 |
| Opus reviews | On a Sonnet start, a review switches the main chat to Opus at high effort for that one turn, then comes back. **Stronger model** sets ask first or always send. | Opus-grade reviews without switching models by hand. | 0.8 |
| Helper hand-offs | From an Opus or Fable session, routine work goes to a Haiku or Sonnet helper subagent when it costs under 70% of staying. The main chat writes a brief with a "Done means" check, checks the result and sends it back at most twice. The helper cannot push, publish, release, deploy or send, and stops at 25 (Haiku) or 40 (Sonnet) tool calls. | Big mechanical jobs cost less, and the main chat still checks the result. | 0.4 (call cap: 0.10) |
| Claude's own subagents | A general-purpose subagent Claude starts without naming a model has its brief rated and runs on the cheapest weaker model that fits. Its real cost is measured and learned from. | Subagents stop running on your most expensive model by default. | 0.5 |
| Workflow guard | When Claude starts a workflow (ultracode), **Workflows** decides: ask, pause rightsize, follow your rules, or right-size every agent. Measurement pauses after a workflow either way. | Many agents at once do not skew rightsize's choices or its learning. | 0.5 |
| Raise when stuck | When a turn shows Claude is stuck (the same call failing twice, 3 failed calls in a 10-call window with no progress, the same call 3 times, a long turn with no progress, or 2 fixes in a row that leave the tests red), effort goes up one level for the rest of the turn, at most twice, never to max. Searches that find nothing and permission denials do not count. | Extra effort is spent only where the turn shows it is needed. | 0.5 (failed fixes: 0.10) |
| Budget pacing | On a subscription, the hand-off and lowering bars move by how fast the 5-hour and 7-day windows are being used. Over 90% used, it saves all it can. | Your plan lasts until the reset when you run hot. | 0.5 |
| Start suggestions | Weekly or monthly, it compares what the last 30 days would have cost from other start models and efforts, and the band suggests a `/model` switch when another start is clearly cheaper. It never changes your model itself. | You learn which start model fits your work, from your own data. | 0.7 |

## Learning

| Feature | How it works | Value | Since |
|---|---|---|---|
| Calibration | Real token usage from each turn corrects the estimates per task type, per model and per model at each level. Sessions running at the same time are merged. | Estimates get closer to your own work over time. | 0.4 |
| Outcome tracking | Rework, a failing test, a reply you correct and your 👍 or 👎 score each route per kind of work and model. A route that misses on 20% of a kind of work is paused for that kind. | A model that keeps missing on, for example, reviews stops getting them until your outcomes say otherwise. | 0.7 |
| Rater check | Sonnet is the default rater and is not checked against itself. When Haiku rates (**Rater** set to haiku, or Haiku as the fallback after a failed Sonnet rating), Sonnet re-rates every 20th such prompt in the background, and Haiku's misses lower its trust per task type. | A cheaper rater is kept honest. | 0.7 |

## Cache and context

| Feature | How it works | Value | Since |
|---|---|---|---|
| Keep warm | Before the prompt cache expires, one tiny request keeps it warm until your usual start time (at most 8 hours). It stops when you type, press Stop, a request fails, or keeping warm would cost more than coming back cold. On a 5-minute cache it also runs inside a long turn. | Coming back to a big session does not pay to rebuild the cache. | 0.8 (inside a turn: Unreleased) |
| Before the cache goes cold | **Before the cache goes cold** picks keep warm, save a whatsnext handoff, compact, ask or off. When keeping warm over your usual idle time would cost at least 3 times a compact, it compacts instead. | The cheaper of keeping warm and compacting is chosen for you. | 0.8 |
| Cache life read, not assumed | The cache's life (5 minutes or 1 hour) is read from the session, not taken from `prices.json` alone. | Keep-warm timing and cold-return costs are right on API keys and subscriptions. | Unreleased |
| Idle warning | When a session sat idle past the cache's life, the band notes what the next prompt costs to rebuild the cache and what `/compact` first would have cost. The prompt is never held. | You see the cost of a cold return before it surprises you. | 0.5 |
| Context-size warning | When the conversation first reaches 40, 50, 60, 70, 80 or 90% of the window, the band says so with a **Compact now** button. It shows while keep warm runs too. | You compact before a long conversation gets expensive. | 0.9 |
| Compact before your 5-hour limit | Near the 5-hour limit, the band advises a compact while the cache is warm and says what it saves after the reset. | Less usage spent rebuilding the cache after a window reset. | 0.9 |
| Steps aside for idle compact | When Claude Code will compact an idle session on its own, rightsize does not keep that session warm. | No paying to keep warm a cache that is about to be thrown away. | 0.10 |
| Handoff before a compact | With whatsnext installed, rightsize asks it to `wrap up` before a compact and uses its compact text. It compacts only once no wrap-up is missing. | A compact keeps the details that matter. | 0.9 |
| Model version prices | `prices.json` has a row for each older model version, kept current by the price check. A main chat on an older version is priced by its row; a version with no row pauses rightsize. | Costs and keep-warm choices stay right on Opus 4.8 and other older models. | Unreleased |
| Price check | Monthly, rightsize compares `prices.json` with Anthropic's pricing page and updates it. `/rightsize prices` checks now. | Costs stay current without a new release. | 0.4 |

## Seeing and controlling it

| Feature | How it works | Value | Since |
|---|---|---|---|
| Band | A row above the prompt says what rightsize did and what it cost, with buttons to retry at the original effort or run on your model, and a ⋯ menu to change a rule or rate a choice. **Band** sets when it shows. | Every choice is visible and can be undone in one click. | 0.5 |
| Watch only | **Mode** set to watch only rates and plans every prompt and changes nothing; the band says what it would have done. | See rightsize's calls on your own work before it acts. | 0.8 |
| Cost report | `/rightsize report` shows what each choice cost and saved against staying on your model, for this session, today, 7 days, 30 days and lifetime, net of rating calls. It names fixed context such as MCP tools, memory files and SessionStart output. | Measured savings, including the times rightsize cost more. | 0.4 (lifetime: 0.10) |
| Switches and rules | **Routing**, **Hand-offs** and **Cache** each turn a feature off. **Ask before changing** makes every move ask first. Four Advanced rules (Lowering, Raising, Stronger model, Cheaper model) set ask, automatic or never per case. | One rule set, two switches: no profiles to tune. | 0.10 |
| Settings pane | `/rightsize` opens a settings pane; `/rightsize status` lists what is in use and what you changed; `/rightsize reset` gives a reset you can paste. | Change every setting without editing files. | 0.8 |
| Short questions | A question that must be answered before the prompt runs waits 30 seconds by default, then takes the choice that changes nothing. Questions on the band do not hold up work. | rightsize never blocks you for long. | 0.8 |
| Local only | Logs stay in `~/.claude/mods-logs/rightsize/`. The only web request is the monthly price check. Nothing goes to the author. | Your prompts and usage stay on your machine. | 0.8.1 |
