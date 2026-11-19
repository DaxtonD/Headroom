/**
 * The picture beside a name: how it is shown, and how one is chosen.
 *
 * The arithmetic is tested for real in `cropImage.test.ts`, and the round trip
 * in the API's `images.test.ts` against Postgres. What is left here is the part
 * with no numbers in it - wiring, and a handful of decisions that are a bug if
 * reversed. Three of those matter more than the rest:
 *
 *  - **a data URL and not an object URL.** The Content-Security-Policy allows
 *    `img-src 'self' data:` and not `blob:`, so `createObjectURL` - which is
 *    the obvious thing to reach for - would render nothing, and would fail
 *    only in the built app where no test looks.
 *  - **the picker reuses the tested crop functions** rather than re-deriving
 *    the position for CSS. The first draft did re-derive it, which is the same
 *    two-copies-of-one-sum mistake that caused bugs 24 and 25.
 *  - **`touch-action: none` on the crop surface.** Without it a drag scrolls
 *    the sheet and the picture never moves at all, on a phone only.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { initialFor } from "../src/lib/initials.js";

const web = (...parts: string[]): string =>
  readFileSync(resolve(import.meta.dirname, "..", "src", ...parts), "utf8");

/**
 * The same source with its comments taken out.
 *
 * For the checks that say something is ABSENT. These files explain at length
 * why `createObjectURL` and `role="application"` are the wrong things to reach
 * for, which is exactly the text such a check looks for - so without this they
 * fail on the comment documenting the rule they enforce. The same helper, for
 * the same reason, is in `ledger-actions.test.ts`.
 */
const withoutComments = (source: string): string =>
  source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/^\s*\/\/.*$/gm, "");

const api = (...parts: string[]): string =>
  readFileSync(resolve(import.meta.dirname, "..", "..", "api", "src", ...parts), "utf8");

const thumb = web("components", "Thumb.tsx");
const thumbCss = web("components", "Thumb.css");
const picker = web("components", "ImagePicker.tsx");
const pickerCss = web("components", "ImagePicker.css");
const crop = web("lib", "cropImage.ts");
const queries = web("lib", "queries.ts");
const billForm = web("components", "BillForm.tsx");
const categoryForm = web("components", "CategoryForm.tsx");
const manage = web("pages", "Manage.tsx");
const budget = web("pages", "Budget.tsx");
const row = web("components", "OccurrenceRow.tsx");
const ledger = web("pages", "Ledger.tsx");
const sw = web("sw.ts");

describe("the square itself", () => {
  it("shows a lettered square where there is no picture", () => {
    /*
     * The first version drew nothing, on the reasoning that a grey letter
     * identifies nothing. That was wrong about the thing that matters, and
     * the household said so on sight: "to ensure visual continuity on the
     * ledger, items with no image should still show the image placeholder."
     *
     * A list where some names start 36px further left than others does not
     * read as "those have no picture yet", it reads as broken. The letter is
     * not identification - it is what makes the column a column.
     */
    expect(thumb).toMatch(/thumb--empty/);
    expect(thumb).toMatch(/initialFor\(fallback\)/);
  });

  it("draws nothing when the screen asks for no placeholder", () => {
    // `fallback` is a prop and not a default, because two places should not
    // have one: a paycheque row, which carries its own mark already, and the
    // picker, where an empty square would read as a failed load.
    expect(thumb).toMatch(/fallback = null/);
    expect(thumb).toMatch(/if \(initial === null\) return null/);
  });

  it("keeps the letter out of what a screen reader says", () => {
    // The name is beside it, so reading out "V" would say the item twice.
    expect(thumb).toMatch(/className=\{`thumb thumb--\$\{size\} thumb--empty`\} aria-hidden="true"/);
  });

  it("uses a colour pair the contrast test already holds", () => {
    // --hr-neutral-fg on --hr-neutral-bg, checked at 4.5:1 across all five
    // themes. The square's own background is that same token.
    expect(thumbCss).toMatch(/\.thumb__initial \{[^}]*color: var\(--hr-neutral-fg\)/s);
    expect(thumbCss).toMatch(/\.thumb \{[^}]*background: var\(--hr-neutral-bg\)/s);
  });

  it("is decorative, so a screen reader does not read the item twice", () => {
    // The name is always beside it, in text. A picture must never be the only
    // way to tell two rows apart.
    expect(thumb).toMatch(/alt=""/);
  });

  it("builds its own URL from the id", () => {
    // An id and not a URL on the wire, so there is one place that knows the
    // route - and that URL is immutable, which is what the caching rests on.
    expect(thumb).toMatch(/src=\{`\/api\/images\/\$\{imageId\}`\}/);
  });

  it("does not hold up a scroll", () => {
    // A long ledger can hold a few dozen, and none of them is why the screen
    // exists.
    expect(thumb).toMatch(/loading="lazy"/);
    expect(thumb).toMatch(/decoding="async"/);
  });

  it("stays square, and clips what is inside it", () => {
    expect(thumbCss).toMatch(/aspect-ratio: 1/);
    expect(thumbCss).toMatch(/\.thumb \{[^}]*overflow: hidden/s);
    expect(thumbCss).toMatch(/\.thumb \{[^}]*border-radius: var\(--hr-radius-thumb\)/s);
  });
});

describe("the letter that stands in for a picture", () => {
  it("takes the first character, upper-cased", () => {
    expect(initialFor("Netflix")).toBe("N");
    expect(initialFor("groceries")).toBe("G");
  });

  it("ignores leading space, which would otherwise be the letter", () => {
    expect(initialFor("  Spotify")).toBe("S");
  });

  it("keeps a character whole that does not fit in one code unit", () => {
    /*
     * The reason this is not `name[0]`. A household can call a category
     * anything, and taking the leading surrogate of an emoji on its own
     * renders as a replacement box - a square with a broken glyph in it,
     * which is worse than no square.
     */
    expect(initialFor("\u{1F3E0} House")).toBe("\u{1F3E0}");
    expect(initialFor("\u{1F3E0} House")).toHaveLength(2);
  });

  it("answers null for a name with nothing in it", () => {
    // Null and not "", so the component can draw nothing rather than an
    // empty square - which would read as a picture that failed to load.
    expect(initialFor("")).toBeNull();
    expect(initialFor("   ")).toBeNull();
  });

  it("leaves a digit or a symbol as it found it", () => {
    expect(initialFor("7-Eleven")).toBe("7");
    expect(initialFor("\u00e9lectricit\u00e9")).toBe("\u00c9");
  });
});

describe("choosing and cropping one", () => {
  it("reads the file as a data URL, never an object URL", () => {
    /*
     * The CSP trap. `img-src` allows `'self'` and `data:`; a `blob:` preview
     * would simply not render, and only in the built app - there is no CSP in
     * a dev server and none in a test.
     */
    expect(picker).toMatch(/readAsDataURL/);
    expect(withoutComments(picker)).not.toMatch(/createObjectURL/);
  });

  it("positions the picture with the same functions that crop it", () => {
    /*
     * Not re-derived for CSS. The first draft of `cropStyle` computed the
     * cover scale and the offsets again by hand, which is two copies of one
     * piece of arithmetic with only one of them tested - exactly how bugs 24
     * and 25 happened, twice.
     */
    expect(picker).toMatch(/const \{ width, height \} = displayedSize\(view\)/);
    expect(picker).toMatch(/const \{ left, top \} = imageOffset\(view\)/);
    // And no second copy of the cover-scale formula in the component.
    expect(picker).not.toMatch(/view\.viewport \/ view\.sourceWidth/);
  });

  it("lets a finger drag the picture instead of scrolling the sheet", () => {
    // Load-bearing, and invisible on a desktop: without it the browser
    // scrolls and the picture never moves.
    expect(pickerCss).toMatch(/\.picker__viewport \{[^}]*touch-action: none/s);
  });

  it("captures the pointer, so a finger may leave the square mid-drag", () => {
    expect(picker).toMatch(/setPointerCapture\(event\.pointerId\)/);
  });

  it("is a real control rather than a div dressed as one", () => {
    // Two earlier goes used role="group" and then role="application", and the
    // linter refused both. A thing you focus and drive with arrow keys is a
    // control, and the way to say so is to be one.
    expect(picker).toMatch(/<button\s+className="picker__viewport"/);
    expect(picker).toMatch(/aria-label="Crop the picture\. Drag it, or move it with the arrow keys\./);
    expect(withoutComments(picker)).not.toMatch(/role="application"/);
  });

  it("can be moved with the keyboard as well as a finger", () => {
    expect(picker).toMatch(/ArrowLeft/);
    expect(picker).toMatch(/ArrowRight/);
    // And the page must not scroll underneath while it is being used.
    expect(picker).toMatch(/event\.preventDefault\(\)/);
  });

  it("takes the viewport size from one constant, used in both places", () => {
    /*
     * The crop arithmetic needs this exact number. A stylesheet holding its
     * own copy would be a second number that could drift, and the symptom
     * would be a stored crop that is not what was on screen.
     */
    expect(picker).toMatch(/const VIEWPORT = \d+;/);
    expect(picker).toMatch(/style=\{\{ width: VIEWPORT, height: VIEWPORT \}\}/);
    expect(pickerCss).not.toMatch(/\.picker__viewport \{[^}]*width: \d+px/s);
  });

  it("pulls the picture back inside its edges when zoomed out", () => {
    // Otherwise zooming out leaves a gap at an edge until it is dragged.
    expect(picker).toMatch(/setPan\(clampPan\(\{ \.\.\.view, scale: next \}\)\)/);
  });

  it("says so when the browser cannot make a WebP, rather than letting the server refuse", () => {
    /*
     * `toDataURL` silently returns a PNG when WebP is unsupported, and the
     * server would then refuse it with a message about the file being wrong -
     * which it is not.
     */
    expect(crop).toMatch(/if \(!url\.startsWith\("data:image\/webp"\)\) throw new WebpUnsupportedError\(\)/);
  });

  it("steps the quality down rather than being refused for size", () => {
    expect(crop).toMatch(/for \(const quality of QUALITY_STEPS\)/);
  });

  it("aims at the same ceiling the server enforces", () => {
    /*
     * Two copies of one number, in two packages, and they are different kinds
     * of number - a target here, a bound there. Different kinds still have to
     * agree, and nothing else would notice if they drifted apart: the symptom
     * would be an upload refused after the crop, which reads as the picture
     * being wrong.
     */
    const here = /MAX_UPLOAD_BYTES = (\d+) \* 1024/.exec(crop)?.[1];
    const there = /MAX_IMAGE_BYTES = (\d+) \* 1024/.exec(api("lib", "images.ts"))?.[1];

    expect(here).toBeDefined();
    expect(there).toBeDefined();
    expect(here).toBe(there);
  });

  it("uploads through its own request, leaving the mutation rules alone", () => {
    // A picture is bytes; every other write is a field-level PATCH with
    // If-Match. Uploading separately means neither has to bend.
    expect(queries).toMatch(/export function useUploadImage/);
    expect(queries).toMatch(/"\/api\/images"/);
  });
});

describe("where the square shows up", () => {
  it("on an expense and a budget-only category, in their own forms", () => {
    for (const [name, source] of [
      ["BillForm", billForm],
      ["CategoryForm", categoryForm],
    ] as const) {
      expect(source, name).toMatch(/<ImagePicker/);
      expect(source, name).toMatch(/useState<string \| null>\(existing\?\.imageId \?\? null\)/);
      // Saved with the form, on both paths - a new one and a change.
      expect(source.match(/\bimageId,/g)?.length ?? 0, name).toBeGreaterThanOrEqual(2);
    }
  });

  it("on an account, where adding and renaming are separate forms", () => {
    // Two pieces of state, because the add form and a rename can both be
    // open and they are not the same account.
    expect(manage).toMatch(/const \[newImageId, setNewImageId\] = useState<string \| null>\(null\)/);
    expect(manage).toMatch(/const \[renameImageId, setRenameImageId\] = useState<string \| null>\(null\)/);
    // Opening a rename has to carry the current picture in, or saving would
    // take it away.
    expect(manage).toMatch(/setRenameImageId\(account\.imageId\)/);
    expect(manage).toMatch(/changes: \{ name: name\.trim\(\), imageId: renameImageId \}/);
  });

  it("on the Manage rows, for the two things that have one", () => {
    expect(manage).toMatch(/imageId=\{bill\.imageId\}/);
    expect(manage).toMatch(/imageId=\{category\.imageId\}/);
    expect(manage).toMatch(
      /<Thumb imageId=\{account\.imageId\} size="line" fallback=\{account\.name\} \/>/,
    );
  });

  it("on the Budget rows", () => {
    expect(budget).toMatch(
      /<Thumb imageId=\{line\.imageId\} size="line" fallback=\{line\.name\} \/>/,
    );
  });

  it("on the ledger rows, beside the badge rather than instead of it", () => {
    // The badge is state and the picture is identity; both are worth a
    // glance, and the row already prefers a taller line to a truncated name.
    expect(row).toMatch(/imageId=\{row\.imageId\}/);
    const thumbAt = row.indexOf("<Thumb");
    const mainAt = row.indexOf('<span className="row__main">');
    expect(thumbAt).toBeGreaterThan(0);
    expect(thumbAt).toBeLessThan(mainAt);
  });

  it("lines the ledger names up, which is what was reported", () => {
    // Every row gets a square, so the column has one left edge.
    expect(row).toMatch(/fallback=\{isPaycheque \? null : row\.name\}/);
  });

  it("leaves a paycheque row alone, which already has its own mark", () => {
    // A green circle and a letter square side by side is two marks competing
    // where one already says everything.
    expect(row).toMatch(/isPaycheque \? null/);
  });

  it("on the card strip in the hero", () => {
    expect(ledger).toMatch(
      /<Thumb imageId=\{card\.imageId\} size="row" fallback=\{card\.name\} \/>/,
    );
  });
});

/**
 * The `registerRoute` call that caches pictures.
 *
 * Found by splitting rather than with a multiline regex, because these files
 * have CRLF line endings: a pattern containing `\n` matches nothing, and the
 * two checks below would then pass against an empty string - testing nothing
 * at all, which is the exact failure this whole file exists to avoid.
 */
function imagesRule(): string {
  return (
    sw.split("registerRoute(").find((part) => part.includes('cacheName: "headroom-images"')) ?? ""
  );
}

describe("offline", () => {
  it("keeps the pictures, which is the one /api route that may be cached", () => {
    /*
     * A real exception rather than a convenience: the URL is content-addressed,
     * so a re-crop produces a NEW id and an existing one never comes to mean
     * different bytes. There is nothing to go stale. Every other `/api` route
     * must reach the server or fail honestly.
     */
    expect(sw).toMatch(/\/\^\\\/api\\\/images\\\/\//);
    expect(sw).toMatch(/cacheName: "headroom-images"/);
    expect(sw).toMatch(/new CacheFirst\(\{\s*cacheName: "headroom-images"/);
  });

  it("caches only a 200, never a lapsed session", () => {
    // A 401 cached as though it were the picture would leave a permanently
    // broken square that no reload could fix.
    const rule = imagesRule();
    expect(rule).toMatch(/statuses: \[200\]/);
    expect(rule).not.toMatch(/statuses: \[0, 200\]/);
  });

  it("is bounded, since the household can add to it without limit", () => {
    expect(imagesRule()).toMatch(/maxEntries: \d+/);
  });
});
