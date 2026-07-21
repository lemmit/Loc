// Model builder v2 — Phase 1 (drill-down backbone, read-only).
//
// The canvas IS the navigator. Each level shows the children of the current
// node; a breadcrumb up top tracks the path; clicking a drillable node pushes
// a step. v1 is unchanged and still ships in the "Model" tab.

import { useCallback, useEffect, useMemo, useRef, useState, Fragment, type ReactNode } from "react";
import { Box, Button, Group, Text } from "@mantine/core";
import {
  Background,
  BaseEdge,
  Controls,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getSmoothStepPath,
  useEdgesState,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeProps,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { LayoutCtx } from "../../layout/ctx";
import { parseDdd } from "../parse";
import {
  addStatement,
  deleteStatement,
  editStatement,
  listStatementViews,
  moveStatement,
  type BodyLocator,
  type StmtView,
} from "../system/body";
import { setEmitEvent } from "../system/emit-event";
import { deleteField, listFields } from "../system/fields";
import { seedExpr } from "../system/expr-model";
import {
  editExprSlot,
  exprHints,
  slotCandidates,
  slotExpr,
  type ExprSlot,
} from "../system/expr-slots";
import { ExprSlotEditor, type ExprMode } from "../system/ExpressionEditor";
import { AstUtils, type AstNode } from "langium";
import { isEventDecl } from "../../../../src/language/generated/ast.js";
import { spliceNode } from "../edit-engine";
import { IDENTIFIER, renameMember } from "../system/rename";
import AddPalette from "./AddPalette";
import ConstructNode, { type ConstructNodeData } from "./ConstructNode";
import { renameByAstType } from "./rename-extra";
import {
  apiNames,
  boundedContextNames,
  deployableContexts,
  deployableServes,
  setDeployableContexts,
  setDeployableServes,
} from "../system/deployable-bindings";
import {
  isRebindableDeployableEdge,
  rebindDeployableEdgeTarget,
} from "./deployable-edge-rebind";
import StmtNode, { type StmtNodeData } from "./StmtNode";
import { buildViewGraph, findAggregate, type ViewGraph, type ViewKind, type ViewPath } from "./view-graph";
import {
  clearPersisted,
  loadPersisted,
  mergePersistedPositions,
  savePersisted,
  type PositionMap,
} from "./persisted-positions";

const KIND_COLOR: Record<ViewKind, string> = {
  system: "var(--mantine-color-indigo-8)",
  subdomain: "var(--mantine-color-blue-7)",
  context: "var(--mantine-color-cyan-8)",
  aggregate: "var(--mantine-color-teal-7)",
  entity: "var(--mantine-color-teal-6)",
  operation: "var(--mantine-color-orange-8)",
  workflow: "var(--mantine-color-orange-8)",
  valueobject: "var(--mantine-color-cyan-7)",
  event: "var(--mantine-color-grape-7)",
  repository: "var(--mantine-color-indigo-7)",
  find: "var(--mantine-color-indigo-8)",
  invariant: "var(--mantine-color-yellow-8)",
  function: "var(--mantine-color-yellow-8)",
  derived: "var(--mantine-color-cyan-7)",
  field: "var(--mantine-color-gray-7)",
  containment: "var(--mantine-color-teal-8)",
  api: "var(--mantine-color-pink-7)",
  storage: "var(--mantine-color-gray-7)",
  ui: "var(--mantine-color-violet-7)",
  deployable: "var(--mantine-color-red-8)",
  // `stmt` is rendered by a custom React Flow node, not styled here; the value
  // is a placeholder to satisfy the kind union.
  stmt: "transparent",
};

function toRfNodes(
  g: ViewGraph,
  stmtData: Map<string, Record<string, unknown>>,
  constructData: Map<string, ConstructNodeData>,
  persisted: PositionMap,
): Node[] {
  return g.nodes.map((n) => {
    if (n.kind === "stmt") {
      // Stmt nodes are an auto-layout sequence (operation/workflow flow view);
      // manual positioning makes no sense, so they're never persisted and stay
      // non-draggable. Ignore any persisted entry for `stmt:*` ids.
      return {
        id: n.id,
        type: "stmt",
        position: { x: n.x, y: n.y },
        data: stmtData.get(n.id) ?? ({} as Record<string, unknown>),
        draggable: false,
        selectable: false,
      } satisfies Node;
    }
    const cdata = constructData.get(n.id);
    if (cdata) {
      // The root banner re-centres over its children on every layout pass —
      // a user-saved position would fight that. Construct nodes otherwise
      // honour a persisted override if one exists for this view-path.
      const useDerived = n.isRoot === true;
      const overridden = !useDerived ? persisted[n.id] : undefined;
      const position = overridden ?? { x: n.x, y: n.y };
      return {
        id: n.id,
        type: "construct",
        position,
        data: cdata as unknown as Record<string, unknown>,
        draggable: !useDerived,
        selectable: false,
      } satisfies Node;
    }
    // Fallback (shouldn't fire — every non-stmt node should get construct data
    // — kept for safety).
    return {
      id: n.id,
      position: { x: n.x, y: n.y },
      data: { label: `${n.kind}\n${n.name}` },
      style: {
        background: KIND_COLOR[n.kind],
        color: "white",
        border: "1px solid rgba(255,255,255,0.25)",
        borderRadius: 6,
        fontSize: 11,
        width: 160,
        whiteSpace: "pre-line" as const,
        textAlign: "center" as const,
      },
    };
  });
}

const NODE_TYPES = { stmt: StmtNode, construct: ConstructNode } as const;

/** Total budget for a drill transition: ~200ms zoom-into the clicked node
 *  (drill-in only), then ~250ms `fitView` to settle into the new view.
 *  Drill-out skips the pre-step and just animates the fit. */
const DRILL_ZOOM_IN_MS = 200;
const DRILL_FIT_MS = 250;
/** Target zoom multiplier for the pre-step (zoom toward the clicked node).
 *  Capped so we don't overshoot the canvas — final `fitView` always corrects. */
const DRILL_ZOOM_IN_FACTOR = 1.5;

/** Respect `prefers-reduced-motion`. Read once at module load (the OS-level
 *  preference rarely changes mid-session and we don't subscribe to changes). */
function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** Pixel offset below the root banner where the `contains` fork's horizontal
 *  segment lands. React Flow's default smoothstep places the bend at the
 *  vertical midpoint between source and target — for a tall layout that
 *  midpoint falls into the workflow row and the fork bar visually overlaps
 *  the orchestrator tier. Pinning the bend to a small offset just below
 *  the banner keeps the fork in its own empty horizontal lane, above every
 *  tier of children. */
const CONTAINS_FORK_OFFSET = 50;

/** Custom edge component for `contains`. Forces the smoothstep bend to a
 *  fixed Y offset below the source (when leaving the bottom handle), or X
 *  offset right/left of the source (when leaving a side handle). Other
 *  React Flow edges fall back to the built-in routing. */
function ContainsEdge(props: EdgeProps): JSX.Element {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, style } = props;
  const centerY =
    sourcePosition === Position.Bottom ? sourceY + CONTAINS_FORK_OFFSET : undefined;
  const centerX =
    sourcePosition === Position.Left
      ? sourceX - CONTAINS_FORK_OFFSET
      : sourcePosition === Position.Right
        ? sourceX + CONTAINS_FORK_OFFSET
        : undefined;
  const [edgePath] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    centerX,
    centerY,
  });
  return <BaseEdge path={edgePath} style={style} />;
}

const EDGE_TYPES = { contains: ContainsEdge } as const;

// ViewKind → AST `$type`. Drives both the on-node delete (splice the matching
// AST node out of source) and the on-node rename (rewrite the declared name +
// every reference via Langium's NameProvider). Field and containment aren't
// here yet — they need v1's `renameMember` (text-token resolver, not a
// cross-ref). Stmt / root aren't constructs.
const AST_TYPE_BY_VIEW: Partial<Record<ViewKind, string>> = {
  system: "System",
  subdomain: "Subdomain",
  context: "BoundedContext",
  aggregate: "Aggregate",
  entity: "EntityPart",
  operation: "Operation",
  function: "FunctionDecl",
  derived: "DerivedProp",
  workflow: "Workflow",
  valueobject: "ValueObject",
  event: "EventDecl",
  repository: "Repository",
  find: "FindDecl",
  api: "Api",
  storage: "Storage",
  ui: "Ui",
  deployable: "Deployable",
};

/** Derive the `BodyLocator` for the operation / workflow currently in focus
 *  (the last step of the path), or null otherwise. Operation needs the
 *  containing aggregate step immediately above it. */
function leafBodyLocator(path: ViewPath): BodyLocator | null {
  const last = path[path.length - 1];
  if (!last) return null;
  if (last.kind === "workflow") return { kind: "workflow", name: last.name };
  if (last.kind === "operation") {
    const agg = path[path.length - 2];
    if (agg?.kind !== "aggregate") return null;
    return { kind: "operation", aggregate: agg.name, op: last.name };
  }
  return null;
}

/** Per-edge-kind stroke + dashing. Keeps the visual language consistent across
 *  views: bindings & writes are solid (commit-shaped), reads & constraints are
 *  dashed (observation-shaped), event emissions get their own accent. */
const EDGE_STYLE: Record<string, { stroke: string; dash?: string; labelFill?: string; opacity?: number; strokeWidth?: number }> = {
  binding:    { stroke: "var(--mantine-color-dark-2)" },
  next:       { stroke: "var(--mantine-color-dark-2)" },
  writes:     { stroke: "var(--mantine-color-teal-4)" },
  reads:      { stroke: "var(--mantine-color-gray-5)", dash: "4 3", labelFill: "var(--mantine-color-gray-5)" },
  constrains: { stroke: "var(--mantine-color-yellow-5)", dash: "2 3", labelFill: "var(--mantine-color-yellow-5)" },
  emits:      { stroke: "var(--mantine-color-grape-5)" },
  // Containment edges (root → child) are a faint structural backdrop —
  // visible enough to read the tree shape, dim enough that the semantic
  // edges (reads/writes/etc.) stay foreground.
  contains:   { stroke: "var(--mantine-color-dark-3)", opacity: 0.5, strokeWidth: 1 },
};

function toRfEdges(g: ViewGraph): Edge[] {
  return g.edges.map((e) => {
    const reconnectable: "target" | false = isRebindableDeployableEdge(e.label ?? "") ? "target" : false;
    const styleSpec = EDGE_STYLE[e.kind ?? "binding"] ?? EDGE_STYLE.binding;
    // Pivot (centre-routed) containment edges form the structural backbone
    // root↔aggregate/workflow/state and deserve more visual weight than the
    // peripheral containment trace. Pivot contains attach to the BOTTOM
    // handle; peripheral ones attach to LEFT / RIGHT.
    const isPivotContains = e.kind === "contains" && e.sourceHandle === "bottom";
    const stroke = isPivotContains ? "var(--mantine-color-dark-1)" : styleSpec.stroke;
    const opacity = isPivotContains ? 0.85 : styleSpec.opacity;
    const strokeWidth = isPivotContains ? 1.5 : styleSpec.strokeWidth;
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      // `contains` edges leave the root's left/right side handle so they trace
      // down the periphery instead of crossing every tier through the centre.
      // Smoothstep gives them an L-shape that hugs the canvas edge.
      ...(e.sourceHandle ? { sourceHandle: e.sourceHandle } : {}),
      // Containment edges use a custom edge component that pins the smoothstep
      // bend to a small offset below the banner (instead of the default
      // midpoint between source and target). That keeps the fork's horizontal
      // segment in its own empty lane between the banner and the first child
      // row, so workflows / operations don't end up sitting on the fork bar.
      ...(e.kind === "contains" ? { type: "contains" } : {}),
      label: e.label,
      reconnectable,
      // Only deployable bindings carry visible labels — reads/writes/constrains
      // use stroke styling instead, which keeps the aggregate view legible
      // even at zoom-out (label text would crowd the field column).
      ...(e.kind === "binding" ? {} : { label: undefined }),
      labelStyle: { fontSize: 9, fill: styleSpec.labelFill ?? "var(--mantine-color-dimmed)" },
      style: {
        stroke,
        strokeDasharray: styleSpec.dash,
        opacity,
        strokeWidth,
      },
      data: { edgeKind: e.kind ?? "binding" },
    };
  });
}

function Breadcrumb({ path, onJump }: { path: ViewPath; onJump: (depth: number) => void }): JSX.Element {
  return (
    <Group
      gap={4}
      px={8}
      py={4}
      bg="dark.7"
      wrap="wrap"
      style={{ borderBottom: "1px solid var(--mantine-color-dark-4)" }}
      data-testid="c4system-v2-breadcrumb"
    >
      <Button
        size="compact-xs"
        variant="subtle"
        data-testid="c4system-v2-crumb-home"
        onClick={() => onJump(0)}
      >
        Model
      </Button>
      {path.map((step, i) => (
        <Fragment key={`${step.kind}:${step.name}:${i}`}>
          <Text size="xs" c="dimmed">›</Text>
          <Button
            size="compact-xs"
            variant={i === path.length - 1 ? "light" : "subtle"}
            data-testid={`c4system-v2-crumb-${i}`}
            onClick={() => onJump(i + 1)}
          >
            <Text size="xs" c="dimmed" mr={4}>{step.kind}</Text>
            {step.name}
          </Button>
        </Fragment>
      ))}
    </Group>
  );
}

function Inner({ ctx }: { ctx: LayoutCtx }): JSX.Element {
  const [path, setPath] = useState<ViewPath>([]);
  const [rev, setRev] = useState(0);
  // Narrow the per-node widths on a phone-width canvas (< 768px → compact),
  // so StmtNode + the deployable's multi-select panel don't blow past the
  // edge of the small canvas.
  const compact = !ctx.isDesktop;
  // Inline-structured-editor open row, scoped per body locator + statement
  // index (+ optional field index for emit fields / call args). Mirrors v1.
  const [structuredKey, setStructuredKey] = useState<string | null>(null);
  const [exprMode, setExprMode] = useState<ExprMode>("structured");
  // Re-parse after every commit by depending on `rev` (`apply` bumps it).
  const parsed = useMemo(() => parseDdd(ctx.getSource()), [ctx, rev]);
  const graph = useMemo(() => buildViewGraph(parsed.ast, path), [parsed, path]);

  /** Single choke-point for source edits — bump `rev` so the next render
   *  re-parses, re-builds the view-graph and re-binds the per-stmt data. */
  const apply = (next: string): void => {
    ctx.onSourceChange(next, "builder");
    setRev((r) => r + 1);
  };

  // When the path's leaf is an operation / workflow, materialise its statement
  // views + per-statement editor handlers and pass them through the stmt node's
  // `data`. The pure view-graph already laid out the column; here we layer in
  // editing.
  const leafLoc = useMemo(() => leafBodyLocator(path), [path]);
  useEffect(() => {
    // Switching to a different operation / workflow / non-leaf collapses any
    // inline `ƒx` editor that was open in the previous body.
    setStructuredKey(null);
  }, [leafLoc]);

  const stmtData = useMemo(() => {
    const m = new Map<string, Record<string, unknown>>();
    if (!leafLoc) return m;
    const views = listStatementViews(parsed.ast, leafLoc) ?? [];
    // Aggregate field names for the assignment-target Autocomplete; only
    // meaningful in an operation body, empty for workflows.
    const targets: string[] =
      leafLoc.kind === "operation"
        ? ((): string[] => {
            const agg = findAggregate(parsed.ast, leafLoc.aggregate);
            return agg ? listFields(agg).map((f) => f.name) : [];
          })()
        : [];

    const base = leafLoc.kind === "operation" ? `${leafLoc.aggregate}.${leafLoc.op}` : leafLoc.name;
    const keyFor = (index: number, field?: number): string => `${base}:${index}:${field ?? ""}`;
    const slotFor = (index: number, field?: number): ExprSlot =>
      leafLoc.kind === "operation"
        ? {
            kind: "stmtExpr",
            owner: leafLoc.aggregate,
            op: leafLoc.op,
            index,
            ...(field !== undefined ? { field } : {}),
          }
        : {
            kind: "wfStmt",
            owner: leafLoc.name,
            index,
            ...(field !== undefined ? { field } : {}),
          };
    const renderEditor = (index: number, field?: number): ReactNode => {
      if (structuredKey !== keyFor(index, field)) return null;
      const slot = slotFor(index, field);
      const expr = slotExpr(parsed.ast, slot);
      if (!expr) return null;
      return (
        <ExprSlotEditor
          key={`${keyFor(index, field)}:${rev}`}
          seed={seedExpr(expr)}
          seedText={expr.$cstNode?.text ?? ""}
          candidates={slotCandidates(parsed.ast, slot)}
          loadHints={() => exprHints(ctx.getSource(), slot)}
          mode={exprMode}
          onMode={setExprMode}
          onCommit={(text) => {
            const next = editExprSlot(ctx.getSource(), slot, text);
            if (next == null) return false;
            apply(next);
            return true;
          }}
        />
      );
    };
    const toggle = (index: number, field?: number): void => {
      const k = keyFor(index, field);
      setStructuredKey((cur) => (cur === k ? null : k));
    };

    // All declared events in the model — candidates for the emit-row Select.
    const events: string[] = [];
    for (const n of AstUtils.streamAst(parsed.ast)) {
      if (isEventDecl(n)) events.push(n.name);
    }

    views.forEach((view, i) => {
      const data: StmtNodeData = {
        view,
        compact,
        targets,
        headCandidates: slotCandidates(parsed.ast, slotFor(i)),
        onCommit: (text) => {
          const next = editStatement(ctx.getSource(), leafLoc, i, text);
          if (next == null) return false;
          apply(next);
          return true;
        },
        valueEditor: renderEditor(i),
        onToggleEditor: () => toggle(i),
        renderArgEditor: (a) => renderEditor(i, a),
        onToggleArg: (a) => toggle(i, a),
        renderFieldEditor: (f) => renderEditor(i, f),
        onToggleField: (f) => toggle(i, f),
        events,
        onRepointEvent:
          view.kind === "emit"
            ? (eventName: string) => {
                const next = setEmitEvent(
                  ctx.getSource(),
                  leafLoc.kind === "operation" ? "aggregate" : "workflow",
                  leafLoc.kind === "operation" ? leafLoc.aggregate : leafLoc.name,
                  leafLoc.kind === "operation" ? leafLoc.op : undefined,
                  i,
                  eventName,
                );
                if (next != null) apply(next);
              }
            : undefined,
      };
      m.set(`stmt:${i}`, data as unknown as Record<string, unknown>);
    });
    return m;
    // `ctx` covers getSource changes (parent re-renders create a fresh ctx).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsed, leafLoc, structuredKey, exprMode, rev, compact]);

  /** Per-construct rename + delete handlers, keyed by the node id. Only
   *  populated for ViewKinds that map to v1's NodeKind (the ones
   *  `renameConstruct` and `spliceNode` cover); other nodes render as
   *  read-only constructs without action buttons. */
  const constructData = useMemo(() => {
    const m = new Map<string, ConstructNodeData>();
    const aggOwner = path[path.length - 1];

    // Inline structured editor + toggle for an expression slot — shared by
    // invariant (`{kind:"invariant", owner, index}`) and find filter
    // (`{kind:"findFilter", owner, name}`). The pane's `structuredKey` is a
    // single string identifying which expression is open (any view); toggling
    // the same key collapses it. Renders the v1 `ExprSlotEditor` keyed by
    // `rev` so it re-seeds on commit.
    const buildExprToggle = (slot: ExprSlot, key: string): {
      expressionEditor: ReactNode;
      onToggleExpression: () => void;
    } => {
      let expressionEditor: ReactNode = null;
      if (structuredKey === key) {
        const expr = slotExpr(parsed.ast, slot);
        if (expr) {
          expressionEditor = (
            <ExprSlotEditor
              key={`${key}:${rev}`}
              seed={seedExpr(expr)}
              seedText={expr.$cstNode?.text ?? ""}
              candidates={slotCandidates(parsed.ast, slot)}
              loadHints={() => exprHints(ctx.getSource(), slot)}
              mode={exprMode}
              onMode={setExprMode}
              onCommit={(text) => {
                const next = editExprSlot(ctx.getSource(), slot, text);
                if (next == null) return false;
                apply(next);
                return true;
              }}
            />
          );
        }
      }
      const onToggleExpression = (): void => {
        setStructuredKey((cur) => (cur === key ? null : key));
      };
      return { expressionEditor, onToggleExpression };
    };

    for (const n of graph.nodes) {
      if (n.kind === "stmt") continue;

      // The synthesised "title" node re-states the current container at the
      // top of the canvas. Read-only — no rename/delete/expr affordances, no
      // drill (you're already inside it).
      if (n.isRoot) {
        m.set(n.id, {
          kind: n.kind,
          name: n.name,
          color: KIND_COLOR[n.kind],
          drillable: false,
          isRoot: true,
          compact,
        });
        continue;
      }

      // Invariants are unnamed, so view-graph keys them by index. Delete
      // requires finding the right Invariant member by index in the aggregate.
      if (n.kind === "invariant" && aggOwner?.kind === "aggregate") {
        const aggName = aggOwner.name;
        const idx = Number(n.id.slice("invariant:".length));
        const onDelete = (): void => {
          const agg = findAggregate(parsed.ast, aggName);
          if (!agg) return;
          let i = 0;
          for (const member of agg.members) {
            if (member.$type === "Invariant") {
              if (i === idx) {
                apply(spliceNode(ctx.getSource(), member, ""));
                return;
              }
              i++;
            }
          }
        };
        const { expressionEditor, onToggleExpression } = buildExprToggle(
          { kind: "invariant", owner: aggName, index: idx },
          `inv:${aggName}:${idx}`,
        );
        m.set(n.id, {
          kind: n.kind,
          name: n.name,
          color: KIND_COLOR[n.kind],
          drillable: n.drillable,
          onDelete,
          expressionEditor,
          onToggleExpression,
          compact,
        });
        continue;
      }

      // Aggregate field / containment names are plain text tokens in
      // expressions (`this.field`, `x.field`, view binds, find filters), not
      // Langium cross-refs — so they need v1's `renameMember` resolver.
      // Delete uses `deleteField` (preserves comma / whitespace layout).
      if ((n.kind === "field" || n.kind === "containment") && aggOwner?.kind === "aggregate") {
        const aggName = aggOwner.name;
        const onRename = (next: string): void => {
          if (!IDENTIFIER.test(next) || next === n.name) return;
          void renameMember(ctx.getSource(), "aggregate", aggName, n.name, next).then((result) => {
            if (result != null) apply(result);
          });
        };
        const onDelete =
          n.kind === "field"
            ? () => {
                const agg = findAggregate(parsed.ast, aggName);
                if (!agg) return;
                const idx = listFields(agg).findIndex((f) => f.name === n.name);
                if (idx < 0) return;
                const next = deleteField(ctx.getSource(), "aggregate", aggName, idx);
                if (next != null) apply(next);
              }
            : undefined;
        m.set(n.id, {
          kind: n.kind,
          name: n.name,
          color: KIND_COLOR[n.kind],
          drillable: n.drillable,
          onRename,
          onDelete,
          compact,
        });
        continue;
      }

      const astType = AST_TYPE_BY_VIEW[n.kind];
      const onRename =
        astType != null
          ? (next: string) => {
              if (!IDENTIFIER.test(next) || next === n.name) return;
              void renameByAstType(ctx.getSource(), astType, n.name, next).then((result) => {
                if (result != null) apply(result);
              });
            }
          : undefined;
      const onDelete =
        astType != null
          ? () => {
              for (const ast of AstUtils.streamAst(parsed.ast)) {
                if (ast.$type === astType && (ast as { name?: string }).name === n.name) {
                  apply(spliceNode(ctx.getSource(), ast, ""));
                  return;
                }
              }
            }
          : undefined;

      // For deployable nodes, inline multi-selects for the multi-valued
      // bindings (modules / serves). Single-valued targets / ui are handled by
      // drag-rebind on the edges (Phase 4d).
      let multiSelects: ConstructNodeData["multiSelects"];
      if (n.kind === "deployable") {
        let dep: AstNode | undefined;
        for (const node of AstUtils.streamAst(parsed.ast)) {
          if (node.$type === "Deployable" && (node as { name?: string }).name === n.name) {
            dep = node;
            break;
          }
        }
        if (dep) {
          const depName = n.name;
          multiSelects = [
            {
              label: "contexts",
              data: boundedContextNames(parsed.ast),
              value: deployableContexts(dep),
              onChange: (v) => {
                const next = setDeployableContexts(ctx.getSource(), depName, v);
                if (next != null) apply(next);
              },
              testid: "c4system-v2-deployable-contexts",
            },
            {
              label: "serves",
              data: apiNames(parsed.ast),
              value: deployableServes(dep),
              onChange: (v) => {
                const next = setDeployableServes(ctx.getSource(), depName, v);
                if (next != null) apply(next);
              },
              testid: "c4system-v2-deployable-serves",
            },
          ];
        }
      }

      // Inline filter editor on a find node (only meaningful inside a
      // repository view, where the parent path step is the repo).
      let expressionEditor: ReactNode | undefined;
      let onToggleExpression: (() => void) | undefined;
      if (n.kind === "find" && aggOwner?.kind === "repository") {
        const repoName = aggOwner.name;
        const t = buildExprToggle(
          { kind: "findFilter", owner: repoName, name: n.name },
          `find:${repoName}:${n.name}`,
        );
        expressionEditor = t.expressionEditor;
        onToggleExpression = t.onToggleExpression;
      }

      m.set(n.id, {
        kind: n.kind,
        name: n.name,
        color: KIND_COLOR[n.kind],
        drillable: n.drillable,
        onRename,
        onDelete,
        multiSelects,
        expressionEditor,
        onToggleExpression,
        compact,
        unused: n.unused,
      });
    }
    return m;
    // structuredKey + exprMode drive the inline ƒx editor (buildExprToggle);
    // without them the toggle flips state but this memo never rebuilds the
    // node data, so the editor never opens for invariant / find / view slots.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, parsed, path, rev, compact, structuredKey, exprMode]);

  // Per-view persisted positions. The ref mirrors localStorage for the
  // current view and is re-read whenever `path` changes (drilling into a new
  // node, popping the breadcrumb, etc.). `persistedRev` bumps after every
  // commit so the toRfNodes effect re-spreads the overrides without making
  // `persistedRef.current` part of the deps array.
  const persistedRef = useRef<PositionMap>(loadPersisted(path));
  const [persistedRev, setPersistedRev] = useState(0);
  useEffect(() => {
    persistedRef.current = loadPersisted(path);
    setPersistedRev((r) => r + 1);
  }, [path]);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(toRfNodes(graph, stmtData, constructData, persistedRef.current));
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(toRfEdges(graph));
  useEffect(() => {
    setNodes(toRfNodes(graph, stmtData, constructData, persistedRef.current));
    setEdges(toRfEdges(graph));
    // persistedRev triggers a re-spread after a reset / cross-view restore;
    // persistedRef.current is otherwise read by reference inside toRfNodes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, stmtData, constructData, persistedRev, setNodes, setEdges]);

  const rf = useReactFlow();
  const nodesInitialized = useNodesInitialized();
  // `true` for the first render of a new path (drill-in or drill-out): tells
  // the fit-view effect to animate. Reset right after the fit fires, so
  // unrelated re-renders (rev bump, source edits, structuredKey toggles)
  // settle without re-animating an already-fit view.
  const animateNextFit = useRef(false);
  // Reduced-motion is captured once per `Inner` mount — cheap to recompute
  // here rather than thread through every callback.
  const reduceMotion = prefersReducedMotion();
  useEffect(() => {
    if (!nodesInitialized || graph.nodes.length === 0) return;
    const duration = animateNextFit.current && !reduceMotion ? DRILL_FIT_MS : 0;
    animateNextFit.current = false;
    void rf.fitView({ padding: 0.2, duration });
  }, [nodesInitialized, graph, rf, reduceMotion]);

  /** Persist a node's final position on drag end. Skip stmt nodes (never
   *  draggable) and the root banner (auto-centred). Same-position drags
   *  (no-op clicks reported as drag stop) are also skipped to avoid
   *  growing the storage with redundant entries. */
  const handleNodeDragStop = useCallback(
    (_e: unknown, n: Node): void => {
      if (n.id.startsWith("stmt:")) return;
      const v = graph.nodes.find((x) => x.id === n.id);
      if (v?.isRoot) return;
      const cur = persistedRef.current[n.id];
      if (cur && cur.x === n.position.x && cur.y === n.position.y) return;
      const next: PositionMap = { ...persistedRef.current, [n.id]: { x: n.position.x, y: n.position.y } };
      persistedRef.current = next;
      savePersisted(path, next);
      // Re-render so the "Reset layout" overlay appears on the first drag.
      // (toRfNodes reads positions from React Flow's internal state already —
      // this bump is only needed to surface `hasPersisted`.)
      setPersistedRev((r) => r + 1);
    },
    [graph, path],
  );

  /** Reset the persisted layout for the current view and re-apply the pure
   *  computed positions. Behind a `confirm` so a stray tap doesn't wipe the
   *  user's arrangement. */
  const resetLayout = (): void => {
    if (typeof window !== "undefined" && !window.confirm("Reset positions for this view?")) return;
    clearPersisted(path);
    persistedRef.current = {};
    setPersistedRev((r) => r + 1);
    void rf.fitView({ padding: 0.2 });
  };

  const hasPersisted = Object.keys(persistedRef.current).length > 0;

  const drill = (id: string): void => {
    const v = graph.nodes.find((x) => x.id === id);
    if (!v?.drillable) return;
    // VNode.drillTo overrides the default `{kind, name}` step — used by
    // containment leaves whose drill target is the entity they reference,
    // not the containment node itself.
    const step = v.drillTo ?? { kind: v.kind, name: v.name };
    animateNextFit.current = true;
    // Optional pre-step: zoom toward the clicked node so the path-push reads
    // as a hierarchical drill instead of a discrete jump. The new graph
    // renders synchronously below; the animated `fitView` (queued by the
    // nodes-initialized effect) settles on top of whatever zoom level
    // `setCenter` reached. No setTimeout chain — keeps tests deterministic.
    const node = rf.getNode(id);
    if (!reduceMotion && node?.position) {
      const w = node.measured?.width ?? 160;
      const h = node.measured?.height ?? 80;
      const cx = node.position.x + w / 2;
      const cy = node.position.y + h / 2;
      const targetZoom = Math.min(2, rf.getZoom() * DRILL_ZOOM_IN_FACTOR);
      try {
        void rf.setCenter(cx, cy, { zoom: targetZoom, duration: DRILL_ZOOM_IN_MS });
      } catch {
        // setCenter throws if React Flow is mid-teardown; safe to ignore.
      }
    }
    setPath((p) => [...p, step]);
  };

  /** Breadcrumb jumps animate the fit (drill-out), but skip the zoom-into
   *  pre-step — there's no specific node to zoom toward. */
  const jumpTo = (depth: number): void => {
    setPath((p) => {
      if (p.length === depth) return p;
      animateNextFit.current = true;
      return p.slice(0, depth);
    });
  };

  /** Repoint a deployable's `targets` / `ui` binding by dragging the edge's
   *  target endpoint to another node. Owner stays fixed; an incompatible drop
   *  or unparseable rewrite leaves the source untouched. */
  const onReconnect = (oldEdge: Edge, conn: Connection): void => {
    if (!conn.target || conn.source !== oldEdge.source) return;
    const label = typeof oldEdge.label === "string" ? oldEdge.label : "";
    const next = rebindDeployableEdgeTarget(ctx.getSource(), label, oldEdge.source, conn.target);
    if (next != null) apply(next);
  };

  return (
    <Box style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <Breadcrumb path={path} onJump={jumpTo} />
      <AddPalette path={path} source={ctx.getSource()} onChange={apply} />
      <Box style={{ flex: 1, position: "relative", minHeight: 0 }} data-testid="c4system-v2-pane">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onReconnect={onReconnect}
          onNodeDragStop={handleNodeDragStop}
          onNodeClick={(_, n) => drill(n.id)}
          fitView
          minZoom={0.1}
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <Controls />
        </ReactFlow>
        {hasPersisted && (
          <Button
            size="compact-xs"
            variant="default"
            onClick={resetLayout}
            data-testid="c4system-v2-reset-layout"
            title="Discard hand-dragged positions for this view and restore the derived layout"
            style={{ position: "absolute", top: 8, right: 8, zIndex: 5 }}
          >
            Reset layout
          </Button>
        )}
        {graph.nodes.length === 0 && (
          <Text
            size="xs"
            c="dimmed"
            style={{ position: "absolute", top: 12, left: 12, zIndex: 5 }}
            data-testid="c4system-v2-empty"
          >
            Nothing to show at {graph.title}. Use the breadcrumb to go back.
          </Text>
        )}
      </Box>
    </Box>
  );
}

export default function SystemBuilderV2Pane({ ctx }: { ctx: LayoutCtx }): JSX.Element {
  return (
    <ReactFlowProvider>
      <Inner ctx={ctx} />
    </ReactFlowProvider>
  );
}
