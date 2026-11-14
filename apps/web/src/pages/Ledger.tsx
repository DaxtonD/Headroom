/**
 * The ledger: Home, Upcoming and Pay plan as one scroll.
 *
 * This is Carol's column 1. Her complaint about the first version of the app
 * was not that a number was wrong, it was that "the data is too spread out -
 * she can't easily see everything". Three screens each held part of one list:
 * the balance on Home, the running balance on Upcoming, the per-cheque
 * subtotals on Pay plan. In the spreadsheet all of that is one column she
 * scrolls, and she can see a tight week by looking at it.
 *
 * So: the balance and what is safe to spend at the top, where they are the
 * instant answer the brief asks for, and then every event in the order the
 * bank would apply it, grouped under the cheque that pays for it, with a
 * running balance on every line and a subtotal band under each group.
 *
 * Three things the old Pay plan screen had that must not be lost:
 *
 *  - **Moving a flexible bill to another cheque.** This is the household's
 *    main lever when a week is tight, and the only one on a phone.
 *  - **The subtotal per window**, which is how a tight week is spotted at all.
 *  - **Room to save**, which is new here: what could go into savings out of
 *    this window without pushing any later balance below the cushion. It is
 *    what turns a third paycheque from "silently absorbed" into a decision.
 */
import { formatCents, formatDateShort } from "@headroom/core";
import { useCallback, useId, useMemo, useState } from "react";
import { Amount, Chip, CoveragePill } from "../components/Badges.js";
import { ExplainButton, ExplainPanel } from "../components/Explain.js";
import { OccurrenceRow, type MoveTarget } from "../components/OccurrenceRow.js";
import { OneOffForm } from "../components/OneOffForm.js";
import {
  explainInChequing,
  explainLeftThisCycle,
  explainSafeToSpend,
} from "../lib/explain.js";
import { useBackDismiss } from "../lib/backDismiss.js";
import {
  useDashboard,
  usePatchOccurrence,
  usePayPeriods,
  useRemoveOneOff,
  type PayPeriod,
  type TimelineRow,
} from "../lib/queries.js";
import "./Ledger.css";

export function Ledger({
  canEdit,
  onUpdateBalance,
}: {
  canEdit: boolean;
  onUpdateBalance: () => void;
}): React.JSX.Element {
  // Two reads, fired together rather than one after the other: the headline
  // paints as soon as the dashboard lands, without waiting for the grouping.
  const dashboard = useDashboard();
  const payPeriods = usePayPeriods();
  const patch = usePatchOccurrence();
  const removeOneOff = useRemoveOneOff();

  // No page-level error state: each row reports its own save, including a
  // conflict with the other phone, and the one-off form reports its own. An
  // error banner up here would be a second place to look for the same news.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [addingOneOff, setAddingOneOff] = useState(false);

  // An opened row is a step, so Android's Back closes it rather than leaving
  // the ledger.
  const collapseRow = useCallback(() => setExpandedId(null), []);
  useBackDismiss(expandedId !== null, collapseRow);

  /*
   * Which figure's working is open, if any.
   *
   * One at a time, and the state lives here rather than in each button,
   * because the panel is not rendered where its button is: "safe to spend"
   * and "left this cycle" share a two-column row, and a panel rendered inside
   * one of those columns is half the width of the screen. Each panel gets a
   * full-width slot instead, and only the open one is mounted.
   */
  const explainId = useId();
  const [explaining, setExplaining] = useState<"chequing" | "safe" | "left" | null>(null);
  const panelId = (which: string): string => `${explainId}-${which}`;
  const toggleExplain = (which: "chequing" | "safe" | "left") => () => {
    setExplaining(explaining === which ? null : which);
  };

  // And Back closes the working, for the same reason.
  const closeExplain = useCallback(() => setExplaining(null), []);
  useBackDismiss(explaining !== null, closeExplain);

  if (dashboard.isPending) {
    return (
      <div className="ledger" aria-busy="true">
        <p className="hr-visually-hidden">Loading your balance</p>
        {/* Painted at once so the screen never looks broken while loading. */}
        <div className="ledger__hero ledger__hero--skeleton" />
      </div>
    );
  }

  if (dashboard.isError || !dashboard.data) {
    return (
      <div className="ledger">
        <div className="hr-card ledger__error">
          <h2>Could not load your numbers</h2>
          <p>
            The server did not answer. Nothing has been changed; pull down or reload to try again.
          </p>
        </div>
      </div>
    );
  }

  const data = dashboard.data;
  const periods = payPeriods.data?.periods ?? [];
  const updatedLabel = data.balance.asOf ? describeUpdated(data.balance.asOf) : "not set yet";

  /**
   * Where a flexible bill can go: "Now", then every payday on the ledger.
   *
   * The anchor is a paycheque, not a window, which is what the API takes - so
   * a window with no cheque placed yet simply has no entry here.
   */
  const moveTargets: MoveTarget[] = [
    { id: null, label: "Now" },
    ...periods.flatMap((period) =>
      period.rows
        .filter((row) => row.kind === "paycheque" && row.date !== null)
        .map((row) => ({ id: row.id, label: formatDateShort(row.date as string) })),
    ),
  ];

  return (
    <div className="ledger">
      {/* ---- The balance, and what follows from it ---- */}
      <section className="ledger__hero" aria-labelledby="ledger-balance-label">
        <p className="ledger__hero-label" id="ledger-balance-label">
          In chequing
          <ExplainButton
            figure="in chequing"
            panelId={panelId("chequing")}
            open={explaining === "chequing"}
            onToggle={toggleExplain("chequing")}
          />
        </p>
        <p className="ledger__hero-amount hr-amount">{formatCents(data.balance.cents)}</p>
        <p className="ledger__hero-meta">
          Updated {updatedLabel}
          {data.balance.enteredBy ? ` by ${data.balance.enteredBy.name}` : ""}
        </p>

        {explaining === "chequing" ? (
          <ExplainPanel
            id={panelId("chequing")}
            working={explainInChequing({
              cents: data.balance.cents,
              snapshotCents: data.balance.snapshotCents,
              asOf: data.balance.asOf,
              enteredBy: data.balance.enteredBy,
            })}
          />
        ) : null}
        <button className="hr-button ledger__update" type="button" onClick={onUpdateBalance}>
          Update balance
        </button>

        <div className="ledger__hero-split">
          <div>
            <p className="ledger__hero-sublabel">
              Safe to spend now
              {/*
                The one most worth explaining. It is not "balance less the
                bills", which is what everybody assumes, and when money
                arrives before it goes out the answer is the whole balance -
                which looks like a mistake until you see the working.
              */}
              <ExplainButton
                figure="safe to spend now"
                panelId={panelId("safe")}
                open={explaining === "safe"}
                onToggle={toggleExplain("safe")}
              />
            </p>
            <p className="ledger__hero-subamount hr-amount">
              {formatCents(data.safeToSpendNowCents)}
            </p>
          </div>
          <div>
            <p className="ledger__hero-sublabel">
              Left this cycle
              <ExplainButton
                figure="left this cycle"
                panelId={panelId("left")}
                open={explaining === "left"}
                onToggle={toggleExplain("left")}
              />
            </p>
            <p className="ledger__hero-subamount hr-amount">
              {formatCents(data.leftThisCycleCents)}
            </p>
          </div>

          {/* Full width, under both: see .ledger__hero-split in the stylesheet. */}
          {explaining === "safe" ? (
            <ExplainPanel
              id={panelId("safe")}
              working={explainSafeToSpend({
                safeToSpendNowCents: data.safeToSpendNowCents,
                cushionCents: data.cushionCents,
                lowest: data.lowest,
                lowestAfterName: data.breakdown.lowestAfterName,
                horizonEnd: data.horizonEnd,
              })}
            />
          ) : null}
          {explaining === "left" ? (
            <ExplainPanel
              id={panelId("left")}
              working={explainLeftThisCycle({
                breakdown: data.breakdown,
                horizonEnd: data.horizonEnd,
              })}
            />
          ) : null}
        </div>
        <p className="ledger__hero-note">
          {data.lowest.date
            ? `The lowest it gets is ${formatCents(data.lowest.cents)}, on ${formatDateShort(data.lowest.date)}.`
            : `The lowest it gets is ${formatCents(data.lowest.cents)}.`}
        </p>
      </section>

      {/* ---- Coverage, said once and near the top ---- */}
      {!data.coverage.allCovered && data.coverage.firstShortfall ? (
        <section className="ledger__warning" role="alert">
          <p className="ledger__warning-title">
            Not enough for {data.coverage.firstShortfall.name}
            {data.coverage.firstShortfall.date
              ? ` on ${formatDateShort(data.coverage.firstShortfall.date)}`
              : ""}
          </p>
          <p className="ledger__warning-detail">
            {formatCents(data.coverage.firstShortfall.shortCents)} short. Push a flexible bill
            later — tap one of the rows below to change the day you pay it, or to hang it off a
            later cheque.
          </p>
        </section>
      ) : (
        <div className="ledger__covered">
          <CoveragePill allCovered count={data.coverage.autoWithdrawalCount} />
          <span>Every automatic withdrawal has the money waiting for it.</span>
        </div>
      )}

      {data.estimatesCount > 0 ? (
        <p className="ledger__estimates">
          {data.estimatesCount === 1
            ? "1 bill is still an estimate."
            : `${data.estimatesCount} bills are still estimates.`}{" "}
          Verified amounts carry a tick.
        </p>
      ) : null}

      {/* ---- The scroll ---- */}
      {payPeriods.isPending ? (
        <p className="ledger__loading" aria-busy="true">
          Working out what is coming up…
        </p>
      ) : periods.length === 0 ? (
        <div className="hr-card ledger__error">
          <h2>No pay periods yet</h2>
          <p>
            Pay periods come from each person&rsquo;s pay schedule. Add those on Manage and the
            whole list appears here.
          </p>
        </div>
      ) : (
        <ol className="ledger__periods">
          {periods.map((period) => (
            <li className="ledger__period" key={period.label}>
              <PeriodGroup
                period={period}
                moveTargets={moveTargets}
                canEdit={canEdit}
                expandedId={expandedId}
                onToggle={(id) => setExpandedId(expandedId === id ? null : id)}
                onSave={(input) => patch.mutateAsync(input)}
                onRemove={(input) => removeOneOff.mutateAsync(input)}
              />
            </li>
          ))}
        </ol>
      )}

      {/*
        Carol's "add a few extra rows": a dentist bill, or an extra amount into
        savings because a third cheque landed.
      */}
      <div className="ledger__actions">
        <button
          className="hr-button"
          type="button"
          disabled={!canEdit}
          onClick={() => setAddingOneOff(true)}
        >
          Add a one-off
        </button>
      </div>

      {/* ---- The bottom line ---- */}
      <section className="ledger__footer">
        <p className="ledger__footer-label">Left for gas, groceries &amp; everyday</p>
        <p className="ledger__footer-amount hr-amount">{formatCents(data.leftThisCycleCents)}</p>
        <p className="ledger__footer-note">
          Through {formatDateShort(data.horizonEnd)}, the day before the next cheque after this
          cycle.
        </p>
      </section>

      {addingOneOff ? (
        <OneOffForm paydays={moveTargets} onClose={() => setAddingOneOff(false)} />
      ) : null}
    </div>
  );
}

/**
 * One pay window: its rows in bank order, then what it leaves behind.
 *
 * The running balance is on every line, which is the single thing the
 * spreadsheet does that three separate screens could not.
 */
function PeriodGroup({
  period,
  moveTargets,
  canEdit,
  expandedId,
  onToggle,
  onSave,
  onRemove,
}: {
  period: PayPeriod;
  moveTargets: readonly MoveTarget[];
  canEdit: boolean;
  expandedId: string | null;
  onToggle: (id: string) => void;
  onSave: React.ComponentProps<typeof OccurrenceRow>["onSave"];
  onRemove: NonNullable<React.ComponentProps<typeof OccurrenceRow>["onRemove"]>;
}): React.JSX.Element {
  /**
   * The window's rows and its expected cheques, in one list, in date order.
   *
   * An expected cheque is one the window counts but that has no occurrence yet
   * - it falls past the horizon, or nothing has generated it. It carries no
   * running balance, because the timeline deliberately stops at the horizon,
   * so it sits between the dated rows without claiming a balance of its own.
   *
   * Undated rows keep their position at the front: they are anchored to "now",
   * which is where the timeline puts them.
   */
  const entries = useMemo(() => {
    type Entry =
      | { kind: "row"; row: TimelineRow; at: string | null }
      | { kind: "cheque"; cheque: PayPeriod["projectedPaycheques"][number]; at: string };

    const merged: Entry[] = [
      ...period.rows.map((row) => ({ kind: "row" as const, row, at: row.date })),
      ...period.projectedPaycheques.map((cheque) => ({
        kind: "cheque" as const,
        cheque,
        at: cheque.date,
      })),
    ];

    // A stable sort on the date alone: within a day, and for undated rows, the
    // engine's order is already correct and must not be disturbed.
    return merged
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) => {
        if (a.entry.at === b.entry.at) return a.index - b.index;
        if (a.entry.at === null) return -1;
        if (b.entry.at === null) return 1;
        return a.entry.at < b.entry.at ? -1 : 1;
      })
      .map(({ entry }) => entry);
  }, [period.rows, period.projectedPaycheques]);

  return (
    <>
      <header className="ledger__period-head">
        <h2 className="ledger__period-title">{period.label}</h2>
        <span className="ledger__period-dates">
          {formatDateShort(period.start)} – {formatDateShort(period.end)}
        </span>
      </header>

      {period.isCurrentPartial ? (
        <p className="ledger__period-note">
          This one starts today, so it opens with what is already in chequing.
        </p>
      ) : null}

      {/*
        The same row component the Upcoming screen used, rather than a second
        one written for this screen. It already carries the running balance,
        the verification badge, the amount editor, verify, mark-as-paid, the
        move buttons and the conflict handling - and a flatter row here would
        have quietly dropped every one of those.

        Expected cheques are interleaved by date, not appended. Appending them
        put a deposit on the 12th below bills dated the 13th to the 19th, which
        reads as "every bill comes out before any money arrives" - the opposite
        of what the dates say, and alarming when the running balance beside the
        bills has not counted the cheque either.
      */}
      <ul className="ledger__rows">
        {entries.map((entry) =>
          entry.kind === "row" ? (
            <OccurrenceRow
              key={entry.row.id}
              row={entry.row}
              expanded={expandedId === entry.row.id}
              onToggle={() => onToggle(entry.row.id)}
              canEdit={canEdit}
              moveTargets={moveTargets}
              onSave={onSave}
              onRemove={onRemove}
            />
          ) : (
            <li
              className="ledger__projected"
              key={`${entry.cheque.scheduleId}|${entry.cheque.date}`}
            >
              <span className="ledger__projected-name">
                {entry.cheque.owner ? `${entry.cheque.owner.name}'s pay` : "Expected pay"}
                <Chip tone="neutral">Expected · {formatDateShort(entry.cheque.date)}</Chip>
              </span>
              <Amount cents={entry.cheque.cents} signed />
            </li>
          ),
        )}

        {entries.length === 0 ? (
          <li className="ledger__empty">Nothing in this period.</li>
        ) : null}
      </ul>

      {/* ---- What the window leaves behind ---- */}
      <div
        className={`ledger__subtotal${period.allAutoCovered ? "" : " ledger__subtotal--short"}`}
      >
        <div className="ledger__subtotal-row">
          <span>Left over</span>
          <span className="hr-amount">{formatCents(period.leftCents)}</span>
        </div>
        <div className="ledger__subtotal-row ledger__subtotal-row--strong">
          <span>Room to save</span>
          <span className="hr-amount">{formatCents(period.roomToSaveCents)}</span>
        </div>
        <p className="ledger__subtotal-note">
          {formatCents(period.inCents)} in, less {formatCents(period.autoCents)} automatic and{" "}
          {formatCents(period.flexibleCents)} flexible.
          {period.lowest
            ? ` Lowest inside it: ${formatCents(period.lowest.cents)}${
                period.lowest.date ? ` on ${formatDateShort(period.lowest.date)}` : ""
              }.`
            : ""}
        </p>
        {!period.allAutoCovered ? (
          <p className="ledger__subtotal-note">
            Something automatic in this window is not covered. Move a flexible bill out of it.
          </p>
        ) : null}
      </div>
    </>
  );
}

/**
 * "today, 9:58 AM" / "yesterday, 6:12 PM" / "Nov 3".
 *
 * Relative wording for the recent past, because that is how Carol thinks about
 * when she last typed the balance in.
 */
function describeUpdated(at: Date): string {
  const time = at.toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" });

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  if (at.getTime() >= startOfToday.getTime()) return `today, ${time}`;

  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  if (at.getTime() >= startOfYesterday.getTime()) return `yesterday, ${time}`;

  return at.toLocaleDateString("en-CA", { month: "short", day: "numeric" });
}
