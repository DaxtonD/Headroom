/**
 * Pay plan (HANDOFF section 7.3).
 *
 * One two-week window at a time, broken into what comes in, what the bank
 * takes automatically, and what is flexible — then the result: what is left
 * over, and the lowest the balance gets inside the window.
 *
 * The flexible section is the point of this screen. When money is tight in one
 * window, a bill can be moved to an earlier or later payday, and both windows
 * recalculate. On a phone that is a move button per row; on a desktop the rows
 * can also be dragged between periods.
 */
import { formatCents, formatDateShort } from "@headroom/core";
import { useState } from "react";
import { Amount, Chip, CoveragePill, VerificationBadge } from "../components/Badges.js";
import { ApiError, OfflineError, newIdempotencyKey } from "../lib/api.js";
import {
  conflictFrom,
  usePatchOccurrence,
  usePayPeriods,
  type PayPeriod,
  type TimelineRow,
} from "../lib/queries.js";
import "./PayPlan.css";

export function PayPlan({ canEdit }: { canEdit: boolean }): React.JSX.Element {
  const payPeriods = usePayPeriods();
  const patch = usePatchOccurrence();

  const [selected, setSelected] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [dragging, setDragging] = useState<TimelineRow | null>(null);

  if (payPeriods.isPending) {
    return (
      <div className="payplan" aria-busy="true">
        <p className="hr-visually-hidden">Loading the pay plan</p>
      </div>
    );
  }

  if (payPeriods.isError || !payPeriods.data) {
    return (
      <div className="payplan">
        <div className="hr-card payplan__error">
          <h2>Could not load the pay plan</h2>
          <p>The server did not answer. Nothing has been changed; reload to try again.</p>
        </div>
      </div>
    );
  }

  const periods = payPeriods.data.periods;
  const period = periods[Math.min(selected, periods.length - 1)];

  if (!period) {
    return (
      <div className="payplan">
        <div className="hr-card payplan__error">
          <h2>No pay periods yet</h2>
          <p>Pay periods come from each person's pay schedule. Add those and they appear here.</p>
        </div>
      </div>
    );
  }

  /**
   * Move a flexible bill to another window.
   *
   * The anchor is the first paycheque of the target window; a window with no
   * paycheque on the timeline cannot take one yet, so its button is disabled.
   */
  const moveTo = async (row: TimelineRow, target: PayPeriod): Promise<void> => {
    const anchor = target.isCurrentPartial
      ? null
      : target.rows.find((candidate) => candidate.kind === "paycheque")?.id;

    if (anchor === undefined) {
      setError(`There is no paycheque in ${target.label} yet to attach ${row.name} to.`);
      return;
    }

    setError(null);
    setMovingId(row.id);

    try {
      await patch.mutateAsync({
        id: row.id,
        baseVersion: row.version,
        changes: { anchorOccurrenceId: anchor },
        idempotencyKey: newIdempotencyKey(),
      });
    } catch (caught) {
      const conflict = conflictFrom(caught);
      if (conflict) {
        setError(
          `${conflict.changedBy.name} changed ${row.name} first. Open it on Upcoming to see what they did.`,
        );
      } else if (caught instanceof OfflineError || caught instanceof ApiError) {
        setError(caught.message);
      } else {
        setError(`Could not move ${row.name}. Please try again.`);
      }
    } finally {
      setMovingId(null);
    }
  };

  const comingIn = period.rows.filter((row) => row.cents > 0n);
  const autoOut = period.rows.filter((row) => row.cents < 0n && row.placement === "auto");
  const flexibleOut = period.rows.filter((row) => row.cents < 0n && row.placement === "flexible");

  const otherPeriods = periods.filter((candidate) => candidate.label !== period.label);

  return (
    <div className="payplan">
      {/* ---- Period chips ---- */}
      <nav className="payplan__chips" aria-label="Pay periods">
        {periods.map((candidate, index) => (
          <button
            key={candidate.label}
            className={`payplan__chip ${index === selected ? "payplan__chip--active" : ""}`}
            type="button"
            aria-current={index === selected}
            onClick={() => setSelected(index)}
          >
            {candidate.label}
          </button>
        ))}
      </nav>

      {error ? (
        <p className="hr-alert" role="alert">
          {error}
        </p>
      ) : null}

      {/* ---- Coming in ---- */}
      <section className="hr-card payplan__section">
        <header className="payplan__section-head">
          <h2 className="payplan__section-title">Coming in</h2>
          <Amount cents={period.inCents} className="payplan__section-total" />
        </header>

        {period.isCurrentPartial ? (
          <p className="payplan__note">
            This period starts today, so it opens with what is already in chequing.
          </p>
        ) : null}

        <ul className="payplan__rows">
          {comingIn.map((row) => (
            <li className="payplan__row" key={row.id}>
              <span className="payplan__row-main">
                <span className="payplan__row-name">{row.name}</span>
                {row.date ? <Chip tone="payday">{formatDateShort(row.date)}</Chip> : null}
              </span>
              <Amount cents={row.cents} signed />
            </li>
          ))}

          {period.projectedPaycheques.map((cheque) => (
            <li className="payplan__row payplan__row--projected" key={`${cheque.scheduleId}|${cheque.date}`}>
              <span className="payplan__row-main">
                <span className="payplan__row-name">
                  {cheque.owner ? `${cheque.owner.name}'s pay` : "Expected pay"}
                </span>
                <Chip tone="neutral">Expected · {formatDateShort(cheque.date)}</Chip>
              </span>
              <Amount cents={cheque.cents} signed />
            </li>
          ))}

          {comingIn.length === 0 && period.projectedPaycheques.length === 0 ? (
            <li className="payplan__empty">Nothing arrives in this period.</li>
          ) : null}
        </ul>
      </section>

      {/* ---- Automatic withdrawals ---- */}
      <section className="hr-card payplan__section">
        <header className="payplan__section-head">
          <h2 className="payplan__section-title">Automatic withdrawals</h2>
          <Amount cents={-period.autoCents} className="payplan__section-total" />
        </header>

        <p className="payplan__note">
          These come out on their own dates. The money has to be there.
        </p>

        <ul className="payplan__rows">
          {autoOut.map((row) => (
            <li className="payplan__row" key={row.id}>
              <VerificationBadge verified={row.verified} verifiedBy={row.verifiedBy} />
              <span className="payplan__row-main">
                <span className="payplan__row-name">{row.name}</span>
                {row.date ? <Chip tone="neutral">{formatDateShort(row.date)}</Chip> : null}
              </span>
              <Amount cents={row.cents} signed />
            </li>
          ))}
          {autoOut.length === 0 ? (
            <li className="payplan__empty">Nothing comes out automatically in this period.</li>
          ) : null}
        </ul>

        <footer className="payplan__section-foot">
          <CoveragePill allCovered={period.allAutoCovered} count={autoOut.length} />
        </footer>
      </section>

      {/* ---- Flexible bills ---- */}
      <section className="hr-card payplan__section">
        <header className="payplan__section-head">
          <h2 className="payplan__section-title">Flexible bills</h2>
          <Amount cents={-period.flexibleCents} className="payplan__section-total" />
        </header>

        <p className="payplan__note">
          These can move to another payday when money is tight. Everything
          recalculates when they do.
        </p>

        <ul className="payplan__rows">
          {flexibleOut.map((row) => (
            <li
              className={`payplan__row payplan__row--flexible ${movingId === row.id ? "payplan__row--moving" : ""}`}
              key={row.id}
              // Desktop affordance. The move buttons below do the same thing
              // and are the only route on a phone, where dragging between
              // periods is not possible.
              draggable={canEdit}
              onDragStart={() => setDragging(row)}
              onDragEnd={() => setDragging(null)}
            >
              <span className="payplan__drag" aria-hidden="true">
                ⠿
              </span>
              <VerificationBadge verified={row.verified} verifiedBy={row.verifiedBy} />
              <span className="payplan__row-main">
                <span className="payplan__row-name">{row.name}</span>
                <Chip tone="flexible">Flexible</Chip>
              </span>
              <Amount cents={row.cents} signed />

              <span className="payplan__moves">
                {otherPeriods.map((target) => (
                  <button
                    key={target.label}
                    className="payplan__move"
                    type="button"
                    disabled={!canEdit || movingId !== null}
                    onClick={() => void moveTo(row, target)}
                    title={`Move ${row.name} to ${target.label}`}
                  >
                    {target.label}
                  </button>
                ))}
              </span>
            </li>
          ))}
          {flexibleOut.length === 0 ? (
            <li className="payplan__empty">No flexible bills in this period.</li>
          ) : null}
        </ul>
      </section>

      {/* ---- Drop targets, for dragging on a desktop ---- */}
      {dragging ? (
        <section className="payplan__drops" aria-hidden="true">
          <p className="payplan__drops-label">Drop {dragging.name} on a period</p>
          <div className="payplan__drops-row">
            {otherPeriods.map((target) => (
              <div
                key={target.label}
                className="payplan__drop"
                onDragOver={(event) => event.preventDefault()}
                onDrop={() => {
                  const row = dragging;
                  setDragging(null);
                  if (row) void moveTo(row, target);
                }}
              >
                {target.label}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {/* ---- The result ---- */}
      <section className="payplan__result">
        <p className="payplan__result-label">Left over</p>
        <p className="payplan__result-amount hr-amount">{formatCents(period.leftCents)}</p>
        <p className="payplan__result-note">
          {formatCents(period.inCents)} in, less {formatCents(period.autoCents)} automatic and{" "}
          {formatCents(period.flexibleCents)} flexible.
        </p>

        {period.lowest ? (
          <p className="payplan__result-lowest">
            Lowest inside this period: <strong>{formatCents(period.lowest.cents)}</strong>
            {period.lowest.date ? ` on ${formatDateShort(period.lowest.date)}` : ""}
          </p>
        ) : null}
      </section>
    </div>
  );
}
