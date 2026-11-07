/**
 * Prisma CLI configuration (Prisma 7).
 *
 * Prisma 7 no longer reads `url` from schema.prisma and no longer loads `.env`
 * on its own, so migrate and introspect get their connection string here.
 * The application's runtime connection is separate: see `src/db.ts`, which
 * builds a PrismaClient over the `pg` driver adapter.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "prisma/config";

// The single .env lives at the repo root so compose, the API and the CLI all
// read the same file.
//
// An explicit DATABASE_URL in the environment always wins, and the file is not
// read at all in that case. This matters: tests point DATABASE_URL at a
// throwaway Postgres, and loading the root .env over the top of that would aim
// migrations and destructive test fixtures at the household's real database.
const rootEnv = resolve(import.meta.dirname, "../../.env");
if (!process.env.DATABASE_URL && existsSync(rootEnv)) {
  process.loadEnvFile(rootEnv);
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: process.env.DATABASE_URL,
    // Only needed for `prisma migrate dev` against a database where the user
    // cannot create the shadow database itself.
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
  migrations: {
    path: "prisma/migrations",
  },
});
