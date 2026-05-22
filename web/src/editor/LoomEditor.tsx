import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { Center, Loader, Stack, Text } from "@mantine/core";
import * as monaco from "monaco-editor";
import type { LoomLspClient } from "../lsp/client";
import type { Diagnostic } from "../lsp/protocol";

const MODEL_URI = monaco.Uri.parse("inmemory:///main.ddd");

function markersToDiagnostics(markers: monaco.editor.IMarker[]): Diagnostic[] {
  return markers.map((m) => ({
    range: {
      start: { line: m.startLineNumber - 1, character: m.startColumn - 1 },
      end: { line: m.endLineNumber - 1, character: m.endColumn - 1 },
    },
    severity:
      m.severity === monaco.MarkerSeverity.Error
        ? "error"
        : m.severity === monaco.MarkerSeverity.Warning
          ? "warning"
          : m.severity === monaco.MarkerSeverity.Info
            ? "info"
            : "hint",
    message: m.message,
    source: m.source ?? "loom",
  }));
}

/** Imperative handle for pushing source into the live editor model from a
 *  non-editor origin (the visual Builder). */
export interface EditorHandle {
  setSource: (text: string) => void;
}

export interface LoomEditorProps {
  initialValue: string;
  handleRef?: MutableRefObject<EditorHandle | null>;
  /** LSP client owned by the parent; survives editor remounts. */
  client: LoomLspClient;
  isMobile?: boolean;
  onChange?: (value: string) => void;
  onDiagnosticsChange?: (items: Diagnostic[]) => void;
}

export function LoomEditor(props: LoomEditorProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const initialValueRef = useRef(props.initialValue);
  const clientRef = useRef(props.client);
  clientRef.current = props.client;
  const onChangeRef = useRef(props.onChange);
  const onDiagnosticsRef = useRef(props.onDiagnosticsChange);
  onChangeRef.current = props.onChange;
  onDiagnosticsRef.current = props.onDiagnosticsChange;
  const handleRef = useRef(props.handleRef);
  handleRef.current = props.handleRef;
  const isMobileRef = useRef(props.isMobile ?? false);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let disposed = false;
    clientRef.current.ready().then(
      () => {
        if (!disposed) setStatus("ready");
      },
      () => {
        if (!disposed) setStatus("error");
      },
    );
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    if (status !== "ready" || !containerRef.current) return;
    const isMobile = isMobileRef.current;

    // Reuse the model across remounts so the LSP document stays attached;
    // refresh its content to the (possibly new) example source.
    const model =
      monaco.editor.getModel(MODEL_URI) ??
      monaco.editor.createModel(initialValueRef.current, "ddd", MODEL_URI);
    if (model.getValue() !== initialValueRef.current) model.setValue(initialValueRef.current);

    const editor = monaco.editor.create(containerRef.current, {
      model,
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: isMobile ? 16 : 13,
      scrollBeyondLastLine: false,
      tabSize: 2,
      "semanticHighlighting.enabled": true,
      ...(isMobile
        ? {
            wordWrap: "on" as const,
            scrollbar: { verticalScrollbarSize: 14, horizontalScrollbarSize: 14, useShadows: false },
            lineNumbersMinChars: 2,
            folding: false,
            glyphMargin: false,
            renderLineHighlight: "none" as const,
            fixedOverflowWidgets: true,
            dragAndDrop: false,
            contextmenu: false,
            mouseStyle: "default" as const,
            smoothScrolling: true,
          }
        : {}),
    });

    let suppressDispatch = false;
    const changeSub = model.onDidChangeContent(() => {
      if (!suppressDispatch) onChangeRef.current?.(model.getValue());
    });

    if (handleRef.current) {
      handleRef.current.current = {
        setSource: (text: string) => {
          if (model.getValue() === text) return;
          suppressDispatch = true;
          model.pushEditOperations(null, [{ range: model.getFullModelRange(), text }], () => null);
          suppressDispatch = false;
        },
      };
    }

    const emitDiagnostics = (): void => {
      onDiagnosticsRef.current?.(
        markersToDiagnostics(monaco.editor.getModelMarkers({ resource: MODEL_URI })),
      );
    };
    const markerSub = monaco.editor.onDidChangeMarkers((resources) => {
      if (resources.some((r) => r.toString() === MODEL_URI.toString())) emitDiagnostics();
    });
    emitDiagnostics();

    return () => {
      if (handleRef.current) handleRef.current.current = null;
      changeSub.dispose();
      markerSub.dispose();
      editor.dispose();
      // Keep the model alive: the language client stays attached to it
      // across example-switch remounts.
    };
  }, [status]);

  if (status !== "ready") {
    return (
      <Center style={{ height: "100%", width: "100%" }}>
        {status === "error" ? (
          <Stack align="center" gap="xs">
            <Text c="red" fw={600}>
              Failed to start the language server.
            </Text>
            <Text c="dimmed" size="sm">
              Try reloading the page.
            </Text>
          </Stack>
        ) : (
          <Stack align="center" gap="sm">
            <Loader />
            <Text c="dimmed" size="sm">
              Starting editor…
            </Text>
          </Stack>
        )}
      </Center>
    );
  }

  return <div ref={containerRef} style={{ height: "100%", width: "100%" }} />;
}
