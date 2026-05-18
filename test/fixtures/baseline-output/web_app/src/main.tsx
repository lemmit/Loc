// Auto-generated.
import React from "react";
// Named import — React 19's react-dom no longer re-exports the
// client APIs through its namespace, so the v7 idiom
// `import ReactDOM from "react-dom/client"; ReactDOM.createRoot(...)`
// resolves `createRoot` to `undefined` under React 19 (`TypeError:
// ReactDOM.createRoot is not a function`).  The named-import form
// works in both React 18 and 19 — it's the canonical idiom across
// the React 18+ docs.
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
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

createRoot(document.getElementById("root")!).render(
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
