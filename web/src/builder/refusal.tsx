import { useState } from "react";
import { Box, Button, Code, Group, Text } from "@mantine/core";
import { lineDiff } from "./edit-engine";

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

export const REFUSAL_MESSAGE = "Apply produced invalid source — not written";

/** Why a write was refused, in words the line can show. */
export const REFUSAL_WHY = {
  /** The helper returned null — nothing to splice (the target wasn't found,
   *  or the edit had no legal placement). */
  noEdit: "the edit could not be produced — nothing was written",
  /** The candidate exists but the parser rejects it. */
  noParse: "the rewrite would not parse — not written",
} as const;

export interface RefusalDetail {
  /** The construct / action the user was editing — "aggregate Order",
   *  "field total", "+ Repository". */
  what: string;
  why: string;
  /** The source at the time of the refusal and the rejected candidate, when
   *  there was one — drives *Show candidate*. */
  before?: string;
  candidate?: string;
}

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

/** The message a refusal renders — exported so tests can pin the wording
 *  without a DOM. */
export function refusalMessage(detail: RefusalDetail | null): string {
  if (!detail) return REFUSAL_MESSAGE;
  return `${detail.what}: ${detail.why}`;
}

/** The refusal line itself. Renders nothing when there's nothing to say. */
export function RefusalLine({ refusal }: { refusal: Refusal }): JSX.Element | null {
  const [showCandidate, setShowCandidate] = useState(false);
  if (!refusal.refused) return null;
  const { detail } = refusal;
  const hasCandidate = detail?.candidate !== undefined && detail.before !== undefined;
  const hunk = hasCandidate && showCandidate ? lineDiff(detail.before ?? "", detail.candidate ?? "") : null;
  return (
    <Box px="xs" py={2} bg="dark.7" data-testid="builder-refused">
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
