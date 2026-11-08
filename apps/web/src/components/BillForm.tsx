/**
 * Adding or changing one expense.
 *
 * This is the form that replaces entering a bill twice. It captures what the
 * bill is, what it usually costs, who gets it, how often it comes out, and
 * whether it is fixed or variable — and from that single entry the bill
 * appears on the timeline AND on the Budget page.
 *
 * The monthly budget figure is shown as it is typed, derived from the cadence,
 * so there is never any doubt about what a biweekly bill will do to the
 * monthly budget. It can be overridden where the spreadsheet says otherwise.
 */
import {
  cadenceOfSchedule,
  formatCents,
  monthlyFigureFor,
  parseCents,
  timesPerYear,
} from "@headroom/core";
import { useId, useState } from "react";
import { ApiError, OfflineError } from "../lib/api.js";
import {
  useCreateBill,
  usePatchBill,
  type Bill,
  type Member,
  type PayScheduleEntry,
  type ScheduleSpec,
} from "../lib/manageQueries.js";
import { Field, RemoveButton, Sheet } from "./Sheet.js";

/** How a bill recurs, in the words someone would actually use. */
const RECURRENCE_OPTIONS = [
  { key: "monthly_day", label: "Every month, on a date" },
  { key: "monthly_last", label: "Every month, on the last day" },
  // The one that was missing. "A few days after someone's payday" is also
  // fortnightly, but only because the payday is - and it cannot express dates
  // a lender set, which is what a mortgage has.
  { key: "biweekly_own", label: "Every two weeks, on its own dates" },
  { key: "after_payday", label: "A few days after someone's payday" },
  { key: "flexible_monthly", label: "Monthly, but I choose when to pay it" },
  { key: "flexible_per_pay", label: "Every payday, but I choose when" },
] as const;

type RecurrenceKey = (typeof RECURRENCE_OPTIONS)[number]["key"];

function recurrenceOf(schedule: ScheduleSpec): RecurrenceKey {
  switch (schedule.type) {
    case "monthly":
      return "monthly_day";
    case "monthly_last":
      return "monthly_last";
    case "relative_to_pay":
      return "after_payday";
    case "biweekly":
      // Mapping this to "after_payday" used to silently rewrite the schedule
      // on the next save: a biweekly item on its own dates became one chasing
      // a payday, with the offset defaulted to 1.
      return schedule.anchorDate === undefined ? "after_payday" : "biweekly_own";
    case "flexible":
      return schedule.frequency === "per_pay_period" ? "flexible_per_pay" : "flexible_monthly";
    default:
      return "monthly_day";
  }
}

export function BillForm({
  existing,
  members,
  paySchedules,
  defaultKind = "bill",
  onClose,
}: {
  existing: Bill | null;
  members: readonly Member[];
  paySchedules: readonly PayScheduleEntry[];
  /**
   * What is being added. A deposit is money arriving that is not a paycheque —
   * a tax refund, a transfer in — so it has no fixed/variable section and does
   * not belong in the expense half of the budget.
   */
  defaultKind?: "bill" | "deposit";
  onClose: () => void;
}): React.JSX.Element {
  const create = useCreateBill();
  const patch = usePatchBill();
  const ids = {
    name: useId(),
    amount: useId(),
    recurrence: useId(),
    day: useId(),
    anchor: useId(),
    payday: useId(),
    offset: useId(),
    section: useId(),
    owner: useId(),
    override: useId(),
  };

  const [name, setName] = useState(existing?.name ?? "");
  const [amount, setAmount] = useState(
    existing ? formatCents(existing.defaultCents, { currencySymbol: false, grouping: false }) : "",
  );
  const [recurrence, setRecurrence] = useState<RecurrenceKey>(
    existing ? recurrenceOf(existing.schedule) : "monthly_day",
  );
  const [day, setDay] = useState(
    existing?.schedule.type === "monthly" ? String(existing.schedule.day) : "1",
  );
  const [payScheduleId, setPayScheduleId] = useState(() => {
    if (existing?.schedule.type === "relative_to_pay") return existing.schedule.payScheduleId;
    if (existing?.schedule.type === "biweekly" && existing.schedule.payScheduleId !== undefined) {
      return existing.schedule.payScheduleId;
    }
    return paySchedules[0]?.id ?? "";
  });
  const [offsetDays, setOffsetDays] = useState(
    existing?.schedule.type === "relative_to_pay" ? String(existing.schedule.offsetDays) : "1",
  );
  const [anchorDate, setAnchorDate] = useState(
    existing?.schedule.type === "biweekly" ? (existing.schedule.anchorDate ?? "") : "",
  );
  const [section, setSection] = useState<"fixed" | "variable">(
    existing?.section === "variable" ? "variable" : "fixed",
  );
  const [ownerUserId, setOwnerUserId] = useState(existing?.ownerUserId ?? "");
  /**
   * Whether a stated monthly figure is in use.
   *
   * Written out rather than `!= null`: with optional chaining on a new bill,
   * `existing?.monthlyBudgetOverrideCents` is `undefined`, and `undefined !==
   * null` is true — which would have switched the override on by default for
   * every new expense.
   */
  const existingOverride =
    existing && existing.monthlyBudgetOverrideCents !== null
      ? existing.monthlyBudgetOverrideCents
      : null;

  const [useOverride, setUseOverride] = useState(existingOverride !== null);
  const [override, setOverride] = useState(
    existingOverride === null
      ? ""
      : formatCents(existingOverride, { currencySymbol: false, grouping: false }),
  );
  const [error, setError] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);

  const saving = create.isPending || patch.isPending;

  /** Money arriving rather than leaving, which changes most of the wording. */
  const kind = existing ? existing.kind : defaultKind;
  const incoming = kind === "paycheque" || kind === "deposit";

  /** The schedule as the API wants it, or null when it cannot be built yet. */
  const buildSchedule = (): ScheduleSpec | null => {
    switch (recurrence) {
      case "monthly_day": {
        const parsed = Number(day);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 31) return null;
        return { type: "monthly", day: parsed };
      }
      case "monthly_last":
        return { type: "monthly_last" };
      case "biweekly_own": {
        if (anchorDate === "") return null;
        return { type: "biweekly", anchorDate };
      }
      case "after_payday": {
        if (!payScheduleId) return null;
        const parsed = Number(offsetDays);
        if (!Number.isInteger(parsed) || parsed < -31 || parsed > 31) return null;
        return { type: "relative_to_pay", payScheduleId, offsetDays: parsed };
      }
      case "flexible_monthly":
        return { type: "flexible", frequency: "monthly" };
      case "flexible_per_pay":
        return { type: "flexible", frequency: "per_pay_period" };
      default:
        return null;
    }
  };

  const schedule = buildSchedule();

  // What this will do to the monthly budget, shown live so a biweekly bill
  // never surprises anyone.
  const preview = (() => {
    if (!schedule) return null;
    let cents: bigint;
    try {
      cents = parseCents(amount === "" ? "0" : amount);
    } catch {
      return null;
    }

    let overrideCents: bigint | null = null;
    if (useOverride && override !== "") {
      try {
        overrideCents = parseCents(override);
      } catch {
        return null;
      }
    }

    const cadence = cadenceOfSchedule(schedule);
    return {
      cadence,
      ...monthlyFigureFor({ cents, cadence, monthlyOverrideCents: overrideCents }),
    };
  })();

  const submit = async (): Promise<void> => {
    setError(null);

    if (name.trim() === "") {
      setError("Give this a name.");
      return;
    }
    if (!schedule) {
      setError("Check how often this comes out.");
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
      setError("Enter what it costs, without a minus sign.");
      return;
    }

    let overrideValue: string | null = null;
    if (useOverride && !incoming) {
      try {
        overrideValue = parseCents(override === "" ? "0" : override).toString();
      } catch {
        setError("That monthly budget figure is not a number.");
        return;
      }
    }

    // Income has no fixed/variable half of the budget to sit in.
    const budgetSection = incoming ? "income" : section;

    // A dated schedule produces dated items; a flexible one produces movable
    // undated items. The API enforces this too.
    const withdrawal = schedule.type === "flexible" ? "flexible" : "auto";

    try {
      if (existing) {
        await patch.mutateAsync({
          id: existing.id,
          version: existing.version,
          changes: {
            name: name.trim(),
            defaultCents: cents.toString(),
            schedule,
            section: budgetSection,
            ownerUserId: ownerUserId === "" ? null : ownerUserId,
            monthlyBudgetOverrideCents: overrideValue,
          },
        });
      } else {
        await create.mutateAsync({
          name: name.trim(),
          kind: defaultKind,
          defaultCents: cents.toString(),
          withdrawal,
          schedule,
          section: budgetSection,
          ownerUserId: ownerUserId === "" ? null : ownerUserId,
          monthlyBudgetOverrideCents: overrideValue,
        });
      }
      onClose();
    } catch (caught) {
      if (caught instanceof OfflineError || caught instanceof ApiError) setError(caught.message);
      else setError("That did not save. Please try again.");
    }
  };

  /** Archiving from inside the form, for a bill that has been paid off. */
  const archive = async (): Promise<void> => {
    if (!existing) return;
    setError(null);
    try {
      await patch.mutateAsync({
        id: existing.id,
        version: existing.version,
        changes: { active: false },
      });
      onClose();
    } catch (caught) {
      if (caught instanceof OfflineError || caught instanceof ApiError) setError(caught.message);
      else setError("Could not archive it.");
    }
  };

  const needsPayday = recurrence === "after_payday";

  return (
    <Sheet
      title={
        existing
          ? `Edit ${existing.name}`
          : incoming
            ? "Add money coming in"
            : "Add an expense"
      }
      intro={
        incoming
          ? "Money arriving that is not a paycheque — a refund, or a transfer in. It appears on the ledger on the day it lands."
          : "Entered once. It appears on the ledger with its due date, and on Budget with its monthly cost."
      }
      error={error}
      saving={saving}
      saveLabel={existing ? "Save changes" : incoming ? "Add it" : "Add expense"}
      onClose={onClose}
      onSubmit={submit}
      footer={
        existing ? (
          <RemoveButton
            label="Archive this"
            confirmLabel="Yes, archive it"
            note="Its history is kept and you can bring it back from Manage."
            armed={armed}
            disabled={saving}
            onArm={() => setArmed(true)}
            onConfirm={() => void archive()}
          />
        ) : null
      }
    >
      <Field label="What is it?" htmlFor={ids.name}>
        <input
          className="hr-input"
          id={ids.name}
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Power"
          disabled={saving}
          required
        />
      </Field>

      <Field
        label={incoming ? "How much arrives, each time?" : "What does it cost, each time?"}
        htmlFor={ids.amount}
      >
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

      <Field label="How often?" htmlFor={ids.recurrence}>
        <select
          className="hr-input"
          id={ids.recurrence}
          value={recurrence}
          onChange={(event) => setRecurrence(event.target.value as RecurrenceKey)}
          disabled={saving}
        >
          {RECURRENCE_OPTIONS.map((option) => (
            <option key={option.key} value={option.key}>
              {option.label}
            </option>
          ))}
        </select>
      </Field>

      {recurrence === "monthly_day" ? (
        <Field
          label="On which day of the month?"
          htmlFor={ids.day}
          hint="A day a short month does not have moves to its last day, so the 31st is the 30th in November."
        >
          <input
            className="hr-input"
            id={ids.day}
            type="number"
            min={1}
            max={31}
            step={1}
            value={day}
            onChange={(event) => setDay(event.target.value)}
            disabled={saving}
          />
        </Field>
      ) : null}

      {recurrence === "biweekly_own" ? (
        <Field
          label="A date it comes out"
          htmlFor={ids.anchor}
          hint="Any real one. Every fourteen days from there — which is 26 times a year, not 24."
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

      {needsPayday ? (
        paySchedules.length === 0 ? (
          <p className="hr-alert sheet__field">
            Nobody has a payday set yet, so this option cannot be used. Add paydays first.
          </p>
        ) : (
          <>
            <Field label="After whose payday?" htmlFor={ids.payday}>
              <select
                className="hr-input"
                id={ids.payday}
                value={payScheduleId}
                onChange={(event) => setPayScheduleId(event.target.value)}
                disabled={saving}
              >
                {paySchedules.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.user?.name ?? "Someone"}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="How many days after?" htmlFor={ids.offset}>
              <input
                className="hr-input"
                id={ids.offset}
                type="number"
                min={-31}
                max={31}
                step={1}
                value={offsetDays}
                onChange={(event) => setOffsetDays(event.target.value)}
                disabled={saving}
              />
            </Field>
          </>
        )
      ) : null}

      {incoming ? null : (
        <Field label="On the budget, is it fixed or variable?" htmlFor={ids.section}>
          <select
            className="hr-input"
            id={ids.section}
            value={section}
            onChange={(event) => setSection(event.target.value as "fixed" | "variable")}
            disabled={saving}
          >
            <option value="fixed">Fixed — the same every month</option>
            <option value="variable">Variable — it changes</option>
          </select>
        </Field>
      )}

      <Field label={incoming ? "Whose is it?" : "Who gets this bill?"} htmlFor={ids.owner}>
        <select
          className="hr-input"
          id={ids.owner}
          value={ownerUserId}
          onChange={(event) => setOwnerUserId(event.target.value)}
          disabled={saving}
        >
          <option value="">Not set</option>
          {members.map((member) => (
            <option key={member.id} value={member.id}>
              {member.name}
            </option>
          ))}
        </select>
      </Field>

      {/* ---- What this does to the monthly budget ---- */}
      {preview ? (
        <div className="sheet__preview">
          <p className="sheet__preview-title">
            {incoming ? "Works out to" : "On the Budget page"}
          </p>
          <p className="sheet__preview-amount hr-amount">
            {formatCents(preview.monthlyCents)} a month
          </p>
          <p className="sheet__preview-note">
            {timesPerYear(preview.cadence)} times a year, so {formatCents(preview.yearlyCents)} a
            year.
            {preview.cadence === "biweekly" ? (
              <>
                {" "}
                Every two weeks is 26 payments a year, not 24, so this is more than twice the
                amount.
              </>
            ) : null}
          </p>
          {preview.overridden ? (
            <p className="sheet__preview-note">
              Worked out from the amount it would be{" "}
              {formatCents(preview.derivedMonthlyCents)}; your figure is being used instead.
            </p>
          ) : null}
        </div>
      ) : null}

      {incoming ? null : (
        <label className="hr-checkbox">
          <input
            type="checkbox"
            checked={useOverride}
            onChange={(event) => setUseOverride(event.target.checked)}
            disabled={saving}
          />
          <span>
            Use a different monthly figure on the budget
            <span className="sheet__hint">
              For when the sheet says a different number than the one worked out above.
            </span>
          </span>
        </label>
      )}

      {useOverride && !incoming ? (
        <Field label="Monthly budget figure" htmlFor={ids.override}>
          <input
            className="hr-input"
            id={ids.override}
            type="text"
            inputMode="decimal"
            value={override}
            onChange={(event) => setOverride(event.target.value)}
            placeholder="0.00"
            disabled={saving}
          />
        </Field>
      ) : null}
    </Sheet>
  );
}
