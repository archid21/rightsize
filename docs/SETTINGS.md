# Settings

Every row is a picker in `/config` (rightsize section). In a terminal session a change applies at once. In the desktop app there is no `/config` menu: change values from a terminal (`claude plugin configure rightsize@archid21 --values-stdin <<< '{"handOff":"60%"}'`), then quit the app and reopen it. `/rightsize` opens the same list as a pane, and `/rightsize reset <key>` resets one row by its key.

**Profile** is the first row, **Mode** the second, and **Routing**, **Hand-offs** and **Cache** the third to fifth: each of these three turns one feature on or off. Every other row is titled "Advanced · ..." in `/config`; the names below leave that off. **Your setting wins:** a row you set always beats what your profile supplies for it, and automatic behavior (pacing, the profile) acts only on rows you left alone. Rows marked "not set" mean your profile decides.

## Profiles

| | Quality | Balanced (default) | Economy |
|---|---|---|---|
| Evidence for a cheaper route (hand-down, a Claude subagent moved down, lowering effort) | The rating says it fits, and at least 10 logged tasks of that kind on that route with under 10% misses | The rating says it fits; the kind of work pauses at 20% misses | The rating says it fits; the kind of work pauses at 30% misses |
| Hand-off threshold: a helper must cost under this share of staying | 50% | 70% | 85% |
| Rater check: Sonnet checks every Nth Haiku rating | every 10 | every 20 | every 30 |
| Chances per task for a struggling helper | 1 | 2 | 3 |
| Before the cache goes cold, while the row is not set | Keep warm for 8 hours | Keep warm until your usual start (at most 8 hours; 9:00 until 5 days of data) | Let it go cold |
| A review switched to Opus runs at most at | Highest effort | Highest effort | high effort |
| Lowering, while not set | ask me | lower automatically | lower automatically |
| Raising, while not set | raise automatically | raise automatically | raise automatically |
| Stronger model, while not set | always send | always send | stay, raise effort only |
| Cheaper model, while not set | ask first | always send | always send |

An "ask" answer opens its own timed dialog (see **Question wait**); every other answer acts without asking, and the band says what the profile decided the first time each case comes up in a session. A row you set under Advanced replaces what the profile supplies for it: Hand-off threshold, Pause after misses (it replaces the whole evidence rule, so Quality's 10 logged tasks go too), Rater check, Before the cache goes cold, and the four case rules. The chances and the review cap have no row, so they always follow the profile. Switching the profile applies at once. Every profile starts from rightsize's research priors (see [HOW-IT-DECIDES.md](HOW-IT-DECIDES.md)).

## Rows

### Profile

- Key: `profile`
- Options: Quality · Balanced · Economy
- Default: Balanced
- How much evidence rightsize needs before it picks a cheaper route, and what each of the four cases does while its rule row is not set (the profile decides; nothing asks). Quality: cheaper routes only with strong evidence (at least 10 logged tasks of that kind on that route, under 10% misses, and the route under 50% of staying), asks before lowering effort or using a cheaper model, gives a struggling helper 1 retry, keeps a big session's cache warm for 8 hours. Balanced (default): a cheaper route when the rating says it fits and it is under 70% of staying; pauses a kind of work at 20% misses; 2 retries; lowers, raises, switches and hands off without asking; keeps the cache warm until your usual start time (at most 8 hours). Economy: cheaper routes on fit alone, under 85% of staying, paused only at 30% misses; 3 retries; stays on your model and raises effort instead of a stronger model; reviews on Opus stop at high effort; lets the cache go cold. A profile also sets how often Sonnet checks Haiku's ratings (every 10, 20 or 30). Every Advanced row below is yours to set: a row you set always wins over the profile.

### Mode

- Key: `mode`
- Options: act · watch only
- Default: act
- act (default): rightsize changes effort, switches reviews to Opus and hands work to helpers as your profile and rules say. watch only: it rates and plans every prompt, applies nothing, and the band says what it would have done; /rightsize report sums what that would have saved. Use it for a week to see rightsize's calls on your own work before turning it on.

### Routing

- Key: `routing`
- Options: on · off
- Default: on
- on (default): rightsize changes effort on your main chat (lowering for easy prompts, raising for hard ones, a session switch you pick), runs a review on Opus for one turn, and raises effort mid-turn when Claude looks stuck, as your profile and rules say. off: none of those happen; your effort and model stay as you set them. With Routing and Hand-offs both off, rightsize rates no prompt and spends nothing on rating (the cache features still work). A row below that belongs to Routing, such as Raise when stuck, is then not used.

### Hand-offs

- Key: `handOffs`
- Options: on · off
- Default: on
- on (default): rightsize hands work to a helper subagent (a cheaper model for routine work, a stronger one for hard work) that your main chat briefs and checks, and runs Claude's own subagents on the cheapest model that fits. off: no hand-offs, and Claude's subagents stay on their model; when Routing is on, an effort change replaces the hand-off. With Routing and Hand-offs both off, rightsize rates no prompt and spends nothing on rating (the cache features still work).

### Cache

- Key: `cache`
- Options: on · off
- Default: on
- on (default): rightsize keeps an eye on the prompt cache: the offer to keep it warm, keep warm itself, a handoff or a compaction before it goes cold, and the idle warning when you return to a cold cache. off: none of those; a keep-warm run in progress stops at once. The rows Idle warning and Before the cache goes cold fine-tune it while Cache is on, and are not used while it is off.

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
- Default: not set. Left at not set, your Profile decides.
- When a prompt needs less effort. ask me: ask each time. lower automatically: lower without asking. never lower: never. not set (the default): your Profile decides, and the band says so the first time the case comes up in a session, with the other rules in its ⋯ menu. A rule set here is used as it is. The band's ⋯ menu and /rightsize settings set it too; set it back to not set to let the profile decide again.

### Raising

- Key: `raiseRule`
- Options: ask me · raise automatically · never raise · not set
- Default: not set. Left at not set, your Profile decides.
- When a prompt needs more effort on the same model. ask me: ask each time. raise automatically: raise without asking. never raise: never. This rule also decides raises mid-turn when Claude looks stuck. not set (the default): your Profile decides, and the band says so the first time the case comes up in a session, with the other rules in its ⋯ menu. A rule set here is used as it is. The band's ⋯ menu and /rightsize settings set it too; set it back to not set to let the profile decide again.

### Stronger model

- Key: `upRule`
- Options: ask first · always send · stay, raise effort only · ask each time · not set
- Default: not set. Left at not set, your Profile decides.
- When a stronger model than yours would do better, or a review runs on Opus for one turn. ask first: ask before it. always send: do it without asking. stay, raise effort only: stay on your model and raise effort. ask each time: ask what to do each time. not set (the default): your Profile decides, and the band says so the first time the case comes up in a session, with the other rules in its ⋯ menu. A rule set here is used as it is. The band's ⋯ menu and /rightsize settings set it too; set it back to not set to let the profile decide again.

### Cheaper model

- Key: `downRule`
- Options: ask first · always send · stay, lower effort only · ask each time · not set
- Default: not set. Left at not set, your Profile decides.
- When a task could run on a cheaper model than yours. ask first: ask before sending it to a subagent on that model. always send: send it without asking. stay, lower effort only: stay on your model and lower effort. ask each time: ask what to do each time. not set (the default): your Profile decides, and the band says so the first time the case comes up in a session, with the other rules in its ⋯ menu. A rule set here is used as it is. The band's ⋯ menu and /rightsize settings set it too; set it back to not set to let the profile decide again.

### Remember choices

- Key: `remember`
- Options: ask · every session · this session
- Default: ask
- What happens to rules you set from the band's ⋯ menu or /rightsize settings. ask: after your first such rule, ask on the band whether to keep your rules in every session (the default). every session: keep every rule for later sessions, without asking. this session: never keep a rule and never ask; rules last until the session ends. A rule set in its row above is always kept.

### Hand-off threshold

- Key: `handOff`
- Options: 50% · 60% · 70% · 80% · 90%
- Default: 70%. Stored default 70%. Left alone, your Profile sets the value (50%, 70% or 85%).
- Send a big task to a cheaper subagent only when it is estimated to cost under this share of staying on your model, counting the brief, check and likely rework. Lower is stricter. Left alone, your Profile sets it: Quality 50%, Balanced 70%, Economy 85%.

### Lowering threshold

- Key: `lowering`
- Options: 70% · 80% · 90% · 95%
- Default: 90%
- Lower effort only when the lower level is estimated to cost under this share of staying, counting the cache it may rewrite. Lower is stricter.

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
- What rightsize does once Claude starts a workflow (ultracode, or asked for): many helper agents at once, often 10 or more, each picking its own model. ask: ask on the band when the first workflow starts (the default); until you answer, rightsize pauses for it. pause rightsize: hand nothing off for the rest of the session, and leave the workflow's agents alone. follow my rules: hand-offs follow your Stronger model and Cheaper model rules as usual; the workflow's agents are left alone. right-size every agent: as follow my rules, and each workflow agent that names no model is rated by the Rater (one rating call each) and runs on the cheapest model that fits, under Claude's subagents, Use Haiku, Use Fable and Pause after misses. Claude's subagents set to off keeps the agents alone in every case. Whichever you pick, measurement stays paused after a workflow: calibration learns nothing and no saving is claimed.

### Explore close calls

- Key: `explore`
- Options: on · off
- Default: off
- on: when two models that fit cost about the same, rightsize picks by task type, and one close call in five takes the other model so both get measured. off (default): a close call always takes the task-type pick, so the other model may never be measured.

### Pause after misses

- Key: `missPause`
- Options: off · 20% · 30% · 40% · 50%
- Default: 30%. The row shows 30% until you set it. Left alone, your Profile sets the value (10%, 20% or 30%).
- The rating is scored against what happens: rework on hand-offs, lowered turns that stepped back up, mid-turn raises, a test run that failed at the turn's end, a next prompt that corrects the reply, your 👍 and 👎 (in the band's ⋯ menu), and Sonnet's checks. When the miss rate for a kind of work on a model reaches this share, rightsize stops handing that work down to that model and stops lowering effort on it, until the rate falls back under it. off: never pause. Left alone, your Profile sets it: Quality pauses at 10% misses and also needs at least 10 logged tasks of that kind on that model before it uses a cheaper route, Balanced pauses at 20%, Economy at 30%. A value you set here replaces the whole rule.

### Budget pacing

- Key: `pacing`
- Options: on · off
- Default: on
- on: on a subscription, move the thresholds by how fast the 5-hour and 7-day windows are being used. Running out early: hand off and lower more readily, and the band says which bars moved. Much left near a reset: nothing changes. Over 90% used: save all it can, which skips raises and stronger models while Raising and Stronger model are not set. A threshold or rule you set stays as you set it: pacing moves only what is left at its default. off: always use the thresholds above.

### Raise when stuck

- Key: `escalation`
- Options: on · off
- Default: on
- on: when a turn shows Claude is stuck (see Stuck sensitivity), raise effort one level for the rest of the turn, at most twice, never above Highest effort and never to max. It follows your Raising rule: automatic raises without asking, otherwise it asks on the band while the turn goes on. off: never raise mid-turn.

### Stuck sensitivity

- Key: `stuck`
- Options: relaxed · normal · sensitive
- Default: normal
- How soon Claude counts as stuck. normal: the same tool call failing twice, 3 tool calls failing, the same call running 3 times, or a turn passing 3x the rated steps (at least 15). relaxed: the same call failing 3 times, 4 calls failing, a call running 4 times, or 4x the steps (at least 20). sensitive: the same call failing twice, 2 calls failing, a call running twice, or 2x the steps (at least 10).

### Helper call cap

- Key: `helperCap`
- Options: tight · normal · loose · off
- Default: normal
- The most tool calls a helper on a cheaper model may make for one task, however well they go. normal: 25 for Haiku, 40 for Sonnet. tight: 15 and 25. loose: 40 and 60. off: no cap. At the cap the helper's next call is refused and it reports back; the main chat finishes the task, as for a helper that is struggling. Opus and Fable helpers have no cap.

### Rater

- Key: `rater`
- Options: sonnet · haiku
- Default: sonnet
- sonnet or haiku: the model that rates each prompt (and each subagent brief), at low effort. sonnet (default) reads prompts more reliably; haiku costs less per rating. With sonnet, a rating that times out, is refused or comes back unreadable is tried once more on Haiku; with haiku, a timeout or an unreadable answer is tried once more on Haiku.

### Rater check

- Key: `raterCheck`
- Options: every 25 · every 50 · every 100 · off
- Default: every 50. The row shows every 50 until you set it. Left alone, your Profile sets the value (every 10, 20 or 30).
- every 25, every 50 or every 100: on every that many prompts rated by Haiku (Rater set to haiku, or Sonnet failed), ask Sonnet in the background to rate the same prompt, and log where it says a model would struggle that Haiku said does the work. These checks and the other outcomes give a miss rate per task type and model (see Pause after misses). Each check costs one Sonnet call and never delays the prompt. off: no checks (the other outcomes still count). Left alone, your Profile sets it: every 10 (Quality), every 20 (Balanced) or every 30 (Economy).

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
- Default: ask. The row shows ask until you set it. Left alone, your Profile decides (Quality 8 hours, Balanced until your usual start, Economy cold).
- What rightsize does when a session that ends a turn with a big conversation (a cold return would cost at least the Idle warning amount, $0.50 by default and while Idle warning is off, API-equivalent on a subscription) is about to lose its prompt cache. keep warm 2 h, keep warm 8 h, keep warm until my usual start (the time you usually send your first prompt, at most 8 hours): send one tiny request just before each expiry to keep the cache warm until then, with a status row on the band (Stop keeping warm; Don't keep warm again in ⋯), and stop when you type, press Stop, a request fails, or keeping warm would cost more than coming back cold. ask: offer the choices on the band 5 minutes after the turn, each with its cost, and do nothing if you do not pick. save a handoff: run whatsnext's wrap-up once before expiry (compact when whatsnext is not installed or not started in the project). compact: compact once before expiry (with whatsnext, using its instructions). off: nothing. Nothing runs during a turn. Not set here, your Profile decides: Quality keeps warm 8 hours, Balanced until your usual start, Economy lets it go cold.

### Reports

- Key: `billing`
- Options: api · subscription
- Default: api
- api: subagent reports show dollars. subscription: they show the share of usage and of the 5-hour window, with API-equivalent dollars beside it. rightsize reads this off each response's rate limits when they show it. A value set here is your answer: the rate limits never change it, and /rightsize says when they disagree.

### Band

- Key: `band`
- Options: when it acts · always · off
- Default: when it acts
- The row above the prompt that shows what rightsize did, with buttons to retry it at the original effort or run it on your model, and a ⋯ menu to change the rule, mark a hand-off or lowering 👍 or 👎 (kept on this machine), or change cache choices. when it acts: only when it changes something. always: on every rated prompt, no change included. off: status line only.

### Question wait

- Key: `questionWait`
- Options: 30 seconds · 1 minute · 2 minutes
- Default: 30 seconds
- How long a question that must be answered before your prompt runs waits for your answer: Effort, Stronger and Subagent when a rule is ask (with Band set to off, or on the mobile app, every question). With no answer, rightsize takes the choice that changes nothing and costs nothing. Questions on the band do not hold up the work and have no wait.

### Price check

- Key: `priceCheck`
- Options: monthly · off
- Default: monthly
- monthly: compare prices.json with Anthropic's pricing page every 30 days and update it. off: never check. /rightsize prices checks right away, whatever this says.
