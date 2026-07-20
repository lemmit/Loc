import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import * as monaco from "monaco-editor";
import { ActionIcon, Box, Group, SegmentedControl, Text, TypographyStylesProvider } from "@mantine/core";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { installMonacoEnvironment } from "../editor/monaco-env";
import { languageFromPath } from "./file-tree";
import type { VirtualFile } from "../build/protocol";
import type { C4Spec, LayoutedC4Model } from "./likec4-model";
import { buildLayoutedModel } from "./likec4-model";
import { reloadOnceForStaleChunks } from "../ErrorBoundary";

installMonacoEnvironment();

interface FileViewerProps {
  path: string;
  content: string;
  // The full generated file set, so the `.c4` viewer can find its sibling
  // `.c4.json` model projection.  Absent (e.g. the secondary pane) → the
  // `.c4` falls back to the source view.
  files?: VirtualFile[];
}

// Dispatcher: Mermaid sources (`.mmd`) get a rendered SVG preview; LikeC4
// (`.c4`) gets an interactive diagram rebuilt from its sibling `.c4.json`;
// Markdown (`.md`) gets a rendered HTML preview with a source toggle;
// everything else uses the read-only Monaco viewer.  Branching here (rather
// than with a conditional hook inside one component) keeps each viewer's
// hooks unconditional.
export function FileViewer({ path, content, files }: FileViewerProps): JSX.Element {
  if (path.endsWith(".mmd")) return <MermaidViewer content={content} />;
  if (path.endsWith(".md") || path.endsWith(".markdown")) {
    return <MarkdownViewer path={path} content={content} />;
  }
  if (path.endsWith(".c4")) {
    const spec = files?.find((f) => f.path === `${path}.json`);
    if (spec) return <LikeC4Viewer specJson={spec.content} source={content} />;
  }
  return <MonacoViewer path={path} content={content} />;
}

// Markdown preview with a Preview / Source toggle.  Preview renders the
// document to sanitized HTML (marked → DOMPurify) inside Mantine's
// TypographyStylesProvider so headings, lists, tables and code blocks pick up
// theme-consistent typography.  Source drops to the Monaco viewer, which now
// has a real markdown grammar (registered in `loom-services.ts`).
function MarkdownViewer({ path, content }: { path: string; content: string }): JSX.Element {
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
          <MonacoViewer path={path} content={content} />
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

// The LikeC4 React canvas (provider + view) is large and pulls its own
// runtime, so it's lazily imported the first time a `.c4` diagram is shown.
const LikeC4Canvas = lazy(async () => {
  const { LikeC4ModelProvider, LikeC4View } = await import("likec4/react");
  return {
    default: ({ model, viewId }: { model: LayoutedC4Model; viewId: string }) => (
      <LikeC4ModelProvider likec4model={model}>
        <LikeC4View
          viewId={viewId as never}
          colorScheme="dark"
          background="dots"
          controls
          enableFocusMode
          enableElementDetails
          enableRelationshipDetails
          enableRelationshipBrowser
        />
      </LikeC4ModelProvider>
    ),
  };
});

// LikeC4 architecture preview with a Diagram / Source toggle.  The diagram is
// rebuilt from the sidecar `.c4.json` (the playground can't run LikeC4's
// Langium parser in-browser) and laid out with Graphviz WASM, so the build is
// async and can fail — we surface errors and let the user drop to source.
function LikeC4Viewer({ specJson, source }: { specJson: string; source: string }): JSX.Element {
  const [view, setView] = useState<"diagram" | "source">("diagram");
  const [model, setModel] = useState<LayoutedC4Model | null>(null);
  const [viewId, setViewId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setModel(null);
    setError(null);
    void (async () => {
      try {
        const spec = JSON.parse(specJson) as C4Spec;
        const built = await buildLayoutedModel(spec);
        if (!cancelled) {
          setViewId(spec.viewId);
          setModel(built);
        }
      } catch (err) {
        if (reloadOnceForStaleChunks(err)) return;
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [specJson]);

  return (
    <Box style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column" }}>
      <Group px="xs" py={4} bg="dark.6" gap="xs" style={{ borderBottom: "1px solid var(--mantine-color-dark-4)" }}>
        <SegmentedControl
          size="xs"
          value={view}
          onChange={(v) => setView(v as "diagram" | "source")}
          data={[
            { label: "Diagram", value: "diagram" },
            { label: "Source", value: "source" },
          ]}
          data-testid="c4-view"
        />
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
          {source}
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
      ) : model ? (
        <Box data-testid="c4-diagram" style={{ flex: 1, minHeight: 0, position: "relative" }}>
          <Suspense
            fallback={
              <Text size="sm" c="dimmed" p="sm">
                Rendering…
              </Text>
            }
          >
            <LikeC4Canvas model={model} viewId={viewId} />
          </Suspense>
        </Box>
      ) : (
        <Text size="sm" c="dimmed" p="sm">
          Rendering…
        </Text>
      )}
    </Box>
  );
}

// Read-only Monaco panel for viewing a generated file.  We reuse
// Monaco (already paid for in bundle size) so syntax highlighting
// for TS / JSON / YAML / SQL / etc. comes for free.
function MonacoViewer({ path, content }: FileViewerProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const editor = monaco.editor.create(containerRef.current, {
      value: content,
      language: languageFromPath(path),
      theme: "vs-dark",
      automaticLayout: true,
      readOnly: true,
      minimap: { enabled: false },
      fontSize: 12,
      scrollBeyondLastLine: false,
    });
    editorRef.current = editor;
    return () => {
      editorRef.current = null;
      editor.dispose();
    };
    // Single-mount: subsequent path / content changes are pushed
    // imperatively below to avoid Monaco re-create churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const model = editor.getModel();
    if (!model) return;
    if (model.getValue() !== content) model.setValue(content);
    monaco.editor.setModelLanguage(model, languageFromPath(path));
  }, [path, content]);

  return <div ref={containerRef} style={{ width: "100%", height: "100%" }} />;
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
function MermaidViewer({ content }: { content: string }): JSX.Element {
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
