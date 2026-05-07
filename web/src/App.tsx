import { useEffect, useMemo, useRef, useState } from "react";
import {
  AppShell,
  Badge,
  Box,
  Button,
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
import { LoomBuildClient } from "./build/client";
import type { GenerateResult, VirtualFile } from "./build/protocol";
import { FileTree } from "./preview/FileTree";
import { FileViewer } from "./preview/FileViewer";
import { buildTree } from "./preview/file-tree";

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

function modeLabel(result: GenerateResult | null): string {
  if (!result) return "not generated";
  if (!result.ok) return "failed";
  switch (result.mode) {
    case "system": return "system";
    case "ts": return "single Hono project";
    case "none": return "empty";
  }
}

export default function App(): JSX.Element {
  const [exampleId, setExampleId] = useState(defaultExample.id);
  const initialSource = useMemo(
    () => examples.find((e) => e.id === exampleId)?.source ?? defaultExample.source,
    [exampleId],
  );
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const sourceRef = useRef<string>(initialSource);
  const buildClientRef = useRef<LoomBuildClient | null>(null);
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  useEffect(() => {
    const client = new LoomBuildClient();
    buildClientRef.current = client;
    return () => {
      buildClientRef.current = null;
      client.dispose();
    };
  }, []);

  // Reset preview state when the user picks a different example —
  // the previously generated tree no longer corresponds to the
  // source in the editor.
  useEffect(() => {
    sourceRef.current = initialSource;
    setResult(null);
    setSelectedPath(null);
  }, [initialSource]);

  const errorCount = diagnostics.filter((d) => d.severity === "error").length;
  const warningCount = diagnostics.filter((d) => d.severity === "warning").length;

  async function runGenerate(): Promise<void> {
    const client = buildClientRef.current;
    if (!client) return;
    setGenerating(true);
    try {
      const res = await client.generate(sourceRef.current);
      setResult(res);
      if (res.ok && res.files.length > 0) {
        // Default to the first file — typically a top-level
        // package.json or domain/<aggregate>.ts.  Lets the user
        // immediately see something instead of an empty viewer.
        setSelectedPath((prev) => prev ?? res.files[0].path);
      } else {
        setSelectedPath(null);
      }
    } finally {
      setGenerating(false);
    }
  }

  const files: VirtualFile[] = result?.ok ? result.files : [];
  const tree = useMemo(() => buildTree(files), [files]);
  const selectedFile = useMemo(
    () => files.find((f) => f.path === selectedPath) ?? null,
    [files, selectedPath],
  );

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
            <Button
              size="xs"
              onClick={runGenerate}
              loading={generating}
              disabled={errorCount > 0}
              variant="filled"
            >
              Generate
            </Button>
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
        <Box style={{ flex: 1, minHeight: 0, display: "flex" }}>
          {/* Editor pane */}
          <Box style={{ flex: 1, minWidth: 0, borderRight: "1px solid var(--mantine-color-dark-4)" }}>
            <LoomEditor
              key={exampleId}
              initialValue={initialSource}
              onChange={(text) => {
                sourceRef.current = text;
              }}
              onDiagnosticsChange={setDiagnostics}
            />
          </Box>
          {/* Preview pane: file tree + viewer */}
          <Box style={{ width: 240, minWidth: 240, borderRight: "1px solid var(--mantine-color-dark-4)", overflow: "hidden", display: "flex", flexDirection: "column" }}>
            <Group px="sm" py={4} bg="dark.6" justify="space-between" gap="xs">
              <Text size="xs" fw={600} tt="uppercase" c="dimmed">
                Generated
              </Text>
              <Text size="xs" c="dimmed">
                {files.length} file{files.length === 1 ? "" : "s"}
              </Text>
            </Group>
            <ScrollArea style={{ flex: 1, minHeight: 0 }}>
              <FileTree
                root={tree}
                selectedPath={selectedPath}
                onSelect={setSelectedPath}
              />
            </ScrollArea>
          </Box>
          <Box style={{ flex: 1.2, minWidth: 0, display: "flex", flexDirection: "column" }}>
            <Group px="sm" py={4} bg="dark.6" justify="space-between" gap="xs">
              <Text size="xs" ff="monospace" c={selectedFile ? undefined : "dimmed"}>
                {selectedFile?.path ?? "no file selected"}
              </Text>
              <Text size="xs" c="dimmed">
                {modeLabel(result)}
              </Text>
            </Group>
            <Box style={{ flex: 1, minHeight: 0 }}>
              {selectedFile ? (
                <FileViewer
                  key={selectedFile.path}
                  path={selectedFile.path}
                  content={selectedFile.content}
                />
              ) : (
                <Box p="md">
                  <Text size="sm" c="dimmed">
                    {result?.ok === false
                      ? "Generation failed — see Problems."
                      : "Click Generate to emit a project from the source."}
                  </Text>
                </Box>
              )}
            </Box>
          </Box>
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
            Phase 2 — editor + LSP + generator
          </Text>
          <Text size="xs" c="dimmed">
            {result?.ok === false
              ? `generate: ${result.diagnostics.filter((d) => d.severity === "error").length} error(s)`
              : result?.ok
                ? `generated ${result.files.length} file(s) (${modeLabel(result)})`
                : "ready"}
          </Text>
        </Group>
      </AppShell.Footer>
    </AppShell>
  );
}
