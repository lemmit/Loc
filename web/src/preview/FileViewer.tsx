import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import {
  bandClass,
  hitClass,
  installCorrespondenceStyles,
  type ViewerHighlight,
} from "../editor/correspondence-decorations";
import { installMonacoEnvironment } from "../editor/monaco-env";
import { languageFromPath } from "./file-tree";
import type { CodePanelProps } from "./code-panel";
import { DocOrCode } from "./doc-viewers";

installMonacoEnvironment();

export type { ViewerHighlight };

export interface ViewerProps extends CodePanelProps {
  highlights?: readonly ViewerHighlight[];
  /** Report the 1-based generated line under the pointer (`null` on leave) —
   *  the reverse direction, which flashes the `.ddd` span it came from. */
  onHoverLine?: (line: number | null) => void;
}

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
export function FileViewer({ path, content, highlights, onHoverLine }: ViewerProps): JSX.Element {
  return (
    <DocOrCode
      path={path}
      content={content}
      CodePanel={(panel) => (
        <MonacoViewer {...panel} highlights={highlights} onHoverLine={onHoverLine} />
      )}
    />
  );
}

// Read-only Monaco panel for viewing a generated file.  On desktop Monaco is
// already paid for, so syntax highlighting for TS / JSON / YAML / SQL / etc.
// comes for free.
function MonacoViewer({ path, content, highlights, onHoverLine }: ViewerProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const decorationsRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const onHoverRef = useRef(onHoverLine);
  onHoverRef.current = onHoverLine;
  installCorrespondenceStyles();

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
    // Reverse direction: hovering generated code flashes the `.ddd` span it
    // came from.  Same last-line guard as the source editor's.
    let lastLine: number | null = null;
    const report = (line: number | null): void => {
      if (line === lastLine) return;
      lastLine = line;
      onHoverRef.current?.(line);
    };
    const moveSub = editor.onMouseMove((e) => report(e.target.position?.lineNumber ?? null));
    const leaveSub = editor.onMouseLeave(() => report(null));
    return () => {
      moveSub.dispose();
      leaveSub.dispose();
      decorationsRef.current = null;
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

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    // Bands first, hits last: Monaco layers later decorations on top, and the
    // "what the cursor produced" highlight has to win over the standing
    // colour map it sits inside.
    const ordered = [...(highlights ?? [])].sort((a, b) =>
      a.kind === b.kind ? 0 : a.kind === "band" ? -1 : 1,
    );
    const decorations = ordered.map((h) => ({
      range: new monaco.Range(h.startLine, 1, h.endLine, 1),
      options: {
        isWholeLine: true,
        className: h.kind === "hit" ? hitClass(h.band) : bandClass(h.band),
      },
    }));
    if (!decorationsRef.current) {
      decorationsRef.current = editor.createDecorationsCollection(decorations);
    } else {
      decorationsRef.current.set(decorations);
    }
  }, [highlights]);

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
