// Custom React Flow node for a body statement in the v2 operation / workflow
// view. Phase 2b reuses v1's inline editor rows (the shared `StmtRow`
// dispatcher) so edits happen right in the node — same controls, same `ƒx`
// expansion, just laid out as a flow instead of a list.

import { Box, Button, Group, Text } from "@mantine/core";
import { useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { StmtRow, type NestedExprEditors } from "../system/BodyEditor";
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
  /** Row commands — the flow twin of the list editor's ↑ / ↓ / × controls.
   *  Optional, so a read-only flow can omit them; `canMove*` disable the
   *  arrows at the ends of the body. */
  onDelete?: () => void;
  onMove?: (dir: -1 | 1) => void;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
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
  /** Path-addressed `ƒx` editors for statements nested inside this one's
   *  `for` / `if let` / `match` blocks (the container rows hand them down). */
  nested?: NestedExprEditors;
  /** Narrow the node for a phone-width canvas (~390px viewport). */
  compact?: boolean;
}

// Label + tint per statement form. The kind comes straight off the AST node
// type (`stmtView` structures every grammar form), so the node no longer sniffs
// the leading keyword out of a verbatim `other` row to tell a precondition from
// a `let`; `other` is only what the grammar has no structured row for.
const KIND_LABEL: Record<StmtView["kind"], string> = {
  assign: "assign",
  call: "call",
  emit: "emit",
  let: "let",
  return: "return",
  precondition: "precondition",
  requires: "requires",
  for: "for",
  ifLet: "if let",
  match: "match",
  other: "stmt",
};

const KIND_TINT: Record<StmtView["kind"], string> = {
  assign: "var(--mantine-color-teal-9)",
  call: "var(--mantine-color-blue-9)",
  emit: "var(--mantine-color-grape-9)",
  // Form-specific tints — a precondition / requires / let / control-flow block
  // each reads differently at a glance instead of a uniform "stmt".
  precondition: "var(--mantine-color-yellow-9)",
  requires: "var(--mantine-color-orange-9)",
  let: "var(--mantine-color-cyan-9)",
  return: "var(--mantine-color-lime-9)",
  for: "var(--mantine-color-indigo-9)",
  ifLet: "var(--mantine-color-violet-9)",
  match: "var(--mantine-color-pink-9)",
  other: "var(--mantine-color-dark-5)",
};

export default function StmtNode({ data }: NodeProps): JSX.Element {
  const d = data as unknown as StmtNodeData;
  const { view } = d;
  const kind = view.kind;
  // Local error flag — each row's onCommit returns false on a parse failure;
  // the row's `error` prop drives the `invalid` styling. Cleared on focus.
  const [error, setError] = useState(false);
  const commit = (text: string): void => {
    if (!d.onCommit(text)) setError(true);
  };
  const clear = (): void => setError(false);

  const body = (
    <StmtRow
      view={view}
      targets={d.targets}
      headCandidates={d.headCandidates}
      error={error}
      onCommit={commit}
      onClearError={clear}
      valueEditor={d.valueEditor}
      onToggleEditor={d.onToggleEditor}
      renderArgEditor={d.renderArgEditor}
      onToggleArg={d.onToggleArg}
      renderFieldEditor={d.renderFieldEditor}
      onToggleField={d.onToggleField}
      events={d.events}
      onRepointEvent={d.onRepointEvent}
      nested={d.nested}
    />
  );

  return (
    <Box
      // Stop React Flow from interpreting interactions inside the editor as a
      // node drag (selection, text-input clicks, dropdowns).
      className="nodrag nopan"
      style={{
        background: "var(--mantine-color-dark-6)",
        border: `1px solid ${KIND_TINT[kind]}`,
        borderLeft: `4px solid ${KIND_TINT[kind]}`,
        borderRadius: 6,
        padding: "8px 10px",
        width: d.compact ? 320 : 380,
      }}
      data-testid="c4system-v2-stmt"
      data-stmt-kind={kind}
      data-stmt-subkind={kind}
    >
      <Handle type="target" position={Position.Top} style={{ background: "var(--mantine-color-dark-3)" }} />
      <Group gap={2} justify="space-between" wrap="nowrap" mb={4}>
        <Text size="xs" tt="uppercase" c="dimmed">
          {KIND_LABEL[kind]}
        </Text>
        {(d.onMove || d.onDelete) && (
          <Group gap={0} wrap="nowrap">
            {d.onMove && (
              <>
                <Button
                  size="compact-xs"
                  variant="subtle"
                  data-testid="c4system-v2-stmt-up"
                  disabled={d.canMoveUp === false}
                  onClick={() => d.onMove?.(-1)}
                >
                  ↑
                </Button>
                <Button
                  size="compact-xs"
                  variant="subtle"
                  data-testid="c4system-v2-stmt-down"
                  disabled={d.canMoveDown === false}
                  onClick={() => d.onMove?.(1)}
                >
                  ↓
                </Button>
              </>
            )}
            {d.onDelete && (
              <Button
                size="compact-xs"
                variant="subtle"
                color="red"
                data-testid="c4system-v2-stmt-delete"
                onClick={() => d.onDelete?.()}
              >
                ×
              </Button>
            )}
          </Group>
        )}
      </Group>
      {body}
      <Handle type="source" position={Position.Bottom} style={{ background: "var(--mantine-color-dark-3)" }} />
    </Box>
  );
}
