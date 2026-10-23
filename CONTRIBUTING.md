# Contributing

Pull requests are welcome. Keep changes small, with one change per pull request.

## Check your change

You need Claude Code 2.1.287 or newer (`claude --version`). From the repository root, run:

```
claude plugin validate plugins/rightsize
claude plugin test plugins/rightsize
```

Both must pass. Add a test for any behaviour you change: `hooks/*.test.ts`, using `claude-code/testing`.

## Try it in a session

```
claude --plugin-dir plugins/rightsize
```

## Where things live

- `hooks/register.ts`: the hooks, the four questions and the reports.
- `hooks/cost.ts`: the cost model, plans and calibration. These are pure functions, tested in `cost.test.ts`.
- `hooks/rate.ts`: the Haiku rating prompt and its parser.
- `hooks/prices.ts`: the pricing-page parser and the monthly check.
- `prices.json`: the price table, in US dollars per 1M tokens.

## When Anthropic changes models or prices

Model facts are kept in two places for now:
- In `hooks/cost.ts`: `TIERS`, `DEFAULT_LEVEL`, `DEFAULT_PRICES` and `EFFORT_OUT`.
- In `hooks/prices.ts`: `ROW_NAME`, the names the pricing page uses.

When a new model replaces one of the four, update both. Check against these pages:
- https://platform.claude.com/docs/en/about-claude/pricing
- https://platform.claude.com/docs/en/about-claude/models/overview
- https://platform.claude.com/docs/en/build-with-claude/effort
- https://platform.claude.com/docs/en/build-with-claude/prompt-caching

Add a line to `CHANGELOG.md` and raise the version in both `plugins/rightsize/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`.
