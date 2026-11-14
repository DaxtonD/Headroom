/**
 * Everything you tap is at least 44px tall.
 *
 * This is one of the stated M5 acceptance criteria, and the reason it needs
 * arithmetic rather than an eye is that the failure is invisible on the
 * machine the CSS is written on. A 36px pill is easy to click with a mouse
 * on a desktop monitor and perfectly legible in a screenshot; it is the
 * thing you miss twice with a thumb, on a phone, while standing up. Nobody
 * reports it as a bug - they just press the wrong one occasionally, and on
 * these screens the wrong one next door is "Remove this".
 *
 * It also drifts in one direction only. A new small button is written by
 * copying the nearest existing small button, so one rule at 36px becomes
 * five. Four of them had: `.manage__small`, `.networth__entry-edit`,
 * `.savings__edit` and `.budget__toggle-button` were all under the floor
 * when this file was written.
 *
 * ## What is checked, and what "the target" means
 *
 * For a button the target is the button. For a checkbox or a radio it is the
 * `<label>` wrapped around it: the input itself is 22px and cannot sensibly
 * be bigger, but the whole label is clickable, so that is what has to carry
 * the floor. A label with no minimum of its own is a 22px target even though
 * it looks like a row.
 *
 * ## What this cannot see
 *
 * It reads the declared minimum, not a rendered box, so it proves a floor
 * exists rather than that the result is 44px on a given phone - there is no
 * browser here. It is the regression it is for: a number typed smaller than
 * the floor, or a new control that never got one.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const WEB_SRC = resolve(import.meta.dirname, "..", "src");

const MINIMUM_PX = 44;
/** The token every rule should use, rather than writing 44 out again. */
const TOKEN = "--hr-touch-min";

function filesUnder(dir: string, extension: string): readonly string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(extension))
    .map((entry) => resolve(dir, entry));
}

/* -------------------------------------------------------------------------- */
/* The stylesheets                                                            */
/* -------------------------------------------------------------------------- */

const css = filesUnder(WEB_SRC, ".css")
  .map((file) => readFileSync(file, "utf8"))
  .join("\n");

/** `--hr-touch-min: 44px;` - so the token cannot be quietly lowered. */
const tokenValue = /--hr-touch-min:\s*(\d+)px/.exec(css)?.[1];

/**
 * Does a rule give an element carrying `cls` a minimum of 44px or more?
 *
 * The class has to be on the *subject* of the selector - the last compound -
 * or `.sheet__choice input[type="radio"] { height: 22px }` would be read as
 * saying something about `.sheet__choice` itself.
 */
function hasFloor(cls: string): boolean {
  for (const rule of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const body = rule[2] ?? "";
    const declared = /min-height:\s*([^;]+);/.exec(body)?.[1]?.trim();
    if (declared === undefined) continue;

    const enough =
      declared.includes(TOKEN) || Number.parseInt(declared, 10) >= MINIMUM_PX;
    if (!enough) continue;

    for (const selector of (rule[1] ?? "").split(",")) {
      const subject = selector.trim().split(/[\s>+~]+/).at(-1) ?? "";
      if (new RegExp(`\\.${cls}(?![\\w-])`).test(subject)) return true;
    }
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* The components                                                             */
/* -------------------------------------------------------------------------- */

/** Comments included `<button>` in prose, which read as a real control. */
function withoutComments(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/^\s*\/\/.*$/gm, "");
}

/**
 * The classes in a `className=`, whichever of the three forms it takes:
 * a string, a template literal, or the function `NavLink` is given.
 */
function classesIn(attributes: string): string[] {
  const at = attributes.indexOf("className=");
  if (at === -1) return [];

  const value = attributes.slice(at + "className=".length).trimStart();

  // Either a plain string, or an expression whose own string literals are
  // where the class names live. `${...}` interpolations are dropped; the
  // literals inside them have already been collected.
  const text =
    value.startsWith('"') || value.startsWith("'")
      ? (value.slice(1, value.indexOf(value[0] as string, 1)) ?? "")
      : [...value.matchAll(/[`"']([^`"']*)[`"']/g)].map((match) => match[1] ?? "").join(" ");

  return [...new Set(text.replaceAll(/\$\{[^}]*\}/g, " ").match(/[\w-]+/g) ?? [])];
}

interface Control {
  readonly where: string;
  readonly what: string;
  readonly classes: readonly string[];
}

/**
 * The attributes of the tag opening at `from`, up to its own `>`.
 *
 * Scanned rather than matched, because `className={({ isActive }) => ...}` -
 * which is how `NavLink` is styled - contains a `>`, and a regex that stops
 * at the first one reads that tag as having no classes at all. Tracking
 * braces and quotes puts the `=>` inside an expression, where it belongs.
 */
function attributesAt(source: string, from: number): string {
  let depth = 0;
  let quote: string | null = null;

  for (let at = from; at < source.length; at += 1) {
    const character = source[at] as string;

    if (quote !== null) {
      if (character === "\\") at += 1;
      else if (character === quote) quote = null;
      continue;
    }

    if (character === '"' || character === "'" || character === "`") quote = character;
    else if (character === "{") depth += 1;
    else if (character === "}") depth -= 1;
    else if (character === ">" && depth === 0) return source.slice(from, at);
  }

  return source.slice(from);
}

/** Every control in the app, with the classes that decide its size. */
function controls(): readonly Control[] {
  const found: Control[] = [];

  for (const file of filesUnder(WEB_SRC, ".tsx")) {
    const source = withoutComments(readFileSync(file, "utf8"));
    const name = file.slice(WEB_SRC.length + 1);

    for (const element of source.matchAll(/<(button|input|select|textarea|a|NavLink|Link)\b/g)) {
      const tag = element[1] as string;
      const attributes = attributesAt(source, element.index + element[0].length);
      const line = source.slice(0, element.index).split("\n").length;
      const type = /type="(\w+)"/.exec(attributes)?.[1] ?? "";

      // A submit input or button inside a <form> is still a control; a
      // hidden one is not a target at all.
      if (type === "hidden") continue;

      let classes = classesIn(attributes);

      if (type === "checkbox" || type === "radio") {
        /*
         * The input is 22px on purpose and the label around it is the
         * target, so this looks outwards for the nearest enclosing
         * `<label>` and judges that instead.
         */
        const before = source.slice(0, element.index);
        const label = [...before.matchAll(/<label\b([^<>]*)>/g)].at(-1);
        const closed = before.lastIndexOf("</label>") > (label?.index ?? -1);
        if (label && !closed) classes = classesIn(label[1] as string);
      }

      found.push({
        where: `${name}:${line}`,
        what: `<${tag}${type ? ` type="${type}"` : ""}>`,
        classes,
      });
    }
  }

  return found;
}

const everyControl = controls();

/* -------------------------------------------------------------------------- */

describe("touch targets", () => {
  it("found the controls and the stylesheets", () => {
    // Without this, every check below passes by having read nothing. The
    // counts are floors, not expectations: they only have to be wrong if the
    // parsing broke.
    expect(everyControl.length).toBeGreaterThan(40);
    expect(css.length).toBeGreaterThan(10_000);
    expect(everyControl.some((control) => control.what === '<input type="checkbox">')).toBe(true);
    expect(everyControl.some((control) => control.what === "<NavLink>")).toBe(true);
  });

  it("keeps the token at 44px", () => {
    // Every rule points at this one value, so lowering it would lower all of
    // them at once and nothing else here would notice.
    expect(tokenValue).toBe(String(MINIMUM_PX));
  });

  it("agrees with itself about which rules clear the floor", () => {
    // The two it is built on: a 44px rule and a deliberately smaller one.
    expect(hasFloor("hr-button")).toBe(true);
    expect(hasFloor("not-a-real-class-anywhere")).toBe(false);
    // A descendant selector says nothing about its ancestor.
    expect(/\.sheet__choice input\[type="radio"\]/.test(css)).toBe(true);
  });

  it("gives every control a 44px minimum", () => {
    const short = everyControl
      .filter((control) => !control.classes.some((cls) => hasFloor(cls)))
      .map(
        (control) =>
          `${control.where} ${control.what} [${control.classes.join(" ") || "no class"}]`,
      );

    /*
     * A failure here is read as: this control, and nothing on it, declares a
     * minimum height of 44px. The fix is `min-height: var(--hr-touch-min)`
     * on the rule that styles it - or, for a checkbox, on the label around
     * it.
     */
    expect(short.sort()).toEqual([]);
  });
});
