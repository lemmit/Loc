import { useState } from "react";
import { Box, Text } from "@mantine/core";

// ---------------------------------------------------------------------------
// The visible half of the builder write-back guard.
//
// `edit-engine`'s `ifParses` / `spliceNodeIfParses` make a corrupting write
// return null instead of committing.  A silent no-op is its own bug, though —
// the user clicks Apply / Delete / Rename, nothing happens, and there's no way
// to tell a refused write from a lost click.  So every pane that can refuse
// pairs the gate with this: one transient red line, cleared by the next write
// that *does* land.
//
// Deliberately not a toast — the playground has no notification provider, and
// the refusal belongs next to the control the user just used.
// ---------------------------------------------------------------------------

export const REFUSAL_MESSAGE = "Apply produced invalid source — not written";

export interface Refusal {
  /** True from a refused write until the next successful one. */
  refused: boolean;
  /** Mark the last write as refused (shows the line). */
  refuse: () => void;
  /** Clear the line — call on a write that committed. */
  clear: () => void;
}

export function useRefusal(): Refusal {
  const [refused, setRefused] = useState(false);
  const refuse = (): void => setRefused(true);
  const clear = (): void => setRefused(false);
  return { refused, refuse, clear };
}

/** The refusal line itself. Renders nothing when there's nothing to say. */
export function RefusalLine({ refused }: { refused: boolean }): JSX.Element | null {
  if (!refused) return null;
  return (
    <Box px="xs" py={2} bg="dark.7" data-testid="builder-refused">
      <Text size="xs" c="red">
        {REFUSAL_MESSAGE}
      </Text>
    </Box>
  );
}
