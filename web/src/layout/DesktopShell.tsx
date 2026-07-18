import { Box, Button, Group as MGroup, SegmentedControl, Text, UnstyledButton } from "@mantine/core";
import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";

// The visual Builder pulls in craft.js + a main-thread Langium parse; lazily
// loaded so neither lands in the main chunk until the Builder tab is opened.
const BuilderPane = lazy(() => import("../builder/BuilderPane"));
// React Flow + the structural graph land only when the Model tab is opened.
const SystemBuilderPane = lazy(() => import("../builder/system/SystemBuilderPane"));
const SystemBuilderV2Pane = lazy(() => import("../builder/system-v2/SystemBuilderV2Pane"));
const RequirementsPane = lazy(() => import("../builder/requirements/RequirementsPane"));
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
import { ExplorerTree } from "../preview/ExplorerTree";
import { FileViewer } from "../preview/FileViewer";
import { SourceFilesTree } from "./SourceFilesTree";
import { usePersistedState } from "../util/usePersistedState";
import { modeLabel, type LayoutCtx } from "./ctx";

type ExplorerMode = "user" | "generated";

// The active non-source document in the center area — a file opened
// from either Explorer view.  `source` (main.ddd) is the other tab.
interface SecondaryDoc {
  source: "generated" | "workspace";
  path: string;
  content: string;
}

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
  const { files, generateResult, reactBundleStatus, ddl, setSelectedPath, tree } = ctx;

  // Center area shows either the editable source (main.ddd) or a
  // read-only view of a file opened from the Explorer.  The editor
  // stays mounted underneath so Monaco keeps its model + undo history.
  const [centerView, setCenterView] = useState<
    "source" | "secondary" | "builder" | "model" | "model-v2" | "requirements"
  >("source");
  const [secondaryDoc, setSecondaryDoc] = useState<SecondaryDoc | null>(null);
  const [explorerMode, setExplorerMode] = usePersistedState<ExplorerMode>(
    "loom.desktop.explorerMode",
    // Default to your source files — the managed "User code" tree is the
    // primary explorer now; "Generated" is for browsing emitted output.
    "user",
  );
  // Coerce tab values persisted before Problems/Generator/Bundler were
  // folded into the consolidated Output panel.
  const [dockTabRaw, setDockTab] = usePersistedState<
    DockTab | "problems" | "generator" | "bundler"
  >("loom.desktop.dockTab", "output");
  const dockTab: DockTab =
    dockTabRaw === "problems" || dockTabRaw === "generator" || dockTabRaw === "bundler"
      ? "output"
      : dockTabRaw;

  const onPickGenerated = (path: string): void => {
    const file = files.find((f) => f.path === path);
    if (!file) return;
    setSelectedPath(path);
    setSecondaryDoc({ source: "generated", path, content: file.content });
    setCenterView("secondary");
  };

  // Which row the generated Explorer view highlights as active.
  const generatedSelection =
    secondaryDoc?.source === "generated" ? secondaryDoc.path : null;

  const leftRef = usePanelRef();
  const rightRef = usePanelRef();
  const bottomRef = usePanelRef();
  // Lazy-mount-then-keep for the Builder pane: false until the user first
  // opens the Builder tab, then permanently true so the builder mounts
  // once and stays mounted via a display toggle (preserving craft state
  // + powering the live re-seed across tab switches).  Same flag pattern
  // could apply to the Model panes but isn't needed yet.
  const [builderEverMounted, setBuilderEverMounted] = useState(centerView === "builder");
  useEffect(() => {
    if (centerView === "builder") setBuilderEverMounted(true);
  }, [centerView]);

  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [bottomCollapsed, setBottomCollapsed] = useState(false);

  const vLayout = useDefaultLayout({ id: "loom.desktop.v.v4", storage: layoutStorage });
  const hLayout = useDefaultLayout({ id: "loom.desktop.h.v4", storage: layoutStorage });

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
                  <Box px="xs" py={4} style={{ borderBottom: "1px solid var(--mantine-color-dark-4)" }}>
                    <SegmentedControl
                      size="xs"
                      fullWidth
                      value={explorerMode}
                      onChange={(v) => setExplorerMode(v as ExplorerMode)}
                      data={[
                        { label: "User code", value: "user" },
                        { label: "Generated", value: "generated" },
                      ]}
                      data-testid="explorer-mode"
                    />
                  </Box>
                  {explorerMode === "generated" ? (
                    <Box style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
                      {files.length > 0 && (
                        <Box px="xs" py={4} style={{ borderBottom: "1px solid var(--mantine-color-dark-4)" }}>
                          <Button
                            size="compact-xs"
                            variant="light"
                            fullWidth
                            leftSection={<span aria-hidden>↓</span>}
                            onClick={() => ctx.runDownloadZip()}
                            data-testid="download-zip"
                          >
                            Download .zip
                          </Button>
                        </Box>
                      )}
                      <ExplorerTree
                        nodes={tree.children}
                        selectedPath={generatedSelection}
                        onActivateFile={onPickGenerated}
                        emptyHint="No files yet — click Generate."
                      />
                    </Box>
                  ) : (
                    // The single source-file explorer: create / rename /
                    // delete via right-click or the per-row kebab, and a
                    // click opens the file editable in the center editor.
                    <SourceFilesTree
                      variant="embedded"
                      files={ctx.sourceFiles}
                      activePath={ctx.activeSourcePath}
                      onSelect={(p) => {
                        ctx.setActiveSourcePath(p);
                        setCenterView("source");
                      }}
                      onCreate={ctx.createSourceFile}
                      onDelete={ctx.deleteSourceFile}
                      onRename={ctx.renameSourceFile}
                      emptyFolders={ctx.emptySourceFolders}
                      onCreateFolder={ctx.createEmptySourceFolder}
                      onDeleteFolder={ctx.deleteSourceFolder}
                    />
                  )}
                </Box>
              </Panel>

              <Handle orientation="vertical" />

              {/* CENTER — Editor / Viewer */}
              <Panel minSize="25%">
                <Box style={{ height: "100%", display: "flex", flexDirection: "column" }}>
                  <MGroup px={4} py={2} bg="dark.6" gap={2} wrap="nowrap" style={{ borderBottom: "1px solid var(--mantine-color-dark-4)" }}>
                    <SegmentedControl
                      size="xs"
                      value={centerView === "secondary" ? "" : centerView}
                      onChange={(v) =>
                        setCenterView(
                          v as "source" | "builder" | "model" | "model-v2" | "requirements",
                        )
                      }
                      data={[
                        { value: "source", label: <span data-testid="doc-tab-source">Source</span> },
                        { value: "builder", label: <span data-testid="doc-tab-builder">Builder</span> },
                        { value: "model", label: <span data-testid="doc-tab-model">Model</span> },
                        { value: "model-v2", label: <span data-testid="doc-tab-model-v2">Model v2</span> },
                        { value: "requirements", label: <span data-testid="doc-tab-requirements">Requirements</span> },
                      ]}
                    />
                    {secondaryDoc && (
                      <DocTab active={centerView === "secondary"} onClick={() => setCenterView("secondary")} testid="doc-tab-file">
                        {secondaryDoc.path}
                      </DocTab>
                    )}
                  </MGroup>
                  {/* Editor stays mounted (display toggle) so Monaco keeps
                      its model + undo history; the read-only viewer
                      remounts per file via its key. */}
                  <Box style={{ flex: 1, minHeight: 0, display: centerView === "source" ? "flex" : "none" }}>
                    <EditorPane ctx={ctx} />
                  </Box>
                  {/* Lazy-mounted on first activation, then kept mounted via
                      a display toggle (same pattern as the editor above) so
                      the builder's craft state — the current selection, the
                      open settings inputs — survives a tab switch.  This is
                      also what lets the debounced text→canvas live re-seed
                      pick up edits the user makes in the Source tab. */}
                  {builderEverMounted && (
                    <Box style={{ flex: 1, minHeight: 0, display: centerView === "builder" ? "flex" : "none" }}>
                      <Suspense fallback={<Box p="md"><Text size="sm" c="dimmed">Loading builder…</Text></Box>}>
                        <BuilderPane ctx={ctx} />
                      </Suspense>
                    </Box>
                  )}
                  {centerView === "model" && (
                    <Box style={{ flex: 1, minHeight: 0, display: "flex" }}>
                      <Suspense fallback={<Box p="md"><Text size="sm" c="dimmed">Loading model…</Text></Box>}>
                        <SystemBuilderPane ctx={ctx} />
                      </Suspense>
                    </Box>
                  )}
                  {centerView === "model-v2" && (
                    <Box style={{ flex: 1, minHeight: 0, display: "flex" }}>
                      <Suspense fallback={<Box p="md"><Text size="sm" c="dimmed">Loading model v2…</Text></Box>}>
                        <SystemBuilderV2Pane ctx={ctx} />
                      </Suspense>
                    </Box>
                  )}
                  {centerView === "requirements" && (
                    <Box style={{ flex: 1, minHeight: 0, display: "flex" }}>
                      <Suspense fallback={<Box p="md"><Text size="sm" c="dimmed">Loading requirements…</Text></Box>}>
                        <RequirementsPane ctx={ctx} />
                      </Suspense>
                    </Box>
                  )}
                  {secondaryDoc && (
                    <Box style={{ flex: 1, minHeight: 0, display: centerView === "secondary" ? "flex" : "none" }}>
                      <FileViewer key={secondaryDoc.path} path={secondaryDoc.path} content={secondaryDoc.content} files={ctx.files} />
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
