import "./buffer-polyfill";
import React from "react";
import ReactDOM from "react-dom/client";
import { MantineProvider, createTheme } from "@mantine/core";
import "@mantine/core/styles.css";
import App from "./App";
import { ErrorBoundary, installGlobalErrorLogging } from "./ErrorBoundary";
import { CrashTestHooks } from "./CrashTestHooks";
import { LastCrashNotice } from "./LastCrashNotice";
import { installDiagnostics } from "./util/diagnostics";

const theme = createTheme({
  fontFamilyMonospace:
    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
});

installGlobalErrorLogging();
installDiagnostics();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="dark">
      <ErrorBoundary>
        <CrashTestHooks />
        <App />
      </ErrorBoundary>
      {/* Outside the boundary on purpose: a boot that crashes again must
          still tell the user the previous session crashed. */}
      <LastCrashNotice />
    </MantineProvider>
  </React.StrictMode>,
);
