import { useEffect, useRef, useState } from "react";
import * as monaco from "monaco-editor";
import { Box, Group, SegmentedControl, Text } from "@mantine/core";
import { installMonacoEnvironment } from "../editor/monaco-env";
import { languageFromPath } from "./file-tree";

installMonacoEnvironment();

interface FileViewerProps {
  path: string;
  content: string;
}

// Dispatcher: Mermaid sources (`.mmd`) get a rendered SVG preview;
// everything else uses the read-only Monaco viewer.  Branching here
// (rather than with a conditional hook inside one component) keeps each
// viewer's hooks unconditional.
export function FileViewer({ path, content }: FileViewerProps): JSX.Element {
  if (path.endsWith(".mmd")) return <MermaidViewer content={content} />;
  return <MonacoViewer path={path} content={content} />;
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

// Mermaid preview with a Diagram / Source toggle.  Rendering can fail
// on malformed input, so we surface the error and let the user drop to
// the raw source.
function MermaidViewer({ content }: { content: string }): JSX.Element {
  const [view, setView] = useState<"diagram" | "source">("diagram");
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const idRef = useRef(`mmd-${Math.random().toString(36).slice(2)}`);

  useEffect(() => {
    if (view !== "diagram") return;
    let cancelled = false;
    setError(null);
    void (async () => {
      try {
        const mermaid = await loadMermaid();
        const { svg } = await mermaid.render(idRef.current, content);
        if (!cancelled) setSvg(svg);
      } catch (err) {
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
          data-testid="mmd-view"
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
          data-testid="mmd-svg"
          p="md"
          style={{ flex: 1, minHeight: 0, overflow: "auto", textAlign: "center" }}
          // Mermaid output is sanitised by its own strict securityLevel.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <Text size="sm" c="dimmed" p="sm">
          Rendering…
        </Text>
      )}
    </Box>
  );
}
