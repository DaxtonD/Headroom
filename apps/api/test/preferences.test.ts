/**
 * How the app looks, stored against the person.
 *
 * Asked for on 2026-11-21: one of the two clears their browser every day, and
 * the theme, the text size and the ledger's density lived in `localStorage`
 * and nowhere else - so every morning the app greeted them in a theme and a
 * size they had not chosen. "I'd like to store the user preferences in the
 * server and load on login."
 *
 * ## What is worth a test here
 *
 * **`null` is not the defaults.** `/api/me` answers `preferences: null` for
 * somebody who has never chosen, and that is what tells a browser which
 * already has a choice to send it up rather than be reset by it. If this ever
 * starts answering with a filled-in set of defaults instead, the symptom is
 * that the first load after an update silently resets a phone that was set up
 * - which is the exact failure this feature exists to stop.
 *
 * **It is per person.** Two people share the money and not their eyes.
 *
 * **It is field level**, like every other PATCH here, so a build that learns
 * a fourth setting cannot clear the three it did not know about.
 *
 * **It takes neither `If-Match` nor `Idempotency-Key`**, which is the only
 * place in this app that is true, and is therefore worth holding deliberately
 * rather than leaving to be "fixed" by somebody applying the rule by rote. The
 * reasoning is beside the route in `apps/api/src/routes/auth.ts`: the row has
 * one writer by construction, holds no money, and a 409 on a theme would be a
 * question nobody could answer.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createHarness,
  migrateTestDatabase,
  seedHousehold,
  signIn,
  type Harness,
} from "./helpers/harness.js";

let harness: Harness;
let cookie: string;
let seeded: Awaited<ReturnType<typeof seedHousehold>>;

beforeAll(async () => {
  migrateTestDatabase();
  harness = await createHarness();
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.reset();
  seeded = await seedHousehold(harness);
  cookie = await signIn(harness, "alex@example.test", seeded.password);
});

interface PreferencesWire {
  readonly theme: string;
  readonly textSize: string;
  readonly ledgerDensity: string;
}

function me(as: string = cookie) {
  return harness.app.inject({ method: "GET", url: "/api/me", headers: { cookie: as } });
}

/**
 * The real client always sends an idempotency key - every write in `api.ts`
 * does - so these do too. The point is that the route does not REQUIRE one,
 * not that nobody sends one.
 */
function patch(payload: unknown, as: string = cookie) {
  return harness.app.inject({
    method: "PATCH",
    url: "/api/me/preferences",
    headers: { cookie: as, "idempotency-key": randomUUID() },
    payload,
  });
}

async function stored(as: string = cookie): Promise<PreferencesWire | null> {
  const response = await me(as);
  expect(response.statusCode, response.body).toBe(200);
  return response.json().preferences as PreferencesWire | null;
}

describe("before anybody has chosen", () => {
  /**
   * The load-bearing null. A set of defaults here would be indistinguishable
   * from a real choice, and a device that already had one would be reset by
   * it on the first load after this shipped.
   */
  it("says nothing rather than saying the defaults", async () => {
    expect(await stored()).toBeNull();
  });

  it("takes whatever the browser already had as the first answer", async () => {
    const seeding = await patch({ theme: "night", textSize: "small", ledgerDensity: "compact" });
    expect(seeding.statusCode, seeding.body).toBe(200);

    expect(await stored()).toEqual({
      theme: "night",
      textSize: "small",
      ledgerDensity: "compact",
    });
  });

  /** A first write that mentions one setting leaves the others at the defaults. */
  it("fills the rest in from the defaults on a partial first write", async () => {
    expect((await patch({ ledgerDensity: "compact" })).statusCode).toBe(200);

    expect(await stored()).toEqual({
      theme: "daylight",
      textSize: "largest",
      ledgerDensity: "compact",
    });
  });
});

describe("changing one thing", () => {
  beforeEach(async () => {
    await patch({ theme: "night", textSize: "small", ledgerDensity: "compact" });
  });

  it("leaves the settings it did not mention alone", async () => {
    const changed = await patch({ ledgerDensity: "comfortable" });
    expect(changed.statusCode, changed.body).toBe(200);

    expect(await stored()).toEqual({
      theme: "night",
      textSize: "small",
      ledgerDensity: "comfortable",
    });
  });

  it("answers with the whole set, not just what changed", async () => {
    const changed = await patch({ theme: "paper" });
    expect(changed.json().preferences).toEqual({
      theme: "paper",
      textSize: "small",
      // Untouched by this request, and still what the block set up.
      ledgerDensity: "compact",
    });
  });

  /** Setting a value is idempotent: sending it twice is sending it once. */
  it("is unbothered by the same change arriving twice", async () => {
    expect((await patch({ theme: "slate" })).statusCode).toBe(200);
    expect((await patch({ theme: "slate" })).statusCode).toBe(200);
    expect((await stored())?.theme).toBe("slate");
  });

  it("refuses a request that changes nothing", async () => {
    const empty = await patch({});
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error).toBe("nothing_to_change");
  });
});

describe("whose settings they are", () => {
  it("are one person's, not the household's", async () => {
    const other = await signIn(harness, "jordan@example.test", seeded.password);

    expect((await patch({ theme: "night" }, cookie)).statusCode).toBe(200);

    expect((await stored(cookie))?.theme).toBe("night");
    // The other person has still never chosen, and must not inherit this.
    expect(await stored(other)).toBeNull();
  });

  it("are refused to somebody who is not signed in", async () => {
    const out = await harness.app.inject({
      method: "PATCH",
      url: "/api/me/preferences",
      headers: { "idempotency-key": randomUUID() },
      payload: { theme: "night" },
    });
    expect(out.statusCode).toBe(401);
  });

  /**
   * Deleting a person takes their settings with them. Nothing else in the
   * schema points at this table, so there is nothing here anybody would want
   * to keep - which is why it is the one table with no `deletedAt`.
   *
   * On a user nobody has signed in as, so this is testing the cascade from
   * `user_preference` rather than every other thing that hangs off a person.
   */
  it("go when the person does", async () => {
    const passing = await harness.db.prisma.user.create({
      data: {
        householdId: seeded.household.id,
        name: "Temporary",
        initial: "T",
        email: "temporary@example.test",
        passwordHash: "not-a-real-hash",
      },
    });
    await harness.db.prisma.userPreference.create({
      data: { userId: passing.id, theme: "slate" },
    });

    await harness.db.prisma.user.delete({ where: { id: passing.id } });
    expect(
      await harness.db.prisma.userPreference.findUnique({ where: { userId: passing.id } }),
    ).toBeNull();
  });
});

describe("what the server will store", () => {
  /**
   * A short, boring token, and deliberately not a list of the names this
   * build knows. The themes, the sizes and the densities are tables in
   * `apps/web/src/lib/appearance.ts`, which already ignores a value it does
   * not recognise. A second list here would be a copy that lags behind the
   * first new theme, and the symptom would be the server refusing a choice
   * the app offers.
   */
  it("accepts a name it has never heard of, so a new theme needs no deploy here", async () => {
    expect((await patch({ theme: "midnight_orchard" })).statusCode).toBe(200);
    expect((await stored())?.theme).toBe("midnight_orchard");
  });

  it("refuses anything that is not a short plain name", async () => {
    for (const theme of ["", " ", "Night", "night!", "a".repeat(17), "<script>"]) {
      const bad = await patch({ theme });
      expect(bad.statusCode, `theme ${JSON.stringify(theme)}`).toBe(400);
    }
  });

  it("refuses a setting it does not have a column for", async () => {
    const bad = await patch({ theme: "night", wallpaper: "cats" });
    expect(bad.statusCode).toBe(400);
  });

  it("refuses a value that is not a string at all", async () => {
    expect((await patch({ textSize: 0.88 })).statusCode).toBe(400);
    expect((await patch({ theme: null })).statusCode).toBe(400);
  });
});

describe("the one mutation with no version and no idempotency key", () => {
  /**
   * Held deliberately. Every other write in this app refuses without both
   * headers, and somebody applying that rule by rote to this route would be
   * making it worse: there is no race to detect on a row with one writer, and
   * a 409 on a theme is a question nobody can answer. `push_subscription` is
   * the existing precedent for a per-person device fact written this way.
   */
  it("works with neither header present", async () => {
    const bare = await harness.app.inject({
      method: "PATCH",
      url: "/api/me/preferences",
      headers: { cookie },
      payload: { theme: "night" },
    });

    expect(bare.statusCode, bare.body).toBe(200);
    expect((await stored())?.theme).toBe("night");
  });

  it("ignores an If-Match rather than failing on it", async () => {
    const versioned = await harness.app.inject({
      method: "PATCH",
      url: "/api/me/preferences",
      headers: { cookie, "if-match": '"41"', "idempotency-key": randomUUID() },
      payload: { theme: "paper" },
    });

    expect(versioned.statusCode, versioned.body).toBe(200);
    expect((await stored())?.theme).toBe("paper");
  });

  /**
   * And it writes no activity. The log is the household's record of changes
   * to its money; what colour one person's phone is does not belong in it,
   * and two people's theme-fiddling would bury what does.
   */
  it("keeps how the app looks out of the household's history", async () => {
    const before = await harness.db.prisma.activity.count();
    await patch({ theme: "night", textSize: "medium", ledgerDensity: "compact" });
    expect(await harness.db.prisma.activity.count()).toBe(before);
  });
});
