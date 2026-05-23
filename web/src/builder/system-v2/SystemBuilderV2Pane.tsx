// Model builder v2 — Phase 1 (drill-down backbone, read-only).
//
// The canvas IS the navigator. Each level shows the children of the current
// node; a breadcrumb up top tracks the path; clicking a drillable node pushes
// a step. v1 is unchanged and still ships in the "Model" tab.

import { useEffect, useMemo, useState, Fragment } from "react";
import { Box, Button, Group, Text } from "@mantine/core";
import {
  Background,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { LayoutCtx } from "../../layout/ctx";
import { parseDdd } from "../parse";
import { listStatementViews, type BodyLocator } from "../system/body";
import StmtNode from "./StmtNode";
import { buildViewGraph, type ViewGraph, type ViewKind, type ViewPath } from "./view-graph";

const KIND_COLOR: Record<ViewKind, string> = {
  system: "var(--mantine-color-indigo-8)",
  module: "var(--mantine-color-blue-7)",
  context: "var(--mantine-color-cyan-8)",
  aggregate: "var(--mantine-color-teal-7)",
  operation: "var(--mantine-color-orange-8)",
  workflow: "var(--mantine-color-orange-8)",
  valueobject: "var(--mantine-color-cyan-7)",
  event: "var(--mantine-color-grape-7)",
  repository: "var(--mantine-color-indigo-7)",
  view: "var(--mantine-color-lime-8)",
  function: "var(--mantine-color-yellow-8)",
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

function toRfNodes(g: ViewGraph, stmtData: Map<string, Record<string, unknown>>): Node[] {
  return g.nodes.map((n) => {
    if (n.kind === "stmt") {
      return {
        id: n.id,
        type: "stmt",
        position: { x: n.x, y: n.y },
        data: stmtData.get(n.id) ?? ({} as Record<string, unknown>),
        // Custom node owns its own dimensions / borders; no React Flow styling.
        draggable: false,
        selectable: false,
      } satisfies Node;
    }
    return {
      id: n.id,
      position: { x: n.x, y: n.y },
      data: { label: `${n.kind}${n.drillable ? "  ↳" : ""}\n${n.name}` },
      style: {
        background: KIND_COLOR[n.kind],
        color: "white",
        border: "1px solid rgba(255,255,255,0.25)",
        borderRadius: 6,
        fontSize: 11,
        width: 160,
        whiteSpace: "pre-line" as const,
        textAlign: "center" as const,
        cursor: n.drillable ? "pointer" : "default",
      },
    };
  });
}

const NODE_TYPES = { stmt: StmtNode } as const;

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

function toRfEdges(g: ViewGraph): Edge[] {
  return g.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    label: e.label,
    labelStyle: { fontSize: 9, fill: "var(--mantine-color-dimmed)" },
    style: { stroke: "var(--mantine-color-dark-2)" },
  }));
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
  const parsed = useMemo(() => parseDdd(ctx.getSource()), [ctx]);
  const graph = useMemo(() => buildViewGraph(parsed.ast, path), [parsed, path]);

  // When the path's leaf is an operation / workflow, materialise its statement
  // views once per render; the custom `stmt` React Flow node reads each one
  // off its node's data.
  const leafLoc = useMemo(() => leafBodyLocator(path), [path]);
  const stmtData = useMemo(() => {
    const m = new Map<string, Record<string, unknown>>();
    if (!leafLoc) return m;
    const views = listStatementViews(parsed.ast, leafLoc) ?? [];
    views.forEach((view, i) => m.set(`stmt:${i}`, { view }));
    return m;
  }, [parsed, leafLoc]);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(toRfNodes(graph, stmtData));
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(toRfEdges(graph));
  useEffect(() => {
    setNodes(toRfNodes(graph, stmtData));
    setEdges(toRfEdges(graph));
  }, [graph, stmtData, setNodes, setEdges]);

  const rf = useReactFlow();
  const nodesInitialized = useNodesInitialized();
  useEffect(() => {
    if (nodesInitialized && graph.nodes.length > 0) void rf.fitView({ padding: 0.2 });
  }, [nodesInitialized, graph, rf]);

  const drill = (id: string): void => {
    const v = graph.nodes.find((x) => x.id === id);
    if (!v?.drillable) return;
    setPath((p) => [...p, { kind: v.kind, name: v.name }]);
  };

  return (
    <Box style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <Breadcrumb path={path} onJump={(d) => setPath((p) => p.slice(0, d))} />
      <Box style={{ flex: 1, position: "relative", minHeight: 0 }} data-testid="c4system-v2-pane">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={(_, n) => drill(n.id)}
          fitView
          minZoom={0.1}
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <Controls />
        </ReactFlow>
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
