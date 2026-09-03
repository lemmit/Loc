import { Box, Button, Group as MGroup, SegmentedControl, Switch, Text, UnstyledButton } from "@mantine/core";
import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from "react";

// The visual Builder pulls in craft.js + a main-thread Langium parse; lazily
// loaded so neither lands in the main chunk until the Builder tab is opened.
const BuilderPane = lazy(() => import("../builder/BuilderPane"));
// React Flow + the structural graph land only when the Model tab is opened.
const ModelBuilderPane = lazy(() => import("../builder/system-v2/SystemBuilderV2Pane"));
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
import { DevToolsDock } from "./DevToolsDock";
import { ExplorerTree, type RowMark } from "../preview/ExplorerTree";
import { constructHue } from "../build/correspondence";
import { LazyFileViewer } from "./lazy-panels";
import { SourceFilesTree } from "./SourceFilesTree";
import { PaneErrorBoundary } from "../PaneErrorBoundary";
import { ExamplesPane } from "./ExamplesPane";
import { FirstRunCard } from "./FirstRunCard";
import { type CenterView, type ExplorerMode, modeLabel, type LayoutCtx } from "./ctx";
import { ApiPane, DiagramsPane, TraceabilityPane } from "./LoomViewsPane";
import {
  CORRESPONDENCE,
  EXPLORER_VIEW,
  nextStep,
  nextStepMid,
  OUTPUT_DIFF,
  PANE,
  STAGE,
} from "./vocabulary";

// The Explorer switcher, in the order a reader walks them: your source, the
// emitted tree, the three `.loom/`-bundle views over it (M-T8.20), then the
// examples syllabus.
const EXPLORER_TABS: readonly ExplorerMode[] = [
  "user",
  "generated",
  "diagrams",
  "api",
  "traceability",
  "examples",
];

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
  // Both lifted to the ctx (App) in M-T8.18 so the palette, the Problems
  // rows and the panes' *Go to line N* can switch them.
  const { centerView, setCenterView, explorerMode, setExplorerMode, firstRunVisible } = ctx;
  const [secondaryDoc, setSecondaryDoc] = useState<SecondaryDoc | null>(null);
  // Dock-tab state lives on the ctx now (lifted to App), so a panel inside
  // the dock — History's "diff as baseline" — can reveal a sibling tab
  // (Migrations) with context.  The legacy-alias coercion moved to App.
  const { dockTab, setDockTab } = ctx;

  // Per-row decoration for the generated tree: what CHANGED in this generate
  // (slice 2) and what the declaration under the cursor PRODUCED (slice 3).
  // One map so a row can carry both — a file can be freshly changed AND part
  // of the hovered declaration's output, and that combination is exactly what
  // a reader wants to see.
  const { outputDiff, correspondence } = ctx;
  const rowMarks = useMemo(() => {
    const out = new Map<string, RowMark>();
    for (const [path, status] of outputDiff.byPath) {
      // A removed file has no row to mark — it is gone from the tree.  The
      // count still reaches the reader through the banner's summary.
      if (status === "removed") continue;
      out.set(path, { status });
    }
    const hue = correspondence?.construct ? constructHue(correspondence.construct) : undefined;
    for (const file of correspondence?.files ?? []) {
      out.set(file.file, { ...out.get(file.file), corresponds: true, hue });
    }
    return out;
  }, [outputDiff, correspondence]);

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
            {ddl ? "live" : `needs ${STAGE.boot}`}
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
            needs {STAGE.bundle}
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
                    label={PANE.explorer}
                    collapsed={leftCollapsed}
                    side="left"
                    onToggle={() => (leftCollapsed ? leftRef.current?.expand() : leftRef.current?.collapse())}
                  >
                    <Text size="xs" c="dimmed">
                      {files.length} file{files.length === 1 ? "" : "s"} · {modeLabel(generateResult)}
                    </Text>
                  </RegionHeader>
                  {/* Six views in an 18 % column: a SegmentedControl would
                      squeeze each label to two characters, so the switcher is
                      a wrapping row of buttons instead.  It keeps the
                      `explorer-mode` test id on the container and each label
                      as plain text, which is what the ~6 specs that click
                      `getByTestId("explorer-mode").getByText("Generated")`
                      match on. */}
                  <Box
                    px={4}
                    py={4}
                    style={{ borderBottom: "1px solid var(--mantine-color-dark-4)" }}
                    data-testid="explorer-mode"
                  >
                    <Box style={{ display: "flex", flexWrap: "wrap", gap: 2 }}>
                      {EXPLORER_TABS.map((tab) => (
                        <UnstyledButton
                          key={tab}
                          onClick={() => setExplorerMode(tab)}
                          data-testid={`explorer-mode-${tab}`}
                          data-active={explorerMode === tab || undefined}
                          px={8}
                          py={3}
                          style={{
                            borderRadius: 4,
                            background:
                              explorerMode === tab
                                ? "var(--mantine-color-dark-5)"
                                : "transparent",
                          }}
                        >
                          <Text
                            size="xs"
                            fw={explorerMode === tab ? 600 : 400}
                            c={explorerMode === tab ? undefined : "dimmed"}
                          >
                            {EXPLORER_VIEW[tab]}
                          </Text>
                        </UnstyledButton>
                      ))}
                    </Box>
                  </Box>
                  {explorerMode === "diagrams" ? (
                    <DiagramsPane
                      files={files}
                      activePath={generatedSelection}
                      isDesktop={ctx.isDesktop}
                      onOpen={(doc) => onPickGenerated(doc.path)}
                    />
                  ) : explorerMode === "traceability" ? (
                    <TraceabilityPane
                      files={files}
                      activePath={generatedSelection}
                      isDesktop={ctx.isDesktop}
                      onOpen={(doc) => onPickGenerated(doc.path)}
                    />
                  ) : explorerMode === "api" ? (
                    <ApiPane ctx={ctx} />
                  ) : explorerMode === "examples" ? (
                    // Sample systems by concept, each opening in a NEW
                    // workspace (M-T8.18, audit H5).
                    <ExamplesPane ctx={ctx} />
                  ) : explorerMode === "generated" ? (
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
                      <ExplorerBanner ctx={ctx} />
                      <ExplorerTree
                        nodes={tree.children}
                        selectedPath={generatedSelection}
                        onActivateFile={onPickGenerated}
                        emptyHint={`No files yet — ${nextStepMid("generate", true)}.`}
                        marks={rowMarks}
                        onHoverFile={(path) =>
                          ctx.setReverseHover(
                            path === null ? null : { file: path, line: 1 },
                          )
                        }
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
                      writable={ctx.sourcesWritable}
                      readOnlyReason={ctx.sourcesReadOnlyReason}
                      error={ctx.sourceError}
                      onDismissError={ctx.clearSourceError}
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
                      onChange={(v) => setCenterView(v as CenterView)}
                      data={[
                        { value: "source", label: <span data-testid="doc-tab-source">{PANE.source}</span> },
                        { value: "builder", label: <span data-testid="doc-tab-builder">{PANE.builder}</span> },
                        { value: "model", label: <span data-testid="doc-tab-model">{PANE.model}</span> },
                        { value: "requirements", label: <span data-testid="doc-tab-requirements">{PANE.requirements}</span> },
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
                  <Box style={{ flex: 1, minHeight: 0, display: centerView === "source" ? "flex" : "none", position: "relative" }}>
                    <EditorPane ctx={ctx} />
                    {/* Three doors over the never-edited editor (M-T8.18). */}
                    {firstRunVisible && <FirstRunCard ctx={ctx} />}
                  </Box>
                  {/* Lazy-mounted on first activation, then kept mounted via
                      a display toggle (same pattern as the editor above) so
                      the builder's craft state — the current selection, the
                      open settings inputs — survives a tab switch.  This is
                      also what lets the debounced text→canvas live re-seed
                      pick up edits the user makes in the Source tab. */}
                  {builderEverMounted && (
                    <Box style={{ flex: 1, minHeight: 0, display: centerView === "builder" ? "flex" : "none" }}>
                      {/* The builder stays mounted in the background and
                          re-parses the live source, so a throw here would
                          otherwise white-screen the app while the user is
                          typing in the Source tab. */}
                      <PaneErrorBoundary name="Builder">
                        <Suspense fallback={<Box p="md"><Text size="sm" c="dimmed">Loading builder…</Text></Box>}>
                          <BuilderPane ctx={ctx} />
                        </Suspense>
                      </PaneErrorBoundary>
                    </Box>
                  )}
                  {centerView === "model" && (
                    <Box style={{ flex: 1, minHeight: 0, display: "flex" }}>
                      <PaneErrorBoundary name="Model">
                        <Suspense fallback={<Box p="md"><Text size="sm" c="dimmed">Loading model…</Text></Box>}>
                          <ModelBuilderPane ctx={ctx} />
                        </Suspense>
                      </PaneErrorBoundary>
                    </Box>
                  )}
                  {centerView === "requirements" && (
                    <Box style={{ flex: 1, minHeight: 0, display: "flex" }}>
                      <PaneErrorBoundary name="Requirements">
                        <Suspense fallback={<Box p="md"><Text size="sm" c="dimmed">Loading requirements…</Text></Box>}>
                          <RequirementsPane ctx={ctx} />
                        </Suspense>
                      </PaneErrorBoundary>
                    </Box>
                  )}
                  {secondaryDoc && (
                    <Box style={{ flex: 1, minHeight: 0, display: centerView === "secondary" ? "flex" : "none" }}>
                      <Suspense fallback={<Box p="md"><Text size="sm" c="dimmed">Loading viewer…</Text></Box>}>
                        <LazyFileViewer key={secondaryDoc.path} path={secondaryDoc.path} content={secondaryDoc.content} />
                      </Suspense>
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
                    label={PANE.preview}
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
              {PANE.devTools}
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

/** The one line above the generated tree.
 *
 *  It answers whichever question is live: while a declaration is hovered in
 *  the editor it names that declaration and how many files it produced (the
 *  correspondence banner); otherwise it summarises what the last generate
 *  changed.  Both are transient state the tree rows also carry — the banner
 *  exists because a virtualized tree only mounts the rows in view, so a match
 *  (or a change) further down would otherwise be invisible. */
function ExplorerBanner({ ctx }: { ctx: LayoutCtx }): JSX.Element | null {
  const { correspondence, outputDiff, colourMap, setColourMap } = ctx;
  const hasDiff = outputDiff.any;
  if (!correspondence && !hasDiff) {
    return (
      <Box px="xs" py={2} style={{ borderBottom: "1px solid var(--mantine-color-dark-4)" }}>
        <ColourMapSwitch on={colourMap} onChange={setColourMap} />
      </Box>
    );
  }
  return (
    <Box
      px="xs"
      py={2}
      style={{ borderBottom: "1px solid var(--mantine-color-dark-4)" }}
      data-testid="explorer-banner"
    >
      {correspondence ? (
        <Text
          size="xs"
          truncate
          data-testid="correspondence-banner"
          data-files={correspondence.files.length}
          data-construct={correspondence.construct}
          style={{
            color: correspondence.construct
              ? `hsl(${constructHue(correspondence.construct)}, 70%, 70%)`
              : undefined,
          }}
        >
          {CORRESPONDENCE.from(correspondence.construct ?? "?", correspondence.files.length)}
        </Text>
      ) : (
        <Text size="xs" c="dimmed" truncate data-testid="output-diff-summary">
          {OUTPUT_DIFF.summary(outputDiff.added, outputDiff.changed, outputDiff.removed)}{" "}
          {OUTPUT_DIFF.sinceLast}
        </Text>
      )}
      <ColourMapSwitch on={colourMap} onChange={setColourMap} />
    </Box>
  );
}

function ColourMapSwitch({
  on,
  onChange,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
}): JSX.Element {
  return (
    <Switch
      size="xs"
      checked={on}
      onChange={(e) => onChange(e.currentTarget.checked)}
      label={CORRESPONDENCE.colourMap}
      title={CORRESPONDENCE.colourMapHint}
      data-testid="colour-map-toggle"
      styles={{ label: { fontSize: 11, color: "var(--mantine-color-dimmed)" } }}
    />
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
