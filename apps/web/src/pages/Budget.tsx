/**
 * Budget (HANDOFF section 7.4) — page 2 of the household's spreadsheet.
 *
 * A Monthly/Yearly toggle, what is left after everything as the hero with a
 * stacked bar, then income, fixed expenses with share bars, and variable
 * expenses.
 *
 * The share bars show each line's share of **its own section**, which is what
 * the spreadsheet's "% of Total" column means.
 *
 * The spreadsheet's two pie charts were deliberately left out when this page
 * was built - HANDOFF section 4.3 says so, and bars really are easier to
 * compare on a phone. The household asked for the chart back on 2026-11-19,
 * having used both, so both are here now and each does the job it is good at:
 * the ring shows the shape of a section at a glance, the bars and figures
 * below it compare the lines exactly. The list is also the ring's legend, its
 * table view and the only control that can be reached from a keyboard.
 */
import { formatCents } from "@headroom/core";
import type { Cents } from "@headroom/core";
import { useMemo, useState } from "react";
import { BudgetDonut } from "../components/BudgetDonut.js";
import { Thumb } from "../components/Thumb.js";
import { ringFor, slotOf, type DonutDatum } from "../lib/donut.js";
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
    /** The line whose figures the middle of the ring is showing. */
    const [chosenId, setChosenId] = useState<string | null>(null);
    /** Which ring is open: null for the whole section, or the folded wedge. */
    const [drillId, setDrillId] = useState<string | null>(null);

    const keyOf = (line: BudgetLine): string => line.id ?? line.name;

    const donutData = useMemo<DonutDatum[]>(
      () =>
        section.lines.map((line) => ({
          id: keyOf(line),
          name: line.name,
          cents: amountOf(line),
        })),
      [section.lines, amountOf],
    );

    const slices = useMemo(() => ringFor(donutData, drillId), [donutData, drillId]);

    /*
     * While a folded wedge is open the list shows what is inside it, so it goes
     * on being the legend for the ring actually on screen rather than for one
     * that is no longer drawn.
     */
    const openIds =
      drillId === null
        ? null
        : new Set(
            ringFor(donutData, null)
              .find((slice) => slice.id === drillId)
              ?.members.map((member) => member.id) ?? [],
          );
    const listed =
      openIds === null ? section.lines : section.lines.filter((line) => openIds.has(keyOf(line)));

    return (
      <section className="hr-card budget__section">
        <header className="budget__section-head">
          <h2 className="budget__section-title">{title}</h2>
          <span className="hr-amount budget__section-total">{formatCents(total)}</span>
        </header>
        <p className="budget__note">{note}</p>

        {/*
          The dock is what keeps the ring on screen while the list under it
          scrolls - see `.budget__chart-dock`. It is a wrapper rather than the
          chart itself because the chart is also the thing that lifts a wedge
          out past its own box, and a sticky element with a background has to
          be the opaque rectangle, not the drawing inside it.
        */}
        <div className="budget__chart-dock">
          <BudgetDonut
            title={title}
            data={donutData}
            total={total}
            selectedId={chosenId}
            onSelect={setChosenId}
            drillId={drillId}
            onDrill={setDrillId}
          />
        </div>

        {section.lines.length === 0 ? (
          <p className="budget__empty">Nothing entered yet.</p>
        ) : (
          <ul className="budget__lines">
            {listed.map((line) => {
              const id = keyOf(line);
              const slot = slotOf(slices, id);
              const chosen = chosenId === id;

              return (
                <li className="budget__line" key={id}>
                  {/*
                    A real button, and the reason the wedges do not have to be
                    one: a 1.6% wedge is a few pixels of arc, and this is the
                    full width of the card. It carries the wedge's colour, so
                    the list is the ring's legend as well as its figures.
                  */}
                  <button
                    type="button"
                    className={`budget__line-button${chosen ? " budget__line-button--chosen" : ""}`}
                    aria-pressed={chosen}
                    onClick={() => setChosenId(chosen ? null : id)}
                  >
                    {/*
                      Beside the name rather than before the whole row: the
                      name takes a column of its own and the amounts line up
                      down the right-hand edge, which is how this page is read.
                    */}
                    <span className="budget__line-name">
                      {slot === null ? null : (
                        <span
                          className="budget__line-swatch"
                          style={{ background: `var(--hr-series-${slot + 1})` }}
                          aria-hidden="true"
                        />
                      )}
                      <Thumb imageId={line.imageId} size="line" fallback={line.name} />
                      {line.name}
                      {/* Where a stated monthly figure is being used instead of
                          the one worked out from the bill's cadence, say so,
                          rather than leaving a number nobody can reconcile. */}
                      {line.overridden && line.derivedMonthlyCents !== null ? (
                        <span className="budget__line-note">
                          set by hand · worked out as {formatCents(line.derivedMonthlyCents)}
                        </span>
                      ) : line.source === "bill" ? (
                        <span className="budget__line-note">from a recurring bill</span>
                      ) : null}
                    </span>
                    <span className="budget__line-amount hr-amount">
                      {formatCents(amountOf(line))}
                    </span>

                    {/* Share of this section - the sheet's "% of Total". */}
                    <span className="budget__line-share">
                      <span className="budget__share-track" aria-hidden="true">
                        <span
                          className="budget__share-fill"
                          style={{ width: `${line.sharePct}%` }}
                        />
                      </span>
                      <span className="budget__share-pct">{line.sharePct}%</span>
                    </span>
                  </button>
                </li>
              );
            })}
        </ul>
      )}
    </section>
  );
}
