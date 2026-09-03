import "./buffer-polyfill";
import React from "react";
import ReactDOM from "react-dom/client";
import { MantineProvider, createTheme } from "@mantine/core";
import "@mantine/core/styles.css";
import "@mantine/spotlight/styles.css";
// The playground's semantic colour tokens.  AFTER Mantine's stylesheet so the
// `light-dark()` roles can alias Mantine's own (`--mantine-color-body`,
// `--mantine-color-default-border`) rather than restate them.
import "./theme.css";
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
    {/* `defaultColorScheme`, not `forceColorScheme`: the ~108 `dark.N`
        literals that made a stored light scheme render white-on-white (audit
        M16) now resolve through the semantic tokens in `theme.css`, so the
        playground renders legibly in either scheme and the viewer's stored
        choice is honoured again (M-T8.23 slice 4).  Dark stays the DEFAULT —
        it is what the playground was designed in and what every screenshot
        shows; light is now correct rather than merely reachable. */}
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
