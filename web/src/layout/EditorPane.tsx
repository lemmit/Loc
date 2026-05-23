import { Box } from "@mantine/core";
import { LoomEditor } from "../editor/LoomEditor";
import { SourceFilesTree } from "./SourceFilesTree";
import { SourceFileTabs } from "./SourceFileTabs";
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
// Multi-file picker:
//   - Desktop: horizontal tab strip above the editor — fast switch
//     for 2-5 files, but starts to scroll horizontally past that.
//   - Mobile: vertical tree below a small "Files" header — thumb-
//     scannable, makes nested paths (`shared/money.ddd`) obvious in
//     a way the tabs strip's truncated names didn't.
// Both pickers source identical state from the workspace-sources
// hook (Phase 2a) and drive the same ctx callbacks; switching
// between them is purely a layout choice.
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
  } = ctx;
  if (!lspClient) return null;
  const picker = isDesktop ? (
    <SourceFileTabs
      files={sourceFiles}
      activePath={activeSourcePath}
      onSelect={setActiveSourcePath}
      onCreate={createSourceFile}
      onDelete={deleteSourceFile}
    />
  ) : (
    <SourceFilesTree
      files={sourceFiles}
      activePath={activeSourcePath}
      onSelect={setActiveSourcePath}
      onCreate={createSourceFile}
      onDelete={deleteSourceFile}
    />
  );
  return (
    <Box
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        borderRight: border === "right" ? "1px solid var(--mantine-color-dark-4)" : undefined,
        borderBottom: border === "bottom" ? "1px solid var(--mantine-color-dark-4)" : undefined,
      }}
    >
      {picker}
      <Box style={{ flex: 1, minHeight: 0 }}>
        <LoomEditor
          key={`${exampleId}::${activeSourcePath}`}
          client={lspClient}
          initialValue={initialSource}
          isMobile={!isDesktop}
          handleRef={editorHandleRef}
          onChange={(v) => onSourceChange(v, "editor")}
          onDiagnosticsChange={onDiagnosticsChange}
          activePath={activeSourcePath}
        />
      </Box>
    </Box>
  );
}
