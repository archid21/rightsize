# rightsize

**Opus where it counts. rightsize everywhere else.**

rightsize is a Claude Code plugin that picks the model and effort level for every prompt. Routine work runs on Sonnet, and reviews switch up to Opus for one turn. On our coding benchmark it matched Opus at roughly 30% less cost.

![rightsize in Claude Code: a routine edit stays on Sonnet, a review switches to Opus for one turn, and the band shows what each cost](docs/images/rightsize-demo.gif)

```bash
claude plugin marketplace add archid21/rightsize
claude plugin install rightsize@archid21 --scope user
```

MIT license · works with a Claude subscription (Pro, Max, Ultra) or an API key · [Open an issue](https://github.com/archid21/rightsize/issues)

---

## The problem: one model for every prompt

Claude Code runs every prompt on the model you picked, at the effort you picked. So you pay one of two prices:

- **Opus on everything.** Renaming a variable costs as much as reviewing a pull request. On Pro you hit your 5-hour limit before lunch; on Max and Ultra you still run into the weekly cap.
- **Sonnet on everything.** Your usage lasts, but the work that needs Opus most, reviews and hard bugs, gets a weaker answer.

Switching by hand with `/model` works until you forget, which is most of the time.

## What you get

**Opus results, without Opus prices.** Before each prompt runs, a quick rating decides what kind of work it is. Routine work stays on Sonnet. Reviews switch to Opus at high effort for that one turn, then your chat goes back.

**More from your plan.** On Pro, Max and Ultra, rightsize watches your usage windows (weekly, and 5-hour where your plan has one) and saves harder as you run low. Opus allowance goes to the work that needs it.

**Big routine jobs, done cheaper.** Working on Opus? A large, mechanical job such as the same edit across many files can go to a Haiku helper. Your main chat writes the brief, checks the result against it, and sends it back if anything is off. On our benchmark these hand-offs passed as often as Opus at a bit under half the cost. rightsize hands off only when the brief and the check still leave a saving, so from a Sonnet session it never does.

**Come back to a warm session.** A long session is cheap only while its prompt cache (the stored copy of your conversation) is warm. Step away past the cache's hour and your next prompt pays to rebuild it. rightsize keeps a big session warm while you are away, for as long as your profile says, and never past the point where coming back cold would be cheaper.

| Coming back to a 150k-token Opus session | Cost at API prices |
|---|---|
| Cold: the conversation is written to the cache again | About $1.20 |
| Kept warm for 8 hours: one cheap cache read per hour | About $0.25 |

On a subscription, the rebuild doesn't eat into your usage window. The band shows `Warm until 8:30 · $0.00 so far`, with a Stop button.

**Cost you can see.** A band above the prompt says what rightsize did and why. `/rightsize report` shows what each choice cost against staying on your own model, including the times it cost more.

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

Want to watch first? In `/config`, set **Mode** to watch only.

## How it works

1. **Rate.** When you send a prompt, a hook asks Sonnet at low effort what kind of work it is and which models would do it well. This takes about a second.
2. **Route.** rightsize keeps the prompt on your model, changes the effort level, switches to Opus for one turn, or hands the work to a helper subagent on a cheaper model. It acts only when its estimate says the choice pays.
3. **Check.** After the turn it records what happened: rework, a failing test, a reply you correct, your 👍 or 👎. A route that keeps missing for a kind of work is paused for that kind of work.

**What leaves your machine.** Nothing goes to the author or to any third party. The rating runs through Claude Code with your own sign-in, like any other prompt. Logs stay in `~/.claude/mods-logs/rightsize/`. rightsize's only web request is a monthly fetch of Anthropic's pricing page (**Price check**, can be turned off): [docs/PRIVACY.md](docs/PRIVACY.md).

**What it costs to run.** Each rating adds about one second and a small Sonnet call before the prompt. The report counts that cost against the savings, so the totals you see are after rightsize's own cost.

**What it never does.** It never changes your model for you, never approves a tool call, never changes a permission, and never touches your project files. Hooks and file paths: [docs/WHAT-IT-TOUCHES.md](docs/WHAT-IT-TOUCHES.md).

**What it runs, writes and sends.** It runs only `mkdir`, `chmod`, `rm` and `rmdir`, on its own log folders. It writes only under `~/.claude/mods-logs/rightsize/`, its own store, and its own `prices.json`. Its only web request is to `platform.claude.com` (Anthropic's pricing page, monthly, sends nothing of yours); it sends nothing to the author. It sets only its own `rightsize.*` settings, submits only the fixed text `wrap up`, reads no credential, and its `tool.call` hook only ever denies, never approves. The full list, checked against the code: [What it runs, writes and sends](plugins/rightsize/README.md#what-it-runs-writes-and-sends).

## Make it yours

Pick a profile in `/config`. Balanced is the default.

| | Quality | Balanced | Economy |
|---|---|---|---|
| Moves to a cheaper model when | Your own log shows it works | The rating says it fits | It fits at all |
| Reviews on Opus | Yes, highest effort | Yes, highest effort | Stays, raises effort only |
| Keeps the cache warm while you're away | 8 hours | Until your usual start time | No |

**Recipes**

- **Opus reviews, but no helper subagents:** set **Hand-offs** to off.
- **Just effort, no model changes:** set **Stronger model** to stay and **Cheaper model** to stay.
- **Ask before anything changes:** set **Profile** to Quality, or set any of the four rules to ask me.

**Routing**, **Hand-offs** and **Cache** each turn one feature off. Every setting, with its options and default: [docs/SETTINGS.md](docs/SETTINGS.md). Every rule and number: [docs/HOW-IT-DECIDES.md](docs/HOW-IT-DECIDES.md).

## Commands

| Command | What it does |
|---|---|
| `/rightsize` | Settings pane |
| `/rightsize report` | What each choice cost and saved |
| `/rightsize status` | Your profile and the settings you changed |
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

- The rating is a model's estimate. It can be wrong on a single prompt; miss tracking corrects it over time.
- Hand-offs take longer than staying, because the helper adds a brief and a check. The band says so.
- If you already use Sonnet for everything, rightsize costs more than you pay now. What you get for it is Opus on reviews.
- The effort picker in the app does not move; the status line shows the level in use.

## Get involved

- ⭐ [Star the repo](https://github.com/archid21/rightsize) if it saves you usage.
- Found a bad call? [Open an issue](https://github.com/archid21/rightsize/issues) with the band text and `/rightsize status`.
- Using it, and want to say how it went? [Send feedback](https://github.com/archid21/rightsize/issues/new?template=feedback.md): what you use, what it did well or got wrong, and optionally your `/rightsize report`.
- Pull requests are welcome: [CONTRIBUTING.md](CONTRIBUTING.md).

Made by [Archi Dubey](https://github.com/archid21). An independent project, not made or endorsed by Anthropic. [MIT](LICENSE) © 2026.
