# Headroom

Household budget web app / PWA for Dax and Carol that replaces Carol's budget spreadsheet. Carol opens it several times a day; the home screen must show the chequing balance and how much is safe to spend, instantly.

- Full spec: `docs/HANDOFF.md`. Read all of it before writing code.
- Running log: `docs/PROGRESS.md`. **If you are resuming (new session or after context compaction), read it first** and continue from the first unfinished item.
- Seed data and golden expected values: `seed/household-nov-2026.json` (check with `python3 seed/check_seed.py`).
- Mockup sources (reference only): `design/`.

## Operating mode: autonomous

Dax is not available this weekend. Build the whole app, milestone by milestone (HANDOFF section 13), without stopping to ask questions.

- Unclear? Use the default in HANDOFF section 14, or the most conservative reasonable choice. Make it an editable household setting where that makes sense. Record it in `docs/PROGRESS.md` under "Decisions made without asking" (and under "Questions for Carol" if she should confirm). Keep going.
- Only stop work on an item if it needs a credential you don't have, touches Dax's Unraid server or any machine other than this one, or is irreversible outside this repo. Log it under "Blocked / needs Dax" and move on to other work.
- Never weaken the integrity rules or the money rules below to get something working.
- Finish each milestone fully (tests green, PROGRESS.md updated, committed, pushed, tagged) before starting the next.

## Git

- Remote: `https://github.com/DaxtonD/Headroom`, default branch `main`.
- First session only: if the repo isn't cloned yet, clone it and copy the handoff package contents (including hidden files: `.env.example`, `.gitignore`, `.claude/`) into the repo root.
- Before the first commit, check visibility: `gh repo view DaxtonD/Headroom --json visibility`. **If PUBLIC:** add `seed/household-nov-2026.json` to `.gitignore`, keep every real figure out of git, put synthetic fixtures with the same structure under `packages/core/test/fixtures/`, and have golden tests also run against the real seed when the local file exists. Log this in PROGRESS.md. If `gh` is unavailable, treat the repo as public.
- Trunk-based on `main`. Small conventional commits (`feat:`, `fix:`, `test:`, `chore:`, `docs:`, `ci:`).
- Commit whenever a coherent step is green. Push after every milestone and at the end of every work session, so nothing lives only on this machine.
- Tag each finished milestone: `m0` ... `m6` (`git tag m1 && git push origin m1`).
- Never force-push, rewrite pushed history, or commit `.env`, secrets, database dumps or `reference/`.

## Stack (approved; do not re-litigate)

pnpm workspaces: `apps/web` (React 19, TypeScript, Vite, vite-plugin-pwa, React Router, TanStack Query), `apps/api` (Node 22, Fastify, Prisma, Zod), `packages/core` (pure TypeScript calculation engine, shared by web and api). PostgreSQL 17. Vitest. Multi-stage Dockerfile producing one app image; `docker-compose.yml` with `app`, `db` and a backup sidecar. GitHub Actions for CI and publishing `ghcr.io/daxtond/headroom`.

## Non-negotiables

- Money is integer cents (`bigint`). No floats anywhere. Display `en-CA` CAD with U+2212 minus.
- Timezone `America/Regina` (no DST). Server clock is authoritative.
- Store facts; derive every total with `packages/core`. Never persist running balances, safe-to-spend, left-over or coverage.
- Every mutation: field-level PATCH + `If-Match` version + `Idempotency-Key`. Same-field conflict returns 409; different fields auto-merge. Balance snapshots and activity are append-only. Writes are online-only; offline is a read-only cache; no Background Sync. (HANDOFF section 16.)
- `packages/core` must reproduce every expected value in the seed (golden tests). The section 16 integrity tests must run against a real Postgres (docker service, local install, or the `embedded-postgres` package), not mocks.
- Config only via environment variables validated at startup. Every new variable goes into `.env.example` with a comment in the same commit.
- Accessibility: 44 px touch targets, 4.5:1 text contrast, real `<button>`/`<input>`/`<label>`.
- `seed/` and `reference/` contain real household finances. Never paste their contents into issues, logs or commit messages.

## Commands

Keep this list current as you build.

- `python3 seed/check_seed.py`: verify the seed spec.
- (add: install, dev, test, lint, typecheck, build, `docker compose up --build`, create-user, import-seed)

## Definition of done

M0 to M6 complete and tagged, CI green, `docker compose up --build` works from a clean clone with only `.env` filled in, the GHCR image is published, `docs/DEPLOY.md` gives Dax copy-paste Unraid steps, and `docs/PROGRESS.md` lists every decision made and every question for Carol.
