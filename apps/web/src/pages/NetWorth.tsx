/**
 * Net worth and retirement (HANDOFF section 7.6).
 *
 * What the household owns, what it owes, and the retirement outlook built from
 * Carol's own formula: the RRSPs plus the mortgage payment redirected for a
 * fixed number of years, grown once by a flat percentage, then divided across
 * the years in retirement.
 *
 * Every assumption is editable (section 4.5 — "All retirement inputs must be
 * editable settings, not constants"), including an option to compound the
 * growth yearly instead, which is off by default because her sheet applies it
 * once (section 14 q3).
 */
import { formatCents, parseCents } from "@headroom/core";
import { useState } from "react";
import { Link } from "react-router";
import { AssetForm } from "../components/AssetForm.js";
import { Amount } from "../components/Badges.js";
import { ApiError, OfflineError } from "../lib/api.js";
import {
  useNetWorth,
  useSaveRetirement,
  type AssetEntry,
  type RetirementInputs,
} from "../lib/plannerQueries.js";
import "./NetWorth.css";

export function NetWorth({ canEdit }: { canEdit: boolean }): React.JSX.Element {
  const netWorth = useNetWorth();
  const [editing, setEditing] = useState(false);
  /** The asset sheet: an entry to change, or null to add a new one. */
  const [asset, setAsset] = useState<{
    asset: AssetEntry | null;
    defaultKind: "asset" | "liability";
  } | null>(null);

  if (netWorth.isPending) {
    return (
      <div className="networth" aria-busy="true">
        <p className="hr-visually-hidden">Loading net worth</p>
      </div>
    );
  }

  if (netWorth.isError || !netWorth.data) {
    return (
      <div className="networth">
        <div className="hr-card networth__error">
          <h2>Could not load net worth</h2>
          <p>The server did not answer. Nothing has been changed; reload to try again.</p>
        </div>
      </div>
    );
  }

  const data = netWorth.data;
  const retirement = data.retirement;

  return (
    <div className="networth">
      <Link className="networth__back" to="/goals">
        ← Goals
      </Link>

      {/* ---- Net worth ---- */}
      <section className="networth__hero">
        <p className="networth__hero-label">Net worth</p>
        <p className="networth__hero-amount hr-amount">{formatCents(data.netWorthCents)}</p>
        <p className="networth__hero-note">
          {formatCents(data.assetsCents)} owned, less {formatCents(data.liabilitiesCents)} owed.
        </p>
      </section>

      <div className="networth__columns">
        <AssetList
          title="What you own"
          entries={data.assets}
          total={data.assetsCents}
          kind="asset"
          canEdit={canEdit}
          onEdit={(asset) => setAsset({ asset, defaultKind: "asset" })}
          onAdd={() => setAsset({ asset: null, defaultKind: "asset" })}
        />
        <AssetList
          title="What you owe"
          entries={data.liabilities}
          total={data.liabilitiesCents}
          kind="liability"
          canEdit={canEdit}
          onEdit={(asset) => setAsset({ asset, defaultKind: "liability" })}
          onAdd={() => setAsset({ asset: null, defaultKind: "liability" })}
        />
      </div>

      {/* ---- Retirement ---- */}
      {retirement ? (
        <>
          <section className="hr-card networth__section">
            <h2 className="networth__section-title">RRSPs by 65</h2>

            <dl className="networth__breakdown">
              <div>
                <dt>RRSPs now, plus contributions still to come</dt>
                <dd className="hr-amount">
                  {formatCents(retirement.inputs.rrspCurrentPlusContribCents)}
                </dd>
              </div>
              <div>
                <dt>
                  Mortgage payment redirected for {retirement.inputs.redirectYears} years after it
                  is paid off
                </dt>
                <dd className="hr-amount">{formatCents(retirement.mortgageRedirectCents)}</dd>
              </div>
              <div className="networth__breakdown-sub">
                <dt>Before growth</dt>
                <dd className="hr-amount">{formatCents(retirement.baseBeforeGrowthCents)}</dd>
              </div>
              <div>
                <dt>
                  Growth at {retirement.inputs.flatGrowthPct}%
                  {retirement.inputs.compoundYearly ? ", compounded yearly" : ", applied once"}
                </dt>
                <dd className="hr-amount">{formatCents(retirement.growthCents)}</dd>
              </div>
              <div className="networth__breakdown-total">
                <dt>RRSPs at 65</dt>
                <dd className="hr-amount">{formatCents(retirement.rrspAt65Cents)}</dd>
              </div>
            </dl>
          </section>

          <section className="hr-card networth__section">
            <h2 className="networth__section-title">Each year in retirement</h2>

            <dl className="networth__breakdown">
              <div>
                <dt>From the RRSPs, over {retirement.inputs.drawdownYears} years</dt>
                <dd className="hr-amount">{formatCents(retirement.annualDrawCents)}</dd>
              </div>
              <div>
                <dt>Government pension</dt>
                <dd className="hr-amount">
                  {formatCents(retirement.inputs.govPensionAnnualCents)}
                </dd>
              </div>
              <div>
                <dt>Less expenses</dt>
                <dd className="hr-amount">
                  {formatCents(-retirement.inputs.retirementExpensesAnnualCents)}
                </dd>
              </div>
              <div className="networth__breakdown-total">
                <dt>Extra per year</dt>
                <dd className="hr-amount">{formatCents(retirement.extraPerYearCents)}</dd>
              </div>
            </dl>
          </section>

          <section className="networth__result">
            <p className="networth__result-label">Extra per month in retirement</p>
            <p className="networth__result-amount hr-amount">
              {formatCents(retirement.extraPerMonthCents)}
            </p>
            <p className="networth__result-note">
              Total for retirement, net worth plus the RRSPs at 65:{" "}
              <strong>{formatCents(retirement.totalForRetirementCents)}</strong>
            </p>
          </section>
        </>
      ) : (
        <section className="hr-card networth__section">
          <h2 className="networth__section-title">Retirement</h2>
          <p className="networth__note">
            The outlook needs a few assumptions before it can be worked out.
          </p>
        </section>
      )}

      <button
        className="hr-button hr-button--secondary networth__edit"
        type="button"
        disabled={!canEdit}
        onClick={() => setEditing(true)}
      >
        {retirement ? "Edit assumptions" : "Set the assumptions"}
      </button>

      {editing ? (
        <AssumptionsForm
          current={retirement?.inputs ?? null}
          onClose={() => setEditing(false)}
        />
      ) : null}

      {asset ? (
        <AssetForm
          existing={asset.asset}
          defaultKind={asset.defaultKind}
          onClose={() => setAsset(null)}
        />
      ) : null}
    </div>
  );
}

function AssetList({
  title,
  entries,
  total,
  kind,
  canEdit,
  onEdit,
  onAdd,
}: {
  title: string;
  entries: readonly AssetEntry[];
  total: bigint;
  kind: "asset" | "liability";
  canEdit: boolean;
  onEdit: (entry: AssetEntry) => void;
  onAdd: () => void;
}): React.JSX.Element {
  return (
    <section className="hr-card networth__section">
      <header className="networth__section-head">
        <h2 className="networth__section-title">{title}</h2>
        <Amount cents={total} className="networth__section-total" />
      </header>

      {entries.length === 0 ? (
        <p className="networth__empty">Nothing entered yet.</p>
      ) : (
        <ul className="networth__entries">
          {entries.map((entry) => (
            <li className="networth__entry" key={entry.id}>
              <span className="networth__entry-main">
                <span className="networth__entry-name">{entry.name}</span>
                {entry.asOf || entry.note ? (
                  <span className="networth__entry-note">
                    {[entry.note, entry.asOf ? `as of ${entry.asOf}` : null]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                ) : null}
              </span>
              <span className="hr-amount networth__entry-amount">{formatCents(entry.cents)}</span>
              <button
                className="networth__entry-edit"
                type="button"
                disabled={!canEdit}
                onClick={() => onEdit(entry)}
                aria-label={`Edit ${entry.name}`}
              >
                Edit
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="networth__actions">
        <button
          className="hr-button hr-button--secondary"
          type="button"
          disabled={!canEdit}
          onClick={onAdd}
        >
          {kind === "liability" ? "Add something owed" : "Add something owned"}
        </button>
      </div>
    </section>
  );
}

/** The fields, and how each maps onto the API's integer-cents wire format. */
const MONEY_FIELDS = [
  {
    key: "rrspCurrentPlusContribCents",
    label: "RRSPs now, plus contributions still to come",
    hint: "An input, not something Headroom works out.",
  },
  { key: "mortgageMonthlyCents", label: "Mortgage payment, per month", hint: "" },
  { key: "govPensionAnnualCents", label: "Government pension, per year", hint: "" },
  { key: "retirementExpensesAnnualCents", label: "Expenses in retirement, per year", hint: "" },
] as const;

const NUMBER_FIELDS = [
  { key: "redirectYears", label: "Years the mortgage payment is redirected", min: 0, max: 60 },
  { key: "flatGrowthPct", label: "Growth rate, %", min: -100, max: 1000 },
  { key: "drawdownYears", label: "Years in retirement to spread it over", min: 1, max: 60 },
] as const;

function AssumptionsForm({
  current,
  onClose,
}: {
  current: RetirementInputs | null;
  onClose: () => void;
}): React.JSX.Element {
  const save = useSaveRetirement();
  const [error, setError] = useState<string | null>(null);

  // Money starts as a human-readable amount; it is converted to integer cents
  // only on submit, which is the one place that conversion belongs.
  const [money, setMoney] = useState<Record<string, string>>(() => ({
    rrspCurrentPlusContribCents: current
      ? formatCents(current.rrspCurrentPlusContribCents, { currencySymbol: false, grouping: false })
      : "",
    mortgageMonthlyCents: current
      ? formatCents(current.mortgageMonthlyCents, { currencySymbol: false, grouping: false })
      : "",
    govPensionAnnualCents: current
      ? formatCents(current.govPensionAnnualCents, { currencySymbol: false, grouping: false })
      : "",
    retirementExpensesAnnualCents: current
      ? formatCents(current.retirementExpensesAnnualCents, { currencySymbol: false, grouping: false })
      : "",
  }));

  const [numbers, setNumbers] = useState<Record<string, string>>(() => ({
    redirectYears: String(current?.redirectYears ?? 16),
    flatGrowthPct: String(current?.flatGrowthPct ?? 10),
    drawdownYears: String(current?.drawdownYears ?? 25),
  }));

  const [compoundYearly, setCompoundYearly] = useState(current?.compoundYearly ?? false);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);

    const values: Record<string, string | number | boolean> = { compoundYearly };

    for (const field of MONEY_FIELDS) {
      const text = money[field.key] ?? "";
      try {
        values[field.key] = parseCents(text === "" ? "0" : text).toString();
      } catch {
        setError(`"${field.label}" is not an amount.`);
        return;
      }
    }

    for (const field of NUMBER_FIELDS) {
      const text = numbers[field.key] ?? "";
      const parsed = Number(text);
      if (!Number.isInteger(parsed) || parsed < field.min || parsed > field.max) {
        setError(`"${field.label}" must be a whole number between ${field.min} and ${field.max}.`);
        return;
      }
      values[field.key] = parsed;
    }

    try {
      await save.mutateAsync({ values, version: current?.version ?? null });
      onClose();
    } catch (caught) {
      if (caught instanceof OfflineError || caught instanceof ApiError) setError(caught.message);
      else setError("Those assumptions did not save. Please try again.");
    }
  };

  return (
    <div className="sheet-backdrop" onClick={onClose} role="presentation">
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Retirement assumptions"
        onClick={(event) => event.stopPropagation()}
      >
        <form onSubmit={(event) => void submit(event)}>
          <h2 className="sheet__title">Retirement assumptions</h2>
          <p className="sheet__intro">
            These are Carol's figures and her method. Change any of them and the outlook
            recalculates.
          </p>

          {error ? (
            <p className="hr-alert sheet__error" role="alert">
              {error}
            </p>
          ) : null}

          {MONEY_FIELDS.map((field) => (
            <div className="hr-field networth__field" key={field.key}>
              <label className="hr-label" htmlFor={field.key}>
                {field.label}
              </label>
              <input
                className="hr-input"
                id={field.key}
                type="text"
                inputMode="decimal"
                autoComplete="off"
                placeholder="0.00"
                value={money[field.key] ?? ""}
                onChange={(event) =>
                  setMoney((previous) => ({ ...previous, [field.key]: event.target.value }))
                }
                disabled={save.isPending}
              />
              {field.hint ? <p className="networth__field-hint">{field.hint}</p> : null}
            </div>
          ))}

          {NUMBER_FIELDS.map((field) => (
            <div className="hr-field networth__field" key={field.key}>
              <label className="hr-label" htmlFor={field.key}>
                {field.label}
              </label>
              <input
                className="hr-input"
                id={field.key}
                type="number"
                inputMode="numeric"
                min={field.min}
                max={field.max}
                step={1}
                value={numbers[field.key] ?? ""}
                onChange={(event) =>
                  setNumbers((previous) => ({ ...previous, [field.key]: event.target.value }))
                }
                disabled={save.isPending}
              />
            </div>
          ))}

          <label className="networth__checkbox">
            <input
              type="checkbox"
              checked={compoundYearly}
              onChange={(event) => setCompoundYearly(event.target.checked)}
              disabled={save.isPending}
            />
            <span>
              Compound the growth every year
              <span className="networth__field-hint">
                Off by default, because the spreadsheet applies the rate once to the total.
              </span>
            </span>
          </label>

          <div className="sheet__actions">
            <button
              className="hr-button hr-button--secondary"
              type="button"
              onClick={onClose}
              disabled={save.isPending}
            >
              Cancel
            </button>
            <button className="hr-button" type="submit" disabled={save.isPending}>
              {save.isPending ? "Saving…" : "Save assumptions"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
