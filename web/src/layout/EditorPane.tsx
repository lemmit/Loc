import { Suspense, useEffect } from "react";
import { Box, Center, Loader } from "@mantine/core";
import { PlainEditor } from "../editor/PlainEditor";
import { LazyLoomEditor, preloadDesktopEditor } from "./lazy-panels";
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
    sourceEpoch,
    sourceFiles,
    setActiveSourcePath,
    createSourceFile,
    deleteSourceFile,
    renameSourceFile,
    deleteSourceFolder,
    emptySourceFolders,
    createEmptySourceFolder,
    sourcesWritable,
    sourcesReadOnlyReason,
    sourceError,
    clearSourceError,
    workspace,
    viewMode,
  } = ctx;
  // Warm the editor chunk the moment a desktop pane exists, rather than when
  // the language client finally resolves — the two would otherwise serialize.
  useEffect(() => {
    if (isDesktop) preloadDesktopEditor();
  }, [isDesktop]);

  // Desktop wants the full editor and therefore the language client; mobile
  // has neither, and `lspClient` is `null` there by construction (App.tsx
  // never constructs one).  A missing client on DESKTOP means the LSP is
  // still coming up — render nothing rather than an editor with no model.
  if (isDesktop && !lspClient) return null;

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
      writable={sourcesWritable}
      readOnlyReason={sourcesReadOnlyReason}
      error={sourceError}
      onDismissError={clearSourceError}
    />
  );

  // `key` semantics are identical on both editors: remount on a project
  // change so the editor reseeds from `initialSource` — the active workspace
  // (switch), whether its content has finished loading, the last-imported
  // example, the active file path, and `sourceEpoch`, which covers the
  // changes identity alone can't see (a history restore or another writer
  // replacing the active file's CONTENT under the same path).
  const remountKey = `${workspace.activeId}:${workspace.loaded ? 1 : 0}:${exampleId}:${sourceEpoch}:${activeSourcePath}`;

  const editor = (
    <Box style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
      {isDesktop && lspClient ? (
        <Suspense
          fallback={
            <Center h="100%">
              <Loader size="sm" />
            </Center>
          }
        >
          <LazyLoomEditor
            key={remountKey}
            client={lspClient}
            initialValue={initialSource}
            isMobile={false}
            handleRef={editorHandleRef}
            onChange={(v) => onSourceChange(v, "editor")}
            onDiagnosticsChange={onDiagnosticsChange}
            activePath={activeSourcePath}
            readOnly={viewMode}
          />
        </Suspense>
      ) : (
        // Mobile: a textarea, no Monaco, no language client.  Diagnostics on
        // this surface come from `generate` (the build worker already computes
        // them) rather than from a live LSP — see M-T8.15.
        <PlainEditor
          key={remountKey}
          initialValue={initialSource}
          handleRef={editorHandleRef}
          onChange={(v) => onSourceChange(v, "editor")}
          readOnly={viewMode}
        />
      )}
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
