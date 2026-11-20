/**
 * Adding one thing that happens once.
 *
 * This is the spreadsheet's "add a few extra rows", which is how the household
 * actually works: a dentist bill this month, an extra amount into savings
 * because a third paycheque landed, a rebate that arrived. None of it recurs,
 * so none of it should become a template that generates for ever.
 *
 * It had no interface at all until now. The endpoint and the mutation hook
 * both existed and nothing connected them, so the only way to add a row was
 * SQL - which is exactly the gap the wiring test was written to find, and did.
 *
 * Three choices matter here and all of them default to what the household
 * does most:
 *
 *  - **What it is** decides which way the money goes. The server signs the
 *    amount from the kind, so the amount is always typed as a plain positive
 *    number and never with a minus.
 *  - **Has it happened** decides whether the row arrives with its tick
 *    already on. It defaults to yes, because a one-off is nearly always typed
 *    in after the fact: a dentist bill paid at the counter, a payment made to
 *    a card on the bank's own app. Reported from use, in those words - "I
 *    then have to open it again to mark it as paid". That was two steps to
 *    say one thing.
 *  - **When** is either a date or a paycheque. Attached to a paycheque it can
 *    be moved to an earlier or later one when a week is tight, which is the
 *    whole point of a flexible row; on a date it cannot, because the bank acts
 *    on that day whatever else is happening.
 *
 * Something already done has a day it happened on, so it is always dated and
 * the paycheque choice is not offered for it. Hanging it off a cheque is a
 * statement about a payment that has not been made yet, which is the opposite
 * of what "already done" says.
 */
import { formatCents, parseCents } from "@headroom/core";
import { useId, useState } from "react";
import { Field, Sheet } from "./Sheet.js";
import type { MoveTarget } from "./OccurrenceRow.js";
import { ApiError, OfflineError, newIdempotencyKey } from "../lib/api.js";
import { useCreateOneOff, type Account } from "../lib/queries.js";
import {
  CHEQUING,
  accountIdOf,
  destinationOptions,
  needsDestination,
  sourceOptions,
} from "../lib/routing.js";

/*
 * `card` is this form's own kind, not the API's.
 *
 * Paying a card is a transfer as far as the data model is concerned - money
 * leaves one account and arrives in another - but "transfer" on screen has
 * always meant putting money into savings, and the two read nothing alike to
 * the person adding one. So the choice is offered in the words the household
 * uses and mapped to the API's kind on the way out.
 *
 * It is the flow the card warning points at: "nothing is scheduled to pay the
 * Visa" is only fair if there is somewhere to say that there is.
 */
/*
 * `mortgage` is this form's own kind too, and for the opposite reason to
 * `card`.
 *
 * Paying a card is a transfer underneath: money leaves one account and
 * arrives in another. A lump sum off the mortgage is NOT, because the
 * mortgage is not an account - there is no balance for the money to arrive
 * in, only a loan to be made smaller. So it goes out as an ordinary bill
 * carrying `mortgageId`, and the Savings screen reads that row as the lump
 * sum rather than keeping a second copy of it.
 *
 * Reported on 2026-11-20: "How do I make a lump sum payment to the mortgage?
 * It's not accessible from the ledger screen... the only way is from the
 * savings screen but it doesn't specify where the money is coming out of."
 * It did not specify because, as built, none did - that record moved no
 * balance anywhere.
 */
type Kind = "bill" | "transfer" | "deposit" | "card" | "mortgage";

const KINDS: readonly { readonly kind: Kind; readonly label: string }[] = [
  { kind: "bill", label: "Money going out" },
  { kind: "card", label: "Paying a credit card" },
  { kind: "mortgage", label: "Lump sum off the mortgage" },
  { kind: "transfer", label: "Into savings" },
  { kind: "deposit", label: "Money coming in" },
];

export function OneOffForm({
  paydays,
  accounts = [],
  mortgageId = null,
  today,
  onClose,
}: {
  /** "Now" plus each upcoming payday, as built by the screen showing them. */
  paydays: readonly MoveTarget[];
  /** The household's accounts. Empty means the old single-account form. */
  accounts?: readonly Account[];
  /**
   * The mortgage a lump sum would pay, or null when there is none.
   *
   * Null hides the choice entirely, on the same rule as the cards and the
   * savings accounts: a choice with no valid answer is worse than no choice.
   */
  mortgageId?: string | null;
  /**
   * Today, as the server reckons it (`America/Regina`).
   *
   * Not `new Date()` on the phone: the default date for something already
   * done, and the check that it is not in the future, both have to agree with
   * the clock every other figure is built from. A phone an hour the wrong
   * side of midnight would otherwise date a payment yesterday.
   */
  today: string;
  onClose: () => void;
}): React.JSX.Element {
  const create = useCreateOneOff();
  const ids = {
    name: useId(),
    amount: useId(),
    date: useId(),
    payday: useId(),
    card: useId(),
    savings: useId(),
    payFrom: useId(),
  };

  const cards = destinationOptions(accounts).filter(
    (account) => account.kind === "credit_card",
  );
  /*
   * Where "Into savings" lands.
   *
   * This list is the whole bug. The choice was offered without it: the form
   * sent `kind: "transfer"` and no destination, so the row was a transfer with
   * nowhere to go. Chequing went down by the amount and savings never moved -
   * the money was simply gone as far as every figure here is concerned.
   *
   * It read as working because the card flow beside it does work: that one was
   * built later, with a destination, when there was more than one account to
   * name. "Into savings" is older than that and predates there being anywhere
   * for it to go.
   */
  const savingsAccounts = destinationOptions(accounts).filter(
    (account) => account.kind === "savings",
  );
  // Nowhere to put it, nothing to offer. Same rule as the cards: a choice with
  // no valid answer is worse than no choice.
  const kinds = KINDS.filter((option) => {
    if (option.kind === "card") return cards.length > 0;
    if (option.kind === "transfer") return savingsAccounts.length > 0;
    if (option.kind === "mortgage") return mortgageId !== null;
    return true;
  });

  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [kind, setKind] = useState<Kind>("bill");
  /**
   * Already done, so the row arrives ticked and the balance moves at once.
   *
   * The default, and the reason the form exists in the shape it does: what
   * gets typed in here is a record far more often than it is a plan.
   */
  const [happened, setHappened] = useState(true);
  const [placement, setPlacement] = useState<"payday" | "date">("payday");
  const [date, setDate] = useState(today);
  // The first real payday if there is one, rather than "Now": something added
  // by hand is nearly always for a cheque that has not arrived yet.
  const [payday, setPayday] = useState<string>(
    () => paydays.find((target) => target.id !== null)?.id ?? "",
  );
  /** Which card is being paid. Pre-picked when there is only one. */
  const [cardId, setCardId] = useState<string>(() => cards[0]?.id ?? CHEQUING);
  /** Which savings account it goes into. Pre-picked when there is only one. */
  const [savingsId, setSavingsId] = useState<string>(
    () => savingsAccounts[0]?.id ?? CHEQUING,
  );
  /** Where the money comes from. "" is chequing, as the API spells it. */
  const [paidFromAccountId, setPaidFromAccountId] = useState(CHEQUING);
  const [error, setError] = useState<string | null>(null);

  /**
   * Where the money arrives, for the two kinds that send it somewhere.
   *
   * One value rather than a branch at each use, so the destination the form
   * shows, the destination it sends and the account it strikes off the source
   * list are the same string by construction.
   */
  const destinationId =
    kind === "card" ? cardId : kind === "transfer" ? savingsId : CHEQUING;
  /*
   * `CHEQUING` here means "no destination", which is right: a lump sum leaves
   * an account and does not arrive in one. The source list is therefore the
   * full set, because there is nothing to strike off it.
   */

  /** Chequing is the empty option, so it is not in this list. */
  const payFrom = sourceOptions(accounts, destinationId);

  /*
   * Something that has happened happened on a day. So the placement choice
   * belongs to the other branch only, and `placement` is left alone while
   * this one is on rather than being overwritten - switch back and the
   * paycheque that was picked is still picked.
   */
  const onADate = happened || placement === "date";

  const preview = (() => {
    try {
      const cents = parseCents(amount === "" ? "0" : amount);
      if (cents === 0n) return null;
      const magnitude = cents < 0n ? -cents : cents;
      return kind === "deposit" ? magnitude : -magnitude;
    } catch {
      return null;
    }
  })();

  const submit = async (): Promise<void> => {
    setError(null);

    if (name.trim() === "") {
      setError("Give this a name.");
      return;
    }

    let cents: bigint;
    try {
      cents = parseCents(amount);
    } catch {
      setError("That amount is not a number.");
      return;
    }
    if (cents === 0n) {
      setError("An amount of nothing would not change anything.");
      return;
    }

    if (onADate && date === "") {
      setError(happened ? "Pick the day it happened." : "Pick the date it comes out.");
      return;
    }

    /*
     * "Already done" and a date in the future cannot both be true, and the
     * combination is worse than it looks: a settled row is left out of the
     * forecast, so a future payment marked done would quietly stop counting
     * towards anything. Caught here, where the date being argued about is on
     * screen.
     */
    if (happened && date > today) {
      setError("That date has not happened yet. Change it, or choose \u201cStill to come\u201d.");
      return;
    }

    if (needsDestination(kind === "card", cardId, cards)) {
      setError("Pick which card this pays.");
      return;
    }

    // The money has to land somewhere nameable. Saving it without a
    // destination is what made it disappear.
    if (needsDestination(kind === "transfer", savingsId, savingsAccounts)) {
      setError("Pick which savings account this goes into.");
      return;
    }

    try {
      await create.mutateAsync({
        name: name.trim(),
        // Always a positive magnitude; the server signs it from the kind.
        cents: (cents < 0n ? -cents : cents).toString(),
        // This form's `card` is the API's `transfer`, with a destination.
        // Its `mortgage` is an ordinary bill that names the mortgage it pays.
        kind: kind === "card" ? "transfer" : kind === "mortgage" ? "bill" : kind,
        ...(kind === "mortgage" && mortgageId !== null ? { mortgageId } : {}),
        // Both kinds that move money send where it lands. Paying a card did
        // this already; "Into savings" did not, and that was the bug.
        ...(destinationId === CHEQUING ? {} : { transferToAccountId: destinationId }),
        ...(paidFromAccountId === CHEQUING
          ? {}
          : { paidFromAccountId: accountIdOf(paidFromAccountId) }),
        // Created with the tick already on, rather than added and then found
        // again on the ledger to tick. Same field, same meaning.
        ...(happened ? { paid: true } : {}),
        ...(onADate
          ? { date }
          : // An empty selection is "Now", which the API spells as a null anchor.
            { anchorOccurrenceId: payday === "" ? null : payday }),
        idempotencyKey: newIdempotencyKey(),
      });
      onClose();
    } catch (caught) {
      if (caught instanceof OfflineError || caught instanceof ApiError) setError(caught.message);
      else setError("That did not save. Please try again.");
    }
  };

  return (
    <Sheet
      title="Add a one-off"
      intro="Something that happens once. It appears on the ledger straight away and never comes back. If it has already happened it arrives ticked, and the balance moves with it."
      error={error}
      saving={create.isPending}
      saveLabel="Add it"
      onClose={onClose}
      onSubmit={submit}
    >
      <Field label="What is it?" htmlFor={ids.name}>
        <input
          className="hr-input"
          id={ids.name}
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Dentist"
          disabled={create.isPending}
          required
        />
      </Field>

      <Field
        label="How much?"
        htmlFor={ids.amount}
        hint="Type it as a plain amount. Which way it goes comes from the choice below."
      >
        <input
          className="hr-input"
          id={ids.amount}
          type="text"
          inputMode="decimal"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          placeholder="0.00"
          disabled={create.isPending}
          required
        />
      </Field>

      <fieldset className="sheet__choices">
        <legend className="hr-label">What kind of thing is it?</legend>
        {kinds.map((option) => (
          <label className="sheet__choice" key={option.kind}>
            <input
              type="radio"
              name="one-off-kind"
              value={option.kind}
              checked={kind === option.kind}
              onChange={() => setKind(option.kind)}
              disabled={create.isPending}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </fieldset>

      {kind === "card" && cards.length > 1 ? (
        <Field label="Which card?" htmlFor={ids.card}>
          <select
            className="hr-input"
            id={ids.card}
            value={cardId}
            onChange={(event) => setCardId(event.target.value)}
            disabled={create.isPending}
          >
            {cards.map((card) => (
              <option key={card.id} value={card.id}>
                {card.name} — {formatCents(card.cents)} owed
              </option>
            ))}
          </select>
        </Field>
      ) : null}

      {kind === "transfer" && savingsAccounts.length > 1 ? (
        <Field label="Which savings account?" htmlFor={ids.savings}>
          <select
            className="hr-input"
            id={ids.savings}
            value={savingsId}
            onChange={(event) => setSavingsId(event.target.value)}
            disabled={create.isPending}
          >
            {savingsAccounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
        </Field>
      ) : null}

      {/*
        Where it comes from. Chequing is the empty option and the default,
        because it nearly always is - but the household asked to be able to
        pay a card, or an expense, straight out of savings.
      */}
      {payFrom.length > 0 && kind !== "deposit" ? (
        <Field label="Which account does it come out of?" htmlFor={ids.payFrom}>
          <select
            className="hr-input"
            id={ids.payFrom}
            value={paidFromAccountId}
            onChange={(event) => setPaidFromAccountId(event.target.value)}
            disabled={create.isPending}
          >
            <option value={CHEQUING}>Chequing</option>
            {payFrom.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
        </Field>
      ) : null}

      {/*
        The one that answers the complaint. Default yes, so the common case -
        typing in something that has already been paid - is name, amount and
        Add it, with nothing to go back and tick afterwards.
      */}
      <fieldset className="sheet__choices">
        <legend className="hr-label">Has it happened?</legend>
        <label className="sheet__choice">
          <input
            type="radio"
            name="one-off-happened"
            value="done"
            checked={happened}
            onChange={() => {
              setHappened(true);
              // A thing that happened happened on a day, and today is very
              // nearly always the day somebody is typing it in about.
              if (date === "") setDate(today);
            }}
            disabled={create.isPending}
          />
          <span>Already done — tick it now, and move the balance</span>
        </label>
        <label className="sheet__choice">
          <input
            type="radio"
            name="one-off-happened"
            value="coming"
            checked={!happened}
            onChange={() => setHappened(false)}
            disabled={create.isPending}
          />
          <span>Still to come — it waits on the ledger until you tick it</span>
        </label>
      </fieldset>

      {/*
        Only for something still to come. A paycheque to hang off is a way of
        moving a payment that has not been made yet; there is nothing to move
        about one that has.
      */}
      {happened ? null : (
        <fieldset className="sheet__choices">
          <legend className="hr-label">When?</legend>
          <label className="sheet__choice">
            <input
              type="radio"
              name="one-off-when"
              value="payday"
              checked={placement === "payday"}
              onChange={() => setPlacement("payday")}
              disabled={create.isPending}
            />
            <span>With a paycheque — can be moved later if the week is tight</span>
          </label>
          <label className="sheet__choice">
            <input
              type="radio"
              name="one-off-when"
              value="date"
              checked={placement === "date"}
              onChange={() => setPlacement("date")}
              disabled={create.isPending}
            />
            <span>On a date — the bank takes it that day</span>
          </label>
        </fieldset>
      )}

      {!onADate ? (
        <Field label="Which paycheque?" htmlFor={ids.payday}>
          <select
            className="hr-input"
            id={ids.payday}
            value={payday}
            onChange={(event) => setPayday(event.target.value)}
            disabled={create.isPending}
          >
            {paydays.map((target) => (
              <option key={target.id ?? "now"} value={target.id ?? ""}>
                {target.label}
              </option>
            ))}
          </select>
        </Field>
      ) : (
        <Field label={happened ? "When did it happen?" : "What date?"} htmlFor={ids.date}>
          <input
            className="hr-input"
            id={ids.date}
            type="date"
            value={date}
            // Today is as late as something already done can be. The check in
            // `submit` is the one that decides; this only stops the phone's
            // own picker offering a day that will be refused.
            {...(happened ? { max: today } : {})}
            onChange={(event) => setDate(event.target.value)}
            disabled={create.isPending}
            required
          />
        </Field>
      )}

      {preview !== null ? (
        <div className="sheet__preview">
          <p className="sheet__preview-title">On the timeline</p>
          <p className="sheet__preview-amount hr-amount">{formatCents(preview)}</p>
          <p className="sheet__preview-note">
            {happened
              ? preview < 0n
                ? "Already gone, so it comes off the balance as soon as this is added."
                : "Already in, so it goes on the balance as soon as this is added."
              : preview < 0n
                ? "Taken off the balance."
                : "Added to the balance."}
          </p>
        </div>
      ) : null}
    </Sheet>
  );
}
