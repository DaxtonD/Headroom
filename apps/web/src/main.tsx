import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App.js";
import { UpdateReady } from "./components/UpdateReady.js";
import { ApiError } from "./lib/api.js";
import { applyAppearance, getAppearance } from "./lib/appearance.js";
import "./styles/global.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Two people edit the same data, so a ping over SSE invalidates queries
      // (M2). Until then, refetch when the app is reopened or focused, which
      // is the pattern section 16.2 describes.
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      staleTime: 30_000,
      retry: (failureCount, error) => {
        // Never retry a refusal; retrying a 401 or a 409 cannot help.
        if (error instanceof ApiError && error.status < 500) return false;
        return failureCount < 2;
      },
    },
    mutations: {
      // Writes are online-only and never queued (section 16.2 rule 2):
      // a retry here would replay a stale edit to money.
      retry: false,
    },
  },
});

/*
 * Put the stored appearance on the document before React draws anything.
 *
 * `index.html` has already applied the theme and the text size from its own
 * inline script, which is the only thing that can run before the browser's
 * first paint. The ledger's density is applied here instead, because nothing
 * has to be read that early for it - the ledger does not exist until React
 * builds it - and this still runs before the first render, so a compact
 * ledger is never drawn comfortable first and then rearranged.
 *
 * Re-applying the other two costs nothing and keeps one function responsible
 * for the whole of "put the choice on the document".
 */
applyAppearance(getAppearance());

const container = document.getElementById("root");
if (!container) throw new Error("No #root element to mount Headroom into.");

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
    {/*
      Outside the router and outside the session, because registering the
      service worker is not something to do only once somebody is signed in -
      the shell has to be cached before the first offline open, and a new
      version has to be offerable on the sign-in screen too.
    */}
    <UpdateReady />
  </StrictMode>,
);
