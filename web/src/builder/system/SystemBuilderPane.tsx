import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Background,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { AstUtils, type AstNode } from "langium";
import { Box, Button, Checkbox, Drawer, Group, Modal, MultiSelect, NumberInput, ScrollArea, Select, Stack, Text, TextInput, Textarea } from "@mantine/core";
import type { LayoutCtx } from "../../layout/ctx";
import type { Model } from "../../../../src/language/generated/ast.js";
import { printStructural } from "../../../../src/language/print/index.js";
import { parseDdd } from "../parse";
import { spliceNode, lineDiff } from "../edit-engine";
import { buildSystemGraph, coverageByNode, matchNodes, nodeDiagnostics, typeLabel, wireShapeOf, type CoverageStatus, type GraphNode, type NodeKind } from "./model";
import type { WireField } from "../../../../src/ir/types/loom-ir.js";
import { loadPositions, savePositions, type Pos } from "./positions";
import { addConstructSource, addSubdomainSource, firstAggregateName, listContextNames } from "./add";
import { groupedLayout } from "./grouped-layout";
import { isRebindableEdge, rebindEdgeTarget } from "./edge-rebind";
import { buildLinkedModel } from "./linked-doc";
import { lowerModel } from "../../../../src/ir/lower/lower.js";
import { enrichLoomModel } from "../../../../src/ir/enrich/enrichments.js";
import type { Diagnostic } from "../../lsp/protocol";
import { IDENTIFIER, renameConstruct, renameMember } from "./rename";
import {
  addField,
  availableTypes,
  baseLabel,
  deleteField,
  freshFieldName,
  isFieldKind,
  listFields,
  retypeField,
  type BaseSpec,
  type TypeSpec,
} from "./fields";
import {
  addFindParam,
  deleteFindParam,
  findReturnSpec,
  freshParamName,
  listFindParams,
  listFinds,
  renameFindParam,
  retypeFindParam,
  setFindReturnType,
} from "./find-params";
import {
  PLATFORMS,
  STORAGE_TYPES,
  deployablePlatform,
  deployablePort,
  setDeployablePlatform,
  setDeployablePort,
  setStorageType,
  storageType,
} from "./infra-props";
import {
  apiNames,
  boundedContextNames,
  deployableContexts,
  deployableNames,
  deployableServes,
  deployableTargets,
  deployableUi,
  setDeployableContexts,
  setDeployableServes,
  setDeployableTargets,
  setDeployableUi,
  subdomainNames,
  uiKind,
  uiNames,
} from "./deployable-bindings";
import { eventNames, listEmits, setEmitEvent } from "./emit-event";
import { currentTarget, isRebindKind, rebindReference, rebindTargets, targetKindOf } from "./rebind";
import {
  addStatement,
  deleteStatement,
  editStatement,
  listOperations,
  listStatementViews,
  moveStatement,
  type BodyLocator,
} from "./body";
import { BodyEditor } from "./BodyEditor";
import { editExprSlot, enumPickerCandidates, exprHints, exprSlotOptions, repoSlotOptions, slotCandidates, slotExpr, workflowSlotOptions, type ExprSlot } from "./expr-slots";
import { seedExpr } from "./expr-model";
import { ExprSlotEditor, type ExprMode } from "./ExpressionEditor";

// Editable structural model graph (React Flow).  Reads the parsed AST into a
// node/edge graph, renders it, and edits splice the backing AST node's CST
// range via the structural printer.  Source stays the source of truth; node
// positions are layout only (not written back).

const KIND_COLOR: Record<NodeKind, string> = {
  subdomain: "var(--mantine-color-blue-7)",
  context: "var(--mantine-color-teal-5)",
  aggregate: "var(--mantine-color-teal-7)",
  valueobject: "var(--mantine-color-cyan-8)",
  event: "var(--mantine-color-grape-7)",
  repository: "var(--mantine-color-indigo-7)",
  workflow: "var(--mantine-color-orange-8)",
  deployable: "var(--mantine-color-red-8)",
  api: "var(--mantine-color-pink-7)",
  storage: "var(--mantine-color-gray-7)",
  ui: "var(--mantine-color-violet-7)",
};

// Worst severity (error beats warning) among a node's diagnostics, or null.
function worstSeverity(diags: readonly Diagnostic[] | undefined): "error" | "warning" | null {
  if (!diags || diags.length === 0) return null;
  return diags.some((d) => d.severity === "error") ? "error" : "warning";
}

const SEVERITY_COLOR = { error: "var(--mantine-color-red-6)", warning: "var(--mantine-color-yellow-5)" } as const;

// Coverage-overlay background tints (replace the kind colour while the overlay
// is on, turning the graph into a tested / untested / unreferenced heatmap).
const COVERAGE_COLOR: Record<CoverageStatus, string> = {
  covered: "var(--mantine-color-green-8)",
  uncovered: "var(--mantine-color-red-8)",
  none: "var(--mantine-color-dark-4)",
};

// One construct (leaf) node, with its kind / coverage colour, diagnostic
// border + count, and optional containing group (for nested layout).
function leafRfNode(
  n: ReturnType<typeof buildSystemGraph>["nodes"][number],
  diagByNode: Map<string, Diagnostic[]>,
  coverage: Map<string, CoverageStatus>,
  overlay: boolean,
  position: Pos,
  parentId?: string,
): Node {
  const diags = diagByNode.get(n.id);
  const sev = worstSeverity(diags);
  const mark = sev ? `\n${sev === "error" ? "✕" : "⚠"} ${diags!.length}` : "";
  const background = overlay ? COVERAGE_COLOR[coverage.get(n.id) ?? "none"] : KIND_COLOR[n.kind];
  return {
    id: n.id,
    position,
    ...(parentId ? { parentId, extent: "parent" as const } : {}),
    data: { label: `${n.kind}\n${n.name}${mark}`, title: diags?.map((d) => d.message).join("\n") },
    style: {
      background,
      color: "white",
      border: sev ? `2px solid ${SEVERITY_COLOR[sev]}` : "1px solid rgba(255,255,255,0.25)",
      borderRadius: 6,
      fontSize: 11,
      width: 150,
      whiteSpace: "pre-line" as const,
      textAlign: "center" as const,
    },
  };
}

function toRfNodes(
  graph: ReturnType<typeof buildSystemGraph>,
  diagByNode: Map<string, Diagnostic[]>,
  coverage: Map<string, CoverageStatus>,
  overlay: boolean,
  positions: Map<string, Pos>,
): Node[] {
  return graph.nodes.map((n) =>
    leafRfNode(n, diagByNode, coverage, overlay, positions.get(n.id) ?? { x: n.x, y: n.y }),
  );
}

const GROUP_STYLE: Record<"subdomain" | "context", { background: string; border: string }> = {
  subdomain: { background: "rgba(59,130,246,0.06)", border: "1px solid var(--mantine-color-blue-7)" },
  context: { background: "rgba(20,184,166,0.07)", border: "1px dashed var(--mantine-color-teal-6)" },
};

// Nested layout: module / context group containers (parents first, so React
// Flow sees a parent before its children) then the member leaf nodes positioned
// inside them. Modules become group containers, so the flat module node is
// dropped here (its edges are remapped to the group by `groupedEdges`).
function toGroupedRfNodes(
  graph: ReturnType<typeof buildSystemGraph>,
  diagByNode: Map<string, Diagnostic[]>,
  coverage: Map<string, CoverageStatus>,
  overlay: boolean,
  layout: ReturnType<typeof groupedLayout>,
): Node[] {
  const out: Node[] = [];
  for (const kind of ["subdomain", "context"] as const) {
    for (const g of layout.groups) {
      if (g.kind !== kind) continue;
      out.push({
        id: g.id,
        position: { x: g.x, y: g.y },
        ...(g.parentId ? { parentId: g.parentId, extent: "parent" as const } : {}),
        data: { label: `${g.kind} ${g.name}` },
        draggable: false,
        selectable: false,
        style: {
          width: g.width,
          height: g.height,
          ...GROUP_STYLE[kind],
          borderRadius: 8,
          fontSize: 10,
          fontWeight: 600,
          color: "var(--mantine-color-dimmed)",
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "flex-start",
          padding: "3px 6px",
          textAlign: "left" as const,
        },
      });
    }
  }
  for (const n of graph.nodes) {
    if (n.kind === "subdomain") continue; // subdomains are group containers in this mode
    const p = layout.placements.get(n.id);
    if (p) out.push(leafRfNode(n, diagByNode, coverage, overlay, { x: p.x, y: p.y }, p.parentId ?? undefined));
  }
  return out;
}

function toRfEdges(graph: ReturnType<typeof buildSystemGraph>, grouped = false): Edge[] {
  // In grouped mode an edge to a module points at that module's group node.
  const remap = (id: string): string => (grouped && id.startsWith("module:") ? `group:${id}` : id);
  return graph.edges.map((e) => {
    const ownerKind = e.source.slice(0, e.source.indexOf(":"));
    // Single cross-ref edges can be repointed by dragging their target endpoint;
    // disabled in grouped mode (endpoints may be group containers).
    const reconnectable: "target" | false =
      !grouped && isRebindableEdge(ownerKind, e.label) ? "target" : false;
    return {
      id: e.id,
      source: remap(e.source),
      target: remap(e.target),
      label: e.label,
      reconnectable,
      labelStyle: { fontSize: 9, fill: "var(--mantine-color-dimmed)" },
      style: { stroke: "var(--mantine-color-dark-2)" },
    };
  });
}


export default function SystemBuilderPane({ ctx }: { ctx: LayoutCtx }): JSX.Element {
  return (
    <ReactFlowProvider>
      <SystemBuilderInner ctx={ctx} />
    </ReactFlowProvider>
  );
}

// Editable field name (aggregate / value-object fields). Commits a reference-
// aware rename on blur / Enter; remounts (re-seeding the draft) once the rename
// lands and the field list re-renders under its new key.
function FieldNameInput({ name, onRename }: { name: string; onRename: (next: string) => void }): JSX.Element {
  const [draft, setDraft] = useState(name);
  return (
    <TextInput
      size="xs"
      style={{ flex: "0 0 70px" }}
      value={draft}
      data-testid="c4system-field-name"
      styles={{ input: { fontFamily: "monospace", fontSize: 11 } }}
      onChange={(e) => setDraft(e.currentTarget.value)}
      onBlur={() => { if (draft.trim() !== name) onRename(draft); }}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
    />
  );
}

// The inspector lives beside the canvas on desktop; on a narrow viewport it
// slides up as a bottom drawer so the graph keeps the full width.
function InspectorPanel({ compact, opened, onClose, children }: { compact: boolean; opened: boolean; onClose: () => void; children: ReactNode }): JSX.Element {
  if (compact) {
    return (
      <Drawer opened={opened} onClose={onClose} position="bottom" size="75%" title="Model" data-testid="c4system-inspector-drawer">
        {children}
      </Drawer>
    );
  }
  return (
    <Box style={{ width: 280, minWidth: 280, borderLeft: "1px solid var(--mantine-color-dark-4)", padding: 8, display: "flex", flexDirection: "column" }}>
      {children}
    </Box>
  );
}

function SystemBuilderInner({ ctx }: { ctx: LayoutCtx }): JSX.Element {
  const [rev, setRev] = useState(0);
  const parsed = useMemo(() => parseDdd(ctx.getSource()), [ctx, rev]);
  const graph = useMemo(
    () => (parsed.parserErrors.length === 0 ? buildSystemGraph(parsed.ast) : null),
    [parsed],
  );
  // LSP diagnostics attributed to the construct that most tightly contains each,
  // so a broken aggregate / view / workflow is flagged on its own node.
  const diagByNode = useMemo(
    () => (graph ? nodeDiagnostics(graph, ctx.diagnostics) : new Map<string, Diagnostic[]>()),
    [graph, ctx.diagnostics],
  );

  // Seed with the first render's nodes/edges (not [] populated by an effect) so
  // the `fitView` prop actually has something to fit on mount.
  const positionsRef = useRef<Map<string, Pos>>(loadPositions());
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(graph ? toRfNodes(graph, diagByNode, new Map(), false, positionsRef.current) : []);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(graph ? toRfEdges(graph) : []);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const compact = !ctx.isDesktop;
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [opName, setOpName] = useState<string | null>(null);
  const [slotKey, setSlotKey] = useState<string | null>(null);
  const [exprMode, setExprMode] = useState<ExprMode>("structured");
  const [findName, setFindName] = useState<string | null>(null);
  const [emitKey, setEmitKey] = useState<string | null>(null);
  // Which body assignment's value is currently expanded into the inline
  // structured editor (`<body-key>:<index>`), or null when all are collapsed.
  const [structuredKey, setStructuredKey] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<NodeKind[]>([]);
  const [overlay, setOverlay] = useState(false);
  const [coverage, setCoverage] = useState<Map<string, CoverageStatus>>(new Map());
  const [preview, setPreview] = useState(false);
  const [pending, setPending] = useState<{ next: string; keepSelection: boolean } | null>(null);
  const [wireShape, setWireShape] = useState<WireField[] | null>(null);
  const [grouped, setGrouped] = useState(false);
  const layout = useMemo(() => (grouped && graph ? groupedLayout(graph) : null), [grouped, graph]);

  // Search + kind filter → the set of node ids to emphasise. Inactive (empty
  // query and no kinds) matches every node, so nothing dims.
  const filterActive = query.trim() !== "" || kindFilter.length > 0;
  const matched = useMemo(
    () => (graph ? matchNodes(graph, query, kindFilter) : new Set<string>()),
    [graph, query, kindFilter],
  );

  useEffect(() => {
    const sel = selectedId;
    setNameDraft(sel ? sel.slice(sel.indexOf(":") + 1) : "");
    setOpName(null);
    setSlotKey(null);
    setExprMode("structured");
    setFindName(null);
    setEmitKey(null);
    setStructuredKey(null);
  }, [selectedId]);

  useEffect(() => {
    if (!graph) return;
    if (grouped && layout) {
      setNodes(toGroupedRfNodes(graph, diagByNode, coverage, overlay, layout));
      setEdges(toRfEdges(graph, true));
    } else {
      setNodes(toRfNodes(graph, diagByNode, coverage, overlay, positionsRef.current));
      setEdges(toRfEdges(graph));
    }
  }, [graph, diagByNode, coverage, overlay, grouped, layout, setNodes, setEdges]);

  // Persist hand-dragged positions: track them live, write to storage on drag
  // end (`dragging === false`). Re-applied by `toRfNodes` on every re-seed, so a
  // source edit or reload no longer resets the user's arrangement.
  const handleNodesChange = useCallback<typeof onNodesChange>(
    (changes) => {
      onNodesChange(changes);
      // Grouped layout is computed (positions are relative to a parent), so it
      // isn't persisted — only the flat layout's absolute positions are.
      if (grouped) return;
      let settled = false;
      for (const c of changes) {
        if (c.type === "position" && c.position && !c.id.startsWith("group:")) {
          positionsRef.current.set(c.id, c.position);
          if (c.dragging === false) settled = true;
        }
      }
      if (settled) savePositions(positionsRef.current);
    },
    [onNodesChange, grouped],
  );

  const resetLayout = (): void => {
    positionsRef.current = new Map();
    savePositions(positionsRef.current);
    if (graph) setNodes(toRfNodes(graph, diagByNode, coverage, overlay, positionsRef.current));
    void rf.fitView({ padding: 0.15 });
  };

  // Coverage overlay: lower + enrich the *linked* model (cross-refs resolved so
  // `entitles`/`covers` land) and map the traceability index onto graph nodes.
  // Async + off the render path; only runs while the overlay is on.
  useEffect(() => {
    if (!overlay) {
      setCoverage(new Map());
      return;
    }
    let alive = true;
    void (async () => {
      const model = await buildLinkedModel(ctx.getSource());
      if (!alive || !model || !graph) return;
      try {
        const loom = enrichLoomModel(lowerModel(model));
        if (alive && loom.traceability) setCoverage(coverageByNode(graph, loom.traceability));
      } catch {
        if (alive) setCoverage(new Map());
      }
    })();
    return () => {
      alive = false;
    };
  }, [overlay, graph, ctx, rev]);

  // Wire shape (canonical DTO field list) of the selected aggregate / value
  // object — lowered + enriched from the linked model, async + off the render
  // path (recomputes on selection change + source edits).
  useEffect(() => {
    const sep = selectedId?.indexOf(":") ?? -1;
    const kind = selectedId && sep >= 0 ? selectedId.slice(0, sep) : "";
    const name = selectedId && sep >= 0 ? selectedId.slice(sep + 1) : "";
    if (kind !== "aggregate" && kind !== "valueobject") {
      setWireShape(null);
      return;
    }
    let alive = true;
    void (async () => {
      const model = await buildLinkedModel(ctx.getSource());
      if (!alive || !model) return;
      try {
        const loom = enrichLoomModel(lowerModel(model));
        if (alive) setWireShape(wireShapeOf(loom, kind, name));
      } catch {
        if (alive) setWireShape(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [selectedId, ctx, rev]);

  // Dim non-matching nodes / edges in place (preserving positions) when a search
  // or kind filter is active; an edge stays lit only if both endpoints match.
  useEffect(() => {
    // Group containers (ids prefixed `group:`) are never dimmed.
    const lit = (id: string): boolean => id.startsWith("group:") || !filterActive || matched.has(id);
    setNodes((ns) => ns.map((n) => ({ ...n, style: { ...n.style, opacity: lit(n.id) ? 1 : 0.2 } })));
    setEdges((es) => es.map((e) => ({ ...e, style: { ...e.style, opacity: !filterActive || (matched.has(e.source) && matched.has(e.target)) ? 1 : 0.1 } })));
  }, [matched, filterActive, setNodes, setEdges]);

  // `fitView` on the ReactFlow element only fits on mount — but nodes are
  // populated by the effect above, *after* the first render — so fit once the
  // nodes have measured dimensions (and again when the graph changes).
  const rf = useReactFlow();
  const nodesInitialized = useNodesInitialized();
  useEffect(() => {
    if (nodesInitialized && graph) void rf.fitView({ padding: 0.15 });
  }, [nodesInitialized, graph, grouped, rf]);

  const hasAggregate = useMemo(() => !!firstAggregateName(parsed.ast), [parsed]);
  const contextNames = useMemo(() => listContextNames(parsed.ast), [parsed]);
  const subdomainNameList = useMemo(() => subdomainNames(parsed.ast), [parsed]);
  const hasSubdomain = subdomainNameList.length > 0;
  // Add-target picks; null means "first" (the default). Clear a stale pick when
  // the named context / subdomain no longer exists after an edit.
  const [addContext, setAddContext] = useState<string | null>(null);
  const [addSubdomainName, setAddSubdomainName] = useState<string | null>(null);
  useEffect(() => {
    if (addContext && !contextNames.includes(addContext)) setAddContext(null);
    if (addSubdomainName && !subdomainNameList.includes(addSubdomainName)) setAddSubdomainName(null);
  }, [contextNames, subdomainNameList, addContext, addSubdomainName]);
  const typeOptions = useMemo(() => availableTypes(parsed.ast), [parsed]);
  const baseByLabel = useMemo(() => {
    const m = new Map<string, BaseSpec>();
    for (const o of typeOptions) m.set(o.label, o.base);
    return m;
  }, [typeOptions]);

  if (parsed.parserErrors.length > 0) {
    return <Message>Source has syntax errors — fix them in the editor to use the model builder.</Message>;
  }
  if (!graph || graph.nodes.length === 0) {
    return <Message>No structural model found. Declare a <code>system</code> with modules / aggregates to see the graph.</Message>;
  }

  const selected = graph.nodes.find((n) => n.id === selectedId) ?? null;

  const commit = (next: string, keepSelection: boolean): void => {
    ctx.onSourceChange(next, "builder");
    if (!keepSelection) setSelectedId(null);
    setRev((r) => r + 1);
  };

  // In preview mode an edit is staged (showing its source diff) until confirmed,
  // instead of committing live. A no-op edit (text unchanged) always passes
  // through. `apply` is the single choke point every editing handler routes to.
  const apply = (next: string, keepSelection = false): void => {
    if (preview && next !== ctx.getSource()) setPending({ next, keepSelection });
    else commit(next, keepSelection);
  };

  const renameField = async (oldName: string, rawNext: string): Promise<void> => {
    if (!selected) return;
    const next = rawNext.trim();
    if (!IDENTIFIER.test(next) || next === oldName) return;
    const result = await renameMember(ctx.getSource(), selected.kind, selected.name, oldName, next);
    if (result != null) apply(result, true);
  };

  const renameSelected = async (): Promise<void> => {
    if (!selected) return;
    const next = nameDraft.trim();
    if (!IDENTIFIER.test(next) || next === selected.name) return;
    setRenaming(true);
    try {
      const result = await renameConstruct(ctx.getSource(), selected.kind, selected.name, next);
      if (result != null) apply(result);
    } finally {
      setRenaming(false);
    }
  };

  const deleteSelected = (): void => {
    if (!selected) return;
    const fresh = parseDdd(ctx.getSource());
    const match = findByKindName(fresh.ast, selected);
    if (!match) return;
    apply(spliceNode(ctx.getSource(), match, ""));
  };

  const addSubdomain = (): void => {
    const next = addSubdomainSource(ctx.getSource());
    if (next != null) apply(next);
  };

  // Add a construct into the chosen target context (domain kinds) / subdomain (api),
  // defaulting to the first when none is picked. Parse-guarded inside `add.ts`.
  const addConstruct = (kind: NodeKind): void => {
    const next = addConstructSource(ctx.getSource(), kind, {
      context: addContext ?? undefined,
      subdomain: addSubdomainName ?? undefined,
    });
    if (next != null) apply(next);
  };

  const addFieldTo = (): void => {
    if (!selected) return;
    const name = freshFieldName(selected.ast);
    const next = addField(ctx.getSource(), selected.kind, selected.name, name, {
      base: { kind: "primitive", name: "string" },
      array: false,
      optional: false,
    });
    if (next != null) apply(next, true);
  };

  const setFieldType = (index: number, spec: TypeSpec): void => {
    if (!selected) return;
    const next = retypeField(ctx.getSource(), selected.kind, selected.name, index, spec);
    if (next != null) apply(next, true);
  };

  const removeField = (index: number): void => {
    if (!selected) return;
    const next = deleteField(ctx.getSource(), selected.kind, selected.name, index);
    if (next != null) apply(next, true);
  };

  // Repository find params (only when a find is picked).
  const applyFind = (next: string | null): void => {
    if (next != null) apply(next, true);
  };
  const addParamTo = (): void => {
    if (!selected || !findName) return;
    const name = freshParamName(parsed.ast, selected.name, findName);
    applyFind(addFindParam(ctx.getSource(), selected.name, findName, name, { base: { kind: "primitive", name: "string" }, array: false, optional: false }));
  };
  const setParamType = (index: number, spec: TypeSpec): void => {
    if (!selected || !findName) return;
    applyFind(retypeFindParam(ctx.getSource(), selected.name, findName, index, spec));
  };
  const removeParam = (index: number): void => {
    if (!selected || !findName) return;
    applyFind(deleteFindParam(ctx.getSource(), selected.name, findName, index));
  };
  const renameParam = (index: number, next: string): void => {
    if (!selected || !findName) return;
    applyFind(renameFindParam(ctx.getSource(), selected.name, findName, index, next));
  };
  const setReturn = (spec: TypeSpec): void => {
    if (!selected || !findName) return;
    applyFind(setFindReturnType(ctx.getSource(), selected.name, findName, spec));
  };

  const repointEmit = (op: string | undefined, index: number, event: string): void => {
    if (!selected) return;
    const next = setEmitEvent(ctx.getSource(), selected.kind, selected.name, op, index, event);
    if (next != null) apply(next, true);
  };

  // Infra construct scalar properties.
  const setStorage = (type: string): void => {
    if (!selected) return;
    const next = setStorageType(ctx.getSource(), selected.name, type);
    if (next != null) apply(next, true);
  };
  const setPlatform = (platform: string): void => {
    if (!selected) return;
    const next = setDeployablePlatform(ctx.getSource(), selected.name, platform);
    if (next != null) apply(next, true);
  };
  const setPort = (port: number | undefined): void => {
    if (!selected) return;
    const next = setDeployablePort(ctx.getSource(), selected.name, port);
    if (next != null) apply(next, true);
  };

  // Deployable composition bindings.
  const bindDeployable = (next: string | null): void => {
    if (next != null) apply(next, true);
  };
  const setContexts = (cs: string[]): void => { if (selected) bindDeployable(setDeployableContexts(ctx.getSource(), selected.name, cs)); };
  const setServes = (apis: string[]): void => { if (selected) bindDeployable(setDeployableServes(ctx.getSource(), selected.name, apis)); };
  const setTargets = (t: string | null): void => { if (selected) bindDeployable(setDeployableTargets(ctx.getSource(), selected.name, t)); };
  const setUi = (u: string | null): void => { if (selected) bindDeployable(setDeployableUi(ctx.getSource(), selected.name, u)); };

  const rebindTo = (target: string | null): void => {
    if (!selected || !target || !isRebindKind(selected.kind)) return;
    const next = rebindReference(ctx.getSource(), selected.kind, selected.name, target);
    if (next != null) apply(next, true);
  };

  // Dragging a (reconnectable) edge's target endpoint onto another node repoints
  // its reference. The owner (edge source) is fixed — only the target moves; an
  // incompatible drop or unparseable rewrite is rejected (edges stay as derived).
  const onReconnect = (oldEdge: Edge, conn: Connection): void => {
    if (!conn.target || conn.source !== oldEdge.source) return;
    const label = typeof oldEdge.label === "string" ? oldEdge.label : "";
    const next = rebindEdgeTarget(ctx.getSource(), label, oldEdge.source, conn.target);
    if (next != null) apply(next, true);
  };

  const bodyHandlers = (loc: BodyLocator) => ({
    onEdit: (i: number, text: string): boolean => {
      const next = editStatement(ctx.getSource(), loc, i, text);
      if (next == null) return false;
      apply(next, true);
      return true;
    },
    onDelete: (i: number): void => {
      const next = deleteStatement(ctx.getSource(), loc, i);
      if (next != null) apply(next, true);
    },
    onMove: (i: number, dir: -1 | 1): void => {
      const next = moveStatement(ctx.getSource(), loc, i, dir);
      if (next != null) apply(next, true);
    },
    onAdd: (text: string): boolean => {
      const next = addStatement(ctx.getSource(), loc, text);
      if (next == null) return false;
      apply(next, true);
      return true;
    },
  });

  // Inline structured editor for a body assignment's value: a per-row `ƒx`
  // toggle expands the same `ExprSlotEditor` the Expression picker uses, bound
  // to that statement's value slot. Keyed by `rev` so it re-seeds on commit;
  // the open row is held in `structuredKey` so it survives the re-seed.
  const valueEditorProps = (loc: BodyLocator) => {
    const base = loc.kind === "operation" ? `${loc.aggregate}.${loc.op}` : loc.name;
    const keyFor = (index: number, field?: number): string => `${base}:${index}:${field ?? ""}`;
    const slotFor = (index: number, field?: number): ExprSlot =>
      loc.kind === "operation"
        ? { kind: "stmtExpr", owner: loc.aggregate, op: loc.op, index, ...(field !== undefined ? { field } : {}) }
        : { kind: "wfStmt", owner: loc.name, index, ...(field !== undefined ? { field } : {}) };
    return {
      // In-scope names at a statement position (params + earlier lets + this-
      // props / context) — receiver suggestions for a bare call's head.
      headCandidates: (index: number): string[] => slotCandidates(parsed.ast, slotFor(index)),
      hasValueEditor: (index: number, field?: number): boolean =>
        slotExpr(parsed.ast, slotFor(index, field)) != null,
      onToggleValueEditor: (index: number, field?: number): void => {
        const k = keyFor(index, field);
        setStructuredKey((cur) => (cur === k ? null : k));
      },
      renderValueEditor: (index: number, field?: number): ReactNode => {
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
            loadEnumPicker={() => enumPickerCandidates(ctx.getSource(), slot)}
            mode={exprMode}
            onMode={setExprMode}
            onCommit={(text) => {
              const next = editExprSlot(ctx.getSource(), slot, text);
              if (next == null) return false;
              apply(next, true);
              return true;
            }}
          />
        );
      },
    };
  };

  return (
    <Box style={{ flex: 1, minHeight: 0, display: "flex" }}>
      <Box style={{ flex: 1, minWidth: 0, position: "relative" }} data-testid="c4system-canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={handleNodesChange}
          onEdgesChange={onEdgesChange}
          onReconnect={onReconnect}
          onNodeClick={(_, n) => { if (n.id.startsWith("group:")) return; setSelectedId(n.id); if (compact) setInspectorOpen(true); }}
          onPaneClick={() => { setSelectedId(null); if (compact) setInspectorOpen(false); }}
          fitView
          minZoom={0.1}
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <Controls />
        </ReactFlow>
        <Group
          gap={4}
          wrap="wrap"
          align="center"
          style={{ position: "absolute", top: 8, left: 8, maxWidth: "calc(100% - 16px)", zIndex: 5, background: "var(--mantine-color-body)", borderRadius: 6, padding: 4, boxShadow: "0 1px 4px rgba(0,0,0,0.2)" }}
        >
          <TextInput
            size="xs"
            w={140}
            placeholder="search…"
            value={query}
            data-testid="c4system-search"
            aria-label="search constructs"
            onChange={(e) => setQuery(e.currentTarget.value)}
          />
          <MultiSelect
            size="xs"
            w={150}
            placeholder={kindFilter.length ? undefined : "all kinds"}
            data={[...new Set(graph.nodes.map((n) => n.kind))]}
            value={kindFilter}
            data-testid="c4system-kind-filter"
            clearable
            onChange={(v) => setKindFilter(v as NodeKind[])}
          />
          {filterActive && (
            <>
              <Text size="xs" c="dimmed" data-testid="c4system-match-count">{matched.size}</Text>
              <Button
                size="compact-xs"
                variant="default"
                data-testid="c4system-focus"
                disabled={matched.size === 0}
                onClick={() => void rf.fitView({ nodes: [...matched].map((id) => ({ id })), padding: 0.2, duration: 300 })}
              >
                Focus
              </Button>
            </>
          )}
          <Button
            size="compact-xs"
            variant={overlay ? "filled" : "default"}
            color={overlay ? "teal" : undefined}
            data-testid="c4system-coverage-toggle"
            onClick={() => setOverlay((o) => !o)}
          >
            Coverage
          </Button>
          <Button
            size="compact-xs"
            variant={grouped ? "filled" : "default"}
            color={grouped ? "grape" : undefined}
            data-testid="c4system-group-toggle"
            title="Nest constructs inside their module / context"
            onClick={() => setGrouped((g) => !g)}
          >
            Group
          </Button>
          <Button
            size="compact-xs"
            variant={preview ? "filled" : "default"}
            color={preview ? "blue" : undefined}
            data-testid="c4system-preview-toggle"
            title="Preview each edit's source diff before applying"
            onClick={() => setPreview((p) => !p)}
          >
            Preview
          </Button>
          <Button
            size="compact-xs"
            variant="default"
            data-testid="c4system-reset-layout"
            title="Discard hand-dragged positions and restore the derived layout"
            onClick={resetLayout}
          >
            Reset layout
          </Button>
          {overlay && (
            <Group gap={8} wrap="nowrap" data-testid="c4system-coverage-legend">
              <Text size="xs" c="green.6">■ tested</Text>
              <Text size="xs" c="red.6">■ untested</Text>
              <Text size="xs" c="dimmed">■ n/a</Text>
            </Group>
          )}
        </Group>
        {compact && (
          <Button
            size="xs"
            variant="filled"
            data-testid="c4system-open-inspector"
            onClick={() => setInspectorOpen(true)}
            style={{ position: "absolute", bottom: 12, right: 12, zIndex: 6, boxShadow: "0 2px 6px rgba(0,0,0,0.3)" }}
          >
            Inspect / +
          </Button>
        )}
      </Box>
      <InspectorPanel compact={compact} opened={inspectorOpen} onClose={() => setInspectorOpen(false)}>
        {(contextNames.length > 1 || subdomainNameList.length > 1) && (
          <Group gap={4} mb={4} wrap="nowrap" align="center">
            <Text size="xs" c="dimmed">Add into</Text>
            {contextNames.length > 1 && (
              <Select
                size="xs"
                w={140}
                data={contextNames}
                value={addContext ?? contextNames[0]}
                allowDeselect={false}
                data-testid="c4system-add-context"
                aria-label="target context"
                onChange={setAddContext}
              />
            )}
            {subdomainNameList.length > 1 && (
              <Select
                size="xs"
                w={120}
                data={subdomainNameList}
                value={addSubdomainName ?? subdomainNameList[0]}
                allowDeselect={false}
                data-testid="c4system-add-subdomain-target"
                aria-label="api source subdomain"
                onChange={setAddSubdomainName}
              />
            )}
          </Group>
        )}
        <Group gap={4} mb="xs">
          <Button size="compact-xs" variant="light" data-testid="c4system-add-subdomain" onClick={addSubdomain}>+ Subdomain</Button>
          <Button size="compact-xs" variant="light" data-testid="c4system-add-aggregate" onClick={() => addConstruct("aggregate")}>+ Aggregate</Button>
          <Button size="compact-xs" variant="light" data-testid="c4system-add-valueobject" onClick={() => addConstruct("valueobject")}>+ Value object</Button>
          <Button size="compact-xs" variant="light" data-testid="c4system-add-event" onClick={() => addConstruct("event")}>+ Event</Button>
          <Button size="compact-xs" variant="light" data-testid="c4system-add-workflow" onClick={() => addConstruct("workflow")}>+ Workflow</Button>
          <Button size="compact-xs" variant="light" data-testid="c4system-add-repository" disabled={!hasAggregate} onClick={() => addConstruct("repository")}>+ Repository</Button>
          <Button size="compact-xs" variant="default" data-testid="c4system-add-storage" onClick={() => addConstruct("storage")}>+ Storage</Button>
          <Button size="compact-xs" variant="default" data-testid="c4system-add-ui" onClick={() => addConstruct("ui")}>+ UI</Button>
          <Button size="compact-xs" variant="default" data-testid="c4system-add-deployable" onClick={() => addConstruct("deployable")}>+ Deployable</Button>
          <Button size="compact-xs" variant="default" data-testid="c4system-add-api" disabled={!hasSubdomain} onClick={() => addConstruct("api")}>+ API</Button>
        </Group>
        {!selected ? (
          <Text size="xs" c="dimmed">Select a node to inspect it, or add a construct.</Text>
        ) : (
          <Stack gap="xs" style={{ flex: 1, minHeight: 0 }}>
            <Group justify="space-between">
              <Text size="xs" tt="uppercase" c="dimmed">{selected.kind}</Text>
              <Button size="compact-xs" variant="subtle" color="red" data-testid="c4system-delete" onClick={deleteSelected}>
                Delete
              </Button>
            </Group>
            <Text size="sm" fw={600} data-testid="c4system-selected-name">{selected.name}</Text>
            <Group gap={4} align="flex-end" wrap="nowrap">
              <TextInput
                size="xs"
                label="Rename"
                style={{ flex: 1 }}
                value={nameDraft}
                error={nameDraft.trim() && !IDENTIFIER.test(nameDraft.trim()) ? "invalid name" : undefined}
                data-testid="c4system-rename-input"
                onChange={(e) => setNameDraft(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void renameSelected();
                }}
              />
              <Button
                size="xs"
                variant="light"
                data-testid="c4system-rename-apply"
                loading={renaming}
                disabled={!IDENTIFIER.test(nameDraft.trim()) || nameDraft.trim() === selected.name}
                onClick={() => void renameSelected()}
              >
                Rename
              </Button>
            </Group>
            {isRebindKind(selected.kind) && (
              <Select
                size="xs"
                label={targetKindOf(selected.kind) === "subdomain" ? "Source subdomain" : "Target aggregate"}
                searchable
                data={rebindTargets(parsed.ast, selected.kind)}
                value={currentTarget(selected.ast, selected.kind)}
                data-testid="c4system-rebind"
                onChange={rebindTo}
              />
            )}
            {isFieldKind(selected.kind) && (
              <Stack gap={4} data-testid="c4system-fields">
                <Group justify="space-between" align="center">
                  <Text size="xs" tt="uppercase" c="dimmed">Fields</Text>
                  <Button size="compact-xs" variant="light" data-testid="c4system-field-add" onClick={addFieldTo}>
                    + field
                  </Button>
                </Group>
                {listFields(selected.ast).map((f, i) => (
                  <Group key={`${f.name}-${i}`} gap={4} align="center" wrap="nowrap" data-testid="c4system-field-row">
                    {selected.kind === "event" ? (
                      <Text size="xs" style={{ flex: "0 0 70px", overflow: "hidden", textOverflow: "ellipsis" }} title={f.name}>
                        {f.name}
                      </Text>
                    ) : (
                      <FieldNameInput name={f.name} onRename={(next) => void renameField(f.name, next)} />
                    )}
                    <Select
                      size="xs"
                      style={{ flex: 1, minWidth: 0 }}
                      searchable
                      data={typeOptions.map((o) => o.label)}
                      value={f.baseLabel}
                      data-testid="c4system-field-type"
                      onChange={(label) => {
                        const base = label ? baseByLabel.get(label) : undefined;
                        if (base) setFieldType(i, { base, array: f.array, optional: f.optional });
                      }}
                    />
                    <Checkbox
                      size="xs"
                      title="array []"
                      checked={f.array}
                      onChange={(e) => setFieldType(i, { base: f.base, array: e.currentTarget.checked, optional: f.optional })}
                    />
                    <Text size="xs" c="dimmed">[]</Text>
                    <Checkbox
                      size="xs"
                      title="optional ?"
                      checked={f.optional}
                      onChange={(e) => setFieldType(i, { base: f.base, array: f.array, optional: e.currentTarget.checked })}
                    />
                    <Text size="xs" c="dimmed">?</Text>
                    <Button
                      size="compact-xs"
                      variant="subtle"
                      color="red"
                      data-testid="c4system-field-delete"
                      onClick={() => removeField(i)}
                    >
                      ×
                    </Button>
                  </Group>
                ))}
              </Stack>
            )}
            {wireShape && wireShape.length > 0 && (
              <Stack gap={2} data-testid="c4system-wireshape">
                <Text size="xs" tt="uppercase" c="dimmed" title="The canonical JSON-on-the-wire DTO every backend emits">
                  Wire shape
                </Text>
                {wireShape.map((w) => (
                  <Group key={w.name} gap={6} wrap="nowrap" align="center" data-testid="c4system-wire-field">
                    <Text size="xs" style={{ fontFamily: "monospace", flex: "0 0 96px", overflow: "hidden", textOverflow: "ellipsis" }} title={w.name}>
                      {w.name}
                    </Text>
                    <Text size="xs" c="dimmed" style={{ fontFamily: "monospace", flex: 1 }}>
                      {typeLabel(w.type)}{w.optional ? "?" : ""}
                    </Text>
                    <Text size="xs" c="dimmed" title="wire field source">{w.source}</Text>
                  </Group>
                ))}
              </Stack>
            )}
            {selected.kind === "repository" && listFinds(selected.ast).length > 0 && (
              <Stack gap={4} data-testid="c4system-finds">
                <Text size="xs" tt="uppercase" c="dimmed">Finds</Text>
                <Select
                  size="xs"
                  placeholder="pick a find…"
                  data={listFinds(selected.ast)}
                  value={findName}
                  data-testid="c4system-find-pick"
                  onChange={setFindName}
                />
                {findName && (() => {
                  const ret = findReturnSpec(parsed.ast, selected.name, findName);
                  const params = listFindParams(parsed.ast, selected.name, findName);
                  return (
                    <Stack gap={4}>
                      {ret && (
                        <Group gap={4} align="center" wrap="nowrap">
                          <Text size="xs" style={{ flex: "0 0 56px" }} c="dimmed">returns</Text>
                          <Select
                            size="xs"
                            style={{ flex: 1, minWidth: 0 }}
                            searchable
                            data={typeOptions.map((o) => o.label)}
                            value={baseLabel(ret.base)}
                            data-testid="c4system-find-return"
                            onChange={(label) => { const base = label ? baseByLabel.get(label) : undefined; if (base) setReturn({ base, array: ret.array, optional: ret.optional }); }}
                          />
                          <Checkbox size="xs" title="array []" checked={ret.array} onChange={(e) => setReturn({ base: ret.base, array: e.currentTarget.checked, optional: ret.optional })} />
                          <Text size="xs" c="dimmed">[]</Text>
                        </Group>
                      )}
                      <Group justify="space-between" align="center">
                        <Text size="xs" c="dimmed">params</Text>
                        <Button size="compact-xs" variant="light" data-testid="c4system-param-add" onClick={addParamTo}>+ param</Button>
                      </Group>
                      {params.map((p, i) => (
                        <Group key={`${p.name}-${i}`} gap={4} align="center" wrap="nowrap" data-testid="c4system-param-row">
                          <FieldNameInput name={p.name} onRename={(next) => renameParam(i, next)} />
                          <Select
                            size="xs"
                            style={{ flex: 1, minWidth: 0 }}
                            searchable
                            data={typeOptions.map((o) => o.label)}
                            value={p.baseLabel}
                            data-testid="c4system-param-type"
                            onChange={(label) => { const base = label ? baseByLabel.get(label) : undefined; if (base) setParamType(i, { base, array: p.array, optional: p.optional }); }}
                          />
                          <Checkbox size="xs" title="array []" checked={p.array} onChange={(e) => setParamType(i, { base: p.base, array: e.currentTarget.checked, optional: p.optional })} />
                          <Text size="xs" c="dimmed">[]</Text>
                          <Checkbox size="xs" title="optional ?" checked={p.optional} onChange={(e) => setParamType(i, { base: p.base, array: p.array, optional: e.currentTarget.checked })} />
                          <Text size="xs" c="dimmed">?</Text>
                          <Button size="compact-xs" variant="subtle" color="red" data-testid="c4system-param-delete" onClick={() => removeParam(i)}>×</Button>
                        </Group>
                      ))}
                    </Stack>
                  );
                })()}
              </Stack>
            )}
            {selected.kind === "storage" && (
              <Group gap={4} align="center" wrap="nowrap" data-testid="c4system-storage">
                <Text size="xs" style={{ flex: "0 0 48px" }} c="dimmed">type</Text>
                <Select
                  size="xs"
                  style={{ flex: 1, minWidth: 0 }}
                  searchable
                  data={STORAGE_TYPES}
                  value={storageType(selected.ast) ?? null}
                  data-testid="c4system-storage-type"
                  onChange={(v) => v && setStorage(v)}
                />
              </Group>
            )}
            {selected.kind === "deployable" && (
              <Stack gap={4} data-testid="c4system-deployable">
                <Group gap={4} align="center" wrap="nowrap">
                  <Text size="xs" style={{ flex: "0 0 56px" }} c="dimmed">platform</Text>
                  <Select
                    size="xs"
                    style={{ flex: 1, minWidth: 0 }}
                    data={PLATFORMS}
                    value={deployablePlatform(selected.ast) ?? null}
                    data-testid="c4system-deployable-platform"
                    onChange={(v) => v && setPlatform(v)}
                  />
                </Group>
                <Group gap={4} align="center" wrap="nowrap">
                  <Text size="xs" style={{ flex: "0 0 56px" }} c="dimmed">port</Text>
                  <NumberInput
                    size="xs"
                    style={{ flex: 1, minWidth: 0 }}
                    value={deployablePort(selected.ast) ?? ""}
                    data-testid="c4system-deployable-port"
                    hideControls
                    allowDecimal={false}
                    onChange={(v) => setPort(typeof v === "number" ? v : undefined)}
                  />
                </Group>
                <MultiSelect
                  size="xs"
                  label="contexts"
                  data={boundedContextNames(parsed.ast)}
                  value={deployableContexts(selected.ast)}
                  data-testid="c4system-deployable-contexts"
                  onChange={setContexts}
                />
                <MultiSelect
                  size="xs"
                  label="serves"
                  data={apiNames(parsed.ast)}
                  value={deployableServes(selected.ast)}
                  data-testid="c4system-deployable-serves"
                  onChange={setServes}
                />
                <Select
                  size="xs"
                  label="targets"
                  clearable
                  data={deployableNames(parsed.ast).filter((n) => n !== selected.name)}
                  value={deployableTargets(selected.ast)}
                  data-testid="c4system-deployable-targets"
                  onChange={setTargets}
                />
                {uiKind(selected.ast) !== "compose" && (
                  <Select
                    size="xs"
                    label="ui"
                    clearable
                    data={uiNames(parsed.ast)}
                    value={deployableUi(selected.ast)}
                    data-testid="c4system-deployable-ui"
                    onChange={setUi}
                  />
                )}
              </Stack>
            )}
            {selected.kind === "workflow" && (
              <BodyEditor
                key={`${selected.id}:${rev}`}
                statements={listStatementViews(parsed.ast, { kind: "workflow", name: selected.name }) ?? []}
                {...bodyHandlers({ kind: "workflow", name: selected.name })}
                {...valueEditorProps({ kind: "workflow", name: selected.name })}
              />
            )}
            {selected.kind === "aggregate" && (
              <Stack gap={4}>
                <Select
                  size="xs"
                  label="Operation body"
                  placeholder="pick an operation…"
                  data={listOperations(selected.ast)}
                  value={opName}
                  data-testid="c4system-op-pick"
                  onChange={setOpName}
                />
                {opName && (
                  <BodyEditor
                    key={`${selected.id}:${opName}:${rev}`}
                    statements={listStatementViews(parsed.ast, { kind: "operation", aggregate: selected.name, op: opName }) ?? []}
                    targets={listFields(selected.ast).map((f) => f.name)}
                    {...bodyHandlers({ kind: "operation", aggregate: selected.name, op: opName })}
                    {...valueEditorProps({ kind: "operation", aggregate: selected.name, op: opName })}
                  />
                )}
              </Stack>
            )}
            {(selected.kind === "aggregate" || selected.kind === "workflow") && listEmits(selected.ast).length > 0 && (
              <Stack gap={4} data-testid="c4system-emits">
                <Select
                  size="xs"
                  label="Emits"
                  placeholder="pick an emit…"
                  data={listEmits(selected.ast).map((e) => ({ value: e.value, label: e.label }))}
                  value={emitKey}
                  data-testid="c4system-emit-pick"
                  onChange={setEmitKey}
                />
                {emitKey && (() => {
                  const e = listEmits(selected.ast).find((x) => x.value === emitKey);
                  return e ? (
                    <Select
                      size="xs"
                      label="event"
                      data={eventNames(parsed.ast)}
                      value={e.event}
                      data-testid="c4system-emit-event"
                      onChange={(v) => v && repointEmit(e.op, e.index, v)}
                    />
                  ) : null;
                })()}
              </Stack>
            )}
            {(() => {
                const options =
                  selected.kind === "repository"
                    ? repoSlotOptions(selected.ast)
                    : selected.kind === "workflow"
                      ? workflowSlotOptions(selected.ast)
                      : selected.kind === "aggregate" || selected.kind === "valueobject"
                        ? exprSlotOptions(selected.ast)
                        : [];
                if (options.length === 0) return null;
                const slot = options.find((o) => o.value === slotKey)?.slot;
                const expr = slot ? slotExpr(parsed.ast, slot) : null;
                return (
                  <Stack gap={4}>
                    <Select
                      size="xs"
                      label="Expression"
                      placeholder="pick a function / derived / invariant…"
                      data={options.map((o) => ({ value: o.value, label: o.label }))}
                      value={slotKey}
                      data-testid="c4system-expr-pick"
                      onChange={setSlotKey}
                    />
                    {slot && expr && (
                      <ExprSlotEditor
                        key={`${selected.id}:${slotKey}:${rev}`}
                        seed={seedExpr(expr)}
                        seedText={expr.$cstNode?.text ?? ""}
                        candidates={slotCandidates(parsed.ast, slot as ExprSlot)}
                        loadHints={() => exprHints(ctx.getSource(), slot as ExprSlot)}
                        loadEnumPicker={() => enumPickerCandidates(ctx.getSource(), slot as ExprSlot)}
                        mode={exprMode}
                        onMode={setExprMode}
                        onCommit={(text) => {
                          const next = editExprSlot(ctx.getSource(), slot as ExprSlot, text);
                          if (next == null) return false;
                          apply(next, true);
                          return true;
                        }}
                      />
                    )}
                  </Stack>
                );
              })()}
            <ScrollArea style={{ flex: 1, minHeight: 0 }}>
              <Textarea
                size="xs"
                label="Source"
                autosize
                minRows={3}
                readOnly
                value={safePrint(selected.ast)}
                styles={{ input: { fontFamily: "monospace", fontSize: 11 } }}
              />
            </ScrollArea>
          </Stack>
        )}
      </InspectorPanel>
      <Modal
        opened={pending !== null}
        onClose={() => setPending(null)}
        title="Preview edit"
        size="lg"
        data-testid="c4system-preview-modal"
      >
        {pending && <DiffView diff={lineDiff(ctx.getSource(), pending.next)} />}
        <Group justify="flex-end" mt="md">
          <Button size="xs" variant="default" data-testid="c4system-preview-cancel" onClick={() => setPending(null)}>
            Cancel
          </Button>
          <Button
            size="xs"
            data-testid="c4system-preview-apply"
            onClick={() => {
              if (pending) commit(pending.next, pending.keepSelection);
              setPending(null);
            }}
          >
            Apply
          </Button>
        </Group>
      </Modal>
    </Box>
  );
}

// A compact unified diff of a staged edit: removed lines (red, `-`) then added
// lines (green, `+`), anchored at the changed line. Edits are localised splices,
// so the hunk is small.
function DiffView({ diff }: { diff: ReturnType<typeof lineDiff> }): JSX.Element {
  if (diff.removed.length === 0 && diff.added.length === 0) {
    return <Text size="xs" c="dimmed">No change.</Text>;
  }
  return (
    <ScrollArea.Autosize mah={360}>
      <Box style={{ fontFamily: "monospace", fontSize: 11, whiteSpace: "pre" }} data-testid="c4system-preview-diff">
        <Text size="xs" c="dimmed">@@ line {diff.atLine + 1} @@</Text>
        {diff.removed.map((l, i) => (
          <Box key={`r${i}`} style={{ background: "var(--mantine-color-red-9)", color: "var(--mantine-color-red-1)" }}>{`- ${l}`}</Box>
        ))}
        {diff.added.map((l, i) => (
          <Box key={`a${i}`} style={{ background: "var(--mantine-color-green-9)", color: "var(--mantine-color-green-1)" }}>{`+ ${l}`}</Box>
        ))}
      </Box>
    </ScrollArea.Autosize>
  );
}

/** Re-locate a graph node's AST node in a freshly parsed tree by kind+name
 *  (the in-memory AST is replaced after every edit, so stored references go
 *  stale). */
function findByKindName(ast: Model, target: GraphNode): AstNode | null {
  const wantType = KIND_TO_TYPE[target.kind];
  for (const n of AstUtils.streamAst(ast)) {
    if (n.$type === wantType && (n as { name?: string }).name === target.name) return n;
  }
  return null;
}

const KIND_TO_TYPE: Record<NodeKind, string> = {
  subdomain: "Subdomain",
  context: "BoundedContext",
  aggregate: "Aggregate",
  valueobject: "ValueObject",
  event: "EventDecl",
  repository: "Repository",
  workflow: "Workflow",
  deployable: "Deployable",
  api: "Api",
  storage: "Storage",
  ui: "Ui",
};

function safePrint(node: AstNode): string {
  try {
    return printStructural(node);
  } catch {
    return node.$cstNode?.text ?? "";
  }
}

function Message({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <Box p="md">
      <Text size="sm" c="dimmed">{children}</Text>
    </Box>
  );
}
