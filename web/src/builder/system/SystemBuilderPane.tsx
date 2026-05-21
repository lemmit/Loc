import { useEffect, useMemo, useState } from "react";
import {
  Background,
  Controls,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { AstUtils, type AstNode } from "langium";
import { Box, Button, Group, ScrollArea, Stack, Text, Textarea } from "@mantine/core";
import type { LayoutCtx } from "../../layout/ctx";
import type { BoundedContext, Model, System } from "../../../../src/language/generated/ast.js";
import { printStructural } from "../../../../src/language/print/index.js";
import { parseDdd } from "../parse";
import { spliceNode, applyEdits } from "../edit-engine";
import { buildSystemGraph, type GraphNode, type NodeKind } from "./model";

// Editable structural model graph (React Flow).  Reads the parsed AST into a
// node/edge graph, renders it, and edits splice the backing AST node's CST
// range via the structural printer.  Source stays the source of truth; node
// positions are layout only (not written back).

const KIND_COLOR: Record<NodeKind, string> = {
  module: "var(--mantine-color-blue-7)",
  aggregate: "var(--mantine-color-teal-7)",
  valueobject: "var(--mantine-color-cyan-8)",
  event: "var(--mantine-color-grape-7)",
  repository: "var(--mantine-color-indigo-7)",
  view: "var(--mantine-color-lime-8)",
  workflow: "var(--mantine-color-orange-8)",
  deployable: "var(--mantine-color-red-8)",
  api: "var(--mantine-color-pink-7)",
  storage: "var(--mantine-color-gray-7)",
  ui: "var(--mantine-color-violet-7)",
};

function freshName(ast: Model, kind: NodeKind, base: string): string {
  const taken = new Set<string>();
  for (const n of AstUtils.streamAst(ast)) {
    const name = (n as { name?: unknown }).name;
    if (typeof name === "string") taken.add(name);
  }
  for (let i = 1; ; i++) {
    const candidate = `${base}${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Insert `text` just before the closing brace of `block` (i.e. as its last
 *  child).  `block` must come from parsing `source`. */
function insertIntoBlock(source: string, block: AstNode, text: string): string {
  const cst = block.$cstNode;
  if (!cst) throw new Error("insertIntoBlock: node has no CST");
  const at = cst.end - 1; // before the trailing `}`
  return applyEdits(source, [{ offset: at, end: at, newText: text }]);
}

export default function SystemBuilderPane({ ctx }: { ctx: LayoutCtx }): JSX.Element {
  const [rev, setRev] = useState(0);
  const parsed = useMemo(() => parseDdd(ctx.getSource()), [ctx, rev]);
  const graph = useMemo(
    () => (parsed.parserErrors.length === 0 ? buildSystemGraph(parsed.ast) : null),
    [parsed],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (!graph) return;
    setNodes(
      graph.nodes.map((n) => ({
        id: n.id,
        position: { x: n.x, y: n.y },
        data: { label: `${n.kind}\n${n.name}` },
        style: {
          background: KIND_COLOR[n.kind],
          color: "white",
          border: "1px solid rgba(255,255,255,0.25)",
          borderRadius: 6,
          fontSize: 11,
          width: 150,
          whiteSpace: "pre-line",
          textAlign: "center",
        },
      })),
    );
    setEdges(
      graph.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        label: e.label,
        labelStyle: { fontSize: 9, fill: "var(--mantine-color-dimmed)" },
        style: { stroke: "var(--mantine-color-dark-2)" },
      })),
    );
  }, [graph, setNodes, setEdges]);

  if (parsed.parserErrors.length > 0) {
    return <Message>Source has syntax errors — fix them in the editor to use the model builder.</Message>;
  }
  if (!graph || graph.nodes.length === 0) {
    return <Message>No structural model found. Declare a <code>system</code> with modules / aggregates to see the graph.</Message>;
  }

  const selected = graph.nodes.find((n) => n.id === selectedId) ?? null;

  const apply = (next: string): void => {
    ctx.onSourceChange(next, "builder");
    setSelectedId(null);
    setRev((r) => r + 1);
  };

  const deleteSelected = (): void => {
    if (!selected) return;
    const fresh = parseDdd(ctx.getSource());
    const match = findByKindName(fresh.ast, selected);
    if (!match) return;
    apply(spliceNode(ctx.getSource(), match, ""));
  };

  const addModule = (): void => {
    const fresh = parseDdd(ctx.getSource());
    const system = fresh.ast.members.find((m): m is System => m.$type === "System");
    if (!system) return;
    const name = freshName(fresh.ast, "module", "Module");
    const text = `\n  module ${name} {\n    context ${name}Ctx {\n    }\n  }\n`;
    apply(insertIntoBlock(ctx.getSource(), system, text));
  };

  const addAggregate = (): void => {
    const fresh = parseDdd(ctx.getSource());
    const context = [...AstUtils.streamAst(fresh.ast)].find(
      (n): n is BoundedContext => n.$type === "BoundedContext",
    );
    if (!context) return;
    const name = freshName(fresh.ast, "aggregate", "Aggregate");
    const text = `\n    aggregate ${name} {\n    }\n`;
    apply(insertIntoBlock(ctx.getSource(), context, text));
  };

  return (
    <Box style={{ flex: 1, minHeight: 0, display: "flex" }}>
      <Box style={{ flex: 1, minWidth: 0 }} data-testid="c4system-canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={(_, n) => setSelectedId(n.id)}
          onPaneClick={() => setSelectedId(null)}
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <Controls />
        </ReactFlow>
      </Box>
      <Box style={{ width: 280, minWidth: 280, borderLeft: "1px solid var(--mantine-color-dark-4)", padding: 8, display: "flex", flexDirection: "column" }}>
        <Group gap="xs" mb="xs">
          <Button size="xs" variant="light" data-testid="c4system-add-module" onClick={addModule}>+ Module</Button>
          <Button size="xs" variant="light" data-testid="c4system-add-aggregate" onClick={addAggregate}>+ Aggregate</Button>
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
      </Box>
    </Box>
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
  module: "Module",
  aggregate: "Aggregate",
  valueobject: "ValueObject",
  event: "EventDecl",
  repository: "Repository",
  view: "View",
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
