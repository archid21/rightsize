# Contributing

Pull requests are welcome. Keep changes small, with one change per pull request.

## Check your change

You need Claude Code 2.1.287 or newer (`claude --version`). From the repository root, run:

```
claude plugin validate plugins/rightsize
claude plugin test plugins/rightsize
node scripts/check-settings.mjs
node scripts/check-plain-dollar.mjs
node scripts/check-features.mjs
```

All five must pass. `check-plain-dollar.mjs` lists any use of `$` (the hook's first parameter) that the Claude plugin directory's check would not read as plain, and any local name that hides a top-level function that takes `$`. It needs the `typescript` package, version 6 or older (`npm install --no-save typescript@5` in the repository root, or set `TYPESCRIPT_DIR` to a typescript folder). Add `--strict` to also list uses we only suspect. Add a test for any behaviour you change: `hooks/*.test.ts`, using `claude-code/testing`.

## Try it in a session

```
claude --plugin-dir plugins/rightsize
```

## Where things live

- `hooks/register.tsx`: the hooks, the four questions, the band above the prompt and the reports.
- `hooks/testkit.ts`: the shared helpers for the `register.*.test.ts` files, which are split by area so each stays small. It names its `$` parameters `ctx` so the directory does not read it as a hook file.
- `hooks/cost.ts`: the cost model, plans and calibration. These are pure functions, tested in `cost.test.ts`.
- `hooks/settings.ts`: the `/config` rows (title, options, default) and which of them are yours. A new row goes in `plugin.json`, in this table, in `applyOption` in `register.tsx`, in `docs/SETTINGS.md` and the `/config` list of `plugins/rightsize/README.md`, and gets a scenario in a `register.*.test.ts` file. Its title starts with `Advanced · ` (only the first five rows, Profile, Mode, Routing, Hand-offs and Cache, do not), and `docs/SETTINGS.md` and the plugin README list give the name without the prefix. `scripts/check-settings.mjs` fails until all of those agree.
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

Add a line to `CHANGELOG.md` and raise the version in both `plugins/rightsize/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`. Add or change the feature's row in `docs/FEATURES.md` with **Since** set to `Unreleased`; at release, follow the steps at the top of that file.
