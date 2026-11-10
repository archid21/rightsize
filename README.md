# rightsize

**Make every Claude token count.**

rightsize sends each prompt to the cheapest model and effort that does the job, raises effort only when Claude is actually stuck, and keeps your cache and context from costing more than they should. No profiles, no tuning: one rule set, two switches.

```bash
claude plugin marketplace add archid21/rightsize
claude plugin install rightsize@archid21 --scope user
```

MIT license · works with a Claude subscription (Pro, Max, Ultra) or an API key · [Open an issue](https://github.com/archid21/rightsize/issues)

---

## Why use it

**Same outcome, lower cost from an Opus start.** Routine work goes to Haiku or Sonnet helpers and lower effort; Opus keeps the work that needs it. On our coding benchmark it matched Opus at up to 30% lower cost (API-equivalent).

**Effort follows evidence, not guesses.** A rating never raises effort on Opus or Fable at prompt time. Effort goes up mid-turn only when the turn shows trouble: repeated failures, a loop, or two fixes in a row that leave the tests red. You stop paying for high effort that buys nothing.

**Stronger reviews from a Sonnet start.** Reviews switch to Opus for that one turn and come back. You get Opus-grade review without switching models yourself. If your default is Sonnet you may spend more: on our coding benchmark, about 1.4x to 2x what Sonnet alone costs, almost all of it from reviews. Your cost depends on how many reviews you run.

**It learns which routes to trust.** Every hand-off, lowering, test run and thumbs rating scores the rater per kind of work and model. A model that misses on reviews stops getting reviews until your own outcomes say otherwise.

**Cut cache and compact costs.** Keeps the cache warm when that is cheaper than coming back cold, warns as your context fills, steps aside for Claude's idle compact, and compacts only when the saving beats the cost.

**rightsize works better with whatsnext.** rightsize decides when a compact pays. [whatsnext](https://github.com/archid21/whatsnext) decides what to keep: it saves a handoff note first, so a compact retains the details that matter. rightsize asks it for that handoff before the cache goes cold and uses its compact text for **Compact now**. rightsize works on its own too, and uses Claude's own compact when whatsnext isn't installed.

## The problem: one model for every prompt

Claude Code runs every prompt on the model you picked, at the effort you picked. So you pay one of two prices:

- **Opus on everything.** Renaming a variable costs as much as reviewing a pull request. On Pro you hit your 5-hour limit before lunch; on Max and Ultra you still run into the weekly cap.
- **Sonnet on everything.** Your usage lasts, but the work that needs Opus most, reviews and hard bugs, gets a weaker answer.

Switching by hand with `/model` works until you forget, which is most of the time.

## What you get

| Feature | What it delivers | How to use it |
|---|---|---|
| Smart routing | Routine work on cheaper models, Opus where it counts | Automatic. **Ask before changing** in `/config` makes it ask first. |
| Effort control | Lower effort for routine prompts; raised mid-turn only when Claude is stuck | Automatic. The **Lowering** and **Raising** rows set ask, automatic or never. |
| Cheaper helpers | Big routine edits handled at lower cost | Automatic from Opus or Fable sessions. Press **Run on your model** on the band to undo one. |
| Opus reviews | Stronger reviews without switching models | Automatic. The **Stronger model** row sets ask first or always send. |
| Watch only | See what rightsize would save before it changes anything | Set **Mode** to watch only, then run `/rightsize report` after a week. |
| Keep warm | Avoid paying to rewrite a cold cache | Set **Before the cache goes cold**, or pick a time when the band offers it. |
| Context-size warning | Compact before the conversation gets costly | Appears at 40–90% full. Press **Compact now**. |
| Compact before your 5-hour limit | Save usage after a window reset | Press **Compact now** when the band advises it. |
| Handoff before a compact ★ | A compact that retains the details that matter | Install whatsnext. rightsize asks it automatically, before the cache goes cold and before **Compact now**. |
| Cost report | Measured savings, spend and return rate | Run `/rightsize report`. |
| Band and settings | See and change every decision | Use the band's buttons and ⋯ menu, `/config`, or `/rightsize settings`. |

★ Needs whatsnext.

### Routing in action

Screenshots from a real session, with captions added.

**1. The first time, it asks what you want.** You stay in charge.

![Claude Code asking: When a task could run on a cheaper model than Opus, what should I do? Send it to a cheaper subagent (Recommended)](docs/images/1-asks-first.png)

**2. This task doesn't need Opus, so it goes to a Sonnet subagent.**

![rightsize band: Sending this to a Sonnet subagent at medium effort, using about 26% of the usage vs staying on Opus (estimated), with Ask first and Stay, lower effort only buttons](docs/images/2-hands-off.png)

**3. Done by Sonnet: $0.18 instead of about $2.41 on Opus (estimated).**

![rightsize band: Sent to Sonnet, used about 7% of the usage vs staying on Opus, API-equivalent $0.18 vs about $2.41 (estimated)](docs/images/3-result.png)

### The cache and compact bands

Each row sits above the prompt. The figures are examples; yours come from your own sessions and prices.

**In the desktop app,** the same rows are labelled and the buttons are drawn as buttons. This is a mock-up of the layout.

![Desktop app band with two rows: Prompt, Sent to Haiku, with a Run on Fable button; Cache, Context is 60% full, with a Compact now button](docs/images/band-desktop.png)

**In the terminal,** each row is one line with its buttons below.

**Keep warm offer.** The cache will go cold soon, and coming back would cost this much.

![Band row: Goes cold in 55 min (19:10), coming back after costs about $1.56, with a Keep warm 8 h button](docs/images/band-keep-warm-offer.png)

**Context-size warning.** The conversation reached the next step of the window.

![Band row: Context is 60% full (120K of 200K tokens), with a Compact now button](docs/images/band-context-warning.png)

**Advice to compact before your 5-hour limit.**

![Band row: Near your 5-hour limit, resets 21:40, Compact now to save about $0.59 after the reset, with a Compact now button](docs/images/band-limit-advice.png)

### See it run

A routine edit stays on Sonnet; a review switches to Opus for one turn; the band shows what each cost.

![rightsize in Claude Code: a routine edit stays on Sonnet, a review switches to Opus for one turn, and the band shows what each cost](docs/images/rightsize-demo.gif)

**Opus results, without Opus prices.** Before each prompt runs, a quick rating decides what kind of work it is. Routine work stays on Sonnet. Reviews switch to Opus at high effort for that one turn, then your chat goes back.

**More from your plan.** On Pro, Max and Ultra, rightsize watches your usage windows (weekly, and 5-hour where your plan has one) and saves harder as you run low. Opus allowance goes to the work that needs it.

**Big routine jobs, done cheaper.** Working on Opus? A large, mechanical job such as the same edit across many files can go to a Haiku helper. Your main chat writes the brief, checks the result against it, and sends it back if anything is off. On our benchmark these hand-offs passed as often as Opus at a bit under half the cost. rightsize hands off only when the brief and the check still leave a saving, so from a Sonnet session it never does.

**Come back to a warm session.** A long session is cheap only while its prompt cache (the stored copy of your conversation) is warm. Step away past the cache's life (an hour on a subscription, 5 minutes on an API key) and your next prompt pays to rebuild it. rightsize keeps a big session warm while you are away, until your usual start time, and never past the point where coming back cold would be cheaper. When keeping warm over your usual idle time would cost at least 3 times a compact, rightsize compacts instead.

| Coming back to a 150k-token Opus session | Cost at API prices |
|---|---|
| Cold: the conversation is written to the cache again | About $1.20 |
| Kept warm for 8 hours: one cheap cache read per hour | About $0.25 |

On a subscription, a keep-warm request draws a small share of your usage window, far less than rebuilding the cache; the band shows the running share. The band shows `Warm until 8:30 · ~0% used so far`, with a Stop button.

**Compact before it costs you.** As a conversation fills the window, the band says so at 40, 50, 60, 70, 80 and 90%, skipping any point where Claude Code would compact by itself. Near your 5-hour limit it advises a compact while the cache is warm. Nothing compacts until you press the button.

**Leave a thread cheaper to come back to.** Before the cache goes cold, rightsize can keep it warm, or save a whatsnext handoff and compact, whichever costs less. It acts only on the choice you made, and it never compacts a closed thread on its own.

**Cost you can see.** A band above the prompt says what rightsize did and why. `/rightsize report` shows what each choice cost against staying on your own model, including the times it cost more. The report also shows how many sessions came back to a cold cache and what a compact could have saved on each.

**Safe to try.** Watch-only mode rates every prompt and changes nothing, so you can see its calls on your own work first.

| | Opus on everything | Sonnet on everything | Sonnet + rightsize |
|---|---|---|---|
| Results on our benchmark | Baseline | Fewer tasks passed | Matched Opus |
| Cost | Highest | Lowest | About 30% less than Opus |
| Reviews | Opus | Sonnet | Opus, for that turn |
| Remembering to switch | You | You | rightsize |

*Benchmark: real tasks from open-source repositories, each graded by hidden tests the model never sees. Your results depend on your work and settings. Method: [docs/METHOD.md](docs/METHOD.md).*

## Quickstart

**You need** Claude Code 2.1.287 or newer (2.1.286 in the desktop app) and a Claude subscription or API key. Nothing else.

1. Install:

   ```bash
   claude plugin marketplace add archid21/rightsize
   claude plugin install rightsize@archid21 --scope user
   ```

2. Start a new session and type `/rightsize`. If the settings pane opens, it works.
3. On an Opus start, the band offers **Switch: /model sonnet** once. Press it, then Enter. rightsize never changes your model by itself.
4. Work as usual. After a few sessions, run `/rightsize report`.
5. Optional: install [whatsnext](https://github.com/archid21/whatsnext) for compacts that retain better information.

Want to watch first? In `/config`, set **Mode** to watch only.

## How it works

1. **Rate.** When you send a prompt, a hook asks Sonnet at low effort what kind of work it is and which models would do it well. This takes about a second.
2. **Route.** rightsize keeps the prompt on your model, changes the effort level, switches to Opus for one turn, or hands the work to a helper subagent on a cheaper model. It acts only when its estimate says the choice pays.
3. **Check.** After the turn it records what happened: rework, a failing test, a reply you correct, your 👍 or 👎. A route that keeps missing for a kind of work is paused for that kind of work.
4. **Watch the cache and context.** At the end of a turn, rightsize checks the conversation's size and how long the cache will live. It can keep the cache warm, warn that the context is filling, or advise a compact. It acts only when its estimate says the choice pays, and it compacts only when you press a button.

**What leaves your machine.** Nothing goes to the author or to any third party. The rating runs through Claude Code with your own sign-in, like any other prompt. Logs stay in `~/.claude/mods-logs/rightsize/`. rightsize's only web request is a monthly fetch of Anthropic's pricing page (**Price check**, can be turned off): [docs/PRIVACY.md](docs/PRIVACY.md).

**What it costs to run.** Each rating adds about one second and a small Sonnet call before the prompt. The report counts that cost against the savings, so the totals you see are after rightsize's own cost.

**What it never does.** It never changes your model for you, never approves a tool call, never changes a permission, and never touches your project files. Hooks and file paths: [docs/WHAT-IT-TOUCHES.md](docs/WHAT-IT-TOUCHES.md).

**What it runs, writes and sends.** It runs `mkdir`, `chmod`, `rm` and `rmdir` on its own log folders and, with whatsnext installed, `git rev-parse` and whatsnext's own script. The script's commands read what to compact and whether a handoff is missing; rightsize writes none of whatsnext's settings or files. It writes only under `~/.claude/mods-logs/rightsize/`, its own store, and its own `prices.json`. Its only web request is to `platform.claude.com` (Anthropic's pricing page, monthly, sends nothing of yours); it sends nothing to the author. It sets only its own `rightsize.*` settings, submits only the fixed text `wrap up`, reads no credential, and its `tool.call` hook only ever denies, never approves. The full list, checked against the code: [What it runs, writes and sends](plugins/rightsize/README.md#what-it-runs-writes-and-sends).

## Make it yours

One rule set, two switches. **Hand-offs** turns helper subagents off (effort still changes). **Ask before changing** makes every move ask first. The rest is fixed or has an Advanced row you can set.

| | Default | Row |
|---|---|---|
| Moves to a cheaper model when | The rating says it fits and the helper costs under 70% of staying | **Cheaper model** (the 70% bar is fixed) |
| Lowers effort when | Every prompt on Opus or Fable but a review runs at low; elsewhere when the rating says the lower level fits | **Lowering** |
| Reviews on Opus | Yes, highest effort | **Stronger model** |
| Keeps the cache warm while you're away | Until your usual start time | **Before the cache goes cold** |

When keeping warm over your usual idle time would cost at least 3 times a compact, keep warm becomes a compact instead. A **Before the cache goes cold** row you set yourself always wins.

**Recipes**

- **Opus reviews, but no helper subagents:** set **Hand-offs** to off.
- **Just effort, no model changes:** set **Stronger model** to stay and **Cheaper model** to stay.
- **Ask before anything changes:** set **Ask before changing** to on, or set any of the four rules to ask me.

**Routing**, **Hand-offs** and **Cache** each turn one feature off. Every setting, with its options and default: [docs/SETTINGS.md](docs/SETTINGS.md). Every rule and number: [docs/HOW-IT-DECIDES.md](docs/HOW-IT-DECIDES.md).

## Commands

| Command | What it does |
|---|---|
| `/rightsize` | Settings pane |
| `/rightsize report` | What each choice cost and saved |
| `/rightsize status` | What is in use and the settings you changed |
| `/rightsize retry` | Runs the last lowered prompt at normal effort |
| `/mods` | Turns rightsize on or off |

All commands: `/rightsize help`.

## Update, pause, remove

```bash
claude plugin update rightsize@archid21
```

- **Pause:** `/mods`, or `claude plugin disable rightsize@archid21` (keeps your settings).
- **Remove:** `claude plugin uninstall rightsize@archid21`, then `rm -r ~/.claude/plugins/store/rightsize_*.json ~/.claude/mods-logs/rightsize*` to delete its data.

## Limits

- **Older models are priced by their own row.** Haiku 5.5, Sonnet 5.5, Opus 5.5 and Fable 5.2 are each family's newest model. Older versions, such as Opus 4.8 or Fable 5.1, cost more, so `prices.json` holds a row for each version the pricing page lists, and rightsize prices a main chat on an older version by its row. An effort change there writes the whole conversation again, so it is priced that way. A version with no row pauses rightsize: the band says so once, and `/rightsize prices` fetches the current list.
- The rating is a model's estimate. It can be wrong on a single prompt; miss tracking corrects it over time.
- Hand-offs take longer than staying, because the helper adds a brief and a check. The band says so.
- If you already use Sonnet for everything, rightsize costs more than you pay now. What you get for it is Opus on reviews.
- Handoffs before a compact need whatsnext. Without it, rightsize uses Claude's own compact.
- rightsize compacts only the open session, and only when you press a button or set a row to compact. It does not compact closed threads.
- The effort picker in the app does not move; the status line shows the level in use.

## Get involved

- ⭐ [Star the repo](https://github.com/archid21/rightsize) if it saves you usage.
- Found a bad call? [Open an issue](https://github.com/archid21/rightsize/issues) with the band text and `/rightsize status`.
- Using it, and want to say how it went? [Send feedback](https://github.com/archid21/rightsize/issues/new?template=feedback.md): what you use, what it did well or got wrong, and optionally your `/rightsize report`.
- Pull requests are welcome: [CONTRIBUTING.md](CONTRIBUTING.md).

Made by [Archi Dubey](https://github.com/archid21). An independent project, not made or endorsed by Anthropic. [MIT](LICENSE) © 2026.
