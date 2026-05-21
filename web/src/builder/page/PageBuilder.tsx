import { useEffect, useState, type ComponentType } from "react";
import { Editor, Frame, useEditor, type SerializedNodes } from "@craftjs/core";
import { Box, Button, Drawer, Group, NumberInput, ScrollArea, Select, Stack, Text, TextInput, Textarea, UnstyledButton } from "@mantine/core";
import { resolver } from "./components";
import { PALETTE_PRIMITIVES, defaultNode, propFields, type PrimitiveName } from "./model";
import { parseDdd } from "../parse";

// A page `body:` admits any expression, so wrapping the field text in a minimal
// page lets the real parser validate an `expr`-kind prop (and the Opaque `raw`
// source) without linking — the same trick the round-trip tests use.
function isValidExpr(text: string): boolean {
  if (text.trim() === "") return false;
  return parseDdd(`system S { ui U { page P { body: ${text} } } }`).parserErrors.length === 0;
}

interface PageBuilderProps {
  initialNodes: SerializedNodes;
  pages: string[];
  pageName: string;
  /** Typed option sets for `ref` props (e.g. { aggregate: [...] }). */
  options: Record<string, string[]>;
  onSelectPage: (name: string) => void;
  onApply: (nodes: SerializedNodes) => void;
  /** Narrow-viewport layout: full-width canvas with the palette and
   *  settings panels moved into bottom drawers (mobile). */
  compact?: boolean;
}

// Structural page-body editor.  Palette (add) | canvas (arrange/select) |
// settings (edit props).  "Apply to source" hands the serialized tree back to
// BuilderPane, which regenerates the `body:` and splices it into `.ddd`.
export default function PageBuilder({ initialNodes, pages, pageName, options, onSelectPage, onApply, compact = false }: PageBuilderProps): JSX.Element {
  return (
    <Editor resolver={resolver} key={pageName}>
      {compact ? (
        <CompactLayout initialNodes={initialNodes} pages={pages} pageName={pageName} options={options} onSelectPage={onSelectPage} onApply={onApply} />
      ) : (
        <Box style={{ display: "flex", flexDirection: "column", height: "100%" }}>
          <Toolbar pages={pages} pageName={pageName} onSelectPage={onSelectPage} onApply={onApply} />
          <Box style={{ flex: 1, minHeight: 0, display: "flex" }}>
            <Palette />
            <ScrollArea style={{ flex: 1, minWidth: 0 }}>
              <Box style={{ padding: 8 }}>
                <Frame data={initialNodes} />
              </Box>
            </ScrollArea>
            <SettingsPanel options={options} />
          </Box>
        </Box>
      )}
    </Editor>
  );
}

// Mobile layout: full-width canvas; the palette ("Add") and settings ("Edit")
// move into bottom drawers reachable from the toolbar.  The settings drawer
// auto-opens on selection so tap-to-select flows straight into editing.
function CompactLayout({ initialNodes, pages, pageName, options, onSelectPage, onApply }: Omit<PageBuilderProps, "compact">): JSX.Element {
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
      <ScrollArea style={{ flex: 1, minWidth: 0 }}>
        <Box style={{ padding: 8 }}>
          <Frame data={initialNodes} />
        </Box>
      </ScrollArea>
      <Drawer opened={paletteOpen} onClose={() => setPaletteOpen(false)} position="bottom" size="55%" title="Add" data-testid="c4builder-palette-drawer">
        <PaletteContent onAdded={() => setPaletteOpen(false)} />
      </Drawer>
      <Drawer opened={settingsOpen} onClose={() => setSettingsOpen(false)} position="bottom" size="65%" title="Edit" data-testid="c4builder-settings-drawer">
        <SettingsContent options={options} />
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
  const { query, actions } = useEditor();

  const targetParent = (): string | null => {
    const selected = query.getEvent("selected").first();
    if (selected && query.node(selected).isCanvas()) return selected;
    const top = query.node("ROOT").get().data.nodes[0];
    if (top && query.node(top).isCanvas()) return top;
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
      {PALETTE_PRIMITIVES.map((name) => (
        <UnstyledButton
          key={name}
          data-testid={`c4palette-${name}`}
          onClick={() => add(name)}
          style={{ fontSize: 12, padding: "3px 6px", borderRadius: 4, border: "1px solid var(--mantine-color-dark-4)", background: "var(--mantine-color-dark-6)", cursor: "pointer" }}
        >
          {name}
        </UnstyledButton>
      ))}
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

function SettingsContent({ options }: { options: Record<string, string[]> }): JSX.Element {
  const { id, name, props, actions } = useEditor((state) => {
    const selected = [...state.events.selected][0];
    const node = selected ? state.nodes[selected] : undefined;
    return {
      id: selected,
      name: node?.data.displayName,
      props: (node?.data.props ?? {}) as Record<string, string | number | undefined>,
    };
  });

  const set = (key: string, value: string | number | undefined): void => {
    if (id) actions.setProp(id, (p: Record<string, unknown>) => { p[key] = value; });
  };

  const fields = name ? propFields(name) : [];

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
      {id && fields.length === 0 && <Text size="xs" c="dimmed">Container — drag children in or use the palette.</Text>}
      {id && fields.map((f) =>
        f.kind === "expr" ? (
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
            data={[...new Set([...(options[f.options ?? ""] ?? []), props[f.key]].filter(Boolean) as string[])]}
            value={props[f.key] != null ? String(props[f.key]) : null}
            data-testid={`c4builder-prop-${f.key}`}
            onChange={(v) => set(f.key, v || undefined)}
          />
        ) : f.kind === "int" ? (
          <NumberInput key={f.key} size="xs" mb="xs" label={f.key} min={1} max={6} value={Number(props[f.key] ?? 1)} onChange={(v) => set(f.key, typeof v === "number" ? v : undefined)} />
        ) : (
          <TextInput key={f.key} size="xs" mb="xs" label={f.key} value={String(props[f.key] ?? "")} data-testid={`c4builder-prop-${f.key}`} onChange={(e) => set(f.key, e.currentTarget.value || undefined)} />
        ),
      )}
    </>
  );
}

function SettingsPanel({ options }: { options: Record<string, string[]> }): JSX.Element {
  return (
    <Box style={{ width: 240, minWidth: 240, borderLeft: "1px solid var(--mantine-color-dark-4)", padding: 8, overflow: "auto" }}>
      <SettingsContent options={options} />
    </Box>
  );
}
