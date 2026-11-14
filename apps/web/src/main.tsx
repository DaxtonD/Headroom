import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App.js";
import { UpdateReady } from "./components/UpdateReady.js";
import { ApiError } from "./lib/api.js";
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
