/**
 * Two clocks that have to agree.
 *
 * Found in production: the app container was running 5 hours 51 minutes
 * ahead of the Postgres it writes to. Every timestamp the app set was in the
 * future - and, far worse, so was its idea of *today*, which every figure on
 * every screen is derived from. The database's clock was correct the whole
 * time, and nothing anywhere compared the two, so the only way to see it was
 * to subtract row timestamps from `now()` by hand.
 *
 * `/api/health` now reports both. The next time it happens it is one request
 * away instead of an afternoon of inference.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, migrateTestDatabase, type Harness } from "./helpers/harness.js";

let harness: Harness;

beforeAll(async () => {
  migrateTestDatabase();
  harness = await createHarness();
});

afterAll(async () => {
  await harness.close();
});

interface HealthBody {
  readonly serverTime: string;
  readonly databaseTime: string | null;
  readonly clockSkewSeconds: number | null;
}

async function health(): Promise<HealthBody> {
  const response = await harness.app.inject({ method: "GET", url: "/api/health" });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as HealthBody;
}

describe("the health check", () => {
  it("reports the database's clock as well as its own", async () => {
    const body = await health();
    expect(body.serverTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.databaseTime, "the database's own clock is the whole point").not.toBeNull();
    expect(body.databaseTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("states the difference between them as a number", async () => {
    const body = await health();
    expect(typeof body.clockSkewSeconds).toBe("number");
    // One machine runs both here, so they are the same clock.
    expect(Math.abs(body.clockSkewSeconds ?? 9999)).toBeLessThan(60);
  });

  it("is still reachable without signing in, and still says nothing about the household", async () => {
    const response = await harness.app.inject({ method: "GET", url: "/api/health" });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toMatch(/cents|household|chequing/i);
  });
});
