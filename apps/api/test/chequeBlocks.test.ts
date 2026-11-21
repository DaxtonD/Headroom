/**
 * What each cheque leaves behind, end to end against a real Postgres.
 *
 * ## Where this came from
 *
 * On 2026-11-20 the household described how the spreadsheet Headroom
 * replaces is actually used, on a phone, several times a day: type the
 * balance at the top, then drag a selection from one paycheque down to the
 * row above the next one and read the sum off the bottom of the screen.
 *
 * That sum had no equivalent anywhere in the app. The pay-period total is
 * not it - a window is a fortnight and holds a cheque from each person, so
 * it answers for two at once and cannot say which of the two weeks is the
 * tight one. The running balance beside those rows is not it either: it
 * carries everything from today forward, so it still contains whatever the
 * previous cheque left over, and clearing that out is the entire point of
 * starting the selection at the cheque.
 *
 * ## Why against a real database
 *
 * `packages/core/test/chequeBlocks.test.ts` already proves the arithmetic
 * and the reconciliation against every seed on the machine. What it cannot
 * prove is that a block survives the trip: that the ids it names still match
 * the rows the same response carries, that a cheque with an occurrence and a
 * cheque projected from a schedule both open one, and that a cheque already
 * in the bank opens nothing. All of those are about data the engine never
 * sees in a unit test.
 *
 * Dates are built from today, because every figure in Headroom is. Every
 * amount is invented.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createHarness,
  inDays,
  migrateTestDatabase,
  seedHousehold,
  signIn,
  type Harness,
} from "./helpers/harness.js";

let harness: Harness;
let cookie: string;
let alexId: string;
let jordanId: string;
let householdId: string;

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
  alexId = seeded.alex.id;
  jordanId = seeded.jordan.id;
  householdId = seeded.household.id;
  cookie = await signIn(harness, "alex@example.test", seeded.password);
});

function headers() {
  return { cookie, "idempotency-key": randomUUID() };
}

function post(url: string, payload: unknown) {
  return harness.app.inject({ method: "POST", url, headers: headers(), payload });
}

function get(url: string) {
  return harness.app.inject({ method: "GET", url, headers: { cookie } });
}

interface Block {
  readonly kind: "balance" | "cheque" | "unopened";
  readonly openerId: string | null;
  readonly date: string | null;
  readonly inCents: string;
  readonly outCents: string;
  readonly leftCents: string;
  readonly entryIds: string[];
}

interface Period {
  readonly label: string;
  readonly isCurrentPartial: boolean;
  readonly leftCents: string;
  readonly rowIds?: string[];
  readonly blocks: Block[];
  readonly rows: {
    id: string;
    name: string;
    kind: string;
    runningCents: string;
    settled: boolean;
  }[];
  readonly projectedPaycheques: { scheduleId: string; date: string }[];
}

async function periods(): Promise<Period[]> {
  const response = await get("/api/pay-periods");
  expect(response.statusCode, response.body).toBe(200);
  return response.json().periods as Period[];
}

/**
 * Two earners paid on alternating weeks, as cheques nobody has placed yet.
 *
 * This is the arrangement the household actually has, and the one that makes
 * a fortnight hold two cheques.
 */
async function seedAlternatingSchedules() {
  await harness.db.prisma.paySchedule.create({
    data: {
      userId: jordanId,
      anchorDate: new Date(`${inDays(-1)}T00:00:00Z`),
      defaultCents: 200_000n,
    },
  });
  await harness.db.prisma.paySchedule.create({
    data: {
      userId: alexId,
      anchorDate: new Date(`${inDays(6)}T00:00:00Z`),
      defaultCents: 180_000n,
    },
  });
}

/**
 * A payday through the API, which also creates the paycheque template that
 * generates its rows - the arrangement a household gets by default.
 */
async function addSchedule(userId: string, daysOut: number, cents: string) {
  const response = await post("/api/pay-schedules", {
    userId,
    anchorDate: inDays(daysOut),
    defaultCents: cents,
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json().paySchedule as { id: string };
}

/** An automatic bill on a given day, which leaves chequing. */
async function addBill(name: string, daysOut: number, cents: string) {
  const target = inDays(daysOut);
  const [, month, day] = target.split("-");

  const created = await post("/api/templates", {
    name,
    kind: "bill",
    defaultCents: cents,
    withdrawal: "auto",
    schedule: { type: "monthly", day: Number(day), month: Number(month) },
    section: "fixed",
  });
  expect(created.statusCode, created.body).toBe(201);
  return target;
}

function sum(values: readonly string[]): bigint {
  return values.reduce((total, value) => total + BigInt(value), 0n);
}

/* -------------------------------------------------------------------------- */

describe("the blocks a window is made of", () => {
  it("gives every window at least one, and reconciles with its total", async () => {
    await seedAlternatingSchedules();
    await addBill("Mortgage", 2, "97450");
    await addBill("Power", 8, "14250");

    const windows = await periods();
    expect(windows.length).toBeGreaterThan(0);

    for (const period of windows) {
      expect(period.blocks.length, period.label).toBeGreaterThan(0);

      /*
       * The property the screen depends on. A block's figure is printed a few
       * rows above the band carrying the window's own, so the two are read
       * together whether or not anybody means to compare them. If they ever
       * disagree the page is self-evidently wrong, and the household stops
       * believing the rest of it.
       */
      expect(sum(period.blocks.map((block) => block.leftCents)), period.label).toBe(
        BigInt(period.leftCents),
      );
    }
  });

  it("puts every row and projected cheque in exactly one block", async () => {
    await seedAlternatingSchedules();
    await addBill("Mortgage", 2, "97450");

    for (const period of await periods()) {
      const placed = period.blocks.flatMap((block) => block.entryIds);
      expect(new Set(placed).size, `${period.label} counts a row twice`).toBe(placed.length);

      const onScreen = [
        ...period.rows.map((row) => row.id),
        ...period.projectedPaycheques.map((cheque) => `${cheque.scheduleId}|${cheque.date}`),
      ];
      expect([...placed].sort(), period.label).toEqual([...onScreen].sort());
    }
  });

  /**
   * Only the window that starts today opens with money already in hand. A
   * later one opening on a balance would be spending it twice.
   */
  it("opens on the balance only in the window starting today", async () => {
    await seedAlternatingSchedules();

    for (const period of await periods()) {
      const onBalance = period.blocks.some((block) => block.kind === "balance");
      expect(onBalance, period.label).toBe(period.isCurrentPartial);
    }
  });

  it("names an opener the same response carries", async () => {
    await seedAlternatingSchedules();
    await addBill("Mortgage", 2, "97450");

    const windows = await periods();
    const known = new Set(
      windows.flatMap((period) => [
        ...period.rows.map((row) => row.id),
        ...period.projectedPaycheques.map((cheque) => `${cheque.scheduleId}|${cheque.date}`),
      ]),
    );

    for (const period of windows) {
      for (const block of period.blocks) {
        if (block.kind !== "cheque") continue;
        expect(block.openerId).not.toBeNull();
        expect(known.has(block.openerId ?? ""), `${period.label}: ${block.openerId ?? ""}`).toBe(
          true,
        );
      }
    }
  });
});

describe("what a cheque has to cover", () => {
  /**
   * The number the drag produces, and the reason it is worth showing: it is
   * not on any row. The running balance beside the last row of a block still
   * carries what the previous cheque left over.
   */
  it("differs from the running balance beside the same row", async () => {
    await seedAlternatingSchedules();
    await addBill("Mortgage", 2, "97450");
    await addBill("Power", 3, "14250");

    const windows = await periods();
    const chequeBlocks = windows.flatMap((period) =>
      period.blocks
        .filter((block) => block.kind === "cheque")
        .map((block) => ({ block, period })),
    );
    expect(chequeBlocks.length).toBeGreaterThan(0);

    const rowsById = new Map(
      windows.flatMap((period) => period.rows.map((row) => [row.id, row] as const)),
    );

    let compared = 0;
    for (const { block } of chequeBlocks) {
      // The last row of the block that is a real row with a balance on it.
      const last = [...block.entryIds].reverse().find((id) => rowsById.has(id));
      if (last === undefined) continue;

      const running = BigInt(rowsById.get(last)?.runningCents ?? "0");
      const left = BigInt(block.leftCents);

      // They answer different questions, so they come apart as soon as any
      // earlier cheque has left anything behind. If these were ever equal
      // across the board the feature would be printing a figure the column
      // beside it already gave.
      if (running !== left) compared += 1;
    }

    expect(compared, "every cheque's left-over equalled a running balance").toBeGreaterThan(0);
  });

  /**
   * Pay this engine cannot recognise for itself.
   *
   * Reported from the ledger on 2026-11-21: a fortnight holding two cheques
   * printed ONE "left from this cheque", and the figure on it was both
   * cheques added together. One person's pay is entered by hand - the
   * paycheque archived, the money re-entered as a deposit - which is an
   * arrangement this app supports and `restorePaycheque.test.ts` was written
   * about. The block split was keyed on `kind === "paycheque"`, saw an
   * ordinary deposit, opened nothing, and folded a whole cheque's stretch
   * into the next one.
   *
   * Against the database because that is where the arrangement lives: a
   * template archived, a deposit template in its place, and a pay schedule
   * that still sets the cadence with nothing projecting from it.
   */
  it("is opened by pay entered by hand as a deposit", async () => {
    const jordanSchedule = await addSchedule(jordanId, -1, "200000");
    await addSchedule(alexId, 6, "180000");

    // Archive the paycheque the schedule generated, as the household did.
    const template = await harness.db.prisma.template.findFirstOrThrow({
      where: { householdId, kind: "paycheque", deletedAt: null },
      // The one bound to the schedule being turned off.
    });
    expect((template.scheduleJson as { payScheduleId?: string }).payScheduleId).toBe(
      jordanSchedule.id,
    );
    const archived = await harness.app.inject({
      method: "PATCH",
      url: `/api/templates/${template.id}`,
      headers: { ...headers(), "if-match": `"${template.version}"` },
      payload: { active: false },
    });
    expect(archived.statusCode, archived.body).toBe(200);

    // The same money, typed in the only way the app offers: a deposit.
    const deposit = await post("/api/templates", {
      name: "Pay",
      kind: "deposit",
      section: "income",
      defaultCents: "211340",
      withdrawal: "auto",
      schedule: { type: "biweekly", anchorDate: inDays(13) },
    });
    expect(deposit.statusCode, deposit.body).toBe(201);

    // A bill between the two cheques, so each block has something to cover.
    await addBill("Mortgage", 15, "97450");

    const windows = await periods();
    const fortnight = windows.find((period) =>
      period.rows.some((row) => row.kind === "deposit"),
    );
    expect(fortnight, "a window should hold the deposit").toBeDefined();

    const byHand = fortnight?.rows.find((row) => row.kind === "deposit");
    const cheque = fortnight?.rows.find((row) => row.kind === "paycheque");
    const mortgage = fortnight?.rows.find((row) => row.name === "Mortgage");
    expect(byHand, "the deposit").toBeDefined();
    expect(cheque, "the other person's cheque").toBeDefined();
    expect(mortgage, "the bill between them").toBeDefined();

    // One block per cheque, not one for the pair of them.
    const chequeBlocks = (fortnight?.blocks ?? []).filter((block) => block.kind === "cheque");
    expect(chequeBlocks).toHaveLength(2);

    const first = chequeBlocks.find((block) => block.entryIds.includes(byHand?.id ?? ""));
    expect(first, "the deposit should open a block").toBeDefined();
    expect(first?.openerId).toBe(byHand?.id);
    // What that cheque has to cover, and nothing belonging to the next one.
    expect(first?.entryIds).toContain(mortgage?.id);
    expect(first?.entryIds).not.toContain(cheque?.id);
    expect(BigInt(first?.leftCents ?? "0")).toBe(211_340n - 97_450n);

    // And the window still reconciles with its own band.
    for (const period of windows) {
      expect(sum(period.blocks.map((block) => block.leftCents)), period.label).toBe(
        BigInt(period.leftCents),
      );
    }
  });

  /**
   * A cheque in the bank is history: the balance the window opens with has
   * already been past it. Opening a block on one would put a heading over
   * the settled rows with a left-over of zero under them.
   */
  it("is not opened by a cheque that has already landed", async () => {
    // A real schedule, so a paycheque occurrence exists to be marked.
    const created = await post("/api/pay-schedules", {
      userId: alexId,
      anchorDate: inDays(0),
      defaultCents: "200000",
    });
    expect(created.statusCode, created.body).toBe(201);

    const before = await periods();
    const cheque = before
      .flatMap((period) => period.rows)
      .find((row) => row.kind === "paycheque");
    expect(cheque, "a paycheque row should exist").toBeDefined();

    const openersBefore = before
      .flatMap((period) => period.blocks)
      .filter((block) => block.openerId === cheque?.id);
    expect(openersBefore).toHaveLength(1);

    // Tick it: the money has arrived and the balance at the top now holds it.
    const row = await harness.db.prisma.occurrence.findUniqueOrThrow({
      where: { id: cheque?.id ?? "" },
      select: { version: true },
    });
    const paid = await harness.app.inject({
      method: "PATCH",
      url: `/api/occurrences/${cheque?.id ?? ""}`,
      headers: { ...headers(), "if-match": `"${row.version}"` },
      payload: { paid: true },
    });
    expect(paid.statusCode, paid.body).toBe(200);

    const after = await periods();
    const openersAfter = after
      .flatMap((period) => period.blocks)
      .filter((block) => block.openerId === cheque?.id);
    expect(openersAfter).toHaveLength(0);

    // And the window still reconciles with a cheque gone from its blocks.
    for (const period of after) {
      expect(sum(period.blocks.map((block) => block.leftCents)), period.label).toBe(
        BigInt(period.leftCents),
      );
    }
  });

  /**
   * The invariant that matters, over both kinds of cheque.
   *
   * Inside the horizon the generator places a real occurrence for a payday,
   * and past it the window counts one projected from the schedule. Which of
   * the two a given cheque is depends on where today falls, so testing only
   * the projected kind tests whichever arrangement the calendar happens to
   * be in today. Every cheque still to come opens exactly one block,
   * whichever way it reached the screen.
   */
  it("gives every cheque still to come exactly one block", async () => {
    await seedAlternatingSchedules();
    await addBill("Mortgage", 2, "97450");

    const windows = await periods();

    const coming = [
      ...windows.flatMap((period) =>
        period.rows.filter((row) => row.kind === "paycheque" && !row.settled).map((row) => row.id),
      ),
      ...windows.flatMap((period) =>
        period.projectedPaycheques.map((cheque) => `${cheque.scheduleId}|${cheque.date}`),
      ),
    ];
    expect(coming.length, "the seed should produce some pay").toBeGreaterThan(0);

    const openers = windows
      .flatMap((period) => period.blocks)
      .filter((block) => block.kind === "cheque")
      .map((block) => block.openerId);

    for (const id of coming) {
      expect(openers.filter((opener) => opener === id), `cheque ${id}`).toHaveLength(1);
    }
    // And nothing else opened one.
    expect(openers.length).toBe(coming.length);
  });
});
