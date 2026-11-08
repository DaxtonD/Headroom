/**
 * Adding one thing that happens once.
 *
 * This is the spreadsheet's "add a few extra rows", which is how the household
 * actually works: a dentist bill this month, an extra amount into savings
 * because a third paycheque landed, a rebate that arrived. None of it recurs,
 * so none of it should become a template that generates for ever.
 *
 * It had no interface at all until now. The endpoint and the mutation hook
 * both existed and nothing connected them, so the only way to add a row was
 * SQL - which is exactly the gap the wiring test was written to find, and did.
 *
 * Two choices matter here and both default to what the household does most:
 *
 *  - **What it is** decides which way the money goes. The server signs the
 *    amount from the kind, so the amount is always typed as a plain positive
 *    number and never with a minus.
 *  - **When** is either a date or a paycheque. Attached to a paycheque it can
 *    be moved to an earlier or later one when a week is tight, which is the
 *    whole point of a flexible row; on a date it cannot, because the bank acts
 *    on that day whatever else is happening.
 */
import { formatCents, parseCents } from "@headroom/core";
import { useId, useState } from "react";
import { Field, Sheet } from "./Sheet.js";
import type { MoveTarget } from "./OccurrenceRow.js";
import { ApiError, OfflineError, newIdempotencyKey } from "../lib/api.js";
import { useCreateOneOff } from "../lib/queries.js";

type Kind = "bill" | "transfer" | "deposit";

const KINDS: readonly { readonly kind: Kind; readonly label: string }[] = [
  { kind: "bill", label: "Money going out" },
  { kind: "transfer", label: "Into savings" },
  { kind: "deposit", label: "Money coming in" },
];

export function OneOffForm({
  paydays,
  onClose,
}: {
  /** "Now" plus each upcoming payday, as built by the screen showing them. */
  paydays: readonly MoveTarget[];
  onClose: () => void;
}): React.JSX.Element {
  const create = useCreateOneOff();
  const ids = { name: useId(), amount: useId(), date: useId(), payday: useId() };

  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [kind, setKind] = useState<Kind>("bill");
  const [placement, setPlacement] = useState<"payday" | "date">("payday");
  const [date, setDate] = useState("");
  // The first real payday if there is one, rather than "Now": something added
  // by hand is nearly always for a cheque that has not arrived yet.
  const [payday, setPayday] = useState<string>(
    () => paydays.find((target) => target.id !== null)?.id ?? "",
  );
  const [error, setError] = useState<string | null>(null);

  const preview = (() => {
    try {
      const cents = parseCents(amount === "" ? "0" : amount);
      if (cents === 0n) return null;
      const magnitude = cents < 0n ? -cents : cents;
      return kind === "deposit" ? magnitude : -magnitude;
    } catch {
      return null;
    }
  })();

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
    if (cents === 0n) {
      setError("An amount of nothing would not change anything.");
      return;
    }

    if (placement === "date" && date === "") {
      setError("Pick the date it comes out.");
      return;
    }

    try {
      await create.mutateAsync({
        name: name.trim(),
        // Always a positive magnitude; the server signs it from the kind.
        cents: (cents < 0n ? -cents : cents).toString(),
        kind,
        ...(placement === "date"
          ? { date }
          : // An empty selection is "Now", which the API spells as a null anchor.
            { anchorOccurrenceId: payday === "" ? null : payday }),
        idempotencyKey: newIdempotencyKey(),
      });
      onClose();
    } catch (caught) {
      if (caught instanceof OfflineError || caught instanceof ApiError) setError(caught.message);
      else setError("That did not save. Please try again.");
    }
  };

  return (
    <Sheet
      title="Add a one-off"
      intro="Something that happens once. It appears on the timeline straight away and never comes back."
      error={error}
      saving={create.isPending}
      saveLabel="Add it"
      onClose={onClose}
      onSubmit={submit}
    >
      <Field label="What is it?" htmlFor={ids.name}>
        <input
          className="hr-input"
          id={ids.name}
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Dentist"
          disabled={create.isPending}
          required
        />
      </Field>

      <Field
        label="How much?"
        htmlFor={ids.amount}
        hint="Type it as a plain amount. Which way it goes comes from the choice below."
      >
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

      <fieldset className="sheet__choices">
        <legend className="hr-label">What kind of thing is it?</legend>
        {KINDS.map((option) => (
          <label className="sheet__choice" key={option.kind}>
            <input
              type="radio"
              name="one-off-kind"
              value={option.kind}
              checked={kind === option.kind}
              onChange={() => setKind(option.kind)}
              disabled={create.isPending}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </fieldset>

      <fieldset className="sheet__choices">
        <legend className="hr-label">When?</legend>
        <label className="sheet__choice">
          <input
            type="radio"
            name="one-off-when"
            value="payday"
            checked={placement === "payday"}
            onChange={() => setPlacement("payday")}
            disabled={create.isPending}
          />
          <span>With a paycheque — can be moved later if the week is tight</span>
        </label>
        <label className="sheet__choice">
          <input
            type="radio"
            name="one-off-when"
            value="date"
            checked={placement === "date"}
            onChange={() => setPlacement("date")}
            disabled={create.isPending}
          />
          <span>On a date — the bank takes it that day</span>
        </label>
      </fieldset>

      {placement === "payday" ? (
        <Field label="Which paycheque?" htmlFor={ids.payday}>
          <select
            className="hr-input"
            id={ids.payday}
            value={payday}
            onChange={(event) => setPayday(event.target.value)}
            disabled={create.isPending}
          >
            {paydays.map((target) => (
              <option key={target.id ?? "now"} value={target.id ?? ""}>
                {target.label}
              </option>
            ))}
          </select>
        </Field>
      ) : (
        <Field label="What date?" htmlFor={ids.date}>
          <input
            className="hr-input"
            id={ids.date}
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
            disabled={create.isPending}
            required
          />
        </Field>
      )}

      {preview !== null ? (
        <div className="sheet__preview">
          <p className="sheet__preview-title">On the timeline</p>
          <p className="sheet__preview-amount hr-amount">{formatCents(preview)}</p>
          <p className="sheet__preview-note">
            {preview < 0n ? "Taken off the balance." : "Added to the balance."}
          </p>
        </div>
      ) : null}
    </Sheet>
  );
}
