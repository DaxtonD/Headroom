# Headroom progress log

Claude Code updates this file at the end of every milestone and every work session. Dax reads it to see where things stand without asking.

> **No real financial figures in this file.** Per Dax's decision on 2026-11-07, no household financial data is committed to git. This log refers to items by name only, never by amount.

## Status

| Milestone | Status | Tag | Notes |
|---|---|---|---|
| Handoff committed to repo | done | | Real-data files deliberately git-ignored (see "Decisions") |
| M0 Scaffold, CI, login, compose | done | m0 | Verified end-to-end in the built image: migrations, login, app shell |
| M1 Calculation engine + golden tests | done | m1 | Reproduces every expected value in BOTH the real seed and the synthetic fixture |
| M2 Home + Upcoming + integrity layer | done | m2 | All section 16.8 integrity tests pass against a real Postgres |
| M3 Recurrence + Pay plan | done | m3 | Generation follows a template edit and never undoes a person's; flexible bills move between periods |
| M4 Budget, Goals, Net worth | done | m4 | Every retirement assumption editable; shares are of the section |
| Manage screen + expense model | done | | Added at Dax's request, before M5. One entry feeds timeline and budget. Second pass: every section editable |
| Biweekly/monthly redesign | done | | Agreed with Dax 2026-11-08. Engine, schema, API, Year screen, Savings screen, and Home+Upcoming+Pay plan merged into one Ledger |
| Biweekly expenses | done | | At Dax's request. Any expense can be every two weeks on its own dates; the mortgage can be anchored either way |
| Manage edits reach the ledger | done | | Bug 14, reported from production. Generation reconciles untouched rows; "I choose when to pay it" takes a planned day |
| Settings: themes + text size | done | | At Dax's request. Five themes plus match-my-device, five text sizes. Per device, not in the database. Contrast checked by test |
| Undo for received/paid | done | | Bug 15, found in testing. A cleared cheque is no longer re-projected, archiving the pay stops the ghost, and the ledger offers an undo |
| "Paid" is a tick, not a transaction | done | | Bug 16. It had been subtracting a bill the typed-in balance already covered. The row now stays on the ledger, marked, and no figure moves |
| M5 PWA + desktop polish | not started | | |
| M6 Ops: backups, seed import, GHCR, DEPLOY.md | not started | | |

## Last session

- Date: 2026-11-08
- **Pushed on 2026-11-09**, on Dax's OK: `main` and the tags `m0`-`m4` are on
  `github.com/DaxtonD/Headroom`, which he made **public**. The repository had been empty until
  then, so nothing was rewritten out from under anyone.
- Done: the handoff, then M0 through M4, then the Manage screen and the expense model, then a
  second pass making every section of Manage editable, then the whole biweekly/monthly redesign:
  engine, schema and migration, the savings and mortgage API, the Year screen, the Savings screen,
  and Home + Upcoming + Pay plan merged into one Ledger.
- **780 tests green** as of 2026-11-11: 311 engine, 345 API against a real Postgres, 124 web
  source, token, contrast and appearance checks. Lint, typecheck and `pnpm build` clean.
- The screens are now: **Ledger, Year, Budget, Savings, Manage**, with Net worth reached from
  Savings. Seven tabs became five.

### Where each milestone stands

- **M0 scaffold** - done, tagged `m0`. Verified end to end in the built image.
- **M1 engine** - done, tagged `m1`. Reproduces every expected value in the seed.
- **M2 Home + Upcoming + integrity** - done, tagged `m2`. Every HANDOFF section 16.8 test passes.
- **M3 recurrence + Pay plan** - done, tagged `m3`. Generation never undoes an edit.
- **M4 Budget, Goals, Net worth** - done, tagged `m4`.
- **Manage screen + expense model** - done, untagged. Built at Dax's request before M5, then
  revised after he found that three of its sections were read-only.
- **Biweekly/monthly redesign** - done, untagged. The whole of the agreed plan: engine, schema,
  API, the Year screen, the Savings screen, and the ledger merge.
- **M5, M6** - not started.

## Next session: start here

1. Read this file, then `CLAUDE.md`, then `docs/HANDOFF.md` (local only, git-ignored).
2. `pnpm install` and `node scripts/testdb.mjs up`, then `pnpm test`.
3. **The image.** `ghcr.io/daxtond/headroom:latest` is published by the `publish` job in
   `.github/workflows/ci.yml` on every push to `main`, gated on lint, typecheck, the full suite on
   both Node versions, and the image smoke test. Check the **package's** visibility after the
   first publish: it is separate from the repository's, and Unraid's Docker Manager cannot pull a
   private package without registry credentials.
4. **Dax is setting up the real household** through Unraid's Docker Manager, entering the
   environment variables by hand so no real value is in a file. `docs/DEPLOY.md` has the runbook.
   Only three variables have no default: `APP_ORIGIN`, `DATABASE_URL`, `SESSION_SECRET`.
5. The redesign is finished, so **M5 next**: PWA and polish. `vite-plugin-pwa` is a dependency but is not wired up, so
   there is no manifest, no icons and no service worker. Needs: the installable manifest and
   icons, the read-only offline cache behind the "Offline, as of ..." banner that
   `useLiveUpdates` already drives, the App Badging API for the count of unverified bills, an
   "Update balance" manifest shortcut, desktop layouts, and the accessibility pass
   (44px targets, 4.5:1 contrast).
6. Then M6: backup sidecar with a tested restore, `import-seed` for the real figures, and
   finishing `docs/DEPLOY.md`. The GHCR image is done early, since Dax needed something to pull;
   `scripts/backup.mjs` covers dump/verify/restore by hand, so M6's remaining job there is the
   scheduled sidecar.

**Constraint on `import-seed`, found 2026-11-08 while answering a question from Dax.** It must
create **templates** and then run generation - never insert occurrences directly. Most of the demo
data was seeded as bare occurrences with no `templateId`, and the symptom is exactly what Dax
spotted: a row sits on the ledger, is absent from Manage, and never regenerates for the next
period. A real household imported that way would look right for a fortnight and then quietly stop
producing bills.

The PWA needs a secure context, so it can only be tested over the HTTPS domain through Nginx
Proxy Manager, never over a LAN IP.

## The expense model (added before M5, at Dax's request)

Dax pointed out that the app could display and adjust money but could not be **set up or
maintained**, and that it was hard to make sense of. He was right, and the gap was wide: bills,
budget lines, goals, assets, work expenses, banked hours and income all had APIs with no UI,
and pay schedules and the household settings had no API at all.

Decisions taken with him on 2026-11-08:

1. **One entry per expense.** A bill used to exist twice - as a timeline item with an amount
   and a recurrence, and again as a budget line with a monthly amount. Now it is entered once
   and the monthly figure is derived from the cadence, with an optional override where the
   spreadsheet states something different. The derived figure is always reported alongside an
   override so the difference is visible.
   - The conversion that matters: **biweekly is 26 times a year, not 24**, so 26/12 of the
     amount. Treating it as semi-monthly understates the year by two whole payments.
   - Budget-only categories (food, gas, everyday) stay as budget lines: spending with no due
     date and no bill.
2. **A sixth "Manage" tab** holds all of it, with a checklist of what is still missing and what
   each gap breaks.
3. **Archive, never delete.** A paid-off bill stops generating and leaves the budget; its
   history stays whole and one button brings it back.

### Second pass: everything on Manage is editable (2026-11-08)

Dax tried the first version and said: *"Nothing is editable on the manage screen. I can only
add new expenses. If this is the management screen, everything should be editable here,
correct?"* Correct, and he had found a real hole rather than a preference.

What had happened: the mutation hooks for categories, goals and assets were **written,
typechecked, exported and wired to nothing**. `useCreateCategory`, `useDeleteCategory`,
`useCreateGoal`, `usePatchGoal`, `useCreateAsset` and `usePatchAsset` were all dead code, so
those three sections rendered as read-only text and the only way to correct one was SQL. 422
tests passed throughout, because nothing asserted that a mutation is reachable by a person.

The rule for the screen now: **anything it lists, it can change.** Every list has an Edit on
each row and an Add underneath, and removal is offered inside the form that edits the thing,
where what is being removed is named and on screen.

- Added UI for: budget categories (add, rename, re-amount, move fixed/variable, remove),
  savings goals (add, edit, remove), assets and debts (add, edit, remove), money coming in
  (add, not just edit), work expenses, banked hours, and renaming the account.
- Pay schedules: the **anchor date** is now editable, not only the amount. It decides which
  fortnight every pay period falls in, so an anchor out by a week yields a plausible schedule
  that is wrong - the form lists the next three paydays as a check.
- Removal is **soft everywhere** (`deletedAt`), consistent with archiving a bill: a goal that
  was reached or a car that was sold stops counting without erasing the figures it explained.
- `kind` cannot be changed on an existing asset. Turning something owed into something owned is
  two different facts, not a correction, and it would silently flip a sign that feeds net worth.
- Editing also lives on Goals and Net worth, where the numbers are, not only on Manage.

New API routes this needed: `DELETE /api/goals/:id`, `DELETE /api/assets/:id` and
`PATCH /api/accounts/:id`. All three are versioned like every other write - verified live that
a stale `If-Match` returns 409 and a missing one returns 428.

Two pieces of tidying that the above exposed:

- **`templates.ts` had its own cents parser.** Two places decided what an amount on the wire
  looks like, which is exactly the seam bug 9 came through. It now uses the shared `wireCents`,
  so a decimal is refused with the same explanation everywhere.
- **The sheet styles lived in `UpdateBalanceSheet.css`.** The bill form and the net-worth form
  used those classes while importing a different stylesheet, so they only looked right because
  that one component happened to be mounted in the app shell. Extracted to `Sheet.css` with a
  shared `Sheet` component, which the four new forms also use.

### A running demo exists

A throwaway container is on this machine for looking at the UI:
`docker ps` shows `headroom-demo` on <http://localhost:8484>, with `headroom-test-db` behind it.
Sign in as `carol@headroom.local` / `headroom-demo-password`. Invented amounts.
Remove with `docker rm -f headroom-demo` and `node scripts/testdb.mjs down`.

### Not yet verified

- **The screens have never been looked at.** There was no browser tooling in the session that
  built them, so Home and Upcoming are verified by typecheck, build, and the API's numbers
  matching the engine - not by eye. Worth a careful look before building more on their patterns.
- CI has never run, because nothing is pushed.

## The biweekly/monthly mismatch (2026-11-08, after a long discussion with Dax)

Dax stopped the build to explain how Carol actually uses the spreadsheet, and the gap was
conceptual, not cosmetic. His words:

> "our pay periods are biweekly but most of our bills are monthly. so, sometimes I get 3
> paychecks per month and sometimes carol does. also, our mortgage is biweekly, not monthly.
> ... the data is too spread out for Carol. she can't easily see everything."

And the purpose of the whole app, which was not written down anywhere:

> "we are actively trying to save as much as possible to pay off our mortgage early with annual
> lump sum payments." / "This app is trying to do 2 things: 1. make Carol feel at home using the
> app instead of the spreadsheet. 2. allow me to understand what the heck she's doing."

### What was wrong

1. **The third cheque was computed away, not surfaced.** The spec said in three places - twice in
   engine comments - that a month with a third cheque "needs no special handling". True of the
   arithmetic, false of the decision: the running balance absorbs it silently, which is exactly
   why nobody can see it coming. Finding those months is Carol's entire monthly ritual.
2. **Worse, the mortgage is `relative_to_pay` (the day after a payday).** That one-day offset
   makes third-cheque months and third-mortgage-payment months drift apart, so a windfall month
   can sit directly beside a squeeze month for no reason anyone would guess from a calendar.
   Verified against the real schedules, and reproduced in a committed test with synthetic anchors.
3. **Savings was modelled as a bill.** Dax: "The savings of $1300 is a goal we set. She decides
   when and how much we allocate." So it is the residual, not an obligation - and the lump sum it
   feeds was nowhere in the app at all.
4. **Targets were mandatory.** `Goal.targetCents` is non-null and Goals draws a bar against it.
   Dax: "Trips never have a set date or set cost." An app that demands a target makes someone
   invent one and then reports progress against a number nobody believes.
5. **Six tabs for one sheet.** Home, Upcoming and Pay plan are three renderings of a single
   object; the view Carol lives in - one running ledger grouped under each cheque - was not quite
   any of them.

### Agreed plan (Dax approved the order)

Engine -> M5 (PWA) -> M6 backups -> deploy -> he and Carol set everything up.

Backups deliberately moved **ahead** of the setup pass: having them hand-enter every bill, date
and balance into a database with no verified restore is the one ordering worth avoiding. Dax also
confirmed the redesign comes before the setup pass, so the data is entered once against the final
shape.

### Done so far: the engine

- `packages/core/src/chequeCalendar.ts` - per-month counts for anything biweekly, flagging months
  that differ from the usual two and what the difference is worth. Needs no amounts or
  verification, only the schedules, so it stays honest a year out.
- `packages/core/src/mortgage.ts` - integer-cent amortization, lump sums, payoff date, "what one
  more lump sum buys", and the calendar-year prepayment allowance. **No floats:** interest is
  `balance x basisPoints / (10_000 x periodsPerYear)` through `mulDivRoundHalfUp`. Checked against
  Dax's own workbook; agrees to one cent after a dozen payments.
- `packages/core/src/savings.ts` - one real account, several earmarks, optional targets, and the
  number no spreadsheet gives you: **unallocated** = balance - earmarks, surfaced rather than
  clamped when a plan does not fit.
- `roomToSaveCents` on every pay period - the same computation as "safe to spend now", asked at a
  later point on the timeline. This is what turns a third cheque from "absorbed" into a decision.

### Done: the schema, the API and two screens

- **`Account.kind`** (`chequing | savings`). Until the savings screen existed, "the chequing
  account" meant "the first account row" - correct with one account and silently wrong with two.
  The timeline and `POST /api/balance` now ask for chequing by name. A savings balance goes
  through that same append-only endpoint with an `accountId`, rather than a second copy of the
  snapshot rules.
- **`Mortgage` and `Prepayment`** store terms and lump sums only. The payoff date, what is owing
  today, the interest and what another lump sum buys are all derived per request.
- **`GET /api/savings`** builds the whole screen in one read. Terms are validated by running them:
  an `asOf` that is not a payment date, or a payment too small to clear the balance, is refused
  with the reason while the form is still open.
- **The Year screen** (`/year`) - which months hold a third cheque or a third mortgage payment,
  and what each is worth.
- **The Savings screen** (`/savings`, replacing Goals, with the old path redirecting) - the real
  balance, the earmarks against it, what is unallocated, and the mortgage panel: owing today,
  payoff date, what the planned lump sums bring it forward by, what the earmarked amount would buy
  if paid now, and this year's allowance.

An intention and a payment are kept as separate facts. Only **paid** lump sums count against the
year's allowance: counting an intention would understate the room and talk them out of paying it.

### Done: the ledger

Home, Upcoming and Pay plan are **one screen** at `/`, labelled Ledger. The balance and what is
safe to spend at the top, then every event in bank order grouped under the cheque that pays for
it, a running balance on every line, and a subtotal band under each group with "left over" and
"room to save". Both old paths redirect; the tab bar is five tabs instead of seven.

The rows are the existing `OccurrenceRow`, not a flatter one written for the new screen. The first
version of this merge did write its own, and that silently dropped verifying an amount, editing it,
marking it paid and the conflict handling - while still showing the badge that says "still an
estimate".

A one-off can now be added (it could not be at all) **and removed**. Only a one-off: a generated
row belongs to its bill, and marking it paid would be a different claim.

### Done: biweekly expenses, at Dax's request (2026-11-08)

Dax: "The mortgage, and other expenses, needs to be able to be configured for bi-weekly." He was
right that it could not be, and the reason was worse than a missing menu entry:

- The only fortnightly option in the interface was **"a few days after someone's payday"**. That
  is biweekly only because the payday is, and it cannot express dates a lender set.
- The schedule type that *sounds* right, `biweekly`, was **reserved for paycheques**: it forced the
  amount positive with `absOf`, so a biweekly bill on it would have been money **arriving**.
- Worse, opening an existing biweekly item in the bill form mapped it to "after payday", so
  **saving it rewrote its schedule** - to a payday it had never followed, with the offset
  defaulted to 1.

Now: **"Every two weeks, on its own dates"** with an anchor date, for a bill, a deposit or a
transfer, signed by kind. The paycheque path is untouched - `signedForKind("paycheque", x)` is the
same answer `absOf` gave. A biweekly bill obeys the weekend rule like every other bill; a paycheque
still does not, because pay arrives when the employer sends it.

The **mortgage** can now be anchored either way, and its own dates are the default for a new one:

- **Its own dates** is what a lender states, and a payday-anchored mortgage silently moves every
  payment if that pay anchor is ever corrected.
- **Following a payday** stays, because this household's really does behave that way (the day
  after Dax's pay), and that one-day offset is the whole reason the Year screen exists.

Naming one anchor clears the other, so which one wins is never a guess. The budget already costed
biweekly at 26/year rather than 24; verified in the demo at $42.50 a fortnight showing as
$92.08 a month.

682 tests green (305 core, 103 web, 274 API), lint, typecheck and build clean.




### Bugs caught while building it

- **A lump sum was credited a fortnight early.** The prepayment window compared forward to the end
  of the period instead of back to the payment date, so a lump sum dated the 1st was applied with
  the payment on the previous 19th. Caught only because the expected values were computed
  independently first rather than read back out of the implementation.
- **`roomToSave` held future periods to today's balance.** A "now"-anchored row was treated as
  still ahead for every later window, and today's balance capped a period that has not started.
  Three cases are now explicit, with the reasoning in the code.
- **Four real figures went into committed source in one sitting** - a basis-point example, a
  "reject a fractional rate" case, the real annual prepayment cap and the real prepayment history.
  Each was chosen simply because it was the number already in mind. See the next section. A fifth
  attempt was blocked while writing the sign-rule test, which reached for the real power bill.

### Bugs the guards found, not a person (2026-11-08, later)

Each of these was found by making an existing check cover more, and each had been passing every
typecheck, lint and test run:

- **Every versioned entity needs an entry in a hand-written table map** or its first PATCH is a
  500, and nothing in the type system says so. The mortgage routes compiled, created rows fine,
  and failed on every edit with "no lockable table registered". `apps/api/test/guards.test.ts`
  now reads `schema.prisma` and fails if a model carrying a `version` column is unregistered -
  which immediately found `banked_hours_entry` missing too. It has no edit route yet, so nothing
  was broken; the first one added would have been.
- **Nothing in the app could add a one-off.** `POST /api/occurrences` and `useCreateOneOff` both
  existed and no button called either, so Carol's "add a few extra rows" meant SQL. The
  reachability check in `wiring.test.ts` only scanned two query modules **by file name**; it now
  matches any `*queries.ts`, and failed on `useCreateOneOff` at once. There is now an
  `OneOffForm` on Upcoming, which the ledger merge will absorb.
- **A one-off's amount was stored with whatever sign was sent**, while a generated bill is signed
  by the engine. The same bill would have been an outflow from a template and income when typed
  in - the running balance would go **up** when someone added a bill. There is now one exported
  rule, `signedForKind`, used by both paths.
- **`--hr-negative` was never defined.** It was referenced by the destructive "Remove this"
  button and by the Year screen's squeeze months. An undefined custom property makes
  `border: 1px solid var(--hr-negative)` invalid outright, so the button had no red border and no
  red text; it looked like an ordinary link. `apps/web/test/css-tokens.test.ts` now fails on any
  token used without a definition, and was verified by removing the token and watching it fail.
- **A pay window dropped any row dated before it started.** The timeline deliberately keeps a
  dated item that is past and uncleared, because the money has not moved yet - and no window's
  date range covered it, so it was left out of the window's rows **and its totals** while still
  lowering every running balance and safe-to-spend figure on the same screen. In the demo that was
  four rows including a $2,315 paycheque, so "left over" on the pay plan was badly wrong. The
  first window now absorbs anything undated or earlier than itself, which is also the truthful
  answer: an overdue bill comes out of the money in hand. The existing API test already asserted
  "every timeline row is in some window" and passed throughout, because the scenario never
  contained one.
- **Three pay windows covered the timeline by coincidence.** The horizon is an editable household
  setting; raise it and rows past the last window fall out of the grouping in the same way. The
  windows now follow the horizon (`coverThrough`).
- **The live-update stream refreshed three screens out of ten.** It acted on three entity names
  and ignored every other one, so an earmark, a bill, a budget line or a mortgage edited on one
  phone did not reach the other until a reload. A ping now invalidates every key; TanStack only
  refetches what is mounted, so this is cheaper than the staleness was.

## Guard: `pnpm check:figures` (2026-11-08)

Writing the mortgage engine put four real household figures into committed files inside one
sitting, and a fifth (the real refund row) turned out to have been sitting in
`apps/api/test/wire.test.ts` since an earlier session. All five are now invented values.

`scripts/scan_for_real_figures.py` reads the **git-ignored seed** for what to look for - hard-coding
the figures would put them in a committed file and defeat the point - and scans every tracked file.

Known limits, deliberately chosen:

- It only flags **distinctive** amounts, meaning those with odd cents. Scanning for round numbers
  gave 140 hits across the tree, effectively all coincidence (a `sortIndex` capped at `100_000`,
  test values of `200000`, a documented amount that is the codebase's own cautionary tale). A
  gate with a 140-line allowlist is a gate nobody reads. So a **round** real figure will not be
  caught, and the rule still needs care.
- It **skips entirely in CI**, which has no seed by design. Its only real home is Dax's machine.
- Not installed as a git hook: that would change local git config, which is Dax's call. Offered.

## Verified by hand, not only by tests

The built image was run against an empty database and checked end to end:

- both migrations applied from scratch;
- `/api/health` returns `ok` with the database up;
- `GET /` serves the app shell, and a deep link (`/upcoming`) serves it too, so a bookmarked page survives a cold load;
- fingerprinted assets come back `immutable`, `index.html` comes back `no-cache`;
- `create-user` created the household and both accounts, with no password in `.env` or on a command line;
- sign-in worked, the cookie is `HttpOnly` and signed, `/api/me` returned both members, and a wrong password returned 401;
- starting the image with an incomplete configuration exits 78 and names the missing variable.

## Resolved: the phone could not reach the dev machine over the LAN

Chased at length on 2026-11-08 and settled. **The development machine was never the problem**:
Windows Firewall is disabled on all profiles, routing is clean, the Privado WireGuard tunnel
service is stopped with no addresses or routes, and the app listens on `0.0.0.0`. A plain
`node.exe` listener on another port behaved identically, so it was not Docker-specific either.

The cause was **wireless-to-wired isolation on the router**: the phone, on wifi, could not reach
the PC, which is on wired Ethernet. Confirmed by the Nginx Proxy Manager route working from the
wired Unraid box immediately.

Two things learned worth keeping:

- The PC cannot ping even its own default gateway while having working internet, so ICMP is
  filtered locally and **ping and ARP evidence is worthless on this machine**. Use a real TCP
  listener and check whether connections arrive.
- Browsers only treat `localhost` as a secure context, never a LAN IP, so the PWA parts need
  real HTTPS regardless. The domain through NPM is the way to test those.

`docs/DEPLOY.md` has the proxy-host settings and the SSE-through-a-proxy notes.

## Bugs caught before deploy (all fixed)

Worth recording, because each would have been invisible until it mattered. Number 9 reached
Dax in the running app rather than being caught here, which is the one that matters most:

1. **Two not-found handlers.** Fastify allows one per prefix, so the app could not start at all. A single handler now decides both the API 404 and the single-page-app fallback.
2. **A global `pg` int8 type parser.** Added so raw queries would return `BigInt`; it broke *every* Prisma write, because Prisma's driver adapter relies on the driver's default and converts the value itself. Removed, with a note so it is not re-added.
3. **BigInt serialization.** `setSerializerCompiler` only applies to routes that declare a response schema, so `/api/me` returned 500 on the household's cushion. Now `setReplySerializer`, which covers every reply.
4. **The login limiter counted successful sign-ins**, while `.env.example` documents `LOGIN_RATE_LIMIT` as failed attempts. Carol could have locked herself out of her own finances. Replaced with a failure-only throttle that a correct password clears.
5. **`pino-pretty` in the production image.** `NODE_ENV=development` against the built image crashed at startup, because the pretty transport is a dev dependency. Pretty logging is now used only when the module is actually present.
6. **Asset cache headers did nothing.** `@fastify/static` sets its own `cache-control` and overrode them, and the pattern looked for `.hash.js` while Vite emits `name-HASH.js`. Both fixed, then verified against the running container.
7. **A pinned base image tag that did not exist** (`node:22.23.4-alpine3.22`). Now `node:22.23.4-alpine`.
10. **A bill and a budget category sharing a name** confused the Budget page: the category was
   labelled as coming from a bill and carried the bill's id, so editing it would have edited
   the wrong record. The cause was matching the engine's output back to source rows by name
   after the fact; identity now travels with each line and is paired back by position. Found
   by using the running app, not by a test.
11. **The override checkbox defaulted to ON for a new expense**, because with optional chaining
   `existing?.field !== null` is true when there is no existing record at all.
12. **Six mutation hooks wired to nothing** - found by Dax in the running app. The query layer
   could create and edit categories, goals and assets; no button called any of it, so three
   sections of the Manage screen were read-only text and only SQL could correct them. The
   whole suite was green, because "a person can reach this" was not something any test
   asserted. Fixed by building the forms, and guarded by `apps/web/test/wiring.test.ts`, which
   fails if an exported `use*` hook appears in no component, or if a path the client calls has
   no matching route on the server. Both halves of that guard were confirmed to fail when
   deliberately broken, rather than assumed to work.
   - Same shape as bug 9 and bug 10: correct on each side, wrong at the seam, and found by
     using the app rather than by running the tests.
9. **A bill saved as 100x its amount** - found by Dax, not by the tests. Typing 186 stored
   $18,600. The amount was converted twice: the web app turned "186" into 18600 cents and
   sent `"-18600"`, and the API ran `parseCents` over that again and read it as dollars.
   Both sides had passing tests; neither crossed the seam between them, because the API's
   tests sent dollar strings while the client sent cents. Fixed by making integer cents the
   only wire format (`apps/api/src/lib/wire.ts`), refusing a decimal outright rather than
   guessing, and adding `apps/api/test/wire.test.ts`, which follows an amount all the way
   round - typed, sent, stored, read back, formatted - through the same engine functions the
   UI uses. The lesson generalises: test across the seam, not just either side of it.
8. **`prisma.config.ts` loaded the root `.env` unconditionally**, which could have aimed destructive test fixtures at the real database. An explicit `DATABASE_URL` now always wins.

## Bug 13: a payday was not money (2026-11-09, found in production)

The worst one so far, and the only one that made the app actively lie. Dax had entered every
real figure and the home screen said **safe to spend: a large negative number**, with a
coverage banner claiming there was not enough for the mortgage.

### What was wrong

A `pay_schedule` stored *when* someone is paid. A `paycheque` **template** is what actually
puts a row on the timeline. Nothing created the second from the first, and nothing said so
clearly, so a household could enter its paydays and all of its bills and get a ledger of pure
outgoings: a running balance that only ever fell, every automatic withdrawal reported as
uncovered, and flexible bills silently skipped by generation because there was no paycheque
to anchor them to.

The giveaway was on the same screen. The pay-period summary reported a full fortnight of pay
coming in, directly above a running balance that never rose once, because `computePayPeriods` projects unplaced
cheques from the schedule and `computeTimeline` only ever sees occurrences. Two engines, one
screen, opposite answers about whether the pay existed.

The UI had already promised the right behaviour - *"Paycheques come from the paydays below"* -
while the checklist beside it said to add the pay by hand. Both could not be true.

### The fix

A payday now brings its cheque: `ensurePaychequeTemplates` creates a `paycheque` template
bound to the schedule by **id**, so the dates stay in one place and correcting a payday moves
the cheques with it. It runs at the top of every generation pass, which makes it self-healing
for a household set up before the change.

- **Changing the pay amount carries through** to the template default, but never rewrites a
  cheque already on the ledger - one of those may have been edited for overtime.
- **It cannot double a household's income**, which would be worse than the bug: a cheque is
  claimed by `payScheduleId`, then by owner, then by fortnightly date alignment; anything
  ambiguous blocks creation and the checklist says so. Four tests cover the ways a household
  that followed the old advice could already have a hand-made paycheque.
- **Archiving is respected.** The lookup deliberately ignores `active` and `deletedAt`, so a
  cheque turned off on purpose stays off.

### The checklist was asking the wrong question

`income_on_ledger` asked *"is there any income template at all"*. A single unrelated benefit
deposit answered yes while neither person's pay was on the ledger - so the check stayed silent
through exactly the setup it existed to catch. It now asks per payday.

### A second, latent bug found on the way

**Generation only ever ran after a write.** The horizon is "through the day before the Nth
upcoming paycheque", so it moves forward every day: a household that edited nothing for a
fortnight would have watched its ledger shorten rather than extend. It also meant this fix
would not have reached Dax's data until he happened to edit something.

`generateForAllHouseholds` now runs once at startup and every `GENERATION_SWEEP_HOURS`
(default 6, new in `.env.example` and the Unraid template). Each household is its own
transaction, and a failure is logged rather than thrown - one bad schedule must not stop the
sweep or the server.

### Still to do

There is no test that every variable in `env.ts` appears in `.env.example` and
`unraid/Headroom.xml`. Keeping the three in step is currently done by hand, and this change
needed it in all three.

## Bug 14: an edit under Manage reached nothing (2026-11-09, reported from production)

Changing an expense under Manage appeared to do nothing at all. The template changed, the
budget changed, and the ledger went on showing the old name, the old amount and the old date.

### What was wrong

Generation would not touch an occurrence that already existed - the rule that protects a
typed-in figure from being overwritten. But by the time anyone edits anything, every occurrence
to the horizon has already been generated, so there was nothing left for an edit to affect.
A corrected amount would first appear on the ledger whenever the horizon rolled past the last
row already made, which for a monthly bill is months away. The one rule meant to protect real
data was silently refusing every correction.

Archiving was the same bug with worse consequences: generation stopped making new rows and left
the existing ones, so a cancelled bill went on pulling every balance below it down for the rest
of the horizon.

### The fix: generation reconciles instead of ignoring

The rule is now split in two, which is what it should always have been.

- **A row nobody has touched is pure derivation of its template**, so it follows the template:
  name, amount, owner, date, placement, and whether it should exist at all.
- **A row somebody has made their own is never written to again.** `customisedAt` (new column)
  records when a person changed the row's own details; `verifiedAt` and `clearedAt` already
  recorded the other two ways. Any of the three makes the row theirs for good.

Also:

- **The past is read and never written to.** Only rows that still lie ahead are reconciled, so
  last month's power bill says what it said.
- **A second pass writes nothing.** Each field is compared before any update, so the sweep that
  runs on a timer and at every boot does not churn versions - which would otherwise make the
  other phone's next save fail with a conflict about a change nobody made.
- **A flexible bill is not stranded when its cheque goes.** Correcting a payday removes the
  cheque a flexible bill was hanging from, and the foreign key nulls the anchor, which means
  "now" - in front of every cheque, dragging the lowest point of the whole ledger down. Those
  rows are now moved to the nearest cheque still there. A test found this: the first attempt
  looked only for a cheque on or *before* the lost date, and a payday corrected one day forward
  leaves nothing before it.

Changing the pay amount now reaches the cheques on the ledger too, where before only the
template default moved. The overtime case that justified the old behaviour is covered properly:
an edited cheque carries `customisedAt` and is left alone.

### A planned day for "every month, but I choose when to pay it"

Asked for in the same message. The option meant "undated, hanging off the first paycheque of the
month", which is right about who decides and wrong about where it appears: a household that
plans to pay the card on the 20th wants to see it on the 20th, against the balance it will come
out of.

So the two halves of the old rule are separated. `withdrawal` says who decides - `auto` is the
bank, `flexible` is us - and the date says where it sits. The database constraint changed from
"an automatic item has a date and a flexible one does not" to "an automatic item must have a
date; a flexible one may have a date, or a payday to hang off, or neither, but never both".
The day is optional and the period key is unchanged, so choosing a day, changing it or clearing
it moves the row already on the ledger rather than adding a second one. A flexible row with a
date is still never counted as an automatic withdrawal to be covered.

The same date can be set on one occurrence from the ledger - "pay this month's late" - and
doing so makes that row the household's own, so the next generation pass leaves it where they
put it while later months stay on the planned day.

### Verified by hand

Against a real Postgres and the built server, over HTTP: renaming a bill and changing its
amount and day moved the row and recomputed every balance below it; a flexible bill given day 20
moved off the first payday onto the 20th in every month; pushing one month's to the 27th from
the ledger moved it into the next window and left the following month on the 20th; archiving a
bill took it off the ledger and dropped the coverage count. Each protection was also proved to
bite by stubbing it out and watching the right tests fail.

### Still to do

There are no component tests on the web side - the two web test files are source-level wiring
checks - so the new form field and the row's date editor are covered by the API tests underneath
them and by the hand check, not by a test that renders them.

## Settings: themes and text size (2026-11-09, at Dax's request)

Asked for as the last thing before the household starts using the app: a settings menu, several
themes including light and dark, and a text-size control that scales **down** from the current
size ("probably as large as we'd want to go").

### Where it lives, and where it does not

A `/settings` route reached from a gear in the header, not a sixth tab: five tabs is already as
many as a phone holds, and this is opened once in a while rather than several times a day.

**Neither choice is in the database, which is deliberate.** Everything else the app stores is a
household fact that changes the numbers; these are per-eye, per-screen preferences. A phone held
at arm's length in a dark room wants a different answer from a desktop in a bright kitchen, and
one person turning the text down must not shrink the other's. So they live in `localStorage`:
per device, per browser, never crossing the wire. They therefore reach no backup, which is
correct - losing them costs two taps.

Every read and write is guarded. `localStorage` *throws* rather than returning null in a private
window or with site data blocked, and an unguarded read would take the whole app down at startup
with a blank screen and no clue why.

### Themes

Five palettes: **Daylight** (the original), **Paper** (warm, low glare), **Clear** (high
contrast, firm edges), **Night** (the brand green after dark) and **Slate** (softer dark). Plus
**Match my device**, which follows `prefers-color-scheme` and updates live while that choice is
on.

The default stays Daylight, not "match my device": installing an update must never change how
the app looks without being asked.

Two things made this more than a palette swap.

- **Eight literal colours were scattered through the component stylesheets** - a white button
  label, the sheet's dim backdrop, the hero's hairline. Each one is a colour no theme can
  change, and each would have looked wrong in exactly one theme. They are now tokens
  (`--hr-on-primary`, `--hr-scrim`, `--hr-hero-divider` and so on), and a test fails on any
  literal colour outside `tokens.css`.
- **`color-scheme` is declared per theme**, so the scrollbars and - more importantly - the date
  pickers on the ledger follow the theme. The `color-scheme` meta in `index.html` is gone,
  because a meta saying "light" while a dark theme is on leaves those controls light.

The four `--hr-user-<name>-*` tokens were deleted: unused since the bubble colours moved into the
database, and they carried two household first names.

### Contrast is checked by arithmetic, not by eye

`theme-contrast.test.ts` computes WCAG relative luminance from `tokens.css` and holds every text
pair the stylesheets actually draw to 4.5:1, and borders and rings to 3:1. The pair list was read
off the real `color:` and `background:` declarations rather than invented.

This found a defect in the palette that had been shipped for months: `--hr-estimate-ring` was
2.9:1 on the page background, just under the 3:1 a meaningful border needs - and that ring is the
only thing distinguishing an estimate from a verified amount. Now #818883.

A theme is also checked for **completeness**: a block that leaves a token out does not fall back
to something sensible, it inherits Daylight's value, which in a dark theme is a white card in the
middle of a dark page, with no warning of any kind.

### Text size

Five steps from 1 down to 0.76, about 7% apart - enough to notice, small enough that no layout
jumps between two of them.

All 149 `font-size` declarations became `rem`, and `html` is `calc(100% * var(--hr-text-scale))`.
A percentage of the browser's own base rather than a px value, so someone who has set their phone
to larger text still gets it and the app's control sits on top. At scale 1 every computed size is
what it was, so the conversion itself changes nothing visible.

One exception: `.hr-input` is `max(16px, 1rem)`. iOS Safari zooms the page in when a field with
text smaller than 16px is focused, and does not zoom back out, so turning the text down would
otherwise make every amount field on the ledger lurch. Form fields therefore stay at 16px at
every scale. Say the word if uniform scaling is preferred - it is one line.

### Applied before the first paint

An inline script in `index.html` sets `data-theme` and the scale before the stylesheet runs.
In React instead, the browser paints Daylight at full size and then corrects itself, so every
load of a dark theme would start with a flash of white - worst in exactly the situation someone
chose dark for.

It reads the same two keys the store writes. The scale is stored as the **number** rather than a
name for it, so that script needs no copy of the table of sizes to drift from; `appearance.test.ts`
fails if the key names ever part company.

**For M5:** this inline script needs a hash or a nonce when the PWA adds a Content-Security-Policy.

### Not verified by eye

There is no browser in this environment, so the themes were checked by arithmetic, by the build,
and by a generated preview page built from the real `tokens.css` and sent to Dax to look at.
Nobody has yet seen the actual app in any theme other than Daylight.

## Bug 15: a received cheque came back as a ghost (2026-11-09, reported from testing)

Reported in this order: a paycheque was on the ledger, it was marked as received, and after that
the row could not be opened, edited or undone. The income entry was deleted under Manage to get
rid of it, and the ledger went on showing it anyway.

Three faults, one seam. A paycheque that is not on the timeline gets **projected** from the
payday instead - right when the cheque has simply not been generated yet, wrong in both of the
cases here, because "not on the timeline" was being used for three different situations.

### 1. A cheque that had already arrived was projected again

Clearing a row folds its money into the balance and takes the row off the timeline
(section 6.1). The payday then looked unplaced, so a cheque was projected for it: the same pay
counted twice in the window's "coming in", and an uneditable "Expected" row standing exactly
where the real one had been. That row is what looked "locked in" - it was never an occurrence,
so there was nothing to open.

`computePayPeriods` now takes `receivedPaycheques` and counts those paydays as placed.

### 2. Archiving the pay left the payday projecting forever

Which is why deleting the entry under Manage did not clear it: the row left behind was never
produced by the thing that was deleted. `paydaysWithoutPay` now stops a payday expecting a cheque
the household has turned off. The setup checklist still says the payday has no pay on the ledger,
which is the honest signal - silently showing no income would be worse than the ghost.

Neither fact can be derived inside the engine, so both are supplied by `timelineService`.

### 3. There was no way back from "Mark as received"

The API has always accepted `cleared: false`. Nothing in the app could reach it: clearing a row
removes it from the ledger, and the ledger is the only screen that lists rows. An accidental tap
was unrecoverable without SQL.

`GET /api/balance/cleared` lists what has been marked since the balance was last typed in, and
the ledger shows it as a collapsed "N marked received or paid" section with an Undo on each.

**It deliberately stops at the last balance entry.** Anything cleared before that is already
inside the figure someone read off the bank, so putting the row back would subtract it a second
time - the same double count in the other direction. Those need a fresh balance entry, not an
undo.

### Tidied on the way

- Three places were parsing `scheduleJson` to find which payday a paycheque follows. One
  `paydaysWithLivePay` now, used by the checklist, the projection and generation.
- `/api/balance/clearable` was sending `version: 1` for every candidate - a fabricated value
  nothing read. Removed rather than left to be believed.

### Verified by hand

The whole sequence, over HTTP against a real Postgres: pay on the ledger, marked received
(balance rises, row leaves, no ghost, undo offered), undone (balance back, row back, editable),
then archived (row goes, no ghost, checklist says the payday has no pay).

### Follow-up: a cleared row should not vanish (same day, Dax's question)

He asked whether marking a payday received should remove it from the ledger completely. It
should leave the running balance - that is the arithmetic, and section 6.1 says so - but it
should not leave the screen, which is what the implementation did by rendering only timeline
rows. A ledger whose lines silently disappear works against the one thing the app is for.

So the undo list became a band called **"Already in your balance"**, directly under the balance
that now includes it and above everything still to come: what landed, then what is in the
account, then what is coming. Shown rather than collapsed, since the problem being fixed is a
row disappearing. No running balance on those lines, because the figure above has counted them.

Offered as three options (band at the top, each row left in place and dimmed, or leave it as it
was) and he picked the band. The "in place and dimmed" version was the more ledger-like of the
two but reads as though a settled row is still to come, sitting below a balance that already
counted it.

The band's tint is a new surface for amounts, so the contrast test now checks the green
positive figure on it as well, in all five themes.

### Known gaps

- **A payday cannot be deleted.** There is no `DELETE /api/pay-schedules/:id`, only POST and
  PATCH, so a payday entered by mistake can only be edited. Not needed to unblock this report -
  archiving the pay now behaves - but it is the obvious next thing someone will try.
- **Projections are now close to dead code.** Generation covers the horizon plus a fortnight and
  the windows stop at the horizon, so every payday in view has a real cheque. They are kept as a
  safety net and are still tested, but nobody should expect to see an "Expected" row.

## Bug 16: "paid" was doing two jobs (2026-11-11, reported from use)

Two reports in one message, and the second one turned out to be a silent money bug.

### "A payday has no paycheque" with no way to resolve it

The checklist said this while both people's pay was entered under "Money coming in". It was
right, and nothing on screen could have explained why.

**"Money coming in" shows two different things in one list and never says which is which.** A
`paycheque` is created by a payday and is what anchors flexible bills and satisfies the
checklist. A `deposit` is what the only button there creates. They look identical in the list
and do completely different jobs - so re-adding archived pay by hand produced a deposit, and the
checklist went on complaining about something the list appeared to show.

It also pointed to the wrong place ("restore it under *Money coming in*" when an archived entry
is in a separate collapsed **Archived** section), named no person, and had no fix at all if the
cheque had been removed rather than archived, because nothing in the app creates a paycheque.

Now: the item names the person, one line per payday, and carries a button that restores the
archived cheque or creates one - `restorePaycheque`, which is the deliberate opposite of
archiving and so is allowed to do what automatic generation refuses. It also rebinds a hand-made
cheque to the payday by id, so the amount follows it afterwards. Income rows say which they are.

### "Mark as paid" moved the balance, and nobody knew

Carol's complaint was that a paid item disappears. Measuring it to answer that turned up worse:
marking a $186 bill paid dropped the balance by $186, because one flag was doing two unrelated
jobs - "we have dealt with this" and "this is already inside the balance I typed in".

Which means a bill that came out **before** the bank was read got subtracted twice: once inside
the typed figure and once again by the tick. The household is left short by the amount of the
bill with nothing on screen to say why. Dax had not realised it moved money at all:

> "I actually didn't realize that marking a bill paid actually moved the balance until now."

Offered three ways out; he chose the one that makes the double subtraction **impossible** rather
than merely fixed.

- **`paidAt`/`paidById` is new, and is a tick.** It records that the two of them have dealt with
  something. The row stays on the ledger, struck through with a "Paid" chip and who marked it,
  and goes on being counted in the running balance. No figure moves.
- **`clearedAt` keeps its one real job**: "this is inside the balance that was typed in", so the
  timeline stops counting it. Set only by the balance-update checklist, which is the one place
  that knows what the typed figure covered. It is no longer reachable from a row.
- **The two are joined up**: anything ticked on the ledger starts ticked on the balance
  checklist, so nobody has to say it twice - which is how a bill got counted twice.

The figures now only ever move when somebody types in a balance read off the bank, which is also
the conservative direction: safe-to-spend stays low until the bank is read, rather than rising
on a tick.

The "Already in your balance" band from two days ago is gone. It existed only because rows
vanished; they no longer do, and undo is tapping the row again. `GET /api/balance/cleared` went
with it.

Dax also asked whether paid-ness carries into the next cycle. It cannot: each cycle is its own
occurrence row, so ticking November says nothing about December. Tested.

### A test that was a time bomb

`generation.test.ts` used `day: 9` for a monthly bill, so for most of any month the next
occurrence fell past the horizon, generated fine and never reached the timeline. It had been
failing since the 10th and would have failed for two thirds of every month. Now derived from
today.

### Still to do

- **A payday still cannot be deleted.** No `DELETE /api/pay-schedules/:id`.
- **Nobody has seen any of this rendered.** There is no browser in this environment, so the paid
  row, the checklist button and the pre-ticked balance sheet are verified by tests and by HTTP
  against a real Postgres, not by eye.

## Git history and attribution (2026-11-09)

Dax asked for **no attribution lines in any commit** - no `Co-Authored-By`, no "Generated with
Claude Code" - and said so in the same message that approved the first push.

All 37 commits were rewritten to strip them **before** pushing, because afterwards it would have
needed a force-push, which the rules here forbid. One pass with `git filter-branch --msg-filter`
also normalised CRLF out of the message bodies and removed the blank lines the stripping left
behind.

What was checked afterwards, rather than assumed:

- the commit count is unchanged at 37;
- `HEAD^{tree}` is byte-identical to before the rewrite, so no file content moved;
- every tag still resolves to the same tree it did before;
- no raw commit object contains a carriage return or an attribution line.

A `git bundle` of the pre-rewrite history is in this session's scratchpad. It is the only copy:
the local backup branch and `refs/original/*` were cleaned up after the push succeeded. If the
history ever needs auditing against the original, that bundle is it - and it will not outlive the
scratchpad, which is the trade-off of keeping it out of the repository.

**Going forward: commit messages end at the last line of prose.** This is recorded in Claude's
memory for the project, so it survives a new session.

## Names, now the repository is public (2026-11-09)

The owner removed both household members' first names from the README himself, then: "I just
wanted names out of the readme. Moving forward we can stop using names. Eventually we will remove
them all from comments."

So:

- **New code, comments, docs, test data and commit messages use no first names** - "the
  household", "one person", "the other", or a role word.
- **Existing mentions stay for now.** About 600 across ~50 files, heaviest in this file and in the
  test suites, where the names are also test-user data. Removing them is agreed future work, not
  urgent, and the fixtures feed the golden tests so it needs a full run rather than a blind
  find-and-replace.
- **The pushed commit messages keep them.** Changing those would need a force-push, which the
  rules here forbid.

## Working agreements with Dax (this build is NOT autonomous)

CLAUDE.md describes an autonomous weekend build. That changed: Dax is available and answering questions.

- **Dax is available.** Ask rather than guessing, for anything that materially changes the build.
- **Pushing to git requires Dax's explicit OK each time.** Commit freely; never push or tag-push unprompted.
- Everything else in CLAUDE.md (money rules, integrity rules, conventional commits, milestone order) still stands.

## Decisions made without asking

- 2026-11-07 (planning): Name is Headroom. Stack per HANDOFF section 10. Defaults for open questions per HANDOFF section 14.
- 2026-11-08: **Ledger and year view are two separate screens**, not one long scroll. Asked twice
  and not answered, so taken as the default per CLAUDE.md. A 14-month ledger would be mostly
  estimates and would bury the near-term tight week. Say the word to merge them.
- 2026-11-08: **The golden fixture stays frozen** at the figures captured 2026-11-07, rather than
  re-captured from the copy Dax attached on 2026-11-08. Three cells had moved (the balance, two
  verification marks, and the bottom line that follows from them); the tests pin the old value and
  nothing depends on the new one.
- 2026-11-08: **The mortgage rate divisor follows Dax's spreadsheet** (annual rate / payments per
  year) rather than the Canadian semi-annual convention, so the app and the document he reads
  agree. The difference is a couple of hundred dollars of interest across the remaining term and
  does not move the payoff date by one payment. The lender's convention is available as a setting.
- 2026-11-08: **Goals became Savings** rather than a new tab beside it. The screen is now about one
  real account and what the money in it is for. Work expenses and banked hours stay on it, below
  the savings and mortgage sections: they were there before, they are all money outside the
  day-to-day ledger, and another tab would be one more place to look. The tab count is unchanged,
  and `/goals` redirects.
- 2026-11-08: **A savings balance goes through `POST /api/balance` with an `accountId`**, not a new
  endpoint. Typing in a balance read off the bank is one act with one set of rules - append-only,
  server clock, latest `asOf` wins - and a second endpoint would be that logic written twice.
  Ticking off cleared bills is refused for a non-chequing account rather than ignored.
- 2026-11-08: **A one-off's sign is decided by the server**, from its kind. This is a behaviour
  change: a `bill` sent with a positive amount is now stored negative. Nothing could create a
  one-off before, so no stored row is affected.
- 2026-11-08: **The mortgage can be removed** (soft, like everything else). A typo is fixable with
  a PATCH, but a mortgage that is paid off or refinanced needs a way out that is not SQL, since it
  drives a panel on Savings and a highlight on Year.
- 2026-11-08: **The one-off form lives on Upcoming for now.** It belongs in the merged ledger; it
  is on Upcoming because the gap it fills is real today and the merge is the next piece of work.

- 2026-11-08: **Home, Upcoming and Pay plan merged into one Ledger**, which is what was agreed in
  the discussion. The balance stays at the top of the scroll, so the instant answer CLAUDE.md asks
  for is still the first thing on screen.
- 2026-11-08: **`/api/timeline` is still served but no screen calls it.** The ledger reads
  `/api/pay-periods`, which now carries every row grouped into its window, so a second ungrouped
  fetch of the same rows would be a second copy of the screen's data. The endpoint is kept because
  the API tests use it as the engine's HTTP contract and it is the obvious place for a flat export.
  `useTimeline` was removed from the web app.
- 2026-11-08: **Only a one-off can be deleted.** Soft-deleting a generated occurrence would either
  be undone by the next generation run or made permanent, depending on how the period key matched,
  and neither is something anyone asked for. Those end by changing the bill on Manage.

- 2026-11-08: **A new mortgage defaults to its own payment dates**, not to following a payday,
  even though this household's follows one. The dates a lender sets are the common case and the
  safer default: anchoring to a payday means correcting that pay anchor later moves every mortgage
  payment with it. Theirs is set up the other way on purpose, and the form says which it is.
- 2026-11-08: **A biweekly paycheque still ignores the weekend rule**, while a biweekly bill obeys
  it. The rule is about when the bank takes money; pay arrives when the employer sends it, and
  turning on `friday_before` should not start moving paydays. Applying it to both would have been
  a silent change to existing behaviour.

## Decisions made WITH Dax (2026-11-07)

1. **No financial data in git, at all.** Dax's instruction, broader than CLAUDE.md's private-repo allowance. Consequences:
   - Git-ignored: `seed/household-nov-2026.json`, `docs/HANDOFF.md` (90 real figures in it), `design/` (all mockups embed real amounts), `reference/`, `headroom-handoff.zip`, `.env`.
   - Committed tests run against a **synthetic fixture** at `packages/core/test/fixtures/household-synthetic.json` — identical structure and dates, invented amounts, all expected values recomputed from those amounts.
   - The golden tests **also** run against the real seed whenever `seed/household-nov-2026.json` exists locally, so Dax's machine verifies the real numbers while CI never sees them.
   - The real data reaches the database through the `import-seed` CLI command (M6), never through git.
   - **Side effect to be aware of:** the repo therefore does not contain the spec (`docs/HANDOFF.md`) or the mockups. A clone is buildable and testable but not self-documenting. Offered to Dax: a redacted `HANDOFF.md` carrying all the rules with synthetic numbers substituted. Awaiting his call; not blocking.
2. **Database is a Postgres instance Dax already runs** (Unraid or elsewhere), not necessarily the compose `db` service. So:
   - `DATABASE_URL` in `.env` points at his server.
   - `docker-compose.yml` still defines a `db` service, but behind a compose **profile**, so `docker compose up` can run against the external Postgres instead. `docker compose --profile with-db up` brings up a self-contained stack.
   - `docs/DEPLOY.md` documents both routes.
3. **Tests use a throwaway Docker Postgres** (`postgres:17-alpine`), created and torn down per run; it never touches Dax's real database. CI uses a service container the same way.

## Environment notes

- Local Node is **v20.19.0**, not the Node 22 in the spec. Vite 7 accepts `^20.19.0`, so local dev and tests run fine. The Docker image and GitHub Actions both pin **Node 22**, which is what production runs.
- `gh` CLI is **not installed** on this machine, so CLAUDE.md's `gh repo view` visibility check could not run. CLAUDE.md's fallback is "treat the repo as public"; Dax confirmed directly that `DaxtonD/Headroom` is private. Moot either way now, since decision 1 keeps all real data out of git regardless of visibility.
- `psql` is not installed; database work goes through Prisma and containers.

## Answered for Dax (2026-11-08)

- **"Child tax credit is on the ledger but not in Manage."** Demo-data artefact, not a bug. Manage
  lists templates, and most demo rows were inserted as bare occurrences with no template. The API
  returns every template whatever its kind, and Manage has a "Money coming in" section for
  paycheques and deposits, so a recurring income entered through the app does appear. See the
  `import-seed` constraint above, which is the production version of this risk.
- **One deliberate exception to "everything on the ledger shows in Manage":** a one-off. It has no
  schedule and happens once, so it lives on the ledger only, where it can be edited or removed.
  Flagged to Dax in case he wants it listed somewhere too.

## Questions for Carol

From HANDOFF section 14. Each default is built and editable in the app where it is a household setting. **Amounts omitted on purpose** — see the note at the top of this file; the real values are in the local seed.

1. **Carol's cheque amount** differs between the two-week template and the daily ledger for her November payday. *Built:* the template amount is the recurring default; that one occurrence keeps the ledger amount.
2. **Monthly net income** on the budget screen is higher than the biweekly cheques plus the child tax credit work out to. *Built:* her stated monthly net income is used, as an editable value.
3. **Retirement growth** is a flat percentage applied once to the total, not compounded yearly. *Built:* her formula exactly; growth percent and method are editable settings, with a "compound yearly" option available and off.
4. **Who receives each bill?** *Built:* no owner assigned. Each bill shows "Set who gets this bill" and either user can set it. Mockup owner placeholders deliberately not used as data.
5. **Cushion** to leave after an automatic withdrawal for it to count as covered. *Built:* zero, editable in settings.
6. **Visa-paid items** (Rogers TV & Internet, Subscriptions). *Built:* v1 tracks chequing only; both templates stay inactive and the Visa balance is not modelled.
7. **Horizon** for "left this cycle". *Built:* through the day before the 4th upcoming paycheque, editable.
8. **Automatic withdrawals that land on a weekend.** *Built:* as scheduled, matching her sheet. Household setting "Weekend withdrawals: as scheduled / Friday before / next business day" with an engine test for each option.
9. **Savings transfer**: a per-pay-period amount in the template versus a single larger transfer in November. *Built:* recurring flexible transfer at the template amount per pay period; the November occurrence keeps its own amount.
10. **Christmas bonus and "Carol extra"** (blue rows). *Built:* not scheduled; either user can add them as one-offs.
11. **Banked hours.** *Built:* per user, hours only, no dollar conversion.
12. **Bank connection.** *Built:* the balance stays manual.

## Blocked / needs Dax

- **Every `git push` and tag push** waits on Dax's explicit OK, by his instruction. EVERY commit
  on `main` is still local, along with the tags `m0`, `m1` and `m2`. `main` has no upstream set,
  so `git push -u origin main` and `git push origin m0 m1 m2` are the first steps once he says so.
- **`APP_ORIGIN` in `.env`** is still the placeholder. It only matters at deploy time, and M6's
  `docs/DEPLOY.md` will say what to set it to. `DATABASE_URL` is filled in.
- **Nothing has run against Dax's own database.** Migrations and tests have only ever touched the
  throwaway Postgres, by design. Applying the schema to his server is a deploy step
  (`prisma migrate deploy`, which the container entrypoint runs) and needs his go-ahead.

## How to run

Requires Node 20.19+ (what Dax has installed), pnpm 9, and Docker for the test database.

```
pnpm install
cp .env.example .env            # fill DATABASE_URL and APP_ORIGIN
pnpm -F @headroom/api db:generate
pnpm -F @headroom/core build

node scripts/testdb.mjs up      # throwaway Postgres for tests
pnpm test                       # 248 tests
pnpm lint && pnpm typecheck
pnpm build
node scripts/testdb.mjs down
```

Run the whole thing in Docker:

```
docker compose up -d --build                      # against the Postgres Dax already runs
docker compose --profile with-db up -d --build     # or let Headroom bring its own
docker compose exec app node apps/api/dist/cli.js create-user
```

Verify a seed file's expected values:

```
python3 seed/check_seed.py                                                   # the real seed, if present
python3 seed/check_seed.py packages/core/test/fixtures/household-synthetic.json
python3 seed/make_synthetic_fixture.py                                       # regenerate the fixture
```
