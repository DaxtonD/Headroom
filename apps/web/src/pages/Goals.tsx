/**
 * Goals (HANDOFF section 7.5).
 *
 * The trip fund's progress, the work purchases put on the Visa and tracked
 * until the employer pays them back, banked hours, and the way through to
 * Net worth.
 *
 * Banked hours are the one quantity here that is not money: hours only, with
 * no dollar conversion (section 14 q11), which is why they are never passed
 * through the money formatter.
 */
import { formatCents } from "@headroom/core";
import { useState } from "react";
import { Link } from "react-router";
import { Amount, InitialBubble } from "../components/Badges.js";
import { BankedHoursForm } from "../components/BankedHoursForm.js";
import { GoalForm } from "../components/GoalForm.js";
import { ReimbursementForm } from "../components/ReimbursementForm.js";
import { ApiError, OfflineError } from "../lib/api.js";
import {
  useAdvanceReimbursement,
  useGoalsOverview,
  type GoalProgress,
  type Reimbursement,
} from "../lib/plannerQueries.js";
import "./Goals.css";

/**
 * Which sheet is open.
 *
 * Editing lives here as well as on Manage on purpose: the natural moment to
 * correct a goal is while looking at how far along it is.
 */
type Open =
  | { readonly kind: "goal"; readonly goal: GoalProgress | null }
  | { readonly kind: "reimbursement" }
  | { readonly kind: "hours" }
  | null;

export function Goals({ canEdit }: { canEdit: boolean }): React.JSX.Element {
  const overview = useGoalsOverview();
  const advance = useAdvanceReimbursement();
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Open>(null);

  if (overview.isPending) {
    return (
      <div className="goals" aria-busy="true">
        <p className="hr-visually-hidden">Loading goals</p>
      </div>
    );
  }

  if (overview.isError || !overview.data) {
    return (
      <div className="goals">
        <div className="hr-card goals__error">
          <h2>Could not load goals</h2>
          <p>The server did not answer. Nothing has been changed; reload to try again.</p>
        </div>
      </div>
    );
  }

  const data = overview.data;

  const move = async (item: Reimbursement, to: "submitted" | "paid"): Promise<void> => {
    setError(null);
    try {
      await advance.mutateAsync({ id: item.id, version: item.version, to });
    } catch (caught) {
      if (caught instanceof OfflineError || caught instanceof ApiError) setError(caught.message);
      else setError(`Could not update ${item.purchase}. Please try again.`);
    }
  };

  return (
    <div className="goals">
      {error ? (
        <p className="hr-alert" role="alert">
          {error}
        </p>
      ) : null}

      {/* ---- Savings goals ---- */}
      <section className="hr-card goals__section">
        <h2 className="goals__section-title">Saving for</h2>

        {data.goals.length === 0 ? (
          <p className="goals__empty">No goals yet.</p>
        ) : (
          <ul className="goals__list">
            {data.goals.map((goal) => (
              <li className="goals__goal" key={goal.id}>
                <div className="goals__goal-head">
                  <span className="goals__goal-name">{goal.name}</span>
                  {goal.pct !== null ? <span className="goals__goal-pct">{goal.pct}%</span> : null}
                  <button
                    className="goals__edit"
                    type="button"
                    disabled={!canEdit}
                    onClick={() => setOpen({ kind: "goal", goal })}
                    aria-label={`Edit ${goal.name}`}
                  >
                    Edit
                  </button>
                </div>

                {/*
                  No target means no bar. A trip has no set cost, so there is
                  nothing to be a fraction of, and a bar against an invented
                  target would be the fiction this screen is meant to avoid.
                */}
                {goal.targetCents !== null && goal.pct !== null ? (
                  <div
                    className="goals__progress"
                    role="img"
                    aria-label={`${formatCents(goal.savedCents)} saved of ${formatCents(goal.targetCents)}, ${goal.pct}%`}
                  >
                    <span
                      className="goals__progress-fill"
                      /* Capped so an overshot goal does not overflow the track. */
                      style={{ width: `${Math.min(100, goal.pct)}%` }}
                    />
                  </div>
                ) : null}

                <p className="goals__goal-note">
                  <strong className="hr-amount">{formatCents(goal.savedCents)}</strong>
                  {goal.targetCents === null ? (
                    <> set aside</>
                  ) : (
                    <>
                      {" of "}
                      <span className="hr-amount">{formatCents(goal.targetCents)}</span>
                      {goal.remainingCents !== null && goal.remainingCents > 0n ? (
                        <> · {formatCents(goal.remainingCents)} to go</>
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

        <div className="goals__actions">
          <button
            className="hr-button"
            type="button"
            disabled={!canEdit}
            onClick={() => setOpen({ kind: "goal", goal: null })}
          >
            Add a goal
          </button>
        </div>
      </section>

      {/* ---- Work expenses ---- */}
      <section className="hr-card goals__section">
        <header className="goals__section-head">
          <h2 className="goals__section-title">Work expenses</h2>
          <Amount cents={data.reimbursements.outstandingCents} className="goals__section-total" />
        </header>
        <p className="goals__note">
          Put on the Visa for work, tracked until it comes back. The figure above is what is
          still owed to you.
        </p>

        {data.reimbursements.items.length === 0 ? (
          <p className="goals__empty">Nothing outstanding.</p>
        ) : (
          <ul className="goals__list">
            {data.reimbursements.items.map((item) => (
              <li className="goals__expense" key={item.id}>
                <div className="goals__expense-main">
                  <span className="goals__expense-name">{item.purchase}</span>
                  <StatusTrail status={item.status} />
                </div>

                <Amount cents={item.cents} />

                {item.status !== "paid" ? (
                  <button
                    className="goals__advance"
                    type="button"
                    disabled={!canEdit || advance.isPending}
                    onClick={() => void move(item, item.status === "bought" ? "submitted" : "paid")}
                  >
                    {item.status === "bought" ? "Mark submitted" : "Mark paid back"}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        <dl className="goals__totals">
          <div>
            <dt>Bought</dt>
            <dd className="hr-amount">{formatCents(data.reimbursements.boughtCents)}</dd>
          </div>
          <div>
            <dt>Submitted</dt>
            <dd className="hr-amount">{formatCents(data.reimbursements.submittedCents)}</dd>
          </div>
          <div>
            <dt>Paid back</dt>
            <dd className="hr-amount">{formatCents(data.reimbursements.paidCents)}</dd>
          </div>
        </dl>

        <div className="goals__actions">
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

      {/* ---- Banked hours ---- */}
      <section className="hr-card goals__section">
        <header className="goals__section-head">
          <h2 className="goals__section-title">Banked hours</h2>
          {/* Hours, not money: never run through the currency formatter. */}
          <span className="goals__section-total hr-amount">{data.bankedHours.total} h</span>
        </header>
        <p className="goals__note">Tracked per person, in hours.</p>

        <ul className="goals__hours">
          {data.bankedHours.perPerson.map((person) => (
            <li className="goals__person" key={person.id}>
              <InitialBubble person={person} />
              <span className="goals__person-name">{person.name}</span>
              <span className="goals__person-hours hr-amount">{person.hours} h</span>
            </li>
          ))}
        </ul>

        <div className="goals__actions">
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

      <Link className="hr-card goals__link" to="/net-worth">
        <span>
          <strong>Net worth &amp; retirement</strong>
          <span className="goals__link-note">What you own, what you owe, and the outlook.</span>
        </span>
        <span aria-hidden="true">→</span>
      </Link>

      {open?.kind === "goal" ? (
        <GoalForm existing={open.goal} onClose={() => setOpen(null)} />
      ) : null}

      {open?.kind === "reimbursement" ? (
        <ReimbursementForm onClose={() => setOpen(null)} />
      ) : null}

      {open?.kind === "hours" ? (
        <BankedHoursForm
          people={data.bankedHours.perPerson}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </div>
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
    <span className="goals__trail">
      {steps.map((step, index) => (
        <span
          key={step.key}
          className={`goals__step ${index <= reachedIndex ? "goals__step--done" : ""}`}
        >
          {step.label}
        </span>
      ))}
    </span>
  );
}
