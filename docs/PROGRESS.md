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
| M5 PWA + desktop polish | not started | | |
| M6 Ops: backups, seed import, GHCR, DEPLOY.md | not started | | |

## Last session

- Date: 2026-11-08
- **Nothing is pushed.** Every commit, and the tags `m0` through `m4`, are local only, awaiting Dax's OK.
- Done: the handoff, then M0 through M4, then the Manage screen and the expense model, then a
  second pass making every section of Manage editable.
- **499 tests green**: 232 engine, 197 API against a real Postgres, 70 web wiring checks. Lint,
  typecheck and `pnpm build` clean.

### Where each milestone stands

- **M0 scaffold** - done, tagged `m0`. Verified end to end in the built image.
- **M1 engine** - done, tagged `m1`. Reproduces every expected value in the seed.
- **M2 Home + Upcoming + integrity** - done, tagged `m2`. Every HANDOFF section 16.8 test passes.
- **M3 recurrence + Pay plan** - done, tagged `m3`. Generation never undoes an edit.
- **M4 Budget, Goals, Net worth** - done, tagged `m4`.
- **Manage screen + expense model** - done, untagged. Built at Dax's request before M5, then
  revised after he found that three of its sections were read-only.
- **M5, M6** - not started.

## Next session: start here

1. Read this file, then `CLAUDE.md`, then `docs/HANDOFF.md` (local only, git-ignored).
2. `pnpm install` and `node scripts/testdb.mjs up`, then `pnpm test`.
3. **M5 next**: PWA and polish. `vite-plugin-pwa` is a dependency but is not wired up, so
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
