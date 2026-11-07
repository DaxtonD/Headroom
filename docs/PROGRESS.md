# Headroom progress log

Claude Code updates this file at the end of every milestone and every work session. Dax reads it to see where things stand without asking.

> **No real financial figures in this file.** Per Dax's decision on 2026-11-07, no household financial data is committed to git. This log refers to items by name only, never by amount.

## Status

| Milestone | Status | Tag | Notes |
|---|---|---|---|
| Handoff committed to repo | done | | Real-data files deliberately git-ignored (see "Decisions") |
| M0 Scaffold, CI, login, compose | in progress | | |
| M1 Calculation engine + golden tests | not started | | |
| M2 Home + Upcoming + integrity layer | not started | | |
| M3 Recurrence + Pay plan | not started | | |
| M4 Budget, Goals, Net worth | not started | | |
| M5 PWA + desktop polish | not started | | |
| M6 Ops: backups, seed import, GHCR, DEPLOY.md | not started | | |

## Last session

- Date: 2026-11-07
- Done: Handoff package unpacked into the repo. Seed spec verified (`python3 seed/check_seed.py` → OK, every expected value reproduces). `.env` created locally from `.env.example` with freshly generated `SESSION_SECRET` and `POSTGRES_PASSWORD`; Dax fills `DATABASE_URL` and `APP_ORIGIN`. `.gitignore` rewritten so that no real financial data can be committed.
- Next: M0 scaffold (pnpm workspaces, Prisma schema, Fastify API, React web, login, health check, compose, CI).

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

(fill in as the project takes shape)
