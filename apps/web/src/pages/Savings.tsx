/**
 * Savings (replaces the Goals screen).
 *
 * The household has one real savings account and is saving as hard as it can
 * in order to pay the mortgage off early with annual lump sums. That was put
 * plainly: they would not need a budget at all if they were not trying to save
 * this much. So this screen answers three questions in that order:
 *
 *  1. **How much is in there?** A fact, read off the bank and typed in.
 *  2. **Where is it going?** Earmarks - labels on money already saved. This
 *     year a trip is taking the flow and the mortgage pot is paused, which is
 *     a real state the screen has to be able to show without complaint.
 *  3. **What does that buy?** The payoff date, and what a lump sum moves it
 *     to. That is the sentence the spreadsheet could not say, and the reason
 *     the saving is happening at all.
 *
 * The balance and the earmarks are both facts and they can disagree. Their
 * difference is reported rather than clamped: a screen that quietly capped a
 * bar at 100% would hide the one thing worth knowing.
 *
 * Work expenses and banked hours live below. They were on this screen before
 * it was about savings and they still belong on the same page - everything
 * here is money that is not in the day-to-day ledger - but they come second.
 */
import { formatCents, formatDateShort, formatDayMonthAndYear } from "@headroom/core";
import { useState } from "react";
import { Link } from "react-router";
import { Amount, InitialBubble } from "../components/Badges.js";
import { BankedHoursForm } from "../components/BankedHoursForm.js";
import { GoalForm } from "../components/GoalForm.js";
import { Loading } from "../components/Loading.js";
import { LumpSumForm } from "../components/LumpSumForm.js";
import { MortgageForm } from "../components/MortgageForm.js";
import { ReimbursementForm } from "../components/ReimbursementForm.js";
import { SavingsBalanceSheet } from "../components/SavingsBalanceSheet.js";
import { useLaunchedBy } from "../lib/launchAction.js";
import { ApiError, OfflineError } from "../lib/api.js";
import { useCreateAccount, useDeleteBankedHours, useSetup } from "../lib/manageQueries.js";
import {
  useAdvanceReimbursement,
  useGoalsOverview,
  type BankedHoursEntry,
  type GoalProgress,
  type Reimbursement,
} from "../lib/plannerQueries.js";
import { useSavings, type Earmark, type LumpSum, type MortgagePanel } from "../lib/savingsQueries.js";
import "./Savings.css";

/**
 * A section whose data did not load.
 *
 * Both sections below used to render `{overview.data ? ... : null}` and
 * nothing else, so when that one query failed they did not fail - they
 * silently were not there. That is how a renamed field on the API took work
 * expenses and banked hours off the screen altogether with no message, on a
 * screen where "there is nothing here" is also a legitimate answer.
 *
 * A section that cannot load now says so in its own place, keeping its
 * heading, so the screen still has the shape the reader expects.
 */
function SectionUnavailable({ title }: { title: string }): React.JSX.Element {
  return (
    <section className="hr-card savings__section">
      <header className="savings__section-head">
        <h2 className="savings__section-title">{title}</h2>
      </header>
      <p className="savings__empty">
        Could not load this section. Nothing has been changed; reload to try again.
      </p>
    </section>
  );
}

/** Which sheet is open. */
type Open =
  | { readonly kind: "balance" }
  | { readonly kind: "earmark"; readonly earmark: Earmark | null }
  | { readonly kind: "mortgage" }
  | { readonly kind: "lumpSum"; readonly lumpSum: LumpSum | null }
  | { readonly kind: "reimbursement" }
  | { readonly kind: "hours" }
  | null;

export function Savings({ canEdit }: { canEdit: boolean }): React.JSX.Element {
  const savings = useSavings();
  const overview = useGoalsOverview();
  const setup = useSetup();
  const advance = useAdvanceReimbursement();
  const removeHours = useDeleteBankedHours();
  const createAccount = useCreateAccount();
  const [error, setError] = useState<string | null>(null);
  // Opened from the screen, or by the manifest shortcut straight to it.
  const openedByShortcut = useLaunchedBy("update-savings");
  const [open, setOpen] = useState<Open>(openedByShortcut ? { kind: "balance" } : null);
  /*
   * Both default to closed. The work-expense history and the hours entries are
   * both append-only lists that only grow, and neither is what the screen is
   * for: the question on arriving is "what is still owed", not "what happened
   * in March".
   */
  const [showPaid, setShowPaid] = useState(false);
  const [showEntries, setShowEntries] = useState(false);

  if (savings.isPending) {
    return <Loading className="savings" label="Loading savings" cards={2} />;
  }

  if (savings.isError || !savings.data) {
    return (
      <div className="savings">
        <div className="hr-card savings__error">
          <h2>Could not load savings</h2>
          <p>The server did not answer. Nothing has been changed; reload to try again.</p>
        </div>
      </div>
    );
  }

  const data = savings.data;
  const latest = data.accounts.find((account) => account.asOf !== null) ?? null;

  const move = async (item: Reimbursement, to: "submitted" | "paid"): Promise<void> => {
    setError(null);
    try {
      await advance.mutateAsync({ id: item.id, version: item.version, to });
    } catch (caught) {
      if (caught instanceof OfflineError || caught instanceof ApiError) setError(caught.message);
      else setError(`Could not update ${item.purchase}. Please try again.`);
    }
  };

  const dropHours = async (entry: BankedHoursEntry): Promise<void> => {
    setError(null);
    try {
      await removeHours.mutateAsync({ id: entry.id, version: entry.version });
    } catch (caught) {
      if (caught instanceof OfflineError || caught instanceof ApiError) setError(caught.message);
      else setError("Could not remove those hours. Please try again.");
    }
  };

  const addAccount = async (): Promise<void> => {
    setError(null);
    try {
      await createAccount.mutateAsync({ name: "Savings", kind: "savings" });
    } catch (caught) {
      if (caught instanceof OfflineError || caught instanceof ApiError) setError(caught.message);
      else setError("Could not add the account.");
    }
  };

  /** An earmark edits through the goal form, which is the same row. */
  const asGoal = (earmark: Earmark): GoalProgress => ({
    id: earmark.id,
    name: earmark.name,
    targetCents: earmark.targetCents,
    savedCents: earmark.setAsideCents,
    // Carried through, not defaulted: the goal form sends every field it
    // knows about, so a null here would clear the household's plan on any
    // edit made from this screen.
    perPaydayIntentCents: earmark.perPaydayIntentCents,
    remainingCents: earmark.remainingCents,
    pct: earmark.pct,
    isMet: earmark.isMet,
    purpose: earmark.purpose,
    sortIndex: 0,
    version: earmark.version,
  });

  return (
    <div className="savings">
      {error ? (
        <p className="hr-alert" role="alert">
          {error}
        </p>
      ) : null}

      {/* ---- What is in there ---- */}
      <section className="hr-card savings__balance">
        <p className="savings__balance-label">In savings</p>
        <p className="savings__balance-amount hr-amount">{formatCents(data.balanceCents)}</p>

        {data.hasSavingsAccount ? (
          <>
            <p className="savings__balance-note">
              {latest?.asOf
                ? `Entered by ${latest.enteredBy?.name ?? "someone"} on ${formatDateShort(
                    latest.asOf.slice(0, 10),
                  )}.`
                : "No balance entered yet."}
            </p>
            <button
              className="hr-button savings__balance-button"
              type="button"
              disabled={!canEdit}
              onClick={() => setOpen({ kind: "balance" })}
            >
              Update savings
            </button>
          </>
        ) : (
          <>
            <p className="savings__balance-note">
              There is no savings account yet. Adding one lets you type in what the bank says and
              split it between the things you are saving for. You can rename it on Manage.
            </p>
            <button
              className="hr-button savings__balance-button"
              type="button"
              disabled={!canEdit || createAccount.isPending}
              onClick={() => void addAccount()}
            >
              Add a savings account
            </button>
          </>
        )}
      </section>

      {/* ---- Where it is going ---- */}
      <section className="hr-card savings__section">
        <header className="savings__section-head">
          <h2 className="savings__section-title">Where it is going</h2>
        </header>

        {data.earmarks.length === 0 ? (
          <p className="savings__empty">
            Nothing is earmarked. All of it is unspoken for, which is a fine place to start.
          </p>
        ) : (
          <ul className="savings__list">
            {data.earmarks.map((earmark) => (
              <li className="savings__goal" key={earmark.id}>
                <div className="savings__goal-head">
                  <span className="savings__goal-name">
                    {earmark.name}
                    {earmark.purpose === "mortgage_lump_sum" ? (
                      <span className="savings__tag">mortgage</span>
                    ) : null}
                  </span>
                  {earmark.pct !== null ? (
                    <span className="savings__goal-pct">{earmark.pct}%</span>
                  ) : null}
                  <button
                    className="savings__edit"
                    type="button"
                    disabled={!canEdit}
                    onClick={() => setOpen({ kind: "earmark", earmark })}
                    aria-label={`Edit ${earmark.name}`}
                  >
                    Edit
                  </button>
                </div>

                {/*
                  No target means no bar. A trip has no set cost, so there is
                  nothing for the bar to be a fraction of, and one drawn
                  against an invented target is the fiction this screen avoids.
                */}
                {earmark.targetCents !== null && earmark.pct !== null ? (
                  <div
                    className="savings__progress"
                    role="img"
                    aria-label={`${formatCents(earmark.setAsideCents)} set aside of ${formatCents(
                      earmark.targetCents,
                    )}, ${earmark.pct}%`}
                  >
                    <span
                      className="savings__progress-fill"
                      style={{ width: `${Math.min(100, earmark.pct)}%` }}
                    />
                  </div>
                ) : null}

                <p className="savings__goal-note">
                  <strong className="hr-amount">{formatCents(earmark.setAsideCents)}</strong>
                  {earmark.targetCents === null ? (
                    <> set aside</>
                  ) : (
                    <>
                      {" of "}
                      <span className="hr-amount">{formatCents(earmark.targetCents)}</span>
                      {earmark.remainingCents !== null && earmark.remainingCents > 0n ? (
                        <> · {formatCents(earmark.remainingCents)} to go</>
                      ) : (
                        <> · there already</>
                      )}
                    </>
                  )}
                </p>
              </li>
            ))}
          </ul>
        )}

        {/*
          The reconciliation, and the reason the earmarks are not just a list.
          Over-allocation is said out loud: it means a decision has been made
          twice over the same money.
        */}
        <div
          className={`savings__allocation${
            data.isOverAllocated ? " savings__allocation--over" : ""
          }`}
          role={data.isOverAllocated ? "alert" : undefined}
        >
          <div className="savings__allocation-row">
            <span>Earmarked</span>
            <span className="hr-amount">{formatCents(data.earmarkedCents)}</span>
          </div>
          <div className="savings__allocation-row savings__allocation-row--strong">
            <span>{data.isOverAllocated ? "Earmarked beyond what is there" : "Not spoken for"}</span>
            <span className="hr-amount">
              {formatCents(
                data.isOverAllocated ? -data.unallocatedCents : data.unallocatedCents,
              )}
            </span>
          </div>
          {data.isOverAllocated ? (
            <p className="savings__allocation-note">
              More has been set aside than the account holds. Lower one of the amounts above, or
              update the balance.
            </p>
          ) : null}
        </div>

        <div className="savings__actions">
          <button
            className="hr-button"
            type="button"
            disabled={!canEdit}
            onClick={() => setOpen({ kind: "earmark", earmark: null })}
          >
            Add an earmark
          </button>
        </div>
      </section>

      {/* ---- The mortgage ---- */}
      <MortgageSection
        mortgage={data.mortgage}
        today={data.today}
        canEdit={canEdit}
        onEditTerms={() => setOpen({ kind: "mortgage" })}
        onAddLumpSum={() => setOpen({ kind: "lumpSum", lumpSum: null })}
        onEditLumpSum={(lumpSum) => setOpen({ kind: "lumpSum", lumpSum })}
      />

      {/* ---- Work expenses ---- */}
      {overview.isError ? <SectionUnavailable title="Work expenses" /> : null}
      {overview.data ? (
        <section className="hr-card savings__section">
          <header className="savings__section-head">
            <h2 className="savings__section-title">Work expenses</h2>
            <Amount
              cents={overview.data.reimbursements.outstandingCents}
              className="savings__section-total"
            />
          </header>
          <p className="savings__note">
            Put on the Visa for work, tracked until it comes back. The figure above is what is
            still owed to you.
          </p>

          {overview.data.reimbursements.outstanding.length === 0 ? (
            <p className="savings__empty">Nothing outstanding.</p>
          ) : (
            <ul className="savings__list">
              {overview.data.reimbursements.outstanding.map((item) => (
                <li className="savings__expense" key={item.id}>
                  <div className="savings__expense-main">
                    <span className="savings__expense-name">{item.purchase}</span>
                    <StatusTrail status={item.status} />
                  </div>

                  <Amount cents={item.cents} />

                  <button
                    className="savings__advance"
                    type="button"
                    disabled={!canEdit || advance.isPending}
                    onClick={() => void move(item, item.status === "bought" ? "submitted" : "paid")}
                  >
                    {item.status === "bought" ? "Mark submitted" : "Mark paid back"}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/*
            Paid back, behind a button. Keeping the history is the point, but
            it is the part with nothing left to do about it, and every month
            adds to it.
          */}
          {overview.data.reimbursements.paidCount > 0 ? (
            <>
              <button
                className="savings__more"
                type="button"
                aria-expanded={showPaid}
                onClick={() => setShowPaid((shown) => !shown)}
              >
                {showPaid
                  ? "Hide paid back"
                  : `Show paid back (${String(overview.data.reimbursements.paidCount)})`}
              </button>

              {showPaid ? (
                <ul className="savings__list">
                  {overview.data.reimbursements.paid.map((item) => (
                    <li className="savings__expense savings__expense--done" key={item.id}>
                      <div className="savings__expense-main">
                        <span className="savings__expense-name">{item.purchase}</span>
                        <StatusTrail status={item.status} />
                      </div>
                      <Amount cents={item.cents} />
                    </li>
                  ))}
                  {overview.data.reimbursements.paidCount >
                  overview.data.reimbursements.paid.length ? (
                    <li className="savings__empty">
                      Showing the {overview.data.reimbursements.paid.length} most recent of{" "}
                      {overview.data.reimbursements.paidCount}. The total below counts them all.
                    </li>
                  ) : null}
                  {/*
                    The lifetime total, here rather than beside the live
                    figures: it counts things that are finished, and it is
                    worth knowing how much has come back over time.
                  */}
                  <li className="savings__expense savings__paid-total">
                    <span className="savings__expense-name">Paid back in total</span>
                    <Amount cents={overview.data.reimbursements.paidCents} />
                  </li>
                </ul>
              ) : null}
            </>
          ) : null}

          {/*
            One line instead of three totals.

            It used to print Bought, Submitted and Paid back side by side,
            each counting only the expenses sitting at exactly that step. So
            "Bought $0.00" appeared beside two purchases that had plainly been
            bought - true in the sense meant, and read as a bug every time.

            The useful fact was never any single one of them: it is the gap.
            Anything bought and not submitted is the only part of this with
            something left for the household to do, so that is what the line
            says, and the warning below appears only when there is a gap to
            close. The paid-back total moved into the history, where the
            things it counts are.
          */}
          <p className="savings__progress">
            Submitted{" "}
            <span className="hr-amount">
              {formatCents(overview.data.reimbursements.submittedCents)}
            </span>{" "}
            of{" "}
            <span className="hr-amount">
              {formatCents(overview.data.reimbursements.outstandingCents)}
            </span>
          </p>

          {overview.data.reimbursements.awaitingSubmissionCents > 0n ? (
            <p className="savings__warning" role="status">
              Still to submit{" "}
              <span className="hr-amount">
                {formatCents(overview.data.reimbursements.awaitingSubmissionCents)}
              </span>
            </p>
          ) : null}

          <div className="savings__actions">
            <button
              className="hr-button"
              type="button"
              disabled={!canEdit}
              onClick={() => setOpen({ kind: "reimbursement" })}
            >
              Add a work expense
            </button>
          </div>
        </section>
      ) : null}

      {/* ---- Banked hours ---- */}
      {overview.isError ? <SectionUnavailable title="Banked hours" /> : null}
      {overview.data ? (
        <section className="hr-card savings__section">
          <header className="savings__section-head">
            <h2 className="savings__section-title">Banked hours</h2>
            {/* Hours, not money: never run through the currency formatter. */}
            <span className="savings__section-total hr-amount">
              {overview.data.bankedHours.total} h
            </span>
          </header>
          <p className="savings__note">Tracked per person, in hours.</p>

          <ul className="savings__hours">
            {overview.data.bankedHours.perPerson.map((person) => (
              <li className="savings__person" key={person.id}>
                <InitialBubble person={person} />
                <span className="savings__person-name">{person.name}</span>
                <span className="savings__person-hours hr-amount">{person.hours} h</span>
              </li>
            ))}
          </ul>

          {/*
            The entries behind the totals. Without them a total could only be
            trusted or not: there was no way to see what made it up, and no
            way to take a wrong one back out.
          */}
          {overview.data.bankedHours.entries.length > 0 ? (
            <>
              <button
                className="savings__more"
                type="button"
                aria-expanded={showEntries}
                onClick={() => setShowEntries((shown) => !shown)}
              >
                {showEntries
                  ? "Hide entries"
                  : `Show entries (${String(overview.data.bankedHours.entries.length)})`}
              </button>

              {showEntries ? (
                <ul className="savings__list">
                  {overview.data.bankedHours.entries.map((entry) => (
                    <li className="savings__entry" key={entry.id}>
                      <div className="savings__entry-main">
                        {/* Hours, never money. */}
                        <span className="savings__entry-hours hr-amount">{entry.hours} h</span>
                        <span className="savings__entry-who">
                          {overview.data.bankedHours.perPerson.find(
                            (person) => person.id === entry.userId,
                          )?.name ?? "Someone"}
                        </span>
                      </div>
                      <span className="savings__entry-note">
                        {formatDayMonthAndYear(entry.createdOn)}
                        {entry.note === null ? "" : ` \u00b7 ${entry.note}`}
                      </span>
                      <button
                        className="savings__advance"
                        type="button"
                        disabled={!canEdit || removeHours.isPending}
                        onClick={() => void dropHours(entry)}
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : null}

          <div className="savings__actions">
            <button
              className="hr-button"
              type="button"
              disabled={!canEdit}
              onClick={() => setOpen({ kind: "hours" })}
            >
              Add or take out hours
            </button>
          </div>
        </section>
      ) : null}

      <Link className="hr-card savings__link" to="/net-worth">
        <span>
          <strong>Net worth &amp; retirement</strong>
          <span className="savings__link-note">What you own, what you owe, and the outlook.</span>
        </span>
        <span aria-hidden="true">→</span>
      </Link>

      {open?.kind === "balance" ? (
        <SavingsBalanceSheet accounts={data.accounts} onClose={() => setOpen(null)} />
      ) : null}

      {open?.kind === "earmark" ? (
        <GoalForm
          existing={open.earmark === null ? null : asGoal(open.earmark)}
          onClose={() => setOpen(null)}
        />
      ) : null}

      {open?.kind === "mortgage" ? (
        <MortgageForm
          existing={data.mortgage}
          paySchedules={setup.data?.paySchedules ?? []}
          schedulesUnavailable={setup.isError}
          onClose={() => setOpen(null)}
        />
      ) : null}

      {open?.kind === "lumpSum" && data.mortgage ? (
        <LumpSumForm
          mortgageId={data.mortgage.id}
          existing={open.lumpSum}
          today={data.today}
          onClose={() => setOpen(null)}
        />
      ) : null}

      {open?.kind === "reimbursement" ? (
        <ReimbursementForm onClose={() => setOpen(null)} />
      ) : null}

      {open?.kind === "hours" && overview.data ? (
        <BankedHoursForm
          people={overview.data.bankedHours.perPerson}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * The mortgage panel.
 *
 * Ordered by what a decision needs, not by what is easiest to compute: what is
 * owing now, when it is gone, what the lump sums already planned are worth,
 * and what paying the money set aside would do. The allowance comes last
 * because it has never been close to binding.
 */
function MortgageSection({
  mortgage,
  today,
  canEdit,
  onEditTerms,
  onAddLumpSum,
  onEditLumpSum,
}: {
  mortgage: MortgagePanel | null;
  today: string;
  canEdit: boolean;
  onEditTerms: () => void;
  onAddLumpSum: () => void;
  onEditLumpSum: (lumpSum: LumpSum) => void;
}): React.JSX.Element {
  if (mortgage === null) {
    return (
      <section className="hr-card savings__section">
        <header className="savings__section-head">
          <h2 className="savings__section-title">Mortgage</h2>
        </header>
        <p className="savings__note">
          Add the mortgage and this shows when it is paid off, and what a lump sum would move that
          to. It also puts the extra payment on the Year screen, which is how a month with three
          payments stops being a surprise.
        </p>
        <div className="savings__actions">
          <button className="hr-button" type="button" disabled={!canEdit} onClick={onEditTerms}>
            Add the mortgage
          </button>
        </div>
      </section>
    );
  }

  const { plan, withoutFurther, plannedBuys, whatIf, room } = mortgage;

  return (
    <section className="hr-card savings__section">
      <header className="savings__section-head">
        <h2 className="savings__section-title">Mortgage</h2>
        <button
          className="savings__edit"
          type="button"
          disabled={!canEdit}
          onClick={onEditTerms}
          aria-label="Edit the mortgage details"
        >
          Details
        </button>
      </header>

      {mortgage.error !== null ? (
        <p className="hr-alert" role="alert">
          The stored terms cannot be worked forward: {mortgage.error}
        </p>
      ) : null}

      {plan ? (
        <>
          <div className="savings__mortgage-headline">
            <div>
              <p className="savings__balance-label">Owing today</p>
              <p className="savings__mortgage-amount hr-amount">
                {formatCents(plan.balanceTodayCents)}
              </p>
            </div>
            <div>
              <p className="savings__balance-label">Paid off</p>
              <p className="savings__mortgage-amount hr-amount">
                {formatDayMonthAndYear(plan.payoffDate)}
              </p>
            </div>
          </div>

          <p className="savings__note">
            {plan.remainingPaymentCount} payments to go
            {plan.nextPaymentDate
              ? `, the next on ${formatDateShort(plan.nextPaymentDate)}`
              : ""}
            . Each one is {formatCents(mortgage.paymentCents)}, every two weeks
            {/*
              Said the way it is actually set up, because the two are not the
              same thing: one moves if a pay anchor is corrected and the other
              does not.
            */}
            {mortgage.follows === null
              ? "."
              : ` — ${
                  mortgage.offsetDays === 0
                    ? "on"
                    : mortgage.offsetDays === 1
                      ? "the day after"
                      : `${String(mortgage.offsetDays)} days after`
                } ${mortgage.follows}'s pay.`}
          </p>

          {/*
            What the lump sums already on the plan are worth. This is the
            number that was impossible to see before: a year's intention, and
            what dropping it would cost.
          */}
          {plannedBuys && withoutFurther && plannedBuys.daysEarlier > 0 ? (
            <div className="savings__gain">
              <p className="savings__gain-title">
                The {formatCents(plannedBuys.lumpSumCents)} planned brings that forward{" "}
                {plannedBuys.daysEarlier} days
              </p>
              <p className="savings__gain-note">
                Without it the mortgage runs to {formatDayMonthAndYear(withoutFurther.payoffDate)},
                and costs {formatCents(plannedBuys.interestSavedCents)} more in interest.
              </p>
            </div>
          ) : null}

          {/* What the money set aside would do if it were paid now. */}
          {whatIf ? (
            <div className="savings__gain savings__gain--whatif">
              <p className="savings__gain-title">
                Paying {formatCents(whatIf.lumpSumCents)} today would move the payoff to{" "}
                {formatDayMonthAndYear(whatIf.payoffDate)}
              </p>
              <p className="savings__gain-note">
                {whatIf.daysEarlier} days sooner, {formatCents(whatIf.interestSavedCents)} less
                interest, {whatIf.paymentsSaved} fewer payments
                {whatIf.source === "earmark" ? " — that is the amount earmarked for it" : ""}.
              </p>
            </div>
          ) : null}
        </>
      ) : null}

      {/* ---- Lump sums ---- */}
      <h3 className="savings__subtitle">Lump sums</h3>

      {mortgage.prepayments.length === 0 ? (
        <p className="savings__empty">None recorded.</p>
      ) : (
        <ul className="savings__list">
          {mortgage.prepayments.map((lump) => (
            <li className="savings__lump" key={lump.id}>
              <div className="savings__lump-main">
                <span className="savings__lump-date">{formatDayMonthAndYear(lump.paidOn)}</span>
                <span className={`savings__tag${lump.paid ? "" : " savings__tag--planned"}`}>
                  {lump.paid ? "paid" : "planned"}
                </span>
                {lump.note ? <span className="savings__lump-note">{lump.note}</span> : null}
                {/*
                  Where the money came from, for the ones that are ledger
                  rows. This is the whole point of the change: a lump sum
                  used to be a figure with no account behind it, so nothing
                  on this screen could say the money had actually gone.
                */}
                {lump.fromAccountName !== null ? (
                  <span className="savings__lump-source">from {lump.fromAccountName}</span>
                ) : null}
              </div>
              <Amount cents={lump.cents} />
              {/*
                A lump sum that IS a ledger row has no copy here to edit: the
                row is the record, and it is changed where it lives. Offering
                an Edit that wrote to this screen's own table would create the
                second copy this design exists to avoid.
              */}
              {lump.occurrenceId === null ? (
                <button
                  className="savings__edit"
                  type="button"
                  disabled={!canEdit}
                  onClick={() => onEditLumpSum(lump)}
                  aria-label={`Edit the lump sum from ${formatDayMonthAndYear(lump.paidOn)}`}
                >
                  Edit
                </button>
              ) : (
                <Link
                  className="savings__edit"
                  to="/"
                  aria-label={`Change the lump sum from ${formatDayMonthAndYear(lump.paidOn)} on the ledger`}
                >
                  On the ledger
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}

      {room.isTracked ? (
        <p className="savings__note">
          {formatCents(room.roomCents)} of this year&rsquo;s {formatCents(room.capCents)} allowance
          is still free
          {room.plannedCents > 0n ? `, with ${formatCents(room.plannedCents)} planned` : ""}. It
          resets on {formatDayMonthAndYear(room.resetsOn)}.
        </p>
      ) : null}

      {/*
        Two different things, said plainly, because the difference is the one
        that was reported: a lump sum you have actually paid has to come out
        of an account, and only the ledger asks which.
      */}
      <p className="savings__note">
        A lump sum you have <strong>already paid</strong> is added on the ledger, as a one-off -
        that is where it says which account the money came out of, and it appears here once it
        is in. Plan one for later here instead.
      </p>

      <div className="savings__actions">
        <button className="hr-button" type="button" disabled={!canEdit} onClick={onAddLumpSum}>
          Plan a lump sum
        </button>
        <Link className="hr-button hr-button--secondary" to="/">
          Record one paid
        </Link>
      </div>

      <p className="hr-visually-hidden">Figures as at {today}.</p>
    </section>
  );
}

/**
 * What has happened to this expense so far: Bought, then Submitted, then
 * Paid back.
 *
 * Only the steps actually reached are drawn. All three used to show at once,
 * with the ones still to come greyed out, which made every row look the same
 * at a glance and put the word "Paid back" on an expense nobody had been
 * paid back for - readable as a label rather than as a prediction. What is
 * next is already on the button underneath.
 */
function StatusTrail({ status }: { status: Reimbursement["status"] }): React.JSX.Element {
  const steps = [
    { key: "bought", label: "Bought" },
    { key: "submitted", label: "Submitted" },
    { key: "paid", label: "Paid back" },
  ] as const;

  const reached = steps.slice(0, steps.findIndex((step) => step.key === status) + 1);

  return (
    <span className="savings__trail">
      {reached.map((step) => (
        <span key={step.key} className="savings__step">
          {step.label}
        </span>
      ))}
    </span>
  );
}
