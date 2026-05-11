import { Badge, Group, ScrollArea, Stack, Text } from "@mantine/core";
import type { Diagnostic } from "../lsp/protocol";

interface Props {
  items: Diagnostic[];
}

// Static list of LSP diagnostics — errors / warnings / info.  Wrapped
// in a ScrollArea by the shell so this component itself just renders
// rows.  Rendering an empty hint when there's nothing keeps the panel
// from looking broken on a clean source.
export function ProblemsPanel({ items }: Props): JSX.Element {
  if (items.length === 0) {
    return (
      <Text c="dimmed" size="sm" p="sm">
        No diagnostics.
      </Text>
    );
  }
  return (
    <Stack gap={2} p="xs">
      {items.map((d, i) => {
        const colour =
          d.severity === "error"
            ? "red"
            : d.severity === "warning"
              ? "yellow"
              : "blue";
        return (
          <Group key={i} gap="xs" align="flex-start" wrap="nowrap">
            <Badge size="xs" color={colour} variant="light" mt={2}>
              {d.severity}
            </Badge>
            <Text size="xs" ff="monospace" c="dimmed">
              {d.range.start.line + 1}:{d.range.start.character + 1}
            </Text>
            <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
              {d.message}
            </Text>
          </Group>
        );
      })}
    </Stack>
  );
}

// Convenience: the shell tends to wrap ProblemsPanel in a ScrollArea
// + a flex-1 box.  Exposing this here keeps the shell code tidy.
export function ProblemsPanelScrollable({ items }: Props): JSX.Element {
  return (
    <ScrollArea style={{ flex: 1, minHeight: 0 }}>
      <ProblemsPanel items={items} />
    </ScrollArea>
  );
}
