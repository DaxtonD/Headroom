/**
 * Home (HANDOFF section 7.1).
 *
 * The screen that answers the question Carol asks all day: what is in
 * chequing, and how much is safe to spend? Everything here is derived by
 * `@headroom/core` on the server; nothing is a stored total.
 *
 * The big number is the chequing balance. "Safe until payday" is the lowest
 * point the balance reaches over the whole horizon, less the cushion, because
 * spending now lowers every later balance.
 */
import { formatCents, formatDateShort } from "@headroom/core";
import { Link } from "react-router";
import { Amount, CoveragePill, VerificationBadge } from "../components/Badges.js";
import { useDashboard } from "../lib/queries.js";
import "./Home.css";

export function Home({ onUpdateBalance }: { onUpdateBalance: () => void }): React.JSX.Element {
  const dashboard = useDashboard();

  if (dashboard.isPending) {
    return (
      <div className="home home--loading" aria-busy="true">
        <p className="hr-visually-hidden">Loading your balance</p>
        {/* Painted immediately so the screen never looks broken while loading. */}
        <div className="home__hero home__hero--skeleton" />
      </div>
    );
  }

  if (dashboard.isError || !dashboard.data) {
    return (
      <div className="home">
        <div className="hr-card home__error">
          <h2>Could not load your numbers</h2>
          <p>
            The server did not answer. Nothing has been changed; pull down or reload to try
            again.
          </p>
        </div>
      </div>
    );
  }

  const data = dashboard.data;
  const updatedLabel = data.balance.asOf ? describeUpdated(data.balance.asOf) : "not set yet";

  return (
    <div className="home">
      {/* ---- The balance ---- */}
      <section className="home__hero" aria-labelledby="home-balance-label">
        <p className="home__hero-label" id="home-balance-label">
          In chequing
        </p>
        <p className="home__hero-amount hr-amount">{formatCents(data.balance.cents)}</p>
        <p className="home__hero-meta">
          Updated {updatedLabel}
          {data.balance.enteredBy ? ` by ${data.balance.enteredBy.name}` : ""}
        </p>
        <button className="hr-button home__update" type="button" onClick={onUpdateBalance}>
          Update balance
        </button>
      </section>

      {/* ---- The two numbers that follow from it ---- */}
      <div className="home__cards">
        <section className="hr-card home__card">
          <h2 className="home__card-title">Safe to spend now</h2>
          <p className="home__card-amount hr-amount">
            {formatCents(data.safeToSpendNowCents)}
          </p>
          <p className="home__card-note">
            {data.lowest.date
              ? `The lowest your balance gets is ${formatCents(data.lowest.cents)}, on ${formatDateShort(data.lowest.date)}.`
              : `The lowest your balance gets is ${formatCents(data.lowest.cents)}.`}
          </p>
        </section>

        <section className="hr-card home__card">
          <h2 className="home__card-title">Left this cycle</h2>
          <p className="home__card-amount hr-amount">{formatCents(data.leftThisCycleCents)}</p>
          <p className="home__card-note">
            For gas, groceries and everyday, through {formatDateShort(data.horizonEnd)}.
          </p>
        </section>
      </div>

      {/* ---- Coverage warning, when there is one ---- */}
      {!data.coverage.allCovered && data.coverage.firstShortfall ? (
        <section className="home__warning" role="alert">
          <p className="home__warning-title">
            Not enough for {data.coverage.firstShortfall.name}
            {data.coverage.firstShortfall.date
              ? ` on ${formatDateShort(data.coverage.firstShortfall.date)}`
              : ""}
          </p>
          <p className="home__warning-detail">
            {formatCents(data.coverage.firstShortfall.shortCents)} short. Move a flexible bill to
            a later payday.
          </p>
          <Link className="home__warning-link" to="/upcoming">
            See what is coming
          </Link>
        </section>
      ) : null}

      {/* ---- The next automatic withdrawals ---- */}
      <section className="hr-card home__autos">
        <header className="home__autos-header">
          <h2 className="home__card-title">Automatic withdrawals</h2>
          <CoveragePill
            allCovered={data.coverage.allCovered}
            count={data.coverage.autoWithdrawalCount}
          />
        </header>

        {data.nextAutoWithdrawals.length === 0 ? (
          <p className="home__empty">Nothing comes out automatically before {formatDateShort(data.horizonEnd)}.</p>
        ) : (
          <ul className="home__auto-list">
            {data.nextAutoWithdrawals.map((row) => (
              <li className="home__auto" key={row.id}>
                <VerificationBadge verified={row.verified} verifiedBy={row.verifiedBy} />
                <div className="home__auto-main">
                  <p className="home__auto-name">{row.name}</p>
                  <p className="home__auto-meta">
                    {row.date ? formatDateShort(row.date) : "No date"}
                    {row.verified
                      ? row.verifiedBy
                        ? ` · verified by ${row.verifiedBy.name}`
                        : " · verified"
                      : " · still an estimate"}
                  </p>
                </div>
                <div className="home__auto-figures">
                  <Amount cents={row.cents} className="home__auto-amount" />
                  <p className="home__auto-after">
                    {formatCents(row.balanceAfterCents)} after
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}

        <Link className="home__see-all" to="/upcoming">
          See everything coming up
        </Link>
      </section>

      {/* ---- Estimates still outstanding ---- */}
      {data.estimatesCount > 0 ? (
        <Link className="home__estimates" to="/upcoming">
          <span className="home__estimates-count">{data.estimatesCount}</span>
          <span>
            {data.estimatesCount === 1 ? "bill is still an estimate" : "bills are still estimates"}
          </span>
          <span className="home__estimates-cta" aria-hidden="true">
            →
          </span>
        </Link>
      ) : null}
    </div>
  );
}

/**
 * "today, 9:58 AM" / "yesterday, 6:12 PM" / "Nov 3".
 *
 * Relative wording for the recent past, because that is how Carol thinks
 * about when she last typed the balance in.
 */
function describeUpdated(at: Date): string {
  const time = at.toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" });

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  if (at.getTime() >= startOfToday.getTime()) return `today, ${time}`;

  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  if (at.getTime() >= startOfYesterday.getTime()) return `yesterday, ${time}`;

  return at.toLocaleDateString("en-CA", { month: "short", day: "numeric" });
}
