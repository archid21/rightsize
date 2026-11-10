<!-- whatsnext:start -->
Project map (start here): `docs/project/README.md`.
Record each decision as one ADR in `docs/decisions` (gitignored; private): copy the format of the latest `NNNN-*.md`, take the next number, and add a row to `docs/decisions/README.md`. Do not run `whatsnext decision new` here: it renumbers from ADR-0001 and overwrites the index.
Handoff note: `docs/project/HANDOFF.md`; overwrite it at wrap-up.
<!-- whatsnext:end -->

## Ground rules

- Show every time in Pacific time, next to any other time zone. Store times in UTC.
- Commit locally. Never push; we push to GitHub together. Ask first: deleting files (rm -rf), force push, deploys.
- Explain in simple words. Say what a technical term means the first time.
- Before you build, show the plan and wait for the user's OK, unless the user says otherwise.
- Ask decision questions one at a time as a pop-up, recommended option first.
- Scope: model, effort and cache are rightsize ("is this worth the tokens right now?"). Plan and handoff are whatsnext. What Claude reads or loads is trim.
- Never read or edit `.env` and `.env.*` files.
- Test: `claude plugin test plugins/rightsize`.
