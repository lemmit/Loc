import { Box } from "@mantine/core";
import { LoomEditor } from "../editor/LoomEditor";
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
// Multi-file (Phase 2b2): a thin Files tab strip sits above the
// editor showing every `.ddd` source in `/workspace/`.  When there
// is only main.ddd the strip still renders (single tab + "+"
// button) — keeps the layout stable and the affordance discoverable.
// Tab switches remount Monaco via `key={activeSourcePath}`; the
// existing example-switch `key={exampleId}` pattern is the
// precedent.
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
      <SourceFileTabs
        files={sourceFiles}
        activePath={activeSourcePath}
        onSelect={setActiveSourcePath}
        onCreate={createSourceFile}
        onDelete={deleteSourceFile}
      />
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
