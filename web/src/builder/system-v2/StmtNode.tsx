// Custom React Flow node for a body statement in the v2 operation / workflow
// view. Phase 2a is a *read-only* rendering — each statement shows its kind +
// canonical text, with handles so the implicit "next" edges connect cleanly.
// Phase 2b will swap the body for the inline editor rows (AssignRow / CallRow /
// EmitRow / OtherRow) so edits happen right in the node.

import { Box, Stack, Text } from "@mantine/core";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { StmtView } from "../system/body";

export interface StmtNodeData {
  view: StmtView;
}

const KIND_LABEL: Record<StmtView["kind"], string> = {
  assign: "assign",
  call: "call",
  emit: "emit",
  other: "stmt",
};

function stmtText(v: StmtView): string {
  if (v.kind === "assign") return `${v.target} ${v.op} ${v.value}`;
  if (v.kind === "call") return `${v.head}(${v.args.join(", ")})`;
  if (v.kind === "emit")
    return `emit ${v.event} { ${v.fields.map((f) => `${f.name}: ${f.value}`).join(", ")} }`;
  return v.src;
}

const KIND_TINT: Record<StmtView["kind"], string> = {
  assign: "var(--mantine-color-teal-9)",
  call: "var(--mantine-color-blue-9)",
  emit: "var(--mantine-color-grape-9)",
  other: "var(--mantine-color-dark-5)",
};

export default function StmtNode({ data }: NodeProps): JSX.Element {
  const { view } = data as unknown as StmtNodeData;
  return (
    <Box
      style={{
        background: "var(--mantine-color-dark-6)",
        border: `1px solid ${KIND_TINT[view.kind]}`,
        borderLeft: `4px solid ${KIND_TINT[view.kind]}`,
        borderRadius: 6,
        padding: "8px 10px",
        width: 320,
      }}
      data-testid="c4system-v2-stmt"
      data-stmt-kind={view.kind}
    >
      <Handle type="target" position={Position.Top} style={{ background: "var(--mantine-color-dark-3)" }} />
      <Stack gap={2}>
        <Text size="xs" tt="uppercase" c="dimmed">{KIND_LABEL[view.kind]}</Text>
        <Text size="xs" style={{ fontFamily: "monospace", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {stmtText(view)}
        </Text>
      </Stack>
      <Handle type="source" position={Position.Bottom} style={{ background: "var(--mantine-color-dark-3)" }} />
    </Box>
  );
}
