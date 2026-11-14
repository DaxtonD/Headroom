/**
 * The letter on a person's badge, and the name in the greeting.
 *
 * Worth a test because the bug it replaces was invisible to every other kind
 * of check: two people in a real household both showed the same letter,
 * because the letter was a column typed in when the account was made rather
 * than anything to do with the name. Nothing was broken, nothing logged, and
 * the badge quietly stopped answering the only question it is there for.
 *
 * Names here are invented.
 */
import { describe, expect, it } from "vitest";
import { firstNameOf, initialOf } from "../src/lib/people.js";

describe("the first name", () => {
  it("is everything before the first space", () => {
    expect(firstNameOf("Jordan Alvarez")).toBe("Jordan");
  });

  it("is the whole thing when there is only one word", () => {
    expect(firstNameOf("Jordan")).toBe("Jordan");
  });

  it("copes with the spacing people actually type", () => {
    expect(firstNameOf("  Jordan   Alvarez ")).toBe("Jordan");
  });

  it("does not throw on an empty name", () => {
    expect(firstNameOf("")).toBe("");
    expect(initialOf({ name: "   " })).toBe("");
  });
});

describe("the initial", () => {
  it("is the first letter of the first name", () => {
    expect(initialOf({ name: "Jordan Alvarez" })).toBe("J");
  });

  it("is upper case however the name was typed", () => {
    expect(initialOf({ name: "jordan" })).toBe("J");
  });

  it("tells two people apart", () => {
    // The failure as reported: both badges read the same letter, so neither
    // said whose row it was.
    const one = initialOf({ name: "Jordan Alvarez" });
    const other = initialOf({ name: "Mina Alvarez" });
    expect(one).not.toBe(other);
  });

  it("is taken from the name, not from a stored initial that disagrees", () => {
    // The shape of the real data: a person whose stored letter is somebody
    // else's. `initialOf` is not given it, which is the point.
    const person = { id: "1", name: "Mina Alvarez", initial: "J" };
    expect(initialOf(person)).toBe("M");
  });

  it("keeps a non-Latin first letter rather than dropping it", () => {
    expect(initialOf({ name: "Øyvind" })).toBe("Ø");
  });
});
