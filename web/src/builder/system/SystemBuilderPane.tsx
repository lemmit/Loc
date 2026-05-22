import { useEffect, useMemo, useState, type ReactNode } from "react";
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
import { Box, Button, Checkbox, Drawer, Group, MultiSelect, NumberInput, ScrollArea, Select, Stack, Text, TextInput, Textarea } from "@mantine/core";
import type { LayoutCtx } from "../../layout/ctx";
import type { BoundedContext, Model, System } from "../../../../src/language/generated/ast.js";
import { printStructural } from "../../../../src/language/print/index.js";
import { parseDdd } from "../parse";
import { spliceNode, applyEdits } from "../edit-engine";
import { buildSystemGraph, type GraphNode, type NodeKind } from "./model";
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
  deployableModules,
  deployableNames,
  deployableServes,
  deployableTargets,
  deployableUi,
  moduleNames,
  setDeployableModules,
  setDeployableServes,
  setDeployableTargets,
  setDeployableUi,
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
  listStatements,
  moveStatement,
  type BodyLocator,
} from "./body";
import { BodyEditor } from "./BodyEditor";
import { editExprSlot, exprHints, exprSlotOptions, repoSlotOptions, slotCandidates, slotExpr, viewSlotOptions, workflowSlotOptions, type ExprSlot } from "./expr-slots";
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

const CONSTRUCT_BASE: Partial<Record<NodeKind, string>> = {
  aggregate: "Aggregate",
  valueobject: "ValueObject",
  event: "Event",
  repository: "Repository",
  view: "View",
  workflow: "Workflow",
  api: "Api",
  storage: "Storage",
  ui: "Ui",
  deployable: "Deployable",
};

// Infra constructs live at system scope; domain constructs live in a context.
const INFRA_KINDS = new Set<NodeKind>(["api", "storage", "ui", "deployable"]);

function firstNodeName(ast: Model, type: string): string | undefined {
  for (const n of AstUtils.streamAst(ast)) {
    if (n.$type === type) return (n as { name?: string }).name;
  }
  return undefined;
}
const firstAggregateName = (ast: Model): string | undefined => firstNodeName(ast, "Aggregate");

// Minimal-but-valid source for a freshly added construct. Constructs that
// require a reference (repository/view → an aggregate, api → a module) return
// null when none exists, so the add is skipped.
function constructTemplate(kind: NodeKind, name: string, ast: Model): string | null {
  switch (kind) {
    case "aggregate":
      return `\n    aggregate ${name} {\n    }\n`;
    case "valueobject":
      return `\n    valueobject ${name} {\n      value: string\n    }\n`;
    case "event":
      return `\n    event ${name} {\n    }\n`;
    case "workflow":
      return `\n    workflow ${name}() {\n    }\n`;
    case "repository": {
      const agg = firstAggregateName(ast);
      return agg ? `\n    repository ${name} for ${agg} {\n    }\n` : null;
    }
    case "view": {
      const agg = firstAggregateName(ast);
      return agg ? `\n    view ${name} = ${agg} where true\n` : null;
    }
    case "storage":
      return `\n  storage ${name} {\n    type: postgres\n  }\n`;
    case "ui":
      return `\n  ui ${name} {\n  }\n`;
    case "deployable":
      return `\n  deployable ${name} {\n    platform: hono\n  }\n`;
    case "api": {
      const mod = firstNodeName(ast, "Module");
      return mod ? `\n  api ${name} from ${mod}\n` : null;
    }
    default:
      return null;
  }
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

  // Seed with the first render's nodes/edges (not [] populated by an effect) so
  // the `fitView` prop actually has something to fit on mount.
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(graph ? toRfNodes(graph) : []);
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

  useEffect(() => {
    const sel = selectedId;
    setNameDraft(sel ? sel.slice(sel.indexOf(":") + 1) : "");
    setOpName(null);
    setSlotKey(null);
    setExprMode("structured");
    setFindName(null);
    setEmitKey(null);
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

  const hasAggregate = useMemo(() => !!firstAggregateName(parsed.ast), [parsed]);
  const hasModule = useMemo(() => !!firstNodeName(parsed.ast, "Module"), [parsed]);
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

  const addModule = (): void => {
    const fresh = parseDdd(ctx.getSource());
    const system = fresh.ast.members.find((m): m is System => m.$type === "System");
    if (!system) return;
    const name = freshName(fresh.ast, "module", "Module");
    const text = `\n  module ${name} {\n    context ${name}Ctx {\n    }\n  }\n`;
    apply(insertIntoBlock(ctx.getSource(), system, text));
  };

  // Add a context-level construct (aggregate / value object / event / repository
  // / view / workflow) into the first bounded context, from a minimal valid
  // template. Repository / view need an aggregate to reference, so they're
  // gated on one existing. The result is parse-guarded before it's applied.
  const addConstruct = (kind: NodeKind): void => {
    const fresh = parseDdd(ctx.getSource());
    const container: AstNode | undefined = INFRA_KINDS.has(kind)
      ? fresh.ast.members.find((m): m is System => m.$type === "System")
      : [...AstUtils.streamAst(fresh.ast)].find((n): n is BoundedContext => n.$type === "BoundedContext");
    if (!container) return;
    const name = freshName(fresh.ast, kind, CONSTRUCT_BASE[kind] ?? "Node");
    const text = constructTemplate(kind, name, fresh.ast);
    if (!text) return;
    const next = insertIntoBlock(ctx.getSource(), container, text);
    if (parseDdd(next).parserErrors.length === 0) apply(next);
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
  const setModules = (mods: string[]): void => { if (selected) bindDeployable(setDeployableModules(ctx.getSource(), selected.name, mods)); };
  const setServes = (apis: string[]): void => { if (selected) bindDeployable(setDeployableServes(ctx.getSource(), selected.name, apis)); };
  const setTargets = (t: string | null): void => { if (selected) bindDeployable(setDeployableTargets(ctx.getSource(), selected.name, t)); };
  const setUi = (u: string | null): void => { if (selected) bindDeployable(setDeployableUi(ctx.getSource(), selected.name, u)); };

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
      <Box style={{ flex: 1, minWidth: 0, position: "relative" }} data-testid="c4system-canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={(_, n) => { setSelectedId(n.id); if (compact) setInspectorOpen(true); }}
          onPaneClick={() => { setSelectedId(null); if (compact) setInspectorOpen(false); }}
          fitView
          minZoom={0.1}
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <Controls />
        </ReactFlow>
        {compact && (
          <Button
            size="xs"
            variant="default"
            data-testid="c4system-open-inspector"
            onClick={() => setInspectorOpen(true)}
            style={{ position: "absolute", top: 8, right: 8, zIndex: 5 }}
          >
            Inspect / +
          </Button>
        )}
      </Box>
      <InspectorPanel compact={compact} opened={inspectorOpen} onClose={() => setInspectorOpen(false)}>
        <Group gap={4} mb="xs">
          <Button size="compact-xs" variant="light" data-testid="c4system-add-module" onClick={addModule}>+ Module</Button>
          <Button size="compact-xs" variant="light" data-testid="c4system-add-aggregate" onClick={() => addConstruct("aggregate")}>+ Aggregate</Button>
          <Button size="compact-xs" variant="light" data-testid="c4system-add-valueobject" onClick={() => addConstruct("valueobject")}>+ Value object</Button>
          <Button size="compact-xs" variant="light" data-testid="c4system-add-event" onClick={() => addConstruct("event")}>+ Event</Button>
          <Button size="compact-xs" variant="light" data-testid="c4system-add-workflow" onClick={() => addConstruct("workflow")}>+ Workflow</Button>
          <Button size="compact-xs" variant="light" data-testid="c4system-add-repository" disabled={!hasAggregate} onClick={() => addConstruct("repository")}>+ Repository</Button>
          <Button size="compact-xs" variant="light" data-testid="c4system-add-view" disabled={!hasAggregate} onClick={() => addConstruct("view")}>+ View</Button>
          <Button size="compact-xs" variant="default" data-testid="c4system-add-storage" onClick={() => addConstruct("storage")}>+ Storage</Button>
          <Button size="compact-xs" variant="default" data-testid="c4system-add-ui" onClick={() => addConstruct("ui")}>+ UI</Button>
          <Button size="compact-xs" variant="default" data-testid="c4system-add-deployable" onClick={() => addConstruct("deployable")}>+ Deployable</Button>
          <Button size="compact-xs" variant="default" data-testid="c4system-add-api" disabled={!hasModule} onClick={() => addConstruct("api")}>+ API</Button>
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
                  label="modules"
                  data={moduleNames(parsed.ast)}
                  value={deployableModules(selected.ast)}
                  data-testid="c4system-deployable-modules"
                  onChange={setModules}
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
                {uiKind(selected.ast) !== "compose" && uiKind(selected.ast) !== "block" && (
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
                  selected.kind === "view"
                    ? viewSlotOptions(selected.ast)
                    : selected.kind === "repository"
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
