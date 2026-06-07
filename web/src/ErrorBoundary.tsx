// ---------------------------------------------------------------------------
// Root error boundary + global error logging.
//
// The playground renders straight under `MantineProvider` with no React
// error boundary, so any exception thrown while rendering the host app
// white-screens the whole page with no recovery path — especially likely
// on a reload (re-reads the URL hash, reopens the IndexedDB git store,
// restores persisted UI state, re-seeds workers), and worst on mobile
// where memory pressure makes throws/OOM more frequent.
//
// This converts a render-time throw into a recoverable panel instead of a
// blank screen, and surfaces a "Reset view & reload" escape hatch that
// clears the small `loom*` localStorage UI prefs (active tab, code view,
// node positions, engine pick) — the most likely culprit for a crash that
// reproduces on every reload.  The durable git workspace lives in
// IndexedDB and is deliberately left untouched, so resetting the view
// never costs the user their work.
// ---------------------------------------------------------------------------

import { Component, type ErrorInfo, type ReactNode } from "react";
import { Box, Button, Code, Group, Stack, Text, Title } from "@mantine/core";
import { logDiagnostic } from "./util/diagnostics";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/** Drop the playground's localStorage UI preferences.  Keys are all
 *  `loom`-prefixed (`loom.mobile.*`, `loom.outputStream`, `loom.engine`,
 *  `loom.builder.node-positions`, `loom-v2-pos-*`).  Best-effort: storage
 *  may be disabled or throw, in which case the reload alone is the
 *  recovery. */
function clearUiPrefsAndReload(): void {
  try {
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("loom")) stale.push(k);
    }
    for (const k of stale) localStorage.removeItem(k);
  } catch {
    // storage disabled / blocked — fall through to the reload
  }
  location.reload();
}

function CrashFallback({ error }: { error: Error }): JSX.Element {
  return (
    <Box
      p="xl"
      style={{
        height: "100dvh",
        overflow: "auto",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Stack gap="md" maw={560} data-testid="app-crash-fallback">
        <Title order={3}>The playground hit an error</Title>
        <Text size="sm" c="dimmed">
          Something went wrong while rendering. Your saved workspace is kept
          in this browser — reloading usually recovers it. If the error
          repeats on every reload, a stale view preference may be the cause;
          “Reset view &amp; reload” clears those (active tab, layout) without
          touching your files.
        </Text>
        <Code block style={{ whiteSpace: "pre-wrap" }}>
          {error.message || String(error)}
        </Code>
        <Group>
          <Button onClick={() => location.reload()} data-testid="app-crash-reload">
            Reload
          </Button>
          <Button
            variant="default"
            onClick={clearUiPrefsAndReload}
            data-testid="app-crash-reset"
          >
            Reset view &amp; reload
          </Button>
        </Group>
      </Stack>
    </Box>
  );
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error("Playground crashed:", error, info.componentStack);
    void logDiagnostic("react-error");
  }

  override render(): ReactNode {
    if (this.state.error) return <CrashFallback error={this.state.error} />;
    return this.props.children;
  }
}

/** Install window-level handlers for errors React boundaries can't catch
 *  (async throws, rejected promises, worker/event-handler errors).  These
 *  don't render UI — they just make a crash observable in the console
 *  instead of failing silently, which is the difference between a
 *  diagnosable report and "it sometimes crashes". */
export function installGlobalErrorLogging(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("error", (e) => {
    // eslint-disable-next-line no-console
    console.error("Uncaught error:", e.error ?? e.message);
    void logDiagnostic("window-error");
  });
  window.addEventListener("unhandledrejection", (e) => {
    // eslint-disable-next-line no-console
    console.error("Unhandled promise rejection:", e.reason);
    void logDiagnostic("unhandledrejection");
  });
}
