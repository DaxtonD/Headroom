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
 * ## The four things added on 2026-11-20
 *
 * Asked for after the household had been living with the screen: "can you
 * think of some more genius ideas to put there? Really intelligent stuff that
 * adapts to the data given to the app."
 *
 *  1. **What pays for what.** The windfalls and the squeezes were listed side
 *     by side and left to be matched up by eye. They are matched here instead,
 *     earliest cheque first - and the pairing where the squeeze lands FIRST is
 *     called out, because that is the one a list of good and bad months can
 *     never show you: the year works out and you are still short in March.
 *  2. **What to put aside** for the bills that do not come every month, with
 *     the honest figure rather than the twelfth that leaves you short.
 *  3. **Those bills themselves**, on the calendar, since a fortnight of ledger
 *     cannot see an annual policy coming.
 *  4. **Where the balance ends each month**, and the month it ends lowest.
 *
 * The first three need no amount verified and no bill entered twice; they are
 * read off the schedules and the stated amounts, so they are as true in
 * fourteen months as tomorrow. The fourth is a projection and says so on the
 * screen, in those words.
 */
import { formatCents, formatDayAndMonth, formatDayMonthAndYear } from "@headroom/core";
import { useYear, type YearMonth, type YearOverview } from "../lib/plannerQueries.js";
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

      <WhatPaysForWhat data={data} />
      <PutAside data={data} />

      {/* ---- Every month, one row each ---- */}
      <section className="hr-card year__section">
        <h2 className="year__section-title">Month by month</h2>
        <Projection data={data} />

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

                {/*
                  The bills that skip months, on the month they land in. A
                  fortnight of ledger cannot see one of these coming, which is
                  the whole reason they are repeated here beside the cheque
                  counts rather than only in the section above.
                */}
                {month.lumps.length > 0 ? (
                  <ul className="year__month-lumps">
                    {month.lumps.map((lump) => (
                      <li className="year__month-lump" key={`${lump.name}-${lump.date}`}>
                        <span className="year__month-lump-name">
                          {formatDayAndMonth(lump.date)} · {lump.name}
                        </span>
                        <span className="year__month-lump-amount hr-amount">
                          {formatCents(-lump.cents)}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}

                {data.hasBalance && month.endBalanceCents !== null ? (
                  <p
                    className={`year__month-balance${
                      month.endBalanceCents < 0n ? " year__month-balance--under" : ""
                    }${month.start === data.lowestStart ? " year__month-balance--lowest" : ""}`}
                  >
                    Ends at{" "}
                    <span className="hr-amount">{formatCents(month.endBalanceCents)}</span>
                    {month.start === data.lowestStart ? " — the lowest of the year" : ""}
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

/* -------------------------------------------------------------------------- */
/* Which windfall pays for which squeeze                                      */
/* -------------------------------------------------------------------------- */

/**
 * The matching, in words.
 *
 * The cheque calendar can say "March is good" and "November is bad". It
 * cannot say that March is what pays for November, and it certainly cannot
 * say that August's extra payment has to be found three months before the
 * cheque that covers it arrives. Both are the same arithmetic done once more,
 * and both are the sentence somebody would otherwise work out on paper.
 */
function WhatPaysForWhat({ data }: { data: YearOverview }): React.JSX.Element | null {
  if (data.pairs.length === 0 && data.uncoveredCents === 0n) return null;

  const early = data.pairs.filter((pair) => pair.squeezeFirst);

  return (
    <section className="hr-card year__section">
      <h2 className="year__section-title">What pays for what</h2>
      <p className="year__section-note">
        Each extra payment matched to the extra paycheque that covers it, earliest first — which
        is the order the money would actually be spent in.
      </p>

      <ul className="year__pairs">
        {data.pairs.map((pair) => (
          <li
            className={`year__pair${pair.squeezeFirst ? " year__pair--early" : ""}`}
            key={`${pair.windfallStart}-${pair.squeezeStart}`}
          >
            <p className="year__pair-line">
              {/*
                The whole sentence in ONE span, which is the entire point of
                the wrapper. Without it the flex container took each of these
                as a separate item and `space-between` spread them into
                columns: "Dec 2026" | "'s extra cheque covers" | "Oct 2027",
                each wrapping on its own. Reported from use as text that
                looked clipped - nothing was missing, it had been laid out as
                four things rather than one.
              */}
              <span className="year__pair-text">
                <strong>{pair.windfallLabel}</strong>&rsquo;s extra cheque covers{" "}
                <strong>{pair.squeezeLabel}</strong>
              </span>
              <span className="year__pair-amount hr-amount">{formatCents(pair.coveredCents)}</span>
            </p>
            {pair.squeezeFirst ? (
              <p className="year__pair-warn">
                {pair.squeezeLabel} comes first, so this has to be found before the cheque
                arrives.
              </p>
            ) : null}
          </li>
        ))}
      </ul>

      {data.uncoveredCents > 0n ? (
        <p className="year__pair-short" role="status">
          <strong>{formatCents(data.uncoveredCents)}</strong> of extra payments has no extra
          paycheque anywhere in the next {data.monthCount} months to answer it.
        </p>
      ) : null}

      {data.spareCents > 0n ? (
        <p className="year__pair-spare">
          <strong>{formatCents(data.spareCents)}</strong> of extra pay is left once every extra
          payment is covered — that is the part that can go to savings.
        </p>
      ) : null}

      {early.length > 0 ? (
        <p className="year__pair-note">
          {early.length === 1 ? "One pairing has" : `${early.length} pairings have`} the payment
          landing before the cheque. The year balances; those months still do not.
        </p>
      ) : null}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* What to put aside                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The set-aside figure, and the bills it is for.
 *
 * Two figures are computed and only one is the headline. The even share -
 * total divided by months - is the one anybody would work out, and it is
 * right only if the bills happen to fall evenly through the year. They do
 * not: a policy renewing in March needs its money by March, and a twelfth a
 * month does not have it. So the headline is the smallest amount that is
 * never short on any date a bill actually falls, and the even share appears
 * underneath it only when the two disagree, where it explains the gap.
 */
function PutAside({ data }: { data: YearOverview }): React.JSX.Element | null {
  const { setAside } = data;
  if (setAside.billCount === 0) return null;

  const bills = data.months.flatMap((month) =>
    month.lumps.map((lump) => ({ lump, monthStart: month.start })),
  );

  return (
    <section className="hr-card year__section">
      <h2 className="year__section-title">Put aside each month</h2>

      <p className="year__aside-figure hr-amount">{formatCents(setAside.levelCents)}</p>
      <p className="year__aside-why">
        covers{" "}
        {setAside.billCount === 1 ? "the one bill" : `all ${setAside.billCount} bills`} below that
        do not come every month — {formatCents(setAside.totalCents)} over the next{" "}
        {setAside.monthCount} months.
      </p>

      {setAside.bindingLabel !== null ? (
        <p className="year__aside-note">
          Not {formatCents(setAside.evenCents)}, which is what the total divided by{" "}
          {setAside.monthCount} comes to. <strong>{setAside.bindingLabel}</strong> needs its money
          before an even share would have saved it, so that is the month setting this figure.
        </p>
      ) : (
        <p className="year__aside-note">
          Which is also the even share, because these are spread through the year well enough that
          saving a twelfth at a time is always in time.
        </p>
      )}

      <ul className="year__lumps">
        {bills.map(({ lump, monthStart }) => (
          <li className="year__lump" key={`${monthStart}-${lump.name}-${lump.date}`}>
            <span className="year__lump-main">
              <span className="year__lump-name">{lump.name}</span>
              <span className="year__lump-when">
                {formatDayMonthAndYear(lump.date)} · {lump.cadence === "yearly" ? "once a year" : "every three months"}
              </span>
            </span>
            <span className="year__lump-amount hr-amount">{formatCents(-lump.cents)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Where the balance ends up                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The note above the month list, saying how much of it to believe.
 *
 * Everything else on this screen is read off the schedules and is as true in
 * fourteen months as tomorrow. The end-of-month balances are not: past the
 * ledger's own horizon they assume every bill costs what it costs today and
 * that nothing at all is bought in between, which is false the moment anybody
 * buys groceries. Saying so is not a disclaimer, it is the difference between
 * a figure that can be acted on and one that cannot - and the SHAPE is still
 * right even where the level is not, which is why it is worth showing.
 */
function Projection({ data }: { data: YearOverview }): React.JSX.Element | null {
  if (!data.hasBalance) return null;

  const lowest = data.months.find((month) => month.start === data.lowestStart);

  return (
    <>
      {lowest && lowest.endBalanceCents !== null ? (
        <p
          className={`year__lowest${lowest.endBalanceCents < 0n ? " year__lowest--under" : ""}`}
          role="status"
        >
          Running from today&rsquo;s {formatCents(data.startBalanceCents)}, the lowest any month
          ends is <strong>{lowest.label}</strong> at{" "}
          <span className="hr-amount">{formatCents(lowest.endBalanceCents)}</span>.
        </p>
      ) : null}

      <p className="year__projection-note">
        Up to {formatDayMonthAndYear(data.ledgerThrough)} these are the ledger&rsquo;s own rows.
        After that they are worked out from the schedules, and assume every bill costs what it
        costs today and that nothing else is spent — so read the shape rather than the figure.
      </p>
    </>
  );
}
