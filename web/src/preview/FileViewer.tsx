import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import { installMonacoEnvironment } from "../editor/monaco-env";
import { languageFromPath } from "./file-tree";
import type { CodePanelProps } from "./code-panel";
import { DocOrCode } from "./doc-viewers";

installMonacoEnvironment();

// The DESKTOP generated-file viewer: the shared markdown/mermaid dispatcher
// over a read-only Monaco code panel.
//
// This module owns a static `monaco-editor` import (and calls
// `installMonacoEnvironment()` at module scope), so importing it ANYWHERE on
// the eager path drags 9.56 MB of editor plus three worker realms with it.
// It is reached only through `await import(...)` — `layout/lazy-panels.ts` is
// the single place that does so, and `scripts/check-eager-chunks.mjs` fails
// the build if it ever lands eager again.  Mobile renders `PlainFileViewer`
// instead.  See M-T8.15.
export function FileViewer({ path, content }: CodePanelProps): JSX.Element {
  return <DocOrCode path={path} content={content} CodePanel={MonacoViewer} />;
}

// Read-only Monaco panel for viewing a generated file.  On desktop Monaco is
// already paid for, so syntax highlighting for TS / JSON / YAML / SQL / etc.
// comes for free.
function MonacoViewer({ path, content }: CodePanelProps): JSX.Element {
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

  // The testid scopes e2e assertions to THIS read-only viewer — the page
  // also hosts the editable source Monaco (kept mounted, just hidden).
  return (
    <div
      ref={containerRef}
      data-testid="file-viewer"
      style={{ width: "100%", height: "100%" }}
    />
  );
}
