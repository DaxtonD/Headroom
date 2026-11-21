/**
 * What a screen looks like before its figures have arrived.
 *
 * Reported from use on 2026-11-21: "often, when I click on a tab the UI gets
 * stuck... like it's waiting for the data to load before it's displayed."
 * Most of that was the cache being emptied five minutes after a screen was
 * left and nothing warming the tabs ahead of a visit - both dealt with in
 * `main.tsx` and `warmTabs.ts`. This is the rest of it, and it is the half
 * that cannot be designed away: the first open of the day has to wait for the
 * server, and what it waited against was an empty `<div>`.
 *
 * An empty page and a broken page look identical, so the honest wait is a
 * shape. These are the bones of the screen that is coming - a hero band, then
 * a card or two with lines in them - at a weight that reads as "not yet"
 * rather than as content.
 *
 * ## Why not a spinner
 *
 * A spinner says "something is happening". A shape says "this is the budget,
 * arriving", which is more information for the same pixels, and it keeps the
 * page from jumping when the real thing lands in roughly the same places.
 *
 * ## Why no numbers, ever
 *
 * Not even plausible ones, not even greyed out. This is a screen about money,
 * and a figure nobody has fetched yet is a lie in the one place this app
 * cannot afford one. The bones are blocks, and blocks cannot be misread as an
 * amount.
 *
 * `aria-busy` and one off-screen sentence are the whole of what this says to a
 * screen reader. The blocks are decoration and are hidden from it.
 */
import "./Loading.css";

export interface LoadingProps {
  /**
   * What is being waited for, read out and never drawn: "Loading the budget".
   * A sentence rather than "Loading", because a screen reader hears it with
   * no idea which screen it is on.
   */
  readonly label: string;
  /** A hero band at the top, as the ledger, budget and savings screens have. */
  readonly hero?: boolean;
  /** How many card shapes follow it. */
  readonly cards?: number;
  /** The class of the page itself, so the bones sit in its own layout. */
  readonly className?: string;
}

export function Loading({
  label,
  hero = true,
  cards = 2,
  className,
}: LoadingProps): React.JSX.Element {
  return (
    <div className={className ?? "loading"} aria-busy="true">
      <p className="hr-visually-hidden">{label}</p>

      {hero ? <div className="loading__block loading__block--hero" aria-hidden="true" /> : null}

      {Array.from({ length: cards }, (_unused, index) => (
        <div className="loading__block loading__block--card" key={index} aria-hidden="true">
          <span className="loading__line loading__line--title" />
          <span className="loading__line" />
          <span className="loading__line loading__line--short" />
        </div>
      ))}
    </div>
  );
}
