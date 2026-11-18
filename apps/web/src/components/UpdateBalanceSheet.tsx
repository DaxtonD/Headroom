/**
 * Updating the balance (HANDOFF section 6.1 and 7.1).
 *
 * Two taps: type the amount, save. The checklist underneath is the part the
 * brief asks for - "Did any of these clear since the last update?" - because
 * the balance read from the bank already has those withdrawals in it,
 * and without ticking them they would be counted twice.
 */
import { formatCents, formatDateShort, parseCents } from "@headroom/core";
import { useEffect, useId, useRef, useState } from "react";
import { Amount } from "./Badges.js";
import { ApiError, OfflineError, newIdempotencyKey } from "../lib/api.js";
import { useClearableCandidates, useDashboard, useUpdateBalance } from "../lib/queries.js";
import { useOverlayDismissal } from "../lib/overlayDismissal.js";
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

  const [amountText, setAmountText] = useState("");
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  /** Which account is being typed. Null until the accounts have landed. */
  const [accountId, setAccountId] = useState<string | null>(null);

  const dashboard = useDashboard();
  const accounts = dashboard.data?.accounts ?? [];
  const chequing = accounts.find((account) => account.kind === "chequing") ?? null;
  const selectedId = accountId ?? chequing?.id ?? null;
  const selected = accounts.find((account) => account.id === selectedId) ?? null;
  const isCard = selected?.kind === "credit_card";

  const clearable = useClearableCandidates(selectedId !== null, selectedId ?? undefined);
  const updateBalance = useUpdateBalance();

  /*
   * Nothing starts ticked, and nothing needs to.
   *
   * This used to arrive with every row already marked paid on the ledger
   * pre-ticked, reasoning that somebody who has said "we paid this" means
   * "it is inside the figure I am about to type" as well. The reasoning held;
   * the consequence did not. Saving cleared whatever was ticked, clearing
   * took a row off the ledger, and so one Save made a bill the household had
   * just dealt with vanish - with nothing on this screen saying it would.
   *
   * A paid row is now settled already, and the server leaves it out of these
   * candidates entirely. What is left to ask about is the genuine remainder:
   * things that came out of the account without anybody ticking them.
   */

  // The amount is the one thing the user came here to type.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Cancel, Escape, Back and a tap outside - all four inert while saving.
  const backdrop = useOverlayDismissal(onClose, updateBalance.isPending);

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
      setError(
        isCard
          ? "Enter what the card owes, without a minus sign. The app knows it is a debt."
          : "A balance below zero is unusual. Enter it without a minus if that was a typo.",
      );
      return;
    }

    try {
      await updateBalance.mutateAsync({
        cents: cents.toString(),
        ...(selectedId && selectedId !== chequing?.id ? { accountId: selectedId } : {}),
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
    /*
     * A div, not a button: this is the dark area around the sheet, and a
     * screen reader should find the dialog inside it rather than a
     * full-screen control to tab past. Tapping outside is a pointer
     * convenience on top of Cancel, Escape and Back, so nothing here is the
     * only way to do anything - which is why it does not need to be
     * reachable by keyboard itself.
     */
    <div
      className="sheet-backdrop"
      role="presentation"
      onPointerDown={backdrop.onPointerDown}
      onClick={backdrop.onClick}
    >
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <form onSubmit={(event) => void submit(event)}>
          <h2 className="sheet__title" id={titleId}>
            Update balance
          </h2>
          <p className="sheet__intro">
            {isCard
              ? `Type what ${selected?.name ?? "the card"} says it owes right now.`
              : `Type what the bank says is in ${selected?.name ?? "chequing"} right now.`}
          </p>

          {/*
            Which account, offered only when there is more than one.
            A household with a single chequing account sees exactly the two
            taps it always did.
          */}
          {accounts.length > 1 ? (
            <fieldset className="sheet__accounts">
              <legend className="sheet__accounts-legend">Which account?</legend>
              <div className="sheet__accounts-list">
                {accounts.map((account) => (
                  <label className="sheet__account" key={account.id}>
                    <input
                      type="radio"
                      name="account"
                      checked={selectedId === account.id}
                      onChange={() => {
                        setAccountId(account.id);
                        // The amount and the ticks belonged to the other
                        // account. Carrying them over would type one
                        // account's balance into another's.
                        setAmountText("");
                        setTicked(new Set());
                        setError(null);
                      }}
                      disabled={updateBalance.isPending}
                    />
                    <span className="sheet__account-name">{account.name}</span>
                    <span className="sheet__account-now hr-amount">
                      {formatCents(account.cents)}
                      {account.kind === "credit_card" ? " owed" : ""}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}

          {error ? (
            <p className="hr-alert sheet__error" role="alert">
              {error}
            </p>
          ) : null}

          <div className="hr-field">
            <label className="hr-label" htmlFor={amountId}>
              {isCard
                ? `Owed on ${selected?.name ?? "the card"}`
                : `Balance in ${selected?.name ?? "chequing"}`}
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
                {isCard
                  ? `Tick anything already on the ${selected?.name ?? "card"} statement, so it is not counted twice. Anything you marked paid is already accounted for and is not listed here.`
                  : "Tick anything the bank has already taken, so it is not counted twice. Anything you marked paid is already accounted for and is not listed here."}
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
              {isCard
                ? `Headroom currently thinks this owes ${formatCents(clearable.data.currentCents)}.`
                : `Headroom currently thinks you have ${formatCents(clearable.data.currentCents)}.`}
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
