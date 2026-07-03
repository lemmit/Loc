import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import { installMonacoEnvironment } from "../editor/monaco-env";

installMonacoEnvironment();

const MARKER_OWNER = "loom-json-body";

// The playground aliases `monaco-editor` onto the VS Code-based
// `@codingame/monaco-vscode-editor-api`, which doesn't ship the classic
// standalone JSON language worker — so semantic schema validation isn't
// available here.  We still give the user inline feedback for the most
// common mistake (malformed JSON) by parsing on the main thread and
// publishing a marker ourselves.  Correct-by-construction example bodies
// come from the schema via the "Generate example" button instead.
function syntaxMarkers(
  model: monaco.editor.ITextModel,
): monaco.editor.IMarkerData[] {
  const text = model.getValue();
  if (text.trim() === "") return [];
  try {
    JSON.parse(text);
    return [];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const at = /position (\d+)/.exec(message);
    const offset = at ? Number(at[1]) : 0;
    const pos = model.getPositionAt(offset);
    return [
      {
        severity: monaco.MarkerSeverity.Error,
        message,
        startLineNumber: pos.lineNumber,
        startColumn: pos.column,
        endLineNumber: pos.lineNumber,
        endColumn: pos.column + 1,
      },
    ];
  }
}

export interface JsonBodyEditorProps {
  value: string;
  onChange: (value: string) => void;
  isDesktop: boolean;
}

/** A small standalone Monaco editor for the request body — JSON syntax
 *  highlighting plus main-thread parse-error markers.  Mirrors the
 *  single-mount + imperative-value-push pattern used by FileViewer to
 *  avoid Monaco re-create churn. */
export function JsonBodyEditor(props: JsonBodyEditorProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const onChangeRef = useRef(props.onChange);
  onChangeRef.current = props.onChange;
  const initialValueRef = useRef(props.value);

  useEffect(() => {
    if (!containerRef.current) return;
    const editor = monaco.editor.create(containerRef.current, {
      value: initialValueRef.current,
      language: "json",
      theme: "vs-dark",
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 12,
      lineNumbers: "off",
      folding: false,
      scrollBeyondLastLine: false,
      tabSize: 2,
    });
    editorRef.current = editor;
    const model = editor.getModel();
    if (model) monaco.editor.setModelMarkers(model, MARKER_OWNER, syntaxMarkers(model));
    const sub = editor.onDidChangeModelContent(() => {
      const m = editor.getModel();
      if (!m) return;
      onChangeRef.current(m.getValue());
      monaco.editor.setModelMarkers(m, MARKER_OWNER, syntaxMarkers(m));
    });

    // Automation seam: lets e2e replace the body text atomically (fires
    // onChange like a normal edit), without depending on select-all +
    // insertText.  The playground's VS Code-based editor build doesn't wire
    // Ctrl+A select-all for standalone editors, so keyboard-driven overwrite
    // silently appends to the picker-prefilled example — two concatenated JSON
    // objects → a malformed body.  `model.setValue` sidesteps that entirely.
    // Harmless in production.
    const automation = window as unknown as { __loomSetRequestBody?: (t: string) => void };
    automation.__loomSetRequestBody = (text: string) => model?.setValue(text);

    return () => {
      sub.dispose();
      delete (window as unknown as { __loomSetRequestBody?: unknown }).__loomSetRequestBody;
      editorRef.current = null;
      editor.dispose();
    };
    // Single-mount; value changes are pushed imperatively below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const model = editor.getModel();
    if (!model) return;
    if (model.getValue() !== props.value) model.setValue(props.value);
  }, [props.value]);

  return (
    <div
      ref={containerRef}
      data-testid="req-body"
      style={{
        height: props.isDesktop ? 140 : 200,
        border: "1px solid var(--mantine-color-dark-4)",
        borderRadius: 4,
        overflow: "hidden",
      }}
    />
  );
}
