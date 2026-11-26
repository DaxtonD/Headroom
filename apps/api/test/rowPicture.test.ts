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
 * A row now takes the picture of whichever account it is about, in order of
 * how specific that is: the bill's own picture, then the account the money
 * landed in, then the account it came out of - chequing included, which is
 * the account a row with no source names.
 *
 * That order arrived in three goes, because the first two left a row with no
 * picture at all in a case the household then met: a charge paid FROM a card
 * (2026-11-20) and an ordinary bill paid from chequing (2026-11-25, "all
 * accounts should show their photo"). Both reversals went the same way, so
 * the tests below assert the opposite of what two of them once did.
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

/**
 * Give the household's chequing account a picture, and return it.
 *
 * The seeded account rather than a new one, and that distinction cost three
 * red tests: "the chequing account" is the FIRST account of that kind, by
 * creation order, because that is the account every chequing figure is about.
 * Adding a second chequing account and decorating that one left the picture
 * on an account no row resolves to - which is also a real limitation worth
 * knowing: a household's second chequing account cannot be a row's source
 * (`routing.ts` keeps every chequing-kind account out of the source picker)
 * and so can never put its picture on a row.
 */
async function givePictureToChequing(seed: number): Promise<string> {
  const picture = await uploadPicture(seed);
  const response = await harness.app.inject({
    method: "PATCH",
    url: `/api/accounts/${seeded.account.id}`,
    headers: { cookie, "idempotency-key": randomUUID(), "if-match": '"1"' },
    payload: { imageId: picture },
  });
  expect(response.statusCode, response.body).toBe(200);
  return picture;
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

  it("has no picture when nothing it names has one", async () => {
    // The seeded chequing account has no picture either, so there is nothing
    // anywhere in the chain to find - which is what makes the square below a
    // real answer rather than this test passing by luck.
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
   * A charge wears the picture of the card it went on.
   *
   * This test used to assert the opposite, on the argument that a charge is a
   * purchase rather than the card and that the card's logo would claim the
   * row IS the card. The household used it and disagreed, 2026-11-20: "I just
   * made a purchase on Amazon today. It was charged to our Visa... now, on
   * the ledger, there is no picture."
   *
   * A row about a card beats a row about nothing, and the distinction the old
   * argument was protecting is carried by the chips - "Pays Visa" against a
   * plain "Visa" - rather than by one row having no picture at all.
   */
  it("wears the picture of the card it is charged to", async () => {
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

    expect((await rowNamed("Groceries"))?.imageId).toBe(picture);
  });

  /**
   * A row with no source is a chequing row, so it wears chequing's picture.
   *
   * This asserted the opposite until 2026-11-25, on the argument that every
   * row would then wear the same logo and the picture would stop telling
   * anybody anything. The household used it and disagreed: "the picture for
   * the chequing account doesn't appear... all accounts should show their
   * photo."
   *
   * Chequing being the exception was never a decision anyway - it is the
   * fallback chain reading a foreign key that chequing does not have, since a
   * null source is how chequing is stored. The repetition the old argument
   * feared is the household's to settle: clearing the picture on the chequing
   * account brings every lettered square back.
   */
  it("gives a chequing bill the chequing picture", async () => {
    const picture = await givePictureToChequing(6);

    const created = await post("/api/occurrences", {
      name: "Dentist",
      kind: "bill",
      cents: "12000",
      date: inDays(1),
    });
    expect(created.statusCode, created.body).toBe(201);

    expect((await rowNamed("Dentist"))?.imageId).toBe(picture);
  });

  /**
   * The reported case, which is the same rule reached by the other door: a
   * one-off has no template, so before this it had nothing at all to fall
   * back to when the money came out of chequing.
   */
  it("gives a one-off paid from chequing the chequing picture", async () => {
    const picture = await givePictureToChequing(9);

    const created = await post("/api/occurrences", {
      name: "Oil change",
      kind: "bill",
      cents: "9500",
      date: inDays(2),
    });
    expect(created.statusCode, created.body).toBe(201);

    expect((await rowNamed("Oil change"))?.imageId).toBe(picture);
  });

  /**
   * The guard that keeps the chequing fallback honest.
   *
   * A charge on a card with no picture must keep its lettered square. Falling
   * through to chequing would put the chequing logo on money that never
   * touched chequing - a wrong statement rather than a missing one, which is
   * worse than the lettered square the last two reversals were fixing.
   */
  it("does not give a card charge the chequing picture", async () => {
    await givePictureToChequing(10);
    const visaId = await addAccount("Visa", "credit_card");

    const created = await post("/api/occurrences", {
      name: "Hardware store",
      kind: "bill",
      cents: "4300",
      date: inDays(1),
      paidFromAccountId: visaId,
    });
    expect(created.statusCode, created.body).toBe(201);

    expect((await rowNamed("Hardware store"))?.imageId).toBeNull();
  });

  /**
   * And a payment INTO an account that has no picture, made from chequing,
   * falls back to chequing rather than to nothing. The chain is ordered, not
   * exclusive: a destination with no picture does not end the search.
   */
  it("falls back past a destination that has no picture", async () => {
    const picture = await givePictureToChequing(11);
    const savingsId = await addAccount("Savings", "savings");

    const created = await post("/api/occurrences", {
      name: "Into savings",
      kind: "transfer",
      cents: "15000",
      date: inDays(1),
      transferToAccountId: savingsId,
    });
    expect(created.statusCode, created.body).toBe(201);

    expect((await rowNamed("Into savings"))?.imageId).toBe(picture);
  });

  /**
   * Where the money LANDED beats where it came from: a Visa payment made out
   * of savings is a row about the Visa, not about savings.
   */
  it("keeps the destination ahead of the source", async () => {
    const visaPicture = await uploadPicture(7);
    const savingsPicture = await uploadPicture(8);
    const visaId = await addAccount("Visa", "credit_card", visaPicture);
    const savingsId = await addAccount("Savings", "savings", savingsPicture);

    const created = await post("/api/occurrences", {
      name: "Visa payment",
      kind: "transfer",
      cents: "25000",
      date: inDays(1),
      paidFromAccountId: savingsId,
      transferToAccountId: visaId,
    });
    expect(created.statusCode, created.body).toBe(201);

    expect((await rowNamed("Visa payment"))?.imageId).toBe(visaPicture);
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
