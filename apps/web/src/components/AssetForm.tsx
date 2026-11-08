/**
 * Adding or changing something owned or owed.
 *
 * Both are stored as positive magnitudes with a `kind`, so nothing depends on
 * remembering to type a minus sign — a mortgage entered as a positive number
 * in the "owed" column cannot accidentally be added to net worth.
 *
 * `kind` cannot be changed on an existing entry: turning a debt into an asset
 * is never a correction, it is two different facts, and quietly flipping the
 * sign of a figure that feeds net worth is exactly the kind of silent error
 * this app is meant to avoid.
 */
import { formatCents, parseCents } from "@headroom/core";
import { useId, useState } from "react";
import { ApiError, OfflineError } from "../lib/api.js";
import { useCreateAsset, useDeleteAsset, usePatchAsset } from "../lib/manageQueries.js";
import type { AssetEntry } from "../lib/plannerQueries.js";
import { Field, RemoveButton, Sheet } from "./Sheet.js";

export function AssetForm({
  existing,
  defaultKind,
  onClose,
}: {
  existing: AssetEntry | null;
  /** Which column the "Add" button was pressed in. */
  defaultKind: "asset" | "liability";
  onClose: () => void;
}): React.JSX.Element {
  const create = useCreateAsset();
  const patch = usePatchAsset();
  const remove = useDeleteAsset();
  const ids = { kind: useId(), name: useId(), amount: useId(), asOf: useId(), note: useId() };

  const [kind, setKind] = useState<"asset" | "liability">(existing?.kind ?? defaultKind);
  const [name, setName] = useState(existing?.name ?? "");
  const [amount, setAmount] = useState(
    existing ? formatCents(existing.cents, { currencySymbol: false, grouping: false }) : "",
  );
  const [asOf, setAsOf] = useState(existing?.asOf ?? "");
  const [note, setNote] = useState(existing?.note ?? "");
  const [error, setError] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);

  const saving = create.isPending || patch.isPending || remove.isPending;
  const owed = kind === "liability";

  const submit = async (): Promise<void> => {
    setError(null);

    if (name.trim() === "") {
      setError("Give this a name.");
      return;
    }

    let cents: bigint;
    try {
      cents = parseCents(amount);
    } catch {
      setError("That amount is not a number.");
      return;
    }
    if (cents < 0n) {
      setError("Enter the amount without a minus sign; whether it is owned or owed is above.");
      return;
    }

    try {
      if (existing) {
        await patch.mutateAsync({
          id: existing.id,
          version: existing.version,
          changes: {
            name: name.trim(),
            cents: cents.toString(),
            asOf: asOf === "" ? null : asOf,
            note: note.trim() === "" ? null : note.trim(),
          },
        });
      } else {
        await create.mutateAsync({
          kind,
          name: name.trim(),
          cents: cents.toString(),
          ...(asOf === "" ? {} : { asOf }),
          ...(note.trim() === "" ? {} : { note: note.trim() }),
        });
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
      title={existing ? `Edit ${existing.name}` : owed ? "Add something owed" : "Add something owned"}
      intro="Net worth is everything owned less everything owed. Enter amounts as positive numbers."
      error={error}
      saving={saving}
      saveLabel={existing ? "Save changes" : "Add it"}
      onClose={onClose}
      onSubmit={submit}
      footer={
        existing ? (
          <RemoveButton
            label="Remove this entry"
            confirmLabel="Yes, remove it"
            note="It stops counting towards net worth. Sold, paid off, or entered by mistake."
            armed={armed}
            disabled={saving}
            onArm={() => setArmed(true)}
            onConfirm={() => void destroy()}
          />
        ) : null
      }
    >
      {existing ? (
        <p className="sheet__hint">
          This is something {owed ? "owed" : "owned"}. To change that, remove it and enter the
          other one — it is a different fact, not a correction.
        </p>
      ) : (
        <Field label="Owned or owed?" htmlFor={ids.kind}>
          <select
            className="hr-input"
            id={ids.kind}
            value={kind}
            onChange={(event) => setKind(event.target.value as "asset" | "liability")}
            disabled={saving}
          >
            <option value="asset">Owned — it adds to net worth</option>
            <option value="liability">Owed — it comes off net worth</option>
          </select>
        </Field>
      )}

      <Field label="What is it?" htmlFor={ids.name}>
        <input
          className="hr-input"
          id={ids.name}
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={owed ? "Car loan" : "House"}
          disabled={saving}
          required
        />
      </Field>

      <Field label={owed ? "How much is owed?" : "What is it worth?"} htmlFor={ids.amount}>
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
        label="As of when?"
        htmlFor={ids.asOf}
        hint="Optional. A valuation goes stale, and this says how stale."
      >
        <input
          className="hr-input"
          id={ids.asOf}
          type="date"
          value={asOf}
          onChange={(event) => setAsOf(event.target.value)}
          disabled={saving}
        />
      </Field>

      <Field label="Note" htmlFor={ids.note} hint="Optional.">
        <input
          className="hr-input"
          id={ids.note}
          type="text"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          disabled={saving}
          maxLength={200}
        />
      </Field>
    </Sheet>
  );
}
