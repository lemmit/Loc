// The Model builder — the playground's ONE structural editing pane
// (M-T8.13: v1's parallel flat-canvas pane was retired into this one).
//
// The canvas IS the navigator. Each level shows the children of the current
// node; a breadcrumb up top tracks the path; clicking a drillable node pushes
// a step. At the ROOT the breadcrumb also offers **Overview** — v1's flat
// whole-system graph, read-only, carrying the comprehension features a
// drill-down cannot serve (coverage heatmap, cross-model search + kind
// filter, wire shape); opening a node there jumps the drill-down to it.

import { useCallback, useEffect, useMemo, useRef, useState, Fragment, type ReactNode } from "react";
import { Box, Button, Checkbox, Group, Stack, Text, TextInput } from "@mantine/core";
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
import { usePaneHarness } from "../pane-harness";
import {
  aggregateBody,
  deleteStatement,
  editStatement,
  listBodies,
  listStatementViews,
  moveStatement,
  type BodyKey,
  type BodyLocator,
  type BodyRef,
  type StmtPath,
} from "../system/body";
import type { NestedExprEditors } from "../system/BodyEditor";
import { setEmitEvent } from "../system/emit-event";
import {
  FIELD_ACCESS,
  deleteField,
  listFieldModifiers,
  listFields,
  retypeField,
  setFieldAccess,
  setFieldCheck,
  setFieldDefault,
  setFieldMask,
  setFieldSensitivity,
} from "../system/fields";
import {
  addFindParam,
  deleteFindParam,
  freshParamName,
  listFindParams,
  renameFindParam,
  retypeFindParam,
  setFindReturnType,
} from "../system/find-params";
import {
  PLATFORMS,
  STORAGE_TYPES,
  deployablePlatform,
  deployablePort,
  setDeployablePlatform,
  setDeployablePort,
  setStorageType,
  storageType,
} from "../system/infra-props";
import { currentTarget, isRebindKind, rebindReference, rebindTargets, targetKindOf } from "../system/rebind";
import { seedExpr } from "../system/expr-model";
import {
  editExprSlot,
  encodeStmtPath,
  exprHints,
  slotCandidates,
  slotExpr,
  type ExprSlot,
} from "../system/expr-slots";
import {
  addOpParam,
  deleteOpParam,
  findSurface,
  freshOpParamName,
  opSurface,
  renameOpParam,
  retypeOpParam,
  setFindGate,
  setFindIgnoring,
  setOpGate,
  setOpModifier,
  setOpReturnType,
} from "../system/op-surface";
import { ExprSlotEditor, type ExprMode } from "../system/ExpressionEditor";
import { AstUtils, type AstNode } from "langium";
import { isEventDecl } from "../../../../src/language/generated/ast.js";
import { RefusalLine } from "../refusal";
import { IDENTIFIER, renameMember } from "../system/rename";
import AddPalette from "./AddPalette";
import ConstructNode, { type ConstructNodeData } from "./ConstructNode";
import OverviewCanvas from "./OverviewCanvas";
import { deleteByAstType, deleteInvariant } from "./delete-extra";
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
import {
  buildViewGraph,
  deleteContainment,
  findAggregate,
  findWorkflow,
  type ViewGraph,
  type ViewKind,
  type ViewPath,
  type ViewStep,
} from "./view-graph";
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
  // ---- read-only constructs -------------------------------------------
  // Colour by FAMILY, not by declaration, so the canvas stays readable at a
  // glance: read models cyan-ish, application/behaviour orange, authz yellow,
  // vocabulary grape, infrastructure indigo, capability/test gray.
  projection: "var(--mantine-color-cyan-8)",
  domainservice: "var(--mantine-color-orange-7)",
  commandhandler: "var(--mantine-color-orange-9)",
  queryhandler: "var(--mantine-color-cyan-9)",
  dsoperation: "var(--mantine-color-orange-8)",
  criterion: "var(--mantine-color-lime-8)",
  retrieval: "var(--mantine-color-lime-9)",
  channel: "var(--mantine-color-grape-8)",
  payload: "var(--mantine-color-grape-9)",
  enum: "var(--mantine-color-grape-6)",
  seed: "var(--mantine-color-green-9)",
  policy: "var(--mantine-color-yellow-9)",
  permissions: "var(--mantine-color-yellow-7)",
  auth: "var(--mantine-color-yellow-9)",
  tenancy: "var(--mantine-color-yellow-8)",
  user: "var(--mantine-color-yellow-7)",
  filter: "var(--mantine-color-gray-8)",
  stamp: "var(--mantine-color-gray-8)",
  implements: "var(--mantine-color-gray-8)",
  with: "var(--mantine-color-gray-8)",
  capability: "var(--mantine-color-gray-6)",
  unique: "var(--mantine-color-gray-8)",
  test: "var(--mantine-color-green-8)",
  teste2e: "var(--mantine-color-green-7)",
  migration: "var(--mantine-color-red-9)",
  theme: "var(--mantine-color-violet-8)",
  layout: "var(--mantine-color-violet-9)",
  resource: "var(--mantine-color-indigo-9)",
  channelsource: "var(--mantine-color-indigo-6)",
  timer: "var(--mantine-color-blue-8)",
  create: "var(--mantine-color-orange-7)",
  destroy: "var(--mantine-color-red-7)",
  apply: "var(--mantine-color-grape-8)",
  // `body` is a path-step kind only — the drilled view's root banner wears the
  // member's own create / destroy / apply tint, so no node ever renders as
  // one. The entry exists to keep this map total over `ViewKind`.
  body: "var(--mantine-color-orange-7)",
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
        // An open detail block makes the node taller than its layout row, so
        // it overlaps the next node in the column. Lift it, or the sibling
        // painted after it swallows the clicks on the block's own controls.
        ...(cdata.detailsOpen ? { zIndex: 10 } : {}),
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

/** Stand-in graph used while the source doesn't parse — keeps the React Flow
 *  hooks below fed with a valid (empty) shape instead of one derived from a
 *  partially-recovered AST. */
const EMPTY_GRAPH: ViewGraph = { title: "Model", nodes: [], edges: [] };

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
  // Read-only constructs whose declared name is a plain `ID` the Langium
  // NameProvider can rename (and whose whole declaration is a self-contained
  // splice) get the same rename + delete affordances as `valueobject`. The
  // rest of the new kinds stay ACTION-LESS on purpose: the unnamed forms
  // (`filter` / `stamp` / `unique` / `with` / block-form `policy` / `seed` /
  // `tenancy` / `auth` / `user` / `theme` / `permissions`) have no name to
  // rewrite and no unambiguous by-name lookup to splice, and the STRING-named
  // ones (`test` / `teste2e` / `migration`) would have their quotes eaten by a
  // bare-identifier rename.
  projection: "Projection",
  domainservice: "DomainService",
  channel: "Channel",
  criterion: "Criterion",
  retrieval: "Retrieval",
  payload: "PayloadDecl",
  enum: "EnumDecl",
  commandhandler: "CommandHandler",
  queryhandler: "QueryHandler",
  capability: "Capability",
  layout: "Layout",
  resource: "Resource",
  channelsource: "ChannelSource",
  timer: "TimerSource",
};

/** The declaration node of `$type` named `name`, or undefined. The node-detail
 *  readers (`storageType`, `deployablePlatform`, `currentTarget`, …) address
 *  the AST node, while the view-graph node only carries kind + name. */
function astByTypeName(ast: AstNode, type: string, name: string): AstNode | undefined {
  for (const node of AstUtils.streamAst(ast)) {
    if (node.$type === type && (node as { name?: string }).name === name) return node;
  }
  return undefined;
}

/** The keyword-less `editable` default, as the access select's own option —
 *  the grammar has no token for it, so picking it means "remove the access
 *  keyword". Same contract v1's inspector used. */
const EDITABLE_ACCESS = "editable";

/** Path-leaf kinds whose view is a statement flow over ONE body of the
 *  aggregate the step above names — an operation, or a lifecycle `body` step
 *  carrying its `listBodies` key. Both take the same picker, palette and
 *  editing plumbing; only how the body is addressed differs. */
const AGG_BODY_LEAF: ReadonlySet<string> = new Set(["operation", "body"]);

/** Derive the `BodyLocator` for the body currently in focus (the last step of
 *  the path), or null when the leaf isn't a body view. An operation / lifecycle
 *  `body` step needs the containing aggregate step immediately above it.
 *  `member` selects one statement-bearing member of a WORKFLOW (a `listBodies`
 *  key: one of its creates / handles / reactors); omitted, the workflow
 *  resolves to its primary `create(...)` starter. An operation leaf always
 *  resolves to the historical member-less locator, byte for byte, so every
 *  pre-existing expression-slot key still resolves; a lifecycle body carries
 *  its key in the path step instead of in an override. */
function leafBodyLocator(path: ViewPath, member?: BodyKey): BodyLocator | null {
  const last = path[path.length - 1];
  if (!last) return null;
  if (last.kind === "workflow") {
    return { kind: "workflow", name: last.name, ...(member ? { member } : {}) };
  }
  if (!AGG_BODY_LEAF.has(last.kind)) return null;
  const agg = path[path.length - 2];
  if (agg?.kind !== "aggregate") return null;
  return last.kind === "body"
    ? aggregateBody(agg.name, last.name)
    : { kind: "operation", aggregate: agg.name, op: last.name };
}

/** The `listBodies` key the body picker highlights when nothing has been
 *  chosen explicitly: a workflow's primary `create` starter, the operation or
 *  lifecycle body the drill path already names. */
function primaryBodyKey(path: ViewPath, members: readonly BodyRef[]): BodyKey | undefined {
  const last = path[path.length - 1];
  if (last?.kind === "operation") return `op:${last.name}`;
  if (last?.kind === "body") return last.name;
  return members.find((b) => b.key.startsWith("create"))?.key;
}

/** The statement-member picker row — one button tab per statement-bearing
 *  member of the workflow / aggregate at the path leaf. Shared by both levels;
 *  only the test-id prefix differs (the workflow ids predate the aggregate
 *  reach and stay put). */
function BodyPicker({ members, selected, testidPrefix, onSelect }: {
  members: readonly BodyRef[];
  selected: BodyKey | undefined;
  testidPrefix: string;
  onSelect: (key: BodyKey) => void;
}): JSX.Element {
  return (
    <Group
      gap={4}
      px={6}
      py={4}
      bg="dark.7"
      wrap="wrap"
      style={{ borderBottom: "1px solid var(--mantine-color-dark-4)" }}
      data-testid={`${testidPrefix}s`}
    >
      <Text size="xs" c="dimmed" mr={2}>
        member
      </Text>
      {members.map((b) => (
        <Button
          key={b.key}
          size="compact-xs"
          variant={selected === b.key ? "light" : "subtle"}
          data-testid={`${testidPrefix}-${b.key}`}
          title={`${b.label} — ${b.count} statement${b.count === 1 ? "" : "s"}`}
          onClick={() => onSelect(b.key)}
        >
          {b.label} ({b.count})
        </Button>
      ))}
    </Group>
  );
}

/** One compact header field of the operation inspector. Local draft state so
 *  typing doesn't re-parse the document per keystroke; committed on blur, and
 *  only when the text actually changed (so focusing a field is never an edit).
 *  The re-derived `value` re-seeds the draft after a commit lands. */
function HeaderInput({ label, value, width, placeholder, testid, onCommit }: {
  label?: string;
  value: string;
  width?: number;
  placeholder?: string;
  testid: string;
  onCommit: (next: string) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <Group gap={4} wrap="nowrap" align="center">
      {label && (
        <Text size="xs" c="dimmed">
          {label}
        </Text>
      )}
      <TextInput
        size="xs"
        w={width}
        value={draft}
        placeholder={placeholder}
        data-testid={testid}
        aria-label={label ?? testid}
        styles={{ input: { fontFamily: "monospace", fontSize: 11 } }}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onBlur={() => {
          if (draft.trim() !== value.trim()) onCommit(draft);
        }}
      />
    </Group>
  );
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

function Breadcrumb({ path, onJump, onOverview }: {
  path: ViewPath;
  onJump: (depth: number) => void;
  /** Only offered at the root — Overview IS the root, seen flat. */
  onOverview?: () => void;
}): JSX.Element {
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
      {onOverview && (
        <Button
          size="compact-xs"
          variant="default"
          data-testid="c4system-v2-overview-toggle"
          title="See the whole model as one flat graph (read-only) — coverage heatmap, search, wire shape"
          onClick={onOverview}
        >
          Overview
        </Button>
      )}
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

function Inner({ ctx, path, setPath, onOverview }: {
  ctx: LayoutCtx;
  // The drill path is owned by the pane shell so switching to Overview and
  // back doesn't lose where you were.
  path: ViewPath;
  setPath: (next: ViewPath | ((prev: ViewPath) => ViewPath)) => void;
  onOverview: () => void;
}): JSX.Element {
  // Narrow the per-node widths on a phone-width canvas (< 768px → compact),
  // so StmtNode + the deployable's multi-select panel don't blow past the
  // edge of the small canvas.
  const compact = !ctx.isDesktop;
  // Inline-structured-editor open row, scoped per body locator + statement
  // index (+ optional field index for emit fields / call args). Mirrors v1.
  const [structuredKey, setStructuredKey] = useState<string | null>(null);
  const [exprMode, setExprMode] = useState<ExprMode>("structured");
  // W2-E: which statement-bearing member of the workflow / aggregate at the
  // path leaf the body surface is showing. `undefined` = the primary body (a
  // workflow's `create(...)` starter, an operation's own statements), so the
  // default view — and every expression-slot key derived from it — is unchanged.
  const [bodyMember, setBodyMember] = useState<BodyKey | undefined>(undefined);
  // Which node's collapsed detail block (`detailsLabel`) is expanded, by node
  // id. Pane state rather than node-local so the pane can also LIFT that node
  // above the siblings its extra height now overlaps (the per-kind columns lay
  // out on a fixed row pitch).
  const [detailsKey, setDetailsKey] = useState<string | null>(null);
  // The shared safety rails (parse memo + `rev` + write gate + refusal line) —
  // see `pane-harness.ts`.  The parse re-runs after every commit (`apply` bumps
  // `rev`), on the debounced editor tick, and on the external-reseed signals.
  //
  // `parseOk` is the read gate v1 has always carried: a recovered AST would
  // otherwise yield a silently-partial graph whose delete/rename handlers
  // splice CST ranges that no longer describe the user's source.  The gate has
  // to live *inside* the derivations — hooks below must still run
  // unconditionally — so the message renders at the end.
  const harness = usePaneHarness(ctx);
  const { parsed, parseOk, rev, refusal } = harness;
  const { apply, applyOrRefuse } = harness;
  const graph = useMemo(
    () => (parseOk ? buildViewGraph(parsed.ast, path, { workflowMember: bodyMember }) : EMPTY_GRAPH),
    [parsed, path, parseOk, bodyMember],
  );

  // The statement-bearing members of the container at the path leaf, for the
  // picker below the breadcrumb: a workflow's creates / handles / reactors, or
  // — on an operation / lifecycle-`body` leaf — every body of the aggregate
  // that owns it, so the whole member list is one click away from any of them.
  // Empty at every other level.
  // Gated on `parseOk` for the same reason the graph is: on a recovered AST
  // `listBodies` reports members whose CST ranges the write-backs can't trust.
  const bodyMembers: BodyRef[] = useMemo(() => {
    if (!parseOk) return [];
    const last = path[path.length - 1];
    if (last?.kind === "workflow") {
      const wf = findWorkflow(parsed.ast, last.name);
      return wf ? listBodies(wf) : [];
    }
    if (last && AGG_BODY_LEAF.has(last.kind)) {
      const aggStep = path[path.length - 2];
      if (aggStep?.kind !== "aggregate") return [];
      const agg = findAggregate(parsed.ast, aggStep.name);
      return agg ? listBodies(agg) : [];
    }
    return [];
  }, [parsed, path, parseOk]);
  // Leaving the container (or drilling into another one) drops back to its
  // primary body — a member key from the previous one means nothing here.
  // The expanded detail block goes with it: node ids repeat across views, so a
  // stale key would silently expand an unrelated node in the new one.
  useEffect(() => {
    setBodyMember(undefined);
    setDetailsKey(null);
  }, [path]);
  const primaryMemberKey = primaryBodyKey(path, bodyMembers);
  const leafKind = path[path.length - 1]?.kind;

  // When the path's leaf is an operation / workflow, materialise its statement
  // views + per-statement editor handlers and pass them through the stmt node's
  // `data`. The pure view-graph already laid out the column; here we layer in
  // editing.
  const leafLoc = useMemo(() => leafBodyLocator(path, bodyMember), [path, bodyMember]);
  useEffect(() => {
    // Switching to a different operation / workflow / non-leaf collapses any
    // inline `ƒx` editor that was open in the previous body.
    setStructuredKey(null);
  }, [leafLoc]);

  /** Everything the body at the path leaf needs to render editable statement
   *  rows: the structured views, the assignment-target names, and the
   *  expression-slot plumbing (key + slot factories, the inline `ƒx`
   *  render/toggle closures, and the path-addressed bundle nested rows use).
   *  Shared by the flow nodes and the lifecycle list panel so both address the
   *  SAME slots — one body, one set of keys.  Gated on `parseOk` like the
   *  graph: statement views over a recovered AST carry CST ranges the
   *  write-backs can't trust. */
  const bodySurface = useMemo(() => {
    if (!leafLoc || !parseOk) return null;
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

    // The structured-editor key is scoped per BODY, member included — two
    // members of the same workflow both have a statement 0.
    const base =
      leafLoc.kind === "operation"
        ? `${leafLoc.aggregate}.${leafLoc.op}`
        : `${leafLoc.name}${leafLoc.member ? `#${leafLoc.member}` : ""}`;
    // `path` are the descent steps into a `for` / `if let` / `match` block
    // below the top-level statement `index` — empty for a top-level row, which
    // keeps its historical key (`encodeStmtPath([])` is the empty string) and
    // its `path`-less slot.
    const keyFor = (index: number, path: StmtPath, field?: number): string =>
      `${base}:${index}${encodeStmtPath(path)}:${field ?? ""}`;
    const slotFor = (index: number, path: StmtPath, field?: number): ExprSlot =>
      leafLoc.kind === "operation"
        ? {
            kind: "stmtExpr",
            owner: leafLoc.aggregate,
            op: leafLoc.op,
            // Only set for a lifecycle member — an operation body is addressed
            // by `op` alone, exactly as it always was.
            ...(leafLoc.member ? { member: leafLoc.member } : {}),
            index,
            ...(path.length > 0 ? { path } : {}),
            ...(field !== undefined ? { field } : {}),
          }
        : {
            kind: "wfStmt",
            owner: leafLoc.name,
            index,
            // Only set for a NON-primary member — the primary create's slots
            // are keyed without one (see `expr-slots.ts`), so leaving it off
            // keeps the default workflow body's editing path unchanged.
            ...(leafLoc.member ? { member: leafLoc.member } : {}),
            ...(path.length > 0 ? { path } : {}),
            ...(field !== undefined ? { field } : {}),
          };
    /** Whether a (possibly nested) statement actually has an editable
     *  expression — drives whether the row offers a `ƒx` toggle at all. */
    const hasEditor = (index: number, path: StmtPath, field?: number): boolean =>
      slotExpr(parsed.ast, slotFor(index, path, field)) != null;
    const renderEditor = (index: number, path: StmtPath, field?: number): ReactNode => {
      if (structuredKey !== keyFor(index, path, field)) return null;
      const slot = slotFor(index, path, field);
      const expr = slotExpr(parsed.ast, slot);
      if (!expr) return null;
      return (
        <ExprSlotEditor
          key={`${keyFor(index, path, field)}:${rev}`}
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
    const toggle = (index: number, path: StmtPath, field?: number): void => {
      const k = keyFor(index, path, field);
      setStructuredKey((cur) => (cur === k ? null : k));
    };
    /** The path-addressed `ƒx` bundle a container row hands down to the rows
     *  of its nested statement lists (and they to theirs, recursively). */
    const nestedFor = (index: number): NestedExprEditors => ({
      has: (path, field) => hasEditor(index, path, field),
      render: (path, field) => renderEditor(index, path, field),
      toggle: (path, field) => toggle(index, path, field),
    });

    // All declared events in the model — candidates for the emit-row Select.
    const events: string[] = [];
    for (const n of AstUtils.streamAst(parsed.ast)) {
      if (isEventDecl(n)) events.push(n.name);
    }

    return { views, targets, events, slotFor, hasEditor, renderEditor, toggle, nestedFor };
    // `ctx` covers getSource changes (parent re-renders create a fresh ctx).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsed, parseOk, leafLoc, structuredKey, exprMode, rev]);

  const stmtData = useMemo(() => {
    const m = new Map<string, Record<string, unknown>>();
    if (!leafLoc || !bodySurface) return m;
    const { views, targets, events, slotFor, renderEditor, toggle, nestedFor } = bodySurface;

    views.forEach((view, i) => {
      const data: StmtNodeData = {
        view,
        compact,
        targets,
        headCandidates: slotCandidates(parsed.ast, slotFor(i, [])),
        onCommit: (text) => {
          const next = editStatement(ctx.getSource(), leafLoc, i, text);
          if (next == null) return false;
          apply(next);
          return true;
        },
        // Row commands, the flow twin of the list editor's ↑ / ↓ / × — without
        // them the flow view could only rewrite statements, never reorder or
        // remove one.
        onDelete: () => {
          const next = deleteStatement(ctx.getSource(), leafLoc, i);
          if (next != null) apply(next);
        },
        onMove: (dir) => {
          const next = moveStatement(ctx.getSource(), leafLoc, i, dir);
          if (next != null) apply(next);
        },
        canMoveUp: i > 0,
        canMoveDown: i < views.length - 1,
        valueEditor: renderEditor(i, []),
        onToggleEditor: () => toggle(i, []),
        renderArgEditor: (a) => renderEditor(i, [], a),
        onToggleArg: (a) => toggle(i, [], a),
        renderFieldEditor: (f) => renderEditor(i, [], f),
        onToggleField: (f) => toggle(i, [], f),
        nested: nestedFor(i),
        events,
        onRepointEvent:
          // `setEmitEvent` addresses a workflow's PRIMARY create body / a named
          // operation only, so the inline event Select is withheld while any
          // other member is selected rather than repointing the wrong body's emit.
          view.kind === "emit" && !leafLoc.member
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
    // `ctx` covers getSource changes (parent re-renders create a fresh ctx);
    // `bodySurface` carries the structuredKey / exprMode dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsed, leafLoc, bodySurface, rev, compact]);

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

    /** The collapsed-detail-block wiring for one node id. */
    const detailToggle = (id: string): { detailsOpen: boolean; onToggleDetails: () => void } => ({
      detailsOpen: detailsKey === id,
      onToggleDetails: () => setDetailsKey((cur) => (cur === id ? null : id)),
    });

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
          applyOrRefuse(deleteInvariant(ctx.getSource(), aggName, idx));
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
          void renameMember(ctx.getSource(), "aggregate", aggName, n.name, next)
            .then(applyOrRefuse)
            // A failed rename leaves the source untouched; log it rather than
            // letting the rejection surface as `unhandledrejection` noise.
            .catch((e: unknown) => {
              // eslint-disable-next-line no-console
              console.error("rename failed:", e);
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
            : () => {
                // Containment ids are `containment:<field>` — the display
                // name embeds the entity type ("lines : OrderLine") but the
                // id keeps the plain field name (see aggregateLayout in
                // view-graph.ts).
                const fieldName = n.id.slice("containment:".length);
                const next = deleteContainment(ctx.getSource(), aggName, fieldName);
                if (next != null) apply(next);
              };
        // Property TYPE + the modifier clauses (`= default`, `check … message`,
        // `mask unless`, the access keyword, `sensitive(…)`) — v1's collapsible
        // `ƒ` section, now the field node's own collapsed detail block. Every
        // mutator returns null when the rewrite wouldn't re-parse, which is a
        // no-op here (the next render re-seeds the input from source).
        let inputs: ConstructNodeData["inputs"];
        let selects: ConstructNodeData["selects"];
        if (n.kind === "field") {
          const agg = findAggregate(parsed.ast, aggName);
          const idx = agg ? listFields(agg).findIndex((f) => f.name === n.name) : -1;
          const info = agg && idx >= 0 ? listFields(agg)[idx] : undefined;
          const mods = agg && idx >= 0 ? listFieldModifiers(agg)[idx] : undefined;
          if (info && mods) {
            const edit = (next: string | null): void => {
              if (next != null) apply(next);
            };
            inputs = [
              {
                label: "type",
                value: `${info.baseLabel}${info.array ? "[]" : ""}${info.optional ? "?" : ""}`,
                testid: "c4system-v2-field-type",
                onCommit: (v) => edit(retypeField(ctx.getSource(), "aggregate", aggName, idx, v)),
              },
              {
                label: "ƒ default",
                value: mods.default ?? "",
                placeholder: "(none)",
                testid: "c4system-v2-field-default",
                onCommit: (v) => edit(setFieldDefault(ctx.getSource(), "aggregate", aggName, idx, v)),
              },
              {
                label: "check",
                value: mods.check ?? "",
                placeholder: "(none)",
                testid: "c4system-v2-field-check",
                onCommit: (v) => edit(setFieldCheck(ctx.getSource(), "aggregate", aggName, idx, v)),
              },
              {
                label: "check message",
                value: mods.checkMessage ?? "",
                placeholder: "(none)",
                testid: "c4system-v2-field-check-message",
                onCommit: (v) =>
                  edit(setFieldCheck(ctx.getSource(), "aggregate", aggName, idx, mods.check ?? "", v)),
              },
              {
                label: "mask unless",
                value: mods.maskUnless ?? "",
                placeholder: "currentUser.…",
                testid: "c4system-v2-field-mask",
                onCommit: (v) => edit(setFieldMask(ctx.getSource(), "aggregate", aggName, idx, v)),
              },
              {
                label: "sensitive",
                value: (mods.sensitivity ?? []).join(", "),
                placeholder: "pii, phi",
                testid: "c4system-v2-field-sensitive",
                onCommit: (v) =>
                  edit(setFieldSensitivity(ctx.getSource(), "aggregate", aggName, idx, v.split(","))),
              },
            ];
            selects = [
              {
                label: "access",
                // The keyword-less `editable` default is its own option: the
                // grammar has no token for it, so picking it REMOVES the access
                // keyword.
                data: [EDITABLE_ACCESS, ...FIELD_ACCESS],
                value: mods.access ?? EDITABLE_ACCESS,
                testid: "c4system-v2-field-access",
                onChange: (v) =>
                  edit(
                    setFieldAccess(
                      ctx.getSource(),
                      "aggregate",
                      aggName,
                      idx,
                      FIELD_ACCESS.find((a) => a === v) ?? null,
                    ),
                  ),
              },
            ];
          }
        }
        m.set(n.id, {
          kind: n.kind,
          name: n.name,
          color: KIND_COLOR[n.kind],
          drillable: n.drillable,
          onRename,
          onDelete,
          inputs,
          selects,
          // Six clauses would turn every field node into a form — they live
          // behind the node's own `ƒ` toggle, as they did in v1's inspector.
          detailsLabel: "ƒ",
          ...detailToggle(n.id),
          compact,
          // A `mask unless` chip rides along on the field leaf.
          badges: n.badges,
        });
        continue;
      }

      const astType = AST_TYPE_BY_VIEW[n.kind];
      const onRename =
        astType != null
          ? (next: string) => {
              if (!IDENTIFIER.test(next) || next === n.name) return;
              void renameByAstType(ctx.getSource(), astType, n.name, next)
                .then(applyOrRefuse)
                .catch((e: unknown) => {
                  // eslint-disable-next-line no-console
                  console.error("rename failed:", e);
                });
            }
          : undefined;
      const onDelete =
        astType != null
          ? () => {
              applyOrRefuse(deleteByAstType(ctx.getSource(), astType, n.name));
            }
          : undefined;

      // For deployable nodes, inline multi-selects for the multi-valued
      // bindings (modules / serves). Single-valued targets / ui are handled by
      // drag-rebind on the edges (Phase 4d).
      let multiSelects: ConstructNodeData["multiSelects"];
      let selects: ConstructNodeData["selects"];
      let actions: ConstructNodeData["actions"];
      let inputs: ConstructNodeData["inputs"];
      const astNode = astType != null ? astByTypeName(parsed.ast, astType, n.name) : undefined;

      // Infra scalar properties (v1's inspector rows): a storage's `type:`,
      // a deployable's `platform:` / `port:`.
      if (n.kind === "storage" && astNode) {
        const storeName = n.name;
        selects = [
          {
            label: "type",
            data: [...STORAGE_TYPES],
            value: storageType(astNode) ?? null,
            searchable: true,
            testid: "c4system-v2-storage-type",
            onChange: (v) => {
              const next = v && setStorageType(ctx.getSource(), storeName, v);
              if (next) apply(next);
            },
          },
        ];
      }
      if (n.kind === "deployable" && astNode) {
        const depName = n.name;
        selects = [
          {
            label: "platform",
            data: [...PLATFORMS],
            value: deployablePlatform(astNode) ?? null,
            searchable: true,
            testid: "c4system-v2-deployable-platform",
            onChange: (v) => {
              const next = v && setDeployablePlatform(ctx.getSource(), depName, v);
              if (next) apply(next);
            },
          },
        ];
        inputs = [
          {
            label: "port",
            // Emptying the field drops the (optional) `port:` clause — the
            // same "null means remove" contract every other setter carries.
            value: deployablePort(astNode)?.toString() ?? "",
            placeholder: "(none)",
            testid: "c4system-v2-deployable-port",
            onCommit: (v) => {
              const text = v.trim();
              const port = text === "" ? undefined : Number(text);
              if (port !== undefined && !Number.isInteger(port)) return;
              const next = setDeployablePort(ctx.getSource(), depName, port);
              if (next != null) apply(next);
            },
          },
        ];
      }

      // A repository's `for <Aggregate>` / an api's `from <Subdomain>` — the
      // single cross-reference each carries, as a closed pick.  Behind the
      // node's own toggle: a repository IS drillable, and an always-open
      // select would sit under the pointer where the drill click lands.
      let detailsLabel: ConstructNodeData["detailsLabel"];
      if (isRebindKind(n.kind) && astNode) {
        const owner = n.name;
        const kind = n.kind;
        detailsLabel = "⇄";
        selects = [
          {
            label: targetKindOf(kind) === "subdomain" ? "from" : "for",
            data: rebindTargets(parsed.ast, kind),
            value: currentTarget(astNode, kind),
            searchable: true,
            testid: "c4system-v2-rebind",
            onChange: (v) => {
              const next = v && rebindReference(ctx.getSource(), kind, owner, v);
              if (next) apply(next);
            },
          },
        ];
      }

      if (n.kind === "deployable") {
        const dep = astNode;
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
      // repository view, where the parent path step is the repo) — plus the
      // two header clauses that sit beside the `where` filter and have no
      // expression tree of their own: the `requires` gate and `ignoring`.
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
        const surface = findSurface(parsed.ast, repoName, n.name);
        if (surface) {
          const findName = n.name;
          // Collapsed: the header clauses plus the signature are five-plus
          // fields, and a repository view stacks its finds — expanded by
          // default they overlap the next find's node.
          detailsLabel = "⋯";
          inputs = [
            {
              label: "requires",
              value: surface.requires ?? "",
              placeholder: "(none)",
              testid: "c4system-v2-find-requires",
              // Empty text is "drop the clause" — `setFindGate` treats null as
              // the removal request and returns the source untouched when
              // there was none.
              onCommit: (v) => {
                const next = setFindGate(ctx.getSource(), repoName, findName, v.trim() || null);
                if (next != null) apply(next);
              },
            },
            {
              label: "ignoring",
              value: surface.ignoring === "*" ? "*" : (surface.ignoring ?? []).join(", "),
              placeholder: "* or Cap1, Cap2",
              testid: "c4system-v2-find-ignoring",
              onCommit: (v) => {
                const text = v.trim();
                const spec = text === "" ? null : text === "*" ? "*" : text.split(",").map((s) => s.trim());
                const next = setFindIgnoring(ctx.getSource(), repoName, findName, spec);
                if (next != null) apply(next);
              },
            },
            // The find's SIGNATURE — the surface v1's inspector owned: the
            // return type plus one row per parameter (`name: Type`, editable
            // and deletable) and a `+ param` action.
            {
              label: "returns",
              value: surface.returnTypeText,
              testid: "c4system-v2-find-return",
              onCommit: (v) => {
                const text = v.trim();
                if (!text) return;
                const next = setFindReturnType(ctx.getSource(), repoName, findName, text);
                if (next != null) apply(next);
              },
            },
            ...surface.params.map((p, i) => ({
              label: `param ${i + 1}`,
              value: `${p.name}: ${p.baseLabel}${p.array ? "[]" : ""}${p.optional ? "?" : ""}`,
              testid: `c4system-v2-find-param-${i}`,
              // `name: Type` in one field, committed as (at most) two narrow
              // splices — the rename first, then the retype on its result, so
              // a rejected half leaves the other half applied to nothing.
              onCommit: (v: string): void => {
                const cut = v.indexOf(":");
                if (cut < 0) return;
                const name = v.slice(0, cut).trim();
                const type = v.slice(cut + 1).trim();
                if (!name || !type) return;
                let src = ctx.getSource();
                if (name !== p.name) {
                  const renamed = renameFindParam(src, repoName, findName, i, name);
                  if (renamed == null) return;
                  src = renamed;
                }
                const retyped = retypeFindParam(src, repoName, findName, i, type);
                const next = retyped ?? (src === ctx.getSource() ? null : src);
                if (next != null) apply(next);
              },
              onDelete: (): void => {
                const next = deleteFindParam(ctx.getSource(), repoName, findName, i);
                if (next != null) apply(next);
              },
            })),
          ];
          actions = [
            {
              label: "+ param",
              testid: "c4system-v2-find-param-add",
              onClick: () => {
                const next = addFindParam(
                  ctx.getSource(),
                  repoName,
                  findName,
                  freshParamName(parsed.ast, repoName, findName),
                  { base: { kind: "primitive", name: "string" }, array: false, optional: false },
                );
                if (next != null) apply(next);
              },
            },
          ];
        }
      }

      m.set(n.id, {
        kind: n.kind,
        name: n.name,
        color: KIND_COLOR[n.kind],
        drillable: n.drillable,
        onRename,
        onDelete,
        multiSelects,
        inputs,
        selects,
        actions,
        detailsLabel,
        ...(detailsLabel ? detailToggle(n.id) : {}),
        expressionEditor,
        onToggleExpression,
        compact,
        unused: n.unused,
        summary: n.summary,
        badges: n.badges,
      });
    }
    return m;
    // structuredKey + exprMode drive the inline ƒx editor (buildExprToggle);
    // without them the toggle flips state but this memo never rebuilds the
    // node data, so the editor never opens for invariant / find / view slots.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, parsed, path, rev, compact, structuredKey, exprMode, detailsKey]);

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
   *  computed positions.  Deliberately NOT behind a confirm: positions are
   *  cosmetic and re-draggable, and confirming this while declaration
   *  deletes went unconfirmed was the audit's clearest inversion (H8). */
  const resetLayout = (): void => {
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

  /** Pick a body member. Inside an aggregate every member — operation and
   *  lifecycle body alike — is SIBLING NAVIGATION: the view-graph builds the
   *  statement flow from the path, so the leaf step is swapped and the override
   *  cleared. An operation keeps its `{kind:"operation"}` step, which keeps its
   *  locator and expression-slot keys member-less, exactly as before the picker
   *  existed; a lifecycle body rides a `body` step carrying its `listBodies`
   *  key. A workflow member has no step of its own, so it stays an override. */
  const pickBodyMember = (key: BodyKey): void => {
    if (leafKind && AGG_BODY_LEAF.has(leafKind)) {
      const step: ViewStep = key.startsWith("op:")
        ? { kind: "operation", name: key.slice(3) }
        : { kind: "body", name: key };
      setBodyMember(undefined);
      setPath((p) => {
        const last = p[p.length - 1];
        if (!last || (last.kind === step.kind && last.name === step.name)) return p;
        animateNextFit.current = true;
        return [...p.slice(0, -1), step];
      });
      return;
    }
    // Selecting the primary member clears the override rather than pinning its
    // key, so the default body keeps its member-less locator.
    setBodyMember(key === primaryMemberKey ? undefined : key);
  };

  /** Header (signature) inspector for the operation at the path leaf — the
   *  surface `op-surface.ts` owns: parameters, return type, the `requires` /
   *  `when` gates and the `private` / `extern` / `audited` modifiers. Compact
   *  by design (an inspector, not a form designer); every mutator returns null
   *  on failure, which is a no-op here. */
  const opInspector = ((): JSX.Element | null => {
    const last = path[path.length - 1];
    const aggStep = path[path.length - 2];
    if (last?.kind !== "operation" || aggStep?.kind !== "aggregate") return null;
    const surface = opSurface(parsed.ast, aggStep.name, last.name);
    if (!surface) return null;
    const agg = aggStep.name;
    const op = last.name;
    const commit = (next: string | null): void => {
      if (next != null) apply(next);
    };
    const modifier = (name: "private" | "extern" | "audited", on: boolean): void =>
      commit(setOpModifier(ctx.getSource(), agg, op, name, on));
    return (
      <Stack
        gap={4}
        px={6}
        py={4}
        bg="dark.7"
        style={{ borderBottom: "1px solid var(--mantine-color-dark-4)" }}
        data-testid="c4system-v2-op-inspector"
      >
        <Group gap={6} wrap="wrap" align="center">
          <Text size="xs" c="dimmed">
            params
          </Text>
          {surface.params.map((p, i) => (
            <Group key={`${p.name}-${i}`} gap={2} wrap="nowrap" align="center" data-testid="c4system-v2-op-param-row">
              <HeaderInput
                value={p.name}
                width={90}
                testid="c4system-v2-op-param-name"
                onCommit={(v) => commit(renameOpParam(ctx.getSource(), agg, op, i, v.trim()))}
              />
              <Text size="xs" c="dimmed">
                :
              </Text>
              <HeaderInput
                value={`${p.baseLabel}${p.array ? "[]" : ""}${p.optional ? "?" : ""}`}
                width={110}
                testid="c4system-v2-op-param-type"
                onCommit={(v) => commit(retypeOpParam(ctx.getSource(), agg, op, i, v))}
              />
              <Button
                size="compact-xs"
                variant="subtle"
                color="red"
                data-testid="c4system-v2-op-param-del"
                onClick={() => commit(deleteOpParam(ctx.getSource(), agg, op, i))}
              >
                ×
              </Button>
            </Group>
          ))}
          <Button
            size="compact-xs"
            variant="light"
            data-testid="c4system-v2-op-param-add"
            onClick={() =>
              commit(
                addOpParam(ctx.getSource(), agg, op, freshOpParamName(parsed.ast, agg, op), {
                  base: { kind: "primitive", name: "string" },
                  array: false,
                  optional: false,
                }),
              )
            }
          >
            + param
          </Button>
        </Group>
        <Group gap={8} wrap="wrap" align="center">
          {/* An emptied field is the removal request — every setter takes null
              for "drop the clause" and no-ops when there was none. */}
          <HeaderInput
            label="returns"
            value={surface.returnTypeText ?? ""}
            width={110}
            placeholder="(none)"
            testid="c4system-v2-op-return"
            onCommit={(v) => commit(setOpReturnType(ctx.getSource(), agg, op, v.trim() || null))}
          />
          <HeaderInput
            label="requires"
            value={surface.requires ?? ""}
            width={150}
            placeholder="(none)"
            testid="c4system-v2-op-requires"
            onCommit={(v) => commit(setOpGate(ctx.getSource(), agg, op, "requires", v.trim() || null))}
          />
          <HeaderInput
            label="when"
            value={surface.when ?? ""}
            width={150}
            placeholder="(none)"
            testid="c4system-v2-op-when"
            onCommit={(v) => commit(setOpGate(ctx.getSource(), agg, op, "when", v.trim() || null))}
          />
          <Checkbox
            size="xs"
            label="private"
            checked={surface.private}
            data-testid="c4system-v2-op-private"
            styles={{ label: { fontSize: 11 } }}
            onChange={(e) => modifier("private", e.currentTarget.checked)}
          />
          <Checkbox
            size="xs"
            label="extern"
            checked={surface.extern}
            data-testid="c4system-v2-op-extern"
            styles={{ label: { fontSize: 11 } }}
            onChange={(e) => modifier("extern", e.currentTarget.checked)}
          />
          <Checkbox
            size="xs"
            label="audited"
            checked={surface.audited}
            data-testid="c4system-v2-op-audited"
            styles={{ label: { fontSize: 11 } }}
            onChange={(e) => modifier("audited", e.currentTarget.checked)}
          />
        </Group>
      </Stack>
    );
  })();

  /** Repoint a deployable's `targets` / `ui` binding by dragging the edge's
   *  target endpoint to another node. Owner stays fixed; an incompatible drop
   *  or unparseable rewrite leaves the source untouched. */
  const onReconnect = (oldEdge: Edge, conn: Connection): void => {
    if (!conn.target || conn.source !== oldEdge.source) return;
    const label = typeof oldEdge.label === "string" ? oldEdge.label : "";
    const next = rebindDeployableEdgeTarget(ctx.getSource(), label, oldEdge.source, conn.target);
    if (next != null) apply(next);
  };

  // Below every hook, so the gate above can't change the hook order.
  if (!parseOk) {
    return <Message>Source has syntax errors — fix them in the editor to use the model builder.</Message>;
  }

  return (
    <Box style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <Breadcrumb path={path} onJump={jumpTo} onOverview={path.length === 0 ? onOverview : undefined} />
      {bodyMembers.length > 0 && (
        <BodyPicker
          members={bodyMembers}
          selected={bodyMember ?? primaryMemberKey}
          // The workflow ids predate the aggregate reach, so they stay put.
          testidPrefix={leafKind === "workflow" ? "c4system-v2-wf-member" : "c4system-v2-body-member"}
          onSelect={pickBodyMember}
        />
      )}
      {opInspector}
      <AddPalette path={path} source={ctx.getSource()} onChange={apply} bodyMember={bodyMember} />
      <RefusalLine refused={refusal.refused} />
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

function Message({ children }: { children: ReactNode }): JSX.Element {
  return (
    <Box p="md">
      <Text size="sm" c="dimmed">{children}</Text>
    </Box>
  );
}

export default function SystemBuilderV2Pane({ ctx }: { ctx: LayoutCtx }): JSX.Element {
  // The drill path lives here so the Overview round-trip is lossless; `mode`
  // picks which canvas is mounted. Each branch gets its OWN provider (keyed,
  // so switching remounts it) — two React Flow instances must never share one
  // store, and only one is ever mounted.
  const [path, setPath] = useState<ViewPath>([]);
  const [mode, setMode] = useState<"drill" | "overview">("drill");
  if (mode === "overview") {
    return (
      <ReactFlowProvider key="overview">
        <OverviewCanvas
          ctx={ctx}
          onClose={() => setMode("drill")}
          onOpen={(next) => {
            setPath(next);
            setMode("drill");
          }}
        />
      </ReactFlowProvider>
    );
  }
  return (
    <ReactFlowProvider key="drill">
      <Inner ctx={ctx} path={path} setPath={setPath} onOverview={() => setMode("overview")} />
    </ReactFlowProvider>
  );
}
