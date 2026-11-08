/**
 * Adding banked hours.
 *
 * Hours are the one quantity in Headroom that is not money (HANDOFF section 14
 * q11): they are never converted to dollars and never pass through
 * `parseCents` or `formatCents`, because a rate would be an invention.
 *
 * Entries add up, so a negative figure is how hours are taken back out — and
 * that is said plainly, since a field that silently accepts a minus sign is
 * worse than one that explains it.
 */
import { useId, useState } from "react";
import { ApiError, OfflineError } from "../lib/api.js";
import { useCreateBankedHours } from "../lib/manageQueries.js";
import { Field, Sheet } from "./Sheet.js";

/** Hours look like 7.5 or 7.50, optionally negative. Matches the API. */
const HOURS = /^-?\d+(\.\d{1,2})?$/;

export function BankedHoursForm({
  people,
  onClose,
}: {
  people: readonly { readonly id: string; readonly name: string }[];
  onClose: () => void;
}): React.JSX.Element {
  const create = useCreateBankedHours();
  const ids = { person: useId(), hours: useId(), note: useId() };

  const [userId, setUserId] = useState(people[0]?.id ?? "");
  const [hours, setHours] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    setError(null);

    if (!userId) {
      setError("Pick whose hours these are.");
      return;
    }
    if (!HOURS.test(hours.trim())) {
      setError("Hours look like 7.5 or 7.50.");
      return;
    }

    try {
      await create.mutateAsync({
        userId,
        hours: hours.trim(),
        ...(note.trim() === "" ? {} : { note: note.trim() }),
      });
      onClose();
    } catch (caught) {
      if (caught instanceof OfflineError || caught instanceof ApiError) setError(caught.message);
      else setError("That did not save. Please try again.");
    }
  };

  const parsed = HOURS.test(hours.trim()) ? Number(hours.trim()) : null;

  return (
    <Sheet
      title="Add banked hours"
      intro="Hours owed to someone. Tracked as hours only — never turned into a dollar figure."
      error={error}
      saving={create.isPending}
      saveLabel="Add hours"
      onClose={onClose}
      onSubmit={submit}
    >
      <Field label="Whose hours?" htmlFor={ids.person}>
        <select
          className="hr-input"
          id={ids.person}
          value={userId}
          onChange={(event) => setUserId(event.target.value)}
          disabled={create.isPending}
        >
          {people.map((person) => (
            <option key={person.id} value={person.id}>
              {person.name}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label="How many hours?"
        htmlFor={ids.hours}
        hint="Entries add up. To take hours back out, enter a negative figure such as −7.5."
      >
        <input
          className="hr-input"
          id={ids.hours}
          type="text"
          inputMode="decimal"
          value={hours}
          onChange={(event) => setHours(event.target.value)}
          placeholder="7.5"
          disabled={create.isPending}
          required
        />
      </Field>

      <Field label="Note" htmlFor={ids.note} hint="Optional — what they were for.">
        <input
          className="hr-input"
          id={ids.note}
          type="text"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          disabled={create.isPending}
          maxLength={200}
        />
      </Field>

      {parsed !== null && parsed !== 0 ? (
        <div className="sheet__preview">
          <p className="sheet__preview-title">{parsed > 0 ? "Adding" : "Taking out"}</p>
          <p className="sheet__preview-amount hr-amount">
            {Math.abs(parsed)} h
          </p>
        </div>
      ) : null}
    </Sheet>
  );
}
