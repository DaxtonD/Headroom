/**
 * One row of the ledger, and what it does when expanded
 * (HANDOFF section 7.2).
 *
 * Expanded, a row offers exactly the things the brief asks for: edit the
 * amount, verify it, move a flexible bill to an earlier or later payday, and
 * mark it paid or received. A one-off can also be removed, which a row from a
 * bill cannot: that one belongs to the bill.
 *
 * Every save carries the version this row was rendered from, so if the other
 * person changed the same field first the server says so and this component
 * shows the choice rather than overwriting their work (section 16.3).
 */
import { formatCents, formatDateShort, parseCents } from "@headroom/core";
import { useId, useState } from "react";
import { Amount, Chip, PaidBadge, VerificationBadge } from "./Badges.js";
import { Thumb } from "./Thumb.js";
import { ApiError, OfflineError, newIdempotencyKey } from "../lib/api.js";
import { conflictFrom, type ConflictInfo, type OccurrenceChange, type TimelineRow } from "../lib/queries.js";
import "./OccurrenceRow.css";

export interface MoveTarget {
  readonly id: string | null;
  readonly label: string;
}

export interface OccurrenceRowProps {
  readonly row: TimelineRow;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly canEdit: boolean;
  readonly moveTargets: readonly MoveTarget[];
  readonly onSave: (input: {
    id: string;
    baseVersion: number;
    changes: OccurrenceChange;
    idempotencyKey: string;
  }) => Promise<unknown>;
  /**
   * Remove this row entirely. Offered only for a one-off, and only when the
   * screen supplies it.
   *
   * Separate from `onSave` because it is not a field change: it takes the row
   * off the ledger, which is a different statement from marking it paid.
   */
  readonly onRemove?: (input: { id: string; version: number }) => Promise<unknown>;
  /**
   * The account this came out of, when it was not chequing.
   *
   * A name rather than an id: the row has no business looking accounts up, and
   * the screen already holds them. Null means chequing, and nothing is shown -
   * saying "Chequing" on almost every row would be noise.
   */
  readonly chargedTo?: string | null;
  /** The account this is a payment toward, when it is one. */
  readonly paidToward?: string | null;
}

export function OccurrenceRow({
  row,
  expanded,
  onToggle,
  canEdit,
  moveTargets,
  onSave,
  onRemove,
  chargedTo = null,
  paidToward = null,
}: OccurrenceRowProps): React.JSX.Element {
  const amountId = useId();
  const dateId = useId();
  const panelId = useId();

  const [amountText, setAmountText] = useState(() => formatCents(row.cents, { currencySymbol: false }));
  const [dateText, setDateText] = useState(row.date ?? "");
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ConflictInfo | null>(null);
  const [saving, setSaving] = useState(false);
  const [merged, setMerged] = useState(false);

  // If the row changes underneath us (the other phone saved something), adopt
  // the new value rather than keeping a stale one in the box.
  //
  // Adjusted during render rather than in an effect: React re-runs the render
  // immediately with the new state and never paints the stale value, whereas
  // an effect would paint once with the old amount and then again with the
  // new one. (Remounting on a key would also work, but it would collapse the
  // expanded panel every time anyone saved anything.)
  // Two presses to remove rather than a confirm(): the native dialog is
  // blocked in some installed-PWA contexts, and a button that becomes the
  // question keeps it where the answer is.
  const [armed, setArmed] = useState(false);
  const [seenVersion, setSeenVersion] = useState(row.version);
  if (seenVersion !== row.version) {
    setSeenVersion(row.version);
    setAmountText(formatCents(row.cents, { currencySymbol: false }));
    setDateText(row.date ?? "");
    setConflict(null);
    setError(null);
  }

  const isPaycheque = row.kind === "paycheque";

  /*
   * Did this row move the account the ledger is about?
   *
   * Two reasons it might not have: it has settled, so the figure at the top
   * already went past it, or it belongs to another account - a charge on a
   * credit card, which the card pays and chequing does not. Either way the
   * running balance walks through unchanged, and the row says why.
   */
  const movedNothing = row.deltaCents === 0n;

  const save = async (changes: OccurrenceChange, baseVersion = row.version): Promise<void> => {
    setSaving(true);
    setError(null);
    setConflict(null);
    setMerged(false);

    try {
      // One key per user action, reused if the request has to be retried.
      const result = (await onSave({
        id: row.id,
        baseVersion,
        changes,
        idempotencyKey: newIdempotencyKey(),
      })) as { merged?: boolean } | undefined;

      if (result?.merged) setMerged(true);
    } catch (caught) {
      const found = conflictFrom(caught);
      if (found) {
        setConflict(found);
      } else if (caught instanceof OfflineError) {
        setError(caught.message);
      } else if (caught instanceof ApiError) {
        setError(caught.message);
      } else {
        setError("That did not save. Please try again.");
      }
    } finally {
      setSaving(false);
    }
  };

  const saveAmount = async (): Promise<void> => {
    let cents: bigint;
    try {
      cents = parseCents(amountText);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That is not an amount.");
      return;
    }

    if (cents === absMagnitude(row.cents)) {
      // Nothing changed, so there is nothing to send.
      return;
    }

    // The sign belongs to the kind of thing it is, not to what was typed:
    // a bill is money out whether or not a minus was entered.
    const signed = row.cents < 0n ? -absOf(cents) : absOf(cents);
    await save({ cents: signed.toString() });
  };

  return (
    <li
      className={`row ${isPaycheque ? "row--payday" : ""} ${expanded ? "row--expanded" : ""} ${
        row.settled ? "row--paid" : ""
      }`}
    >
      <button
        className="row__summary"
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={panelId}
      >
        {isPaycheque ? (
          <span className="row__payday-mark" role="img" aria-label="Payday">
            <span aria-hidden="true">+</span>
          </span>
        ) : row.settled ? (
          /*
            Paid replaces verified rather than joining it. A row can be paid
            without anyone having confirmed the amount first, and leaving the
            estimate badge on a bill that has already left the account was
            the thing that read as wrong: the money is gone, so "still an
            estimate" is no longer the useful fact about it.
          */
          <PaidBadge paidBy={row.paidBy} />
        ) : (
          <VerificationBadge verified={row.verified} verifiedBy={row.verifiedBy} />
        )}

        {/*
          After the badge, not instead of it: the badge is state and this is
          identity, and both are worth a glance. A row with a picture is a
          little wider in its left column and so may wrap its name onto a
          second line - which is already how this row prefers to handle a long
          name, so it degrades into something the design already does.
        */}
        <Thumb imageId={row.imageId} size="row" />

        <span className="row__main">
          <span className="row__name">{row.name}</span>
          <span className="row__chips">
            {/*
              Driven by `settled`, not by `paid`. A row taken into a typed
              balance by the checklist has gone from the account just as
              surely, and nobody ever marked it paid - without this it would
              sit on the ledger looking outstanding with the money already
              spent.
            */}
            {row.settled ? (
              <Chip tone="payday">{row.cents > 0n ? "Received" : "Paid"}</Chip>
            ) : null}
            {isPaycheque ? (
              <Chip tone="payday">Payday · {row.date ? formatDateShort(row.date) : ""}</Chip>
            ) : row.isDated ? (
              <Chip tone="neutral">
                {row.cents > 0n ? "Auto deposit" : "Auto"} · {row.date ? formatDateShort(row.date) : ""}
              </Chip>
            ) : (
              <Chip tone="flexible">
                {row.date ? `Flexible · ${formatDateShort(row.date)}` : "Flexible"}
              </Chip>
            )}
            {row.isOneOff ? <Chip tone="oneoff">One-off</Chip> : null}
            {/*
              Which card it went on, and which card a payment is for. Without
              this a charge is a row with an amount and no running balance,
              and the only honest reading of that is "something is broken".
            */}
            {chargedTo ? <Chip tone="neutral">{chargedTo}</Chip> : null}
            {paidToward ? <Chip tone="flexible">Pays {paidToward}</Chip> : null}
          </span>
          {!isPaycheque ? (
            <span className="row__owner">
              {row.settled
                ? row.paidBy
                  ? `Marked by ${row.paidBy.name}`
                  : "Counted in your balance"
                : chargedTo
                  ? `Charged to ${chargedTo}`
                  : row.verified
                  ? row.verifiedBy
                    ? `Verified by ${row.verifiedBy.name}`
                    : "Verified"
                  : row.owner
                    ? `${row.owner.name}'s bill · still an estimate`
                    : "Set who gets this bill"}
            </span>
          ) : null}
        </span>

        <span className="row__figures">
          <Amount cents={row.cents} className="row__amount" signed />
          {/*
            A row that moved nothing still prints its running balance, dimmed.

            An earlier attempt at this replaced the figure with the words "in
            your balance", which left a column of rows with no numbers beside
            them and read as though something had broken. The balance has
            simply walked past unchanged, and showing that is more honest than
            hiding it.

            Driven by the delta rather than by `settled`, so a charge on a card
            reads the same way for the same reason: this account's balance did
            not move here.
          */}
          <span
            className={`row__running hr-amount ${movedNothing ? "row__running--settled" : ""}`}
          >
            {formatCents(row.runningCents)}
          </span>
        </span>
      </button>

      {expanded ? (
        <div className="row__panel" id={panelId}>
          {row.isDated && !isPaycheque ? (
            <p className="row__note">
              Comes out automatically on {row.date ? formatDateShort(row.date) : "its date"}. The
              money has to be in the account by then.
            </p>
          ) : null}
          {!row.isDated ? (
            <p className="row__note">
              {row.date
                ? "Flexible: this is the day you plan to pay it, not a day the bank takes it. Change the date or hang it off a payday whenever money is tight."
                : "Flexible: it can move to an earlier or later payday when money is tight."}
            </p>
          ) : null}

          {row.settled ? (
            <p className="row__note">
              {row.paid
                ? "The money has gone, so it has come off the balance at the top and stops counting towards the running balance. Typing in a balance from the bank replaces that estimate with what the bank actually says."
                : "Counted in the balance you typed in from the bank, so it is not subtracted again."}
            </p>
          ) : null}

          {chargedTo && !row.settled ? (
            <p className="row__note">
              Charged to {chargedTo}, so it does not come out of chequing. Marking it paid raises
              what {chargedTo} owes. The chequing money leaves when you pay {chargedTo} itself.
            </p>
          ) : null}

          {paidToward ? (
            <p className="row__note">
              A payment toward {paidToward}. Marking it paid takes it out of this account and off
              what {paidToward} owes, both at once.
            </p>
          ) : null}

          {merged ? (
            <p className="row__merged" role="status">
              Saved. Someone else had changed something else about this, and both changes stand.
            </p>
          ) : null}

          {conflict ? (
            <div className="row__conflict" role="alert">
              <p className="row__conflict-title">
                {conflict.changedBy.name} changed this to{" "}
                {typeof conflict.current["cents"] === "string"
                  ? formatCents(BigInt(conflict.current["cents"] as string))
                  : "something else"}
                {conflict.current["verified"] === true ? " (verified)" : ""}{" "}
                {describeWhen(conflict.changedAt)}.
              </p>
              <div className="row__conflict-actions">
                <button
                  className="hr-button hr-button--secondary"
                  type="button"
                  disabled={saving}
                  onClick={() => {
                    // Keep theirs: discard this edit and show their value.
                    setConflict(null);
                    if (typeof conflict.current["cents"] === "string") {
                      setAmountText(
                        formatCents(BigInt(conflict.current["cents"] as string), {
                          currencySymbol: false,
                        }),
                      );
                    }
                  }}
                >
                  Keep{" "}
                  {typeof conflict.current["cents"] === "string"
                    ? formatCents(BigInt(conflict.current["cents"] as string))
                    : "theirs"}
                </button>
                <button
                  className="hr-button"
                  type="button"
                  disabled={saving}
                  onClick={() => {
                    // Use mine: resend against the version that won. Changing a
                    // verified amount un-verifies it, so the other person sees
                    // it needs looking at again.
                    void save(
                      { cents: signedFor(row, amountText), verified: false },
                      conflict.current.version,
                    );
                  }}
                >
                  Use {formatAttempt(amountText)}
                </button>
              </div>
            </div>
          ) : null}

          {error ? (
            <p className="hr-alert row__error" role="alert">
              {error}
            </p>
          ) : null}

          <div className="row__controls">
            <div className="hr-field row__amount-field">
              <label className="hr-label" htmlFor={amountId}>
                Amount
              </label>
              <div className="row__amount-input">
                <input
                  className="hr-input"
                  id={amountId}
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  value={amountText}
                  onChange={(event) => setAmountText(event.target.value)}
                  disabled={!canEdit || saving}
                />
                <button
                  className="hr-button"
                  type="button"
                  onClick={() => void saveAmount()}
                  disabled={!canEdit || saving}
                >
                  {saving ? "Saving…" : "Save"}
                </button>
              </div>
            </div>

            <div className="row__buttons">
              {!isPaycheque ? (
                <button
                  className={`hr-button ${row.verified ? "hr-button--secondary" : ""}`}
                  type="button"
                  disabled={!canEdit || saving}
                  onClick={() => void save({ verified: !row.verified })}
                >
                  {row.verified ? "Undo verify" : "Verify this amount"}
                </button>
              ) : null}

              {/*
                A tick, not a transaction. It records that the two of them have
                dealt with something and moves no figure: whether the money has
                left is answered by the balance typed in off the bank. It used
                to clear the row instead, which took it off the ledger
                entirely and subtracted it from the balance a second time if
                that balance had already accounted for it.
              */}
              <button
                className={`hr-button ${row.paid ? "" : "hr-button--secondary"}`}
                type="button"
                disabled={!canEdit || saving}
                onClick={() => void save({ paid: !row.paid })}
              >
                {row.paid
                  ? row.cents > 0n
                    ? "Undo received"
                    : "Undo paid"
                  : row.cents > 0n
                    ? "Mark as received"
                    : "Mark as paid"}
              </button>
            </div>

            {/*
              Removing is for a row somebody typed in by hand. Without it, a
              mistyped one-off would distort every figure on the ledger with no
              way out but SQL - and marking it paid would be a lie.
            */}
            {row.isOneOff && onRemove ? (
              <div className="row__remove">
                {armed ? (
                  <>
                    <p className="row__note">
                      Remove {row.name}? It stops counting. The record of it stays in the history.
                    </p>
                    <div className="row__buttons">
                      <button
                        className="hr-button row__danger"
                        type="button"
                        disabled={!canEdit || saving}
                        onClick={() => {
                          setSaving(true);
                          setError(null);
                          void onRemove({ id: row.id, version: row.version })
                            .catch((caught: unknown) => {
                              setError(
                                caught instanceof OfflineError || caught instanceof ApiError
                                  ? caught.message
                                  : "Could not remove it.",
                              );
                            })
                            .finally(() => {
                              setSaving(false);
                              setArmed(false);
                            });
                        }}
                      >
                        Yes, remove it
                      </button>
                      <button
                        className="hr-button hr-button--secondary"
                        type="button"
                        onClick={() => setArmed(false)}
                      >
                        Keep it
                      </button>
                    </div>
                  </>
                ) : (
                  <button
                    className="hr-button hr-button--secondary"
                    type="button"
                    disabled={!canEdit || saving}
                    onClick={() => setArmed(true)}
                  >
                    Remove this one-off
                  </button>
                )}
              </div>
            ) : null}

            {!row.isDated ? (
              <div className="hr-field row__date-field">
                <label className="hr-label" htmlFor={dateId}>
                  Plan to pay it on
                </label>
                <div className="row__date-input">
                  <input
                    className="hr-input"
                    id={dateId}
                    type="date"
                    value={dateText}
                    onChange={(event) => setDateText(event.target.value)}
                    disabled={!canEdit || saving}
                  />
                  <button
                    className="hr-button"
                    type="button"
                    onClick={() => void save({ date: dateText === "" ? null : dateText })}
                    disabled={!canEdit || saving || dateText === (row.date ?? "")}
                  >
                    {saving ? "Saving…" : "Save"}
                  </button>
                </div>
              </div>
            ) : null}

            {!row.isDated && moveTargets.length > 0 ? (
              <div className="row__move">
                <p className="hr-label">{row.date ? "Or hang it off a payday" : "Move to"}</p>
                <div className="row__move-buttons">
                  {moveTargets.map((target) => (
                    <button
                      key={target.id ?? "now"}
                      className="hr-button hr-button--secondary row__move-button"
                      type="button"
                      disabled={!canEdit || saving || target.id === row.anchorOccurrenceId}
                      onClick={() => void save({ anchorOccurrenceId: target.id })}
                    >
                      {target.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </li>
  );
}

function absOf(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function absMagnitude(value: bigint): bigint {
  return absOf(value);
}

/** The typed amount, signed the way this row's kind requires. */
function signedFor(row: TimelineRow, text: string): string {
  try {
    const magnitude = absOf(parseCents(text));
    return (row.cents < 0n ? -magnitude : magnitude).toString();
  } catch {
    return row.cents.toString();
  }
}

function formatAttempt(text: string): string {
  try {
    return formatCents(absOf(parseCents(text)));
  } catch {
    return "mine";
  }
}

/** "2 minutes ago", for the conflict notice. */
function describeWhen(iso: string): string {
  // Math.round is restricted for money. This is elapsed time, not an amount.
  /* eslint-disable no-restricted-properties */
  const seconds = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  /* eslint-enable no-restricted-properties */
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return new Date(iso).toLocaleDateString("en-CA", { month: "short", day: "numeric" });
}
