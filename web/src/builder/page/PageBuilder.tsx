import { useEffect, useMemo, useState, type ComponentType } from "react";
import { Editor, Frame, useEditor, type SerializedNodes } from "@craftjs/core";
import { Box, Button, Drawer, Group, NumberInput, ScrollArea, Select, Stack, Switch, Text, TextInput, Textarea, UnstyledButton } from "@mantine/core";

// Mantine palette names offered in the `color`-kind dropdown (the current value
// is always included too, so custom colours round-trip).
const PALETTE = ["blue", "red", "green", "yellow", "grape", "teal", "gray", "orange", "cyan", "pink", "violet", "indigo", "lime"];
import { resolver, resolverWithComponents } from "./components";
import { PALETTE_PRIMITIVES, SINGLE_CHILD_NODES, defaultNode, propFields, syntheticDefaultProps, type PrimitiveName } from "./model";
import { parseDdd } from "../parse";
import type { Diagnostic } from "../../lsp/protocol";

// A compact problems bar shown above the canvas when the current body has LSP
// diagnostics, so the builder flags errors/warnings in place.
function DiagnosticsBar({ diagnostics }: { diagnostics: Diagnostic[] }): JSX.Element | null {
  if (diagnostics.length === 0) return null;
  const worst = diagnostics.some((d) => d.severity === "error") ? "error" : "warning";
  const bg = worst === "error" ? "var(--mantine-color-red-9)" : "var(--mantine-color-yellow-9)";
  return (
    <Box data-testid="c4builder-diagnostics" style={{ background: bg, color: "white", padding: "3px 8px", fontSize: 11, maxHeight: 72, overflow: "auto" }}>
      {diagnostics.map((d, i) => (
        <div key={i}>{d.severity === "error" ? "✕" : "!"} {d.range.start.line + 1}:{d.range.start.character + 1} — {d.message}</div>
      ))}
    </Box>
  );
}

// A page `body:` admits any expression, so wrapping the field text in a minimal
// page lets the real parser validate an `expr`-kind prop (and the Opaque `raw`
// source) without linking — the same trick the round-trip tests use.
function isValidExpr(text: string): boolean {
  if (text.trim() === "") return false;
  return parseDdd(`system S { ui U { page P { body: ${text} } } }`).parserErrors.length === 0;
}

// Validate a verbatim statement row (call / emit / navigate / …) by parsing it
// inside a handler block — the same no-link wrapping trick as isValidExpr.
function isValidStmt(text: string): boolean {
  if (text.trim() === "") return false;
  return parseDdd(`system S { ui U { page P { body: Button(onClick: e => {\n${text}\n}) } } }`).parserErrors.length === 0;
}

// If `stored` is a bare string literal (e.g. `"hi"`), return its inner text;
// otherwise null (it's an expression like `"a" + x`).
function asLiteralText(stored: string): string | null {
  try {
    const parsed = JSON.parse(stored);
    return typeof parsed === "string" && JSON.stringify(parsed) === stored ? parsed : null;
  } catch {
    return null;
  }
}

// A `text`-kind field: a plain text box for a string literal (re-quoting on
// change), or the raw expression when the content is dynamic (`Text(a + b)`).
function TextField({ label, value, onChange }: { label: string; value: string; onChange: (v: string | undefined) => void }): JSX.Element {
  const literal = asLiteralText(value);
  if (literal !== null || value === "") {
    return (
      <TextInput
        size="xs"
        mb="xs"
        label={label}
        value={literal ?? ""}
        data-testid={`c4builder-prop-${label}`}
        onChange={(e) => onChange(e.currentTarget.value === "" ? undefined : JSON.stringify(e.currentTarget.value))}
      />
    );
  }
  return (
    <TextInput
      size="xs"
      mb="xs"
      label={`${label} (expr)`}
      value={value}
      data-testid={`c4builder-prop-${label}`}
      error={isValidExpr(value) ? undefined : "Invalid expression"}
      onChange={(e) => onChange(e.currentTarget.value || undefined)}
    />
  );
}

interface PageBuilderProps {
  initialNodes: SerializedNodes;
  pages: string[];
  pageName: string;
  /** Typed option sets for `ref` props (e.g. { aggregate: [...] }). */
  options: Record<string, string[]>;
  /** Operation names per aggregate — the contextual `op:` dropdown follows a
   *  Form's selected `of:`. */
  operations?: Record<string, string[]>;
  /** User-defined `component` names in scope, registered in the craft resolver
   *  so calls to them render as editable nodes. */
  componentNames?: string[];
  /** LSP diagnostics scoped to this body, shown as a problems bar. */
  diagnostics?: Diagnostic[];
  onSelectPage: (name: string) => void;
  onApply: (nodes: SerializedNodes) => void;
  /** Narrow-viewport layout: full-width canvas with the palette and
   *  settings panels moved into bottom drawers (mobile). */
  compact?: boolean;
}

// Structural page-body editor.  Palette (add) | canvas (arrange/select) |
// settings (edit props).  "Apply to source" hands the serialized tree back to
// BuilderPane, which regenerates the `body:` and splices it into `.ddd`.
export default function PageBuilder({ initialNodes, pages, pageName, options, operations = {}, componentNames = [], diagnostics = [], onSelectPage, onApply, compact = false }: PageBuilderProps): JSX.Element {
  const editorResolver = useMemo(() => resolverWithComponents(componentNames), [componentNames]);
  return (
    <Editor resolver={editorResolver} key={pageName}>
      {compact ? (
        <CompactLayout initialNodes={initialNodes} pages={pages} pageName={pageName} options={options} operations={operations} diagnostics={diagnostics} onSelectPage={onSelectPage} onApply={onApply} />
      ) : (
        <Box style={{ display: "flex", flexDirection: "column", height: "100%" }}>
          <Toolbar pages={pages} pageName={pageName} onSelectPage={onSelectPage} onApply={onApply} />
          <DiagnosticsBar diagnostics={diagnostics} />
          <Box style={{ flex: 1, minHeight: 0, display: "flex" }}>
            <Palette />
            <ScrollArea style={{ flex: 1, minWidth: 0 }}>
              <Box style={{ padding: 8 }}>
                <Frame data={initialNodes} />
              </Box>
            </ScrollArea>
            <SettingsPanel options={options} operations={operations} />
          </Box>
        </Box>
      )}
    </Editor>
  );
}

// Mobile layout: full-width canvas; the palette ("Add") and settings ("Edit")
// move into bottom drawers reachable from the toolbar.  The settings drawer
// auto-opens on selection so tap-to-select flows straight into editing.
function CompactLayout({ initialNodes, pages, pageName, options, operations = {}, diagnostics = [], onSelectPage, onApply }: Omit<PageBuilderProps, "compact">): JSX.Element {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { selectedId } = useEditor((state) => ({ selectedId: [...state.events.selected][0] }));

  useEffect(() => {
    if (selectedId) setSettingsOpen(true);
  }, [selectedId]);

  return (
    <Box style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <Toolbar
        pages={pages}
        pageName={pageName}
        onSelectPage={onSelectPage}
        onApply={onApply}
        compact
        onOpenPalette={() => setPaletteOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <DiagnosticsBar diagnostics={diagnostics} />
      <ScrollArea style={{ flex: 1, minWidth: 0 }}>
        <Box style={{ padding: 8 }}>
          <Frame data={initialNodes} />
        </Box>
      </ScrollArea>
      <Drawer opened={paletteOpen} onClose={() => setPaletteOpen(false)} position="bottom" size="55%" title="Add" data-testid="c4builder-palette-drawer">
        <PaletteContent onAdded={() => setPaletteOpen(false)} />
      </Drawer>
      <Drawer opened={settingsOpen} onClose={() => setSettingsOpen(false)} position="bottom" size="65%" title="Edit" data-testid="c4builder-settings-drawer">
        <SettingsContent options={options} operations={operations} />
      </Drawer>
    </Box>
  );
}

function Toolbar({ pages, pageName, onSelectPage, onApply, compact = false, onOpenPalette, onOpenSettings }: Pick<PageBuilderProps, "pages" | "pageName" | "onSelectPage" | "onApply"> & { compact?: boolean; onOpenPalette?: () => void; onOpenSettings?: () => void }): JSX.Element {
  const { query } = useEditor();
  const apply = (
    <Button size="xs" data-testid="c4builder-apply" onClick={() => onApply(query.getSerializedNodes())}>
      Apply to source
    </Button>
  );
  return (
    <Group px="xs" py={4} bg="dark.6" gap="xs" justify="space-between" style={{ borderBottom: "1px solid var(--mantine-color-dark-4)" }}>
      <Select size="xs" data={pages} value={pageName} onChange={(v) => v && onSelectPage(v)} data-testid="c4builder-page-select" allowDeselect={false} />
      {compact ? (
        <Group gap="xs" wrap="nowrap">
          <Button size="xs" variant="default" data-testid="c4builder-add" onClick={onOpenPalette}>Add</Button>
          <Button size="xs" variant="default" data-testid="c4builder-edit" onClick={onOpenSettings}>Edit</Button>
          {apply}
        </Group>
      ) : (
        apply
      )}
    </Group>
  );
}

// Palette: click to add a primitive into the selected container, or the body's
// top container by default.  (Drag-to-add is a later enhancement — craft's
// create-connector swallows the click, so click-add is the reliable path.
// Click-add is also what makes the palette work on touch, where craft's
// mouse-driven drag-reorder is unavailable.)
function PaletteContent({ onAdded }: { onAdded?: () => void }): JSX.Element {
  const { query, actions, connectors } = useEditor();

  // A node can host a freshly-added primitive if it's a canvas that isn't a
  // Match (whose children must be arms — use "+ arm") and isn't an already-full
  // single-child slot (a lambda body / match value holds exactly one child).
  const canHost = (nodeId: string): boolean => {
    const node = query.node(nodeId);
    if (!node.isCanvas()) return false;
    const dn = node.get().data.displayName;
    if (dn === "Match") return false;
    if (SINGLE_CHILD_NODES.has(dn) && node.get().data.nodes.length >= 1) return false;
    return true;
  };

  const targetParent = (): string | null => {
    const selected = query.getEvent("selected").first();
    if (selected && canHost(selected)) return selected;
    const top = query.node("ROOT").get().data.nodes[0];
    if (top && canHost(top)) return top;
    return null;
  };

  const add = (name: (typeof PALETTE_PRIMITIVES)[number]): void => {
    const parent = targetParent();
    if (!parent) return;
    const Comp = resolver[name] as ComponentType<Record<string, unknown>>;
    const tree = query.parseReactElement(<Comp {...defaultNode(name).props} />).toNodeTree();
    actions.addNodeTree(tree, parent);
    onAdded?.();
  };

  return (
    <Stack gap={4}>
      {PALETTE_PRIMITIVES.map((name) => {
        const Comp = resolver[name] as ComponentType<Record<string, unknown>>;
        return (
          <UnstyledButton
            key={name}
            data-testid={`c4palette-${name}`}
            // Drag onto a canvas to create the node there; click still adds it to
            // the selected/top container (the reliable, touch-friendly path).
            ref={(dom: HTMLButtonElement | null) => {
              if (dom) connectors.create(dom, <Comp {...defaultNode(name).props} />);
            }}
            onClick={() => add(name)}
            style={{ fontSize: 12, padding: "3px 6px", borderRadius: 4, border: "1px solid var(--mantine-color-dark-4)", background: "var(--mantine-color-dark-6)", cursor: "grab" }}
          >
            {name}
          </UnstyledButton>
        );
      })}
    </Stack>
  );
}

function Palette(): JSX.Element {
  return (
    <Box style={{ width: 110, minWidth: 110, borderRight: "1px solid var(--mantine-color-dark-4)", padding: 6, overflow: "auto" }}>
      <Text size="xs" tt="uppercase" c="dimmed" mb={6}>Add</Text>
      <PaletteContent />
    </Box>
  );
}

function SettingsContent({ options, operations = {} }: { options: Record<string, string[]>; operations?: Record<string, string[]> }): JSX.Element {
  const { id, name, props, childNames, actions, query } = useEditor((state) => {
    const selected = [...state.events.selected][0];
    const node = selected ? state.nodes[selected] : undefined;
    return {
      id: selected,
      name: node?.data.displayName,
      props: (node?.data.props ?? {}) as Record<string, string | number | undefined>,
      childNames: (node?.data.nodes ?? []).map((cid) => state.nodes[cid]?.data.displayName),
    };
  });

  const set = (key: string, value: string | number | undefined): void => {
    if (id) actions.setProp(id, (p: Record<string, unknown>) => { p[key] = value; });
  };

  // Add a synthetic match arm / else (with a default value child) into the
  // selected Match.  Arms aren't palette primitives, so they need this control.
  const addArm = (kind: "MatchArm" | "MatchElse"): void => {
    if (!id) return;
    const Arm = resolver[kind] as ComponentType<Record<string, unknown>>;
    const arm = query.parseReactElement(<Arm {...syntheticDefaultProps(kind)} />).toNodeTree();
    actions.addNodeTree(arm, id);
    const Value = resolver.Text as ComponentType<Record<string, unknown>>;
    const value = query.parseReactElement(<Value {...defaultNode("Text").props} />).toNodeTree();
    actions.addNodeTree(value, arm.rootNodeId);
  };

  // Add a statement row to the selected block-bodied lambda.
  const addStmt = (): void => {
    if (!id) return;
    const Stmt = resolver.Stmt as ComponentType<Record<string, unknown>>;
    actions.addNodeTree(query.parseReactElement(<Stmt src="let x = 0" />).toNodeTree(), id);
  };

  const isBlockLambda = name === "Lambda" && props.__block != null;

  const specFields = name ? propFields(name) : [];
  // Surface passthrough props (unmodelled modifiers kept verbatim, e.g.
  // `testid:`/`striped:`) as generic expr fields so they stay editable.
  const known = new Set(specFields.map((f) => f.key));
  const extraFields = Object.keys(props)
    .filter((k) => !known.has(k) && !k.startsWith("__"))
    .map((k) => ({ key: k, kind: "expr" as const }));
  const fields = [...specFields, ...extraFields];

  return (
    <>
      <Group justify="space-between" mb="xs">
        <Text size="xs" tt="uppercase" c="dimmed">{id ? name : "Select a node"}</Text>
        {id && name !== "Root" && (
          <Button size="compact-xs" variant="subtle" color="red" data-testid="c4builder-delete" onClick={() => id && actions.delete(id)}>
            Delete
          </Button>
        )}
      </Group>
      {id && name === "Match" && (
        <Group gap={4} mb="xs">
          <Button size="compact-xs" variant="light" data-testid="c4builder-add-arm" onClick={() => addArm("MatchArm")}>+ arm</Button>
          {!childNames.includes("MatchElse") && (
            <Button size="compact-xs" variant="light" data-testid="c4builder-add-else" onClick={() => addArm("MatchElse")}>+ else</Button>
          )}
        </Group>
      )}
      {id && isBlockLambda && (
        <Group gap={4} mb="xs">
          <Text size="xs" c="dimmed">Handler statements:</Text>
          <Button size="compact-xs" variant="light" data-testid="c4builder-add-stmt" onClick={addStmt}>+ statement</Button>
        </Group>
      )}
      {id && name === "Stmt" && props.kind === "assign" && (
        // Assignment statement: target / op / value as separate controls.
        <>
          <TextInput size="xs" mb={4} label="target" value={String(props.target ?? "")} data-testid="c4builder-prop-target" styles={{ input: { fontFamily: "monospace" } }} onChange={(e) => set("target", e.currentTarget.value)} />
          <Select size="xs" mb={4} label="op" data={[":=", "+=", "-="]} value={String(props.op ?? ":=")} allowDeselect={false} data-testid="c4builder-prop-op-assign" onChange={(v) => v && set("op", v)} />
          <Textarea size="xs" mb="xs" label="value" autosize minRows={1} value={String(props.value ?? "")} data-testid="c4builder-prop-value" styles={{ input: { fontFamily: "monospace" } }} error={props.value && !isValidExpr(String(props.value)) ? "Invalid expression" : undefined} onChange={(e) => set("value", e.currentTarget.value)} />
        </>
      )}
      {id && name === "Stmt" && props.kind === "let" && (
        // `let` binding: name / value as separate controls.
        <>
          <TextInput size="xs" mb={4} label="name" value={String(props.name ?? "")} data-testid="c4builder-prop-let-name" styles={{ input: { fontFamily: "monospace" } }} onChange={(e) => set("name", e.currentTarget.value)} />
          <Textarea size="xs" mb="xs" label="value" autosize minRows={1} value={String(props.value ?? "")} data-testid="c4builder-prop-let-value" styles={{ input: { fontFamily: "monospace" } }} error={props.value && !isValidExpr(String(props.value)) ? "Invalid expression" : undefined} onChange={(e) => set("value", e.currentTarget.value)} />
        </>
      )}
      {id && name === "Stmt" && props.kind !== "assign" && props.kind !== "let" && (
        <Textarea
          size="xs"
          mb="xs"
          label="Statement"
          autosize
          minRows={1}
          value={String(props.src ?? "")}
          data-testid="c4builder-prop-src"
          styles={{ input: { fontFamily: "monospace" } }}
          error={props.src && !isValidStmt(String(props.src)) ? "Invalid statement" : undefined}
          onChange={(e) => set("src", e.currentTarget.value)}
        />
      )}
      {id && fields.length === 0 && name !== "Match" && name !== "Stmt" && !isBlockLambda && (
        <Text size="xs" c="dimmed">
          {SINGLE_CHILD_NODES.has(name ?? "")
            ? (childNames.length === 0 ? "Empty — add one child from the palette." : "Holds one child.")
            : "Container — add children from the palette."}
        </Text>
      )}
      {id && name !== "Stmt" && fields.map((f) =>
        f.kind === "color" ? (
          <Select
            key={f.key}
            size="xs"
            mb="xs"
            label={f.key}
            clearable
            searchable
            data={[...new Set([...PALETTE, props[f.key]].filter(Boolean) as string[])]}
            value={props[f.key] != null ? String(props[f.key]) : null}
            data-testid={`c4builder-prop-${f.key}`}
            onChange={(v) => set(f.key, v || undefined)}
          />
        ) : f.kind === "text" ? (
          <TextField key={f.key} label={f.key} value={String(props[f.key] ?? "")} onChange={(v) => set(f.key, v)} />
        ) : f.kind === "expr" && (props[f.key] === "true" || props[f.key] === "false") ? (
          // A boolean-valued modifier (e.g. `striped: true`) edits as a switch.
          <Switch
            key={f.key}
            size="xs"
            mb="xs"
            label={f.key}
            checked={props[f.key] === "true"}
            data-testid={`c4builder-prop-${f.key}`}
            onChange={(e) => set(f.key, e.currentTarget.checked ? "true" : "false")}
          />
        ) : f.kind === "expr" ? (
          <Textarea
            key={f.key}
            size="xs"
            mb="xs"
            label={f.key === "raw" ? "Source" : f.key}
            autosize
            minRows={2}
            value={String(props[f.key] ?? "")}
            data-testid={`c4builder-prop-${f.key}`}
            error={props[f.key] != null && props[f.key] !== "" && !isValidExpr(String(props[f.key])) ? "Invalid expression" : undefined}
            onChange={(e) => set(f.key, e.currentTarget.value || undefined)}
          />
        ) : f.kind === "ref" ? (
          <Select
            key={f.key}
            size="xs"
            mb="xs"
            label={f.key}
            clearable
            searchable
            // `operation` options are contextual: the operations of the node's
            // sibling `of:` aggregate.  Other ref kinds use a static option set.
            data={[...new Set([
              ...(f.options === "operation" ? (operations[String(props.of ?? "")] ?? []) : (options[f.options ?? ""] ?? [])),
              props[f.key],
            ].filter(Boolean) as string[])]}
            value={props[f.key] != null ? String(props[f.key]) : null}
            data-testid={`c4builder-prop-${f.key}`}
            onChange={(v) => set(f.key, v || undefined)}
          />
        ) : f.kind === "int" ? (
          <NumberInput key={f.key} size="xs" mb="xs" label={f.key} min={0} value={Number(props[f.key] ?? 1)} onChange={(v) => set(f.key, typeof v === "number" ? v : undefined)} />
        ) : (
          <TextInput key={f.key} size="xs" mb="xs" label={f.key} value={String(props[f.key] ?? "")} data-testid={`c4builder-prop-${f.key}`} onChange={(e) => set(f.key, e.currentTarget.value || undefined)} />
        ),
      )}
    </>
  );
}

function SettingsPanel({ options, operations = {} }: { options: Record<string, string[]>; operations?: Record<string, string[]> }): JSX.Element {
  return (
    <Box style={{ width: 240, minWidth: 240, borderLeft: "1px solid var(--mantine-color-dark-4)", padding: 8, overflow: "auto" }}>
      <SettingsContent options={options} operations={operations} />
    </Box>
  );
}
