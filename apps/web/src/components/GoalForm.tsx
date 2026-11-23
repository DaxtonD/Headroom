/**
 * Adding or changing a savings goal.
 *
 * A goal is a target and what has been put aside so far. The progress figure
 * is stored rather than derived, because money moves into a goal by decision
 * and not by rule — there is no schedule to work it out from.
 *
 * What is left is shown as it is typed, so the target and the saved figure are
 * never entered the wrong way round without it being obvious.
 */
import { formatCents, parseCents } from "@headroom/core";
import { useId, useState } from "react";
import { ApiError, OfflineError } from "../lib/api.js";
import { useCreateGoal, useDeleteGoal, usePatchGoal } from "../lib/manageQueries.js";
import type { GoalProgress } from "../lib/plannerQueries.js";
import { Field, RemoveButton, Sheet } from "./Sheet.js";

export function GoalForm({
  existing,
  onClose,
}: {
  existing: GoalProgress | null;
  onClose: () => void;
}): React.JSX.Element {
  const create = useCreateGoal();
  const patch = usePatchGoal();
  const remove = useDeleteGoal();
  const ids = {
    name: useId(),
    target: useId(),
    saved: useId(),
    hasTarget: useId(),
    intent: useId(),
  };

  const [name, setName] = useState(existing?.name ?? "");
  // Spelled out rather than `existing?.targetCents != null`, because for a new
  // goal `undefined != null` is false and the default has to be "has a target".
  const [hasTarget, setHasTarget] = useState(existing ? existing.targetCents !== null : true);
  const [target, setTarget] = useState(
    existing && existing.targetCents !== null
      ? formatCents(existing.targetCents, { currencySymbol: false, grouping: false })
      : "",
  );
  const [saved, setSaved] = useState(
    existing ? formatCents(existing.savedCents, { currencySymbol: false, grouping: false }) : "0",
  );
  /**
   * What to put in each payday, or empty for a pot with no plan.
   *
   * Empty is not zero, and the difference decides whether this goal is ever
   * allocated to. A pot with no plan is somewhere to put money on purpose -
   * the normal state for a trip - and the ledger leaves it out of the
   * breakdown rather than quietly earmarking for it.
   */
  const [intent, setIntent] = useState(
    existing && existing.perPaydayIntentCents !== null
      ? formatCents(existing.perPaydayIntentCents, { currencySymbol: false, grouping: false })
      : "",
  );
  const [error, setError] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);

  const saving = create.isPending || patch.isPending || remove.isPending;

  const preview = (() => {
    if (!hasTarget) return null;
    let targetCents: bigint;
    let savedCents: bigint;
    try {
      targetCents = parseCents(target === "" ? "0" : target);
      savedCents = parseCents(saved === "" ? "0" : saved);
    } catch {
      return null;
    }
    if (targetCents <= 0n) return null;

    const remaining = targetCents - savedCents;
    // Integer percentage, computed in cents so no float is involved.
    const pct = Number((savedCents * 100n) / targetCents);
    return { remaining, pct: Math.max(0, Math.min(100, pct)) };
  })();

  const submit = async (): Promise<void> => {
    setError(null);

    if (name.trim() === "") {
      setError("Give this goal a name.");
      return;
    }

    let targetCents: bigint | null = null;
    let savedCents: bigint;

    if (hasTarget) {
      try {
        targetCents = parseCents(target);
      } catch {
        setError("That target is not a number.");
        return;
      }
      if (targetCents <= 0n) {
        setError("A target has to be above zero, or switch it off.");
        return;
      }
    }

    let intentCents: bigint | null = null;
    if (intent.trim() !== "") {
      try {
        intentCents = parseCents(intent);
      } catch {
        setError("That payday amount is not a number.");
        return;
      }
      if (intentCents < 0n) {
        setError("A payday amount cannot be negative.");
        return;
      }
    }

    try {
      savedCents = parseCents(saved === "" ? "0" : saved);
    } catch {
      setError("That saved amount is not a number.");
      return;
    }
    if (savedCents < 0n) {
      setError("Saved cannot be negative.");
      return;
    }

    try {
      if (existing) {
        await patch.mutateAsync({
          id: existing.id,
          version: existing.version,
          changes: {
            name: name.trim(),
            targetCents: targetCents === null ? null : targetCents.toString(),
            savedCents: savedCents.toString(),
            perPaydayIntentCents: intentCents === null ? null : intentCents.toString(),
          },
        });
      } else {
        await create.mutateAsync({
          name: name.trim(),
          targetCents: targetCents === null ? null : targetCents.toString(),
          savedCents: savedCents.toString(),
          perPaydayIntentCents: intentCents === null ? null : intentCents.toString(),
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
      title={existing ? "Edit goal" : "Add a goal"}
      intro="Something you are saving towards. A target is optional - leave it off and it simply accumulates."
      error={error}
      saving={saving}
      saveLabel={existing ? "Save changes" : "Add goal"}
      onClose={onClose}
      onSubmit={submit}
      footer={
        existing ? (
          <RemoveButton
            label="Remove this goal"
            confirmLabel="Yes, remove it"
            note="It stops appearing on Goals. The figures it held stay in the history."
            armed={armed}
            disabled={saving}
            onArm={() => setArmed(true)}
            onConfirm={() => void destroy()}
          />
        ) : null
      }
    >
      <Field label="What are you saving for?" htmlFor={ids.name}>
        <input
          className="hr-input"
          id={ids.name}
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Trip"
          disabled={saving}
          required
        />
      </Field>

      {/*
        Some things have a number attached and some do not. Asked, 2026-11-08:
        "Trips never have a set date or set cost. We simply save for it and
        book a good deal when it comes about." So the target is opt-in, and
        switching it off is a normal answer rather than leaving a box empty.
      */}
      <label className="sheet__checkbox" htmlFor={ids.hasTarget}>
        <input
          id={ids.hasTarget}
          type="checkbox"
          checked={hasTarget}
          onChange={(event) => setHasTarget(event.target.checked)}
          disabled={saving}
        />
        <span>There is an amount we are aiming for</span>
      </label>

      {hasTarget ? (
        <Field label="How much do you need?" htmlFor={ids.target}>
          <input
            className="hr-input"
            id={ids.target}
            type="text"
            inputMode="decimal"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            placeholder="0.00"
            disabled={saving}
            required
          />
        </Field>
      ) : null}

      <Field
        label="How much is set aside already?"
        htmlFor={ids.saved}
        hint="Update this whenever money moves into the goal."
      >
        <input
          className="hr-input"
          id={ids.saved}
          type="text"
          inputMode="decimal"
          value={saved}
          onChange={(event) => setSaved(event.target.value)}
          placeholder="0.00"
          disabled={saving}
        />
      </Field>

      {/*
        What the household means to put in each payday.

        Per payday rather than per month, because the figure it is shown
        against on the ledger - what could safely leave chequing in this pay
        period - is a per-period one. Converting money between the two would
        need a rounding rule nobody asked for.

        Leaving it blank is a real answer and the hint says so: a pot with no
        plan is never allocated to, which is what keeps "not earmarked" from
        quietly becoming zero.
      */}
      <Field
        label="Put aside each payday?"
        htmlFor={ids.intent}
        hint="Leave blank for a pot you add to when you choose. The ledger shows this against what could safely leave chequing."
      >
        <input
          className="hr-input"
          id={ids.intent}
          type="text"
          inputMode="decimal"
          value={intent}
          onChange={(event) => setIntent(event.target.value)}
          placeholder="Blank for no plan"
          disabled={saving}
        />
      </Field>

      {preview ? (
        <div className="sheet__preview">
          <p className="sheet__preview-title">Progress</p>
          <p className="sheet__preview-amount hr-amount">
            {preview.remaining > 0n
              ? `${formatCents(preview.remaining)} to go`
              : "Target reached"}
          </p>
          <p className="sheet__preview-note">{preview.pct}% of the way there.</p>
        </div>
      ) : null}
    </Sheet>
  );
}
