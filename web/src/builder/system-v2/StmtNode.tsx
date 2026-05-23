// Custom React Flow node for a body statement in the v2 operation / workflow
// view. Phase 2b reuses v1's inline editor rows (AssignRow / CallRow / EmitRow
// / OtherRow) so edits happen right in the node — same controls, same `ƒx`
// expansion, just laid out as a flow instead of a list.

import { Box, Text } from "@mantine/core";
import { useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { AssignRow, CallRow, EmitRow, OtherRow } from "../system/BodyEditor";
import type { StmtView } from "../system/body";
import type { ReactNode } from "react";

export interface StmtNodeData {
  view: StmtView;
  targets: string[];
  headCandidates: string[];
  /** Commit a re-stringified statement (target+op+value, head(args), or the
   *  whole emit / other text). Returns false on parse-failure, mirroring
   *  v1's `commitEdit` contract; the row flags the error locally. */
  onCommit: (text: string) => boolean;
  /** Inline structured editor for the value / single-expr / arg / field, or
   *  null when the corresponding row is collapsed. */
  valueEditor: ReactNode;
  onToggleEditor?: () => void;
  renderArgEditor?: (argIndex: number) => ReactNode;
  onToggleArg?: (argIndex: number) => void;
  renderFieldEditor?: (fieldIndex: number) => ReactNode;
  onToggleField?: (fieldIndex: number) => void;
  /** Candidates for an emit row's event Select; provide together with
   *  `onRepointEvent` to make the event re-pointable inline. */
  events?: string[];
  onRepointEvent?: (eventName: string) => void;
}

const KIND_LABEL: Record<StmtView["kind"], string> = {
  assign: "assign",
  call: "call",
  emit: "emit",
  other: "stmt",
};

const KIND_TINT: Record<StmtView["kind"], string> = {
  assign: "var(--mantine-color-teal-9)",
  call: "var(--mantine-color-blue-9)",
  emit: "var(--mantine-color-grape-9)",
  other: "var(--mantine-color-dark-5)",
};

export default function StmtNode({ data }: NodeProps): JSX.Element {
  const d = data as unknown as StmtNodeData;
  const { view } = d;
  // Local error flag — each row's onCommit returns false on a parse failure;
  // the row's `error` prop drives the `invalid` styling. Cleared on focus.
  const [error, setError] = useState(false);
  const commit = (text: string): void => {
    if (!d.onCommit(text)) setError(true);
  };
  const clear = (): void => setError(false);

  let body: JSX.Element;
  if (view.kind === "assign") {
    body = (
      <AssignRow
        view={view}
        targets={d.targets}
        valueEditor={d.valueEditor}
        onToggleEditor={d.onToggleEditor}
        error={error}
        onCommit={commit}
        onClearError={clear}
      />
    );
  } else if (view.kind === "call") {
    body = (
      <CallRow
        view={view}
        headCandidates={d.headCandidates}
        error={error}
        onCommit={commit}
        onClearError={clear}
        renderArgEditor={d.renderArgEditor}
        onToggleArg={d.onToggleArg}
      />
    );
  } else if (view.kind === "emit") {
    body = (
      <EmitRow
        view={view}
        error={error}
        onCommit={commit}
        onClearError={clear}
        renderFieldEditor={d.renderFieldEditor}
        onToggleField={d.onToggleField}
        events={d.events}
        onRepointEvent={d.onRepointEvent}
      />
    );
  } else {
    body = (
      <OtherRow
        src={view.src}
        valueEditor={d.valueEditor}
        onToggleEditor={d.onToggleEditor}
        error={error}
        onCommit={commit}
        onClearError={clear}
      />
    );
  }

  return (
    <Box
      // Stop React Flow from interpreting interactions inside the editor as a
      // node drag (selection, text-input clicks, dropdowns).
      className="nodrag nopan"
      style={{
        background: "var(--mantine-color-dark-6)",
        border: `1px solid ${KIND_TINT[view.kind]}`,
        borderLeft: `4px solid ${KIND_TINT[view.kind]}`,
        borderRadius: 6,
        padding: "8px 10px",
        width: 380,
      }}
      data-testid="c4system-v2-stmt"
      data-stmt-kind={view.kind}
    >
      <Handle type="target" position={Position.Top} style={{ background: "var(--mantine-color-dark-3)" }} />
      <Text size="xs" tt="uppercase" c="dimmed" mb={4}>
        {KIND_LABEL[view.kind]}
      </Text>
      {body}
      <Handle type="source" position={Position.Bottom} style={{ background: "var(--mantine-color-dark-3)" }} />
    </Box>
  );
}
