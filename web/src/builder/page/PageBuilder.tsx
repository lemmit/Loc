import type { ComponentType } from "react";
import { Editor, Frame, useEditor, type SerializedNodes } from "@craftjs/core";
import { Box, Button, Group, NumberInput, ScrollArea, Select, Stack, Text, TextInput, Textarea, UnstyledButton } from "@mantine/core";
import { resolver } from "./components";
import { PRIMITIVES, defaultNode, propFields, type PrimitiveName } from "./model";

interface PageBuilderProps {
  initialNodes: SerializedNodes;
  pages: string[];
  pageName: string;
  /** Typed option sets for `ref` props (e.g. { aggregate: [...] }). */
  options: Record<string, string[]>;
  onSelectPage: (name: string) => void;
  onApply: (nodes: SerializedNodes) => void;
}

// Structural page-body editor.  Palette (add) | canvas (arrange/select) |
// settings (edit props).  "Apply to source" hands the serialized tree back to
// BuilderPane, which regenerates the `body:` and splices it into `.ddd`.
export default function PageBuilder({ initialNodes, pages, pageName, options, onSelectPage, onApply }: PageBuilderProps): JSX.Element {
  return (
    <Editor resolver={resolver} key={pageName}>
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
    </Editor>
  );
}

function Toolbar({ pages, pageName, onSelectPage, onApply }: Pick<PageBuilderProps, "pages" | "pageName" | "onSelectPage" | "onApply">): JSX.Element {
  const { query } = useEditor();
  return (
    <Group px="xs" py={4} bg="dark.6" gap="xs" justify="space-between" style={{ borderBottom: "1px solid var(--mantine-color-dark-4)" }}>
      <Select size="xs" data={pages} value={pageName} onChange={(v) => v && onSelectPage(v)} data-testid="c4builder-page-select" allowDeselect={false} />
      <Button size="xs" data-testid="c4builder-apply" onClick={() => onApply(query.getSerializedNodes())}>
        Apply to source
      </Button>
    </Group>
  );
}

// Palette: click to add a primitive into the selected container, or the body's
// top container by default.  (Drag-to-add is a later enhancement — craft's
// create-connector swallows the click, so click-add is the reliable path.)
function Palette(): JSX.Element {
  const { query, actions } = useEditor();

  const targetParent = (): string | null => {
    const selected = query.getEvent("selected").first();
    if (selected && query.node(selected).isCanvas()) return selected;
    const top = query.node("ROOT").get().data.nodes[0];
    if (top && query.node(top).isCanvas()) return top;
    return null;
  };

  const add = (name: PrimitiveName): void => {
    const parent = targetParent();
    if (!parent) return;
    const Comp = resolver[name] as ComponentType<Record<string, unknown>>;
    const tree = query.parseReactElement(<Comp {...defaultNode(name as Exclude<PrimitiveName, "Opaque">).props} />).toNodeTree();
    actions.addNodeTree(tree, parent);
  };

  return (
    <Box style={{ width: 110, minWidth: 110, borderRight: "1px solid var(--mantine-color-dark-4)", padding: 6, overflow: "auto" }}>
      <Text size="xs" tt="uppercase" c="dimmed" mb={6}>Add</Text>
      <Stack gap={4}>
        {PRIMITIVES.map((name) => (
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
    </Box>
  );
}

function SettingsPanel({ options }: { options: Record<string, string[]> }): JSX.Element {
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
    <Box style={{ width: 240, minWidth: 240, borderLeft: "1px solid var(--mantine-color-dark-4)", padding: 8, overflow: "auto" }}>
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
        f.key === "raw" ? (
          <Textarea key={f.key} size="xs" label="Source" autosize minRows={2} value={String(props[f.key] ?? "")} onChange={(e) => set(f.key, e.currentTarget.value)} />
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
    </Box>
  );
}
