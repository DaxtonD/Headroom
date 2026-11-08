/**
 * Adding or changing someone's paydays.
 *
 * Pay is every two weeks, so one real payday fixes every other one: the anchor
 * date is not a detail, it decides which fortnight every pay period falls in.
 * Changing it by a day shifts the whole schedule, which is why it is editable
 * here instead of being a one-time entry that could only be fixed with SQL.
 *
 * The next few paydays are listed as the date is typed, because an anchor that
 * is out by a week produces a plausible-looking schedule that is wrong.
 */
import { addDays, formatCents, formatDateShort, isPlainDate, parseCents } from "@headroom/core";
import { useId, useState } from "react";
import { ApiError, OfflineError } from "../lib/api.js";
import {
  useCreatePaySchedule,
  usePatchPaySchedule,
  type Member,
  type PayScheduleEntry,
} from "../lib/manageQueries.js";
import { Field, Sheet } from "./Sheet.js";

export function PaydayForm({
  existing,
  candidates,
  onClose,
}: {
  existing: PayScheduleEntry | null;
  /** People who do not have a schedule yet; only used when adding. */
  candidates: readonly Member[];
  onClose: () => void;
}): React.JSX.Element {
  const create = useCreatePaySchedule();
  const patch = usePatchPaySchedule();
  const ids = { person: useId(), date: useId(), amount: useId() };

  const [userId, setUserId] = useState(existing?.userId ?? candidates[0]?.id ?? "");
  const [anchorDate, setAnchorDate] = useState(existing?.anchorDate ?? "");
  const [amount, setAmount] = useState(
    existing ? formatCents(existing.defaultCents, { currencySymbol: false, grouping: false }) : "",
  );
  const [error, setError] = useState<string | null>(null);

  const saving = create.isPending || patch.isPending;

  /** The next three paydays implied by the anchor, as a sanity check. */
  const upcoming = (() => {
    if (!isPlainDate(anchorDate)) return null;
    return [0, 14, 28].map((offset) => addDays(anchorDate, offset));
  })();

  const submit = async (): Promise<void> => {
    setError(null);

    if (!isPlainDate(anchorDate)) {
      setError("Pick one real payday.");
      return;
    }

    let cents: bigint;
    try {
      cents = parseCents(amount);
    } catch {
      setError("That pay amount is not a number.");
      return;
    }
    if (cents <= 0n) {
      setError("A paycheque has to be more than nothing.");
      return;
    }

    try {
      if (existing) {
        await patch.mutateAsync({
          id: existing.id,
          version: existing.version,
          changes: { anchorDate, defaultCents: cents.toString() },
        });
      } else {
        if (!userId) {
          setError("Pick whose payday this is.");
          return;
        }
        await create.mutateAsync({ userId, anchorDate, defaultCents: cents.toString() });
      }
      onClose();
    } catch (caught) {
      if (caught instanceof OfflineError || caught instanceof ApiError) setError(caught.message);
      else setError("That did not save. Please try again.");
    }
  };

  return (
    <Sheet
      title={existing ? `Edit ${existing.user?.name ?? "these"} paydays` : "Add a payday"}
      intro="Pay is every two weeks. Give one real payday and the rest are worked out from it."
      error={error}
      saving={saving}
      saveLabel={existing ? "Save changes" : "Add payday"}
      onClose={onClose}
      onSubmit={submit}
    >
      {existing ? null : (
        <Field label="Whose payday?" htmlFor={ids.person}>
          <select
            className="hr-input"
            id={ids.person}
            value={userId}
            onChange={(event) => setUserId(event.target.value)}
            disabled={saving}
          >
            {candidates.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
              </option>
            ))}
          </select>
        </Field>
      )}

      <Field
        label="One real payday"
        htmlFor={ids.date}
        hint="Any payday will do — a recent one is easiest to check."
      >
        <input
          className="hr-input"
          id={ids.date}
          type="date"
          value={anchorDate}
          onChange={(event) => setAnchorDate(event.target.value)}
          disabled={saving}
          required
        />
      </Field>

      <Field label="Usual pay, after deductions" htmlFor={ids.amount}>
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

      {upcoming ? (
        <div className="sheet__preview">
          <p className="sheet__preview-title">Which means paydays on</p>
          <p className="sheet__preview-note">
            {upcoming.map((date) => formatDateShort(date)).join(" · ")} … and every two weeks
            after that, 26 times a year.
          </p>
          <p className="sheet__preview-note">
            If those dates look wrong, the anchor is wrong — everything on Upcoming and Pay plan
            is worked out from it.
          </p>
        </div>
      ) : null}
    </Sheet>
  );
}
