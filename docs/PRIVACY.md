# Privacy

rightsize sends nothing to its author or to any third party. It keeps its logs on your machine.

## What rightsize sends

- **Nothing to the author, and nothing to any third party.** It has no analytics, no feedback upload and no account.
- **One web request of its own:** a plain GET of Anthropic's pricing page, `https://platform.claude.com/docs/en/about-claude/pricing.md`, every 30 days, to keep `prices.json` current. It carries nothing of yours. **Price check** set to off stops it, and rightsize sends nothing while Claude Code's `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set.
- **Model calls go through Claude Code,** with your own sign-in, to Anthropic, as your prompts do anyway (see "What the rating sees"). rightsize reads no credential.

## whatsnext

If whatsnext is installed, rightsize runs its script on your machine, found in Claude Code's list of installed plugins. One command: `compact-instructions --json` reads and prints; rightsize writes no whatsnext file or setting. Nothing goes to the author or any third party. whatsnext's own compacts go through Claude Code with your sign-in, like any other request.

## What stays on your machine

- The logs under `~/.claude/mods-logs/rightsize/` (readable by you alone) and rightsize's store in Claude Code's plugin store. They hold what rightsize decided and measured, and are listed in [WHAT-IT-TOUCHES.md](WHAT-IT-TOUCHES.md).
- Your answers to keep-warm offers (`cold` lines) and what keep warm saved on your returns (`warmSaved` lines). The `warmSaved` lines count toward the report's saving, as an estimate of what coming back cold would have cost; the `cold` lines carry no cost and are no part of any figure.
- The report's lifetime roll-up: sums of cost and saving for runs older than 30 days, in rightsize's store. No prompt text, no session or task ids. It stays in `~/.claude/plugins/store/`, outside any repository, so no git command picks it up.
- Your 👍 and 👎 (below).

## What the rating sees

To rate each prompt, rightsize asks Claude Sonnet (or Haiku, if you set **Rater** to haiku, or if Sonnet fails) through Claude Code. The rating call carries your prompt (the whole prompt, or its first 4,000 and last 2,000 characters when it is over 6,000), the end of Claude's last reply (up to 1,500 characters) and, while a task is in progress, the first 600 characters of the prompt that started it. It goes to Anthropic, just as your prompts do when you use Claude Code. When Claude starts its own helper, rightsize rates the helper's brief the same way. A spot-check (**Rater check**) sends a Haiku-rated prompt to Sonnet as well. None of this goes to rightsize's author.

## 👍 and 👎

You mark a hand-off or a lowering from the band's ⋯ menu (**Mark this 👍 (right call)**, **Mark this 👎 (wrong call)**). The mark is written to the run log on this machine, where it tunes rightsize's choices (a 👎 counts as a miss for that route, a 👍 as a hit). It is not sent anywhere.

## Telling the author

To give feedback, [open an issue](https://github.com/archid21/rightsize/issues/new?template=feedback.md). You choose what to write. `/rightsize report` can be pasted there; it may include your usage figures, so trim what you do not want public.

## Earlier versions

Versions 0.7.0 to 0.8.0 had an opt-in row, **Share anonymous feedback** (off by default), that sent anonymous numbers (task types, models, effort levels, costs, timings and a random install ID; never prompts, code or paths) to `feedback.aivalue.blog`. 0.8.1 removes the row and all of that code. If you had it on, data sent before you updated stays on the author's server until you ask for it to be deleted: email [hello@aivalue.blog](mailto:hello@aivalue.blog?subject=rightsize) (subject: rightsize) with your install ID, which is the `shareInstall` value in `~/.claude/plugins/store/rightsize_*.json`.

## Delete your data

After uninstalling, run `rm -r ~/.claude/plugins/store/rightsize_*.json ~/.claude/mods-logs/rightsize*`. Skip it if you might come back: reinstalling picks up the stored data where it left off.
