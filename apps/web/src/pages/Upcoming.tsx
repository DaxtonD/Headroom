/**
 * Upcoming (HANDOFF section 7.2).
 *
 * The full timeline, in the order the bank would apply it, with a running
 * balance on every line. This is the screen that replaces selecting a range
 * of cells in the spreadsheet to find out what the balance will be.
 */
import { formatCents, formatDateShort } from "@headroom/core";
import { useMemo, useState } from "react";
import { CoveragePill, VerificationBadge } from "../components/Badges.js";
import { OccurrenceRow, type MoveTarget } from "../components/OccurrenceRow.js";
import { usePatchOccurrence, useTimeline } from "../lib/queries.js";
import "./Upcoming.css";

export function Upcoming({ canEdit }: { canEdit: boolean }): React.JSX.Element {
  const timeline = useTimeline();
  const patch = usePatchOccurrence();
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const moveTargets = useMemo<MoveTarget[]>(() => {
    const rows = timeline.data?.rows ?? [];
    return [
      // A null anchor means "now", before the first upcoming paycheque.
      { id: null, label: "Now" },
      ...rows
        .filter((row) => row.kind === "paycheque" && row.date)
        .map((row) => ({ id: row.id, label: formatDateShort(row.date as string) })),
    ];
  }, [timeline.data?.rows]);

  if (timeline.isPending) {
    return (
      <div className="upcoming" aria-busy="true">
        <p className="hr-visually-hidden">Loading what is coming up</p>
      </div>
    );
  }

  if (timeline.isError || !timeline.data) {
    return (
      <div className="upcoming">
        <div className="hr-card upcoming__error">
          <h2>Could not load the timeline</h2>
          <p>The server did not answer. Nothing has been changed; reload to try again.</p>
        </div>
      </div>
    );
  }

  const data = timeline.data;

  return (
    <div className="upcoming">
      {/* ---- Summary strip ---- */}
      <section className="hr-card upcoming__summary">
        <div className="upcoming__summary-item">
          <p className="upcoming__summary-label">Chequing now</p>
          <p className="upcoming__summary-value hr-amount">
            {formatCents(data.startBalanceCents)}
          </p>
        </div>
        <div className="upcoming__summary-item">
          <p className="upcoming__summary-label">Lowest point</p>
          <p className="upcoming__summary-value hr-amount">{formatCents(data.lowest.cents)}</p>
          <p className="upcoming__summary-note">
            {data.lowest.date ? formatDateShort(data.lowest.date) : "right now"}
          </p>
        </div>
        <div className="upcoming__summary-item">
          <p className="upcoming__summary-label">Left at the end</p>
          <p className="upcoming__summary-value hr-amount">
            {formatCents(data.leftThisCycleCents)}
          </p>
          <p className="upcoming__summary-note">{formatDateShort(data.horizonEnd)}</p>
        </div>
      </section>

      {/* ---- Coverage banner ---- */}
      {data.coverage.allCovered ? (
        <div className="upcoming__banner upcoming__banner--ok">
          <CoveragePill allCovered count={data.coverage.autoWithdrawalCount} />
          <span>Every automatic withdrawal has the money waiting for it.</span>
        </div>
      ) : data.coverage.firstShortfall ? (
        <div className="upcoming__banner upcoming__banner--warn" role="alert">
          <strong>
            Not enough for {data.coverage.firstShortfall.name}
            {data.coverage.firstShortfall.date
              ? ` on ${formatDateShort(data.coverage.firstShortfall.date)}`
              : ""}
            : {formatCents(data.coverage.firstShortfall.shortCents)} short.
          </strong>
          <span>Move a flexible bill to a later payday.</span>
        </div>
      ) : null}

      {/* ---- Legend ---- */}
      <div className="upcoming__legend">
        <span className="upcoming__legend-item">
          <VerificationBadge verified />
          <span>The real amount, verified</span>
        </span>
        <span className="upcoming__legend-item">
          <VerificationBadge verified={false} />
          <span>Still an estimate</span>
        </span>
      </div>

      {/* ---- The timeline ---- */}
      {data.rows.length === 0 ? (
        <div className="hr-card upcoming__empty">
          <p>Nothing is coming up before {formatDateShort(data.horizonEnd)}.</p>
        </div>
      ) : (
        <ul className="hr-card upcoming__list">
          {data.rows.map((row) => (
            <OccurrenceRow
              key={row.id}
              row={row}
              expanded={expandedId === row.id}
              onToggle={() => setExpandedId(expandedId === row.id ? null : row.id)}
              canEdit={canEdit}
              moveTargets={moveTargets}
              onSave={(input) => patch.mutateAsync(input)}
            />
          ))}
        </ul>
      )}

      {/* ---- Footer ---- */}
      <section className="upcoming__footer">
        <p className="upcoming__footer-label">Left for gas, groceries & everyday</p>
        <p className="upcoming__footer-amount hr-amount">
          {formatCents(data.leftThisCycleCents)}
        </p>
        <p className="upcoming__footer-note">
          Through {formatDateShort(data.horizonEnd)}, the day before the next cheque after this
          cycle.
        </p>
      </section>
    </div>
  );
}
