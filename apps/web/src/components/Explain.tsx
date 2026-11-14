/**
 * "Where did that number come from?"
 *
 * An info button beside each headline figure that shows the arithmetic behind
 * it, with the household's own amounts in it. Asked for for the moment
 * somebody looks at a figure and cannot see how it was arrived at - which is
 * most likely with "safe to spend now", because it is not the subtraction
 * anybody assumes it is.
 *
 * The figures come from the engine, by way of the dashboard, rather than being
 * worked out again here. An explanation that could disagree with the number it
 * explains would be worse than no explanation at all.
 *
 * The button and the panel are separate components on purpose. Two of the
 * three figures sit side by side in a two-column hero, and a panel rendered
 * where its button is inherits that column: a page of one-word lines in a
 * 150px gutter, which is what the first version did. The caller keeps the open
 * state and puts the panel where there is room for it.
 */
import { formatCents } from "@headroom/core";
import type { Working } from "../lib/explain.js";
import "./Explain.css";

export function ExplainButton({
  figure,
  panelId,
  open,
  onToggle,
}: {
  /** Which figure this explains, for the screen-reader label. */
  figure: string;
  panelId: string;
  open: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  return (
    <button
      className="explain__button"
      type="button"
      aria-expanded={open}
      aria-controls={panelId}
      // The label names the figure: on a screen with three of these, "more
      // information" would not say which one.
      aria-label={`How ${figure} is worked out`}
      onClick={onToggle}
    >
      <span aria-hidden="true">i</span>
    </button>
  );
}

export function ExplainPanel({
  id,
  working,
}: {
  id: string;
  working: Working;
}): React.JSX.Element {
  return (
    <div className="explain__panel hr-card" id={id} role="region" aria-label={working.title}>
      <p className="explain__title">{working.title}</p>
      <p className="explain__meaning">{working.meaning}</p>

      <dl className="explain__lines">
        {working.lines.map((line) => (
          <div
            className={`explain__line ${line.total ? "explain__line--total" : ""}`}
            key={line.label}
          >
            <dt>{line.label}</dt>
            <dd className="hr-amount">
              {line.cents === undefined
                ? ""
                : line.negative
                  ? `−${formatCents(line.cents < 0n ? -line.cents : line.cents)}`
                  : formatCents(line.cents)}
            </dd>
          </div>
        ))}
      </dl>

      {working.notes?.map((note) => (
        <p className="explain__note" key={note}>
          {note}
        </p>
      ))}
    </div>
  );
}
