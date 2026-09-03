// Overview — the whole model as ONE flat, READ-ONLY graph.
//
// This is v1's canvas, folded into the Model pane as a root-level view mode
// (M-T8.13). It serves the task the drill-down structurally cannot: see
// everything at once, heat-map it by test coverage, search across levels, read
// a construct's wire shape. What it deliberately does NOT do is edit — there
// is exactly one mutation surface in the playground now, the drill-down; from
// here you SELECT a node (its detail panel opens) and `Open ↳` jumps the
// drill-down straight to it, ancestors and all.
//
// Everything below the chrome is the shared graph library `builder/system/`
// (`buildSystemGraph` / `coverageByNode` / `matchNodes` / `wireShapeOf` /
// `groupedLayout` / `positions`) — the modules that survived v1's pane.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  ReactFlow,
  useEdgesState,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Box, Button, Group, MultiSelect, ScrollArea, Stack, Text, TextInput } from "@mantine/core";
import type { AstNode } from "langium";
import type { LayoutCtx } from "../../layout/ctx";
import { MODEL_EMPTY, USED_BY } from "../../layout/vocabulary";
import type { Diagnostic } from "../../lsp/protocol";
import type { WireField } from "../../../../src/ir/types/loom-ir.js";
import { enrichLoomModel } from "../../../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../../../src/ir/lower/lower.js";
import { usePaneHarness } from "../pane-harness";
import { RefusalLine } from "../refusal";
import { ParseErrorState } from "../ParseErrorState";
import { PARSE_ERROR } from "../../layout/vocabulary";
import { groupedLayout } from "../system/grouped-layout";
import { buildLinkedModel } from "../system/linked-doc";
import {
  buildSystemGraph,
  coverageByNode,
  matchNodes,
  nodeDiagnostics,
  typeLabel,
  wireShapeOf,
  type CoverageStatus,
  type GraphNode,
  type NodeKind,
  type SystemGraph,
} from "../system/model";
import { loadPositions, savePositions, type Pos } from "../system/positions";
import type { ViewKind, ViewPath, ViewStep } from "./view-graph";

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

// Coverage-overlay background tints (replace the kind colour while the overlay
// is on, turning the graph into a tested / untested / unreferenced heatmap).
const COVERAGE_COLOR: Record<CoverageStatus, string> = {
  covered: "var(--mantine-color-green-8)",
  uncovered: "var(--mantine-color-red-8)",
  none: "var(--mantine-color-dark-4)",
};

const SEVERITY_COLOR = { error: "var(--mantine-color-red-6)", warning: "var(--mantine-color-yellow-5)" } as const;

/** Worst severity (error beats warning) among a node's diagnostics, or null. */
function worstSeverity(diags: readonly Diagnostic[] | undefined): "error" | "warning" | null {
  if (!diags || diags.length === 0) return null;
  return diags.some((d) => d.severity === "error") ? "error" : "warning";
}

function leafRfNode(
  n: GraphNode,
  diagByNode: Map<string, Diagnostic[]>,
  coverage: Map<string, CoverageStatus>,
  overlay: boolean,
  position: Pos,
  selected: boolean,
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
      border: selected
        ? "2px solid var(--mantine-color-blue-3)"
        : sev
          ? `2px solid ${SEVERITY_COLOR[sev]}`
          : "1px solid rgba(255,255,255,0.25)",
      borderRadius: 6,
      fontSize: 11,
      width: 150,
      whiteSpace: "pre-line" as const,
      textAlign: "center" as const,
    },
  };
}

const GROUP_STYLE: Record<"subdomain" | "context", { background: string; border: string }> = {
  subdomain: { background: "rgba(59,130,246,0.06)", border: "1px solid var(--mantine-color-blue-7)" },
  context: { background: "rgba(20,184,166,0.07)", border: "1px dashed var(--mantine-color-teal-6)" },
};

/** Nested layout: module / context group containers first (React Flow needs a
 *  parent before its children), then the member leaves placed inside them. */
function toGroupedRfNodes(
  graph: SystemGraph,
  diagByNode: Map<string, Diagnostic[]>,
  coverage: Map<string, CoverageStatus>,
  overlay: boolean,
  layout: ReturnType<typeof groupedLayout>,
  selectedId: string | null,
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
    if (n.kind === "subdomain") continue; // subdomains are group containers here
    const p = layout.placements.get(n.id);
    if (p) {
      out.push(
        leafRfNode(n, diagByNode, coverage, overlay, { x: p.x, y: p.y }, n.id === selectedId, p.parentId ?? undefined),
      );
    }
  }
  return out;
}

function toRfEdges(graph: SystemGraph, grouped = false): Edge[] {
  // In grouped mode an edge to a module points at that module's group node.
  const remap = (id: string): string => (grouped && id.startsWith("module:") ? `group:${id}` : id);
  return graph.edges.map((e) => ({
    id: e.id,
    source: remap(e.source),
    target: remap(e.target),
    label: e.label,
    labelStyle: { fontSize: 9, fill: "var(--mantine-color-dimmed)" },
    style: { stroke: "var(--mantine-color-dark-2)" },
  }));
}

// --- drill hand-off ---------------------------------------------------------

/** Flat-graph kind → drill-down step kind. The two vocabularies agree on every
 *  name the flat graph produces, so this is an identity — spelled out so a
 *  future divergence is a compile error rather than a silent bad step. */
const STEP_KIND: Record<NodeKind, ViewKind> = {
  subdomain: "subdomain",
  context: "context",
  aggregate: "aggregate",
  valueobject: "valueobject",
  event: "event",
  repository: "repository",
  workflow: "workflow",
  deployable: "deployable",
  api: "api",
  storage: "storage",
  ui: "ui",
};

/** Kinds `buildViewGraph` has a real view for. Anything else has nothing
 *  BELOW it, so opening it lands on its container instead — where the node is
 *  rendered in situ with its rename / delete / detail affordances. */
const HAS_VIEW: ReadonlySet<NodeKind> = new Set<NodeKind>([
  "subdomain",
  "context",
  "aggregate",
  "repository",
  "workflow",
]);

const CONTAINER_STEP: Record<string, ViewKind> = {
  System: "system",
  Subdomain: "subdomain",
  BoundedContext: "context",
  Aggregate: "aggregate",
};

/** The full drill path to a construct: its System / Subdomain / BoundedContext
 *  ancestors (outermost first), then the construct itself when it has a view
 *  of its own. Built from the AST container chain, so the breadcrumb the user
 *  lands on reads exactly as if they had drilled there by hand. */
export function drillPathTo(node: GraphNode): ViewPath {
  const ancestors: ViewStep[] = [];
  let cur: AstNode | undefined = node.ast.$container;
  while (cur) {
    const kind = CONTAINER_STEP[cur.$type];
    const name = (cur as { name?: string }).name;
    if (kind && typeof name === "string") ancestors.unshift({ kind, name });
    cur = cur.$container;
  }
  const self: ViewStep[] = HAS_VIEW.has(node.kind)
    ? [{ kind: STEP_KIND[node.kind], name: node.name }]
    : [];
  return [...ancestors, ...self];
}

export default function OverviewCanvas({ ctx, onClose, onOpen }: {
  ctx: LayoutCtx;
  onClose: () => void;
  onOpen: (path: ViewPath) => void;
}): JSX.Element {
  // The same rails every pane takes — here only the READ half matters
  // (`parseOk` gates the graph); Overview never writes, so `apply` is unused
  // and the refusal line only ever reports the shared state.
  const harness = usePaneHarness(ctx);
  const { parsed, parseOk, refusal } = harness;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<NodeKind[]>([]);
  const [overlay, setOverlay] = useState(false);
  const [coverage, setCoverage] = useState<Map<string, CoverageStatus>>(new Map());
  const [grouped, setGrouped] = useState(false);
  const [wireShape, setWireShape] = useState<WireField[] | null>(null);
  const getSource = ctx.getSource;

  const graph = useMemo(() => (parseOk ? buildSystemGraph(parsed.ast) : null), [parsed, parseOk]);
  const diagByNode = useMemo(
    () => (graph ? nodeDiagnostics(graph, ctx.diagnostics) : new Map<string, Diagnostic[]>()),
    [graph, ctx.diagnostics],
  );
  const layout = useMemo(() => (grouped && graph ? groupedLayout(graph) : null), [grouped, graph]);

  // Search + kind filter → the ids to emphasise. Inactive (empty query, no
  // kinds) matches every node, so nothing dims.
  const filterActive = query.trim() !== "" || kindFilter.length > 0;
  const matched = useMemo(
    () => (graph ? matchNodes(graph, query, kindFilter) : new Set<string>()),
    [graph, query, kindFilter],
  );

  const positionsRef = useRef<Map<string, Pos>>(loadPositions());
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  useEffect(() => {
    if (!graph) return;
    if (grouped && layout) {
      setNodes(toGroupedRfNodes(graph, diagByNode, coverage, overlay, layout, selectedId));
      setEdges(toRfEdges(graph, true));
    } else {
      setNodes(
        graph.nodes.map((n) =>
          leafRfNode(
            n,
            diagByNode,
            coverage,
            overlay,
            positionsRef.current.get(n.id) ?? { x: n.x, y: n.y },
            n.id === selectedId,
          ),
        ),
      );
      setEdges(toRfEdges(graph));
    }
  }, [graph, diagByNode, coverage, overlay, grouped, layout, selectedId, setNodes, setEdges]);

  // Dim non-matching nodes / edges in place (positions preserved) while a
  // search or kind filter is active; an edge stays lit only if both endpoints
  // match. Group containers are never dimmed.
  useEffect(() => {
    const lit = (id: string): boolean => id.startsWith("group:") || !filterActive || matched.has(id);
    setNodes((ns) => ns.map((n) => ({ ...n, style: { ...n.style, opacity: lit(n.id) ? 1 : 0.2 } })));
    setEdges((es) =>
      es.map((e) => ({
        ...e,
        style: {
          ...e.style,
          opacity: !filterActive || (matched.has(e.source) && matched.has(e.target)) ? 1 : 0.1,
        },
      })),
    );
  }, [matched, filterActive, setNodes, setEdges]);

  // Coverage overlay: lower + enrich the LINKED model (cross-refs resolved so
  // `entitles` / `covers` land) and map the traceability index onto the graph.
  // Async + off the render path; only runs while the overlay is on.
  useEffect(() => {
    if (!overlay) {
      setCoverage(new Map());
      return;
    }
    let alive = true;
    void (async () => {
      const model = await buildLinkedModel(getSource());
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
  }, [overlay, graph, getSource]);

  // Wire shape (the canonical DTO field list every backend emits) of the
  // selected aggregate / value object — lowered + enriched from the linked
  // model, async + off the render path.
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
      const model = await buildLinkedModel(getSource());
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
  }, [selectedId, getSource, parsed]);

  const rf = useReactFlow();
  const nodesInitialized = useNodesInitialized();
  useEffect(() => {
    if (nodesInitialized && graph) void rf.fitView({ padding: 0.15 });
  }, [nodesInitialized, graph, grouped, rf]);

  // Persist hand-dragged positions (layout only — never written back to
  // source): track them live, write to storage on drag end.
  const handleNodesChange = useCallback<typeof onNodesChange>(
    (changes) => {
      onNodesChange(changes);
      // Grouped placements are relative to a parent and recomputed — only the
      // flat layout's absolute positions are persisted.
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
    if (graph) {
      setNodes(
        graph.nodes.map((n) =>
          leafRfNode(n, diagByNode, coverage, overlay, { x: n.x, y: n.y }, n.id === selectedId),
        ),
      );
    }
    void rf.fitView({ padding: 0.15 });
  };

  const selected = graph?.nodes.find((n) => n.id === selectedId) ?? null;
  const open = (n: GraphNode): void => onOpen(drillPathTo(n));

  const toolbar = (
    <Group
      gap={4}
      px={8}
      py={4}
      bg="dark.7"
      wrap="wrap"
      align="center"
      style={{ borderBottom: "1px solid var(--mantine-color-dark-4)" }}
      data-testid="c4system-v2-overview-toolbar"
    >
      <Button
        size="compact-xs"
        variant="subtle"
        data-testid="c4system-v2-overview-close"
        title="Back to the drill-down navigator"
        onClick={onClose}
      >
        ‹ Model
      </Button>
      <Text size="xs" c="dimmed" mr={4}>
        Overview (read-only)
      </Text>
      <TextInput
        size="xs"
        w={130}
        placeholder="search…"
        value={query}
        data-testid="c4system-v2-search"
        aria-label="search constructs"
        onChange={(e) => setQuery(e.currentTarget.value)}
      />
      <MultiSelect
        size="xs"
        w={150}
        placeholder={kindFilter.length ? undefined : "all kinds"}
        data={graph ? [...new Set(graph.nodes.map((n) => n.kind))] : []}
        value={kindFilter}
        data-testid="c4system-v2-kind-filter"
        clearable
        onChange={(v) => setKindFilter(v as NodeKind[])}
      />
      {filterActive && (
        <>
          <Text size="xs" c="dimmed" data-testid="c4system-v2-match-count">
            {matched.size}
          </Text>
          <Button
            size="compact-xs"
            variant="default"
            data-testid="c4system-v2-focus"
            disabled={matched.size === 0}
            onClick={() =>
              void rf.fitView({ nodes: [...matched].map((id) => ({ id })), padding: 0.2, duration: 300 })
            }
          >
            Focus
          </Button>
        </>
      )}
      <Button
        size="compact-xs"
        variant={overlay ? "filled" : "default"}
        color={overlay ? "teal" : undefined}
        data-testid="c4system-v2-coverage-toggle"
        onClick={() => setOverlay((o) => !o)}
      >
        Coverage
      </Button>
      <Button
        size="compact-xs"
        variant={grouped ? "filled" : "default"}
        color={grouped ? "grape" : undefined}
        data-testid="c4system-v2-group-toggle"
        title="Nest constructs inside their module / context"
        onClick={() => setGrouped((g) => !g)}
      >
        Group
      </Button>
      <Button
        size="compact-xs"
        variant="default"
        data-testid="c4system-v2-overview-reset-layout"
        title="Discard hand-dragged positions and restore the derived layout"
        onClick={resetLayout}
      >
        Reset layout
      </Button>
      {overlay && (
        <Group gap={8} wrap="nowrap" data-testid="c4system-v2-coverage-legend">
          <Text size="xs" c="green.6">■ tested</Text>
          <Text size="xs" c="red.6">■ untested</Text>
          <Text size="xs" c="dimmed">■ n/a</Text>
        </Group>
      )}
    </Group>
  );

  if (!parseOk) {
    return (
      <Box style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
        {toolbar}
        <ParseErrorState ctx={ctx} purpose={PARSE_ERROR.purpose.model} testid="overview" />
      </Box>
    );
  }

  return (
    <Box style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      {toolbar}
      <RefusalLine refusal={refusal} />
      <Box style={{ flex: 1, minHeight: 0, display: "flex" }}>
        <Box style={{ flex: 1, minWidth: 0, position: "relative" }} data-testid="c4system-v2-overview-canvas">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={handleNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={(_, n) => {
              if (n.id.startsWith("group:")) return;
              setSelectedId(n.id);
            }}
            onNodeDoubleClick={(_, n) => {
              const g = graph?.nodes.find((x) => x.id === n.id);
              if (g) open(g);
            }}
            onPaneClick={() => setSelectedId(null)}
            fitView
            minZoom={0.1}
            proOptions={{ hideAttribution: true }}
          >
            <Background />
            <Controls />
          </ReactFlow>
          {(!graph || graph.nodes.length === 0) && (
            <Text
              size="xs"
              c="dimmed"
              style={{ position: "absolute", top: 12, left: 12, zIndex: 5 }}
              data-testid="c4system-v2-overview-empty"
            >
              {MODEL_EMPTY.overview}
            </Text>
          )}
        </Box>
        <Box
          style={{
            width: 260,
            minWidth: 260,
            borderLeft: "1px solid var(--mantine-color-dark-4)",
            padding: 8,
            display: "flex",
            flexDirection: "column",
          }}
          data-testid="c4system-v2-overview-detail"
        >
          {!selected ? (
            <Text size="xs" c="dimmed">
              {MODEL_EMPTY.select}
            </Text>
          ) : (
            <Stack gap="xs" style={{ flex: 1, minHeight: 0 }}>
              <Group justify="space-between" wrap="nowrap">
                <Text size="xs" tt="uppercase" c="dimmed">
                  {selected.kind}
                </Text>
                <Button
                  size="compact-xs"
                  variant="light"
                  data-testid="c4system-v2-overview-open"
                  title="Open this construct in the drill-down navigator"
                  onClick={() => open(selected)}
                >
                  Open ↳
                </Button>
              </Group>
              <Text size="sm" fw={600} data-testid="c4system-v2-overview-selected">
                {selected.name}
              </Text>
              {/* The reverse references the graph already carries — every
                  edge INTO the selected node, named by its source and the
                  relation (M-T8.21 slice 4). */}
              <Text size="xs" c="dimmed" data-testid="c4system-v2-overview-usedby">
                {(() => {
                  const refs = (graph?.edges ?? [])
                    .filter((e) => e.target === selected.id)
                    .map((e) => {
                      const src = graph?.nodes.find((n) => n.id === e.source);
                      return src ? `${src.kind} ${src.name} (${e.label})` : null;
                    })
                    .filter((s): s is string => s !== null);
                  return refs.length > 0 ? `${USED_BY.label}: ${refs.join(", ")}` : USED_BY.none;
                })()}
              </Text>
              {overlay && (
                <Text size="xs" c="dimmed" data-testid="c4system-v2-overview-coverage">
                  coverage: {coverage.get(selected.id) ?? "none"}
                </Text>
              )}
              {wireShape && wireShape.length > 0 && (
                <ScrollArea style={{ flex: 1, minHeight: 0 }}>
                  <Stack gap={2} data-testid="c4system-v2-wireshape">
                    <Text
                      size="xs"
                      tt="uppercase"
                      c="dimmed"
                      title="The canonical JSON-on-the-wire DTO every backend emits"
                    >
                      Wire shape
                    </Text>
                    {wireShape.map((w) => (
                      <Group key={w.name} gap={6} wrap="nowrap" align="center" data-testid="c4system-v2-wire-field">
                        <Text
                          size="xs"
                          style={{ fontFamily: "monospace", flex: "0 0 88px", overflow: "hidden", textOverflow: "ellipsis" }}
                          title={w.name}
                        >
                          {w.name}
                        </Text>
                        <Text size="xs" c="dimmed" style={{ fontFamily: "monospace", flex: 1 }}>
                          {typeLabel(w.type)}{w.optional ? "?" : ""}
                        </Text>
                        <Text size="xs" c="dimmed" title="wire field source">
                          {w.source}
                        </Text>
                      </Group>
                    ))}
                  </Stack>
                </ScrollArea>
              )}
            </Stack>
          )}
        </Box>
      </Box>
    </Box>
  );
}
