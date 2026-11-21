/**
 * The arithmetic behind the budget donut.
 *
 * Pure: angles in, path strings out, no React and no DOM. It is here rather
 * than inside the component for the reason every other rule in this app is in
 * one place - a chart that disagrees with the list beside it is worse than no
 * chart, and the only way to know they agree is to test the numbers with
 * values.
 *
 * Angles are radians measured clockwise from twelve o'clock, which is where a
 * reader expects a share to start. SVG's own angle zero is three o'clock, so
 * the conversion happens once, here, in `pointOn`.
 *
 * Money is `bigint` everywhere in Headroom and stays that way: the shares are
 * computed from the cents themselves rather than from the rounded percentage
 * the API also sends, so two lines a cent apart cannot come out as equal
 * wedges. The angle a slice ends up with is an ordinary number, because an
 * angle is geometry and not money.
 */

/** One thing a slice can be about. */
export interface DonutDatum {
  readonly id: string;
  readonly name: string;
  /** A positive magnitude. A line costing nothing has no wedge. */
  readonly cents: bigint;
}

export interface DonutSlice extends DonutDatum {
  /** Radians clockwise from twelve o'clock. */
  readonly start: number;
  readonly end: number;
  /**
   * Which categorical colour this wears, 0-7.
   *
   * By rank within this ring, assigned once and never cycled. Eight is the
   * whole validated palette; a ninth hue would be invented rather than
   * chosen, and adjacent classes blur past about seven anyway.
   */
  readonly slot: number;
  /**
   * What this slice folds together, for the "Other" wedge. Empty on a slice
   * that is one real line - which is how a caller knows whether tapping it
   * drills in or opens a figure.
   */
  readonly members: readonly DonutDatum[];
}

/** How many wedges a ring may draw before the tail is folded away. */
export const MAX_SLICES = 8;

/** The name the folded tail goes by, in one place so the tests can say it. */
export const OTHER_NAME = "Everything else";

const TAU = Math.PI * 2;

/**
 * The slices for one ring, largest first.
 *
 * Lines costing nothing are dropped rather than drawn as a zero-width wedge
 * nobody can tap. More than `MAX_SLICES` and the tail folds into one slice
 * that carries its members, so the ring stays inside the palette and the
 * detail is still reachable by tapping it.
 */
export function buildSlices(
  data: readonly DonutDatum[],
  maxSlices: number = MAX_SLICES,
): DonutSlice[] {
  const spending = data.filter((datum) => datum.cents > 0n);
  if (spending.length === 0) return [];

  const ranked = [...spending].sort((a, b) => {
    if (a.cents === b.cents) return a.name.localeCompare(b.name);
    return a.cents > b.cents ? -1 : 1;
  });

  const shown: DonutDatum[] = [];
  const folded: DonutDatum[] = [];

  if (ranked.length <= maxSlices) {
    shown.push(...ranked);
  } else {
    shown.push(...ranked.slice(0, maxSlices - 1));
    folded.push(...ranked.slice(maxSlices - 1));
  }

  const tail: DonutDatum | null =
    folded.length === 0
      ? null
      : {
          id: "__other__",
          name: OTHER_NAME,
          cents: folded.reduce((sum, datum) => sum + datum.cents, 0n),
        };

  const wedges = tail ? [...shown, tail] : shown;
  const total = wedges.reduce((sum, datum) => sum + datum.cents, 0n);
  if (total === 0n) return [];

  const slices: DonutSlice[] = [];
  let consumed = 0n;

  wedges.forEach((datum, index) => {
    const start = Number(consumed) / Number(total);
    consumed += datum.cents;
    /*
     * The running total decides both edges, so the wedges tile exactly and
     * the last one lands on the full turn. Taking each wedge's own share and
     * adding them up instead leaves a hairline gap that grows with the count.
     */
    const end = Number(consumed) / Number(total);

    slices.push({
      ...datum,
      start: start * TAU,
      end: end * TAU,
      slot: index,
      members: datum === tail ? folded : [],
    });
  });

  return slices;
}

/** Where an angle lands on a circle, in SVG coordinates. */
export function pointOn(
  cx: number,
  cy: number,
  radius: number,
  angle: number,
): { x: number; y: number } {
  // Clockwise from twelve o'clock, which is a quarter turn behind SVG's zero.
  const fromSvgZero = angle - Math.PI / 2;
  return {
    x: cx + radius * Math.cos(fromSvgZero),
    y: cy + radius * Math.sin(fromSvgZero),
  };
}

/** Trimmed to three places: more is noise in the DOM, less is visible. */
function round(value: number): string {
  return value.toFixed(3).replace(/\.?0+$/, "");
}

/**
 * One annulus sector, as an SVG path.
 *
 * A wedge that covers the whole turn is drawn as two half turns, because an
 * arc whose ends are the same point draws nothing at all - the single-line
 * section would vanish instead of being a complete ring.
 */
export function arcPath(options: {
  readonly cx: number;
  readonly cy: number;
  readonly outer: number;
  readonly inner: number;
  readonly start: number;
  readonly end: number;
}): string {
  const { cx, cy, outer, inner, start, end } = options;
  const sweep = end - start;
  if (sweep <= 0) return "";

  if (sweep >= TAU - 1e-9) {
    const top = pointOn(cx, cy, outer, 0);
    const bottom = pointOn(cx, cy, outer, Math.PI);
    const innerTop = pointOn(cx, cy, inner, 0);
    const innerBottom = pointOn(cx, cy, inner, Math.PI);
    return [
      `M ${round(top.x)} ${round(top.y)}`,
      `A ${round(outer)} ${round(outer)} 0 1 1 ${round(bottom.x)} ${round(bottom.y)}`,
      `A ${round(outer)} ${round(outer)} 0 1 1 ${round(top.x)} ${round(top.y)}`,
      `M ${round(innerTop.x)} ${round(innerTop.y)}`,
      `A ${round(inner)} ${round(inner)} 0 1 0 ${round(innerBottom.x)} ${round(innerBottom.y)}`,
      `A ${round(inner)} ${round(inner)} 0 1 0 ${round(innerTop.x)} ${round(innerTop.y)}`,
      "Z",
    ].join(" ");
  }

  const largeArc = sweep > Math.PI ? 1 : 0;
  const outerStart = pointOn(cx, cy, outer, start);
  const outerEnd = pointOn(cx, cy, outer, end);
  const innerEnd = pointOn(cx, cy, inner, end);
  const innerStart = pointOn(cx, cy, inner, start);

  return [
    `M ${round(outerStart.x)} ${round(outerStart.y)}`,
    `A ${round(outer)} ${round(outer)} 0 ${largeArc} 1 ${round(outerEnd.x)} ${round(outerEnd.y)}`,
    `L ${round(innerEnd.x)} ${round(innerEnd.y)}`,
    `A ${round(inner)} ${round(inner)} 0 ${largeArc} 0 ${round(innerStart.x)} ${round(innerStart.y)}`,
    "Z",
  ].join(" ");
}

/**
 * How far to nudge a selected wedge out of the ring, and in which direction.
 *
 * Along its own bisector, so it reads as the same wedge lifted rather than a
 * new shape. The distance is small on purpose: enough to see, not enough to
 * leave a gap the eye reads as another category.
 */
export function liftOf(
  slice: Pick<DonutSlice, "start" | "end">,
  distance: number,
): { x: number; y: number } {
  const middle = (slice.start + slice.end) / 2;
  const point = pointOn(0, 0, distance, middle);
  return { x: point.x, y: point.y };
}

/**
 * A ring part-way between two rings, for the drill-down.
 *
 * Matched by id where an id appears in both, so a line that survives the
 * drill slides from its old wedge to its new one instead of being redrawn.
 * Anything only in one of them opens from, or closes to, a zero-width wedge
 * at the place it belongs - which is what makes the ring look like it is
 * folding rather than flickering.
 *
 * `t` runs 0 (from) to 1 (to) and is clamped, so an overshooting easing
 * curve cannot produce an angle outside the turn.
 */
export function tweenSlices(
  from: readonly DonutSlice[],
  to: readonly DonutSlice[],
  t: number,
): DonutSlice[] {
  const progress = t < 0 ? 0 : t > 1 ? 1 : t;
  const before = new Map(from.map((slice) => [slice.id, slice]));

  return to.map((slice) => {
    const was = before.get(slice.id);
    // Not in the old ring: open it from a hairline at its own leading edge.
    const start = was?.start ?? slice.start;
    const end = was?.end ?? slice.start;

    return {
      ...slice,
      start: start + (slice.start - start) * progress,
      end: end + (slice.end - end) * progress,
    };
  });
}

/** `0.372` of the turn, as a percentage a person would read. */
export function sharePctOf(slice: Pick<DonutSlice, "start" | "end">): number {
  return ((slice.end - slice.start) / TAU) * 100;
}

/**
 * The slices for whichever ring is open.
 *
 * `drillId` names a folded wedge to open, or is null for the top ring. A
 * drill into something that is not folded falls back to the top ring rather
 * than drawing nothing: the ring the caller is looking at may have been
 * rebuilt underneath it by a figure changing.
 */
export function ringFor(
  data: readonly DonutDatum[],
  drillId: string | null,
): DonutSlice[] {
  const top = buildSlices(data);
  if (drillId === null) return top;

  const folded = top.find((slice) => slice.id === drillId);
  if (!folded || folded.members.length === 0) return top;

  return buildSlices(folded.members);
}

/**
 * The colour a list row should wear.
 *
 * Here rather than in the component because the list is the ring's legend,
 * and a legend that works its colours out separately from the chart is a
 * legend that can disagree with it. A line folded into "everything else"
 * wears that wedge's colour, which is the honest answer: that is the wedge it
 * is part of.
 */
export function slotOf(slices: readonly DonutSlice[], id: string): number | null {
  const own = slices.find((slice) => slice.id === id);
  if (own) return own.slot;

  const folded = slices.find((slice) => slice.members.some((member) => member.id === id));
  return folded ? folded.slot : null;
}

/**
 * How wide a gap one wedge can afford between itself and its neighbour.
 *
 * The 2px gap in the surface colour is what keeps two wedges of similar hue
 * reading as two, and for most of the ring it costs nothing. On a thin wedge
 * it is the whole wedge: the stroke is centred on the path, so it eats half
 * its width inward from each of the two radial edges, and a 1.6% wedge is
 * about five units across at the inner radius. Two units of stroke then
 * covers two fifths of the only fill there was. That is what was reported -
 * "small slices look like they're behind the other slices, and the thick
 * white border is more than the slice" - and the fill was never behind
 * anything. It was underneath its own gap.
 *
 * So the gap is a quarter of the wedge's narrowest crossing, capped at the
 * full width it would otherwise have. Three quarters of the mark survives at
 * every size, which is the one promise worth making here: a gap exists to
 * separate two marks and must never become more of the mark than the fill is.
 *
 * Measured at the INNER radius because that is where a sector is narrowest.
 */
export function gapFor(
  slice: Pick<DonutSlice, "start" | "end">,
  inner: number,
  max: number,
): number {
  const narrowest = (slice.end - slice.start) * inner;
  if (narrowest <= 0) return 0;

  const affordable = narrowest / 4;
  return affordable >= max ? max : affordable;
}

/**
 * The wedges in the order they should be painted, chosen one last.
 *
 * SVG has no z-index: the last sibling wins. The ring is built largest first,
 * so the thin wedges at the end of it are already on top of everything - but
 * the chosen wedge lifts out of the ring and grows past it, and a chosen
 * wedge painted early does both of those things UNDERNEATH its smaller
 * neighbours. Moving it to the end is the whole fix, and it leaves the order
 * of every other wedge alone so nothing else changes depth as the selection
 * moves.
 *
 * The slices keep their ids, so React moves the existing nodes rather than
 * rebuilding them and the lift goes on animating through the reorder.
 */
export function paintOrder(
  slices: readonly DonutSlice[],
  chosenId: string | null,
): DonutSlice[] {
  const ordered = [...slices];
  if (chosenId === null) return ordered;

  const at = ordered.findIndex((slice) => slice.id === chosenId);
  if (at < 0) return ordered;

  const [chosen] = ordered.splice(at, 1);
  if (chosen) ordered.push(chosen);
  return ordered;
}
