import { useMemo, useState } from "react";
import {
  AppShell,
  Badge,
  Box,
  Group,
  ScrollArea,
  Select,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { LoomEditor } from "./editor/LoomEditor";
import type { Diagnostic } from "./lsp/protocol";
import { examples, defaultExample } from "./examples";

interface DiagnosticsPanelProps {
  items: Diagnostic[];
}

function DiagnosticsPanel({ items }: DiagnosticsPanelProps): JSX.Element {
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

export default function App(): JSX.Element {
  const [exampleId, setExampleId] = useState(defaultExample.id);
  const initialSource = useMemo(
    () => examples.find((e) => e.id === exampleId)?.source ?? defaultExample.source,
    // Reload editor only when the user picks a new example.
    [exampleId],
  );
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);

  const errorCount = diagnostics.filter((d) => d.severity === "error").length;
  const warningCount = diagnostics.filter((d) => d.severity === "warning").length;

  return (
    <AppShell header={{ height: 48 }} footer={{ height: 28 }} padding={0}>
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Group gap="md">
            <Title order={5}>Loom Playground</Title>
            <Select
              size="xs"
              value={exampleId}
              onChange={(v) => v && setExampleId(v)}
              data={examples.map((e) => ({ value: e.id, label: e.label }))}
              allowDeselect={false}
              w={240}
            />
          </Group>
          <Group gap="xs">
            <Badge color="red" variant={errorCount > 0 ? "filled" : "light"} size="sm">
              {errorCount} error{errorCount === 1 ? "" : "s"}
            </Badge>
            <Badge color="yellow" variant={warningCount > 0 ? "filled" : "light"} size="sm">
              {warningCount} warning{warningCount === 1 ? "" : "s"}
            </Badge>
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Main style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 76px)" }}>
        <Box style={{ flex: 1, minHeight: 0 }}>
          {/* Re-mount the editor when the example changes so its
              initial value updates without us having to push it
              imperatively. */}
          <LoomEditor
            key={exampleId}
            initialValue={initialSource}
            onDiagnosticsChange={setDiagnostics}
          />
        </Box>
        <Box
          style={{
            height: 180,
            borderTop: "1px solid var(--mantine-color-dark-4)",
            background: "var(--mantine-color-dark-7)",
            overflow: "hidden",
          }}
        >
          <Group px="sm" py={4} bg="dark.6" gap="xs">
            <Text size="xs" fw={600} tt="uppercase" c="dimmed">
              Problems
            </Text>
          </Group>
          <ScrollArea h={140}>
            <DiagnosticsPanel items={diagnostics} />
          </ScrollArea>
        </Box>
      </AppShell.Main>
      <AppShell.Footer>
        <Group h="100%" px="md" gap="md" justify="space-between">
          <Text size="xs" c="dimmed">
            Phase 1 — editor + LSP
          </Text>
          <Text size="xs" c="dimmed">
            {diagnostics.length === 0
              ? "ready"
              : `${diagnostics.length} message${diagnostics.length === 1 ? "" : "s"}`}
          </Text>
        </Group>
      </AppShell.Footer>
    </AppShell>
  );
}
