/**
 * The two things you came to the ledger to do, and getting to them.
 *
 * ## What was asked for, and why
 *
 * Both from use, after a week of running the household on this screen:
 *
 *  1. "When I add a one-off, it's placed on the ledger. I then have to open
 *     it again to mark it as paid." Two steps to say one thing. A one-off is
 *     nearly always typed in after the fact, so the row being added is a
 *     record rather than a plan, and it should arrive with its tick on.
 *  2. "Move the Add a one-off button to the top, beside the Update balance
 *     button", and keep the balance and both buttons visible once the screen
 *     is scrolled. The ledger is one long scroll with the figure at the top,
 *     which is right - but it means the two actions leave the screen as soon
 *     as you look at anything, and "Add a one-off" was at the very bottom,
 *     under four pay windows.
 *
 * ## Why these are source checks
 *
 * There is no DOM in this suite. What the arithmetic does is covered where it
 * lives: `oneOffAlreadyDone.test.ts` proves a one-off created paid moves the
 * balance from the one request, and proves it is the same row as one created
 * and then ticked, both against real Postgres.
 *
 * What a grep covers well is the part of this that has no behaviour to test -
 * a layout decision with a reason behind it, where the regression is someone
 * simplifying the reason away. Three of them matter:
 *
 *  - the pinned bar being **fixed rather than sticky**, which is not a style
 *    preference. Sticky would make it take up space in the scroll, so the
 *    page would get shorter when it appeared, which scrolls up, which can
 *    bring the hero back, which hides the bar. Fixed cannot do that.
 *  - it being **under the header in the stack**, so it slides out from behind
 *    the header rather than over the top of it.
 *  - **`inert` while it is away**, or it is a second set of buttons sitting in
 *    the tab order behind the header where nobody can see what they focused.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (...parts: string[]): string =>
  readFileSync(resolve(import.meta.dirname, "..", "src", ...parts), "utf8");

/**
 * The same source with its comments taken out.
 *
 * For the checks that say something is *absent*. The prose in these files
 * explains why `new Date()` is the wrong thing to reach for, which is exactly
 * the string such a check looks for - so without this it fails on the comment
 * that documents the rule it is enforcing.
 */
const withoutComments = (source: string): string =>
  source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/^\s*\/\/.*$/gm, "");

const ledger = read("pages", "Ledger.tsx");
const ledgerCss = read("pages", "Ledger.css");
const oneOff = read("components", "OneOffForm.tsx");
const shell = read("components", "Shell.tsx");
const pinned = read("lib", "pinnedHeader.ts");
const tokens = read("styles", "tokens.css");
const queries = read("lib", "queries.ts");

describe("a one-off that has already happened", () => {
  it("is asked about, in the form, in those words", () => {
    expect(oneOff).toMatch(/<legend className="hr-label">Has it happened\?<\/legend>/);
  });

  it("defaults to yes, which is the whole point", () => {
    // The complaint was about the extra step, so the default has to be the
    // one that removes it. A choice defaulting the other way would be the
    // same number of taps as before.
    expect(oneOff).toMatch(/const \[happened, setHappened\] = useState\(true\)/);
  });

  it("sends the tick with the row rather than after it", () => {
    expect(oneOff).toMatch(/\.\.\.\(happened \? \{ paid: true \} : \{\}\)/);
    expect(queries).toMatch(/paid\?: boolean;/);
  });

  it("is always dated, because a thing that happened happened on a day", () => {
    /*
     * A paycheque to hang off is a way of moving a payment that has not been
     * made yet. There is nothing to move about one that has, so that choice
     * is not offered and the placement is a date either way.
     */
    expect(oneOff).toMatch(/const onADate = happened \|\| placement === "date"/);
    expect(oneOff).toMatch(/\{happened \? null : \(/);
  });

  it("will not let already-done and a future date both be true", () => {
    /*
     * The combination is worse than it looks. A settled row is left out of
     * the forecast, so a future payment marked done would quietly stop
     * counting towards anything at all.
     */
    expect(oneOff).toMatch(/if \(happened && date > today\)/);
    // And the phone's own picker is told, so it is not offered in the first
    // place; the check above is still what decides.
    expect(oneOff).toMatch(/\{\.\.\.\(happened \? \{ max: today \} : \{\}\)\}/);
  });

  it("takes today from the server, not from the phone", () => {
    // `America/Regina`, and the clock every other figure is built from. A
    // phone the wrong side of midnight would date a payment yesterday.
    expect(oneOff).toMatch(/today: string;/);
    expect(ledger).toMatch(/today=\{data\.today\}/);
    expect(withoutComments(oneOff)).not.toMatch(/new Date\(/);
  });

  it("says in the preview that the balance has already moved", () => {
    // The preview is the only place the consequence is visible before saving,
    // and "Taken off the balance" is the wrong tense for something gone.
    expect(oneOff).toMatch(/Already gone, so it comes off the balance/);
    expect(oneOff).toMatch(/Already in, so it goes on the balance/);
  });
});

describe("both buttons at the top", () => {
  it("puts them side by side in the hero", () => {
    expect(ledger).toMatch(/ledger__hero-actions/);
    const actions = ledger.indexOf("ledger__hero-actions");
    const section = ledger.indexOf('className="ledger__cards"');
    expect(actions).toBeGreaterThan(0);
    // Inside the hero, above everything else on the screen.
    expect(actions).toBeLessThan(section);

    expect(ledger).toMatch(/>\s*Update balance\s*</);
    expect(ledger).toMatch(/>\s*Add a one-off\s*</);
  });

  it("no longer leaves one of them at the bottom of the scroll", () => {
    // Moved, not duplicated: a second copy under the whole list is a second
    // place to look for the same button.
    expect(ledger).not.toMatch(/ledger__actions/);
    expect(ledgerCss).not.toMatch(/\.ledger__actions/);
  });

  it("stacks them rather than truncating two labels", () => {
    // What decides is whether two readable labels fit, which depends on the
    // text scale as much as the phone - so `auto-fit`, not a media query.
    expect(ledgerCss).toMatch(
      /\.ledger__hero-actions \{[^}]*grid-template-columns: repeat\(auto-fit, minmax\(150px, 1fr\)\)/s,
    );
  });
});

describe("the pinned balance line", () => {
  it("is fixed, not sticky", () => {
    /*
     * The one thing here that is not a style preference. Sticky would mean it
     * took up space in the scroll, so the page would get shorter when it
     * appeared - which scrolls up, which can bring the hero back into view,
     * which hides it again.
     */
    expect(ledgerCss).toMatch(/\.ledger__pinned \{[^}]*position: fixed/s);
    expect(ledgerCss).not.toMatch(/\.ledger__pinned \{[^}]*position: sticky/s);
  });

  it("sits exactly below the header, at the height the shell measured", () => {
    expect(ledgerCss).toMatch(/\.ledger__pinned \{[^}]*top: var\(--hr-header-h\)/s);
    // Measured, because the real figure includes the safe-area inset, which
    // differs between a browser tab and an installed app.
    expect(shell).toMatch(/trackHeaderHeight\(header\)/);
    expect(pinned).toMatch(/setProperty\("--hr-header-h", `\$\{height\}px`\)/);
    // And declared, so it resolves on the frame before that runs.
    expect(tokens).toMatch(/--hr-header-h: 69px;/);
  });

  it("is under the header in the stack, not over it", () => {
    // 10 is the header and the tab bar; 50 is anything modal. Sliding out
    // from behind the header is what makes it read as the hero condensing.
    const z = /\.ledger__pinned \{[^}]*z-index: (\d+)/s.exec(ledgerCss)?.[1];
    expect(z).toBeDefined();
    expect(Number(z)).toBeLessThan(10);
  });

  it("is inert while it is away", () => {
    // Otherwise it is a second Update balance and a second Add a one-off in
    // the tab order, behind the header, where nobody can see what they have
    // focused.
    expect(ledger).toMatch(/inert=\{!heroGone\}/);
  });

  it("does not read its figures out a second time", () => {
    // They are the hero's own numbers again, and the hero has already said
    // them. The buttons stay real, because a sighted keyboard user has to be
    // able to reach them.
    expect(ledger).toMatch(/className="ledger__pinned-figures" aria-hidden="true"/);
  });

  it("appears when the hero has gone, not merely when it is out of view", () => {
    // A marker still below the fold has not been reached yet. Treating that
    // as past would pin the bar before the screen had been scrolled at all.
    expect(pinned).toMatch(/!entry\.isIntersecting && entry\.boundingClientRect\.top < 0/);
    expect(ledger).toMatch(/const \[heroEndRef, heroGone\] = useScrolledPast\(\)/);
    expect(ledger).toMatch(/className="ledger__hero-end" ref=\{heroEndRef\}/);
  });

  it("watches with an observer rather than on every scroll frame", () => {
    // A scroll handler does this work on the main thread on every frame of
    // every flick. An observer fires twice: once going, once coming back.
    expect(pinned).toMatch(/new IntersectionObserver\(/);
    expect(pinned).not.toMatch(/addEventListener\(\s*"scroll"/);
  });

  it("allows for the header when deciding, or it arrives late", () => {
    // Without the margin the marker counts as visible while it sits behind
    // the header, and the bar is a header's height of scrolling late.
    expect(pinned).toMatch(/rootMargin: `-\$\{Math\.trunc\(measured \?\? FALLBACK_HEADER_PX\)\}px/);
  });

  it("keeps still for anybody who asked for that", () => {
    expect(ledgerCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.ledger__pinned \{[^}]*transition: none/s,
    );
  });

  it("clears the left nav on a desktop, where the nav is a column", () => {
    // A bar pinned from the left edge would sit across the 220px nav.
    expect(ledgerCss).toMatch(
      /@media \(min-width: 1024px\) \{\s*\.ledger__pinned \{\s*left: 220px/s,
    );
  });

  it("uses the hero's own colours, which are already checked for contrast", () => {
    // --hr-hero-text on --hr-hero-bg is held at 4.5:1 across all five themes
    // by `theme-contrast.test.ts`. Not a new pair.
    expect(ledgerCss).toMatch(/\.ledger__pinned \{[^}]*background: var\(--hr-hero-bg\)/s);
    expect(ledgerCss).toMatch(/\.ledger__pinned \{[^}]*color: var\(--hr-hero-text\)/s);
  });
});
