/**
 * The app shell and routes.
 *
 * Net worth is reached from Savings rather than the tab bar, which is what
 * HANDOFF section 7 asks for.
 *
 * Home, Upcoming and Pay plan have merged into one ledger at `/`. The brief
 * described them as three screens; the household's complaint about the result
 * was that one list had been split across three places.
 */
import { useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router";
import { Shell } from "./components/Shell.js";
import { UpdateBalanceSheet } from "./components/UpdateBalanceSheet.js";
import { Budget } from "./pages/Budget.js";
import { Ledger } from "./pages/Ledger.js";
import { Manage } from "./pages/Manage.js";
import { NetWorth } from "./pages/NetWorth.js";
import { Savings } from "./pages/Savings.js";
import { Settings } from "./pages/Settings.js";
import { Year } from "./pages/Year.js";
import { useLogout, useSession } from "./lib/session.js";
import { useLiveUpdates } from "./lib/useLiveUpdates.js";
import { Login } from "./pages/Login.js";
import "./styles/app.css";

export function App(): React.JSX.Element {
  const session = useSession();
  const logout = useLogout();
  /*
   * Opened by the manifest shortcut as well as by the button.
   *
   * A PWA on Android cannot have the home-screen widget the brief asks for
   * (HANDOFF section 3), so the nearest real thing is a long-press shortcut
   * straight to the one job done several times a day. It arrives as
   * `/?update-balance=1`, which is read once on mount and then taken out of
   * the URL - otherwise a reload, or a share of the address, reopens it.
   */
  const [balanceSheetOpen, setBalanceSheetOpen] = useState(() => {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).has("update-balance");
  });

  useEffect(() => {
    if (!balanceSheetOpen) return;
    const url = new URL(window.location.href);
    if (!url.searchParams.has("update-balance")) return;
    url.searchParams.delete("update-balance");
    window.history.replaceState(window.history.state, "", url);
  }, [balanceSheetOpen]);

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
      you={{ name: session.data.user.name }}
      live={live}
      onSignOut={() => logout.mutate()}
    >
      <Routes>
        <Route
          path="/"
          element={
            <Ledger canEdit={canEdit} onUpdateBalance={() => setBalanceSheetOpen(true)} />
          }
        />
        {/*
          Home, Upcoming and Pay plan were three views of one list, and keeping
          them apart was the actual complaint: "the data is too spread out - she
          can't easily see everything." Both old paths still work, because an
          installed shortcut may point at either.
        */}
        <Route path="/upcoming" element={<Navigate to="/" replace />} />
        <Route path="/pay-plan" element={<Navigate to="/" replace />} />
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
        {/*
          Reached from the header rather than the tab bar: it is opened once in
          a while and the five tabs are already as many as a phone holds.
        */}
        <Route path="/settings" element={<Settings onSignOut={() => logout.mutate()} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>

      {/* Mounted only while open, so its fields start fresh each time. */}
      {balanceSheetOpen ? (
        <UpdateBalanceSheet onClose={() => setBalanceSheetOpen(false)} />
      ) : null}
    </Shell>
  );
}
