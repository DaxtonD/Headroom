# Ideas, not yet decided

Written 2026-11-16, after the owner asked what would make this app genuinely
better rather than merely finished. Section 0 was added on 2026-11-17 and came
from somewhere else: a bill disappearing off the ledger in ordinary use, and
the design the owner proposed in response.

**Nothing in this file is agreed, scheduled or started.** It is a record of
four gaps found by reading the code, plus one design worked out with the owner,
kept so the thinking is not lost and so a later session does not have to
re-derive it. Each one says what is missing, what already exists to build it
on, and what the household would have to decide first. The owner decides
whether any of it happens.

No figures and no names, per the standing rule. Every claim below was checked
against the code - the four numbered ideas on 2026-11-16, section 0 on
2026-11-17; where something is an assumption rather than a verified fact, it
says so.

## The one thing worth knowing first

`safeToSpendNowCents` is the lowest point of the forward timeline minus the
cushion - [`timeline.ts:239`](../packages/core/src/timeline.ts#L239), against
`lowest` computed over the whole horizon at
[`timeline.ts:191`](../packages/core/src/timeline.ts#L191).

That means the home screen is not showing a balance. It is showing the worst
the account gets between now and the horizon. The app is already a forecast
rather than a scoreboard, which is further than most budget apps get.

So the interesting work is not more forecasting. It is closing the loops that
are still open: three places where the app holds the data for an answer and
asks no question of it, and one place where the engine can project three
different futures that never meet.

The reason all four are cheap is the same reason the app is correct: facts are
stored and every total is derived, so the model can be re-run against a
hypothesis as easily as against reality. An app that stored running balances
could not do any of this without a migration.

Section 0 comes first and is a different kind of thing: not a gap found by
reading, but a change the owner asked for after using the app. The same
derived-from-facts design is what makes it cheap as well.

---

## 0. The balance should follow what has already been ticked

**Status: the owner's own design, proposed 2026-11-17 after a real incident,
and refined in discussion the same day.** Not started. Written down so it can
be read whole before anything is changed.

Unlike the four that follow, this did not come from reading the code hunting
for gaps. It came from a bill disappearing off the ledger in ordinary use.

### What happened

Someone marked a bill paid. The row stayed, correctly marked - that part works.
Two minutes later they opened the balance update, typed the figure from the
bank and saved, and the bill vanished.

Nothing was broken. Anything marked paid arrives pre-ticked in the "did any of
these come out since you last updated?" checklist
([`UpdateBalanceSheet.tsx:45-56`](../apps/web/src/components/UpdateBalanceSheet.tsx#L45-L56)),
saving clears what is ticked, and a cleared row leaves the timeline
([`timelineService.ts:195-235`](../apps/api/src/lib/timelineService.ts#L195-L235)).
Every step did what it was written to do. But one Save turned "we paid this"
into "take this off the ledger", and nothing on that screen said it would.

The pre-ticking is deliberate and the reasoning behind it is sound: making
someone say "paid" and then separately say "cleared" is how a bill ends up
subtracted from a bank figure that already excludes it. The defect is that the
consequence is invisible, not that the inference is wrong.

Two things came out of the incident. The second is the interesting one.

1. Everything should stay on the ledger, so you can see what is paid and what
   is not.
2. **The balance at the top should have gone down when the bill was marked
   paid.** It did not, and that was the surprise.

### The second one is right, and the engine almost does it already

`effectiveBalance` is the last typed snapshot plus everything cleared since it
was taken ([`timeline.ts:299`](../packages/core/src/timeline.ts#L299)), fed by
a query for `clearedAt > snapshot.asOf`
([`timelineService.ts:144-153`](../apps/api/src/lib/timelineService.ts#L144-L153)).

So the displayed balance is already "the last figure a person read off the
bank, adjusted by what the app knows has happened since". That is exactly the
proposal. The only difference is which column it listens to.

**The change is to settle on `paidAt` as well as `clearedAt`.** A tick on the
ledger and a tick in the balance checklist are the same assertion - this has
left the account - made in two different places.

### Why it is safe: the typed figure always wins

The hazard in any running tally is double-counting: the balance was typed
*after* the money left, so the figure already excludes the bill, and deducting
it again puts the account too low.

The existing `> snapshot.asOf` comparison handles that without any new logic.
Whichever is newer wins, and the newest thing is almost always the figure
somebody has just read off the bank.

A worked example, with two unrecorded card purchases in the middle of it -
which is the realistic case, and the one the household raised:

| Time  | Event                        | Fact stored      | App shows            |
|-------|------------------------------|------------------|----------------------|
| 09:00 | Bank says 500, typed in      | snapshot @ 09:00 | 500; bill -100 to 400 |
| --    | 35 and 25 spent on the cards | nothing          | still 500            |
| --    | Bill actually paid           | nothing yet      | still 500            |
| 11:27 | Marked paid                  | `paidAt` 11:27   | **400**, row PAID    |
| 11:35 | Bank says 340, typed in      | snapshot @ 11:35 | **340**, row PAID    |

At 11:35 the paid tick is older than the snapshot, so it stops being added and
the typed figure stands alone. No compensating entry, no reset, no flag. The
household's own summary of the rule: the app suggests what the balance should
be from what it knows, and the frequent manual updates define what really
exists.

At 11:27 the app said 400 against a real 340. Today it would have said 500.
Being closer, more of the time, between updates is the entire benefit - and the
app is opened several times a day, so "between updates" is most of its life.

### Nothing new is persisted

An earlier sketch of this had each tick write a derived balance row, with a
column marking it machine-written rather than typed. That is unnecessary, and
it strains the non-negotiable against persisting running totals.

It is not needed. The facts are already stored - snapshots, and the moment a
tick happened - and the balance stays derived from both. No schema change, no
migration, no new table. Undo is free: clearing `paidAt` drops it out of the
sum and the row counts forward again, with nothing to reverse.

### Income is symmetric and already wired

A paycheque uses the same field. The button reads "Mark as received"
([`OccurrenceRow.tsx:341-352`](../apps/web/src/components/OccurrenceRow.tsx#L341-L352))
and the activity log says `marked X received` for an incoming row and
`marked X paid` otherwise
([`activity.ts:188`](../packages/core/src/activity.ts#L188)). `clearedSince`
already sums signed amounts, so positive rows need no special case.

An earlier draft of this design suggested leaving income out, on the grounds
that you know when you paid a bill but not when money landed. **The household
corrected that:** both pays are estimates until the stub arrives, at which
point the actual amount is verified in the app and the row is marked received.
The amount is correct before the tick, exactly as it is for a bill. Income is
in.

That discipline - verify the real figure, then tick - is what makes the whole
design work, because the adjustment is only ever as good as the amount on the
row.

### Paid rows must stay visible, and that is no longer optional

If a tick both moves the balance and hides the row, the bill is gone with
nothing to look at and no way to undo it by eye. So this brings the reverted
work back with it:

- `98d3405 feat: a paid row stays on the ledger to the end` (2026-11-11) added
  `TimelineInput.settled`: shown and ordered like any other row, counted in
  nothing, dropping off after 31 days, with undo.
- `be4bd84` reverted it the next day at the owner's request, recording that the
  question behind it was still open and undecided.

It survives on the local branch `settled-rows-on-ledger`, well behind `main`,
so it is a re-implementation rather than a merge. One thing to change when it
comes back: a settled row printed the words "in your balance" where its running
balance goes, which left a column of rows with no figures beside them. Printing
the running balance carrying through unchanged would read better.

The two changes discussed separately are therefore one change.

### What `cleared` is still for

A narrow but real job. If a bill comes out and nobody ticks it, the next typed
balance already excludes it while the ledger still counts it forward - that is
the double-subtraction the checklist exists to prevent. So `clearedAt` stays,
the checklist stays, and it gets much shorter: already-settled rows need not
appear in it at all, which also retires the pre-tick that caused the incident.

### One implementation hazard

A row can carry both `paidAt` and `clearedAt`. Summing two separate queries
would count it twice. The settled moment has to be a single value per row - the
**earliest** of the two non-null timestamps, not the latest.

Earliest is the correct choice, not merely the tidier one. Take a bill marked
paid at 11:27, a balance typed at 11:28, and the row cleared at 11:30. The
11:28 figure was read off the bank after the money left, so it already contains
the bill. Earliest gives 11:27, which is not after 11:28, so it is not added -
correct. Latest gives 11:30, which is, so the bill would come out twice.

Ties go to the snapshot, since the comparison is a strict `>`. That is the safe
direction: the typed figure is authoritative.

### What it needs decided

- **Does a paid tick adjust the balance immediately, or only once its date has
  arrived?** A bill scheduled for Friday and ticked on Wednesday has not left
  yet. Immediate is simpler and errs low, which is the safe direction, but it
  means the headline can disagree with the bank for a day or two - the exact
  complaint this is meant to fix.
- **How long a settled row stays on the ledger.** The reverted work used 31
  days. A pay period is the other natural answer, and matches how the household
  already works.
- **Whether the difference at the next update is surfaced.** In the worked
  example the app expects 400 and the bank says 340; that 60 is card spending
  nobody recorded. It is idea 1 below, and this change makes it considerably
  more valuable, because the expected figure becomes a real prediction rather
  than a restatement of the last typed number. Suggest shipping this first and
  the difference second, so the wording can be judged against real gaps.

### Size and risk

Medium, and smaller than it sounds. One query condition, one engine input, the
settled-row work restored, and the checklist's candidate list narrowed. No
schema change.

The risk is not arithmetic - at the moment of a tick the forward low point, and
therefore safe-to-spend, is identical either way. The risk is that the headline
stops being a figure somebody saw and becomes one the app believes, which is a
real change in what the number means. Frequent updates keep it honest, and
idea 1 is what would prove they are happening.

---

## 1. The balance entry records; it should reconcile

**Priority: first.** Smallest of the four and the largest gap.

### What is missing

Every figure in the app descends from a number a person reads off their bank
and types in. Nothing checks that number against what the app expected.

The expected figure already exists: `effectiveBalance` is the last snapshot
plus everything cleared since it was taken
([`timeline.ts:299`](../packages/core/src/timeline.ts#L299)).
[`UpdateBalanceSheet.tsx`](../apps/web/src/components/UpdateBalanceSheet.tsx)
asks for the typed amount and runs the "did any of these clear?" checklist,
and at no point compares the two. Searching the balance paths for *expected*,
*discrepancy*, *reconcile* or *mismatch* returns nothing: the concept is
absent, not merely unused.

So the app's single point of truth-decay is the one thing it never audits.

### What it would look like

On save, when the typed figure and the expected figure differ by more than a
threshold, say so, and name the candidates: a bill nobody ticked, a deposit
that did not arrive, a one-off nobody entered. The entry stops being
data-entry and becomes an audit, at the one moment the person is already
paying attention.

### The half that is actually valuable

Keep the difference and trend it. A household that comes in consistently under
expected has unmodelled spending, and the app could put a number on it.

That insight is the thing bank-connecting apps exist to sell, and it is
derivable from a figure already typed by hand. It needs no integration, no
credentials and no third party - which matters, because bank connections were
investigated on 2026-11-16 and ruled out (see PROGRESS, and question 12).

**It can also be backfilled.** `BalanceSnapshot` is append-only
([`schema.prisma:268`](../apps/api/prisma/schema.prisma#L268)) and carries
`cents`, `asOf` and who entered it; occurrences carry `clearedAt`. The
expected figure at each past snapshot is therefore reconstructible from rows
already in production, so the drift history exists on the day the feature
ships rather than starting from empty. That is worth confirming against the
real data before promising it.

If section 0 ships first, backfill has to read the same settled moment it
does - the earliest of `paidAt` and `clearedAt` - or the reconstructed
history will disagree with the live figure.

### What it needs decided

- **The threshold.** A dollar amount, a percentage, or any difference at all.
  Suggest starting at any difference and letting the household raise it.
- **What happens on a difference.** Three options, increasingly intrusive:
  mention it, require an acknowledgement, or refuse the save. Recommend
  mention only - refusing to record a real balance because the app disagrees
  with it inverts which of the two is authoritative.
- **Whether drift is stored.** Storing it is a derived figure in a table,
  which the non-negotiables forbid. The honest form is to derive it on read
  from snapshots and `clearedAt`, and never persist it.

### Size and risk

Small. One engine function, one API field, one block in an existing sheet. The
risk is tone: this feature tells people they have made a mistake, several
times a month, and the wording decides whether it feels like help or
nagging.

---

## 2. Verification produces a history that nothing reads

**Priority: second.** Removes a chore and catches a class of real-world event
nobody currently notices.

### What is missing

The verify flow means every recurring item accumulates estimate-versus-actual,
cycle after cycle. None of it is read. Next cycle's estimate is whatever was
typed into Manage, indefinitely.

The data is unusually complete, in two places:

- `Occurrence` carries `templateId`, `cents`, `date`, `verifiedById` and
  `verifiedAt` ([`schema.prisma:372`](../apps/api/prisma/schema.prisma#L372)),
  so the per-period series for each recurring item is already a query. Note
  that `cents` and `verified` are independent PATCH fields
  ([`occurrences.ts:541`](../apps/api/src/routes/occurrences.ts#L541)), so in
  practice the estimate is overwritten by the real amount and the row holds
  the actual.
- `Activity` is append-only and stores `beforeJson`, `afterJson` and the exact
  `fields` touched ([`schema.prisma:708`](../apps/api/prisma/schema.prisma#L708)).
  Every revision of an amount is therefore already recorded with who and when
  - the estimate, the correction, and the order they happened in.

Nothing reads either for this purpose: there is no *suggest*, *average* or
*last actual* anywhere in the engine or the API.

### What it would look like

Two things, of which the second is the valuable one.

1. **Propose the estimate** from recent actuals when an item is created for a
   new period, so keeping the ledger honest stops being manual.
2. **Flag an item that has risen several cycles running.** This is how a rate
   increase, an expiring promotional price or subscription creep gets caught.
   At present it would go unnoticed until somebody happened to look.

### Why it fits the architecture

The suggestion is derived; the stored fact stays whatever a person chose. The
app never silently changes an amount - it offers one, and a human accepts it.
That keeps rule "store facts, derive every total" intact and keeps the
household in charge of its own numbers, which is the whole premise.

### What it needs decided

- **How many cycles make a trend.** Three is the obvious default and is a
  guess; the household may have a view.
- **Whether a proposed estimate is pre-filled or merely offered.** Pre-filled
  is fewer taps and risks a number nobody read. Recommend offered, shown
  beside the field.
- **Which items it applies to.** A bill that varies by season (heating) wants
  the same month last year, not last month. That is a real distinction and
  possibly a per-item setting rather than one rule.

### Size and risk

Medium. A new engine module with golden tests, a query, and a small amount of
UI. The risk is that a proposed figure is trusted more than it deserves to be;
the wording has to make clear it is the app's guess from history, not a bill
anybody has seen.

---

## 3. The budget is a plan with no actuals

**Priority: third.** Larger, and the one that genuinely needs the household's
input before any code.

### What is missing

`BudgetLineInput` carries `monthlyCents` and nothing else
([`types.ts:266`](../packages/core/src/types.ts#L266)), and `computeBudget`
([`budget.ts:43`](../packages/core/src/budget.ts#L43)) returns each line's
share of its own section. The Budget screen is page 2 of the spreadsheet: a
statement of intent, with no feedback from what happened.

It is not as disconnected as that sounds. `Template.section` is already read
by [`budget.ts`](../apps/api/src/routes/budget.ts), which folds the real
recurring bills into the budget by section. So the screen already knows the
plan and the bills - what it cannot say is what a period actually cost against
what it was meant to.

### This is cheaper than it looks

`Template.budgetLineId` and the `budgetLine` relation **already exist in the
schema** ([`schema.prisma:325`](../apps/api/prisma/schema.prisma#L325) and
[`:364`](../apps/api/prisma/schema.prisma#L364)) and are read and written by
nothing at all. The per-line link was anticipated when the schema was designed
and never wired up.

So the work is not a new data model. It is: populate that column, add an
engine function that sums actuals per line over a window, and show it. The
migration is already done.

### What it would look like

"Planned X for this line; committed Y, with eleven days left." That sentence
is the difference between a budget somebody wrote and a budget somebody uses.

### What it needs decided - and this is the blocker

Mapping items to budget lines is a decision about how the household wants to
think about its money, not a technical choice. Specifically:

- **Does every recurring item belong to exactly one budget line?** If some
  belong to none, the screen has to say what is uncounted, or the totals lie
  by omission.
- **What counts as "actual"?** Verified amount, paid amount, or cleared
  amount. These differ, and bug 16 established that "paid" is a tick rather
  than a transaction - so the word that reads most naturally is the one that
  means least here.
- **Does a variable line have actuals at all?** Groceries are not a recurring
  item in the ledger. If variable spending is not itemised anywhere, the
  budget can only ever show actuals for the fixed half, and a screen that
  compares plan to actual for half the lines may be worse than one that
  compares neither.

That last question is the one to answer first. It may well sink the idea, and
finding that out costs a conversation rather than a milestone.

### Size and risk

Largest of the four. The risk is building a comparison that is accurate for
fixed costs and silently blank for variable ones, which would make the Budget
screen look broken rather than incomplete.

---

## 4. The three projections never meet

**Priority: last by order, first by ambition.** This is the one that would
make the app genuinely unusual.

### What already exists

Three independent projections, all pure, all golden-tested:

- the ledger forward to the horizon - `computeTimeline`
- the mortgage to its payoff date, with and without lump sums - `amortize`
  and `payoffDelta` ([`mortgage.ts:319`](../packages/core/src/mortgage.ts#L319))
- retirement for decades - `computeRetirement`
  ([`netWorth.ts:40`](../packages/core/src/netWorth.ts#L40))

**And the pattern already exists for one of them.** The Savings screen runs a
mortgage what-if today: `savings.ts` calls `payoffDelta` with a `whatIfCents`
figure ([`savings.ts:340`](../apps/api/src/routes/savings.ts#L340)) to answer
"this much moves the payoff date to here". The house style for a hypothetical
is established and tested.

### What is missing

Nothing takes **one** hypothesis and runs it through all three.

> "We want to spend this much, in March."

Today that is three separate acts of imagination. It could be one input
threading through every projection at once: what it does to the lowest balance
in each cycle between now and then, what it does to the payoff date, what it
does to the retirement figure. A proposed purchase as a first-class thing the
app can hold, rather than a sum done in somebody's head.

### Why this app can do it and others cannot

Most budget apps store running balances and totals, so they cannot re-derive a
different future without rewriting their data. Headroom stores facts and
derives everything, which is why a hypothesis costs no more to evaluate than
reality does. That architectural choice has been paying for correctness so
far. This is where it would start paying for capability.

### What it needs decided

- **Where it lives.** It is not a sixth tab - five is deliberate and is why
  the app opens fast. Probably a sheet reachable from the headline figures,
  where the existing info panels already explain the working behind them.
- **Whether a hypothesis can be saved.** A saved one is a plan the household
  can revisit, and is also a stored fact that must never be mistaken for a
  real occurrence - the `import-seed` constraint in PROGRESS is the cautionary
  version of exactly that mistake.
- **How far it may reach.** Threading a purchase through retirement means
  showing a figure decades out that moved because of a trip. True, and
  possibly not useful. Worth deciding whether the retirement leg is shown at
  all or only on request.

### Size and risk

Medium for the ledger and mortgage legs, since the primitives exist. Larger
for presenting three horizons together without it becoming a wall of numbers.
The real risk is scope: this is the idea most likely to grow into a planning
tool nobody asked for. The disciplined version is one amount, one date, three
sentences.

---

## What I would not do

Recorded so a later session does not propose them as novelties.

- **More screens.** Five tabs, down from seven on purpose, is why the home
  screen opens instantly. Anything above goes inside what exists.
- **Guessing categories with a model.** The household's own categories are the
  point; a guessed one is a figure nobody chose.
- **Bank connections.** Investigated 2026-11-16 and ruled out: no free
  production option in Canada, the regulatory framework is legislated but not
  operational, and credit-union coverage is doubtful for the account that
  matters most. See PROGRESS and question 12.
- **Piping insights through notifications.** Push and the activity log are new
  (2026-11-15). The temptation to send every finding to a phone is how a
  useful app becomes one people mute.

---

## Collected questions for the household

Pulled out of the sections above, so they can be answered in one sitting.
These are additions to the list in PROGRESS, not replacements.

From section 0:

1. Should a paid tick move the balance straight away, or wait until the row's
   date has arrived?
2. How long should a settled row stay on the ledger - 31 days, or a pay
   period?
3. Should the balance update say when the bank disagrees with what the app
   expected, or stay silent at first?

From the numbered ideas:

4. On a balance difference: mention it, require an acknowledgement, or refuse
   the save?
5. How many cycles running make a rising bill worth flagging?
6. **Is variable spending itemised anywhere, or only budgeted?** This decides
   whether idea 3 is possible at all.
7. Does every recurring item belong to exactly one budget line, and what
   should the screen say about anything belonging to none?
8. For a what-if, should the retirement effect be shown at all, or only on
   request?

---

## Footnote: an orphan found while reading

`lowestWithin` ([`timeline.ts:310`](../packages/core/src/timeline.ts#L310))
and `lowestOf` ([`timeline.ts:330`](../packages/core/src/timeline.ts#L330))
are exported and called from nowhere in the app.

`computeTimeline` computes `lowest` inline, pay periods compute their own, and
`lowestWithin`'s own comment says it is "used for the ... figure on the Pay
plan screen" - a screen the biweekly/monthly redesign merged into the Ledger.
It looks orphaned by that merge, with a comment still pointing at somewhere
that no longer exists.

Not urgent and not a bug. Either the per-window figure should go through the
engine - which the non-negotiables would prefer, since every total is supposed
to be derived there - or these two should go. Worth five minutes before
somebody reads the stale comment and believes it.
