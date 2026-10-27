# rightsize

rightsize picks the model and effort level for each piece of Claude Code work, so the work gets done well at the lowest cost.

## Models and effort

**Tier**:
A model family that rightsize can route to: Haiku, Sonnet, Opus or Fable.
_Avoid_: model size, class

**Level**:
An effort level: low, medium, high, xhigh or max.
_Avoid_: thinking budget, effort setting

**Session model**:
The tier the main chat runs on. rightsize changes it only for a switch, for one turn.
_Avoid_: main model, parent model

## Deciding

**Task**:
One goal the user is working toward: the prompt that starts it, any hand-off, rework, repairs by the main chat, and the user's follow-up corrections. It ends when a rating says the user has moved to a new goal.
_Avoid_: turn, run, job

**Rating**:
A quick, cheap judgement of one prompt: what kind of work it is, how much it reads and writes, its fit on each tier, and whether it continues the current task or starts a new one.

**Fit**:
For one tier, the lowest level at which that tier does the work well, or "would struggle" if no level does.
_Avoid_: capability, suitability

**Route**:
Where the work runs and at what level: on the session model, switched to another tier for the turn, or handed off to a subagent on another tier.

**Switch**:
A route that runs one turn of the main chat on another tier, then goes back to the session model. The main chat keeps the whole conversation, so nothing is briefed or checked.
_Avoid_: model change, escalation

**Hand-off**:
A route that sends the work to a subagent on another tier. A hand-down goes to a cheaper tier; a hand-up goes to a stronger one.
_Avoid_: delegation, offload

**Helper**:
The subagent that does the work in a hand-off, or a subagent Claude starts on its own that rightsize moves to another tier.
_Avoid_: worker, delegate

**Outcome**:
Whether a task succeeded, one per task. It comes from the strongest evidence available, in this order: the user's verdict, objective checks (tests, builds), the main chat's verdict on a hand-off, then weak signals such as rework and corrections.
_Avoid_: result, score

**Miss**:
A task whose outcome is failure after rightsize chose a cheaper route or a lower level for it.
_Avoid_: failure, error

**Stall**:
A helper that has stopped making progress. Every stall has one cause: waiting, blocked or struggling.
_Avoid_: stuck, hang

**Waiting**:
A stall caused by the helper waiting on the user, such as a permission prompt or a question. It is not a stall the helper caused.

**Blocked**:
A stall caused by the environment, such as a network failure, a missing login or tests that already failed. More effort would not fix it.

**Struggling**:
A stall the helper caused itself, such as repeating a failing command or undoing its own edits. Only a struggling stall can lead to a miss.

**Chance**:
One attempt a struggling helper gets before the task goes back to the main chat. Each profile allows a set number of chances.
_Avoid_: retry, attempt

**Rater disagreement**:
A spot-check in which a stronger model says a cheaper tier would struggle with work the rating said it fits. It can pause that tier for that kind of work, but it is never a miss.
_Avoid_: spot-check miss

**Profile**:
The user's choice of how much evidence rightsize needs before it picks a cheaper route: Quality, Balanced or Economy.
_Avoid_: mode, policy, preset

**Balanced**:
The default profile. It picks the cheapest tier and level that fit, and only when the evidence says quality holds.

**Quality**:
The profile that also uses stronger tiers and higher levels when they would help, and rarely picks a cheaper route.

**Economy**:
The profile that favours lower cost and accepts more risk that a cheaper route falls short.
_Avoid_: Conserve, saver, budget mode

## Reporting

**Task cost**:
The actual cost of everything in a task: the main chat, any hand-off, rework, repairs and corrections.

**Baseline**:
rightsize's estimate, made when it chose the route, of what the task would have cost on the session model at the level it needed. It is never changed afterward.
_Avoid_: counterfactual, would-have-cost

**Net impact**:
The baseline minus the task cost, summed over tasks, minus the cost of rightsize's own checks. It can be negative.
_Avoid_: total saved, savings
