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
| M3 Recurrence + Pay plan | done | m3 | Generation never undoes an edit; flexible bills move between periods |
| M4 Budget, Goals, Net worth | done | m4 | Every retirement assumption editable; shares are of the section |
| Manage screen + expense model | done | | Added at Dax's request, before M5. One entry feeds timeline and budget. Second pass: every section editable |
| Biweekly/monthly redesign | done | | Agreed with Dax 2026-11-08. Engine, schema, API, Year screen, Savings screen, and Home+Upcoming+Pay plan merged into one Ledger |
| Biweekly expenses | done | | At Dax's request. Any expense can be every two weeks on its own dates; the mortgage can be anchored either way |
| M5 PWA + desktop polish | not started | | |
| M6 Ops: backups, seed import, GHCR, DEPLOY.md | not started | | |

## Last session

- Date: 2026-11-08
- **Nothing is pushed.** Every commit, and the tags `m0` through `m4`, are local only, awaiting Dax's OK.
- Done: the handoff, then M0 through M4, then the Manage screen and the expense model, then a
  second pass making every section of Manage editable, then the whole biweekly/monthly redesign:
  engine, schema and migration, the savings and mortgage API, the Year screen, the Savings screen,
  and Home + Upcoming + Pay plan merged into one Ledger.
- **682 tests green**: 305 engine, 274 API against a real Postgres, 103 web source checks. Lint,
  typecheck and `pnpm build` clean.
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
3. The redesign is finished, so **M5 next**: PWA and polish. `vite-plugin-pwa` is a dependency but is not wired up, so
   there is no manifest, no icons and no service worker. Needs: the installable manifest and
   icons, the read-only offline cache behind the "Offline, as of ..." banner that
   `useLiveUpdates` already drives, the App Badging API for the count of unverified bills, an
   "Update balance" manifest shortcut, desktop layouts, and the accessibility pass
   (44px targets, 4.5:1 contrast).
4. Then M6: backup sidecar with a tested restore, `import-seed` for the real figures, the
   GHCR image, and finishing `docs/DEPLOY.md`.

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
