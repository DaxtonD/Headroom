/**
 * The signed-in landing page for M0.
 *
 * It exists to prove the full round trip works: session cookie, /api/me, the
 * household settings and both users' initials. Home replaces it in M2.
 */
import { formatCents } from "@headroom/core";
import { useLogout, type SessionResponse } from "../lib/session.js";
import "./Placeholder.css";

export function Placeholder({ session }: { session: SessionResponse }): React.JSX.Element {
  const logout = useLogout();
  const { user, household, members } = session;

  return (
    <div className="shell">
      <header className="shell__header">
        <p className="shell__wordmark">Headroom</p>
        <ul className="shell__people" aria-label="Household members">
          {members.map((member) => (
            <li
              key={member.id}
              className="shell__initial"
              style={{ color: member.colorFg, background: member.colorBg }}
              title={member.name}
            >
              <span aria-hidden="true">{member.initial}</span>
              <span className="hr-visually-hidden">{member.name}</span>
            </li>
          ))}
        </ul>
      </header>

      <main className="shell__main">
        <section className="shell__hero">
          <p className="shell__hero-label">Signed in as</p>
          <h1 className="shell__hero-value">{user.name}</h1>
          <p className="shell__hero-note">
            The scaffold is working. Home, Upcoming, Pay plan, Budget and Goals come next.
          </p>
        </section>

        <section className="hr-card shell__card">
          <h2 className="shell__card-title">Household</h2>
          {household ? (
            <dl className="shell__facts">
              <div>
                <dt>Name</dt>
                <dd>{household.name}</dd>
              </div>
              <div>
                <dt>Timezone</dt>
                <dd>{household.timezone}</dd>
              </div>
              <div>
                <dt>Cushion</dt>
                <dd className="hr-amount">{formatCents(BigInt(household.cushionCents))}</dd>
              </div>
              <div>
                <dt>Horizon</dt>
                <dd>
                  through the day before paycheque #{household.horizonPaychequeCount}
                </dd>
              </div>
              <div>
                <dt>Weekend withdrawals</dt>
                <dd>{household.weekendWithdrawalRule.replaceAll("_", " ")}</dd>
              </div>
            </dl>
          ) : (
            <p>No household settings yet.</p>
          )}
        </section>

        <button
          className="hr-button hr-button--secondary shell__signout"
          type="button"
          onClick={() => logout.mutate()}
          disabled={logout.isPending}
        >
          {logout.isPending ? "Signing out…" : "Sign out"}
        </button>
      </main>
    </div>
  );
}
