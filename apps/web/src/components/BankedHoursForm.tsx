/**
 * Adding or taking out banked hours.
 *
 * Hours are the one quantity in Headroom that is not money (HANDOFF section 14
 * q11): they are never converted to dollars and never pass through
 * `parseCents` or `formatCents`, because a rate would be an invention.
 *
 * ## Why there is a choice here rather than a minus sign
 *
 * Entries add up, so a negative figure is what takes hours back out, and this
 * form used to say exactly that in a hint: "enter a negative figure such as
 * −7.5". The whole stack accepted one. It was still impossible to do on a
 * phone, because the field asks for `inputMode="decimal"` and that keyboard
 * has digits and a decimal point and no minus key at all. The instruction was
 * correct and unfollowable.
 *
 * So the direction is a choice, and the number is always a plain positive
 * magnitude. Nothing depends on reaching a character the keyboard does not
 * offer. The sign is applied here, on the way out.
 */
import { useId, useState } from "react";
import { ApiError, OfflineError } from "../lib/api.js";
import { useCreateBankedHours } from "../lib/manageQueries.js";
import { Field, Sheet } from "./Sheet.js";

/** A positive magnitude: 7, 7.5 or 7.50. The direction is chosen separately. */
const HOURS = /^\d+(\.\d{1,2})?$/;

type Direction = "add" | "remove";

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
  const [direction, setDirection] = useState<Direction>("add");
  const [hours, setHours] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    setError(null);

    if (!userId) {
      setError("Pick whose hours these are.");
      return;
    }

    const magnitude = hours.trim();
    if (!HOURS.test(magnitude)) {
      setError("Hours look like 7.5 or 7.50.");
      return;
    }
    if (!/[1-9]/.test(magnitude)) {
      setError("Enter more than zero hours.");
      return;
    }

    try {
      await create.mutateAsync({
        userId,
        // The only place a sign is introduced. The field itself never holds one.
        hours: direction === "remove" ? `-${magnitude}` : magnitude,
        ...(note.trim() === "" ? {} : { note: note.trim() }),
      });
      onClose();
    } catch (caught) {
      if (caught instanceof OfflineError || caught instanceof ApiError) setError(caught.message);
      else setError("That did not save. Please try again.");
    }
  };

  const valid = HOURS.test(hours.trim()) && /[1-9]/.test(hours.trim());

  return (
    <Sheet
      title={direction === "add" ? "Add banked hours" : "Take out banked hours"}
      intro="Hours owed to someone. Tracked as hours only — never turned into a dollar figure."
      error={error}
      saving={create.isPending}
      saveLabel={direction === "add" ? "Add hours" : "Take hours out"}
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

      <fieldset className="sheet__choices">
        <legend className="hr-label">Adding or taking out?</legend>
        <label className="sheet__choice">
          <input
            type="radio"
            name="banked-hours-direction"
            value="add"
            checked={direction === "add"}
            onChange={() => setDirection("add")}
            disabled={create.isPending}
          />
          <span>Adding hours — hours worked and owed back</span>
        </label>
        <label className="sheet__choice">
          <input
            type="radio"
            name="banked-hours-direction"
            value="remove"
            checked={direction === "remove"}
            onChange={() => setDirection("remove")}
            disabled={create.isPending}
          />
          <span>Taking hours out — hours taken as time off or paid out</span>
        </label>
      </fieldset>

      <Field
        label="How many hours?"
        htmlFor={ids.hours}
        hint="Up to two decimals. Entries add up to the total on the screen."
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

      {valid ? (
        <div className="sheet__preview">
          <p className="sheet__preview-title">{direction === "add" ? "Adding" : "Taking out"}</p>
          {/* Hours, never money: no currency formatter touches this. */}
          <p className="sheet__preview-amount hr-amount">{hours.trim()} h</p>
        </div>
      ) : null}
    </Sheet>
  );
}
