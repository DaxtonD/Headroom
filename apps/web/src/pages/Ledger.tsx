/**
 * The ledger: Home, Upcoming and Pay plan as one scroll.
 *
 * This is column 1 of the spreadsheet. The complaint about the first version
 * was not that a number was wrong, it was that "the data is too spread out -
 * she can't easily see everything". Three screens each held part of one list:
 * the balance on Home, the running balance on Upcoming, the per-cheque
 * subtotals on Pay plan. In the spreadsheet all of that is one column to
 * scroll, and a tight week can be seen by looking at it.
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
 *
 * One scroll has one cost, and it took using the screen to see it: the two
 * things you came here to do leave the top of the page as soon as you look at
 * anything. So both buttons are in the hero, side by side - "Add a one-off"
 * was at the bottom, under four pay windows, which is a long way to scroll to
 * record something that has just happened - and once the hero has gone behind
 * the header a single line takes its place carrying the balance, what is safe
 * to spend, and both buttons again. Asked for from use, in those words.
 */
import { formatCents, formatDateShort, type Cents } from "@headroom/core";
import { Fragment, useCallback, useId, useMemo, useState } from "react";
import { Amount, Chip, CoveragePill } from "../components/Badges.js";
import { ExplainButton, ExplainPanel } from "../components/Explain.js";
import { OccurrenceRow, type MoveTarget } from "../components/OccurrenceRow.js";
import { OneOffForm } from "../components/OneOffForm.js";
import { Thumb } from "../components/Thumb.js";
import {
  explainInChequing,
  explainLeftThisCycle,
  explainSafeToSpend,
} from "../lib/explain.js";
import { useBackDismiss } from "../lib/backDismiss.js";
import { useLaunchedBy } from "../lib/launchAction.js";
import { JumpBar } from "../components/JumpBar.js";
import { usePublishedHeight, useScrolledPast } from "../lib/pinnedHeader.js";
import { JUMP_BAR_PX, useSectionSpy, type JumpTarget } from "../lib/sectionNav.js";
import {
  useDashboard,
  usePatchOccurrence,
  usePayPeriods,
  useRemoveOneOff,
  type Account,
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
  // Opened by either copy of the button, or by the manifest shortcut.
  const [addingOneOff, setAddingOneOff] = useState(useLaunchedBy("add-one-off"));

  /*
   * The hero has gone behind the header, so the pinned line takes over.
   *
   * The marker sits at the bottom of the hero, so this turns true at the
   * moment the last of it disappears and false again as it comes back - which
   * is what makes the two read as one thing changing shape rather than as a
   * bar that appears from nowhere.
   */
  const [heroEndRef, heroGone] = useScrolledPast();

  /*
   * How tall the pinned balance line is, published for the stylesheet and
   * returned for the scroll-spy below.
   *
   * Measured rather than written down, for the reason the whole of
   * `pinnedHeader.ts` exists: it is a figure, two buttons and whichever of
   * the five text sizes the household has chosen.
   */
  const [pinnedRef, pinnedHeight] = usePublishedHeight("--hr-ledger-pinned-h");

  /*
   * The chips that jump between pay periods, asked for on 2026-11-20 after
   * the same thing landed on Manage: "let's do the same thing on the ledger
   * to navigate the weeks."
   *
   * Above the early returns because hooks have to be, which means reading
   * the periods before the guard that proves they arrived.
   */
  const jumpTargets = useMemo<JumpTarget[]>(
    () =>
      (payPeriods.data?.periods ?? []).map((period, index) => ({
        id: `ledger-period-${String(index)}`,
        // The window's own label, so a chip and the heading it scrolls to
        // say the same thing. They are short already - "Now-Dec 9".
        label: period.label,
      })),
    [payPeriods.data],
  );

  /*
   * What is pinned above the chips: the bar itself, plus the balance line
   * once the hero has gone. The chips can only ever be stuck when the hero
   * IS gone - they sit below it on the page - so the second term is what
   * holds in every case that matters.
   */
  const spy = useSectionSpy(jumpTargets, JUMP_BAR_PX + (heroGone ? pinnedHeight : 0));

  /*
   * The first row whose money has NOT moved yet, which is where today is.
   *
   * The "Balance now" line goes above it. Found by walking the windows in
   * order, rather than by comparing dates: `settled` is the flag the engine
   * itself acted on when it stopped counting those rows, so the line lands
   * exactly where the balance at the top stops being history and starts
   * being a forecast.
   *
   * It was the last SETTLED row until 2026-11-21, which is the same place
   * only while the two groups do not interleave - and they do. A bill dated
   * last week that nobody has ticked is deliberately kept on the ledger,
   * still to come, and it sorts above anything settled since. The line then
   * printed the balance in the account underneath a row that had already
   * taken a large transfer out of it, so the running column resumed below
   * the line a long way under the figure on it. Anchoring to the
   * first unsettled row makes that impossible: every row above the line
   * moved nothing, so the balance on it is by construction the balance the
   * first row below it starts from.
   *
   * Null when nothing has been ticked yet. There is then no run of repeated
   * figures to break up and no history to mark the end of, so no line.
   */
  const balanceBeforeId = useMemo(() => {
    let firstUnsettled: string | null = null;
    let anySettled = false;
    for (const period of payPeriods.data?.periods ?? []) {
      for (const row of period.rows) {
        if (row.settled) anySettled = true;
        else if (firstUnsettled === null) firstUnsettled = row.id;
      }
    }
    return anySettled ? firstUnsettled : null;
  }, [payPeriods.data]);

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
  /*
   * The accounts, split the way the hero shows them.
   *
   * Chequing leads on its own - it is what the screen is for - and the cards
   * follow it. Savings has its own screen and is not repeated here.
   */
  const cards = data.accounts.filter((account) => account.kind === "credit_card");
  const unpaidCards = cards.filter((account) => account.needsPayment);

  /**
   * An account id as a name, or null for chequing.
   *
   * Null on purpose: a chip saying "Chequing" on almost every row is noise,
   * and the absence of one already means chequing. Only the exception is
   * worth naming.
   */
  const accountsById = new Map(data.accounts.map((account) => [account.id, account]));
  const accountName = (id: string | null): string | null => {
    if (id === null) return null;
    const found = accountsById.get(id);
    if (!found || found.kind === "chequing") return null;
    return found.name;
  };

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
        {/*
          Both of them, at the top, side by side - which is where the one that
          was already here has always been, and where the other one had to
          come to be any use. They stack on a narrow phone rather than
          shrinking to two unreadable labels.
        */}
        <div className="ledger__hero-actions">
          <button className="hr-button ledger__hero-action" type="button" onClick={onUpdateBalance}>
            Update balance
          </button>
          <button
            className="hr-button ledger__hero-action"
            type="button"
            disabled={!canEdit}
            onClick={() => setAddingOneOff(true)}
          >
            Add a one-off
          </button>
        </div>

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

      {/*
        The bottom edge of the hero, with no height of its own.

        A marker rather than the hero itself: it is the whole thing having
        gone that matters, and a thing that never changes size cannot start
        the loop that watching a collapsing element invites. See
        `pinnedHeader.ts`.
      */}
      <div className="ledger__hero-end" ref={heroEndRef} aria-hidden="true" />

      {/*
        ---- The same figures and the same two buttons, in one line ----

        Fixed below the header, so the page never reflows when it arrives: the
        document is exactly as tall either way, which is what stops showing
        the bar from scrolling the page and hiding it again.

        `inert` while it is away, or it would be a second set of buttons
        sitting in the tab order behind the header where nobody can see what
        they have focused. While it is showing, its figures are marked
        `aria-hidden` instead: they are the hero's own numbers a second time,
        and the hero has already said them.
      */}
      <div
        className={`ledger__pinned${heroGone ? " ledger__pinned--shown" : ""}`}
        inert={!heroGone}
        ref={pinnedRef}
      >
        <div className="ledger__pinned-inner">
          <p className="ledger__pinned-figures" aria-hidden="true">
            <span className="ledger__pinned-amount hr-amount">
              {formatCents(data.balance.cents)}
            </span>
            <span className="ledger__pinned-safe">
              {formatCents(data.safeToSpendNowCents)} safe to spend
            </span>
          </p>
          {/*
            Short on screen, full when read out. One line has room for a
            figure or for two full labels and not both - but "Balance" alone
            does not say what the button does, and the name is the only thing
            a screen reader has to go on.
          */}
          <div className="ledger__pinned-buttons">
            <button
              className="ledger__pinned-button"
              type="button"
              aria-label="Update balance"
              onClick={onUpdateBalance}
            >
              Balance
            </button>
            <button
              className="ledger__pinned-button"
              type="button"
              aria-label="Add a one-off"
              disabled={!canEdit}
              onClick={() => setAddingOneOff(true)}
            >
              One-off
            </button>
          </div>
        </div>
      </div>

      {/*
        ---- The cards ----

        Inside the hero, above coverage, because of what changed underneath
        it. A charge on a card correctly stops draining the chequing
        forecast, which means the debt can now grow while safe-to-spend looks
        healthy. The household chose to keep safe-to-spend a pure chequing
        figure - it is the one number whose working fits in a sentence - and
        asked for this to be impossible to miss instead.

        So a card with nothing paying it is an alert, in the hero, above the
        scroll. Not a line at the bottom nobody reaches.
      */}
      {cards.length > 0 ? (
        <section className="ledger__cards" aria-labelledby="ledger-cards-label">
          <p className="ledger__cards-label" id="ledger-cards-label">
            On cards
          </p>
          <ul className="ledger__cards-list">
            {cards.map((card) => (
              <li className="ledger__card" key={card.id}>
                <Thumb imageId={card.imageId} size="row" fallback={card.name} />
                <span className="ledger__card-name">{card.name}</span>
                {/*
                  The amount and its tail are one column, so the amount lands
                  on the same edge on every card. Side by side, a longer tail
                  pushed the amount further left and the figures stopped
                  lining up with each other - which is what was reported.
                */}
                <span className="ledger__card-figures">
                  <span className="ledger__card-owed hr-amount">{formatCents(card.cents)}</span>
                  <span className="ledger__card-ahead">
                    {card.horizonCents === card.cents
                      ? "owed"
                      : `owed, ${formatCents(card.horizonCents)} by ${formatDateShort(data.horizonEnd)}`}
                  </span>
                </span>
              </li>
            ))}
          </ul>

          {unpaidCards.length > 0 ? (
            <p className="ledger__cards-warning" role="alert">
              <strong>
                {unpaidCards.length === 1
                  ? `Nothing is scheduled to pay ${unpaidCards[0]?.name ?? "it"}.`
                  : `Nothing is scheduled to pay ${unpaidCards.length} of these.`}
              </strong>{" "}
              Charges do not come out of chequing, so safe to spend does not know about this yet.
              Add a payment as a one-off and it will.
            </p>
          ) : null}
        </section>
      ) : null}

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
      ) : payPeriods.isError ? (
        /*
         * Not the same as having none, and the difference matters: the empty
         * message below tells someone to go and add a pay schedule, which on
         * a failed fetch is both untrue and actively harmful - they already
         * have one, and adding a second puts every cheque on the ledger twice.
         * The balance above comes from a different query, which succeeded.
         */
        <div className="hr-card ledger__error">
          <h2>Could not load what is coming up</h2>
          <p>
            The server did not answer. The balance above is current; nothing has been changed.
            Reload to try again.
          </p>
        </div>
      ) : periods.length === 0 ? (
        <div className="hr-card ledger__error">
          <h2>No pay periods yet</h2>
          <p>
            Pay periods come from each person&rsquo;s pay schedule. Add those on Manage and the
            whole list appears here.
          </p>
        </div>
      ) : (
        <>
          {/*
            Nested under the balance line rather than beside it: both are
            pinned, and the chips are the thing you came back up the page to
            use. `Ledger.css` has the one declaration that does it.
          */}
          {periods.length > 1 ? (
            <JumpBar
              className={`ledger__jump${heroGone ? " ledger__jump--under-balance" : ""}`}
              label="Jump to a pay period"
              targets={jumpTargets}
              activeId={spy.activeId}
              onJump={spy.jumpTo}
              barRef={spy.barRef}
            />
          ) : null}

          <ol className="ledger__periods">
            {periods.map((period, index) => (
              <li
                className="ledger__period"
                id={`ledger-period-${String(index)}`}
                key={period.label}
              >
                <PeriodGroup
                  period={period}
                  balanceBeforeId={balanceBeforeId}
                  balanceCents={data.balance.cents}
                  moveTargets={moveTargets}
                  accountName={accountName}
                  accounts={data.accounts}
                  canEdit={canEdit}
                  expandedId={expandedId}
                  onToggle={(id) => setExpandedId(expandedId === id ? null : id)}
                  onSave={(input) => patch.mutateAsync(input)}
                  onRemove={(input) => removeOneOff.mutateAsync(input)}
                />
              </li>
            ))}
          </ol>
        </>
      )}

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
        <OneOffForm
          paydays={moveTargets}
          accounts={data.accounts}
          mortgageId={data.mortgageId}
          today={data.today}
          onClose={() => setAddingOneOff(false)}
        />
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
/**
 * One thing on a window's list: a row of the timeline, or a cheque the window
 * counts that has no row yet because it falls past the horizon.
 */
type Entry =
  | { kind: "row"; row: TimelineRow; at: string | null }
  | { kind: "cheque"; cheque: PayPeriod["projectedPaycheques"][number]; at: string };

/**
 * The id the engine knows an entry by.
 *
 * A projected cheque has no row and so no id of its own; the engine names it
 * for the schedule and the day it falls on, and this has to spell it the same
 * way or a block would never find its last row. Both spellings live in
 * `payPeriods.ts`.
 */
function idOfEntry(entry: Entry): string {
  return entry.kind === "row" ? entry.row.id : `${entry.cheque.scheduleId}|${entry.cheque.date}`;
}

function PeriodGroup({
  period,
  moveTargets,
  canEdit,
  expandedId,
  onToggle,
  onSave,
  onRemove,
  accountName,
  accounts,
  balanceBeforeId,
  balanceCents,
}: {
  period: PayPeriod;
  moveTargets: readonly MoveTarget[];
  /**
   * The row the "Balance now" line goes above: the first one whose money has
   * not moved yet. Null in every window that holds no such row, which is
   * every window but the one today falls in.
   */
  balanceBeforeId: string | null;
  balanceCents: Cents;
  /** Resolves an account id to its name, for the chip on a charge. */
  accountName: (id: string | null) => string | null;
  /**
   * The accounts themselves, so an expanded row can be moved between them.
   *
   * Passed as well as `accountName` rather than instead of it: the chips on a
   * collapsed row want one name and nothing else, and handing every row the
   * whole list to find it in would be the row doing lookups the screen has
   * already done.
   */
  accounts: readonly Account[];
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

  /**
   * Where each cheque's left-over line goes: under the last row that cheque
   * has to cover.
   *
   * Found by position rather than assumed to be contiguous. The engine sorts
   * its entries the same way this screen does, so in practice a block IS a
   * run of adjacent rows - but "in practice" is how the window membership
   * rule went wrong when it was written twice, and a footer that lands in the
   * middle of the next cheque is a worse failure than one that does not
   * appear. Taking the furthest row of each block cannot do that.
   */
  const leftOverAfter = useMemo(() => {
    const positionOf = new Map<string, number>();
    entries.forEach((entry, index) => {
      positionOf.set(idOfEntry(entry), index);
    });

    const footers = new Map<number, PayPeriod["blocks"][number]>();
    for (const block of period.blocks) {
      // Only a cheque gets one. The opening stretch between now and the next
      // cheque leaves behind exactly the running balance already printed
      // beside its last row, and a second copy of a number is not an answer.
      if (block.kind !== "cheque") continue;

      let last = -1;
      for (const id of block.entryIds) {
        const at = positionOf.get(id);
        if (at !== undefined && at > last) last = at;
      }
      if (last >= 0) footers.set(last, block);
    }
    return footers;
  }, [entries, period.blocks]);

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
        A short last period is a boundary, not missing data - so it says which
        one. Headroom looks a set number of paycheques ahead, and with two
        people being paid on alternating weeks that count usually lands in the
        middle of a fortnight rather than at the end of one. This period is
        reported as far as the ledger actually reaches: anything dated after it
        is real and is simply not looked at yet.
      */}
      {period.endsAtHorizon ? (
        <p className="ledger__period-note">
          This is as far ahead as Headroom is set to look, so the rest of the
          fortnight is not counted here yet. Manage can raise how many
          paycheques ahead it goes.
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
        {entries.map((entry, index) => {
          const id = idOfEntry(entry);
          const leftOver = leftOverAfter.get(index);

          return (
            <Fragment key={id}>
              {/*
                ---- Where today is ----

                The rows above this have happened: the money has gone, and the
                figure at the top already counts it. Said once, here, instead
                of repeating the same balance down a dozen rows - which is
                what the ledger used to do and what read as a stuck counter.

                Drawn above the row rather than below one, so the figure on it
                is the balance the first row under it starts from. Every row
                above moved nothing, which is what makes that true rather than
                merely usually true.
              */}
              {id === balanceBeforeId ? (
                <li className="ledger__now">
                  <span className="ledger__now-label">Balance now</span>
                  <span className="ledger__now-amount hr-amount">{formatCents(balanceCents)}</span>
                </li>
              ) : null}

              {entry.kind === "row" ? (
                <OccurrenceRow
                  row={entry.row}
                  expanded={expandedId === entry.row.id}
                  onToggle={() => onToggle(entry.row.id)}
                  canEdit={canEdit}
                  moveTargets={moveTargets}
                  onSave={onSave}
                  onRemove={onRemove}
                  chargedTo={accountName(entry.row.paidFromAccountId)}
                  paidToward={accountName(entry.row.transferToAccountId)}
                  accounts={accounts}
                />
              ) : (
                <li className="ledger__projected">
                  <span className="ledger__projected-name">
                    {entry.cheque.owner ? `${entry.cheque.owner.name}'s pay` : "Expected pay"}
                    <Chip tone="neutral">Expected · {formatDateShort(entry.cheque.date)}</Chip>
                  </span>
                  <Amount cents={entry.cheque.cents} signed />
                </li>
              )}

              {/*
                ---- What this cheque leaves ----

                The number the spreadsheet gets by dragging from a paycheque
                down to the row above the next one. It is not on any row: the
                running balance beside these rows still carries whatever the
                last cheque left over, and this deliberately does not.
              */}
              {leftOver ? (
                <li className="ledger__block-left">
                  <span>Left from this cheque</span>
                  <span className="hr-amount">{formatCents(leftOver.leftCents)}</span>
                </li>
              ) : null}
            </Fragment>
          );
        })}

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
        {period.elsewhereCents > 0n ? (
          <div className="ledger__subtotal-row">
            <span>On cards</span>
            <span className="hr-amount">{formatCents(period.elsewhereCents)}</span>
          </div>
        ) : null}
        <p className="ledger__subtotal-note">
          {formatCents(period.inCents)} in, less {formatCents(period.autoCents)} automatic and{" "}
          {formatCents(period.flexibleCents)} flexible.
          {period.elsewhereCents > 0n
            ? ` The ${formatCents(period.elsewhereCents)} on cards is not in that: it comes out when you pay the card.`
            : ""}
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
 * Relative wording for the recent past, because that is how the household
 * thinks about when the balance was last typed in.
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
