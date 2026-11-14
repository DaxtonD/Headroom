/**
 * The badges and chips from the mockups (HANDOFF section 15).
 *
 * The verified/estimate distinction is the one Carol and Dax read at a glance,
 * and the brief is specific about it: a filled green check with the verifier's
 * initial when someone has entered the real amount, versus a dashed ring with
 * a "~" when it is still a guess. In the spreadsheet this was Dax typing an
 * "X"; here it is graphical, and it never relies on colour alone - the shape,
 * the symbol and the accessible name all carry the meaning.
 */
import type { Cents } from "@headroom/core";
import { formatCents } from "@headroom/core";
import { initialOf } from "../lib/people.js";
import "./Badges.css";

export interface Person {
  readonly id: string;
  readonly name: string;
  /**
   * Kept because the API sends it and the CLI prints it, and deliberately not
   * used for display: see `initialOf` in `lib/people.ts`.
   */
  readonly initial: string;
}

/** An amount, always with tabular figures so columns line up. */
export function Amount({
  cents,
  className = "",
  signed = false,
}: {
  cents: Cents;
  className?: string;
  signed?: boolean;
}): React.JSX.Element {
  const text = formatCents(cents, { alwaysSign: signed });
  return (
    <span className={`hr-amount ${cents < 0n ? "amount--out" : "amount--in"} ${className}`.trim()}>
      {text}
    </span>
  );
}

/**
 * Verified, or still an estimate.
 *
 * The accessible name says who verified it and when the UI knows, because the
 * badge is the whole point of the row for the person who did not enter it.
 */
export function VerificationBadge({
  verified,
  verifiedBy,
}: {
  verified: boolean;
  verifiedBy?: Person | null;
}): React.JSX.Element {
  if (!verified) {
    return (
      <span className="badge badge--estimate" role="img" aria-label="Still an estimate">
        <span aria-hidden="true">~</span>
      </span>
    );
  }

  const label = verifiedBy ? `Verified by ${verifiedBy.name}` : "Verified";

  return (
    <span className="badge badge--verified" role="img" aria-label={label}>
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path
          d="M20 6 9 17l-5-5"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {verifiedBy ? (
        <span className="badge__initial" aria-hidden="true">
          {initialOf(verifiedBy)}
        </span>
      ) : null}
    </span>
  );
}

export type ChipTone = "neutral" | "flexible" | "oneoff" | "payday" | "warning";

/** The small label on each row: `Auto · Nov 13`, `Flexible`, `Payday`. */
export function Chip({
  tone = "neutral",
  children,
}: {
  tone?: ChipTone;
  children: React.ReactNode;
}): React.JSX.Element {
  return <span className={`chip chip--${tone}`}>{children}</span>;
}

/** A person's initial, in their own colours. */
export function InitialBubble({
  person,
  colorFg,
  colorBg,
}: {
  person: Person;
  colorFg?: string;
  colorBg?: string;
}): React.JSX.Element {
  return (
    <span
      className="initial-bubble"
      style={{ color: colorFg ?? "var(--hr-neutral-fg)", background: colorBg ?? "var(--hr-neutral-bg)" }}
      title={person.name}
    >
      <span aria-hidden="true">{initialOf(person)}</span>
      <span className="hr-visually-hidden">{person.name}</span>
    </span>
  );
}

/** "All 8 covered", or the warning that replaces it. */
export function CoveragePill({
  allCovered,
  count,
}: {
  allCovered: boolean;
  count: number;
}): React.JSX.Element {
  return (
    <span className={`coverage-pill ${allCovered ? "coverage-pill--ok" : "coverage-pill--warn"}`}>
      {allCovered ? `All ${count} covered` : "Not enough for one bill"}
    </span>
  );
}
