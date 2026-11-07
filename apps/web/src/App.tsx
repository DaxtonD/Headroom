/**
 * The app shell.
 *
 * Home, Upcoming, Pay plan, Budget and Goals arrive in M2 to M4. For now the
 * shell proves the M0 acceptance criterion: a clean clone with a filled `.env`
 * serves the login page, and a signed-in user gets past it.
 */
import { Navigate, Route, Routes } from "react-router";
import { Login } from "./pages/Login.js";
import { Placeholder } from "./pages/Placeholder.js";
import { useSession } from "./lib/session.js";

export function App(): React.JSX.Element {
  const session = useSession();

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
          <p>
            The app is running but the server did not answer. Check the connection and reload.
          </p>
        </div>
      </main>
    );
  }

  if (!session.data) {
    return <Login />;
  }

  return (
    <Routes>
      <Route path="/" element={<Placeholder session={session.data} />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
