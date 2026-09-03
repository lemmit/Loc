import "./buffer-polyfill";
import React from "react";
import ReactDOM from "react-dom/client";
import { MantineProvider, createTheme } from "@mantine/core";
import "@mantine/core/styles.css";
import "@mantine/spotlight/styles.css";
import App from "./App";
import { ErrorBoundary, installGlobalErrorLogging } from "./ErrorBoundary";
import { CrashTestHooks } from "./CrashTestHooks";
import { LastCrashNotice } from "./LastCrashNotice";
import { installDiagnostics } from "./util/diagnostics";
import { gcOpfsAtStartup } from "./engine/opfs-gc";

const theme = createTheme({
  fontFamilyMonospace:
    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
});

installGlobalErrorLogging();
installDiagnostics();
// Shed stale OPFS islands even when no boot ever succeeds — otherwise a
// failing-boot loop only ever ADDS storage, and quota pressure is what makes
// mobile browsers evict and reload the tab.  See engine/opfs-gc.ts.
void gcOpfsAtStartup();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {/* Forced, not default: ~108 `dark.N` literals assume the dark palette,
        so a stored light scheme rendered white-on-white (audit M16).  The
        token migration that lets this go back to `defaultColorScheme` is
        M-T8.23's residue. */}
    <MantineProvider theme={theme} forceColorScheme="dark">
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
