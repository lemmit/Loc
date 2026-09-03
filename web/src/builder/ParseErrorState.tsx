// The visual panes' parse-error state (M-T8.18 slice 4, audit H7).
//
// "Source has syntax errors — fix them in the editor" used to be the whole
// message, with no line number and no way to get there, although the
// diagnostics were one prop away.  This shows the FIRST error's message and
// a *Go to line N* button that switches the centre to Source and reveals
// the range through the editor handle.  One component for the four panes
// (`BuilderPane`, `SystemBuilderV2Pane`, `OverviewCanvas`,
// `RequirementsPane`); M-T8.21 reuses it for its own empty states.
//
// Desktop reads the LSP's diagnostics; mobile's arrive from `generate`
// (M-T8.15) and may not exist yet for a source that has never been run — the
// state then still names the fix path, just without a line to jump to.

import { Box, Button, Stack, Text } from "@mantine/core";
import type { LayoutCtx } from "../layout/ctx";
import { inDocumentOrder, toEditorRange } from "../layout/problem-nav";
import { PARSE_ERROR } from "../layout/vocabulary";

interface Props {
  ctx: Pick<LayoutCtx, "diagnostics" | "revealSourceRange">;
  /** The pane's clause — `PARSE_ERROR.purpose.builder` etc. */
  purpose: string;
  /** Test-id prefix (`builder` → `builder-parse-error`, `builder-goto-line`). */
  testid: string;
}

export function ParseErrorState({ ctx, purpose, testid }: Props): JSX.Element {
  const first = inDocumentOrder(ctx.diagnostics.filter((d) => d.severity === "error"))[0] ?? null;
  const line = first ? first.range.start.line + 1 : null;
  return (
    <Box p="md" data-testid={`${testid}-parse-error`}>
      <Stack gap="xs" align="flex-start" maw={560}>
        <Text size="sm" fw={600}>
          {PARSE_ERROR.title}
        </Text>
        {first && (
          <Text size="sm" ff="monospace" style={{ whiteSpace: "pre-wrap" }} data-testid={`${testid}-parse-error-message`}>
            {line}: {first.message}
          </Text>
        )}
        <Text size="sm" c="dimmed">
          {PARSE_ERROR.body(purpose)}
        </Text>
        {first && line !== null && (
          <Button
            size="xs"
            variant="light"
            onClick={() => ctx.revealSourceRange(toEditorRange(first))}
            data-testid={`${testid}-goto-line`}
          >
            {PARSE_ERROR.goToLine(line)}
          </Button>
        )}
      </Stack>
    </Box>
  );
}
