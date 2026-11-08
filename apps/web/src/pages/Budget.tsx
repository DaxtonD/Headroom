/**
 * Budget (HANDOFF section 7.4) — page 2 of Carol's spreadsheet.
 *
 * A Monthly/Yearly toggle, what is left after everything as the hero with a
 * stacked bar, then income, fixed expenses with share bars, and variable
 * expenses.
 *
 * The share bars show each line's share of **its own section**, which is what
 * her "% of Total" column means. Her two pie charts become bars here: on a
 * phone, bars are far easier to compare than slices.
 */
import { formatCents } from "@headroom/core";
import type { Cents } from "@headroom/core";
import { useState } from "react";
import { useBudget, type BudgetLine, type BudgetSection } from "../lib/plannerQueries.js";
import "./Budget.css";

type View = "monthly" | "yearly";

export function Budget(): React.JSX.Element {
  const budget = useBudget();
  const [view, setView] = useState<View>("monthly");

  if (budget.isPending) {
    return (
      <div className="budget" aria-busy="true">
        <p className="hr-visually-hidden">Loading the budget</p>
      </div>
    );
  }

  if (budget.isError || !budget.data) {
    return (
      <div className="budget">
        <div className="hr-card budget__error">
          <h2>Could not load the budget</h2>
          <p>The server did not answer. Nothing has been changed; reload to try again.</p>
        </div>
      </div>
    );
  }

  const data = budget.data;
  const monthly = view === "monthly";

  const income = monthly ? data.income.netMonthlyCents : data.income.netYearlyCents;
  const fixed = monthly ? data.fixed.monthlyCents : data.fixed.yearlyCents;
  const variable = monthly ? data.variable.monthlyCents : data.variable.yearlyCents;
  const left = monthly ? data.balanceMonthlyCents : data.balanceYearlyCents;

  const amountOf = (line: BudgetLine): Cents => (monthly ? line.monthlyCents : line.yearlyCents);

  // Widths for the stacked bar. Guarded against a zero income so the bar
  // simply does not render rather than dividing by nothing.
  const share = (part: Cents): number =>
    income > 0n ? Math.max(0, Number((part * 1000n) / income) / 10) : 0;

  return (
    <div className="budget">
      <div className="budget__toggle" role="group" aria-label="Show monthly or yearly figures">
        {(["monthly", "yearly"] as const).map((option) => (
          <button
            key={option}
            className={`budget__toggle-button ${view === option ? "budget__toggle-button--active" : ""}`}
            type="button"
            aria-pressed={view === option}
            onClick={() => setView(option)}
          >
            {option === "monthly" ? "Monthly" : "Yearly"}
          </button>
        ))}
      </div>

      {/* ---- What is left after everything ---- */}
      <section className="budget__hero">
        <p className="budget__hero-label">
          Left after everything, {monthly ? "each month" : "each year"}
        </p>
        <p className="budget__hero-amount hr-amount">{formatCents(left)}</p>

        {income > 0n ? (
          <>
            <div
              className="budget__bar"
              role="img"
              aria-label={`Of ${formatCents(income)} coming in, ${formatCents(fixed)} is fixed, ${formatCents(variable)} is variable, and ${formatCents(left)} is left.`}
            >
              <span
                className="budget__bar-part budget__bar-part--fixed"
                style={{ width: `${share(fixed)}%` }}
              />
              <span
                className="budget__bar-part budget__bar-part--variable"
                style={{ width: `${share(variable)}%` }}
              />
              <span
                className="budget__bar-part budget__bar-part--left"
                style={{ width: `${share(left > 0n ? left : 0n)}%` }}
              />
            </div>

            <ul className="budget__legend">
              <li>
                <span className="budget__swatch budget__swatch--fixed" aria-hidden="true" />
                Fixed {formatCents(fixed)}
              </li>
              <li>
                <span className="budget__swatch budget__swatch--variable" aria-hidden="true" />
                Variable {formatCents(variable)}
              </li>
              <li>
                <span className="budget__swatch budget__swatch--left" aria-hidden="true" />
                Left {formatCents(left)}
              </li>
            </ul>
          </>
        ) : (
          <p className="budget__hero-note">
            Set the household's net income to see how it divides up.
          </p>
        )}
      </section>

      {/* ---- Income ---- */}
      <section className="hr-card budget__section">
        <header className="budget__section-head">
          <h2 className="budget__section-title">Income</h2>
          <span className="hr-amount budget__section-total">{formatCents(income)}</span>
        </header>
        <p className="budget__note">
          {monthly
            ? "Net, after tax and pension."
            : "Net for the year, as entered. It is not exactly the monthly figure times twelve, which is deliberate."}
        </p>
      </section>

      <ExpenseSection
        title="Fixed expenses"
        note="The bills that are the same every month."
        section={data.fixed}
        total={fixed}
        amountOf={amountOf}
      />

      <ExpenseSection
        title="Variable expenses"
        note="What the household chooses to spend."
        section={data.variable}
        total={variable}
        amountOf={amountOf}
      />
    </div>
  );
}

function ExpenseSection({
  title,
  note,
  section,
  total,
  amountOf,
}: {
  title: string;
  note: string;
  section: BudgetSection;
  total: Cents;
  amountOf: (line: BudgetLine) => Cents;
}): React.JSX.Element {
  return (
    <section className="hr-card budget__section">
      <header className="budget__section-head">
        <h2 className="budget__section-title">{title}</h2>
        <span className="hr-amount budget__section-total">{formatCents(total)}</span>
      </header>
      <p className="budget__note">{note}</p>

      {section.lines.length === 0 ? (
        <p className="budget__empty">Nothing entered yet.</p>
      ) : (
        <ul className="budget__lines">
          {section.lines.map((line) => (
            <li className="budget__line" key={line.id ?? line.name}>
              <span className="budget__line-name">
                {line.name}
                {/* Where a stated monthly figure is being used instead of the
                    one worked out from the bill's cadence, say so, rather than
                    leaving a number nobody can reconcile. */}
                {line.overridden && line.derivedMonthlyCents !== null ? (
                  <span className="budget__line-note">
                    set by hand · worked out as {formatCents(line.derivedMonthlyCents)}
                  </span>
                ) : line.source === "bill" ? (
                  <span className="budget__line-note">from a recurring bill</span>
                ) : null}
              </span>
              <span className="budget__line-amount hr-amount">{formatCents(amountOf(line))}</span>

              {/* Share of this section, which is what her "% of Total" means. */}
              <span className="budget__line-share">
                <span className="budget__share-track" aria-hidden="true">
                  <span className="budget__share-fill" style={{ width: `${line.sharePct}%` }} />
                </span>
                <span className="budget__share-pct">{line.sharePct}%</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
