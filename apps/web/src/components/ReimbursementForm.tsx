/**
 * Recording a work purchase that will be paid back.
 *
 * Something bought on the card for work: it leaves the chequing account now
 * and comes back later, so it is tracked separately from a bill. Only the
 * creation is here — moving it along to "submitted" and "paid back" happens on
 * the Savings screen, where the whole trail is visible.
 */
import { formatCents, parseCents } from "@headroom/core";
import { useId, useState } from "react";
import { ApiError, OfflineError } from "../lib/api.js";
import { useCreateReimbursement } from "../lib/manageQueries.js";
import { useDashboard } from "../lib/queries.js";
import { Field, Sheet } from "./Sheet.js";

export function ReimbursementForm({ onClose }: { onClose: () => void }): React.JSX.Element {
  const create = useCreateReimbursement();
  // The server's date, never the browser's: the server clock is authoritative
  // and a phone with a wrong date would otherwise file the purchase in the
  // wrong pay period.
  const dashboard = useDashboard();
  const ids = { purchase: useId(), amount: useId(), boughtOn: useId() };

  const [purchase, setPurchase] = useState("");
  const [amount, setAmount] = useState("");
  // Defaults to today, because that is when it is nearly always entered. Left
  // blank until the server has said what today is.
  const [boughtOn, setBoughtOn] = useState("");
  const [error, setError] = useState<string | null>(null);

  const today = dashboard.data?.today ?? "";
  const effectiveDate = boughtOn === "" ? today : boughtOn;

  const preview = (() => {
    try {
      const cents = parseCents(amount === "" ? "0" : amount);
      return cents > 0n ? cents : null;
    } catch {
      return null;
    }
  })();

  const submit = async (): Promise<void> => {
    setError(null);

    if (purchase.trim() === "") {
      setError("What was bought?");
      return;
    }
    if (effectiveDate === "") {
      setError("When was it bought?");
      return;
    }

    let cents: bigint;
    try {
      cents = parseCents(amount);
    } catch {
      setError("That amount is not a number.");
      return;
    }
    if (cents <= 0n) {
      setError("An expense has to be above zero.");
      return;
    }

    try {
      await create.mutateAsync({
        purchase: purchase.trim(),
        cents: cents.toString(),
        boughtOn: effectiveDate,
      });
      onClose();
    } catch (caught) {
      if (caught instanceof OfflineError || caught instanceof ApiError) setError(caught.message);
      else setError("That did not save. Please try again.");
    }
  };

  return (
    <Sheet
      title="Add a work expense"
      intro="Bought for work and owed back to you. It starts at 'bought' and you move it along as it is submitted and repaid."
      error={error}
      saving={create.isPending}
      saveLabel="Add it"
      onClose={onClose}
      onSubmit={submit}
    >
      <Field label="What was bought?" htmlFor={ids.purchase}>
        <input
          className="hr-input"
          id={ids.purchase}
          type="text"
          value={purchase}
          onChange={(event) => setPurchase(event.target.value)}
          placeholder="Hotel"
          disabled={create.isPending}
          required
        />
      </Field>

      <Field label="How much?" htmlFor={ids.amount}>
        <input
          className="hr-input"
          id={ids.amount}
          type="text"
          inputMode="decimal"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          placeholder="0.00"
          disabled={create.isPending}
          required
        />
      </Field>

      <Field label="When?" htmlFor={ids.boughtOn}>
        <input
          className="hr-input"
          id={ids.boughtOn}
          type="date"
          value={effectiveDate}
          onChange={(event) => setBoughtOn(event.target.value)}
          disabled={create.isPending}
          required
        />
      </Field>

      {preview ? (
        <div className="sheet__preview">
          <p className="sheet__preview-title">Owed back to you</p>
          <p className="sheet__preview-amount hr-amount">{formatCents(preview)}</p>
          <p className="sheet__preview-note">
            Counted as outstanding until you mark it paid back.
          </p>
        </div>
      ) : null}
    </Sheet>
  );
}
