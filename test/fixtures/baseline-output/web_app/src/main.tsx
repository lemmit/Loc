// Auto-generated.
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { ModalsProvider } from "@mantine/modals";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "@mantine/dates/styles.css";
import App from "./App";
import { theme } from "./theme";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000, retry: 1 } },
});

// Optional basename hook the host page can set before the bundle
// runs.  When present (e.g. the Loom playground iframe served at
// `<deploy>/__loom_sandbox__/` injects `window.__LOOM_BASENAME__`
// = `/<deploy>/__loom_sandbox__`), routes resolve relative to it
// so links like `/customers` push state inside the iframe scope.
// Plain deploys leave it undefined and the router defaults to `/`.
const basename =
  (typeof window !== "undefined"
    ? (window as { __LOOM_BASENAME__?: string }).__LOOM_BASENAME__
    : undefined) ?? undefined;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <MantineProvider theme={theme} defaultColorScheme="light">
        <ModalsProvider>
          <Notifications position="top-right" />
          <BrowserRouter basename={basename}>
            <App />
          </BrowserRouter>
        </ModalsProvider>
      </MantineProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
