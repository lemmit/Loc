import { useEffect, useMemo, useRef, useState } from "react";
import { ActionIcon, Box, Group, SegmentedControl, Text, TypographyStylesProvider } from "@mantine/core";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { reloadOnceForStaleChunks } from "../ErrorBoundary";
import type { CodePanel, CodePanelProps } from "./code-panel";

// The two DOCUMENT viewers — markdown and mermaid — plus the dispatcher that
// chooses between them and a plain code panel.  Deliberately free of any
// `monaco-editor` import: both shells render these, and mobile must be able to
// reach them without pulling 9.56 MB of editor onto its graph (M-T8.15).  The
// code panel itself is injected, which is the whole reason this file exists
// separately from `FileViewer.tsx`.

/** Path → viewer.  Mermaid sources (`.mmd`) get a rendered SVG preview;
 *  Markdown (`.md`) gets rendered HTML with a source toggle; everything else
 *  goes to the supplied code panel.  Branching here (rather than with a
 *  conditional hook inside one component) keeps each viewer's hooks
 *  unconditional. */
export function DocOrCode({
  path,
  content,
  CodePanel,
}: CodePanelProps & { CodePanel: CodePanel }): JSX.Element {
  if (path.endsWith(".mmd")) return <MermaidViewer content={content} />;
  if (path.endsWith(".md") || path.endsWith(".markdown")) {
    return <MarkdownViewer path={path} content={content} CodePanel={CodePanel} />;
  }
  return <CodePanel path={path} content={content} />;
}

// Markdown preview with a Preview / Source toggle.  Preview renders the
// document to sanitized HTML (marked → DOMPurify) inside Mantine's
// TypographyStylesProvider so headings, lists, tables and code blocks pick up
// theme-consistent typography.  Source drops to the Monaco viewer, which now
// has a real markdown grammar (registered in `loom-services.ts`).
export function MarkdownViewer({
  path,
  content,
  CodePanel,
}: CodePanelProps & { CodePanel: CodePanel }): JSX.Element {
  const [view, setView] = useState<"preview" | "source">("preview");
  const html = useMemo(() => {
    // `marked.parse` is synchronous with the default (non-async) options.
    const raw = marked.parse(content, { async: false, gfm: true }) as string;
    return DOMPurify.sanitize(raw);
  }, [content]);

  return (
    <Box style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column" }}>
      <Group px="xs" py={4} bg="dark.6" gap="xs" style={{ borderBottom: "1px solid var(--mantine-color-dark-4)" }}>
        <SegmentedControl
          size="xs"
          value={view}
          onChange={(v) => setView(v as "preview" | "source")}
          data={[
            { label: "Preview", value: "preview" },
            { label: "Source", value: "source" },
          ]}
          data-testid="md-view"
        />
      </Group>
      {view === "source" ? (
        <Box style={{ flex: 1, minHeight: 0 }}>
          <CodePanel path={path} content={content} />
        </Box>
      ) : (
        <TypographyStylesProvider
          p="md"
          style={{ flex: 1, minHeight: 0, overflow: "auto" }}
          data-testid="md-preview"
        >
          {/* marked output sanitised by DOMPurify above. */}
          <div dangerouslySetInnerHTML={{ __html: html }} />
        </TypographyStylesProvider>
      )}
    </Box>
  );
}


let mermaidReady: Promise<typeof import("mermaid").default> | null = null;
// Lazy-load + initialise Mermaid once, on first `.mmd` view, so the
// (large) library stays out of the main bundle until it's needed.
function loadMermaid(): Promise<typeof import("mermaid").default> {
  if (!mermaidReady) {
    mermaidReady = import("mermaid").then(({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict" });
      return mermaid;
    });
  }
  return mermaidReady;
}

// Monotonic id source — `mermaid.render` requires a DOM id that is
// unique per call.  Reusing one (e.g. a stable ref) collides with the
// SVG already in the document when toggling Source→Diagram, which made
// the re-render come back empty until the component remounted.
let mermaidRenderSeq = 0;

const ZOOM_STEP = 1.2;
const ZOOM_MIN = 0.2;
const ZOOM_MAX = 8;

// Mermaid preview with a Diagram / Source toggle and pan + zoom.
// Rendering can fail on malformed input, so we surface the error and
// let the user drop to the raw source.
export function MermaidViewer({ content }: { content: string }): JSX.Element {
  const [view, setView] = useState<"diagram" | "source">("diagram");
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Viewport transform.  Pan stays interactive after zooming so the
  // user can drag to the region they care about.
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  // Reset the viewport whenever the document changes so each diagram
  // opens fitted at the top-left rather than wherever the last one was.
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [content]);

  useEffect(() => {
    if (view !== "diagram") return;
    let cancelled = false;
    setError(null);
    void (async () => {
      try {
        const mermaid = await loadMermaid();
        const id = `mmd-${mermaidRenderSeq++}`;
        const { svg } = await mermaid.render(id, content);
        if (!cancelled) setSvg(svg);
      } catch (err) {
        // Mermaid lazy-loads one chunk per diagram type; on a stale tab
        // after a redeploy those chunk URLs 404 and surface here as
        // "Failed to fetch dynamically imported module".  Trigger the
        // one-shot reload so the user picks up the current asset hashes.
        if (reloadOnceForStaleChunks(err)) return;
        if (!cancelled) {
          setSvg(null);
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [content, view]);

  const zoomBy = (factor: number): void =>
    setZoom((z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z * factor)));
  const resetView = (): void => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const onPointerDown = (e: React.PointerEvent): void => {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, ox: pan.x, oy: pan.y };
  };
  const onPointerMove = (e: React.PointerEvent): void => {
    const d = dragRef.current;
    if (!d) return;
    setPan({ x: d.ox + (e.clientX - d.x), y: d.oy + (e.clientY - d.y) });
  };
  const endDrag = (e: React.PointerEvent): void => {
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };
  const onWheel = (e: React.WheelEvent): void => {
    // Plain wheel zooms; the user then drags to reposition.
    zoomBy(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
  };

  return (
    <Box style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column" }}>
      <Group px="xs" py={4} bg="dark.6" gap="xs" justify="space-between" wrap="nowrap" style={{ borderBottom: "1px solid var(--mantine-color-dark-4)" }}>
        <SegmentedControl
          size="xs"
          value={view}
          onChange={(v) => setView(v as "diagram" | "source")}
          data={[
            { label: "Diagram", value: "diagram" },
            { label: "Source", value: "source" },
          ]}
          data-testid="mmd-view"
        />
        {view === "diagram" && svg && !error && (
          <Group gap={4} wrap="nowrap">
            <ActionIcon size="sm" variant="default" onClick={() => zoomBy(1 / ZOOM_STEP)} data-testid="mmd-zoom-out" aria-label="Zoom out">
              −
            </ActionIcon>
            <Text size="xs" c="dimmed" w={40} ta="center" data-testid="mmd-zoom-level">
              {Math.round(zoom * 100)}%
            </Text>
            <ActionIcon size="sm" variant="default" onClick={() => zoomBy(ZOOM_STEP)} data-testid="mmd-zoom-in" aria-label="Zoom in">
              +
            </ActionIcon>
            <ActionIcon size="sm" variant="default" onClick={resetView} data-testid="mmd-zoom-reset" aria-label="Reset view">
              ⤢
            </ActionIcon>
          </Group>
        )}
      </Group>
      {view === "source" ? (
        <Box
          component="pre"
          p="sm"
          style={{
            flex: 1,
            minHeight: 0,
            overflow: "auto",
            margin: 0,
            fontFamily: "var(--mantine-font-family-monospace)",
            fontSize: 12,
            whiteSpace: "pre",
          }}
        >
          {content}
        </Box>
      ) : error ? (
        <Box p="sm" style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
          <Text size="sm" c="red" mb="xs">
            Could not render diagram.
          </Text>
          <Text size="xs" ff="monospace" c="dimmed" style={{ whiteSpace: "pre-wrap" }}>
            {error}
          </Text>
        </Box>
      ) : svg ? (
        <Box
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onWheel={onWheel}
          style={{
            flex: 1,
            minHeight: 0,
            overflow: "hidden",
            cursor: dragRef.current ? "grabbing" : "grab",
            touchAction: "none",
          }}
        >
          <Box
            data-testid="mmd-svg"
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transformOrigin: "0 0",
              width: "fit-content",
              padding: 16,
            }}
            // Mermaid output is sanitised by its own strict securityLevel.
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </Box>
      ) : (
        <Text size="sm" c="dimmed" p="sm">
          Rendering…
        </Text>
      )}
    </Box>
  );
}
