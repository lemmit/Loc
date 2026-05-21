import { Editor, Frame, useEditor, type SerializedNodes } from "@craftjs/core";
import { Box, Button, Group, NumberInput, Select, Text, TextInput, Textarea } from "@mantine/core";
import { resolver } from "./components";

interface PageBuilderProps {
  initialNodes: SerializedNodes;
  pages: string[];
  pageName: string;
  onSelectPage: (name: string) => void;
  onApply: (nodes: SerializedNodes) => void;
}

// Structural page-body editor.  The craft canvas shows the primitive tree;
// "Apply to source" serializes it and hands it back to BuilderPane, which
// regenerates the `body:` and splices it into the `.ddd` source.
export default function PageBuilder({ initialNodes, pages, pageName, onSelectPage, onApply }: PageBuilderProps): JSX.Element {
  return (
    <Editor resolver={resolver} key={pageName}>
      <Box style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <Toolbar pages={pages} pageName={pageName} onSelectPage={onSelectPage} onApply={onApply} />
        <Box style={{ flex: 1, minHeight: 0, display: "flex" }}>
          <Box style={{ flex: 1, minWidth: 0, overflow: "auto", padding: 8 }}>
            <Frame data={initialNodes} />
          </Box>
          <SettingsPanel />
        </Box>
      </Box>
    </Editor>
  );
}

function Toolbar({ pages, pageName, onSelectPage, onApply }: Omit<PageBuilderProps, "initialNodes">): JSX.Element {
  const { query } = useEditor();
  return (
    <Group px="xs" py={4} bg="dark.6" gap="xs" justify="space-between" style={{ borderBottom: "1px solid var(--mantine-color-dark-4)" }}>
      <Select
        size="xs"
        data={pages}
        value={pageName}
        onChange={(v) => v && onSelectPage(v)}
        data-testid="c4builder-page-select"
        allowDeselect={false}
      />
      <Button size="xs" data-testid="c4builder-apply" onClick={() => onApply(query.getSerializedNodes())}>
        Apply to source
      </Button>
    </Group>
  );
}

function SettingsPanel(): JSX.Element {
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

  return (
    <Box style={{ width: 240, minWidth: 240, borderLeft: "1px solid var(--mantine-color-dark-4)", padding: 8, overflow: "auto" }}>
      <Text size="xs" tt="uppercase" c="dimmed" mb="xs">{id ? name : "Select a node"}</Text>
      {id && name === "Heading" && (
        <>
          <TextInput size="xs" label="Text" value={String(props.text ?? "")} onChange={(e) => set("text", e.currentTarget.value)} data-testid="c4builder-prop-text" />
          <NumberInput size="xs" mt="xs" label="Level" min={1} max={6} value={Number(props.level ?? 2)} onChange={(v) => set("level", typeof v === "number" ? v : undefined)} />
        </>
      )}
      {id && name === "Text" && (
        <TextInput size="xs" label="Text" value={String(props.text ?? "")} onChange={(e) => set("text", e.currentTarget.value)} data-testid="c4builder-prop-text" />
      )}
      {id && name === "Button" && (
        <>
          <TextInput size="xs" label="Label" value={String(props.label ?? "")} onChange={(e) => set("label", e.currentTarget.value)} data-testid="c4builder-prop-text" />
          <TextInput size="xs" mt="xs" label="Link (to)" value={String(props.to ?? "")} onChange={(e) => set("to", e.currentTarget.value || undefined)} />
        </>
      )}
      {id && name === "Opaque" && (
        <Textarea size="xs" label="Source" autosize minRows={2} value={String(props.raw ?? "")} onChange={(e) => set("raw", e.currentTarget.value)} />
      )}
      {id && (name === "Stack" || name === "Group" || name === "Root") && (
        <Text size="xs" c="dimmed">Container — no editable props.</Text>
      )}
    </Box>
  );
}
