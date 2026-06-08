import { Box } from "@mantine/core";
import { LoomEditor } from "../editor/LoomEditor";
import { SourceFilesTree } from "./SourceFilesTree";
import type { LayoutCtx } from "./ctx";

interface Props {
  ctx: LayoutCtx;
  // Bordered = desktop, where the editor sits beside the right pane
  // and wants a right border as visual divider.  Mobile fullscreen
  // skips the border (the bottom-tab bar is the visual divider).
  border?: "right" | "bottom" | "none";
}

// Thin wrapper that owns the Monaco container's outer Box.  The
// LoomEditor itself fills 100% × 100% of this Box (its `automaticLayout`
// ResizeObserver needs a parent with definite size on first paint —
// flex + minHeight: 0 satisfies that on every shell).
//
// File explorer (`SourceFilesTree`):
//   - Desktop: a persistent left sidebar beside the editor — file
//     management is right-click → context menu (New / Rename / Delete).
//   - Mobile: a collapsible tree above the editor (closed by default so
//     the editor keeps the viewport); same context menu via long-press,
//     plus a header "+" and per-row delete for touch.
export function EditorPane({ ctx, border = "none" }: Props): JSX.Element | null {
  const {
    lspClient,
    initialSource,
    exampleId,
    onSourceChange,
    onDiagnosticsChange,
    isDesktop,
    editorHandleRef,
    activeSourcePath,
    sourceFiles,
    setActiveSourcePath,
    createSourceFile,
    deleteSourceFile,
    renameSourceFile,
    deleteSourceFolder,
    emptySourceFolders,
    createEmptySourceFolder,
    workspace,
  } = ctx;
  if (!lspClient) return null;

  // Mobile only: a collapsible source-file tree above the editor.  On
  // desktop the single file explorer lives in the left Explorer panel
  // (DesktopShell), so the editor pane is just the editor — no second
  // tree of the same files.
  const explorer = isDesktop ? null : (
    <SourceFilesTree
      variant="accordion"
      files={sourceFiles}
      activePath={activeSourcePath}
      onSelect={setActiveSourcePath}
      onCreate={createSourceFile}
      onDelete={deleteSourceFile}
      onRename={renameSourceFile}
      emptyFolders={emptySourceFolders}
      onCreateFolder={createEmptySourceFolder}
      onDeleteFolder={deleteSourceFolder}
    />
  );

  const editor = (
    <Box style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
      <LoomEditor
        // Remount on a project change so the editor reseeds from
        // `initialSource`: the active workspace (switch), whether its
        // content has finished loading, the last-imported example, and
        // the active file path.
        key={`${workspace.activeId}:${workspace.loaded ? 1 : 0}:${exampleId}::${activeSourcePath}`}
        client={lspClient}
        initialValue={initialSource}
        isMobile={!isDesktop}
        handleRef={editorHandleRef}
        onChange={(v) => onSourceChange(v, "editor")}
        onDiagnosticsChange={onDiagnosticsChange}
        activePath={activeSourcePath}
      />
    </Box>
  );

  return (
    <Box
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        display: "flex",
        // Mobile stacks the accordion explorer above the editor; desktop
        // has no in-pane explorer (it's the left panel), so this is just
        // the editor.
        flexDirection: "column",
        borderRight: border === "right" ? "1px solid var(--mantine-color-dark-4)" : undefined,
        borderBottom: border === "bottom" ? "1px solid var(--mantine-color-dark-4)" : undefined,
      }}
    >
      {explorer}
      {editor}
    </Box>
  );
}
