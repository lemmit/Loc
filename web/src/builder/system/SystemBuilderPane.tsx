import { useEffect, useMemo, useState } from "react";
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
import { AstUtils, type AstNode } from "langium";
import { Box, Button, Checkbox, Group, ScrollArea, Select, Stack, Text, TextInput, Textarea } from "@mantine/core";
import type { LayoutCtx } from "../../layout/ctx";
import type { BoundedContext, Model, System } from "../../../../src/language/generated/ast.js";
import { printStructural } from "../../../../src/language/print/index.js";
import { parseDdd } from "../parse";
import { spliceNode, applyEdits } from "../edit-engine";
import { buildSystemGraph, type GraphNode, type NodeKind } from "./model";
import { IDENTIFIER, renameConstruct } from "./rename";
import {
  addField,
  availableTypes,
  deleteField,
  freshFieldName,
  isFieldKind,
  listFields,
  retypeField,
  type BaseSpec,
  type TypeSpec,
} from "./fields";
import { currentTarget, isRebindKind, rebindReference, rebindTargets, targetKindOf } from "./rebind";
import {
  addStatement,
  deleteStatement,
  editStatement,
  listOperations,
  listStatements,
  moveStatement,
  type BodyLocator,
} from "./body";
import { BodyEditor } from "./BodyEditor";
import { editExprSlot, exprSlotOptions, slotExpr, type ExprSlot } from "./expr-slots";
import { seedExpr } from "./expr-model";
import { ExprSlotEditor, type ExprMode } from "./ExpressionEditor";

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

function toRfNodes(graph: ReturnType<typeof buildSystemGraph>): Node[] {
  return graph.nodes.map((n) => ({
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
      whiteSpace: "pre-line" as const,
      textAlign: "center" as const,
    },
  }));
}

function toRfEdges(graph: ReturnType<typeof buildSystemGraph>): Edge[] {
  return graph.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    label: e.label,
    labelStyle: { fontSize: 9, fill: "var(--mantine-color-dimmed)" },
    style: { stroke: "var(--mantine-color-dark-2)" },
  }));
}

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
  return (
    <ReactFlowProvider>
      <SystemBuilderInner ctx={ctx} />
    </ReactFlowProvider>
  );
}

function SystemBuilderInner({ ctx }: { ctx: LayoutCtx }): JSX.Element {
  const [rev, setRev] = useState(0);
  const parsed = useMemo(() => parseDdd(ctx.getSource()), [ctx, rev]);
  const graph = useMemo(
    () => (parsed.parserErrors.length === 0 ? buildSystemGraph(parsed.ast) : null),
    [parsed],
  );

  // Seed with the first render's nodes/edges (not [] populated by an effect) so
  // the `fitView` prop actually has something to fit on mount.
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(graph ? toRfNodes(graph) : []);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(graph ? toRfEdges(graph) : []);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [opName, setOpName] = useState<string | null>(null);
  const [slotKey, setSlotKey] = useState<string | null>(null);
  const [exprMode, setExprMode] = useState<ExprMode>("structured");

  useEffect(() => {
    const sel = selectedId;
    setNameDraft(sel ? sel.slice(sel.indexOf(":") + 1) : "");
    setOpName(null);
    setSlotKey(null);
    setExprMode("structured");
  }, [selectedId]);

  useEffect(() => {
    if (!graph) return;
    setNodes(toRfNodes(graph));
    setEdges(toRfEdges(graph));
  }, [graph, setNodes, setEdges]);

  // `fitView` on the ReactFlow element only fits on mount — but nodes are
  // populated by the effect above, *after* the first render — so fit once the
  // nodes have measured dimensions (and again when the graph changes).
  const rf = useReactFlow();
  const nodesInitialized = useNodesInitialized();
  useEffect(() => {
    if (nodesInitialized && graph) void rf.fitView({ padding: 0.15 });
  }, [nodesInitialized, graph, rf]);

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

  const apply = (next: string, keepSelection = false): void => {
    ctx.onSourceChange(next, "builder");
    if (!keepSelection) setSelectedId(null);
    setRev((r) => r + 1);
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

  const rebindTo = (target: string | null): void => {
    if (!selected || !target || !isRebindKind(selected.kind)) return;
    const next = rebindReference(ctx.getSource(), selected.kind, selected.name, target);
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
          minZoom={0.1}
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
                label={targetKindOf(selected.kind) === "module" ? "Source module" : selected.kind === "view" ? "Source aggregate" : "Target aggregate"}
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
                    <Text size="xs" style={{ flex: "0 0 70px", overflow: "hidden", textOverflow: "ellipsis" }} title={f.name}>
                      {f.name}
                    </Text>
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
            {selected.kind === "workflow" && (
              <BodyEditor
                key={`${selected.id}:${rev}`}
                statements={listStatements(parsed.ast, { kind: "workflow", name: selected.name }) ?? []}
                {...bodyHandlers({ kind: "workflow", name: selected.name })}
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
                    statements={listStatements(parsed.ast, { kind: "operation", aggregate: selected.name, op: opName }) ?? []}
                    {...bodyHandlers({ kind: "operation", aggregate: selected.name, op: opName })}
                  />
                )}
              </Stack>
            )}
            {(selected.kind === "aggregate" || selected.kind === "valueobject") &&
              (() => {
                const options = exprSlotOptions(selected.ast);
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
