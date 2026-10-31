# How savings are estimated, and how rightsize is tested

This page explains the method. It gives no results: your own results depend on your work, your model and your settings, and `/rightsize report` shows them from your own log.

## What "saved" means

- **Baseline.** When rightsize chooses a route for a prompt, it also estimates what the task would have cost if it stayed on your model at the effort level the work needs. That estimate is the baseline. It is made at the moment of the choice and never changed afterward, so a later change in prices or in rightsize's own estimates cannot move a past saving.
- **Saving.** The saving of a task is its baseline minus what the task actually cost, counting everything it caused: the main chat's turns, helpers, rework, repairs, corrections, the rating calls, spot-checks and keep-warm requests. **Total saved** in the report is that sum, after rightsize's own costs.
- **Negative savings are shown.** A task that cost more than its baseline counts as a negative saving, and the report lists the turns it does not count as savings, with a reason for each: lowered turns that stepped back up, turns raised mid-turn, hand-offs that cost more than staying or needed rework, effort switches that missed the cache, turns you stopped, and prompts that could not be rated.
- **Extra spent** on harder prompts (raising effort, or using a stronger model for a better answer) is shown on its own line and is not taken off Total saved.
- **Subscription versus API.** On the API the report shows dollars. On a subscription it shows a share of your 5-hour and weekly usage windows, as a range, because usage comes to rightsize in whole percents. Dollar amounts there are API-equivalent: what the same tokens would cost at API prices, not your bill.
- **Actual cost** is read from Claude Code's cost ledger (the `/cost` total) where there is one, and priced from the API's token counts otherwise.
- **Watch only.** In watch only mode nothing is applied, so the `Watch only:` line is an estimate of what rightsize would have saved: the same baseline against the estimate of the route it would have chosen.

## How accuracy is measured

- **Miss rate from your own log.** rightsize scores each rating against what happened, per task type and model: rework on a hand-off, a lowered turn that stepped back up or was raised mid-turn, a test run that failed at the end of a turn, a next prompt that corrects the reply, your 👍 and 👎, and Sonnet's checks of Haiku's ratings. These counts come from the run log on your machine. A route whose miss rate reaches the line for its profile is paused for that kind of work. Rules and values: [HOW-IT-DECIDES.md](HOW-IT-DECIDES.md).
- **Estimates against reality.** After each turn, the real cost is compared with the estimate, and the estimates are corrected per task type and route. The report shows how far estimates were off, early against late, and compares each finished task's cost with the sum of its estimates.
- **Starting values.** Before your own log says anything, some kinds of work start from miss rates set from rightsize's own research. Each task you run takes the place of one of those starting tasks.

## How rightsize is tested

rightsize was tuned and tested on real tasks, not toy prompts.

- **Tasks.** Real tasks taken from the history of public open-source repositories (for example Express and Click), each starting from the repository as it was before the change.
- **Hidden tests.** Each task has a check the model never sees. Before a task is used, the check is proven to fail on the starting code and pass with the real fix. A run passes only if the check passes, so a cheaper route is judged on whether the work was right, not only on what it cost.
- **Off against on.** Every task is run with rightsize off and with rightsize on, on the same starting model and effort, and cost and pass rate are compared.
- **Repeats.** Each task is run several times in each arm, because one run of a model is noisy.
- **Same tasks for both.** The off and on arms use the same tasks, with the same tests and the same budget.
- **Held-out tasks.** Some tasks are kept out of tuning. Defaults such as the hand-off threshold, the task-type guide and the starting miss rates were tuned on the other tasks, and the held-out tasks check that the tuning did not just fit the tasks it was tuned on.

Those tests tuned the values rightsize ships with. They do not predict your results. To see rightsize's calls on your own work before it changes anything, set **Mode** to watch only.
