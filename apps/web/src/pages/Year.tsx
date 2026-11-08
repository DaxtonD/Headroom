/**
 * The year ahead: which months are unusual, and by how much.
 *
 * This screen exists because of something the spec got wrong. It said, in three
 * places, that a month with a third paycheque "needs no special handling" -
 * true of the arithmetic and false of the decision. The running balance absorbs
 * a third cheque silently and correctly, which is exactly why nobody can see
 * one coming, and finding those months is the household's whole monthly ritual.
 *
 * It answers two questions a ledger cannot:
 *
 *  - Which month has an extra paycheque, so more can go to savings?
 *  - Which month has an extra mortgage payment, so something has to move?
 *
 * They are not the same months. The mortgage comes out the day after a payday,
 * and that single day lets a third payment slip across a month boundary, so a
 * windfall month can sit directly beside a squeeze month for no reason anyone
 * would guess from a calendar.
 *
 * Nothing here needs an amount entered or a bill verified, only the pay
 * schedules, so it stays honest a year out - unlike the ledger, which becomes
 * guesswork past a few weeks.
 */
import { formatCents, formatDayAndMonth } from "@headroom/core";
import { useYear, type YearMonth } from "../lib/plannerQueries.js";
import "./Year.css";

/** What a month is, at a glance. */
type Flavour = "normal" | "windfall" | "squeeze" | "mixed";

function flavourOf(month: YearMonth): Flavour {
  if (!month.isUnusual) return "normal";
  if (month.netExtraCents > 0n) return "windfall";
  if (month.netExtraCents < 0n) return "squeeze";
  // Unusual, but the extras cancel out: an extra cheque and an extra payment
  // of the same size. Worth showing, because the weeks inside it still move.
  return "mixed";
}

const FLAVOUR_LABEL: Record<Flavour, string> = {
  normal: "Normal",
  windfall: "Extra coming in",
  squeeze: "Extra going out",
  mixed: "Extra both ways",
};

export function Year(): React.JSX.Element {
  const year = useYear();

  if (year.isPending) {
    return (
      <div className="year" aria-busy="true">
        <p className="hr-visually-hidden">Loading the year ahead</p>
      </div>
    );
  }

  if (year.isError || !year.data) {
    return (
      <div className="year">
        <div className="hr-card year__error">
          <h2>Could not load the year</h2>
          <p>The server did not answer. Nothing has been changed; reload to try again.</p>
        </div>
      </div>
    );
  }

  const data = year.data;
  const unusual = data.months.filter((month) => month.isUnusual);

  if (data.months.every((month) => month.entries.length === 0)) {
    return (
      <div className="year">
        <div className="hr-card year__error">
          <h2>Nothing to show yet</h2>
          <p>
            Add a payday on the Manage screen and this fills in. It works out which months hold a
            third paycheque or a third mortgage payment, from the schedules alone.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="year">
      <section className="hr-card year__intro">
        <h2 className="year__intro-title">The next {data.monthCount} months</h2>
        <p className="year__intro-note">
          Pay comes every two weeks, so most months hold two of everything — but{" "}
          <strong>{unusual.length === 1 ? "one month" : `${unusual.length} months`}</strong> below
          {unusual.length === 1 ? " holds" : " hold"} a third of something.
          {data.hasMortgage ? (
            <>
              {" "}
              The mortgage comes out the day after a payday, so an extra paycheque and an extra
              mortgage payment do not always fall in the same month.
            </>
          ) : null}
        </p>
      </section>

      {/* ---- Just the months worth looking at ---- */}
      {unusual.length > 0 ? (
        <section className="hr-card year__section">
          <h2 className="year__section-title">Worth planning for</h2>
          <ul className="year__highlights">
            {unusual.map((month) => (
              <li className={`year__highlight year__highlight--${flavourOf(month)}`} key={month.label}>
                <div className="year__highlight-head">
                  <span className="year__highlight-month">{month.label}</span>
                  <span className="year__highlight-amount hr-amount">
                    {month.netExtraCents === 0n
                      ? "evens out"
                      : formatCents(month.netExtraCents, { alwaysSign: true })}
                  </span>
                </div>
                <p className="year__highlight-why">
                  {month.entries
                    .filter((entry) => entry.extraCount !== 0)
                    .map((entry) =>
                      entry.extraCount > 0
                        ? `a third ${entry.name.toLowerCase()}`
                        : `one fewer ${entry.name.toLowerCase()}`,
                    )
                    .join(", ")}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* ---- Every month, one row each ---- */}
      <section className="hr-card year__section">
        <h2 className="year__section-title">Month by month</h2>
        <ul className="year__months">
          {data.months.map((month) => {
            const flavour = flavourOf(month);
            return (
              <li className={`year__month year__month--${flavour}`} key={month.label}>
                <div className="year__month-main">
                  <span className="year__month-label">{month.label}</span>
                  <span className="year__month-flavour">{FLAVOUR_LABEL[flavour]}</span>
                </div>

                <ul className="year__counts">
                  {month.entries.map((entry) => (
                    <li
                      className={`year__count${entry.extraCount !== 0 ? " year__count--odd" : ""}`}
                      key={entry.id}
                    >
                      <span className="year__count-name">{entry.name}</span>
                      <span className="year__count-value">
                        {entry.count}
                        {entry.extraCount !== 0 ? (
                          <span className="year__count-dates">
                            {" "}
                            ({entry.dates.map((date) => formatDayAndMonth(date)).join(", ")})
                          </span>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>

                {month.netExtraCents !== 0n ? (
                  <p className="year__month-effect hr-amount">
                    {formatCents(month.netExtraCents, { alwaysSign: true })} against a normal month
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
