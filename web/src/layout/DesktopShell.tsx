import { Box, Group as MGroup, ScrollArea, Text, UnstyledButton } from "@mantine/core";
import { useState, type ReactNode } from "react";
import {
  Group,
  Panel,
  Separator,
  useDefaultLayout,
  usePanelRef,
} from "react-resizable-panels";
import { EditorPane } from "./EditorPane";
import { PreviewPane } from "./PreviewPane";
import { DevToolsDock, type DockTab } from "./DevToolsDock";
import { FileTree } from "../preview/FileTree";
import { FileViewer } from "../preview/FileViewer";
import { usePersistedState } from "../util/usePersistedState";
import { modeLabel, type LayoutCtx } from "./ctx";

interface Props {
  ctx: LayoutCtx;
}

// react-resizable-panels persists layout via a storage adapter; the
// playground is client-only (Vite), so localStorage is always present.
const layoutStorage = typeof window !== "undefined" ? window.localStorage : undefined;

// Desktop layout — a VS Code-style four-region shell built on
// react-resizable-panels (v4: Group / Panel / Separator).  Every
// region stays mounted; collapsing a region drives its panel to zero
// size rather than unmounting its content.  This is what keeps the
// Preview iframe (and its service-worker runtime bridge) alive across
// UI changes — the old shell remounted Preview every time the user
// toggled away from it, tearing down the iframe and re-running the
// bundle push.
//
//   ┌────────┬────────────────────┬──────────┐
//   │ Left   │ Center             │ Right    │
//   │ Files  │ Editor / Viewer    │ Preview  │
//   ├────────┴────────────────────┴──────────┤
//   │ Bottom — Dev Tools (tabbed)             │
//   └─────────────────────────────────────────┘
export function DesktopShell({ ctx }: Props): JSX.Element {
  const { files, generateResult, reactBundleStatus, ddl, selectedFile, selectedPath, setSelectedPath, tree } = ctx;

  // Which document the center area shows.  "source" is the editable
  // .ddd; "file" is a read-only view of a generated output file picked
  // from the Explorer.  Selecting a tree node flips to "file"; the
  // Source tab flips back.  The editor stays mounted underneath either
  // way so Monaco keeps its model + undo history.
  const [centerView, setCenterView] = useState<"source" | "file">("source");
  const [dockTab, setDockTab] = usePersistedState<DockTab>("loom.desktop.dockTab", "problems");

  const leftRef = usePanelRef();
  const rightRef = usePanelRef();
  const bottomRef = usePanelRef();
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [bottomCollapsed, setBottomCollapsed] = useState(false);

  const vLayout = useDefaultLayout({ id: "loom.desktop.v.v4", storage: layoutStorage });
  const hLayout = useDefaultLayout({ id: "loom.desktop.h.v4", storage: layoutStorage });

  const onPickFile = (p: string | null): void => {
    setSelectedPath(p);
    if (p) setCenterView("file");
  };

  const previewStatus = ((): JSX.Element => {
    switch (reactBundleStatus.kind) {
      case "ok":
        return (
          <Text size="xs" c={ddl ? "green" : "dimmed"}>
            {ddl ? "live" : "needs Boot"}
          </Text>
        );
      case "fail":
        return (
          <Text size="xs" c="red" title="The React bundle failed — see the Bundler tab in Dev Tools.">
            preview bundle failed
          </Text>
        );
      case "absent":
        return (
          <Text size="xs" c="dimmed" title="This example has no React deployable — pick a system-mode example (e.g. Sales System) to enable Preview.">
            no preview
          </Text>
        );
      case "pending":
        return (
          <Text size="xs" c="dimmed">
            needs Bundle
          </Text>
        );
    }
  })();

  return (
    <Group
      orientation="vertical"
      defaultLayout={vLayout.defaultLayout}
      onLayoutChanged={vLayout.onLayoutChanged}
      style={{ flex: 1, minHeight: 0 }}
    >
      <Panel defaultSize="72%" minSize="30%">
        <Box style={{ height: "100%", display: "flex", flexDirection: "row" }}>
          {leftCollapsed && (
            <CollapsedRail label="Explorer" side="left" onExpand={() => leftRef.current?.expand()} />
          )}
          <Box style={{ flex: 1, minWidth: 0 }}>
            <Group
              orientation="horizontal"
              defaultLayout={hLayout.defaultLayout}
              onLayoutChanged={hLayout.onLayoutChanged}
              style={{ height: "100%" }}
            >
              {/* LEFT — Explorer */}
              <Panel
                panelRef={leftRef}
                collapsible
                collapsedSize="0%"
                defaultSize="18%"
                minSize="10%"
                onResize={(s) => setLeftCollapsed(s.asPercentage < 1)}
              >
                <Box style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--mantine-color-dark-7)" }}>
                  <RegionHeader
                    label="Explorer"
                    collapsed={leftCollapsed}
                    side="left"
                    onToggle={() => (leftCollapsed ? leftRef.current?.expand() : leftRef.current?.collapse())}
                  >
                    <Text size="xs" c="dimmed">
                      {files.length} file{files.length === 1 ? "" : "s"} · {modeLabel(generateResult)}
                    </Text>
                  </RegionHeader>
                  <ScrollArea style={{ flex: 1, minHeight: 0 }} data-testid="explorer-tree">
                    <FileTree root={tree} selectedPath={selectedPath} onSelect={onPickFile} />
                  </ScrollArea>
                </Box>
              </Panel>

              <Handle orientation="vertical" />

              {/* CENTER — Editor / Viewer */}
              <Panel minSize="25%">
                <Box style={{ height: "100%", display: "flex", flexDirection: "column" }}>
                  <MGroup px={4} py={2} bg="dark.6" gap={2} wrap="nowrap" style={{ borderBottom: "1px solid var(--mantine-color-dark-4)" }}>
                    <DocTab active={centerView === "source"} onClick={() => setCenterView("source")} testid="doc-tab-source">
                      main.ddd
                    </DocTab>
                    {selectedFile && (
                      <DocTab active={centerView === "file"} onClick={() => setCenterView("file")} testid="doc-tab-file">
                        {selectedFile.path}
                      </DocTab>
                    )}
                  </MGroup>
                  {/* Both surfaces mounted; toggled by display so Monaco
                      keeps its model and the viewer keeps scroll position. */}
                  <Box style={{ flex: 1, minHeight: 0, display: centerView === "source" ? "flex" : "none" }}>
                    <EditorPane ctx={ctx} />
                  </Box>
                  {selectedFile && (
                    <Box style={{ flex: 1, minHeight: 0, display: centerView === "file" ? "flex" : "none" }}>
                      <FileViewer key={selectedFile.path} path={selectedFile.path} content={selectedFile.content} />
                    </Box>
                  )}
                </Box>
              </Panel>

              <Handle orientation="vertical" />

              {/* RIGHT — Preview (always mounted) */}
              <Panel
                panelRef={rightRef}
                collapsible
                collapsedSize="0%"
                defaultSize="32%"
                minSize="15%"
                onResize={(s) => setRightCollapsed(s.asPercentage < 1)}
              >
                <Box data-testid="preview-region" style={{ height: "100%", display: "flex", flexDirection: "column" }}>
                  <RegionHeader
                    label="Preview"
                    collapsed={rightCollapsed}
                    side="right"
                    onToggle={() => (rightCollapsed ? rightRef.current?.expand() : rightRef.current?.collapse())}
                  >
                    {previewStatus}
                  </RegionHeader>
                  <PreviewPane ctx={ctx} />
                </Box>
              </Panel>
            </Group>
          </Box>
          {rightCollapsed && (
            <CollapsedRail label="Preview" side="right" onExpand={() => rightRef.current?.expand()} />
          )}
        </Box>
      </Panel>

      <Handle orientation="horizontal" />

      {/* BOTTOM — Dev Tools dock */}
      <Panel
        panelRef={bottomRef}
        collapsible
        collapsedSize="6%"
        defaultSize="26%"
        minSize="10%"
        onResize={(s) => setBottomCollapsed(s.asPercentage < 8)}
      >
        {bottomCollapsed ? (
          <MGroup px="sm" py={4} bg="dark.6" gap="xs" justify="space-between" style={{ height: "100%" }}>
            <Text size="xs" fw={600} tt="uppercase" c="dimmed">
              Dev Tools
            </Text>
            <UnstyledButton onClick={() => bottomRef.current?.expand()} data-testid="dock-toggle">
              <Text size="xs" c="dimmed">▴ expand</Text>
            </UnstyledButton>
          </MGroup>
        ) : (
          <DevToolsDock ctx={ctx} tab={dockTab} setTab={setDockTab} />
        )}
      </Panel>
    </Group>
  );
}

// Thin resize handle — a 1-px divider with the library's grab/keyboard
// behavior.  Separator must be a direct child of its Group.
function Handle({ orientation }: { orientation: "vertical" | "horizontal" }): JSX.Element {
  const vertical = orientation === "vertical";
  return (
    <Separator
      style={{
        background: "var(--mantine-color-dark-4)",
        ...(vertical ? { width: 1 } : { height: 1 }),
      }}
    />
  );
}

// Slim vertical bar shown in place of a collapsed side region so the
// user can bring it back — the panel collapses to zero size, which
// would otherwise leave no affordance to re-expand.
function CollapsedRail({
  label,
  side,
  onExpand,
}: {
  label: string;
  side: "left" | "right";
  onExpand: () => void;
}): JSX.Element {
  return (
    <UnstyledButton
      onClick={onExpand}
      data-testid={`expand-${side}`}
      title={`Show ${label}`}
      style={{
        width: 26,
        flex: "0 0 26px",
        background: "var(--mantine-color-dark-6)",
        borderRight: side === "left" ? "1px solid var(--mantine-color-dark-4)" : undefined,
        borderLeft: side === "right" ? "1px solid var(--mantine-color-dark-4)" : undefined,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text
        size="xs"
        fw={600}
        tt="uppercase"
        c="dimmed"
        style={{ writingMode: "vertical-rl", transform: "rotate(180deg)", whiteSpace: "nowrap" }}
      >
        {label}
      </Text>
    </UnstyledButton>
  );
}

function RegionHeader({
  label,
  collapsed,
  side,
  onToggle,
  children,
}: {
  label: string;
  collapsed: boolean;
  side: "left" | "right";
  onToggle: () => void;
  children?: ReactNode;
}): JSX.Element {
  // Chevron points "inward" to collapse, "outward" to expand.
  const collapseGlyph = side === "left" ? "‹" : "›";
  const expandGlyph = side === "left" ? "›" : "‹";
  return (
    <MGroup px="sm" py={4} bg="dark.6" gap="xs" justify="space-between" wrap="nowrap" style={{ borderBottom: "1px solid var(--mantine-color-dark-4)" }}>
      <MGroup gap="xs" wrap="nowrap">
        <Text size="xs" fw={600} tt="uppercase" c="dimmed">
          {label}
        </Text>
        {children}
      </MGroup>
      <UnstyledButton onClick={onToggle} data-testid={`collapse-${side}`}>
        <Text size="xs" c="dimmed">{collapsed ? expandGlyph : collapseGlyph}</Text>
      </UnstyledButton>
    </MGroup>
  );
}

function DocTab({
  active,
  onClick,
  testid,
  children,
}: {
  active: boolean;
  onClick: () => void;
  testid: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <UnstyledButton
      onClick={onClick}
      data-testid={testid}
      data-active={active || undefined}
      px="xs"
      py={2}
      style={{
        borderRadius: 4,
        maxWidth: 280,
        background: active ? "var(--mantine-color-dark-5)" : "transparent",
      }}
    >
      <Text size="xs" ff="monospace" truncate c={active ? undefined : "dimmed"}>
        {children}
      </Text>
    </UnstyledButton>
  );
}
