/**
 * The activity log, as a panel that slides in from the side.
 *
 * Not a tab: the tab bar went from seven to five deliberately and this is
 * read now and then, not several times a day. Not a section of the Ledger
 * either - the Ledger has to open instantly with the balance at the top, and
 * a growing list of history underneath it is the opposite of that.
 *
 * A panel also suits what it is. The log is something you glance at *while*
 * looking at something else - "did the mortgage get verified?" - and it closes
 * back to whatever screen you were on, rather than being somewhere you have to
 * navigate away to and back from.
 *
 * ## Dismissal
 *
 * Shared with every sheet in the app through `useOverlayDismissal`: the close
 * button, Escape, Android's Back and a tap outside, all four. Written once
 * because the time it was written per-sheet, three of the four went missing
 * and nothing about the code showed it.
 */
import { useEffect, useRef } from "react";
import { activitySentence } from "@headroom/core";
import { useActivity, type ActivityEntry } from "../lib/activityQueries.js";
import { useOverlayDismissal } from "../lib/overlayDismissal.js";
import { firstNameOf } from "../lib/people.js";
import "./ActivityPanel.css";

export function ActivityPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const backdrop = useOverlayDismissal(onClose);
  const log = useActivity(true);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Moving focus in is what makes Escape work for a keyboard, and what stops
  // a screen reader carrying on reading the page behind.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const entries = log.data?.pages.flatMap((page) => page.entries) ?? [];

  return (
    <div
      className="activity-backdrop"
      role="presentation"
      onPointerDown={backdrop.onPointerDown}
      onClick={backdrop.onClick}
    >
      <aside className="activity-panel" role="dialog" aria-modal="true" aria-label="Activity">
        <div className="activity-panel__head">
          <h2 className="activity-panel__title" ref={headingRef} tabIndex={-1}>
            Activity
          </h2>
          <button
            className="hr-button hr-button--secondary activity-panel__close"
            type="button"
            onClick={onClose}
          >
            Close
          </button>
        </div>

        {log.isPending ? <p className="activity-panel__note">Loading…</p> : null}

        {log.isError ? (
          <p className="hr-alert activity-panel__note" role="alert">
            Could not load the activity log. Reload to try again.
          </p>
        ) : null}

        {log.isSuccess && entries.length === 0 ? (
          <p className="activity-panel__note">
            Nothing yet. Everything either of you does to the money shows up here.
          </p>
        ) : null}

        {entries.length > 0 ? <ActivityList entries={entries} /> : null}

        {log.hasNextPage ? (
          <button
            className="hr-button hr-button--secondary activity-panel__more"
            type="button"
            disabled={log.isFetchingNextPage}
            onClick={() => void log.fetchNextPage()}
          >
            {log.isFetchingNextPage ? "Loading…" : "Show older"}
          </button>
        ) : null}
      </aside>
    </div>
  );
}

function ActivityList({ entries }: { entries: readonly ActivityEntry[] }): React.JSX.Element {
  // Worked out up front rather than tracked through the loop: a variable
  // mutated while rendering is a different list depending on when React
  // chooses to render it.
  const days = entries.map((entry) => dayOf(entry.at));

  return (
    <ol className="activity-list">
      {entries.map((entry, index) => {
        const day = days[index] ?? "";
        const newDay = index === 0 || days[index - 1] !== day;

        return (
          <li className="activity-list__item" key={entry.id}>
            {newDay ? <p className="activity-list__day">{day}</p> : null}
            <div className="activity-row">
              {/*
                The person's own colours, the same pair used on every badge
                in the app, so who did what is answerable at a glance without
                reading the name.
              */}
              <span
                className="activity-row__who"
                style={{ color: entry.by.colorFg, background: entry.by.colorBg }}
                aria-hidden="true"
              >
                {entry.by.initial}
              </span>
              <p className="activity-row__said">
                {activitySentence(firstNameOf(entry.by.name), entry)}
              </p>
              <time className="activity-row__at" dateTime={entry.at}>
                {timeOf(entry.at)}
              </time>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * "Today", "Yesterday", or the date.
 *
 * Deliberately the device's own idea of today rather than the server's. This
 * is a heading someone reads at a glance; being an hour out either way around
 * midnight is not worth a round trip, and every figure that matters is still
 * derived server-side.
 */
function dayOf(iso: string): string {
  const at = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  if (isSameDay(at, today)) return "Today";
  if (isSameDay(at, yesterday)) return "Yesterday";

  return at.toLocaleDateString("en-CA", {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(at.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
  });
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  );
}

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" });
}
