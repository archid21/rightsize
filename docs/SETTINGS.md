# Settings

Every row is a picker in `/config` (rightsize section). In a terminal session a change applies at once. In the desktop app there is no `/config` menu: change values from a terminal (`claude plugin configure rightsize@archid21 --values-stdin <<< '{"floor":"medium"}'`), then quit the app and reopen it. `/rightsize` opens the same list as a pane, and `/rightsize reset <key>` resets one row by its key.

**Mode** is the first row, **Routing**, **Hand-offs** and **Cache** turn one feature each on or off, **Ask before changing** makes every automatic move ask first, and **Band** says when the band shows. These six are the plain rows; `/rightsize` shows them above the rest. Every other row is titled "Advanced · ..." in `/config`; the names below leave that off. **Your setting wins:** a row you set always beats rightsize's own value for it. Budget pacing moves only the fixed bars, never a rule you set. Rows marked "not set" mean Ask before changing decides: off acts, on asks.

## One rule set

rightsize has one rule set and no profiles (the Quality, Balanced and Economy profiles of releases before 0.9 are gone; a stored Quality reads as Ask before changing on). These values are fixed; a value stored for a row an earlier release had (Hand-off threshold, Lowering threshold, Explore close calls, Pause after misses, Helper call cap, Rater check) is ignored. Question wait, Price check and Rater have no row in `/config` or in the pane and are not reset by `/rightsize reset`; their values are fixed too. A value an earlier release stored for one of them in `settings.json` is kept and used:

| | Fixed value | Row |
|---|---|---|
| Evidence for a cheaper route (hand-down, a Claude subagent moved down, lowering effort) | The rating says it fits; the kind of work pauses at 20% misses, with no minimum of logged tasks | none |
| Hand-off threshold: a helper must cost under this share of staying | 70% (85% while a usage window runs hot, 95% when nearly used up: Budget pacing) | none |
| Lowering threshold: a lower level must cost under this share of staying, counting the cache it may rewrite | 90% (97% hot, 100% nearly used up) | none |
| Close calls between two models that fit | The task-type guide decides; never explored | none |
| Helper call cap: the most tool calls a helper on a cheaper model may make for one task | 25 for Haiku, 40 for Sonnet; none for Opus and Fable | none |
| Rater check: Sonnet checks every Nth Haiku rating | every 20 | none |
| Rater: the model that rates each prompt (and each subagent brief), at low effort. A rating that times out, is refused or comes back unreadable is tried once more on Haiku | Sonnet (a stored haiku rates with Haiku, with a retry on Haiku) | none |
| Question wait: how long a question that must be answered before your prompt runs waits for you (Effort, Stronger and Subagent when a rule is ask; with Band set to off, or on the mobile app, every question). With no answer, rightsize takes the choice that changes nothing and costs nothing | 30 seconds (a stored 1 minute or 2 minutes is used) | none |
| Price check: compare prices.json with Anthropic's pricing page and update it. `/rightsize prices` checks right away | monthly, every 30 days (a stored off never checks) | none |
| Chances per task for a struggling helper | 2 | none |
| Before the cache goes cold, while the row is not set | Keep warm until your usual start (at most 8 hours; 9:00 until 5 days of data) | Before the cache goes cold |
| A review switched to Opus runs at most at | Highest effort | Highest effort |
| Lowering, Raising, Stronger model, Cheaper model, while not set | act without asking; with Ask before changing on, ask first | the four rule rows |

An "ask" answer opens its own timed dialog (it waits 30 seconds); every other answer acts without asking, and the band says what decided the first time each case comes up in a session. Every rating starts from rightsize's research priors (see [HOW-IT-DECIDES.md](HOW-IT-DECIDES.md)).

## Rows

### Mode

- Key: `mode`
- Options: act · watch only
- Default: act
- act (default): rightsize changes effort, switches reviews to Opus and hands work to helpers as your rules say. watch only: it rates and plans every prompt, applies nothing, and the band says what it would have done; /rightsize report sums what that would have saved. Use it for a week to see rightsize's calls on your own work before turning it on. rightsize saves the date (UTC) watch only was turned on. Seven full days later, at a turn end, one band row shows what the Saving check says rightsize would have saved, with three answers: **Turn on** (Mode becomes act), **Ask before changing** (Mode becomes act and Ask before changing goes on) and **Keep watching** (nothing changes). It shows once per watch-only period and never holds a prompt. With fewer than 20 rated prompts it says "Not enough turns yet to estimate" instead of a range. When you turn watch only off, the next turn end shows one summary row with the same range for the days it ran, unless you chose Turn on in that row. Turning watch only on again starts a new period.

### Routing

- Key: `routing`
- Options: on · off
- Default: on
- on (default): rightsize changes effort on your main chat (lowering for easy prompts, raising for hard ones, a session switch you pick), runs a review on Opus for one turn, and raises effort mid-turn when Claude looks stuck, as your rules say. off: none of those happen; your effort and model stay as you set them. With Routing and Hand-offs both off, rightsize rates no prompt and spends nothing on rating (the cache features still work). A row below that belongs to Routing, such as Raise when stuck, is then not used.

### Hand-offs

- Key: `handOffs`
- Options: on · off
- Default: on
- on (default): rightsize hands work to a helper subagent (a cheaper model for routine work, a stronger one for hard work) that your main chat briefs and checks, and runs Claude's own subagents on the cheapest model that fits. off: no hand-offs, and Claude's subagents stay on their model; when Routing is on, an effort change replaces the hand-off. With Routing and Hand-offs both off, rightsize rates no prompt and spends nothing on rating (the cache features still work).

### Ask before changing

- Key: `askFirst`
- Options: off · on
- Default: off
- off (default): rightsize lowers or raises effort, switches a review to Opus and hands work to a helper without asking, and the band says what it did. on: every move rightsize would make on its own asks first, in a timed dialog (it waits 30 seconds), and nothing changes until you answer. Either way an Advanced rule row you set (Lowering, Raising, Stronger model, Cheaper model) wins for its case. A Quality profile saved by an older release reads as on until you set this row.

### Cache

- Key: `cache`
- Options: on · off
- Default: on
- on (default): rightsize keeps an eye on the prompt cache: the offer to keep it warm, keep warm itself, a handoff or a compaction before it goes cold, and the idle warning when you return to a cold cache. off: none of those; a keep-warm run in progress stops at once. The rows Idle warning and Before the cache goes cold fine-tune it while Cache is on, and are not used while it is off.

### Band

- Key: `band`
- Options: when it acts · always · off
- Default: when it acts
- The row above the prompt that shows what rightsize did, with buttons to retry it at the original effort or run it on your model, and a ⋯ menu to change the rule, mark a hand-off or lowering 👍 or 👎 (kept on this machine), or change cache choices. when it acts: only when it changes something. always: on every rated prompt, no change included. off: status line only.

### Lowest effort

- Key: `floor`
- Options: low · medium · high
- Default: low
- The lowest effort level rightsize will lower to.

### Highest effort

- Key: `ceiling`
- Options: high · xhigh · max
- Default: max
- The highest effort level rightsize will raise to. It never goes above this: not when a prompt needs more, not mid-turn when Claude looks stuck (those also never reach max), and not for the subagent it hands work to, which runs at most at this level. A level you are already on above it is left alone: this stops raises, it never lowers.

### Lowering

- Key: `lowerRule`
- Options: ask me · lower automatically · never lower · not set
- Default: not set. Left at not set, Ask before changing decides.
- When a prompt needs less effort. ask me: ask each time. lower automatically: lower without asking. never lower: never. not set (the default): Ask before changing decides (off: done without asking; on: asked first), and the band says so the first time the case comes up in a session, with the other rules in its ⋯ menu. A rule set here is used as it is. The band's ⋯ menu and /rightsize settings set it too; set it back to not set to let Ask before changing decide again.

### Raising

- Key: `raiseRule`
- Options: ask me · raise automatically · never raise · not set
- Default: not set. Left at not set, Ask before changing decides.
- When a prompt needs more effort on the same model. ask me: ask each time. raise automatically: raise without asking. never raise: never. This rule also decides raises mid-turn when Claude looks stuck. not set (the default): Ask before changing decides (off: done without asking; on: asked first), and the band says so the first time the case comes up in a session, with the other rules in its ⋯ menu. A rule set here is used as it is. The band's ⋯ menu and /rightsize settings set it too; set it back to not set to let Ask before changing decide again.

### Stronger model

- Key: `upRule`
- Options: ask first · always send · stay, raise effort only · ask each time · not set
- Default: not set. Left at not set, Ask before changing decides.
- When a stronger model than yours would do better, or a review runs on Opus for one turn. ask first: ask before it. always send: do it without asking (the one exception is the switch from a Haiku session to Sonnet for debugging, features, refactors and writing, which always asks). stay, raise effort only: stay on your model and raise effort. ask each time: ask what to do each time. not set (the default): Ask before changing decides (off: done without asking; on: asked first), and the band says so the first time the case comes up in a session, with the other rules in its ⋯ menu. A rule set here is used as it is. The band's ⋯ menu and /rightsize settings set it too; set it back to not set to let Ask before changing decide again.

### Cheaper model

- Key: `downRule`
- Options: ask first · always send · stay, lower effort only · ask each time · not set
- Default: not set. Left at not set, Ask before changing decides.
- When a task could run on a cheaper model than yours. ask first: ask before sending it to a subagent on that model. always send: send it without asking. stay, lower effort only: stay on your model and lower effort. ask each time: ask what to do each time. not set (the default): Ask before changing decides (off: done without asking; on: asked first), and the band says so the first time the case comes up in a session, with the other rules in its ⋯ menu. A rule set here is used as it is. The band's ⋯ menu and /rightsize settings set it too; set it back to not set to let Ask before changing decide again.

### Remember choices

- Key: `remember`
- Options: ask · every session · this session
- Default: ask
- What happens to rules you set from the band's ⋯ menu or /rightsize settings. ask: after your first such rule, ask on the band whether to keep your rules in every session (the default). every session: keep every rule for later sessions, without asking. this session: never keep a rule and never ask; rules last until the session ends. A rule set in its row above is always kept.

### Use Haiku

- Key: `useHaiku`
- Options: on · off
- Default: on
- on: rightsize may hand work to Haiku, and move Claude's own subagents to it. off: it never does, and the starting-point comparison leaves Haiku out. Haiku still rates your prompts (it is the rater, not a worker), so this does not stop the rating calls.

### Use Fable

- Key: `useFable`
- Options: on · off
- Default: on
- on: rightsize may hand work to Fable when the work needs a stronger model. off: it never does, and the starting-point comparison leaves Fable out. If you work on Fable yourself, nothing changes.

### Claude's subagents

- Key: `subagents`
- Options: cheaper when it fits · off
- Default: cheaper when it fits
- cheaper when it fits: when Claude starts a general-purpose subagent without naming a model, rate its brief and run it on the cheapest weaker model that fits, at that model's level, under the hand-off threshold. off: leave Claude's own subagents on its model.

### Workflows

- Key: `workflows`
- Options: ask · pause rightsize · follow my rules · right-size every agent
- Default: ask
- What rightsize does once Claude starts a workflow (ultracode, or asked for): many helper agents at once, often 10 or more, each picking its own model. ask: ask on the band when the first workflow starts (the default); until you answer, rightsize pauses for it. pause rightsize: hand nothing off for the rest of the session, and leave the workflow's agents alone. follow my rules: hand-offs follow your Stronger model and Cheaper model rules as usual; the workflow's agents are left alone. right-size every agent: as follow my rules, and each workflow agent that names no model is rated by the Rater (one rating call each) and runs on the cheapest model that fits, under Claude's subagents, Use Haiku, Use Fable and the miss-rate pause (20%). Claude's subagents set to off keeps the agents alone in every case. Whichever you pick, measurement stays paused after a workflow: calibration learns nothing and no saving is claimed.

### Budget pacing

- Key: `pacing`
- Options: on · off
- Default: on
- on: on a subscription, move the hand-off and lowering bars by how fast the 5-hour and 7-day windows are being used. Running out early: hand off and lower more readily, and the band says which bars moved. Much left near a reset: nothing changes. Over 90% used: save all it can, which skips raises and stronger models while Raising and Stronger model are not set. A rule you set stays as you set it. off: always use the fixed bars (70% for hand-offs, 90% for lowering).

### Raise when stuck

- Key: `escalation`
- Options: on · off
- Default: on
- on: when a turn shows Claude is stuck (the same tool call failing twice, 3 of the last 10 tool calls failing with none of the 10 making progress (a `grep`, `rg`, `diff` or `test` that exits 1 found nothing, and a line of read-only lookups that missed a file: neither is a failed call), the same call running 3 times, a turn passing 3x the rated steps (at least 15) with no progress, or 2 fixes in a row leaving the tests red), raise effort one level for the rest of the turn, at most twice, never above Highest effort and never to max. It follows your Raising rule: automatic raises without asking, otherwise it asks on the band while the turn goes on. off: never raise mid-turn.

### Start suggestions

- Key: `startTips`
- Options: weekly · monthly · off
- Default: weekly
- weekly or monthly: every 7 or 30 days, estimate what the last 30 days of rated prompts would have cost from Sonnet and Opus at medium and high, rightsize's changes counted. Prompts Haiku's rating has often got wrong for a model count against that model's start. When another start is at least 15% cheaper (25% while it has few measured runs) without sending over 1 prompt in 10 to a stronger model, or when over 15% of prompts needed a stronger model or more effort, the band suggests switching with /model. rightsize never changes your model itself. off: no suggestions; /rightsize report still shows the comparison.

### Idle warning

- Key: `idleWarning`
- Options: over $0.10 · over $0.50 · over $1 · off
- Default: over $0.50
- When a session sat idle past the cache's life (1 hour, or 5 minutes when prices.json says 5m), the next prompt writes the whole conversation to the cache again. When that costs over this much more than a warm cache, the band notes the cost beside what rightsize did with the prompt (as a share of the 5-hour window on a subscription, once runs show the rate), and what /compact first would have cost. The prompt is never held. The same amount is the size bar for Before the cache goes cold.

### Before the cache goes cold

- Key: `beforeCold`
- Options: ask · keep warm 2 h · keep warm 8 h · keep warm until my usual start · save a handoff · compact · off
- Default: ask. The row shows ask until you set it; left alone, rightsize keeps warm until your usual start.
- What rightsize does when a session that ends a turn with a big conversation (a cold return would cost at least the Idle warning amount, $0.50 by default and while Idle warning is off, API-equivalent on a subscription) is about to lose its prompt cache. keep warm 2 h, keep warm 8 h, keep warm until my usual start (the time you usually send your first prompt, at most 8 hours): send one tiny request just before each expiry to keep the cache warm until then, with a status row on the band (Stop keeping warm; Don't keep warm again in ⋯), and stop when you type, press Stop, a request fails, or keeping warm would cost more than coming back cold. ask: offer the choices on the band 5 minutes after the turn, each with its cost, and do nothing if you do not pick. save a handoff: run whatsnext's wrap-up once before expiry (compact when whatsnext is not installed or not started in the project). compact: compact once before expiry (with whatsnext, using its instructions). off: nothing. Nothing runs during a turn. Not set here, rightsize keeps warm until your usual start.

### Reports

- Key: `billing`
- Options: api · subscription
- Default: api
- api: subagent reports show dollars. subscription: they show the share of usage and of the 5-hour window, with API-equivalent dollars beside it. rightsize reads this off each response's rate limits when they show it. A value set here is your answer: the rate limits never change it, and /rightsize says when they disagree.

### Long helpers

- Key: `longHelpers`
- Options: ask · continue while making progress · stop at the limit
- Default: ask
- A helper on a cheaper model (a hand-down, or a subagent rightsize moved) has a spend limit: 1.5, 2 or 3 times what the task is estimated to cost on your main model (1.5 for a task rated 10 tool calls or fewer, 2 for 11 to 30, 3 for more). This row says what happens at 80% of that limit when the helper is still finding new things.
- ask: a question on the band, without pausing the helper: Continue (one more block, the size of the first limit), Stop and report, or Always while it's making progress. With no answer by the limit, the helper stops and reports.
- continue while making progress: rightsize adds a block by itself, one at a time, up to 10 times the estimate; past that it asks, as in ask.
- stop at the limit: the helper is never extended.
- A helper that is stuck is stopped with no question, whatever this says. An extension does not use a retry of the task. With no estimate for the task, a flat cap of tool calls (25 for Haiku, 40 for Sonnet) applies instead.

### Output suggestion

- Key: `outputAdvice`
- Options: on · off
- Default: on
- on: once a session, when output is a large share of the cost (at least 25%, after 20 requests and $1.00 spent at list prices), rightsize asks whether to use the Concise output style. off: it never asks. This row does not change your output style. To use Concise in every project, set Output style to Concise in your Claude settings.
