# Headroom

Household budget web app / PWA for a two-person household, replacing the spreadsheet it was run from. It is opened several times a day; the home screen must show the chequing balance and how much is safe to spend, instantly.

- Full spec: `docs/HANDOFF.md`. Read all of it before writing code.
- Running log: `docs/PROGRESS.md`. **If you are resuming (new session or after context compaction), read it first** and continue from the first unfinished item.
- Seed data and golden expected values: `seed/household-nov-2026.json` (check with `python3 seed/check_seed.py`).
- Mockup sources (reference only): `design/`.
- Ideas raised but **not** decided: `docs/IDEAS.md`. Nothing in it is agreed, scheduled or
  started. Do not begin any of it without the owner saying so.

## Operating mode

**Superseded on 2026-11-07: this build is NOT autonomous.** The owner is available and
answering questions, so ask rather than guess whenever an answer would change the work. Two
standing instructions from them override what follows:

1. **Never push without their explicit OK.** Commit and tag locally as usual; pushing waits.
2. **No real financial data in git, ever** - broader than the private-repo allowance below.
   See `docs/PROGRESS.md` for what is git-ignored as a result.

The rest of this section still describes the intended rhythm: build the whole app, milestone by
milestone (HANDOFF section 13), keeping each one green before starting the next.

- Unclear? Use the default in HANDOFF section 14, or the most conservative reasonable choice. Make it an editable household setting where that makes sense. Record it in `docs/PROGRESS.md` under "Decisions made without asking" (and under "Questions for the household" if it needs confirming). Keep going.
- Only stop work on an item if it needs a credential you don't have, touches the owner's Unraid server or any machine other than this one, or is irreversible outside this repo. Log it under "Blocked / needs the owner" and move on to other work.
- Never weaken the integrity rules or the money rules below to get something working.
- Finish each milestone fully (tests green, PROGRESS.md updated, committed, pushed, tagged) before starting the next.

## Git

- Remote: `https://github.com/DaxtonD/Headroom`, default branch `main`.
- First session only: if the repo isn't cloned yet, clone it and copy the handoff package contents (including hidden files: `.env.example`, `.gitignore`, `.claude/`) into the repo root.
- Before the first commit, check visibility: `gh repo view DaxtonD/Headroom --json visibility`. **If PUBLIC:** add `seed/household-nov-2026.json` to `.gitignore`, keep every real figure out of git, put synthetic fixtures with the same structure under `packages/core/test/fixtures/`, and have golden tests also run against the real seed when the local file exists. Log this in PROGRESS.md. If `gh` is unavailable, treat the repo as public.
- Trunk-based on `main`. Small conventional commits (`feat:`, `fix:`, `test:`, `chore:`, `docs:`, `ci:`).
- **`dev` follows `main`.** Standing instruction from the owner, 2026-11-20: whenever work
  lands on `main`, bring `dev` up to it in the same session - `git checkout dev && git merge
  --ff-only main && git push origin dev`, then back to `main`. It is always a fast-forward,
  because `dev` is only ever used to try something out and is merged back before the next
  push. If it ever is not a fast-forward, stop and ask rather than reconciling it. This is
  the one push that does not need to be asked for each time; everything else still does.
- Commit whenever a coherent step is green. Push after every milestone and at the end of every work session, so nothing lives only on this machine.
- Tag each finished milestone: `m0` ... `m6` (`git tag m1 && git push origin m1`).
- Never force-push, rewrite pushed history, or commit `.env`, secrets, database dumps or `reference/`.

## Stack (approved; do not re-litigate)

pnpm workspaces: `apps/web` (React 19, TypeScript, Vite, vite-plugin-pwa, React Router, TanStack Query), `apps/api` (Node 22, Fastify, Prisma, Zod), `packages/core` (pure TypeScript calculation engine, shared by web and api). PostgreSQL 17. Vitest. Multi-stage Dockerfile producing one app image; `docker-compose.yml` with `app`, `db` and a backup sidecar. GitHub Actions for CI and publishing `ghcr.io/daxtond/headroom`.

## Non-negotiables

- Money is integer cents (`bigint`). No floats anywhere. Display `en-CA` CAD with U+2212 minus.
- Timezone `America/Regina` (no DST). Server clock is authoritative.
- Store facts; derive every total with `packages/core`. Never persist running balances, safe-to-spend, left-over or coverage.
- **Money between accounts**: `accountDelta` in `packages/core/src/timeline.ts` is the only place
  that decides a sign. A row's source is `paidFromAccountId` (null means chequing) and its
  destination `transferToAccountId`; a card's typed balance is what it OWES, a positive
  magnitude, and the engine projects that as a negative balance so one engine runs every
  account. Do not add a second sign rule anywhere, and do not give the engine a default source -
  it refuses a row without one for a reason (see `docs/PROGRESS.md`). A charge on a card keeps
  its budget section; a template that **pays** a card must not have one, or the same money is
  budgeted twice.
- Every mutation: field-level PATCH + `If-Match` version + `Idempotency-Key`. Same-field conflict returns 409; different fields auto-merge. Balance snapshots and activity are append-only. Writes are online-only; offline is a read-only cache; no Background Sync. (HANDOFF section 16.)
- `packages/core` must reproduce every expected value in the seed (golden tests). The section 16 integrity tests must run against a real Postgres (docker service, local install, or the `embedded-postgres` package), not mocks.
- Config only via environment variables validated at startup. Every new variable goes into `.env.example` with a comment in the same commit.
- Accessibility: 44 px touch targets, 4.5:1 text contrast, real `<button>`/`<input>`/`<label>`.
- `seed/` and `reference/` contain real household finances. Never paste their contents into issues, logs or commit messages.

## Commands

Keep this list current as you build.

- `pnpm install`: install every workspace's dependencies.
- `pnpm dev`: API and web dev server together.
- `pnpm test`: Vitest everywhere. The API tests need a Postgres; see `testdb` below.
- `pnpm lint`, `pnpm typecheck`, `pnpm build`.
- `pnpm -F @headroom/api db:generate | db:migrate | db:deploy`: Prisma client and migrations.
- `node scripts/testdb.mjs up | down`: throwaway Postgres for tests, never the real database.
- `PIN_DATE=2026-12-21 pnpm -F @headroom/api test`: run the API suite as if it were another
  day. Every figure is built from "today", so a test with a hardcoded date tests one
  arrangement of today and goes red by the calendar; this is how that is caught. Pin to
  today or later only - the database's own clock is not faked.
- `python3 seed/check_seed.py [path]`: verify a seed file's expected values. With no path it checks the local real seed and skips cleanly when absent.
- `python3 seed/make_synthetic_fixture.py`: regenerate the committed synthetic fixture.
- **Icons are drawn, not generated.** Every file in `apps/web/public/` is authored artwork
  from the icon package, committed as delivered except for one correction on 2026-11-18: the
  whole set was slid right so the two bars of the H sit in the middle of the canvas. The
  delivered artwork centred the full outline, arrowhead included, which left the H itself
  visibly left of centre on a home screen. It was a whole-pixel translation per file, so the
  drawing is untouched - do not "restore" the originals. The masters are
  `assets/headroom-icon.svg` and `assets/headroom-icon.png`. `scripts/make_icons.py` used to
  derive them from one PNG and was removed on 2026-11-17, because it would have overwritten a
  hand-tuned maskable with a script's crop. To change the logo, replace the set and the
  masters together - `apps/web/test/pwa.test.ts` checks every manifest icon exists at the size
  it claims. The Unraid template's icon lives beside it in `unraid/`.
- `pnpm check:figures`: fail if a real household figure has reached a tracked file. Reads the
  git-ignored seed for what to look for, so it only works on the owner's machine and skips
  cleanly elsewhere (CI has no seed by design). Catches distinctive amounts - the ones with odd
  cents - not round ones. A hand audit on 2026-11-15 found three real round figures it had let
  through, so treat it as a safety net and never as a substitute for the rule.
- `node scripts/backup.mjs dump | verify <file> | list | restore <file> --yes`: back up the
  database and prove the dump restores. `verify` restores into a throwaway database and counts
  what came back, so "I have a dump" and "I can get my data back" are the same claim. Runs
  `pg_dump` in a container, so nothing has to be installed. Dumps go in `backups/`, which is
  git-ignored because they contain the household's real figures.
- `npx web-push generate-vapid-keys`: the one-off key pair notifications need.
  Set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` together - the server
  refuses to start on a partial set - in the container's environment and in `.env`. With
  none of them set, notifications are simply off and Settings says so. Changing the pair
  later silently invalidates every subscription, so treat it as permanent once a phone is
  subscribed.
- `curl <origin>/api/health`: what is actually running. `buildId` is the commit the image was
  built from, stamped in by CI. The web bundle carries the same value and Settings shows both,
  so an installed app sitting on a stale service-worker cache is visible rather than guessed at
  - which it had to be, twice, before this existed.
- `docker compose up -d --build`: run against the Postgres the owner already has. Kept for a
  local run only - compose is not how this is deployed (see Definition of done).
- `docker compose --profile with-db up -d --build`: run with a bundled Postgres.
- `docker compose exec app node apps/api/dist/cli.js create-user | list-users | reset-password`.
  In production these run through Unraid's console on the container, not through compose.

## Definition of done

Revised 2026-11-15, because three of the original gates described work the owner has since
retired and one described a thing that was already finished. What is actually required:

- **M0 to M5 complete and tagged.** Done. `m0` to `m5` all exist locally and on the remote,
  `m5` at 4f007a7. This said M5 was "awaiting its tag" until 2026-11-18, which was wrong and
  was read as meaning the work itself had never been pushed - check `git ls-remote --tags
  origin` before believing a line like this one. **M6 is empty** - its three items were
  backups, `docs/DEPLOY.md` and a verified compose run, and the owner took all three over or
  dropped them on 2026-11-14.
- **CI green**, with the GHCR image published only when lint, typecheck and every test pass.
- **The app runs from the GHCR image**, added as a plain container through Unraid's Docker
  Manager and pulling `latest`. This replaces the old gate of `docker compose up --build` from
  a clean clone: compose is not part of the owner's workflow and never will be. `docs/DEPLOY.md`
  is written and keeps both routes documented anyway.
- **Backups are the owner's own Duplicati job to Backblaze.** `scripts/backup.mjs` stays
  available for a dump whose restore has actually been proven, and Duplicati should be pointed
  at a folder of those dumps rather than at a live Postgres data directory.
- **`docs/PROGRESS.md` lists every decision made and every open question for the household.**
