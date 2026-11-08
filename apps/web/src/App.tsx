/**
 * The app shell and routes.
 *
 * Every screen in the brief now exists. Net worth is reached from Savings rather
 * than the tab bar, which is what HANDOFF section 7 asks for.
 */
import { useState } from "react";
import { Navigate, Route, Routes } from "react-router";
import { Shell } from "./components/Shell.js";
import { UpdateBalanceSheet } from "./components/UpdateBalanceSheet.js";
import { Budget } from "./pages/Budget.js";
import { Savings } from "./pages/Savings.js";
import { Home } from "./pages/Home.js";
import { Manage } from "./pages/Manage.js";
import { NetWorth } from "./pages/NetWorth.js";
import { PayPlan } from "./pages/PayPlan.js";
import { Year } from "./pages/Year.js";
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
        <Route path="/year" element={<Year />} />
        <Route path="/budget" element={<Budget />} />
        <Route path="/savings" element={<Savings canEdit={canEdit} />} />
        {/*
          Goals became Savings: the screen is now about one real account and
          what the money in it is for. The old path still works, because it is
          what any bookmark or installed shortcut points at.
        */}
        <Route path="/goals" element={<Navigate to="/savings" replace />} />
        {/* Reached from Savings rather than the tab bar, as the brief asks. */}
        <Route path="/net-worth" element={<NetWorth canEdit={canEdit} />} />
        <Route path="/manage" element={<Manage canEdit={canEdit} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>

      {/* Mounted only while open, so its fields start fresh each time. */}
      {balanceSheetOpen ? (
        <UpdateBalanceSheet onClose={() => setBalanceSheetOpen(false)} />
      ) : null}
    </Shell>
  );
}
