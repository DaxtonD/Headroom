/**
 * Migrations, checked without a database.
 *
 * ## Why this exists
 *
 * A migration here tried to back-fill a column on `activity` with an UPDATE.
 * It failed against a database with rows in it - "Table activity is
 * insert-only", the trigger from `20261107000100_integrity_guards` doing its
 * job - and it would have stopped production from starting, because
 * `migrate deploy` runs on container boot.
 *
 * The suite was green the whole time. The trigger is `FOR EACH ROW`, and the
 * test database is empty when migrations run, so an UPDATE that touches no
 * rows fires no trigger and passes. **No amount of running the suite against
 * a real Postgres catches this**, because the thing that makes it fail is
 * data the test database does not have.
 *
 * So it is checked statically instead, which also means it is caught on a
 * machine with no Docker at all.
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATIONS = resolve(import.meta.dirname, "..", "prisma", "migrations");

/** Tables the integrity guards make insert-only. */
const INSERT_ONLY = ["activity", "balance_snapshot"] as const;

interface Migration {
  readonly name: string;
  readonly sql: string;
}

const migrations: readonly Migration[] = readdirSync(MIGRATIONS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => ({
    name: entry.name,
    sql: readFileSync(resolve(MIGRATIONS, entry.name, "migration.sql"), "utf8"),
  }));

/**
 * The SQL with comments stripped.
 *
 * Every migration in this repository explains itself at length, and those
 * explanations mention the very statements being searched for - including
 * this one, which describes the UPDATE that caused it.
 */
function statements(sql: string): string {
  return sql
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("the migrations", () => {
  it("are all there", () => {
    expect(migrations.length).toBeGreaterThanOrEqual(12);
    expect(migrations.some((migration) => migration.name.includes("integrity_guards"))).toBe(true);
  });

  it.each(INSERT_ONLY)("never rewrite %s", (table) => {
    /*
     * An append-only table is append-only for migrations too. Needing to
     * change one of these rows means the fact was recorded wrongly, and the
     * answer is a new row - or, as it turned out last time, reading what was
     * already stored rather than moving it.
     */
    const forbidden = new RegExp(
      `\\b(update|delete\\s+from)\\s+"?${table}"?\\b`,
      "i",
    );

    for (const migration of migrations) {
      const found = forbidden.exec(statements(migration.sql));
      expect(
        found,
        `${migration.name} tries to ${found?.[1] ?? "rewrite"} ${table}, which the ` +
          "integrity guards forbid. It will pass against the empty test database and " +
          "fail on boot in production.",
      ).toBeNull();
    }
  });

  it("do not disable the integrity guards to get something through", () => {
    /*
     * The other way past the trigger is to turn it off for the length of the
     * migration. That is weakening an integrity rule to make a change fit,
     * which is the one thing this project does not do.
     */
    for (const migration of migrations) {
      const sql = statements(migration.sql);
      if (migration.name.includes("integrity_guards")) continue;

      expect(sql, `${migration.name} disables a trigger`).not.toMatch(/DISABLE\s+TRIGGER/i);
      expect(sql, `${migration.name} drops an insert-only trigger`).not.toMatch(
        /DROP\s+TRIGGER[^;]*insert_only/i,
      );
      expect(sql, `${migration.name} sets session_replication_role`).not.toMatch(
        /session_replication_role/i,
      );
    }
  });
});
