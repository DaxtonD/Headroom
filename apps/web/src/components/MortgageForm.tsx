/**
 * The mortgage, as terms rather than as a schedule.
 *
 * Six facts go in and everything else is worked out: the payoff date, what is
 * owing today, the interest over the term, and what a lump sum would move it
 * to. None of that is stored, so correcting a figure here corrects every
 * number on the Savings screen at once.
 *
 * The payment is fortnightly, and there are two honest ways to say when:
 *
 *  - **Its own dates.** Any real payment date, every fourteen days from there.
 *    This is what a lender gives you, and it is the default: a mortgage
 *    anchored to somebody's payday silently moves every payment if that pay
 *    anchor is ever corrected.
 *  - **Following a payday.** A fixed number of days after one. This household's
 *    really does behave this way - the day after Dax's pay - and that one-day
 *    offset is why a month can hold three cheques but two mortgage payments.
 *
 * The balance date is the fiddly one either way: the valid dates are the
 * payment dates, not the paydays. Getting it wrong would put every later date
 * a fortnight out, so the server refuses one that is not a payment date and
 * says which ones are.
 */
import { formatCents, parseCents } from "@headroom/core";
import { useId, useState } from "react";
import { Field, RemoveButton, Sheet } from "./Sheet.js";
import { ApiError, OfflineError } from "../lib/api.js";
import type { PayScheduleEntry } from "../lib/manageQueries.js";
import {
  useCreateMortgage,
  useDeleteMortgage,
  usePatchMortgage,
  type MortgagePanel,
  type RateCompounding,
} from "../lib/savingsQueries.js";

/**
 * A rate as a percentage with up to two decimals, in whole basis points.
 *
 * Reuses the money parser because the shape is identical - two decimal places
 * into an exact integer, with no float in the middle - and 3.99% becoming 399
 * is the same operation as $3.99 becoming 399 cents.
 */
function parseBasisPoints(text: string): number {
  return Number(parseCents(text));
}

function formatBasisPoints(basisPoints: number): string {
  return (basisPoints / 100).toFixed(2);
}

export function MortgageForm({
  existing,
  paySchedules,
  onClose,
}: {
  existing: MortgagePanel | null;
  paySchedules: readonly PayScheduleEntry[];
  onClose: () => void;
}): React.JSX.Element {
  const create = useCreateMortgage();
  const patch = usePatchMortgage();
  const remove = useDeleteMortgage();

  const ids = {
    balance: useId(),
    asOf: useId(),
    rate: useId(),
    payment: useId(),
    anchor: useId(),
    schedule: useId(),
    offset: useId(),
    cap: useId(),
  };

  const [balance, setBalance] = useState(
    existing
      ? formatCents(existing.balanceCents, { currencySymbol: false, grouping: false })
      : "",
  );
  const [asOf, setAsOf] = useState(existing?.asOf ?? "");
  const [rate, setRate] = useState(existing ? formatBasisPoints(existing.rateBasisPoints) : "");
  const [payment, setPayment] = useState(
    existing
      ? formatCents(existing.paymentCents, { currencySymbol: false, grouping: false })
      : "",
  );
  /**
   * Which way this one is anchored. Its own dates unless it is already
   * following a payday, and its own dates for anything new.
   */
  const [anchoring, setAnchoring] = useState<"own" | "payday">(
    existing !== null && existing.payScheduleId !== null ? "payday" : "own",
  );
  const [anchorDate, setAnchorDate] = useState(existing?.anchorDate ?? "");
  const [scheduleId, setScheduleId] = useState(
    existing?.payScheduleId ?? paySchedules[0]?.id ?? "",
  );
  const [offsetDays, setOffsetDays] = useState(String(existing?.offsetDays ?? 1));
  const [cap, setCap] = useState(
    existing
      ? formatCents(existing.prepaymentCapCents, { currencySymbol: false, grouping: false })
      : "0",
  );
  const [compounding, setCompounding] = useState<RateCompounding>(
    existing?.compounding ?? "simple_division",
  );
  const [error, setError] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);

  const saving = create.isPending || patch.isPending || remove.isPending;

  const submit = async (): Promise<void> => {
    setError(null);

    if (anchoring === "payday" && paySchedules.length === 0) {
      setError("Nobody has a payday set yet. Add one on Manage, or give this its own dates.");
      return;
    }
    if (anchoring === "own" && anchorDate === "") {
      setError("Give a date one of the payments comes out.");
      return;
    }

    let balanceCents: bigint;
    let paymentCents: bigint;
    let capCents: bigint;
    let basisPoints: number;
    try {
      balanceCents = parseCents(balance);
      paymentCents = parseCents(payment);
      capCents = parseCents(cap === "" ? "0" : cap);
      basisPoints = parseBasisPoints(rate === "" ? "0" : rate);
    } catch {
      setError("One of those amounts is not a number.");
      return;
    }

    if (balanceCents <= 0n) {
      setError("The balance owing has to be more than nothing.");
      return;
    }
    if (paymentCents <= 0n) {
      setError("The payment has to be more than nothing.");
      return;
    }
    if (asOf === "") {
      setError("Give the date of the payment that left that balance.");
      return;
    }

    const offset = Number(offsetDays);
    if (!Number.isInteger(offset) || offset < 0 || offset > 13) {
      setError("Days after the payday is a whole number from 0 to 13.");
      return;
    }

    // One anchor or the other, never both: the server refuses both, and
    // sending both would make which one wins a guess.
    const input = {
      balanceCents: balanceCents.toString(),
      asOf,
      rateBasisPoints: basisPoints,
      paymentCents: paymentCents.toString(),
      compounding,
      prepaymentCapCents: capCents.toString(),
      ...(anchoring === "own"
        ? { anchorDate }
        : { payScheduleId: scheduleId, offsetDays: offset }),
    };

    try {
      if (existing) {
        await patch.mutateAsync({ id: existing.id, version: existing.version, changes: input });
      } else {
        await create.mutateAsync(input);
      }
      onClose();
    } catch (caught) {
      // The server's message is the useful one here: it names the dates that
      // would have been valid.
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
      title={existing ? "Mortgage details" : "Add the mortgage"}
      intro="Only the terms are stored. The payoff date, the interest and what a lump sum would buy are worked out from them."
      error={error}
      saving={saving}
      saveLabel={existing ? "Save changes" : "Add it"}
      onClose={onClose}
      onSubmit={submit}
      footer={
        existing ? (
          <RemoveButton
            label="Remove the mortgage"
            confirmLabel="Yes, remove it"
            note="The payoff projection and the extra payment on the Year screen both go away."
            armed={armed}
            disabled={saving}
            onArm={() => setArmed(true)}
            onConfirm={() => void destroy()}
          />
        ) : null
      }
    >
      <Field
        label="Balance owing"
        htmlFor={ids.balance}
        hint="As it stood straight after the payment on the date below."
      >
        <input
          className="hr-input"
          id={ids.balance}
          type="text"
          inputMode="decimal"
          value={balance}
          onChange={(event) => setBalance(event.target.value)}
          placeholder="0.00"
          disabled={saving}
          required
        />
      </Field>

      <Field
        label="Date of that payment"
        htmlFor={ids.asOf}
        hint="A payment date, which is a payday plus the offset below - not the payday itself."
      >
        <input
          className="hr-input"
          id={ids.asOf}
          type="date"
          value={asOf}
          onChange={(event) => setAsOf(event.target.value)}
          disabled={saving}
          required
        />
      </Field>

      <Field label="Interest rate" htmlFor={ids.rate} hint="As a percentage, like 3.99.">
        <input
          className="hr-input"
          id={ids.rate}
          type="text"
          inputMode="decimal"
          value={rate}
          onChange={(event) => setRate(event.target.value)}
          placeholder="0.00"
          disabled={saving}
          required
        />
      </Field>

      <Field label="Payment" htmlFor={ids.payment} hint="What leaves the account each time.">
        <input
          className="hr-input"
          id={ids.payment}
          type="text"
          inputMode="decimal"
          value={payment}
          onChange={(event) => setPayment(event.target.value)}
          placeholder="0.00"
          disabled={saving}
          required
        />
      </Field>

      <fieldset className="sheet__choices">
        <legend className="hr-label">When do the payments come out?</legend>
        <label className="sheet__choice">
          <input
            type="radio"
            name="mortgage-anchoring"
            value="own"
            checked={anchoring === "own"}
            onChange={() => setAnchoring("own")}
            disabled={saving}
          />
          <span>Every two weeks, on its own dates — what the lender set</span>
        </label>
        <label className="sheet__choice">
          <input
            type="radio"
            name="mortgage-anchoring"
            value="payday"
            checked={anchoring === "payday"}
            onChange={() => setAnchoring("payday")}
            disabled={saving}
          />
          <span>A fixed number of days after someone&rsquo;s payday</span>
        </label>
      </fieldset>

      {anchoring === "own" ? (
        <Field
          label="A date a payment comes out"
          htmlFor={ids.anchor}
          hint="Any real one. The rest fall every fourteen days from there."
        >
          <input
            className="hr-input"
            id={ids.anchor}
            type="date"
            value={anchorDate}
            onChange={(event) => setAnchorDate(event.target.value)}
            disabled={saving}
            required
          />
        </Field>
      ) : null}

      {anchoring === "payday" ? (
      <>
      <Field label="Follows whose payday?" htmlFor={ids.schedule}>
        <select
          className="hr-input"
          id={ids.schedule}
          value={scheduleId}
          onChange={(event) => setScheduleId(event.target.value)}
          disabled={saving}
        >
          {paySchedules.map((schedule) => (
            <option key={schedule.id} value={schedule.id}>
              {schedule.user ? `${schedule.user.name}'s pay` : "Pay"}
            </option>
          ))}
        </select>
      </Field>

      {/*
        The offset is not a detail. It is why a month can hold three paycheques
        and only two mortgage payments, which is the thing the Year screen is
        for.
      */}
      <Field
        label="Days after that payday"
        htmlFor={ids.offset}
        hint="Usually 1. This is why an extra cheque and an extra payment are not always in the same month."
      >
        <input
          className="hr-input"
          id={ids.offset}
          type="number"
          min={0}
          max={13}
          step={1}
          value={offsetDays}
          onChange={(event) => setOffsetDays(event.target.value)}
          disabled={saving}
        />
      </Field>
      </>
      ) : null}

      <Field
        label="Lump sum allowance each year"
        htmlFor={ids.cap}
        hint="What the lender lets you prepay in a calendar year. Leave it at 0 if you would rather not track it."
      >
        <input
          className="hr-input"
          id={ids.cap}
          type="text"
          inputMode="decimal"
          value={cap}
          onChange={(event) => setCap(event.target.value)}
          placeholder="0.00"
          disabled={saving}
        />
      </Field>

      <fieldset className="sheet__choices">
        <legend className="hr-label">How the rate is applied</legend>
        <label className="sheet__choice">
          <input
            type="radio"
            name="mortgage-compounding"
            value="simple_division"
            checked={compounding === "simple_division"}
            onChange={() => setCompounding("simple_division")}
            disabled={saving}
          />
          <span>Divide the yearly rate by the number of payments — matches the spreadsheet</span>
        </label>
        <label className="sheet__choice">
          <input
            type="radio"
            name="mortgage-compounding"
            value="semi_annual"
            checked={compounding === "semi_annual"}
            onChange={() => setCompounding("semi_annual")}
            disabled={saving}
          />
          <span>Canadian semi-annual compounding — closer to the lender</span>
        </label>
      </fieldset>
    </Sheet>
  );
}
