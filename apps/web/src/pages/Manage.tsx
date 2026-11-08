/**
 * Manage: where the household is set up and kept current.
 *
 * The rule for this screen is that everything it shows, it can change. A
 * management screen that lists figures you cannot edit is just a report, and
 * the first version of this page was exactly that for half its sections —
 * budget categories, goals and net worth were read-only, so the only way to
 * correct one was SQL.
 *
 * So: every list here has an Edit on each row and an Add underneath, and
 * removing something is offered inside the form that edits it, where the thing
 * being removed is named and on screen.
 *
 * The checklist at the top is deliberate. Without pay schedules the pay
 * periods and the horizon cannot be worked out at all, and the old failure
 * mode was a screen full of plausible-looking zeroes with no explanation.
 */
import {
  cadenceOfSchedule,
  formatCents,
  formatDateShort,
  parseCents,
  timesPerYear,
} from "@headroom/core";
import { useState } from "react";
import { Link } from "react-router";
import { AssetForm } from "../components/AssetForm.js";
import { Amount, InitialBubble } from "../components/Badges.js";
import { BillForm } from "../components/BillForm.js";
import { CategoryForm } from "../components/CategoryForm.js";
import { GoalForm } from "../components/GoalForm.js";
import { PaydayForm } from "../components/PaydayForm.js";
import { ApiError, OfflineError } from "../lib/api.js";
import {
  useBills,
  useCategories,
  useCreateAccount,
  useGenerate,
  usePatchAccount,
  usePatchBill,
  usePatchHousehold,
  useSaveIncome,
  useSetup,
  type AccountEntry,
  type Bill,
  type Category,
  type PayScheduleEntry,
  type Setup,
} from "../lib/manageQueries.js";
import { useGoalsOverview, useNetWorth, type AssetEntry, type GoalProgress } from "../lib/plannerQueries.js";
import "./Manage.css";

/** Which editing sheet is open, and on what. */
type Editing =
  | { readonly kind: "bill"; readonly bill: Bill | null; readonly adding: "bill" | "deposit" }
  | { readonly kind: "category"; readonly category: Category | null }
  | { readonly kind: "goal"; readonly goal: GoalProgress | null }
  | { readonly kind: "asset"; readonly asset: AssetEntry | null; readonly defaultKind: "asset" | "liability" }
  | { readonly kind: "payday"; readonly payday: PayScheduleEntry | null }
  | null;

export function Manage({ canEdit }: { canEdit: boolean }): React.JSX.Element {
  const setup = useSetup();
  const bills = useBills();
  const categories = useCategories();
  const goals = useGoalsOverview();
  const netWorth = useNetWorth();

  const generate = useGenerate();
  const patchBill = usePatchBill();

  const [editing, setEditing] = useState<Editing>(null);
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

  const close = (): void => setEditing(null);

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
      <p className="manage__intro">
        Everything the app works from is entered here, and anything listed here can be changed.
      </p>

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
              <li>The household's net income, for the Budget page.</li>
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
      <Section
        title="Expenses"
        count={expenses.length}
        note="Entered once. Each one appears on Upcoming with its due date and on Budget with its monthly cost."
        empty="No expenses yet."
        isEmpty={expenses.length === 0}
        actions={
          <>
            <button
              className="hr-button"
              type="button"
              disabled={!canEdit}
              onClick={() => setEditing({ kind: "bill", bill: null, adding: "bill" })}
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
          </>
        }
      >
        {expenses.map((bill) => (
          <Row
            key={bill.id}
            name={bill.name}
            note={describeSchedule(bill)}
            amount={bill.defaultCents}
            canEdit={canEdit}
            onEdit={() => setEditing({ kind: "bill", bill, adding: "bill" })}
            extra={
              <button
                className="manage__small"
                type="button"
                disabled={!canEdit}
                onClick={() => void archive(bill, false)}
              >
                Archive
              </button>
            }
          />
        ))}
      </Section>

      {/* ---- Money coming in ---- */}
      <Section
        title="Money coming in"
        count={incoming.length}
        note="Paycheques come from the paydays below. Anything else that arrives — a refund, a transfer in — goes here."
        empty="Nothing but paycheques."
        isEmpty={incoming.length === 0}
        actions={
          <button
            className="hr-button hr-button--secondary"
            type="button"
            disabled={!canEdit}
            onClick={() => setEditing({ kind: "bill", bill: null, adding: "deposit" })}
          >
            Add money coming in
          </button>
        }
      >
        {incoming.map((bill) => (
          <Row
            key={bill.id}
            name={bill.name}
            note={describeSchedule(bill)}
            amount={bill.defaultCents}
            canEdit={canEdit}
            onEdit={() => setEditing({ kind: "bill", bill, adding: "deposit" })}
            extra={
              <button
                className="manage__small"
                type="button"
                disabled={!canEdit}
                onClick={() => void archive(bill, false)}
              >
                Archive
              </button>
            }
          />
        ))}
      </Section>

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
      <Section
        title="Budget-only categories"
        count={categories.data?.length}
        note="Spending with no due date and no bill — food, gas, everyday things. These appear on the Budget page only."
        empty="No categories yet."
        isEmpty={(categories.data?.length ?? 0) === 0}
        pending={categories.isPending}
        actions={
          <>
            <button
              className="hr-button"
              type="button"
              disabled={!canEdit}
              onClick={() => setEditing({ kind: "category", category: null })}
            >
              Add a category
            </button>
            <Link className="hr-button hr-button--secondary" to="/budget">
              See the budget
            </Link>
          </>
        }
      >
        {(categories.data ?? []).map((category) => (
          <Row
            key={category.id}
            name={category.name}
            note={
              category.section === "fixed"
                ? "Fixed · the same every month"
                : "Variable · it changes"
            }
            amount={category.monthlyCents}
            canEdit={canEdit}
            onEdit={() => setEditing({ kind: "category", category })}
          />
        ))}
      </Section>

      {/* ---- Savings goals ---- */}
      <Section
        title="Savings goals"
        count={goals.data?.goals.length}
        note="What you are saving towards, and how much is set aside so far."
        empty="No goals yet."
        isEmpty={(goals.data?.goals.length ?? 0) === 0}
        pending={goals.isPending}
        actions={
          <>
            <button
              className="hr-button"
              type="button"
              disabled={!canEdit}
              onClick={() => setEditing({ kind: "goal", goal: null })}
            >
              Add a goal
            </button>
            <Link className="hr-button hr-button--secondary" to="/savings">
              See savings
            </Link>
          </>
        }
      >
        {(goals.data?.goals ?? []).map((goal) => (
          <Row
            key={goal.id}
            name={goal.name}
            note={
              goal.targetCents === null || goal.pct === null
                ? "No target - saving towards it"
                : `${goal.pct}% of ${formatCents(goal.targetCents)}`
            }
            amount={goal.savedCents}
            canEdit={canEdit}
            onEdit={() => setEditing({ kind: "goal", goal })}
          />
        ))}
      </Section>

      {/* ---- What you own and owe ---- */}
      <Section
        title="What you own"
        count={netWorth.data?.assets.length}
        note="Everything owned, which adds to net worth."
        empty="Nothing entered yet."
        isEmpty={(netWorth.data?.assets.length ?? 0) === 0}
        pending={netWorth.isPending}
        actions={
          <button
            className="hr-button"
            type="button"
            disabled={!canEdit}
            onClick={() => setEditing({ kind: "asset", asset: null, defaultKind: "asset" })}
          >
            Add something owned
          </button>
        }
      >
        {(netWorth.data?.assets ?? []).map((asset) => (
          <Row
            key={asset.id}
            name={asset.name}
            note={describeAsset(asset)}
            amount={asset.cents}
            canEdit={canEdit}
            onEdit={() => setEditing({ kind: "asset", asset, defaultKind: "asset" })}
          />
        ))}
      </Section>

      <Section
        title="What you owe"
        count={netWorth.data?.liabilities.length}
        note="Everything owed, which comes off net worth."
        empty="Nothing entered yet."
        isEmpty={(netWorth.data?.liabilities.length ?? 0) === 0}
        pending={netWorth.isPending}
        actions={
          <>
            <button
              className="hr-button"
              type="button"
              disabled={!canEdit}
              onClick={() => setEditing({ kind: "asset", asset: null, defaultKind: "liability" })}
            >
              Add something owed
            </button>
            <Link className="hr-button hr-button--secondary" to="/net-worth">
              See net worth
            </Link>
          </>
        }
      >
        {(netWorth.data?.liabilities ?? []).map((asset) => (
          <Row
            key={asset.id}
            name={asset.name}
            note={describeAsset(asset)}
            amount={asset.cents}
            canEdit={canEdit}
            onEdit={() => setEditing({ kind: "asset", asset, defaultKind: "liability" })}
          />
        ))}
      </Section>

      {/* ---- Paydays ---- */}
      <Section
        title="Paydays"
        count={data.paySchedules.length}
        note="Pay is every two weeks. Give one real payday and Headroom works out the rest. Everything on Upcoming and Pay plan depends on these."
        empty="No paydays yet. Most of the app needs these."
        isEmpty={data.paySchedules.length === 0}
        actions={
          data.members.some(
            (member) => !data.paySchedules.some((schedule) => schedule.userId === member.id),
          ) ? (
            <button
              className="hr-button"
              type="button"
              disabled={!canEdit}
              onClick={() => setEditing({ kind: "payday", payday: null })}
            >
              Add a payday
            </button>
          ) : null
        }
      >
        {data.paySchedules.map((schedule) => (
          <Row
            key={schedule.id}
            name={schedule.user?.name ?? "Someone"}
            note={`Every two weeks from ${formatDateShort(schedule.anchorDate)} · 26x a year`}
            amount={schedule.defaultCents}
            canEdit={canEdit}
            onEdit={() => setEditing({ kind: "payday", payday: schedule })}
            badge={schedule.user ? <InitialBubble person={schedule.user} /> : null}
          />
        ))}
      </Section>

      {/* ---- The account ---- */}
      <AccountsSection accounts={data.accounts} canEdit={canEdit} />

      {/* ---- Income ---- */}
      <IncomeSection setup={data} canEdit={canEdit} />

      {/* ---- Household settings ---- */}
      <SettingsSection setup={data} canEdit={canEdit} />

      {/* ---- The sheets ---- */}
      {editing?.kind === "bill" ? (
        <BillForm
          existing={editing.bill}
          members={data.members}
          paySchedules={data.paySchedules}
          defaultKind={editing.adding}
          onClose={close}
        />
      ) : null}

      {editing?.kind === "category" ? (
        <CategoryForm existing={editing.category} onClose={close} />
      ) : null}

      {editing?.kind === "goal" ? <GoalForm existing={editing.goal} onClose={close} /> : null}

      {editing?.kind === "asset" ? (
        <AssetForm existing={editing.asset} defaultKind={editing.defaultKind} onClose={close} />
      ) : null}

      {editing?.kind === "payday" ? (
        <PaydayForm
          existing={editing.payday}
          candidates={data.members.filter(
            (member) => !data.paySchedules.some((schedule) => schedule.userId === member.id),
          )}
          onClose={close}
        />
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The pieces every section is built from                                     */
/* -------------------------------------------------------------------------- */

/**
 * A card with a heading, a count, a list and the actions underneath.
 *
 * Shared so that every list on this screen is laid out and worded the same
 * way, and so adding a new manageable thing cannot accidentally ship without
 * an empty state or a count.
 */
function Section({
  title,
  count,
  note,
  empty,
  isEmpty,
  pending,
  actions,
  children,
}: {
  title: string;
  count?: number | undefined;
  note: string;
  empty: string;
  isEmpty: boolean;
  pending?: boolean;
  actions?: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="hr-card manage__section">
      <header className="manage__section-head">
        <h2 className="manage__section-title">{title}</h2>
        {count === undefined ? null : <span className="manage__count">{count}</span>}
      </header>
      <p className="manage__note">{note}</p>

      {pending ? (
        <p className="manage__empty">Loading…</p>
      ) : isEmpty ? (
        <p className="manage__empty">{empty}</p>
      ) : (
        <ul className="manage__list">{children}</ul>
      )}

      {actions ? <div className="manage__actions">{actions}</div> : null}
    </section>
  );
}

/** One editable row: what it is, what it costs, and a way in. */
function Row({
  name,
  note,
  amount,
  canEdit,
  onEdit,
  badge,
  extra,
}: {
  name: string;
  note: string | null;
  amount: bigint;
  canEdit: boolean;
  onEdit: () => void;
  badge?: React.ReactNode;
  extra?: React.ReactNode;
}): React.JSX.Element {
  return (
    <li className="manage__row">
      {badge}
      <span className="manage__row-main">
        <span className="manage__row-name">{name}</span>
        {note ? <span className="manage__row-note">{note}</span> : null}
      </span>
      <Amount cents={amount} />
      <span className="manage__row-buttons">
        {extra}
        <button
          className="manage__small"
          type="button"
          disabled={!canEdit}
          onClick={onEdit}
          aria-label={`Edit ${name}`}
        >
          Edit
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

/** A valuation is only as good as its date, so say when it was taken. */
function describeAsset(asset: AssetEntry): string | null {
  const parts: string[] = [];
  if (asset.asOf) parts.push(`As of ${formatDateShort(asset.asOf)}`);
  if (asset.note) parts.push(asset.note);
  return parts.length === 0 ? null : parts.join(" · ");
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
/* The chequing account                                                       */
/* -------------------------------------------------------------------------- */

function AccountsSection({
  accounts,
  canEdit,
}: {
  accounts: readonly AccountEntry[];
  canEdit: boolean;
}): React.JSX.Element {
  const patch = usePatchAccount();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const save = async (account: AccountEntry): Promise<void> => {
    setError(null);
    if (name.trim() === "") {
      setError("An account needs a name.");
      return;
    }
    try {
      await patch.mutateAsync({
        id: account.id,
        version: account.version,
        changes: { name: name.trim() },
      });
      setRenaming(null);
    } catch (caught) {
      if (caught instanceof OfflineError || caught instanceof ApiError) setError(caught.message);
      else setError("Could not rename it.");
    }
  };

  return (
    <section className="hr-card manage__section">
      <header className="manage__section-head">
        <h2 className="manage__section-title">The account</h2>
        <span className="manage__count">{accounts.length}</span>
      </header>
      <p className="manage__note">
        The chequing account the balance belongs to. Its name is the label on the Home screen.
      </p>

      {error ? (
        <p className="hr-alert manage__inline-alert" role="alert">
          {error}
        </p>
      ) : null}

      {accounts.length === 0 ? (
        <p className="manage__empty">No account yet.</p>
      ) : (
        <ul className="manage__list">
          {accounts.map((account) => (
            <li className="manage__row" key={account.id}>
              {renaming === account.id ? (
                <>
                  <span className="manage__row-main">
                    <input
                      className="hr-input"
                      type="text"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      disabled={patch.isPending}
                      aria-label="Account name"
                      maxLength={60}
                    />
                  </span>
                  <span className="manage__row-buttons">
                    <button
                      className="manage__small"
                      type="button"
                      disabled={patch.isPending}
                      onClick={() => void save(account)}
                    >
                      Save
                    </button>
                    <button
                      className="manage__small"
                      type="button"
                      disabled={patch.isPending}
                      onClick={() => setRenaming(null)}
                    >
                      Cancel
                    </button>
                  </span>
                </>
              ) : (
                <>
                  <span className="manage__row-main">
                    <span className="manage__row-name">{account.name}</span>
                  </span>
                  <span className="manage__row-buttons">
                    <button
                      className="manage__small"
                      type="button"
                      disabled={!canEdit}
                      onClick={() => {
                        setName(account.name);
                        setRenaming(account.id);
                      }}
                      aria-label={`Rename ${account.name}`}
                    >
                      Rename
                    </button>
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {accounts.length === 0 ? (
        <div className="manage__actions">
          <AddAccount />
        </div>
      ) : null}
    </section>
  );
}

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

/* -------------------------------------------------------------------------- */
/* Income                                                                     */
/* -------------------------------------------------------------------------- */

function IncomeSection({ setup, canEdit }: { setup: Setup; canEdit: boolean }): React.JSX.Element {
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
  setup: Setup;
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
