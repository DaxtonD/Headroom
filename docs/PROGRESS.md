# Headroom progress log

Claude Code updates this file at the end of every milestone and every work session. Dax reads it to see where things stand without asking.

> **No real financial figures in this file.** Per Dax's decision on 2026-11-07, no household financial data is committed to git. This log refers to items by name only, never by amount.

## Status

| Milestone | Status | Tag | Notes |
|---|---|---|---|
| Handoff committed to repo | done | | Real-data files deliberately git-ignored (see "Decisions") |
| M0 Scaffold, CI, login, compose | done | m0 | Verified end-to-end in the built image: migrations, login, app shell |
| M1 Calculation engine + golden tests | done | m1 | Reproduces every expected value in BOTH the real seed and the synthetic fixture |
| M2 Home + Upcoming + integrity layer | not started | | |
| M3 Recurrence + Pay plan | not started | | |
| M4 Budget, Goals, Net worth | not started | | |
| M5 PWA + desktop polish | not started | | |
| M6 Ops: backups, seed import, GHCR, DEPLOY.md | not started | | |

## Last session

- Date: 2026-11-07
- Done:
  - Handoff unpacked; seed spec verified; `.env` created with generated secrets; `.gitignore` rewritten so no real financial data can be committed.
  - **M0 complete.** pnpm workspaces (`packages/core`, `apps/api`, `apps/web`), the full Prisma data model plus a migration of database-level guards, Zod-validated config, Argon2id login with server-side sessions, health check, operator CLI, Docker image, compose, GitHub Actions CI.
  - **M1 complete.** The engine reproduces every expected value in the seed: timeline ordering and running balances, lowest point, safe-to-spend, coverage and the first shortfall, left this cycle, all three pay periods, budget and section shares, goals, net worth and the whole retirement chain. Includes the shortfall case and the moved-flexible-bill case.
  - 248 tests green (194 engine, 54 API against a real Postgres); lint, typecheck and `pnpm build` clean.
- Next: M2 (Home + Upcoming + the section 16 integrity layer).
- **Nothing is pushed.** Every commit and tag is local, waiting on Dax's OK.

## Verified by hand, not only by tests

The built image was run against an empty database and checked end to end:

- both migrations applied from scratch;
- `/api/health` returns `ok` with the database up;
- `GET /` serves the app shell, and a deep link (`/upcoming`) serves it too, so a bookmarked page survives a cold load;
- fingerprinted assets come back `immutable`, `index.html` comes back `no-cache`;
- `create-user` created the household and both accounts, with no password in `.env` or on a command line;
- sign-in worked, the cookie is `HttpOnly` and signed, `/api/me` returned both members, and a wrong password returned 401;
- starting the image with an incomplete configuration exits 78 and names the missing variable.

## Bugs caught before deploy (all fixed)

Worth recording, because each would have been invisible until it mattered:

1. **Two not-found handlers.** Fastify allows one per prefix, so the app could not start at all. A single handler now decides both the API 404 and the single-page-app fallback.
2. **A global `pg` int8 type parser.** Added so raw queries would return `BigInt`; it broke *every* Prisma write, because Prisma's driver adapter relies on the driver's default and converts the value itself. Removed, with a note so it is not re-added.
3. **BigInt serialization.** `setSerializerCompiler` only applies to routes that declare a response schema, so `/api/me` returned 500 on the household's cushion. Now `setReplySerializer`, which covers every reply.
4. **The login limiter counted successful sign-ins**, while `.env.example` documents `LOGIN_RATE_LIMIT` as failed attempts. Carol could have locked herself out of her own finances. Replaced with a failure-only throttle that a correct password clears.
5. **`pino-pretty` in the production image.** `NODE_ENV=development` against the built image crashed at startup, because the pretty transport is a dev dependency. Pretty logging is now used only when the module is actually present.
6. **Asset cache headers did nothing.** `@fastify/static` sets its own `cache-control` and overrode them, and the pattern looked for `.hash.js` while Vite emits `name-HASH.js`. Both fixed, then verified against the running container.
7. **A pinned base image tag that did not exist** (`node:22.23.4-alpine3.22`). Now `node:22.23.4-alpine`.
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

- **`DATABASE_URL` and `APP_ORIGIN` in `.env`** — Dax is filling the connection string for the database he already created. Both are marked `>>> FILL IN <<<` in the file. Not blocking the scaffold, engine or unit tests; needed before migrations run against his database.
- **Every `git push` and tag push** waits on Dax's explicit OK, by his instruction.

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
