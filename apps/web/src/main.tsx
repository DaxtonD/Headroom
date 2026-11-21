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
      /*
       * Keep what has been fetched for as long as the app is open.
       *
       * Reported from use on 2026-11-21: "often, when I click on a tab the UI
       * gets stuck... like it's waiting for the data to load before it's
       * displayed." It was. TanStack's default is to throw a query's data
       * away five minutes after the last screen using it unmounts, and every
       * screen in this app gates its first render on `isPending` - so any tab
       * revisited after five minutes was a cold fetch against a blank page,
       * which on a phone is most revisits.
       *
       * `Infinity` is in memory only. Nothing is written to the device, which
       * is the 2026-11-14 decision and still stands; a reload starts empty
       * and `queryClient.clear()` on sign-out takes the lot. What it costs is
       * a few hundred kilobytes of JSON for the life of a tab.
       *
       * It is not a licence to show old numbers. `staleTime` is still 30
       * seconds, a ping from the other phone still invalidates, and coming
       * back to the app still refetches everything - so what this changes is
       * only whether there is something on screen WHILE that happens.
       *
       * The two reads that take a parameter - a savings what-if, a different
       * number of months - set their own shorter `gcTime`, because their keys
       * multiply with what is typed into them.
       */
      gcTime: Infinity,
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
