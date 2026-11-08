/**
 * Savings (replaces the Goals screen).
 *
 * The household has one real savings account and is saving as hard as it can
 * in order to pay the mortgage off early with annual lump sums. Dax said it
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
import { LumpSumForm } from "../components/LumpSumForm.js";
import { MortgageForm } from "../components/MortgageForm.js";
import { ReimbursementForm } from "../components/ReimbursementForm.js";
import { SavingsBalanceSheet } from "../components/SavingsBalanceSheet.js";
import { ApiError, OfflineError } from "../lib/api.js";
import { useCreateAccount, useSetup } from "../lib/manageQueries.js";
import {
  useAdvanceReimbursement,
  useGoalsOverview,
  type GoalProgress,
  type Reimbursement,
} from "../lib/plannerQueries.js";
import { useSavings, type Earmark, type LumpSum, type MortgagePanel } from "../lib/savingsQueries.js";
import "./Savings.css";

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
  const createAccount = useCreateAccount();
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Open>(null);

  if (savings.isPending) {
    return (
      <div className="savings" aria-busy="true">
        <p className="hr-visually-hidden">Loading savings</p>
      </div>
    );
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

          {overview.data.reimbursements.items.length === 0 ? (
            <p className="savings__empty">Nothing outstanding.</p>
          ) : (
            <ul className="savings__list">
              {overview.data.reimbursements.items.map((item) => (
                <li className="savings__expense" key={item.id}>
                  <div className="savings__expense-main">
                    <span className="savings__expense-name">{item.purchase}</span>
                    <StatusTrail status={item.status} />
                  </div>

                  <Amount cents={item.cents} />

                  {item.status !== "paid" ? (
                    <button
                      className="savings__advance"
                      type="button"
                      disabled={!canEdit || advance.isPending}
                      onClick={() =>
                        void move(item, item.status === "bought" ? "submitted" : "paid")
                      }
                    >
                      {item.status === "bought" ? "Mark submitted" : "Mark paid back"}
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          <dl className="savings__totals">
            <div>
              <dt>Bought</dt>
              <dd className="hr-amount">
                {formatCents(overview.data.reimbursements.boughtCents)}
              </dd>
            </div>
            <div>
              <dt>Submitted</dt>
              <dd className="hr-amount">
                {formatCents(overview.data.reimbursements.submittedCents)}
              </dd>
            </div>
            <div>
              <dt>Paid back</dt>
              <dd className="hr-amount">{formatCents(overview.data.reimbursements.paidCents)}</dd>
            </div>
          </dl>

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

          <div className="savings__actions">
            <button
              className="hr-button"
              type="button"
              disabled={!canEdit}
              onClick={() => setOpen({ kind: "hours" })}
            >
              Add banked hours
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
              </div>
              <Amount cents={lump.cents} />
              <button
                className="savings__edit"
                type="button"
                disabled={!canEdit}
                onClick={() => onEditLumpSum(lump)}
                aria-label={`Edit the lump sum from ${formatDayMonthAndYear(lump.paidOn)}`}
              >
                Edit
              </button>
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

      <div className="savings__actions">
        <button className="hr-button" type="button" disabled={!canEdit} onClick={onAddLumpSum}>
          Add a lump sum
        </button>
      </div>

      <p className="hr-visually-hidden">Figures as at {today}.</p>
    </section>
  );
}

/** Bought → Submitted → Paid back, with the current step marked. */
function StatusTrail({ status }: { status: Reimbursement["status"] }): React.JSX.Element {
  const steps = [
    { key: "bought", label: "Bought" },
    { key: "submitted", label: "Submitted" },
    { key: "paid", label: "Paid back" },
  ] as const;

  const reachedIndex = steps.findIndex((step) => step.key === status);

  return (
    <span className="savings__trail">
      {steps.map((step, index) => (
        <span
          key={step.key}
          className={`savings__step ${index <= reachedIndex ? "savings__step--done" : ""}`}
        >
          {step.label}
        </span>
      ))}
    </span>
  );
}
