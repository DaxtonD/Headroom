/**
 * "Purchases come from the Visa for now", on screen.
 *
 * Asked for on 2026-11-22, to replace a conversation the household was having
 * by hand: when chequing runs low, one of them tells the other in the morning
 * that necessary purchases go on the Visa until payday.
 *
 * ## The thing these tests are actually protecting
 *
 * **It is not a banner.** The message was never the part that failed. What
 * failed was somebody forgetting and recording a purchase against chequing
 * anyway - and then every figure on the ledger is wrong in the direction that
 * matters, because chequing looks emptier than it is and the card looks
 * healthier than it is.
 *
 * So the load-bearing line is the one-off form's default source account. A
 * build that kept the banner and lost that default would look completely
 * correct and would have given up the entire point, which is exactly the kind
 * of regression a source check is good at catching.
 *
 * ## Why these are source checks
 *
 * There is no DOM in this suite. The rule about when the posture applies is
 * tested as behaviour in `packages/core/test/spendFrom.test.ts`, and the whole
 * route is tested against a real Postgres in `apps/api/test/spendFrom.test.ts`.
 * What a grep covers well is the wiring between them going quietly missing.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (...parts: string[]): string =>
  readFileSync(resolve(import.meta.dirname, "..", "src", ...parts), "utf8");

const ledger = read("pages", "Ledger.tsx");
const ledgerCss = read("pages", "Ledger.css");
const oneOff = read("components", "OneOffForm.tsx");
const form = read("components", "SpendFromForm.tsx");
const queries = read("lib", "queries.ts");

describe("the default source on a new one-off", () => {
  it("starts on the account the household said to use", () => {
    // The whole feature. Everything else here is how somebody finds out.
    expect(oneOff).toContain("spendFromAccountId ?? CHEQUING");
  });

  it("is handed the posture by the ledger", () => {
    expect(ledger).toContain("spendFromAccountId={data.spendFrom?.accountId ?? null}");
  });

  it("is still a visible, changeable choice", () => {
    /*
     * It moves what is selected, not what is possible. A purchase that
     * genuinely did come out of chequing has to be one tap away, and nothing
     * may be recorded differently from what the form shows.
     */
    expect(oneOff).toContain("setPaidFromAccountId");
    expect(oneOff).toMatch(/value=\{paidFromAccountId\}/u);
  });

  it("never works out for itself whether the posture still applies", () => {
    /*
     * The expiry rule lives in the engine and is applied by the server, so a
     * lapsed posture arrives as null and this form has nothing to get wrong.
     * A date comparison in here would be the rule written twice.
     */
    expect(oneOff).not.toContain("spendFromUntil");
    expect(oneOff).not.toContain("spendFromIsActive");
  });
});

describe("the banner", () => {
  it("says which account, until when, and who said so", () => {
    // Who it was, without having to ask, is most of what this is for.
    const banner = ledger.slice(ledger.indexOf("ledger__posture"));
    expect(banner).toContain("data.spendFrom.accountName");
    expect(banner).toContain("formatDateShort(data.spendFrom.until)");
    expect(banner).toContain("data.spendFrom.setBy");
  });

  it("shows their reason as their words", () => {
    const banner = ledger.slice(ledger.indexOf("ledger__posture"));
    expect(banner).toContain("data.spendFrom.note");
  });

  it("says it lifts by itself, so nobody has to remember to", () => {
    expect(ledger).toContain("It lifts by itself on");
  });

  it("is not dressed as a warning", () => {
    /*
     * Nothing is wrong. The household has decided something and is telling
     * each other about it, and a red banner for a decision somebody made on
     * purpose is the kind of alarm that teaches people to ignore banners.
     */
    const rule = ledgerCss.slice(ledgerCss.indexOf(".ledger__posture {"));
    const body = rule.slice(0, rule.indexOf("}"));
    expect(body).not.toContain("--hr-warning");
    expect(body).not.toContain("--hr-negative");
  });

  it("is in the hero, above the account strip", () => {
    // It changes what the other person should do next, so it goes where the
    // unpaid-card warning goes rather than at the bottom of the screen.
    expect(ledger.indexOf('className="ledger__posture"')).toBeLessThan(
      ledger.indexOf('className="ledger__cards"'),
    );
  });
});

describe("turning it on and off", () => {
  it("offers the button only when there is somewhere else to spend from", () => {
    // The same rule the one-off form follows: a choice with no valid answer
    // is worse than no choice.
    expect(ledger).toContain("data.spendFrom === null && spendFromChoices > 0");
    expect(ledger).toContain('account.kind !== "chequing"');
  });

  it("lifts it in one tap, with no sheet to confirm the ordinary state", () => {
    expect(ledger).toContain("spendFromAccountId: null");
    expect(ledger).toContain("Back to chequing");
  });

  it("sends the version, because this is a household fact", () => {
    /*
     * Not like `me/preferences`, which is the one route in this app with no
     * `If-Match`. That row has a single writer by construction; this one has
     * two, and a silent overwrite would mean one of them acting on a posture
     * the other had already changed.
     */
    expect(ledger).toContain("version: data.householdVersion");
    expect(form).toContain("version: householdVersion");
    expect(queries).toContain("readonly householdVersion: number;");
  });

  it("refuses to send a change it cannot version", () => {
    // Only reachable against a server older than this app, and the answer is
    // to reload rather than to write without conflict detection.
    expect(form).toContain("householdVersion === 0");
  });

  it("asks neither when it ends nor who set it", () => {
    /*
     * The end is the next payday, which the server already knows - a posture
     * nobody turns off becomes permanently on, so the end is not optional,
     * it is just not a decision anybody has to make. And a field for who set
     * it would let one of them put the other's name on it.
     */
    expect(form).not.toContain("spendFromUntil");
    expect(form).not.toContain("spendFromSetById");
  });

  it("offers a card before savings, since that is what it is for", () => {
    expect(form).toContain('choices.find((account) => account.kind === "credit_card")');
  });

  it("says what saving it will actually do", () => {
    // Somebody pressing this should know it changes a default, not just that
    // it posts a message.
    expect(form).toMatch(/default to this account instead of chequing/u);
  });
});

describe("what the screen is told", () => {
  it("takes the posture from the server already decided", () => {
    expect(queries).toContain("readonly spendFrom: SpendFrom | null;");
  });

  it("survives a server too old to send it", () => {
    // An installed app can outrun its server: the worker only takes over
    // when the page asks it to.
    expect(queries).toMatch(/readonly spendFrom\?: SpendFromWire \| null \| undefined;/u);
    expect(queries).toContain("householdVersion: wire.householdVersion ?? 0");
  });
});
