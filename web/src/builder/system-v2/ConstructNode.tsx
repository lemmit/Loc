// Custom React Flow node for non-statement constructs (system / module /
// context / aggregate / operation / value object / event / repository / view /
// workflow / api / storage / ui / deployable). Replaces the default node so we
// can put a pencil affordance for **inline rename** and an `×` for **delete**
// right on the node — same parse-guarded paths v1 already uses.

import { Box, Button, Group, MultiSelect, Select, Stack, Text, TextInput } from "@mantine/core";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { useEffect, useState, type ReactNode } from "react";
import { InlineConfirm, confirmSites } from "../../util/confirm";
import { DETAIL_TOGGLE, IconFx, IconPencil, IconX, type DetailToggleKind } from "../icons";
import { IDENTIFIER, IDENTIFIER_RULE } from "../system/rename";
import type { VBadge, ViewKind } from "./view-graph";

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

/** A small inline text field on the node — used for the single-clause header
 *  edits that have no expression tree behind them (a find's `requires` gate,
 *  its `ignoring` list).  Committed on blur, and only when the text actually
 *  changed, so a stray focus never rewrites the source. */
export interface NodeTextInput {
  label: string;
  value: string;
  placeholder?: string;
  testid: string;
  onCommit: (value: string) => void;
  /** Provide to hang an `×` beside the field — a find parameter's row delete. */
  onDelete?: () => void;
}

/** A small inline single-value select on the node — the closed vocabularies
 *  that used to live in v1's inspector: a storage's `type:`, a deployable's
 *  `platform:`, a property's access modifier. */
export interface NodeSelect {
  label: string;
  data: string[];
  value: string | null;
  placeholder?: string;
  searchable?: boolean;
  testid: string;
  onChange: (value: string | null) => void;
}

/** A button in the node's detail block (`+ param`). */
export interface NodeAction {
  label: string;
  testid: string;
  onClick: () => void;
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
  /** Optional inline text fields (stacked below the name) for single-clause
   *  header edits — a find's `requires` gate / `ignoring` list. */
  inputs?: NodeTextInput[];
  /** Optional inline single-value selects (closed vocabularies). */
  selects?: NodeSelect[];
  /** Optional buttons under the detail block (`+ param`). */
  actions?: NodeAction[];
  /** When set, the detail block (`inputs` / `selects` / `actions`) is COLLAPSED
   *  behind a toggle button carrying this label — a property's five modifier
   *  clauses would otherwise make every field node a form.  The open/closed
   *  state is the PANE's (`detailsOpen` + `onToggleDetails`), not local: an
   *  expanded node is taller than its layout row, so the pane also has to lift
   *  it above the siblings it now overlaps. */
  detailsLabel?: DetailToggleKind;
  detailsOpen?: boolean;
  onToggleDetails?: () => void;
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
  /** Read-only detail lines under the name (a projection's `select`, a
   *  channel's carried events, …). Purely derived — no edit affordance. */
  summary?: string[];
  /** Authorization / redaction chips (`requires` / `when` / `mask`). */
  badges?: VBadge[];
}

/** Chip glyph per badge label. The lock reads as "gated"; the cog as
 *  "conditionally applicable" (a `when` guard isn't an authz decision). */
const BADGE_ICON: Record<VBadge["label"], string> = {
  requires: "🔒",
  when: "⚙",
  mask: "🔒",
};

/** One inline header field. Local draft state so typing doesn't re-parse the
 *  document on every keystroke; the parent's re-derived `value` re-seeds it. */
function NodeInput({ spec }: { spec: NodeTextInput }): JSX.Element {
  const [draft, setDraft] = useState(spec.value);
  useEffect(() => setDraft(spec.value), [spec.value]);
  const field = (
    <TextInput
      size="xs"
      label={spec.label}
      value={draft}
      placeholder={spec.placeholder}
      className="nodrag"
      style={spec.onDelete ? { flex: 1, minWidth: 0 } : undefined}
      data-testid={spec.testid}
      aria-label={spec.label}
      onChange={(e) => setDraft(e.currentTarget.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => {
        if (draft.trim() !== spec.value.trim()) spec.onCommit(draft);
      }}
      styles={{
        label: { fontSize: 9, color: "rgba(255,255,255,0.7)", marginBottom: 2 },
        input: { fontSize: 11, minHeight: 24, fontFamily: "monospace" },
      }}
    />
  );
  if (!spec.onDelete) return field;
  return (
    <Group gap={2} wrap="nowrap" align="flex-end">
      {field}
      <Button
        size="compact-xs"
        variant="subtle"
        color="red"
        data-testid={`${spec.testid}-del`}
        aria-label={`remove ${spec.label}`}
        styles={{ root: { paddingInline: 4, height: 22, minHeight: 22, color: "white" } }}
        onClick={(e) => {
          e.stopPropagation();
          spec.onDelete!();
        }}
      >
        <IconX />
      </Button>
    </Group>
  );
}

/** One inline select. Stateless — the source-derived `value` is the truth, and
 *  a pick commits immediately (there is no half-typed state to protect). */
function NodeSelectField({ spec }: { spec: NodeSelect }): JSX.Element {
  return (
    <Select
      size="xs"
      label={spec.label}
      data={spec.data}
      value={spec.value}
      placeholder={spec.placeholder}
      searchable={spec.searchable}
      className="nodrag"
      data-testid={spec.testid}
      aria-label={spec.label}
      onChange={spec.onChange}
      onClick={(e) => e.stopPropagation()}
      styles={{
        label: { fontSize: 9, color: "rgba(255,255,255,0.7)", marginBottom: 2 },
        input: { fontSize: 11, minHeight: 24 },
      }}
    />
  );
}

export default function ConstructNode({ data }: NodeProps): JSX.Element {
  const d = data as unknown as ConstructNodeData;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(d.name);
  // The `×` ARMS an inline confirm under the name (M-T8.17, audit H8: a
  // whole aggregate used to vanish on one click while a cosmetic layout
  // reset asked first).  `onDelete` only fires from the confirm's Yes.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // A rename draft that isn't an identifier used to snap back to the old
  // name with no message (H10).  Now the input stays open and shows the rule.
  const [renameError, setRenameError] = useState<string | null>(null);
  const hasDetail =
    (d.inputs?.length ?? 0) > 0 || (d.selects?.length ?? 0) > 0 || (d.actions?.length ?? 0) > 0;
  const detailShown = hasDetail && (!d.detailsLabel || d.detailsOpen === true);
  // Re-seed the draft + collapse the editor when the source-derived name
  // changes (after a successful rename the parent re-builds this node).
  useEffect(() => {
    setDraft(d.name);
    setEditing(false);
    setConfirmingDelete(false);
    setRenameError(null);
  }, [d.name]);

  const commit = (): void => {
    const next = draft.trim();
    if (!next || next === d.name || !d.onRename) {
      setEditing(false);
      setRenameError(null);
      setDraft(d.name);
      return;
    }
    if (!IDENTIFIER.test(next)) {
      // Stay in edit mode with the rule shown; Escape still cancels.
      setRenameError(IDENTIFIER_RULE);
      return;
    }
    setEditing(false);
    setRenameError(null);
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
            : (d.multiSelects && d.multiSelects.length > 0) || detailShown
              ? d.compact
                ? 210
                : 240
              : // Read-only construct detail needs room for a `from Order as o`
                // / `allow deep on Invoice` line without wrapping every word.
                d.summary && d.summary.length > 0
                ? d.compact
                  ? 200
                  : 230
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
          error={renameError}
          onChange={(e) => {
            setDraft(e.currentTarget.value);
            if (renameError) setRenameError(null);
          }}
          onBlur={commit}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            else if (e.key === "Escape") {
              setDraft(d.name);
              setRenameError(null);
              setEditing(false);
            }
          }}
          styles={{ input: { fontSize: 12, padding: "2px 4px", minHeight: 22 }, error: { fontSize: 9 } }}
        />
      ) : (
        <Text
          size={d.isRoot ? "lg" : "sm"}
          style={{ fontWeight: d.isRoot ? 700 : 500 }}
        >
          {d.name}
        </Text>
      )}
      {d.badges && d.badges.length > 0 && (
        <Group gap={3} mt={3}>
          {d.badges.map((b) => (
            <Text
              key={b.label}
              size="xs"
              // The gate expression itself is the tooltip — the chip only says
              // THAT the construct is guarded, hovering says by what.
              title={`${b.label} ${b.detail}`}
              data-testid="c4system-v2-badge"
              data-badge-label={b.label}
              style={{
                fontSize: 9,
                lineHeight: 1.4,
                padding: "0 4px",
                borderRadius: 8,
                background: "rgba(0,0,0,0.3)",
                border: "1px solid rgba(255,255,255,0.3)",
              }}
            >
              {BADGE_ICON[b.label]} {b.label}
            </Text>
          ))}
        </Group>
      )}
      {d.summary && d.summary.length > 0 && (
        <Stack gap={0} mt={3}>
          {d.summary.map((line, i) => (
            <Text
              // Two summary lines CAN repeat (a projection with two identical
              // join clauses), so the index disambiguates the React key.
              key={`${i}-${line}`}
              size="xs"
              title={line}
              data-testid="c4system-v2-summary"
              style={{
                fontSize: 9,
                lineHeight: 1.5,
                opacity: 0.75,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {line}
            </Text>
          ))}
        </Stack>
      )}
      {(d.onRename || d.onDelete || d.onToggleExpression || (d.detailsLabel && hasDetail)) && !editing && (
        <Group
          gap={2}
          // Drag-exempt: clicking ✎ / × / ƒx / ƒ should never start a node drag.
          className="nodrag"
          style={{ position: "absolute", top: 2, right: 2 }}
        >
          {d.detailsLabel && hasDetail && (
            <Button
              size="compact-xs"
              variant={d.detailsOpen ? "filled" : "subtle"}
              color="gray"
              data-testid="c4system-v2-details-toggle"
              title={DETAIL_TOGGLE[d.detailsLabel].label}
              aria-label={DETAIL_TOGGLE[d.detailsLabel].label}
              aria-expanded={d.detailsOpen === true}
              styles={{ root: { paddingInline: 4, height: 18, minHeight: 18, color: "white" } }}
              onClick={(e) => {
                e.stopPropagation();
                d.onToggleDetails?.();
              }}
            >
              {(() => {
                const Icon = DETAIL_TOGGLE[d.detailsLabel].Icon;
                return <Icon />;
              })()}
            </Button>
          )}
          {d.onToggleExpression && (
            <Button
              size="compact-xs"
              variant={d.expressionEditor ? "filled" : "subtle"}
              color="gray"
              data-testid="c4system-v2-expr-toggle"
              title="edit the expression structurally"
              aria-label="edit the expression structurally"
              aria-expanded={d.expressionEditor != null}
              styles={{ root: { paddingInline: 4, height: 18, minHeight: 18, color: "white" } }}
              onClick={(e) => {
                e.stopPropagation();
                d.onToggleExpression!();
              }}
            >
              <IconFx />
            </Button>
          )}
          {d.onRename && (
            <Button
              size="compact-xs"
              variant="subtle"
              color="gray"
              data-testid="c4system-v2-rename"
              title={`rename ${d.kind} ${d.name}`}
              aria-label={`rename ${d.kind} ${d.name}`}
              styles={{ root: { paddingInline: 4, height: 18, minHeight: 18, color: "white" } }}
              onClick={(e) => {
                e.stopPropagation();
                setEditing(true);
              }}
            >
              <IconPencil />
            </Button>
          )}
          {d.onDelete && (
            <Button
              size="compact-xs"
              variant="subtle"
              color="red"
              data-testid="c4system-v2-delete"
              title={`delete ${d.kind} ${d.name}`}
              aria-label={`delete ${d.kind} ${d.name}`}
              styles={{ root: { paddingInline: 4, height: 18, minHeight: 18, color: "white" } }}
              onClick={(e) => {
                e.stopPropagation();
                setConfirmingDelete(true);
              }}
            >
              <IconX />
            </Button>
          )}
        </Group>
      )}
      {confirmingDelete && d.onDelete && (
        <Box mt={6} className="nodrag">
          <InlineConfirm
            spec={confirmSites.declarationDelete(d.kind, d.name)}
            stacked
            size="compact-xs"
            onConfirm={() => {
              setConfirmingDelete(false);
              d.onDelete?.();
            }}
            onCancel={() => setConfirmingDelete(false)}
            testids={{ base: "c4system-v2-delete" }}
          />
        </Box>
      )}
      {d.expressionEditor && (
        <Box mt={6} className="nodrag" data-testid="c4system-v2-expression-editor">
          {d.expressionEditor}
        </Box>
      )}
      {detailShown && (
        <Stack
          gap={4}
          mt={6}
          className="nodrag"
          data-testid="c4system-v2-node-inputs"
          // One guard for the whole detail block: a click inside it must never
          // reach the node (which would DRILL). Per-control `onClick` handlers
          // are not enough — Mantine's `Select` sets its own `onClick` on the
          // input to open the dropdown, overriding a spread one.
          onClick={(e) => e.stopPropagation()}
        >
          {(d.inputs ?? []).map((spec) => (
            <NodeInput key={spec.testid} spec={spec} />
          ))}
          {(d.selects ?? []).map((spec) => (
            <NodeSelectField key={spec.testid} spec={spec} />
          ))}
          {(d.actions ?? []).length > 0 && (
            <Group gap={4} wrap="wrap">
              {(d.actions ?? []).map((a) => (
                <Button
                  key={a.testid}
                  size="compact-xs"
                  variant="light"
                  data-testid={a.testid}
                  onClick={(e) => {
                    e.stopPropagation();
                    a.onClick();
                  }}
                >
                  {a.label}
                </Button>
              ))}
            </Group>
          )}
        </Stack>
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
