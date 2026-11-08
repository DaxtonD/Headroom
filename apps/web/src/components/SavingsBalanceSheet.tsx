/**
 * Typing in the savings balance.
 *
 * Deliberately plainer than the chequing version: there is no checklist of
 * things that might have cleared, because nothing comes out of savings on a
 * schedule. It is a figure read off the bank, and it is a fact.
 *
 * Append-only, like every balance: a correction is a new snapshot and the
 * latest one wins, so there is no version to conflict with and two people
 * typing at once simply produces two snapshots.
 */
import { formatCents, parseCents } from "@headroom/core";
import { useEffect, useId, useRef, useState } from "react";
import { Field, Sheet } from "./Sheet.js";
import { ApiError, OfflineError } from "../lib/api.js";
import { useSaveSavingsBalance, type SavingsAccount } from "../lib/savingsQueries.js";

export function SavingsBalanceSheet({
  accounts,
  onClose,
}: {
  accounts: readonly SavingsAccount[];
  onClose: () => void;
}): React.JSX.Element {
  const save = useSaveSavingsBalance();
  const ids = { amount: useId(), account: useId() };
  const inputRef = useRef<HTMLInputElement>(null);

  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);

  // The amount is the one thing anyone came here to type.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const chosen = accounts.find((account) => account.id === accountId) ?? accounts[0] ?? null;

  const submit = async (): Promise<void> => {
    setError(null);

    let cents: bigint;
    try {
      cents = parseCents(amount);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That is not an amount.");
      return;
    }
    if (cents < 0n) {
      setError("A savings balance below zero is not something a bank reports. Check the amount.");
      return;
    }
    if (accountId === "") {
      setError("There is no savings account to record this against yet.");
      return;
    }

    try {
      await save.mutateAsync({ accountId, cents: cents.toString() });
      onClose();
    } catch (caught) {
      if (caught instanceof OfflineError || caught instanceof ApiError) setError(caught.message);
      else setError("That did not save. Please try again.");
    }
  };

  return (
    <Sheet
      title="Update savings"
      intro="What the bank says is in there now."
      error={error}
      saving={save.isPending}
      saveLabel="Save"
      onClose={onClose}
      onSubmit={submit}
    >
      {accounts.length > 1 ? (
        <Field label="Which account?" htmlFor={ids.account}>
          <select
            className="hr-input"
            id={ids.account}
            value={accountId}
            onChange={(event) => setAccountId(event.target.value)}
            disabled={save.isPending}
          >
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
        </Field>
      ) : null}

      <Field
        label="Balance"
        htmlFor={ids.amount}
        hint={
          chosen?.cents === null || chosen === null
            ? "Nothing has been entered for this account yet."
            : `Last entered as ${formatCents(chosen.cents)}.`
        }
      >
        <input
          className="hr-input"
          id={ids.amount}
          ref={inputRef}
          type="text"
          inputMode="decimal"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          placeholder="0.00"
          disabled={save.isPending}
          required
        />
      </Field>
    </Sheet>
  );
}
