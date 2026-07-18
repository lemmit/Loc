import { Box, Button, Group, ScrollArea, Stack, Text } from "@mantine/core";
import { FileTree } from "../preview/FileTree";
import { FileViewer } from "../preview/FileViewer";
import type { LayoutCtx } from "./ctx";

interface Props {
  ctx: LayoutCtx;
}

// File-tree sidebar (desktop) + file viewer + bundle-error drawer.
// Mobile branch swaps the sidebar for a native <details> dropdown so
// the viewer keeps the screen real estate by default.
export function FilesPane({ ctx }: Props): JSX.Element {
  const {
    isDesktop,
    tree,
    files,
    selectedFile,
    selectedPath,
    setSelectedPath,
    generateResult,
    honoBundleResult,
    reactBundleResult,
    runDownloadZip,
  } = ctx;

  const treeNode = (
    <FileTree
      root={tree}
      selectedPath={selectedPath}
      onSelect={setSelectedPath}
    />
  );

  return (
    <Box style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: isDesktop ? "row" : "column" }}>
      {isDesktop ? (
        <Box
          style={{
            width: 240,
            minWidth: 240,
            borderRight: "1px solid var(--mantine-color-dark-4)",
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <ScrollArea style={{ flex: 1, minHeight: 0 }}>{treeNode}</ScrollArea>
        </Box>
      ) : (
        // Mobile: collapsible <details> above the viewer.  Native
        // HTML — accessible, keyboard-friendly, no Mantine dependency
        // for a one-off toggle.  Closed by default so the viewer
        // keeps the screen real estate; tap "Files (N)" to pick a
        // file.  We auto-close after a pick so the viewer is
        // immediately readable.
        <Box
          component="details"
          data-testid="file-tree-mobile"
          style={{
            borderBottom: "1px solid var(--mantine-color-dark-4)",
            background: "var(--mantine-color-dark-7)",
            flexShrink: 0,
          }}
        >
          <Box
            component="summary"
            px="sm"
            py={10}
            style={{
              cursor: "pointer",
              fontSize: 14,
              fontWeight: 600,
              color: "var(--mantine-color-dimmed)",
              userSelect: "none",
              minHeight: 44,
              display: "flex",
              alignItems: "center",
            }}
          >
            Files ({files.length})
          </Box>
          <Box style={{ maxHeight: 240, overflow: "auto" }}>
            <FileTree
              root={tree}
              selectedPath={selectedPath}
              onSelect={(p) => {
                setSelectedPath(p);
                const root = document.querySelector(
                  '[data-testid="file-tree-mobile"]',
                ) as HTMLDetailsElement | null;
                if (root) root.open = false;
              }}
            />
          </Box>
        </Box>
      )}
      <Box style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <Group px="sm" py={4} bg="dark.7" gap="xs" wrap="nowrap" justify="space-between">
          <Text size="xs" ff="monospace" c={selectedFile ? undefined : "dimmed"} truncate>
            {selectedFile?.path ?? "no file selected"}
          </Text>
          {/* Mobile counterpart of DesktopShell's Download .zip — the bridge
              out of the browser for the backends/frontends the preview can't
              boot.  Shown once there's a generated tree to export. */}
          {files.length > 0 && (
            <Button
              size="compact-xs"
              variant="light"
              leftSection={<span aria-hidden>↓</span>}
              onClick={() => runDownloadZip()}
              style={{ flexShrink: 0 }}
              data-testid="download-zip-mobile"
            >
              .zip
            </Button>
          )}
        </Group>
        {/* Monaco's `automaticLayout` ResizeObserver needs a parent
            with a definite 2D size on first paint, otherwise it
            latches at 0×0.  `display: flex` here promotes the
            FileViewer's `<div height: 100% width: 100%>` to a flex
            item, same as the LoomEditor wrapper. */}
        <Box style={{ flex: 1, minHeight: 0, display: "flex" }}>
          {selectedFile ? (
            <FileViewer
              key={selectedFile.path}
              path={selectedFile.path}
              content={selectedFile.content}
              files={files}
            />
          ) : (
            <Box p="md">
              <Text size="sm" c="dimmed">
                {generateResult?.ok === false
                  ? "Generation failed — see Problems."
                  : "Click Generate to emit a project from the source."}
              </Text>
            </Box>
          )}
        </Box>
        {((honoBundleResult && !honoBundleResult.ok) ||
          (reactBundleResult && !reactBundleResult.ok)) && (
          <Box
            p="xs"
            style={{
              borderTop: "1px solid var(--mantine-color-dark-4)",
              background: "var(--mantine-color-dark-7)",
              maxHeight: 200,
              overflow: "auto",
            }}
          >
            {honoBundleResult && !honoBundleResult.ok && (
              <>
                <Text size="xs" fw={600} tt="uppercase" c="red" mb={4}>
                  Hono bundle errors
                </Text>
                <Stack gap={2} mb={reactBundleResult && !reactBundleResult.ok ? "sm" : 0}>
                  {honoBundleResult.diagnostics.map((d, i) => (
                    <Text key={i} size="xs" ff="monospace" style={{ whiteSpace: "pre-wrap" }}>
                      {d.file ? `${d.file}:${d.line ?? "?"}: ` : ""}
                      {d.message}
                    </Text>
                  ))}
                </Stack>
              </>
            )}
            {reactBundleResult && !reactBundleResult.ok && (
              <>
                <Text size="xs" fw={600} tt="uppercase" c="red" mb={4}>
                  React bundle errors
                </Text>
                <Stack gap={2}>
                  {reactBundleResult.diagnostics.map((d, i) => (
                    <Text key={i} size="xs" ff="monospace" style={{ whiteSpace: "pre-wrap" }}>
                      {d.file ? `${d.file}:${d.line ?? "?"}: ` : ""}
                      {d.message}
                    </Text>
                  ))}
                </Stack>
              </>
            )}
          </Box>
        )}
      </Box>
    </Box>
  );
}
