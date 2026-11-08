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
import "./BillForm.css";

/** How a bill recurs, in the words someone would actually use. */
const RECURRENCE_OPTIONS = [
  { key: "monthly_day", label: "Every month, on a date" },
  { key: "monthly_last", label: "Every month, on the last day" },
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
      return "after_payday";
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
  onClose,
}: {
  existing: Bill | null;
  members: readonly Member[];
  paySchedules: readonly PayScheduleEntry[];
  onClose: () => void;
}): React.JSX.Element {
  const create = useCreateBill();
  const patch = usePatchBill();
  const ids = {
    name: useId(),
    amount: useId(),
    day: useId(),
    offset: useId(),
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
  const [payScheduleId, setPayScheduleId] = useState(
    existing?.schedule.type === "relative_to_pay" || existing?.schedule.type === "biweekly"
      ? existing.schedule.payScheduleId
      : (paySchedules[0]?.id ?? ""),
  );
  const [offsetDays, setOffsetDays] = useState(
    existing?.schedule.type === "relative_to_pay" ? String(existing.schedule.offsetDays) : "1",
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

  const saving = create.isPending || patch.isPending;

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

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
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
    if (useOverride) {
      try {
        overrideValue = parseCents(override === "" ? "0" : override).toString();
      } catch {
        setError("That monthly budget figure is not a number.");
        return;
      }
    }

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
            section,
            ownerUserId: ownerUserId === "" ? null : ownerUserId,
            monthlyBudgetOverrideCents: overrideValue,
          },
        });
      } else {
        await create.mutateAsync({
          name: name.trim(),
          kind: "bill",
          defaultCents: cents.toString(),
          withdrawal,
          schedule,
          section,
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

  const needsPayday = recurrence === "after_payday";

  return (
    <div className="sheet-backdrop" onClick={onClose} role="presentation">
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={existing ? `Edit ${existing.name}` : "Add an expense"}
        onClick={(event) => event.stopPropagation()}
      >
        <form onSubmit={(event) => void submit(event)}>
          <h2 className="sheet__title">{existing ? "Edit expense" : "Add an expense"}</h2>
          <p className="sheet__intro">
            Entered once. It appears on Upcoming with its due date, and on Budget with its
            monthly cost.
          </p>

          {error ? (
            <p className="hr-alert sheet__error" role="alert">
              {error}
            </p>
          ) : null}

          <div className="hr-field billform__field">
            <label className="hr-label" htmlFor={ids.name}>
              What is it?
            </label>
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
          </div>

          <div className="hr-field billform__field">
            <label className="hr-label" htmlFor={ids.amount}>
              What does it cost, each time?
            </label>
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
          </div>

          <div className="hr-field billform__field">
            <label className="hr-label" htmlFor="billform-recurrence">
              How often?
            </label>
            <select
              className="hr-input"
              id="billform-recurrence"
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
          </div>

          {recurrence === "monthly_day" ? (
            <div className="hr-field billform__field">
              <label className="hr-label" htmlFor={ids.day}>
                On which day of the month?
              </label>
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
              <p className="billform__hint">
                A day a short month does not have moves to its last day, so the 31st is the 30th
                in November.
              </p>
            </div>
          ) : null}

          {needsPayday ? (
            paySchedules.length === 0 ? (
              <p className="hr-alert billform__field">
                Nobody has a payday set yet, so this option cannot be used. Add paydays first.
              </p>
            ) : (
              <>
                <div className="hr-field billform__field">
                  <label className="hr-label" htmlFor="billform-payday">
                    After whose payday?
                  </label>
                  <select
                    className="hr-input"
                    id="billform-payday"
                    value={payScheduleId}
                    onChange={(event) => setPayScheduleId(event.target.value)}
                    disabled={saving}
                  >
                    {paySchedules.map((schedule) => (
                      <option key={schedule.id} value={schedule.id}>
                        {schedule.user?.name ?? "Someone"}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="hr-field billform__field">
                  <label className="hr-label" htmlFor={ids.offset}>
                    How many days after?
                  </label>
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
                </div>
              </>
            )
          ) : null}

          <div className="hr-field billform__field">
            <label className="hr-label" htmlFor="billform-section">
              On the budget, is it fixed or variable?
            </label>
            <select
              className="hr-input"
              id="billform-section"
              value={section}
              onChange={(event) => setSection(event.target.value as "fixed" | "variable")}
              disabled={saving}
            >
              <option value="fixed">Fixed — the same every month</option>
              <option value="variable">Variable — it changes</option>
            </select>
          </div>

          <div className="hr-field billform__field">
            <label className="hr-label" htmlFor="billform-owner">
              Who gets this bill?
            </label>
            <select
              className="hr-input"
              id="billform-owner"
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
          </div>

          {/* ---- What this does to the monthly budget ---- */}
          {preview ? (
            <div className="billform__preview">
              <p className="billform__preview-title">On the Budget page</p>
              <p className="billform__preview-amount hr-amount">
                {formatCents(preview.monthlyCents)} a month
              </p>
              <p className="billform__preview-note">
                {timesPerYear(preview.cadence)} times a year, so{" "}
                {formatCents(preview.yearlyCents)} a year.
                {preview.cadence === "biweekly" ? (
                  <>
                    {" "}
                    Every two weeks is 26 payments a year, not 24, so this is more than twice the
                    amount.
                  </>
                ) : null}
              </p>
              {preview.overridden ? (
                <p className="billform__preview-note">
                  Worked out from the amount it would be{" "}
                  {formatCents(preview.derivedMonthlyCents)}; your figure is being used instead.
                </p>
              ) : null}
            </div>
          ) : null}

          <label className="billform__checkbox">
            <input
              type="checkbox"
              checked={useOverride}
              onChange={(event) => setUseOverride(event.target.checked)}
              disabled={saving}
            />
            <span>
              Use a different monthly figure on the budget
              <span className="billform__hint">
                For when the sheet says a different number than the one worked out above.
              </span>
            </span>
          </label>

          {useOverride ? (
            <div className="hr-field billform__field">
              <label className="hr-label" htmlFor={ids.override}>
                Monthly budget figure
              </label>
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
            </div>
          ) : null}

          <div className="sheet__actions">
            <button
              className="hr-button hr-button--secondary"
              type="button"
              onClick={onClose}
              disabled={saving}
            >
              Cancel
            </button>
            <button className="hr-button" type="submit" disabled={saving}>
              {saving ? "Saving…" : existing ? "Save changes" : "Add expense"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
