/**
 * Adding or changing a budget-only category.
 *
 * A category is spending with no bill and no due date — food, gas, everyday
 * things. It has a monthly figure and nothing else, which is what separates it
 * from an expense: an expense has a date and so lands on Upcoming, a category
 * only ever appears on Budget.
 *
 * The yearly figure is normally twelve times the monthly one. It can be stated
 * separately because Carol's sheet does exactly that for a few lines, and
 * silently showing twelve times the monthly figure would contradict her.
 */
import { formatCents, parseCents } from "@headroom/core";
import { useId, useState } from "react";
import { ApiError, OfflineError } from "../lib/api.js";
import {
  useCreateCategory,
  useDeleteCategory,
  usePatchCategory,
  type Category,
} from "../lib/manageQueries.js";
import { Field, RemoveButton, Sheet } from "./Sheet.js";

export function CategoryForm({
  existing,
  onClose,
}: {
  existing: Category | null;
  onClose: () => void;
}): React.JSX.Element {
  const create = useCreateCategory();
  const patch = usePatchCategory();
  const remove = useDeleteCategory();
  const ids = { name: useId(), monthly: useId(), section: useId(), yearly: useId() };

  const [name, setName] = useState(existing?.name ?? "");
  const [monthly, setMonthly] = useState(
    existing ? formatCents(existing.monthlyCents, { currencySymbol: false, grouping: false }) : "",
  );
  const [section, setSection] = useState<"fixed" | "variable">(existing?.section ?? "variable");

  // Spelled out rather than `existing?.yearlyCentsOverride !== null`, which is
  // true for a new category because `undefined !== null`.
  const existingYearly =
    existing && existing.yearlyCentsOverride !== null ? existing.yearlyCentsOverride : null;

  const [useYearly, setUseYearly] = useState(existingYearly !== null);
  const [yearly, setYearly] = useState(
    existingYearly === null
      ? ""
      : formatCents(existingYearly, { currencySymbol: false, grouping: false }),
  );
  const [error, setError] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);

  const saving = create.isPending || patch.isPending || remove.isPending;

  /** The yearly figure as it will appear, so the override is never a mystery. */
  const preview = (() => {
    let monthlyCents: bigint;
    try {
      monthlyCents = parseCents(monthly === "" ? "0" : monthly);
    } catch {
      return null;
    }

    if (!useYearly) return { monthlyCents, yearlyCents: monthlyCents * 12n, overridden: false };

    let yearlyCents: bigint;
    try {
      yearlyCents = parseCents(yearly === "" ? "0" : yearly);
    } catch {
      return null;
    }
    return { monthlyCents, yearlyCents, overridden: true };
  })();

  const submit = async (): Promise<void> => {
    setError(null);

    if (name.trim() === "") {
      setError("Give this a name.");
      return;
    }

    let monthlyCents: bigint;
    try {
      monthlyCents = parseCents(monthly);
    } catch {
      setError("That monthly amount is not a number.");
      return;
    }
    if (monthlyCents < 0n) {
      setError("Enter the amount without a minus sign.");
      return;
    }

    let yearlyValue: string | null = null;
    if (useYearly) {
      try {
        yearlyValue = parseCents(yearly === "" ? "0" : yearly).toString();
      } catch {
        setError("That yearly amount is not a number.");
        return;
      }
    }

    try {
      if (existing) {
        await patch.mutateAsync({
          id: existing.id,
          version: existing.version,
          changes: {
            name: name.trim(),
            section,
            monthlyCents: monthlyCents.toString(),
            yearlyCentsOverride: yearlyValue,
          },
        });
      } else {
        await create.mutateAsync({
          name: name.trim(),
          section,
          monthlyCents: monthlyCents.toString(),
          yearlyCentsOverride: yearlyValue,
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
      title={existing ? "Edit category" : "Add a category"}
      intro="Everyday spending with no bill and no due date. It appears on the Budget page only."
      error={error}
      saving={saving}
      saveLabel={existing ? "Save changes" : "Add category"}
      onClose={onClose}
      onSubmit={submit}
      footer={
        existing ? (
          <RemoveButton
            label="Remove this category"
            confirmLabel="Yes, remove it"
            note="It stops counting towards the budget. The change is recorded in the history."
            armed={armed}
            disabled={saving}
            onArm={() => setArmed(true)}
            onConfirm={() => void destroy()}
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
          placeholder="Groceries"
          disabled={saving}
          required
        />
      </Field>

      <Field label="How much a month?" htmlFor={ids.monthly}>
        <input
          className="hr-input"
          id={ids.monthly}
          type="text"
          inputMode="decimal"
          value={monthly}
          onChange={(event) => setMonthly(event.target.value)}
          placeholder="0.00"
          disabled={saving}
          required
        />
      </Field>

      <Field label="Fixed or variable?" htmlFor={ids.section}>
        <select
          className="hr-input"
          id={ids.section}
          value={section}
          onChange={(event) => setSection(event.target.value as "fixed" | "variable")}
          disabled={saving}
        >
          <option value="variable">Variable — it changes</option>
          <option value="fixed">Fixed — the same every month</option>
        </select>
      </Field>

      {preview ? (
        <div className="sheet__preview">
          <p className="sheet__preview-title">On the Budget page</p>
          <p className="sheet__preview-amount hr-amount">
            {formatCents(preview.monthlyCents)} a month
          </p>
          <p className="sheet__preview-note">
            {preview.overridden
              ? `${formatCents(preview.yearlyCents)} a year, as stated below.`
              : `${formatCents(preview.yearlyCents)} a year — twelve times the monthly figure.`}
          </p>
        </div>
      ) : null}

      <label className="hr-checkbox">
        <input
          type="checkbox"
          checked={useYearly}
          onChange={(event) => setUseYearly(event.target.checked)}
          disabled={saving}
        />
        <span>
          State the yearly figure separately
          <span className="sheet__hint">
            For when the year is not simply twelve times the month.
          </span>
        </span>
      </label>

      {useYearly ? (
        <Field label="How much a year?" htmlFor={ids.yearly}>
          <input
            className="hr-input"
            id={ids.yearly}
            type="text"
            inputMode="decimal"
            value={yearly}
            onChange={(event) => setYearly(event.target.value)}
            placeholder="0.00"
            disabled={saving}
          />
        </Field>
      ) : null}
    </Sheet>
  );
}
