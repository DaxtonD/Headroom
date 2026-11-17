# Ideas, not yet decided

Written 2026-11-16, after the owner asked what would make this app genuinely
better rather than merely finished.

**Nothing in this file is agreed, scheduled or started.** It is a record of
four gaps found by reading the code, kept so the thinking is not lost and so a
later session does not have to re-derive it. Each one says what is missing,
what already exists to build it on, and what the household would have to
decide first. The owner decides whether any of it happens.

No figures and no names, per the standing rule. Every claim below was checked
against the code on 2026-11-16; where something is an assumption rather than a
verified fact, it says so.

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

Pulled out of the four sections above, so they can be answered in one sitting.
These are additions to the list in PROGRESS, not replacements.

1. On a balance difference: mention it, require an acknowledgement, or refuse
   the save?
2. How many cycles running make a rising bill worth flagging?
3. **Is variable spending itemised anywhere, or only budgeted?** This decides
   whether idea 3 is possible at all.
4. Does every recurring item belong to exactly one budget line, and what
   should the screen say about anything belonging to none?
5. For a what-if, should the retirement effect be shown at all, or only on
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
