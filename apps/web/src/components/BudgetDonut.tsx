/**
 * The budget ring.
 *
 * Asked for 2026-11-19: the household keeps a pie chart in the spreadsheet
 * and wanted it in the app, "and take it one further - tapping a slice drills
 * down into that expense and shows real numbers."
 *
 * ## Two decisions worth knowing
 *
 * **A ring rather than a solid pie.** The hole is where the drill-down lives:
 * tapping a wedge puts that expense's real figures in the middle of the chart
 * it came from, which is the whole point of the request. A solid pie would
 * have to put them somewhere else and the connection would be lost.
 *
 * **Eight wedges at most.** Past about seven, adjacent slices blur into each
 * other whatever colours they wear, and a ninth hue would be invented rather
 * than chosen from a set that has been checked for colour-blind separation.
 * So the tail folds into one "everything else" wedge - and because that wedge
 * can be tapped like any other, nothing is hidden: it opens into a ring of
 * its own. The spreadsheet draws twelve slices, six of which are under 3%
 * and unreadable; this shows the same money in a form that can be read.
 *
 * ## Why the slices are not the accessible control
 *
 * A 1.6% wedge is about five pixels of arc. It cannot be a 44px touch target
 * and no amount of care makes it one. So the list underneath is the real
 * control - full-width buttons, one per line, each carrying its colour, its
 * name and its amount. It is the legend, the table view and the keyboard path
 * at once. Tapping a wedge does the same thing as pressing its row, and the
 * svg is hidden from assistive technology because everything in it is said
 * better down there.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { formatCents, type Cents } from "@headroom/core";
import {
  arcPath,
  buildSlices,
  gapFor,
  liftOf,
  paintOrder,
  ringFor,
  sharePctOf,
  tweenSlices,
  type DonutDatum,
  type DonutSlice,
} from "../lib/donut.js";
import "./BudgetDonut.css";

/** The drawing, in its own coordinates. Scaled by CSS, never by these. */
const BOX = 200;
const CENTRE = BOX / 2;
const OUTER = 92;
/*
 * Just over half, so it still reads as a pie with a hole rather than as a
 * thin bracelet - and leaves room for an amount and a name in the middle.
 */
const INNER = 50;
/** How far the chosen wedge lifts out of the ring. */
const LIFT = 7;
/**
 * How much further out the chosen wedge reaches than the rest of the ring.
 *
 * Asked for 2026-11-21, of the thin wedges: "maybe zoom it a bit more?" The
 * lift alone moves a five-pixel sliver five pixels and leaves it a sliver.
 * Growing it outward as well gives it something to be seen as.
 *
 * Outward only, which is not a detail: a sector is narrowest at its inner
 * radius, so pulling that radius in would make the thin end of a thin wedge
 * thinner still. The angle - the only part of this that is data - never
 * changes.
 */
const GROW = 7;
/** The gap between two wedges, where the wedges can afford it. */
const GAP = 2;
/** The chosen wedge's outline, where it can afford it. */
const CHOSEN_STROKE = 1.5;
/** Long enough to follow, short enough not to be in the way. */
const MORPH_MS = 420;

/** Ease-out cubic: quick to commit, gentle to settle. */
function ease(t: number): number {
  const remaining = 1 - t;
  return 1 - remaining * remaining * remaining;
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export interface BudgetDonutProps {
  /** Names the chart for the text under it; not drawn inside the ring. */
  readonly title: string;
  readonly data: readonly DonutDatum[];
  /** The section total, shown in the middle when nothing is chosen. */
  readonly total: Cents;
  /** The line the page has selected, or null. */
  readonly selectedId: string | null;
  readonly onSelect: (id: string | null) => void;
  /**
   * Which ring is open: null for the top one, or the id of the folded wedge.
   * Held by the page so the list underneath shows the same lines.
   */
  readonly drillId: string | null;
  readonly onDrill: (id: string | null) => void;
}

export function BudgetDonut({
  title,
  data,
  total,
  selectedId,
  onSelect,
  drillId,
  onDrill,
}: BudgetDonutProps): React.JSX.Element | null {
  const target = useMemo(() => ringFor(data, drillId), [data, drillId]);

  /*
   * The ring part-way through a morph, or null when none is running - in
   * which case the target is simply drawn. Null rather than a copy of the
   * target so that the common case renders no extra state at all, and so
   * that nothing has to be set while the effect body runs: a morph only ever
   * publishes a frame from inside `requestAnimationFrame`.
   *
   * The ring a morph comes FROM, and the frame last drawn, are refs: neither
   * may cause a render, and both must survive the renders the animation
   * itself causes.
   */
  const [tween, setTween] = useState<DonutSlice[] | null>(null);
  const fromRef = useRef<DonutSlice[]>(target);
  const frameRef = useRef<DonutSlice[]>(target);

  useEffect(() => {
    const from = fromRef.current;
    // First render, or a rebuild that changed nothing worth animating.
    if (from === target) return;

    /*
     * Reduced motion arrives here with no frame ever published, so `tween`
     * is already null and the target is already what is drawn. Nothing to
     * set, which is also why there is no state change in this body.
     */
    if (prefersReducedMotion()) {
      fromRef.current = target;
      return;
    }

    const startedAt = performance.now();
    let frame = 0;

    const step = (now: number): void => {
      const elapsed = now - startedAt;
      const t = elapsed >= MORPH_MS ? 1 : elapsed / MORPH_MS;

      if (t >= 1) {
        fromRef.current = target;
        frameRef.current = target;
        setTween(null);
        return;
      }

      const next = tweenSlices(from, target, ease(t));
      frameRef.current = next;
      setTween(next);
      frame = requestAnimationFrame(step);
    };

    frame = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(frame);
      // Whatever was on screen is where the next morph starts, so an
      // interrupted one is continued rather than snapped back.
      fromRef.current = frameRef.current;
    };
  }, [target]);

  if (target.length === 0) return null;

  /** The target, except while a morph is publishing frames. */
  const shown = tween ?? target;

  const chosen = target.find((slice) => slice.id === selectedId) ?? null;
  const openedFrom =
    drillId === null ? null : buildSlices(data).find((slice) => slice.id === drillId) ?? null;

  /** What the middle says: the chosen line, or the whole of what is drawn. */
  const centre = chosen
    ? {
        name: chosen.name,
        cents: chosen.cents,
        note: `${sharePctOf(chosen).toFixed(1)}% of ${openedFrom ? openedFrom.name.toLowerCase() : title.toLowerCase()}`,
      }
    : {
        name: openedFrom ? openedFrom.name : title,
        cents: openedFrom ? openedFrom.cents : total,
        note: openedFrom ? `${openedFrom.members.length} lines` : "a month",
      };

  return (
    <div className="donut">
      <div className="donut__plot">
        {/*
          Hidden from assistive technology on purpose: every wedge is a row in
          the list below, which is a real button with the name and the amount
          written out. Repeating it here would be two readings of one fact.
        */}
        <svg
          className="donut__svg"
          viewBox={`0 0 ${BOX} ${BOX}`}
          aria-hidden="true"
          focusable="false"
        >
          {/*
            Painted in the ring's own order except for the chosen wedge, which
            goes last: svg has no z-index, and a lifted wedge drawn early
            comes out from under the ring underneath its own neighbours.
          */}
          {paintOrder(shown, selectedId).map((slice) => {
            const isChosen = slice.id === selectedId;
            const lift = isChosen ? liftOf(slice, LIFT) : { x: 0, y: 0 };
            const path = arcPath({
              cx: CENTRE,
              cy: CENTRE,
              outer: isChosen ? OUTER + GROW : OUTER,
              inner: INNER,
              start: slice.start,
              end: slice.end,
            });
            if (path === "") return null;

            return (
              <g
                className="donut__wedge"
                key={slice.id}
                style={{ transform: `translate(${lift.x.toFixed(2)}px, ${lift.y.toFixed(2)}px)` }}
              >
                <path
                  d={path}
                  className={`donut__slice${isChosen ? " donut__slice--chosen" : ""}`}
                  style={{
                    fill: `var(--hr-series-${slice.slot + 1})`,
                    /*
                      The gap between wedges and the chosen wedge's outline
                      are the same stroke, and both have to fit inside the
                      wedge they are drawn on. `gapFor` says what this one can
                      spare; the colour stays in the stylesheet, where the
                      theme is.
                    */
                    strokeWidth: gapFor(slice, INNER, isChosen ? CHOSEN_STROKE : GAP).toFixed(2),
                  }}
                  onClick={() => {
                    if (slice.members.length > 0) {
                      onDrill(slice.id);
                      onSelect(null);
                    } else {
                      onSelect(isChosen ? null : slice.id);
                    }
                  }}
                />
              </g>
            );
          })}
        </svg>

        {/*
          The middle, as ordinary HTML over the hole rather than SVG text: it
          wears the app's fonts and the money formatter, wraps when a name is
          long, and scales with the text-size setting like everything else.
        */}
        <div className="donut__centre" aria-hidden="true">
          <span className="donut__centre-amount hr-amount">{formatCents(centre.cents)}</span>
          <span className="donut__centre-name">{centre.name}</span>
          <span className="donut__centre-note">{centre.note}</span>
        </div>
      </div>

      {drillId !== null ? (
        <button
          type="button"
          className="hr-button donut__back"
          onClick={() => {
            onDrill(null);
            onSelect(null);
          }}
        >
          Back to all of {title.toLowerCase()}
        </button>
      ) : null}
    </div>
  );
}
