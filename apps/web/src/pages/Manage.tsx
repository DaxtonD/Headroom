/**
 * Manage: where the household is set up and kept current.
 *
 * Everything that used to require SQL or a CLI lives here — the expenses, who
 * gets paid when, the goals, what you own and owe, and the settings that
 * change how every figure is worked out.
 *
 * The checklist at the top is deliberate. Without pay schedules the pay
 * periods and the horizon cannot be worked out at all, and the old failure
 * mode was a screen full of plausible-looking zeroes with no explanation.
 */
import { formatCents, formatDateShort, parseCents, timesPerYear, cadenceOfSchedule } from "@headroom/core";
import { useState } from "react";
import { Link } from "react-router";
import { Amount, InitialBubble } from "../components/Badges.js";
import { BillForm } from "../components/BillForm.js";
import { ApiError, OfflineError } from "../lib/api.js";
import {
  useBills,
  useCreateAccount,
  useCreatePaySchedule,
  useGenerate,
  usePatchBill,
  usePatchHousehold,
  usePatchPaySchedule,
  useSaveIncome,
  useSetup,
  type Bill,
} from "../lib/manageQueries.js";
import { useBudget } from "../lib/plannerQueries.js";
import "./Manage.css";

export function Manage({ canEdit }: { canEdit: boolean }): React.JSX.Element {
  const setup = useSetup();
  const bills = useBills();
  const budget = useBudget();

  const generate = useGenerate();
  const patchBill = usePatchBill();

  const [editing, setEditing] = useState<Bill | null>(null);
  const [adding, setAdding] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (setup.isPending || bills.isPending) {
    return (
      <div className="manage" aria-busy="true">
        <p className="hr-visually-hidden">Loading</p>
      </div>
    );
  }

  if (setup.isError || !setup.data || bills.isError || !bills.data) {
    return (
      <div className="manage">
        <div className="hr-card manage__error">
          <h2>Could not load this</h2>
          <p>The server did not answer. Nothing has been changed; reload to try again.</p>
        </div>
      </div>
    );
  }

  const data = setup.data;
  const active = bills.data.filter((bill) => bill.active);
  const archived = bills.data.filter((bill) => !bill.active);

  const expenses = active.filter((bill) => bill.kind === "bill" || bill.kind === "transfer");
  const incoming = active.filter((bill) => bill.kind === "paycheque" || bill.kind === "deposit");

  const archive = async (bill: Bill, nextActive: boolean): Promise<void> => {
    setError(null);
    setNotice(null);
    try {
      await patchBill.mutateAsync({
        id: bill.id,
        version: bill.version,
        changes: { active: nextActive },
      });
      setNotice(
        nextActive
          ? `${bill.name} is back. It will appear again the next time bills are brought up to date.`
          : `${bill.name} is archived. Its history is kept, and you can bring it back.`,
      );
    } catch (caught) {
      if (caught instanceof OfflineError || caught instanceof ApiError) setError(caught.message);
      else setError(`Could not change ${bill.name}.`);
    }
  };

  const bringUpToDate = async (): Promise<void> => {
    setError(null);
    setNotice(null);
    try {
      const result = (await generate.mutateAsync()) as { generation: { created: number } };
      const created = result.generation.created;
      setNotice(
        created === 0
          ? "Already up to date; nothing new to add."
          : `Added ${created} upcoming item${created === 1 ? "" : "s"}. Nothing already there was changed.`,
      );
    } catch (caught) {
      if (caught instanceof OfflineError || caught instanceof ApiError) setError(caught.message);
      else setError("Could not bring things up to date.");
    }
  };

  return (
    <div className="manage">
      <h1 className="manage__title">Manage</h1>

      {data.missing.length > 0 ? (
        <section className="manage__checklist" role="status">
          <p className="manage__checklist-title">Still to set up</p>
          <ul>
            {data.missing.includes("account") ? (
              <li>
                A chequing account to track. <AddAccount />
              </li>
            ) : null}
            {data.missing.includes("pay_schedule") ? (
              <li>
                <strong>Paydays.</strong> Without these, pay periods and the horizon cannot be
                worked out, so Upcoming and Pay plan will look empty.
              </li>
            ) : null}
            {data.missing.includes("income") ? (
              <li>
                The household's net income, for the Budget page.
              </li>
            ) : null}
          </ul>
        </section>
      ) : null}

      {notice ? (
        <p className="manage__notice" role="status">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="hr-alert" role="alert">
          {error}
        </p>
      ) : null}

      {/* ---- Expenses ---- */}
      <section className="hr-card manage__section">
        <header className="manage__section-head">
          <h2 className="manage__section-title">Expenses</h2>
          <span className="manage__count">{expenses.length}</span>
        </header>
        <p className="manage__note">
          Entered once. Each one appears on Upcoming with its due date and on Budget with its
          monthly cost.
        </p>

        {expenses.length === 0 ? (
          <p className="manage__empty">No expenses yet.</p>
        ) : (
          <ul className="manage__list">
            {expenses.map((bill) => (
              <BillRow
                key={bill.id}
                bill={bill}
                canEdit={canEdit}
                onEdit={() => setEditing(bill)}
                onArchive={() => void archive(bill, false)}
              />
            ))}
          </ul>
        )}

        <div className="manage__actions">
          <button
            className="hr-button"
            type="button"
            disabled={!canEdit}
            onClick={() => setAdding(true)}
          >
            Add an expense
          </button>
          <button
            className="hr-button hr-button--secondary"
            type="button"
            disabled={!canEdit || generate.isPending}
            onClick={() => void bringUpToDate()}
            title="Creates any upcoming items the expenses call for. Never changes anything already there."
          >
            {generate.isPending ? "Working…" : "Bring upcoming up to date"}
          </button>
        </div>
      </section>

      {/* ---- Money coming in ---- */}
      {incoming.length > 0 ? (
        <section className="hr-card manage__section">
          <header className="manage__section-head">
            <h2 className="manage__section-title">Money coming in</h2>
            <span className="manage__count">{incoming.length}</span>
          </header>
          <ul className="manage__list">
            {incoming.map((bill) => (
              <BillRow
                key={bill.id}
                bill={bill}
                canEdit={canEdit}
                onEdit={() => setEditing(bill)}
                onArchive={() => void archive(bill, false)}
              />
            ))}
          </ul>
        </section>
      ) : null}

      {/* ---- Archived ---- */}
      {archived.length > 0 ? (
        <section className="hr-card manage__section">
          <button
            className="manage__disclosure"
            type="button"
            aria-expanded={showArchived}
            onClick={() => setShowArchived(!showArchived)}
          >
            <span className="manage__section-title">Archived</span>
            <span className="manage__count">{archived.length}</span>
          </button>

          {showArchived ? (
            <>
              <p className="manage__note">
                Paid off or no longer wanted. Their history is kept, and they can come back.
              </p>
              <ul className="manage__list">
                {archived.map((bill) => (
                  <li className="manage__row manage__row--archived" key={bill.id}>
                    <span className="manage__row-main">
                      <span className="manage__row-name">{bill.name}</span>
                      <span className="manage__row-note">{describeSchedule(bill)}</span>
                    </span>
                    <Amount cents={bill.defaultCents} />
                    <button
                      className="manage__small"
                      type="button"
                      disabled={!canEdit}
                      onClick={() => void archive(bill, true)}
                    >
                      Bring back
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </section>
      ) : null}

      {/* ---- Budget-only categories ---- */}
      <section className="hr-card manage__section">
        <header className="manage__section-head">
          <h2 className="manage__section-title">Budget-only categories</h2>
        </header>
        <p className="manage__note">
          Spending with no due date and no bill — food, gas, everyday things. These appear on the
          Budget page only.
        </p>

        {budget.data ? (
          <ul className="manage__list">
            {[...budget.data.fixed.lines, ...budget.data.variable.lines]
              // Lines that came from a bill are managed under Expenses above.
              .filter((line) => line.source === "category" && line.id !== null)
              .map((line) => (
                <li className="manage__row" key={line.id ?? line.name}>
                  <span className="manage__row-main">
                    <span className="manage__row-name">{line.name}</span>
                  </span>
                  <Amount cents={line.monthlyCents} />
                </li>
              ))}
          </ul>
        ) : null}

        <div className="manage__actions">
          <Link className="hr-button hr-button--secondary" to="/budget">
            See the budget
          </Link>
        </div>
      </section>

      {/* ---- Paydays ---- */}
      <PaydaysSection setup={data} canEdit={canEdit} />

      {/* ---- Income ---- */}
      <IncomeSection setup={data} canEdit={canEdit} />

      {/* ---- Household settings ---- */}
      <SettingsSection setup={data} canEdit={canEdit} />

      <section className="hr-card manage__section">
        <h2 className="manage__section-title">Goals, and what you own</h2>
        <p className="manage__note">
          Savings goals live on Goals; what you own and owe, and the retirement assumptions, live
          on Net worth.
        </p>
        <div className="manage__actions">
          <Link className="hr-button hr-button--secondary" to="/goals">
            Goals
          </Link>
          <Link className="hr-button hr-button--secondary" to="/net-worth">
            Net worth
          </Link>
        </div>
      </section>

      {adding || editing ? (
        <BillForm
          existing={editing}
          members={data.members}
          paySchedules={data.paySchedules}
          onClose={() => {
            setAdding(false);
            setEditing(null);
          }}
        />
      ) : null}
    </div>
  );
}

function BillRow({
  bill,
  canEdit,
  onEdit,
  onArchive,
}: {
  bill: Bill;
  canEdit: boolean;
  onEdit: () => void;
  onArchive: () => void;
}): React.JSX.Element {
  return (
    <li className="manage__row">
      <span className="manage__row-main">
        <span className="manage__row-name">{bill.name}</span>
        <span className="manage__row-note">{describeSchedule(bill)}</span>
      </span>
      <Amount cents={bill.defaultCents} />
      <span className="manage__row-buttons">
        <button className="manage__small" type="button" disabled={!canEdit} onClick={onEdit}>
          Edit
        </button>
        <button className="manage__small" type="button" disabled={!canEdit} onClick={onArchive}>
          Archive
        </button>
      </span>
    </li>
  );
}

/** How a bill recurs, in a sentence. */
function describeSchedule(bill: Bill): string {
  const schedule = bill.schedule;
  const cadence = (() => {
    try {
      return cadenceOfSchedule(schedule);
    } catch {
      return null;
    }
  })();

  const howOften = cadence ? ` · ${timesPerYear(cadence)}x a year` : "";

  switch (schedule.type) {
    case "monthly":
      return `Monthly on the ${ordinal(schedule.day)}${howOften}`;
    case "monthly_last":
      return `Monthly, last day${howOften}`;
    case "relative_to_pay":
      return `${schedule.offsetDays === 0 ? "On" : `${schedule.offsetDays} day(s) after`} a payday${howOften}`;
    case "biweekly":
      return `Every payday${howOften}`;
    case "flexible":
      return schedule.frequency === "per_pay_period"
        ? `Flexible, every payday${howOften}`
        : `Flexible, monthly${howOften}`;
    default:
      return "Schedule not readable";
  }
}

function ordinal(day: number): string {
  if (day > 3 && day < 21) return `${day}th`;
  switch (day % 10) {
    case 1:
      return `${day}st`;
    case 2:
      return `${day}nd`;
    case 3:
      return `${day}rd`;
    default:
      return `${day}th`;
  }
}

/* -------------------------------------------------------------------------- */
/* Paydays                                                                    */
/* -------------------------------------------------------------------------- */

function PaydaysSection({
  setup,
  canEdit,
}: {
  setup: ReturnType<typeof useSetup>["data"] & object;
  canEdit: boolean;
}): React.JSX.Element {
  const create = useCreatePaySchedule();
  const patch = usePatchPaySchedule();
  const [userId, setUserId] = useState(setup.members[0]?.id ?? "");
  const [anchorDate, setAnchorDate] = useState("");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);

  const withoutSchedule = setup.members.filter(
    (member) => !setup.paySchedules.some((schedule) => schedule.userId === member.id),
  );

  const add = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);

    if (!userId || anchorDate === "") {
      setError("Pick a person and one of their paydays.");
      return;
    }

    let cents: bigint;
    try {
      cents = parseCents(amount);
    } catch {
      setError("That pay amount is not a number.");
      return;
    }

    try {
      await create.mutateAsync({ userId, anchorDate, defaultCents: cents.toString() });
      setAnchorDate("");
      setAmount("");
    } catch (caught) {
      if (caught instanceof OfflineError || caught instanceof ApiError) setError(caught.message);
      else setError("Could not add that payday.");
    }
  };

  const changeAmount = async (id: string, version: number, text: string): Promise<void> => {
    setError(null);
    try {
      await patch.mutateAsync({ id, version, changes: { defaultCents: parseCents(text).toString() } });
    } catch (caught) {
      if (caught instanceof OfflineError || caught instanceof ApiError) setError(caught.message);
      else setError("Could not change that pay amount.");
    }
  };

  return (
    <section className="hr-card manage__section">
      <header className="manage__section-head">
        <h2 className="manage__section-title">Paydays</h2>
        <span className="manage__count">{setup.paySchedules.length}</span>
      </header>
      <p className="manage__note">
        Pay is every two weeks. Give one real payday and Headroom works out the rest. Everything
        on Upcoming and Pay plan depends on these.
      </p>

      {error ? (
        <p className="hr-alert manage__inline-alert" role="alert">
          {error}
        </p>
      ) : null}

      {setup.paySchedules.length > 0 ? (
        <ul className="manage__list">
          {setup.paySchedules.map((schedule) => (
            <li className="manage__row" key={schedule.id}>
              {schedule.user ? <InitialBubble person={schedule.user} /> : null}
              <span className="manage__row-main">
                <span className="manage__row-name">{schedule.user?.name ?? "Someone"}</span>
                <span className="manage__row-note">
                  Every two weeks from {formatDateShort(schedule.anchorDate)} · 26x a year
                </span>
              </span>
              <PayAmount
                cents={schedule.defaultCents}
                canEdit={canEdit}
                busy={patch.isPending}
                onSave={(text) => void changeAmount(schedule.id, schedule.version, text)}
              />
            </li>
          ))}
        </ul>
      ) : null}

      {withoutSchedule.length > 0 ? (
        <form className="manage__inline-form" onSubmit={(event) => void add(event)}>
          <p className="hr-label">Add a payday</p>

          <select
            className="hr-input"
            value={userId}
            onChange={(event) => setUserId(event.target.value)}
            disabled={create.isPending}
            aria-label="Whose payday"
          >
            {withoutSchedule.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
              </option>
            ))}
          </select>

          <input
            className="hr-input"
            type="date"
            value={anchorDate}
            onChange={(event) => setAnchorDate(event.target.value)}
            disabled={create.isPending}
            aria-label="One of their paydays"
          />

          <input
            className="hr-input"
            type="text"
            inputMode="decimal"
            placeholder="Usual pay, e.g. 1750.00"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            disabled={create.isPending}
            aria-label="Usual pay amount"
          />

          <button className="hr-button" type="submit" disabled={!canEdit || create.isPending}>
            {create.isPending ? "Adding…" : "Add payday"}
          </button>
        </form>
      ) : null}
    </section>
  );
}

function PayAmount({
  cents,
  canEdit,
  busy,
  onSave,
}: {
  cents: bigint;
  canEdit: boolean;
  busy: boolean;
  onSave: (text: string) => void;
}): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(formatCents(cents, { currencySymbol: false, grouping: false }));

  if (!editing) {
    return (
      <span className="manage__row-buttons">
        <Amount cents={cents} />
        <button
          className="manage__small"
          type="button"
          disabled={!canEdit}
          onClick={() => setEditing(true)}
        >
          Edit
        </button>
      </span>
    );
  }

  return (
    <span className="manage__row-buttons">
      <input
        className="hr-input manage__narrow"
        type="text"
        inputMode="decimal"
        value={text}
        onChange={(event) => setText(event.target.value)}
        disabled={busy}
        aria-label="Usual pay amount"
      />
      <button
        className="manage__small"
        type="button"
        disabled={busy}
        onClick={() => {
          onSave(text);
          setEditing(false);
        }}
      >
        Save
      </button>
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Income                                                                     */
/* -------------------------------------------------------------------------- */

function IncomeSection({
  setup,
  canEdit,
}: {
  setup: ReturnType<typeof useSetup>["data"] & object;
  canEdit: boolean;
}): React.JSX.Element {
  const save = useSaveIncome();
  const [monthly, setMonthly] = useState(
    formatCents(setup.household.netMonthlyIncomeCents, { currencySymbol: false, grouping: false }),
  );
  const [yearly, setYearly] = useState(
    formatCents(setup.household.netYearlyIncomeCents, { currencySymbol: false, grouping: false }),
  );
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    try {
      await save.mutateAsync({
        version: setup.household.version,
        netMonthlyCents: parseCents(monthly === "" ? "0" : monthly).toString(),
        netYearlyCents: parseCents(yearly === "" ? "0" : yearly).toString(),
      });
    } catch (caught) {
      if (caught instanceof OfflineError || caught instanceof ApiError) setError(caught.message);
      else setError("Could not save the income.");
    }
  };

  return (
    <section className="hr-card manage__section">
      <h2 className="manage__section-title">Net income</h2>
      <p className="manage__note">
        What actually arrives, after tax and pension. Both figures are stored, because a stated
        yearly income is often not exactly twelve times the monthly one.
      </p>

      {error ? (
        <p className="hr-alert manage__inline-alert" role="alert">
          {error}
        </p>
      ) : null}

      <form className="manage__inline-form" onSubmit={(event) => void submit(event)}>
        <label className="hr-field">
          <span className="hr-label">Per month</span>
          <input
            className="hr-input"
            type="text"
            inputMode="decimal"
            value={monthly}
            onChange={(event) => setMonthly(event.target.value)}
            disabled={save.isPending}
          />
        </label>

        <label className="hr-field">
          <span className="hr-label">Per year</span>
          <input
            className="hr-input"
            type="text"
            inputMode="decimal"
            value={yearly}
            onChange={(event) => setYearly(event.target.value)}
            disabled={save.isPending}
          />
        </label>

        <button className="hr-button" type="submit" disabled={!canEdit || save.isPending}>
          {save.isPending ? "Saving…" : "Save income"}
        </button>
      </form>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Household settings                                                         */
/* -------------------------------------------------------------------------- */

const WEEKEND_RULES = [
  { key: "as_scheduled", label: "Leave it on the weekend date" },
  { key: "friday_before", label: "Move it to the Friday before" },
  { key: "next_business_day", label: "Move it to the Monday after" },
] as const;

function SettingsSection({
  setup,
  canEdit,
}: {
  setup: ReturnType<typeof useSetup>["data"] & object;
  canEdit: boolean;
}): React.JSX.Element {
  const patch = usePatchHousehold();
  const [cushion, setCushion] = useState(
    formatCents(setup.household.cushionCents, { currencySymbol: false, grouping: false }),
  );
  const [horizon, setHorizon] = useState(String(setup.household.horizonPaychequeCount));
  const [weekendRule, setWeekendRule] = useState(setup.household.weekendWithdrawalRule);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);

    const horizonValue = Number(horizon);
    if (!Number.isInteger(horizonValue) || horizonValue < 1 || horizonValue > 52) {
      setError("The horizon must be a whole number of paycheques, from 1 to 52.");
      return;
    }

    try {
      await patch.mutateAsync({
        version: setup.household.version,
        changes: {
          cushionCents: parseCents(cushion === "" ? "0" : cushion).toString(),
          horizonPaychequeCount: horizonValue,
          weekendWithdrawalRule: weekendRule,
        },
      });
    } catch (caught) {
      if (caught instanceof OfflineError || caught instanceof ApiError) setError(caught.message);
      else setError("Could not save those settings.");
    }
  };

  return (
    <section className="hr-card manage__section">
      <h2 className="manage__section-title">How things are worked out</h2>
      <p className="manage__note">
        These three change every figure in the app, so they are worth understanding.
      </p>

      {error ? (
        <p className="hr-alert manage__inline-alert" role="alert">
          {error}
        </p>
      ) : null}

      <form className="manage__inline-form" onSubmit={(event) => void submit(event)}>
        <label className="hr-field">
          <span className="hr-label">Cushion</span>
          <input
            className="hr-input"
            type="text"
            inputMode="decimal"
            value={cushion}
            onChange={(event) => setCushion(event.target.value)}
            disabled={patch.isPending}
          />
          <span className="manage__field-hint">
            How much should still be left after a bill comes out for it to count as covered. It
            comes straight off what is safe to spend.
          </span>
        </label>

        <label className="hr-field">
          <span className="hr-label">Look ahead this many paycheques</span>
          <input
            className="hr-input"
            type="number"
            min={1}
            max={52}
            step={1}
            value={horizon}
            onChange={(event) => setHorizon(event.target.value)}
            disabled={patch.isPending}
          />
          <span className="manage__field-hint">
            "Left this cycle" runs to the day before this many paydays from now.
          </span>
        </label>

        <label className="hr-field">
          <span className="hr-label">When a bill lands on a weekend</span>
          <select
            className="hr-input"
            value={weekendRule}
            onChange={(event) =>
              setWeekendRule(event.target.value as typeof setup.household.weekendWithdrawalRule)
            }
            disabled={patch.isPending}
          >
            {WEEKEND_RULES.map((rule) => (
              <option key={rule.key} value={rule.key}>
                {rule.label}
              </option>
            ))}
          </select>
        </label>

        <button className="hr-button" type="submit" disabled={!canEdit || patch.isPending}>
          {patch.isPending ? "Saving…" : "Save settings"}
        </button>
      </form>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* The chequing account                                                       */
/* -------------------------------------------------------------------------- */

function AddAccount(): React.JSX.Element {
  const create = useCreateAccount();
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      <button
        className="manage__small"
        type="button"
        disabled={create.isPending}
        onClick={() => {
          setError(null);
          create.mutateAsync({ name: "Chequing" }).catch(() => setError("Could not add it."));
        }}
      >
        {create.isPending ? "Adding…" : "Add a chequing account"}
      </button>
      {error ? <span className="manage__field-hint">{error}</span> : null}
    </>
  );
}
