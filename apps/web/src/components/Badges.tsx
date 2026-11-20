/**
 * The badges and chips from the mockups (HANDOFF section 15).
 *
 * The verified/estimate distinction is the one read at a glance, and the
 * brief is specific about it: a filled green check with the verifier's initial
 * when someone has entered the real amount, versus a dashed ring with a "~"
 * when it is still a guess. In the spreadsheet this was someone typing an "X";
 * here it is graphical, and it never relies on colour alone - the shape, the
 * symbol and the accessible name all carry the meaning.
 */
import type { Cents } from "@headroom/core";
import { formatCents } from "@headroom/core";
import { firstNameOf, initialOf } from "../lib/people.js";
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

/**
 * The money has gone, and who said so.
 *
 * A filled green badge like the verified one, because both are good news and
 * the eye should read them the same way, but carrying a dollar sign rather
 * than a tick: verified is "we know the amount", paid is "it has left the
 * account". A row can be paid without ever having been verified, which is why
 * this replaces that badge rather than sitting beside it.
 *
 * No initial when nobody marked it paid. That happens when the balance
 * checklist settled it instead, and inventing a person for it would be a
 * worse answer than leaving it off.
 */
export function PaidBadge({ paidBy }: { paidBy?: Person | null }): React.JSX.Element {
  const label = paidBy ? `Paid by ${paidBy.name}` : "Paid";

  return (
    <span className="badge badge--paid" role="img" aria-label={label}>
      <span className="badge__glyph" aria-hidden="true">
        $
      </span>
      {paidBy ? (
        <span className="badge__initial" aria-hidden="true">
          {initialOf(paidBy)}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Money arriving: a payday, and whether it has landed.
 *
 * This was a bare "+" in a tinted circle for most of the build, and reported
 * from use as the row having no badge at all - which was very nearly true.
 * The circle was `--hr-green-tint` and a payday row is `--hr-payday-row`;
 * those two are a few percent apart in every light theme, and on an EXPANDED
 * payday row they are literally the same token. So the mark had no edge, no
 * fill anyone could see and no initial, while the bill above it carried a
 * filled badge saying who had paid it.
 *
 * It is now the same badge as the rest of the ledger, carrying a "+" rather
 * than a tick or a dollar sign so money in still reads as money in at a
 * glance: filled once the money is in the account, an outlined ring with a
 * real border until then. The ring is drawn in `--hr-positive` rather than
 * being a lighter fill, because the one thing this badge may never do again
 * is disappear into the row it sits on.
 *
 * The initial is `paidBy` only, exactly as `PaidBadge` does it. A paycheque
 * settled by the balance checklist has nobody attached, and inventing one
 * would be worse than leaving it off.
 */
export function PaydayBadge({
  received,
  paidBy,
}: {
  received: boolean;
  paidBy?: Person | null;
}): React.JSX.Element {
  const label = received ? (paidBy ? `Received, marked by ${paidBy.name}` : "Received") : "Payday";

  return (
    <span
      className={`badge ${received ? "badge--received" : "badge--incoming"}`}
      role="img"
      aria-label={label}
    >
      <span className="badge__glyph" aria-hidden="true">
        +
      </span>
      {received && paidBy ? (
        <span className="badge__initial" aria-hidden="true">
          {initialOf(paidBy)}
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

/**
 * A person's first name, in their own colours.
 *
 * The alternative to `InitialBubble`, for the places where one letter is not
 * enough. An initial only tells two people apart when their names start with
 * different letters, and there is no rule that they do - in the household
 * this was built for they do not, so every row of the activity log opened
 * with the same letter whoever had done the thing.
 *
 * Deliberately readable rather than `aria-hidden`: where this is used it is
 * the only thing naming who acted, so hiding it would leave a screen reader
 * with "verified the mortgage" and no subject.
 *
 * Built on `.chip` so it is the same shape and size as every other chip on a
 * row; only the colours are the person's own, and they come from the server
 * rather than from CSS because they are a property of the person.
 */
export function NameChip({
  person,
  colorFg,
  colorBg,
}: {
  // Only the name: this is used with the activity log's person as well as
  // with `Person`, and the stored initial is none of its business.
  person: { readonly name: string };
  colorFg?: string;
  colorBg?: string;
}): React.JSX.Element {
  return (
    <span
      className="chip name-chip"
      style={{
        color: colorFg ?? "var(--hr-neutral-fg)",
        background: colorBg ?? "var(--hr-neutral-bg)",
      }}
    >
      {firstNameOf(person.name)}
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
