/**
 * The app shell and routes.
 *
 * Home and Upcoming are built (M2). Pay plan, Budget and Goals land in M3 and
 * M4; their tabs are present and say so rather than being hidden, so the
 * navigation does not change shape as the app fills in.
 */
import { useState } from "react";
import { Navigate, Route, Routes } from "react-router";
import { Shell } from "./components/Shell.js";
import { UpdateBalanceSheet } from "./components/UpdateBalanceSheet.js";
import { Home } from "./pages/Home.js";
import { PayPlan } from "./pages/PayPlan.js";
import { Upcoming } from "./pages/Upcoming.js";
import { useLogout, useSession } from "./lib/session.js";
import { useLiveUpdates } from "./lib/useLiveUpdates.js";
import { Login } from "./pages/Login.js";
import "./styles/app.css";

export function App(): React.JSX.Element {
  const session = useSession();
  const logout = useLogout();
  const [balanceSheetOpen, setBalanceSheetOpen] = useState(false);

  // Only listen once there is someone to listen for.
  const live = useLiveUpdates(Boolean(session.data));

  if (session.isPending) {
    return (
      <main className="app-splash" aria-busy="true">
        <p className="hr-visually-hidden">Loading Headroom</p>
      </main>
    );
  }

  if (session.isError) {
    return (
      <main className="app-splash">
        <div className="hr-card app-splash__card">
          <h1>Headroom cannot reach the server</h1>
          <p>The app is running but the server did not answer. Check the connection and reload.</p>
        </div>
      </main>
    );
  }

  if (!session.data) {
    return <Login />;
  }

  // Editing is switched off while offline: the server is the only source of
  // truth and a write has to reach it to count.
  const canEdit = live.online;

  return (
    <Shell
      members={session.data.members.map((member) => ({
        id: member.id,
        name: member.name,
        initial: member.initial,
        colorFg: member.colorFg,
        colorBg: member.colorBg,
      }))}
      live={live}
      onSignOut={() => logout.mutate()}
    >
      <Routes>
        <Route path="/" element={<Home onUpdateBalance={() => setBalanceSheetOpen(true)} />} />
        <Route path="/upcoming" element={<Upcoming canEdit={canEdit} />} />
        <Route path="/pay-plan" element={<PayPlan canEdit={canEdit} />} />
        <Route path="/budget" element={<ComingSoon title="Budget" milestone="M4" />} />
        <Route path="/goals" element={<ComingSoon title="Goals" milestone="M4" />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>

      {/* Mounted only while open, so its fields start fresh each time. */}
      {balanceSheetOpen ? (
        <UpdateBalanceSheet onClose={() => setBalanceSheetOpen(false)} />
      ) : null}
    </Shell>
  );
}

function ComingSoon({ title, milestone }: { title: string; milestone: string }): React.JSX.Element {
  return (
    <div className="hr-card coming-soon">
      <h1 className="coming-soon__title">{title}</h1>
      <p className="coming-soon__note">
        Being built in {milestone}. Home and Upcoming are working now.
      </p>
    </div>
  );
}
