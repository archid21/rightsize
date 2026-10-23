# Changelog

## Unreleased

- Run log lines carry the rater's guesses behind each estimate (`read`, `write`, `steps`), so a bad guess can be told from a bad cost model.
- **Claude's own subagents.** When Claude starts a general-purpose subagent without naming a model, it would run on Claude's own model. rightsize now rates the subagent's brief with Haiku and runs it on the cheapest weaker model that fits, at that model's level, when that costs under the hand-off threshold. It never picks a stronger model, and it leaves alone subagents that name a model, other agent types (they may set their own), forks, workflow agents, resumes, teammates and subagents started by subagents. The band says so (`Ran Claude's subagent on Haiku (low) instead of Opus.`), and run log lines carry `resized`. **Claude's subagents** in `/config` turns it off.
- A hand-off now counts as taken when Claude's Agent call names the full model id (`claude-haiku-5-5`), not only the alias.
- **Workflow guard (ultracode).** Once Claude runs a workflow in a session, rightsize stops handing work off for the rest of that session, and turns from then on teach calibration nothing and claim no saving: a workflow runs on in the background, so its agents' cost lands in later turns too. Prompts are still rated and effort still changes. `/rightsize report` lists these turns on their own line; run log lines carry `workflows` and `afterWorkflow`.
- Main-chat calibration is kept per task type, per model and per model at each level, like hand-offs: expensive runs at high no longer move the estimate for low.
- **Model and effort together.** The rating gives each model's own level (or says it would struggle), and the cost model prices every model at its level. On Opus at medium, work Opus needs high for can go to Haiku at high instead of raising Opus. Of the cheaper models that fit, the cheapest route wins; the comparison counts the switch a raise would cost. Hand-downs no longer need the work rated "bulky": the cost decides. The older one-level rating still reads.
- The hand-off's subagent runs at the level its model needs: rightsize sets its effort on each of its requests, instead of relying on the note. Other subagents keep their own level.
- Hand-off calibration is kept per task type, per model and per model at each level; each finer key starts from the one above it.
- `rightsize-runs.jsonl` lines carry each model's rated level (`fit`) and a hand-off's real subagent level (`subLevel`).
- **Hand-off threshold** (default 70%) and **Lowering threshold** (default 90%) in `/config`: how much cheaper a subagent or a lower effort level must be before rightsize uses it. `/rightsize` shows the values in use.
- Calibration from sessions running at the same time is merged, not overwritten: each save adds its new runs to the stored record.
- A lowered turn that stepped back up no longer counts toward calibration, since part of it ran at the normal level.
- A band above the prompt (CLI and desktop app) shows what rightsize did, with buttons to undo it, clear a session switch, change the rule for that case, or close it. It also shows a hand-off's result, which no longer takes a transcript line. **Band** in `/config` (or ⋯ on the band) sets when it shows: when it acts (default), always, or off.
- Billing is read off each response's rate limits: five-hour and seven-day windows mean a subscription, a spend limit means a gateway. rightsize asks once only when they show nothing, and keeps the answer across sessions.
- Each turn's actual cost comes from the session's cost ledger (the `/cost` total), leaving out the Haiku rating call. Where there is no ledger, it prices the token counts from `prices.json`. Cache writes are priced at the 1-hour TTL by default.
- Every rated turn is logged to `rightsize-runs.jsonl` with its session, the change made and suggested, the rating call's cost, the rate-limit windows, its duration and its subagent calls.
- `/rightsize report`: prompts rated and changed, the saving net of rating calls, the share of the usage window it kept for subscribers, and what went wrong, for this session, 7 days and 30 days.
- The monthly price check is claimed before the page is fetched, so two sessions starting at once check only once. A failed check gives the claim back and stays due.

## 0.4.0 (2026-10-23)

First public release, renamed from effort-advisor.

- Q1–Q4: lowering, raising, a stronger model and a cheaper model, each asked once and remembered on request.
- A cost model that counts cache reads and writes, output and thinking, the cache rewrite an effort switch may cause, and the brief, report, check and rework of a subagent.
- Calibration from the API's real token usage, per task type and route.
- Subagent hand-off through a hidden note beside the prompt, with a "Done means" check and at most 2 reworks.
- Monthly price check against Anthropic's pricing page; "check now" in `/config` and `/rightsize prices`.
- One log line per measured effort switch (`~/.claude/mods-logs/rightsize-switches.jsonl`), to learn whether Claude Code keeps the cache when effort changes.
