// ---------------------------------------------------------------------------
// "The playground crashed last session."
//
// The `loom.diag` ring already survived the reload a crash causes — but
// nothing read it on boot, so the user never learned that a report was worth
// filing.  This is that missing signal: a dismissible banner, shown once,
// carrying the report actions inline so the fix is one click from the notice
// rather than three menus away.
//
// Rendered OUTSIDE the root error boundary (in `main.tsx`) so it still appears
// when the boot that follows a crash crashes again.
// ---------------------------------------------------------------------------

import { Alert, Button, Group, Stack, Text } from "@mantine/core";
import { useState } from "react";
import { CrashReportButtons } from "./CrashReportButtons";
import { clearLastCrash, readLastCrash, type LastCrash } from "./util/diagnostics";

/** Ask the shell to switch the Output panel to the Diagnostics stream.  A
 *  window event rather than a prop, because this component renders above
 *  `App` and has no access to its state. */
export const SHOW_DIAGNOSTICS_EVENT = "loom:show-diagnostics";

export function LastCrashNotice(): JSX.Element | null {
  const [crash, setCrash] = useState<LastCrash | null>(() => readLastCrash());
  if (!crash) return null;

  const dismiss = (): void => {
    clearLastCrash();
    setCrash(null);
  };

  return (
    <Alert
      color="red"
      variant="filled"
      title="The playground crashed in your last session"
      data-testid="last-crash-notice"
      style={{
        position: "fixed",
        left: "50%",
        transform: "translateX(-50%)",
        bottom: 16,
        zIndex: 1000,
        maxWidth: 620,
        width: "calc(100% - 32px)",
      }}
    >
      <Stack gap="xs">
        <Text size="sm">
          <Text span ff="monospace" size="sm">
            {crash.reason}
          </Text>{" "}
          at {crash.t.replace("T", " ").replace(/\.\d+Z$/, "")} on build{" "}
          <Text span ff="monospace" size="sm">
            {crash.build.sha}
          </Text>
          {crash.message ? ` — ${crash.message}` : ""}. Your workspace is intact.
          A crash report makes it fixable.
        </Text>
        <CrashReportButtons size="xs" />
        <Group gap="xs">
          <Button
            size="compact-xs"
            variant="white"
            color="red"
            onClick={() => {
              window.dispatchEvent(new CustomEvent(SHOW_DIAGNOSTICS_EVENT));
              dismiss();
            }}
            data-testid="last-crash-view"
          >
            View diagnostics
          </Button>
          <Button
            size="compact-xs"
            variant="subtle"
            color="gray"
            onClick={dismiss}
            data-testid="last-crash-dismiss"
          >
            Dismiss
          </Button>
        </Group>
      </Stack>
    </Alert>
  );
}
