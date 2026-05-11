import { Box } from "@mantine/core";
import { LoomEditor } from "../editor/LoomEditor";
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
export function EditorPane({ ctx, border = "none" }: Props): JSX.Element | null {
  const { lspClient, initialSource, exampleId, onSourceChange, onDiagnosticsChange, isDesktop } = ctx;
  if (!lspClient) return null;
  return (
    <Box
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        borderRight: border === "right" ? "1px solid var(--mantine-color-dark-4)" : undefined,
        borderBottom: border === "bottom" ? "1px solid var(--mantine-color-dark-4)" : undefined,
      }}
    >
      <LoomEditor
        key={exampleId}
        client={lspClient}
        initialValue={initialSource}
        isMobile={!isDesktop}
        onChange={onSourceChange}
        onDiagnosticsChange={onDiagnosticsChange}
      />
    </Box>
  );
}
