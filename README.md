# Headroom

A household budget web app / PWA for our family, built to replace a complex budget spreadsheet. Shows the chequing balance, how much is safe to spend before the next bill, every upcoming paycheque and bill with a running balance, two-week pay periods, the monthly budget, goals, net worth and the retirement outlook.

Status: **M0 scaffold in progress.** See [docs/PROGRESS.md](docs/PROGRESS.md) for where things stand, every decision made, and the open questions.
## No financial data in this repository

By decision on 2026-11-07, **no real household financial data is committed to git**. These paths are git-ignored and exist only on local machines (they ship in `headroom-handoff.zip`):

| Path | Why |
|---|---|
| `seed/household-nov-2026.json` | The real November figures |
| `docs/HANDOFF.md` | The full spec; quotes ~90 real amounts |
| `design/` | Mockup sources; embed real amounts as sample data |
| `reference/` | Scan of Carol's original sheet |
| `.env` | Secrets and the database connection string |

Committed tests run against a **synthetic fixture** (`packages/core/test/fixtures/household-synthetic.json`) with the same structure and dates but invented amounts. The golden tests additionally run against the real seed whenever that file is present locally, so a developer machine verifies the real numbers while CI never sees them. Real data reaches the database only through the `import-seed` command.

`seed/check_seed.py` recomputes every expected value in a seed file from its inputs; it contains no figures of its own.

```
python3 seed/check_seed.py                       # the real seed, if present
python3 seed/check_seed.py packages/core/test/fixtures/household-synthetic.json
```

## Repository layout

```
apps/web        React 19 + TypeScript + Vite PWA (phone first)
apps/api        Node 22 + Fastify + Prisma + Zod; serves /api and the built web app
packages/core   Pure TypeScript calculation engine, shared by web and api
docs/           PROGRESS.md (running log), DEPLOY.md (Unraid steps)
seed/           check_seed.py (the real seed file is git-ignored)
```

## Getting started

Requires Node 20.19+ (Node 22 recommended; production runs 22), pnpm 9, and Docker for the test database.

```
pnpm install
cp .env.example .env     # then fill DATABASE_URL and APP_ORIGIN
pnpm typecheck
pnpm test
pnpm dev
```

## Commands

Kept current as the project is built; see CLAUDE.md.

| Command | What it does |
|---|---|
| `pnpm install` | Install all workspace dependencies |
| `pnpm dev` | Run the API and the web dev server together |
| `pnpm test` | Vitest across all packages |
| `pnpm typecheck` | TypeScript project-wide, no emit |
| `pnpm lint` | ESLint across all packages |
| `pnpm build` | Build `packages/core`, `apps/api` and `apps/web` |
| `python3 seed/check_seed.py [path]` | Verify a seed file's expected values |

Deployment, backups and restore: [docs/DEPLOY.md](docs/DEPLOY.md) (written in M6).

## Documentation

- [CLAUDE.md](CLAUDE.md) — working rules: money rules, integrity rules, git conventions, milestones.
- [docs/PROGRESS.md](docs/PROGRESS.md) — milestone status, decisions, questions for Carol, blockers.
- `docs/HANDOFF.md` — the full spec. Local only, not in git (see above).
