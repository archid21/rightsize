# Changelog

## Unreleased

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
