/**
 * Updating the balance (HANDOFF section 6.1 and 7.1).
 *
 * Two taps: type the amount, save. The checklist underneath is the part the
 * brief asks for - "Did any of these clear since the last update?" - because
 * the balance Carol reads from the bank already has those withdrawals in it,
 * and without ticking them they would be counted twice.
 */
import { formatCents, formatDateShort, parseCents } from "@headroom/core";
import { useEffect, useId, useRef, useState } from "react";
import { Amount } from "./Badges.js";
import { ApiError, OfflineError, newIdempotencyKey } from "../lib/api.js";
import { useClearableCandidates, useUpdateBalance } from "../lib/queries.js";
import "./Sheet.css";
import "./UpdateBalanceSheet.css";

/**
 * Mounted only while open (see App.tsx), so every field starts fresh and there
 * is no reset effect to keep in step with the open/closed flag.
 */
export function UpdateBalanceSheet({ onClose }: { onClose: () => void }): React.JSX.Element {
  const amountId = useId();
  const titleId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

/**
 * Did this click's press begin on the backdrop itself?
 *
 * A `click` is dispatched on the nearest common ancestor of where the pointer
 * went down and where it came up. Select some text in the sheet, drag past its
 * edge and release, and that ancestor is the backdrop - so a plain
 * `onClick={onClose}` threw the form away mid-selection, losing whatever had
 * been typed. `stopPropagation` on the sheet cannot help: the sheet is not in
 * that event's path at all.
 *
 * So the press has to have started on the backdrop too. A deliberate click
 * outside still closes; a selection that merely ends outside does not.
 */
  const pressedBackdrop = useRef(false);

  const [amountText, setAmountText] = useState("");
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const clearable = useClearableCandidates(true);
  const updateBalance = useUpdateBalance();

  /*
   * Anything already ticked as dealt with on the ledger starts ticked here.
   *
   * The two gestures answer different questions - "we have paid this" and
   * "this is inside the figure I just read off the bank" - but when somebody
   * has said the first, the second is almost always true as well, and making
   * them say it twice is how a bill ends up counted twice.
   *
   * Adjusted during render rather than in an effect, so the boxes are never
   * painted empty and then ticked.
   */
  const [seenCandidates, setSeenCandidates] = useState<string | null>(null);
  const candidateKey = clearable.data?.candidates.map((candidate) => candidate.id).join("|") ?? null;
  if (candidateKey !== null && candidateKey !== seenCandidates) {
    setSeenCandidates(candidateKey);
    setTicked(
      new Set(
        (clearable.data?.candidates ?? [])
          .filter((candidate) => candidate.paid)
          .map((candidate) => candidate.id),
      ),
    );
  }

  // The amount is the one thing the user came here to type.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Escape closes, as it should for anything modal.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);

    let cents: bigint;
    try {
      cents = parseCents(amountText);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That is not an amount.");
      return;
    }

    if (cents < 0n) {
      setError("A chequing balance below zero is unusual. Enter it without a minus if that was a typo.");
      return;
    }

    try {
      await updateBalance.mutateAsync({
        cents: cents.toString(),
        clearedOccurrenceIds: [...ticked],
        // One key for this whole save, so a double tap cannot record it twice.
        idempotencyKey: newIdempotencyKey(),
      });
      onClose();
    } catch (caught) {
      if (caught instanceof OfflineError) setError(caught.message);
      else if (caught instanceof ApiError) setError(caught.message);
      else setError("That did not save. Please try again.");
    }
  };

  const toggle = (id: string): void => {
    setTicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div
      className="sheet-backdrop"
      onPointerDown={(event) => {
        pressedBackdrop.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        const fromBackdrop =
          pressedBackdrop.current && event.target === event.currentTarget;
        pressedBackdrop.current = false;
        if (fromBackdrop) onClose();
      }}
      role="presentation"
    >
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <form onSubmit={(event) => void submit(event)}>
          <h2 className="sheet__title" id={titleId}>
            Update balance
          </h2>
          <p className="sheet__intro">
            Type what the bank says is in chequing right now.
          </p>

          {error ? (
            <p className="hr-alert sheet__error" role="alert">
              {error}
            </p>
          ) : null}

          <div className="hr-field">
            <label className="hr-label" htmlFor={amountId}>
              Balance in chequing
            </label>
            <input
              className="hr-input sheet__amount"
              id={amountId}
              ref={inputRef}
              type="text"
              /* decimal, not numeric, so the phone shows a decimal point. */
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.00"
              value={amountText}
              onChange={(event) => setAmountText(event.target.value)}
              disabled={updateBalance.isPending}
            />
          </div>

          {clearable.data && clearable.data.candidates.length > 0 ? (
            <fieldset className="sheet__clearable">
              <legend className="sheet__clearable-legend">
                Did any of these come out since you last updated?
              </legend>
              <p className="sheet__clearable-note">
                Tick anything the bank has already taken, so it is not counted twice. Anything
                you marked paid on the ledger is ticked for you.
              </p>
              <ul className="sheet__clearable-list">
                {clearable.data.candidates.map((candidate) => (
                  <li key={candidate.id}>
                    <label className="sheet__clearable-item">
                      <input
                        type="checkbox"
                        checked={ticked.has(candidate.id)}
                        onChange={() => toggle(candidate.id)}
                        disabled={updateBalance.isPending}
                      />
                      <span className="sheet__clearable-name">{candidate.name}</span>
                      <span className="sheet__clearable-date">
                        {candidate.date ? formatDateShort(candidate.date) : ""}
                      </span>
                      <Amount cents={candidate.cents} />
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>
          ) : null}

          {clearable.data ? (
            <p className="sheet__current">
              Headroom currently thinks you have {formatCents(clearable.data.currentCents)}.
            </p>
          ) : null}

          <div className="sheet__actions">
            <button
              className="hr-button hr-button--secondary"
              type="button"
              onClick={onClose}
              disabled={updateBalance.isPending}
            >
              Cancel
            </button>
            <button className="hr-button" type="submit" disabled={updateBalance.isPending}>
              {updateBalance.isPending ? "Saving…" : "Save balance"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
