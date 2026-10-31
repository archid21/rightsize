# Privacy

rightsize keeps its logs on your machine. It sends nothing to its author unless you turn **Share anonymous feedback** on, and it never asks you to.

## What stays on your machine

- The logs under `~/.claude/mods-logs/rightsize/` (readable by you alone) and rightsize's store in Claude Code's plugin store. They hold what rightsize decided and measured, and are listed in [WHAT-IT-TOUCHES.md](WHAT-IT-TOUCHES.md).
- Your answers to keep-warm offers (`cold` lines) and what keep warm saved on your returns (`warmSaved` lines). These are never shared and are no part of any report figure.
- Your 👍 and 👎 (below).

## What the rating sees

To rate each prompt, rightsize asks Claude Sonnet (or Haiku, if you set **Rater** to haiku, or if Sonnet fails) through Claude Code. The rating call carries your prompt (the whole prompt, or its first 4,000 and last 2,000 characters when it is over 6,000), the end of Claude's last reply (up to 1,500 characters) and, while a task is in progress, the first 600 characters of the prompt that started it. It goes to Anthropic, just as your prompts do when you use Claude Code. When Claude starts its own helper, rightsize rates the helper's brief the same way. A spot-check (**Rater check**) sends a Haiku-rated prompt to Sonnet as well. None of this goes to rightsize's author.

## Share anonymous feedback

The row is off by default. rightsize never asks you to turn it on: the row in `/config`, `/rightsize status` and the footer of `/rightsize report` are where it shows. Turning it on sends anonymous numbers at most once an hour, only for what is logged after you turned it on. Turning it off stops all sending at once; turning it on again later starts a new install ID, so the old and new data cannot be linked. rightsize also sends nothing while Claude Code's `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set.

**What is sent.** In every batch: the rightsize version, whether you pay by API or subscription, and a random install ID that is not made from anything on your machine. For each rated prompt:

- the task type;
- the models and effort levels (rated, used and suggested), and the change made;
- the rater's guesses of tokens read and written and of tool calls;
- the conversation's size;
- the estimated and real cost, and the rating call's cost;
- how many helper calls and requests it took;
- whether it stepped back up, was raised mid-turn (a count, not the reason), was stopped, or ran after a workflow;
- how a close call was decided;
- how long the turn took, and how long its rating took, each as a number.

Also: each 👍 or 👎 as a number, linked to its prompt by a one-way code; and each Sonnet spot-check (the levels Haiku and Sonnet gave each model, and its cost). Each event carries the time it happened, and the server saves the time it received the batch.

**What is never sent:** your prompts, Claude's replies, code, file names, paths, tool and MCP server names, the reasons Claude got stuck, session IDs, or anything that names you. The server also rebuilds every event from a fixed list of fields and drops anything else.

**Where it goes.** To `feedback.aivalue.blog`, a server the author runs, kept in a private store that only the author can read. The numbers are used to tune rightsize's defaults, such as the hand-off threshold, the task-type guide and the estimates of work per model. Like any web server, it records the IP address each request comes from in its request logs, which the host (Vercel) keeps for a limited time; the IP address is not saved with the numbers.

## 👍 and 👎

You mark a hand-off or a lowering from the band's ⋯ menu (**Mark this 👍 (right call)**, **Mark this 👎 (wrong call)**). The mark is written to the run log on this machine, where it tunes rightsize's choices (a 👎 counts as a miss for that route, a 👍 as a hit). It is not sent anywhere unless Share is on, and then only as a number linked to its prompt by a one-way code, with no text.

## Delete your data

- **On your machine.** After uninstalling, run `rm -r ~/.claude/plugins/store/rightsize_*.json ~/.claude/mods-logs/rightsize*`. Skip it if you might come back: reinstalling picks up the stored data where it left off.
- **What was shared.** If Share was on, type `/rightsize status` and copy your install ID before you uninstall. Uninstalling stops all sending, but data already shared stays on the server until you ask for it to be deleted: email [rightsize@aivalue.blog](mailto:rightsize@aivalue.blog) with that ID. The same address answers questions about shared data.
