// Custom React Flow node for non-statement constructs (system / module /
// context / aggregate / operation / value object / event / repository / view /
// workflow / api / storage / ui / deployable). Replaces the default node so we
// can put a pencil affordance for **inline rename** and an `×` for **delete**
// right on the node — same parse-guarded paths v1 already uses.

import { Box, Button, Group, MultiSelect, Stack, Text, TextInput } from "@mantine/core";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { useEffect, useState, type ReactNode } from "react";
import type { ViewKind } from "./view-graph";

/** A small inline multi-select on the node — used for multi-valued bindings
 *  (a deployable's modules / serves) that can't be expressed as a single
 *  drag-rebindable edge. */
export interface NodeMultiSelect {
  label: string;
  data: string[];
  value: string[];
  onChange: (v: string[]) => void;
  testid: string;
}

export interface ConstructNodeData {
  kind: ViewKind;
  name: string;
  color: string;
  drillable: boolean;
  /** Provide to enable a pencil + inline rename input. */
  onRename?: (newName: string) => void;
  /** Provide to enable an `×` delete button. */
  onDelete?: () => void;
  /** Optional inline multi-selects (stacked below the name). */
  multiSelects?: NodeMultiSelect[];
  /** Inline structured editor for the construct's expression (find filter,
   *  invariant condition, …) — rendered below the name while expanded. */
  expressionEditor?: ReactNode;
  /** Toggle the inline structured editor. Provide together with
   *  `expressionEditor` to expose a `ƒx` button on the node. */
  onToggleExpression?: () => void;
  /** Narrow the node for a phone-width canvas (~390px viewport). */
  compact?: boolean;
  /** Render the node as a banner-style "title" — wider, larger text, no
   *  rename/delete affordances. Used for the synthesised root node that
   *  re-states the current view container above its children. */
  isRoot?: boolean;
  /** Advisory marker — the construct exists in source but isn't actually
   *  wired up (e.g. an event declared but never emitted). Dims the
   *  background, switches the border to dashed, and pins a small ⚠ next
   *  to the name so the user can spot the dead reference at a glance. */
  unused?: boolean;
}

export default function ConstructNode({ data }: NodeProps): JSX.Element {
  const d = data as unknown as ConstructNodeData;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(d.name);
  // Re-seed the draft + collapse the editor when the source-derived name
  // changes (after a successful rename the parent re-builds this node).
  useEffect(() => {
    setDraft(d.name);
    setEditing(false);
  }, [d.name]);

  const commit = (): void => {
    setEditing(false);
    const next = draft.trim();
    if (!next || next === d.name || !d.onRename) {
      setDraft(d.name);
      return;
    }
    d.onRename(next);
  };

  return (
    <Box
      // The root banner is auto-centred over its children on every layout
      // pass; persisted positions skip it explicitly. Marking it `nodrag`
      // here makes that intent visible at the DOM layer too — React Flow
      // ignores drag attempts inside this subtree.
      className={d.isRoot ? "nodrag" : undefined}
      style={{
        background: d.color,
        color: "white",
        // The root banner gets a chunkier outline + extra padding so it
        // reads as a "this is the container you're in", not a sibling node.
        // Unused nodes drop to 50% opacity + dashed border as an advisory.
        opacity: d.unused ? 0.55 : undefined,
        border: d.isRoot
          ? "2px solid rgba(255,255,255,0.55)"
          : d.unused
            ? "1px dashed rgba(255,255,255,0.4)"
            : "1px solid rgba(255,255,255,0.25)",
        borderRadius: d.isRoot ? 10 : 6,
        padding: d.isRoot ? "10px 16px" : "6px 8px",
        boxShadow: d.isRoot ? "0 2px 12px rgba(0,0,0,0.35)" : undefined,
        // Widen when there are multi-selects (chip pills) or an inline
        // expression editor (the structured tree); narrower on a phone canvas.
        // Title banners auto-size to their text via min/max.
        width: d.isRoot
          ? undefined
          : d.expressionEditor
            ? d.compact
              ? 320
              : 360
            : d.multiSelects && d.multiSelects.length > 0
              ? d.compact
                ? 210
                : 240
              : d.compact
                ? 150
                : 170,
        minWidth: d.isRoot ? (d.compact ? 200 : 280) : undefined,
        position: "relative",
        cursor: d.drillable ? "pointer" : "default",
      }}
      data-testid="c4system-v2-construct"
      data-construct-kind={d.kind}
      data-construct-name={d.name}
      data-construct-root={d.isRoot ? "true" : undefined}
    >
      <Handle
        type="target"
        position={Position.Top}
        style={{ background: "var(--mantine-color-dark-3)", visibility: d.isRoot ? "hidden" : undefined }}
      />
      {/* Left/right side handles on the root let `contains` edges leave the
       *  banner's sides and trace down the periphery, keeping the centre of
       *  the canvas free for semantic edges. Non-root nodes don't need these. */}
      {d.isRoot && (
        <>
          <Handle
            type="source"
            id="left"
            position={Position.Left}
            style={{ background: "var(--mantine-color-dark-3)", visibility: "hidden" }}
          />
          <Handle
            type="source"
            id="right"
            position={Position.Right}
            style={{ background: "var(--mantine-color-dark-3)", visibility: "hidden" }}
          />
        </>
      )}
      <Text
        size="xs"
        tt="uppercase"
        style={{ opacity: d.isRoot ? 0.85 : 0.65, fontSize: d.isRoot ? 10 : 9, letterSpacing: d.isRoot ? 1 : undefined }}
      >
        {d.kind}{d.drillable ? "  ↳" : ""}{d.unused ? "  ⚠ unused" : ""}
      </Text>
      {editing ? (
        <TextInput
          size="xs"
          autoFocus
          value={draft}
          // React Flow treats children flagged with `nodrag` as drag-exempt —
          // typing into the rename input must not start a node drag.
          className="nodrag"
          data-testid="c4system-v2-rename-input"
          onChange={(e) => setDraft(e.currentTarget.value)}
          onBlur={commit}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
            else if (e.key === "Escape") {
              setDraft(d.name);
              setEditing(false);
            }
          }}
          styles={{ input: { fontSize: 12, padding: "2px 4px", minHeight: 22 } }}
        />
      ) : (
        <Text
          size={d.isRoot ? "lg" : "sm"}
          style={{ fontWeight: d.isRoot ? 700 : 500 }}
        >
          {d.name}
        </Text>
      )}
      {(d.onRename || d.onDelete || d.onToggleExpression) && !editing && (
        <Group
          gap={2}
          // Drag-exempt: clicking ✎ / × / ƒx should never start a node drag.
          className="nodrag"
          style={{ position: "absolute", top: 2, right: 2 }}
        >
          {d.onToggleExpression && (
            <Button
              size="compact-xs"
              variant={d.expressionEditor ? "filled" : "subtle"}
              color="gray"
              data-testid="c4system-v2-expr-toggle"
              title="edit the expression structurally"
              styles={{ root: { paddingInline: 4, height: 18, minHeight: 18, color: "white" } }}
              onClick={(e) => {
                e.stopPropagation();
                d.onToggleExpression!();
              }}
            >
              ƒx
            </Button>
          )}
          {d.onRename && (
            <Button
              size="compact-xs"
              variant="subtle"
              color="gray"
              data-testid="c4system-v2-rename"
              styles={{ root: { paddingInline: 4, height: 18, minHeight: 18, color: "white" } }}
              onClick={(e) => {
                e.stopPropagation();
                setEditing(true);
              }}
            >
              ✎
            </Button>
          )}
          {d.onDelete && (
            <Button
              size="compact-xs"
              variant="subtle"
              color="red"
              data-testid="c4system-v2-delete"
              styles={{ root: { paddingInline: 4, height: 18, minHeight: 18, color: "white" } }}
              onClick={(e) => {
                e.stopPropagation();
                d.onDelete!();
              }}
            >
              ×
            </Button>
          )}
        </Group>
      )}
      {d.expressionEditor && (
        <Box mt={6} className="nodrag" data-testid="c4system-v2-expression-editor">
          {d.expressionEditor}
        </Box>
      )}
      {d.multiSelects && d.multiSelects.length > 0 && (
        <Stack gap={4} mt={6} className="nodrag">
          {d.multiSelects.map((sel) => (
            <MultiSelect
              key={sel.label}
              size="xs"
              label={sel.label}
              data={sel.data}
              value={sel.value}
              data-testid={sel.testid}
              onChange={sel.onChange}
              styles={{
                label: { fontSize: 9, color: "rgba(255,255,255,0.7)", marginBottom: 2 },
                input: { fontSize: 11, minHeight: 24 },
              }}
            />
          ))}
        </Stack>
      )}
      <Handle
        type="source"
        id="bottom"
        position={Position.Bottom}
        style={{ background: "var(--mantine-color-dark-3)" }}
      />
    </Box>
  );
}
