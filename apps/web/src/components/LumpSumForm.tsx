/**
 * A lump sum against the mortgage, paid or intended.
 *
 * The "already paid" switch is the point of this form. An intention and a
 * payment are different facts, and keeping them apart is what lets the screen
 * answer the question the household actually has: what does next year's lump
 * sum buy, and what would skipping it cost? Recording an intention as though
 * it had happened would make that question unanswerable.
 *
 * It also keeps the prepayment allowance honest. Only money actually paid
 * counts against the year's room; counting an intention would understate the
 * room and talk them out of paying it.
 */
import { formatCents, parseCents } from "@headroom/core";
import { useId, useState } from "react";
import { Field, RemoveButton, Sheet } from "./Sheet.js";
import { ApiError, OfflineError } from "../lib/api.js";
import {
  useCreatePrepayment,
  useDeletePrepayment,
  usePatchPrepayment,
  type LumpSum,
} from "../lib/savingsQueries.js";

export function LumpSumForm({
  mortgageId,
  existing,
  today,
  onClose,
}: {
  mortgageId: string;
  existing: LumpSum | null;
  today: string;
  onClose: () => void;
}): React.JSX.Element {
  const create = useCreatePrepayment();
  const patch = usePatchPrepayment();
  const remove = useDeletePrepayment();
  const ids = { amount: useId(), paidOn: useId(), note: useId(), paid: useId() };

  const [amount, setAmount] = useState(
    existing ? formatCents(existing.cents, { currencySymbol: false, grouping: false }) : "",
  );
  const [paidOn, setPaidOn] = useState(existing?.paidOn ?? today);
  const [note, setNote] = useState(existing?.note ?? "");
  const [paid, setPaid] = useState(existing?.paid ?? true);
  const [error, setError] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);

  const saving = create.isPending || patch.isPending || remove.isPending;

  const submit = async (): Promise<void> => {
    setError(null);

    let cents: bigint;
    try {
      cents = parseCents(amount);
    } catch {
      setError("That amount is not a number.");
      return;
    }
    if (cents <= 0n) {
      setError("A lump sum has to be more than nothing.");
      return;
    }
    if (paidOn === "") {
      setError("Give the date.");
      return;
    }

    const input = {
      paidOn,
      cents: cents.toString(),
      ...(note.trim() === "" ? {} : { note: note.trim() }),
      paid,
    };

    try {
      if (existing) {
        await patch.mutateAsync({ id: existing.id, version: existing.version, changes: input });
      } else {
        await create.mutateAsync({ ...input, mortgageId });
      }
      onClose();
    } catch (caught) {
      if (caught instanceof OfflineError || caught instanceof ApiError) setError(caught.message);
      else setError("That did not save. Please try again.");
    }
  };

  const destroy = async (): Promise<void> => {
    if (!existing) return;
    setError(null);
    try {
      await remove.mutateAsync({ id: existing.id, version: existing.version });
      onClose();
    } catch (caught) {
      if (caught instanceof OfflineError || caught instanceof ApiError) setError(caught.message);
      else setError("Could not remove it.");
    }
  };

  return (
    <Sheet
      title={existing ? "Lump sum" : "Add a lump sum"}
      intro="An extra payment straight off the principal. Record one you plan to make and the payoff date shows what it buys."
      error={error}
      saving={saving}
      saveLabel={existing ? "Save changes" : "Add it"}
      onClose={onClose}
      onSubmit={submit}
      footer={
        existing ? (
          <RemoveButton
            label="Remove this lump sum"
            confirmLabel="Yes, remove it"
            note="It stops counting towards the payoff date and the year's allowance."
            armed={armed}
            disabled={saving}
            onArm={() => setArmed(true)}
            onConfirm={() => void destroy()}
          />
        ) : null
      }
    >
      <Field label="How much?" htmlFor={ids.amount}>
        <input
          className="hr-input"
          id={ids.amount}
          type="text"
          inputMode="decimal"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          placeholder="0.00"
          disabled={saving}
          required
        />
      </Field>

      <Field
        label="When?"
        htmlFor={ids.paidOn}
        hint="It lands with the first payment on or after this date."
      >
        <input
          className="hr-input"
          id={ids.paidOn}
          type="date"
          value={paidOn}
          onChange={(event) => setPaidOn(event.target.value)}
          disabled={saving}
          required
        />
      </Field>

      <label className="sheet__checkbox" htmlFor={ids.paid}>
        <input
          id={ids.paid}
          type="checkbox"
          checked={paid}
          onChange={(event) => setPaid(event.target.checked)}
          disabled={saving}
        />
        <span>
          This has been paid
          <span className="sheet__hint">
            Leave it off for one you intend to make. Only paid ones count against the year&rsquo;s
            allowance.
          </span>
        </span>
      </label>

      <Field label="Note" htmlFor={ids.note} hint="Optional.">
        <input
          className="hr-input"
          id={ids.note}
          type="text"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Annual lump sum"
          disabled={saving}
          maxLength={200}
        />
      </Field>
    </Sheet>
  );
}
