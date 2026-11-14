/**
 * "Where did that number come from?"
 *
 * An info button beside each headline figure that shows the arithmetic behind
 * it, with the household's own amounts in it. Asked for by Dax, for the moment
 * Carol looks at a figure and cannot see how it was arrived at - which is most
 * likely with "safe to spend now", because it is not the subtraction anybody
 * assumes it is.
 *
 * The figures come from the engine, by way of the dashboard, rather than being
 * worked out again here. An explanation that could disagree with the number it
 * explains would be worse than no explanation at all.
 */
import { formatCents } from "@headroom/core";
import { useId, useState } from "react";
import type { Working } from "../lib/explain.js";
import "./Explain.css";

export function Explain({ working }: { working: Working }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const panelId = useId();

  return (
    <>
      <button
        className="explain__button"
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        // The label says which figure, because on a screen with three of
        // these "more information" would not say which one.
        aria-label={`How ${working.title} is worked out`}
        onClick={() => setOpen(!open)}
      >
        <span aria-hidden="true">i</span>
      </button>

      {open ? (
        <div className="explain__panel hr-card" id={panelId} role="region">
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
      ) : null}
    </>
  );
}
