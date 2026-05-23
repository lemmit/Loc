// Model builder v2 — Phase 0 (wiring check).
//
// A standalone pane next to v1, behind its own tab in both shells. This
// placeholder confirms the tab + source flow are wired; the real v2 is built
// up phase-by-phase per docs/builder-roadmap.md (drill-down through system →
// module → context → aggregate → operation, with operations rendered as a
// React Flow of statement nodes). v1 stays untouched and shippable.

import { Box, Stack, Text, Title } from "@mantine/core";
import { AstUtils } from "langium";
import { useMemo } from "react";
import type { LayoutCtx } from "../../layout/ctx";
import { parseDdd } from "../parse";

const TOP_LEVEL_KINDS = [
  "System",
  "Module",
  "BoundedContext",
  "Aggregate",
  "ValueObject",
  "EventDecl",
  "Workflow",
  "Deployable",
] as const;

export default function SystemBuilderV2Pane({ ctx }: { ctx: LayoutCtx }): JSX.Element {
  const parsed = useMemo(() => parseDdd(ctx.getSource()), [ctx]);
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const n of AstUtils.streamAst(parsed.ast)) c[n.$type] = (c[n.$type] ?? 0) + 1;
    return c;
  }, [parsed]);
  return (
    <Box style={{ flex: 1, padding: 16, overflow: "auto" }} data-testid="c4system-v2-pane">
      <Stack gap="xs">
        <Title order={4}>Model v2 — preview</Title>
        <Text size="sm" c="dimmed">
          Phase 0 — wiring check. The visual designer is being rebuilt as a drill-down
          React Flow (system → module → context → aggregate → operation). v1 still lives
          in the "Model" tab while v2 is built phase by phase.
        </Text>
        <Text size="xs" c="dimmed" mt="md">Top-level constructs in the current source:</Text>
        <Stack gap={2} style={{ fontFamily: "monospace", fontSize: 12 }}>
          {TOP_LEVEL_KINDS.map((k) => (
            <Text key={k} size="xs" data-testid={`c4system-v2-count-${k}`}>
              {k}: {counts[k] ?? 0}
            </Text>
          ))}
        </Stack>
      </Stack>
    </Box>
  );
}
