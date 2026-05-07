import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import { installMonacoEnvironment } from "./monaco-env";
import {
  loomLanguage,
  loomLanguageConfig,
  loomLanguageId,
} from "./loom-monarch";
import type { LoomLspClient } from "../lsp/client";
import type { Diagnostic, Range } from "../lsp/protocol";

installMonacoEnvironment();

let registered = false;
function registerLoomLanguage(): void {
  if (registered) return;
  registered = true;
  monaco.languages.register({ id: loomLanguageId, extensions: [".ddd"] });
  monaco.languages.setMonarchTokensProvider(loomLanguageId, loomLanguage);
  monaco.languages.setLanguageConfiguration(loomLanguageId, loomLanguageConfig);
}

function rangeToMonaco(r: Range): monaco.IRange {
  return {
    startLineNumber: r.start.line + 1,
    startColumn: r.start.character + 1,
    endLineNumber: r.end.line + 1,
    endColumn: r.end.character + 1,
  };
}

function diagnosticsToMarkers(items: Diagnostic[]): monaco.editor.IMarkerData[] {
  return items.map((d) => ({
    severity:
      d.severity === "error"
        ? monaco.MarkerSeverity.Error
        : d.severity === "warning"
          ? monaco.MarkerSeverity.Warning
          : d.severity === "info"
            ? monaco.MarkerSeverity.Info
            : monaco.MarkerSeverity.Hint,
    message: d.message,
    source: d.source ?? "loom",
    startLineNumber: d.range.start.line + 1,
    startColumn: d.range.start.character + 1,
    endLineNumber: d.range.end.line + 1,
    endColumn: d.range.end.character + 1,
  }));
}

export interface LoomEditorProps {
  initialValue: string;
  /** LSP client owned by the parent.  Lifted out of this component
   *  so the underlying Langium worker survives example switches —
   *  the editor remounts (via `key={exampleId}` in App) but the
   *  worker stays alive, which costs ~5–10 MB per saved instance
   *  and a few hundred ms of Langium init each. */
  client: LoomLspClient;
  onChange?: (value: string) => void;
  onDiagnosticsChange?: (items: Diagnostic[]) => void;
}

export function LoomEditor(props: LoomEditorProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Stable refs so the effect that wires Monaco only runs once.
  const initialValueRef = useRef(props.initialValue);
  const clientRef = useRef(props.client);
  clientRef.current = props.client;
  const onChangeRef = useRef(props.onChange);
  const onDiagnosticsRef = useRef(props.onDiagnosticsChange);
  onChangeRef.current = props.onChange;
  onDiagnosticsRef.current = props.onDiagnosticsChange;

  useEffect(() => {
    if (!containerRef.current) return;
    registerLoomLanguage();

    const client = clientRef.current;
    let version = 0;

    const editor = monaco.editor.create(containerRef.current, {
      value: initialValueRef.current,
      language: loomLanguageId,
      theme: "vs-dark",
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      scrollBeyondLastLine: false,
      tabSize: 2,
    });
    const model = editor.getModel();
    if (!model) {
      editor.dispose();
      // Don't dispose the client here — the parent owns its
      // lifetime now.  Just bail out of wiring this mount.
      return;
    }

    const pushUpdate = (): void => {
      version += 1;
      void client.update(model.getValue(), version);
    };
    pushUpdate();

    const changeSub = model.onDidChangeContent(() => {
      onChangeRef.current?.(model.getValue());
      pushUpdate();
    });

    const offDiagnostics = client.onDiagnostics((v, items) => {
      // Drop late responses for stale versions to keep markers
      // aligned with the current buffer.
      if (v !== version) return;
      monaco.editor.setModelMarkers(model, "loom", diagnosticsToMarkers(items));
      onDiagnosticsRef.current?.(items);
    });

    const hoverProvider = monaco.languages.registerHoverProvider(loomLanguageId, {
      async provideHover(m, position) {
        if (m !== model) return null;
        const result = await client.hover({
          line: position.lineNumber - 1,
          character: position.column - 1,
        });
        if (!result.contents) return null;
        return {
          contents: [{ value: result.contents }],
          range: result.range ? rangeToMonaco(result.range) : undefined,
        };
      },
    });

    const completionProvider = monaco.languages.registerCompletionItemProvider(loomLanguageId, {
      // Trigger on identifier chars and a few structural punctuators.
      // Langium's completion provider handles bare-name + dotted lookups.
      triggerCharacters: [".", " ", ":", "<", "(", ","],
      async provideCompletionItems(m, position) {
        if (m !== model) return { suggestions: [] };
        const word = m.getWordUntilPosition(position);
        const replaceRange: monaco.IRange = {
          startLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endLineNumber: position.lineNumber,
          endColumn: word.endColumn,
        };
        const result = await client.completion({
          line: position.lineNumber - 1,
          character: position.column - 1,
        });
        const suggestions: monaco.languages.CompletionItem[] = result.items.map((it) => ({
          label: it.label,
          kind: it.kind ?? monaco.languages.CompletionItemKind.Text,
          detail: it.detail,
          documentation: it.documentation,
          insertText: it.insertText ?? it.label,
          range: replaceRange,
        }));
        return { suggestions };
      },
    });

    const definitionProvider = monaco.languages.registerDefinitionProvider(loomLanguageId, {
      async provideDefinition(m, position) {
        if (m !== model) return null;
        const result = await client.definition({
          line: position.lineNumber - 1,
          character: position.column - 1,
        });
        if (result.length === 0) return null;
        return result.map((loc) => ({
          uri: model.uri,
          range: rangeToMonaco(loc.range),
        }));
      },
    });

    return () => {
      changeSub.dispose();
      hoverProvider.dispose();
      completionProvider.dispose();
      definitionProvider.dispose();
      offDiagnostics();
      editor.dispose();
      // Client lifetime is parent-owned; do not dispose here.
    };
  }, []);

  return <div ref={containerRef} style={{ height: "100%", width: "100%" }} />;
}
