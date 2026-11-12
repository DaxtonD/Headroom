/**
 * Resolving "a payday is not putting any money on the ledger".
 *
 * Reported from use: the checklist said this, both people's pay was entered
 * under "Money coming in", and there was no obvious way to act on it.
 *
 * Both halves of that were real. The message named no person, so with two
 * entries in the list there was no way to tell which was wrong. And what the
 * checklist asks for is a `paycheque` bound to that payday - while the only
 * button on the screen adds a `deposit`, which sits in the same list, looks
 * like income, and does none of the things a paycheque does: it anchors no
 * flexible bill and claims no payday. So whatever was entered by hand, the
 * checklist went on complaining and said to restore something from a section
 * it was not in.
 *
 * Every amount here is invented.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, migrateTestDatabase, seedHousehold, signIn, type Harness } from "./helpers/harness.js";

let harness: Harness;
let cookie: string;
let householdId: string;
let firstMemberId: string;
let secondMemberId: string;

beforeAll(async () => {
  migrateTestDatabase();
  harness = await createHarness();
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.reset();
  const seeded = await seedHousehold(harness);
  householdId = seeded.household.id;
  firstMemberId = seeded.carol.id;
  secondMemberId = seeded.dax.id;
  cookie = await signIn(harness, "carol@example.test", seeded.password);
});

function post(url: string, payload: unknown) {
  return harness.app.inject({
    method: "POST",
    url,
    headers: { cookie, "idempotency-key": randomUUID() },
    payload,
  });
}

function patch(url: string, version: number, payload: unknown) {
  return harness.app.inject({
    method: "PATCH",
    url,
    headers: { cookie, "idempotency-key": randomUUID(), "if-match": `"${String(version)}"` },
    payload,
  });
}

function get(url: string) {
  return harness.app.inject({ method: "GET", url, headers: { cookie } });
}

function nextThursday(weeksAhead = 0): string {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + ((4 - date.getUTCDay() + 7) % 7) + 7 * weeksAhead);
  return date.toISOString().slice(0, 10);
}

async function addPayday(userId: string, weeksAhead = 0): Promise<{ id: string }> {
  const response = await post("/api/pay-schedules", {
    userId,
    anchorDate: nextThursday(weeksAhead),
    defaultCents: "210000",
  });
  expect(response.statusCode).toBe(201);
  return response.json().paySchedule as { id: string };
}

interface SetupBody {
  readonly missing: readonly string[];
  readonly paydaysWithoutPay: readonly { readonly scheduleId: string; readonly person: string }[];
}

function setup(): Promise<SetupBody> {
  return get("/api/setup").then((response) => response.json() as Promise<SetupBody>);
}

function paycheques() {
  return harness.db.prisma.template.findMany({
    where: { householdId, kind: "paycheque", deletedAt: null },
  });
}

describe("the checklist item", () => {
  it("says whose payday it is", async () => {
    const schedule = await addPayday(firstMemberId);
    const template = (await paycheques())[0] as { id: string; version: number };
    await patch(`/api/templates/${template.id}`, template.version, { active: false });

    const body = await setup();
    expect(body.missing).toContain("income_on_ledger");

    // With two people entered, "a payday has no paycheque" left no way to
    // tell which one was wrong.
    expect(body.paydaysWithoutPay).toEqual([{ scheduleId: schedule.id, person: "Carol" }]);
  });

  it("names each payday separately", async () => {
    await addPayday(firstMemberId);
    await addPayday(secondMemberId, 1);

    for (const template of await paycheques()) {
      await patch(`/api/templates/${template.id}`, template.version, { active: false });
    }

    const body = await setup();
    expect(body.paydaysWithoutPay.map((payday) => payday.person).sort()).toEqual(["Carol", "Dax"]);
  });

  it("is not satisfied by a deposit entered by hand", async () => {
    /*
     * Exactly what happened: the pay was archived, income was re-entered
     * through the only button available - which makes a deposit - and the
     * checklist went on complaining about something the list appeared to show.
     */
    const schedule = await addPayday(firstMemberId);
    const template = (await paycheques())[0] as { id: string; version: number };
    await patch(`/api/templates/${template.id}`, template.version, { active: false });

    const deposit = await post("/api/templates", {
      name: "My pay",
      kind: "deposit",
      section: "income",
      defaultCents: "210000",
      withdrawal: "auto",
      schedule: { type: "biweekly", anchorDate: nextThursday() },
    });
    expect(deposit.statusCode).toBe(201);

    const body = await setup();
    expect(body.paydaysWithoutPay.map((payday) => payday.scheduleId)).toEqual([schedule.id]);
  });
});

describe("putting the pay back", () => {
  it("restores the archived cheque, with its cheques", async () => {
    const schedule = await addPayday(firstMemberId);
    const template = (await paycheques())[0] as { id: string; version: number; name: string };
    await patch(`/api/templates/${template.id}`, template.version, { active: false });
    expect(await harness.db.prisma.occurrence.count({ where: { householdId } })).toBe(0);

    const restored = await post(`/api/pay-schedules/${schedule.id}/paycheque`, {});
    expect(restored.statusCode).toBe(200);
    expect(restored.json().restored).toBe(true);

    // The same template, brought back - not a second one beside it.
    const live = await paycheques();
    expect(live.length).toBe(1);
    expect((live[0] as { id: string }).id).toBe(template.id);
    expect((live[0] as { active: boolean }).active).toBe(true);

    // And the cheques are on the ledger again.
    expect(
      await harness.db.prisma.occurrence.count({ where: { householdId, kind: "paycheque" } }),
    ).toBeGreaterThan(0);
    expect((await setup()).missing).not.toContain("income_on_ledger");
  });

  it("creates one when there is nothing to restore", async () => {
    const schedule = await addPayday(firstMemberId);

    // Removed rather than archived, which generation will not undo on its own.
    for (const template of await paycheques()) {
      await harness.db.prisma.template.update({
        where: { id: template.id },
        data: { deletedAt: new Date(), deletedById: firstMemberId },
      });
    }
    expect((await setup()).missing).toContain("income_on_ledger");

    const restored = await post(`/api/pay-schedules/${schedule.id}/paycheque`, {});
    expect(restored.statusCode).toBe(200);
    expect(restored.json().restored).toBe(true);

    expect((await paycheques()).length).toBe(1);
    expect((await setup()).missing).not.toContain("income_on_ledger");
  });

  it("rebinds a hand-made cheque to the payday it follows", async () => {
    const schedule = await addPayday(firstMemberId);

    // The shape the old setup advice produced: owned by a person, with dates
    // of its own rather than naming the payday.
    for (const template of await paycheques()) {
      await harness.db.prisma.template.update({
        where: { id: template.id },
        data: {
          active: false,
          ownerUserId: firstMemberId,
          scheduleJson: { type: "biweekly", anchorDate: nextThursday() },
        },
      });
    }

    const restored = await post(`/api/pay-schedules/${schedule.id}/paycheque`, {});
    expect(restored.statusCode).toBe(200);

    // Bound by id now, so correcting the payday moves the cheques with it.
    const live = (await paycheques())[0] as { scheduleJson: unknown };
    expect(live.scheduleJson).toEqual({ type: "biweekly", payScheduleId: schedule.id });
    expect((await setup()).missing).not.toContain("income_on_ledger");
  });

  it("says so, and changes nothing, when the pay is already there", async () => {
    const schedule = await addPayday(firstMemberId);
    const before = await paycheques();

    const again = await post(`/api/pay-schedules/${schedule.id}/paycheque`, {});
    expect(again.statusCode).toBe(200);
    expect(again.json().restored).toBe(false);

    expect(await paycheques()).toEqual(before);
  });

  it("touches only the payday it was asked about", async () => {
    const first = await addPayday(firstMemberId);
    await addPayday(secondMemberId, 1);

    for (const template of await paycheques()) {
      await patch(`/api/templates/${template.id}`, template.version, { active: false });
    }

    await post(`/api/pay-schedules/${first.id}/paycheque`, {});

    const body = await setup();
    expect(body.paydaysWithoutPay.map((payday) => payday.person)).toEqual(["Dax"]);
  });

  it("refuses a payday from another household", async () => {
    // Built by hand rather than with seedHousehold, whose email addresses are
    // fixed and would collide with the household already seeded.
    const other = await harness.db.prisma.household.create({ data: { name: "Next door" } });
    const theirPerson = await harness.db.prisma.user.create({
      data: {
        householdId: other.id,
        name: "Sam",
        initial: "S",
        email: "sam@elsewhere.test",
        passwordHash: "x",
        colorFg: "#2A3C8F",
        colorBg: "#E3E7F7",
      },
    });
    const theirs = await harness.db.prisma.paySchedule.create({
      data: {
        userId: theirPerson.id,
        anchorDate: new Date(`${nextThursday()}T00:00:00.000Z`),
        defaultCents: 100_000n,
      },
    });

    const response = await post(`/api/pay-schedules/${theirs.id}/paycheque`, {});
    expect(response.statusCode).toBe(404);
  });
});
