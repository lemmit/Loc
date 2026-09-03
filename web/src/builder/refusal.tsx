import { useState } from "react";
import { Box, Button, Code, Group, Text } from "@mantine/core";
import { lineDiff } from "./edit-engine";
// The wording + shapes live in a React-free module so headless tests can
// import them without `react` — see refusal-text.ts.
import { REFUSAL_MESSAGE, type RefusalDetail, refusalMessage } from "./refusal-text";

export { REFUSAL_MESSAGE, REFUSAL_WHY, refusalMessage } from "./refusal-text";
export type { RefusalDetail } from "./refusal-text";

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
// Since M-T8.17 (audit H10) the line is ACTIONABLE: it names the construct
// the user was editing and WHY the write was refused (the helper produced no
// edit, or the rewrite would not parse), and when a rejected candidate exists
// it offers *Show candidate* — a read-only line diff of what would have been
// written, so the user can see what the builder tried and fix the source by
// hand if they want that outcome.
//
// Deliberately not a toast — the playground has no notification provider, and
// the refusal belongs next to the control the user just used.
// ---------------------------------------------------------------------------

export interface Refusal {
  /** True from a refused write until the next successful one. */
  refused: boolean;
  /** What was refused and why; null while nothing is refused or when the
   *  caller gave no detail. */
  detail: RefusalDetail | null;
  /** Mark the last write as refused (shows the line). */
  refuse: (detail?: RefusalDetail) => void;
  /** Clear the line — call on a write that committed. */
  clear: () => void;
}

export function useRefusal(): Refusal {
  const [detail, setDetail] = useState<RefusalDetail | null>(null);
  const [refused, setRefused] = useState(false);
  const refuse = (d?: RefusalDetail): void => {
    setRefused(true);
    setDetail(d ?? null);
  };
  const clear = (): void => {
    setRefused(false);
    setDetail(null);
  };
  return { refused, detail, refuse, clear };
}

/** The refusal line itself. Renders nothing when there's nothing to say. */
export function RefusalLine({ refusal }: { refusal: Refusal }): JSX.Element | null {
  const [showCandidate, setShowCandidate] = useState(false);
  if (!refusal.refused) return null;
  const { detail } = refusal;
  const hasCandidate = detail?.candidate !== undefined && detail.before !== undefined;
  const hunk = hasCandidate && showCandidate ? lineDiff(detail.before ?? "", detail.candidate ?? "") : null;
  return (
    <Box px="xs" py={2} bg="var(--loom-bg)" data-testid="builder-refused">
      <Group gap={8} wrap="nowrap" align="center">
        <Text size="xs" c="red" style={{ flex: 1, minWidth: 0 }} data-testid="builder-refused-message">
          {refusalMessage(detail)}
        </Text>
        {hasCandidate && (
          <Button
            size="compact-xs"
            variant="subtle"
            color="gray"
            onClick={() => setShowCandidate((s) => !s)}
            data-testid="builder-refused-show"
          >
            {showCandidate ? "Hide candidate" : "Show candidate"}
          </Button>
        )}
      </Group>
      {hunk && (
        <Code
          block
          data-testid="builder-refused-candidate"
          style={{ maxHeight: 180, overflow: "auto", fontSize: 11, marginTop: 4 }}
        >
          {hunk.removed.length === 0 && hunk.added.length === 0
            ? "(candidate is identical to the current source)"
            : [
                `@@ line ${hunk.atLine + 1}`,
                ...hunk.removed.map((l) => `- ${l}`),
                ...hunk.added.map((l) => `+ ${l}`),
              ].join("\n")}
        </Code>
      )}
    </Box>
  );
}
