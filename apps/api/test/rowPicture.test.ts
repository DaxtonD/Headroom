/**
 * Which picture a ledger row wears.
 *
 * Reported from use, 2026-11-19: "when adding a one-off to pay the VISA, the
 * image for the VISA isn't also placed on the ledger." The row showed a
 * lettered square beside an entry whose whole subject is the Visa - while the
 * Visa's own picture sat two inches up the same screen, in "On cards".
 *
 * The cause was narrow: a row's picture came from `template.imageId`, and a
 * one-off has no template. So the row fell through to the fallback with
 * nothing to say it was about an account that has a picture of its own.
 *
 * A row now takes the picture of the account the money LANDS IN when it has
 * no template of its own. Deliberately not the account it comes FROM: a
 * charge paid from a card is a purchase rather than the card, it already
 * names the card in a chip, and wearing the card's logo would say the row is
 * the card itself.
 *
 * Every amount is invented.
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
import { distinctWebp } from "./helpers/webp.js";

let harness: Harness;
let cookie: string;

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

async function uploadPicture(seed: number): Promise<string> {
  const response = await post("/api/images", {
    base64: distinctWebp(seed).toString("base64"),
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json().image.id as string;
}

async function addAccount(name: string, kind: string, imageId?: string) {
  const response = await post("/api/accounts", {
    name,
    kind,
    ...(imageId === undefined ? {} : { imageId }),
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json().account.id as string;
}

/** The row on the ledger with this name, whatever window it landed in. */
async function rowNamed(name: string): Promise<{ imageId: string | null } | undefined> {
  const body = await get("/api/timeline").then((response) => response.json());
  return (body.rows as { name: string; imageId: string | null }[]).find(
    (row) => row.name === name,
  );
}

describe("a one-off that pays an account", () => {
  it("wears the picture of the account it pays", async () => {
    const picture = await uploadPicture(1);
    const visaId = await addAccount("Visa", "credit_card", picture);

    const created = await post("/api/occurrences", {
      name: "Visa",
      kind: "transfer",
      cents: "31042",
      date: inDays(1),
      transferToAccountId: visaId,
    });
    expect(created.statusCode, created.body).toBe(201);

    expect((await rowNamed("Visa"))?.imageId).toBe(picture);
  });

  it("works the same for a payment into savings", async () => {
    const picture = await uploadPicture(2);
    const savingsId = await addAccount("Savings", "savings", picture);

    const created = await post("/api/occurrences", {
      name: "Into savings",
      kind: "transfer",
      cents: "25000",
      date: inDays(1),
      transferToAccountId: savingsId,
    });
    expect(created.statusCode, created.body).toBe(201);

    expect((await rowNamed("Into savings"))?.imageId).toBe(picture);
  });

  it("has no picture when the account it pays has none", async () => {
    const visaId = await addAccount("Visa", "credit_card");

    const created = await post("/api/occurrences", {
      name: "Visa",
      kind: "transfer",
      cents: "31042",
      date: inDays(1),
      transferToAccountId: visaId,
    });
    expect(created.statusCode, created.body).toBe(201);

    // The lettered square, which is a real answer rather than a broken one.
    expect((await rowNamed("Visa"))?.imageId).toBeNull();
  });

  /**
   * A charge is a purchase, not the card.
   *
   * It names the card in a chip already. Wearing the card's logo would claim
   * the row IS the card, and then a Visa payment and a coffee bought on the
   * Visa would be indistinguishable at a glance - which is the opposite of
   * what the picture is there for.
   */
  it("does not wear the picture of the card it is charged to", async () => {
    const picture = await uploadPicture(3);
    const visaId = await addAccount("Visa", "credit_card", picture);

    const created = await post("/api/occurrences", {
      name: "Groceries",
      kind: "bill",
      cents: "8400",
      date: inDays(1),
      paidFromAccountId: visaId,
    });
    expect(created.statusCode, created.body).toBe(201);

    expect((await rowNamed("Groceries"))?.imageId).toBeNull();
  });

  /**
   * A picture somebody chose beats one worked out from where the money went.
   */
  it("keeps a template's own picture ahead of the destination's", async () => {
    const cardPicture = await uploadPicture(4);
    const ownPicture = await uploadPicture(5);
    const visaId = await addAccount("Visa", "credit_card", cardPicture);

    const created = await post("/api/occurrences", {
      name: "Visa payment",
      kind: "transfer",
      cents: "31042",
      date: inDays(1),
      transferToAccountId: visaId,
    });
    expect(created.statusCode, created.body).toBe(201);
    const occurrenceId = created.json().occurrence.id as string;

    // Attach it to a template that has a picture of its own.
    const template = await post("/api/templates", {
      name: "Visa payment",
      kind: "transfer",
      defaultCents: "31042",
      withdrawal: "auto",
      schedule: { type: "monthly", day: 1 },
      transferToAccountId: visaId,
      imageId: ownPicture,
    });
    expect(template.statusCode, template.body).toBe(201);

    await harness.db.prisma.occurrence.update({
      where: { id: occurrenceId },
      data: { templateId: template.json().template.id as string },
    });

    expect((await rowNamed("Visa payment"))?.imageId).toBe(ownPicture);
  });
});
