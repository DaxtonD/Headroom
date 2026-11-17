/**
 * Who did it, on a row of the activity log.
 *
 * ## The bug this replaces
 *
 * Every row opened with a coloured circle holding one letter, and in the
 * household it was built for both people's letters were the same. The circle
 * existed to answer one question - whose row is this - and it answered it
 * wrongly half the time, silently, with nothing broken and nothing logged.
 *
 * The cause was known and already fixed once: the letter is a column typed in
 * when an account is made, which is why `lib/people.ts` derives one from the
 * name instead. Every other badge in the app had been moved over. This panel
 * was written later and read the stored column straight off the wire, so the
 * fix did not reach it. That is the part worth a test - not the letter logic,
 * which `people.test.ts` already covers, but that *this* row does not go back
 * to the column.
 *
 * ## Why it is a source check
 *
 * There is no DOM in this suite. A grep is a weak test of appearance and a
 * perfectly good test of "the panel does not read `by.initial`", which is the
 * regression. The wording half below is real.
 *
 * Names here are invented.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { activitySentence, describeActivity, type ActivityEvent } from "@headroom/core";

const component = (name: string): string =>
  readFileSync(resolve(import.meta.dirname, "..", "src", "components", `${name}.tsx`), "utf8");

const panel = component("ActivityPanel");
const badges = component("Badges");

describe("the activity row", () => {
  it("does not show the stored initial", () => {
    // The whole bug, in one expression.
    expect(panel).not.toMatch(/\.initial\b/);
  });

  it("shows the person's name instead", () => {
    expect(panel).toMatch(/<NameChip/);
  });

  it("leaves the name to the chip rather than saying it twice", () => {
    // `activitySentence` prefixes the actor's name. With a chip in front of
    // it that reads "Jordan Jordan verified the mortgage".
    expect(panel).not.toMatch(/activitySentence/);
    expect(panel).toMatch(/describeActivity\(/);
  });
});

describe("the name chip", () => {
  it("takes the name from the name, not from a stored letter", () => {
    expect(badges).toMatch(/firstNameOf\(person\.name\)/);
  });

  it("is readable, because it is the only thing naming who acted", () => {
    /*
     * The initial bubble it replaced here was `aria-hidden`, correctly: the
     * sentence beside it already began with the name. Now the sentence does
     * not, so hiding the chip would leave a screen reader with "verified the
     * mortgage" and no subject.
     */
    const chip = /export function NameChip\([\s\S]*?\n}/.exec(badges)?.[0] ?? "";
    expect(chip, "NameChip has moved or been renamed").not.toBe("");
    expect(chip).not.toMatch(/aria-hidden/);
  });
});

const VERIFIED: ActivityEvent = {
  action: "verify",
  entity: "occurrence",
  label: "Mortgage",
  labelKind: "bill",
  fields: ["verifiedAt"],
};

describe("the two wordings", () => {
  it("the log's leaves the actor out, because the chip carries it", () => {
    expect(describeActivity(VERIFIED)).toBe("verified Mortgage");
  });

  it("a notification's keeps the actor, having nowhere to put a chip", () => {
    expect(activitySentence("Jordan", VERIFIED)).toBe("Jordan verified Mortgage");
  });
});
