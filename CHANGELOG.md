# Changelog

## Unreleased

- The monthly price check is claimed before the page is fetched, so two sessions starting at once check only once. A failed check gives the claim back and stays due.

## 0.4.0 (2026-10-23)

First public release, renamed from effort-advisor.

- Q1–Q4: lowering, raising, a stronger model and a cheaper model, each asked once and remembered on request.
- A cost model that counts cache reads and writes, output and thinking, the cache rewrite an effort switch may cause, and the brief, report, check and rework of a subagent.
- Calibration from the API's real token usage, per task type and route.
- Subagent hand-off through a hidden note beside the prompt, with a "Done means" check and at most 2 reworks.
- Monthly price check against Anthropic's pricing page; "check now" in `/config` and `/rightsize prices`.
- One log line per measured effort switch (`~/.claude/mods-logs/rightsize-switches.jsonl`), to learn whether Claude Code keeps the cache when effort changes.
