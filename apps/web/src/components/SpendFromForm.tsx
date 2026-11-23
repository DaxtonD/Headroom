/**
 * "Put purchases on a card for now."
 *
 * Asked for on 2026-11-22, to replace a conversation the household was having
 * by hand: when chequing runs low, one of them tells the other in the morning
 * that necessary purchases go on the Visa until payday.
 *
 * ## What this form is actually for
 *
 * Not the message. The message was never the part that failed - what failed
 * was somebody forgetting and recording a purchase against chequing anyway,
 * at which point every figure on the ledger is wrong in the direction that
 * matters: chequing looks emptier than it is, and the card looks healthier.
 *
 * So saving this changes the **default source account** on a new one-off. The
 * banner and the notification are consequences of the setting rather than the
 * point of it.
 *
 * ## Two things it deliberately does not ask
 *
 * **When it ends.** The server sets that to the next payday. "Until payday" is
 * what somebody says out loud, the server already knows the date, and a
 * posture nobody turns off becomes permanently on and stops being read - so
 * the end is not optional, it is just not a decision anybody has to make.
 *
 * **Who set it.** Recorded server-side from the session. A field for it would
 * let one of them put the other's name on it.
 */
import { useId, useState } from "react";
import { Field, Sheet } from "./Sheet.js";
import { ApiError, OfflineError } from "../lib/api.js";
import { usePatchHousehold } from "../lib/manageQueries.js";
import type { Account } from "../lib/queries.js";

export function SpendFromForm({
  accounts,
  householdVersion,
  onClose,
}: {
  /**
   * The household's accounts. Chequing is filtered out here rather than by
   * the caller: chequing is not a posture, it is the ordinary state, and the
   * way to say that is to clear this. The API rejects it too, so the two
   * cannot drift.
   */
  accounts: readonly Account[];
  householdVersion: number;
  onClose: () => void;
}): React.JSX.Element {
  const patch = usePatchHousehold();
  const ids = { account: useId(), note: useId() };

  const choices = accounts.filter((account) => account.kind !== "chequing");
  const [accountId, setAccountId] = useState<string>(() => {
    // A card first, because that is what this is for. Savings is offered -
    // some households do spend out of it - but it is not the likely answer.
    const card = choices.find((account) => account.kind === "credit_card");
    return card?.id ?? choices[0]?.id ?? "";
  });
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const save = async (): Promise<void> => {
    setError(null);

    if (accountId === "") {
      setError("Add a card or a savings account first.");
      return;
    }
    if (householdVersion === 0) {
      /*
       * No version means no `If-Match`, and a money-affecting change without
       * conflict detection is exactly what the versioning rules exist to
       * stop. Only reachable against a server older than this app.
       */
      setError("This app is newer than the server. Reload and try again.");
      return;
    }

    try {
      await patch.mutateAsync({
        version: householdVersion,
        changes: {
          spendFromAccountId: accountId,
          // Empty is "no reason given", not an empty string in the database.
          spendFromNote: note.trim() === "" ? null : note.trim(),
        },
      });
      onClose();
    } catch (cause) {
      if (cause instanceof OfflineError) {
        setError("You are offline. This one needs the server, so it has not been saved.");
        return;
      }
      if (cause instanceof ApiError) {
        setError(
          cause.status === 409
            ? "The other of you changed this at the same time. Reload to see where it landed."
            : cause.message,
        );
        return;
      }
      setError("That did not save. Try again.");
    }
  };

  return (
    <Sheet
      title="Where purchases come from"
      intro="Until the next payday, a new one-off will default to this account instead of chequing. The other of you gets told."
      error={error}
      saving={patch.isPending}
      saveLabel="Save"
      onClose={onClose}
      onSubmit={save}
    >
      <Field label="Purchases come from" htmlFor={ids.account}>
        <select
          className="hr-input"
          id={ids.account}
          value={accountId}
          onChange={(event) => setAccountId(event.target.value)}
        >
          {choices.map((account) => (
            <option key={account.id} value={account.id}>
              {account.name}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Why (optional)" htmlFor={ids.note}>
        <input
          className="hr-input"
          id={ids.note}
          type="text"
          maxLength={140}
          value={note}
          placeholder="Tight until Friday"
          onChange={(event) => setNote(event.target.value)}
        />
      </Field>
    </Sheet>
  );
}
