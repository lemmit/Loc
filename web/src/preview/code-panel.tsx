import { Box } from "@mantine/core";
import type { ComponentType } from "react";

/** What every code panel is handed: one file's path (for language choice /
 *  labelling) and its content. */
export interface CodePanelProps {
  path: string;
  content: string;
}

/** A read-only view of one file's text.  Two implementations ship:
 *  `MonacoViewer` (desktop — syntax highlighting for TS / C# / YAML / SQL /…)
 *  and {@link PlainCodePanel} (mobile).
 *
 *  This indirection exists so `preview/doc-viewers.tsx` — the markdown and
 *  mermaid viewers, which both fall back to "show me the source" — can be
 *  shared by both surfaces without dragging Monaco onto the mobile path. */
export type CodePanel = ComponentType<CodePanelProps>;

/** The mobile code panel: monospace text, no editor.
 *
 *  Monaco is 9.56 MB of eager JS and brings three worker realms; on a 375 px
 *  screen its entire value proposition (minimap, multi-cursor, hovers,
 *  completions) is unreachable, and the memory it holds is memory the PGlite
 *  boot has to find on top of.  Reading generated code needs a scrollable
 *  monospace block — that is what this is.  See M-T8.15. */
export function PlainCodePanel({ path, content }: CodePanelProps): JSX.Element {
  return (
    <Box
      component="pre"
      data-testid="file-viewer"
      data-path={path}
      p="sm"
      style={{
        width: "100%",
        height: "100%",
        margin: 0,
        overflow: "auto",
        // `pre` (not `pre-wrap`): generated code is column-aligned, and
        // horizontal scroll beats reflowing a 120-col line into ten.
        whiteSpace: "pre",
        fontFamily: "var(--mantine-font-family-monospace)",
        // 16px is the iOS threshold below which focusing/zooming kicks in and
        // the layout jumps; it is also simply readable on a phone.
        fontSize: 13,
        lineHeight: 1.5,
        // iOS momentum scrolling inside the block rather than the page.
        WebkitOverflowScrolling: "touch",
      }}
    >
      {content}
    </Box>
  );
}
