import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { Center, Loader, Stack, Text } from "@mantine/core";
import * as monaco from "monaco-editor";
import type { LoomLspClient } from "../lsp/client";
import type { Diagnostic } from "../lsp/protocol";
import { modelUriFor } from "../lsp/workspace-lsp-sync";
import { installMonacoEnvironment } from "./monaco-env";
import type { EditorHandle, EditorRange } from "./editor-handle";
import { loomQuickFixes, quickFixesAt } from "./fix-hint-actions";
import { applyTextEdits } from "./apply-edits";

export type { EditorHandle };

// Monaco spawns workers by LABEL, and with no `MonacoEnvironment` it throws
// the moment tokenization starts ("You must define a function
// MonacoEnvironment.getWorkerUrl ... for the worker label: TextMateWorker").
//
// This used to be installed as a side effect of `FileViewer` being eagerly
// imported — nothing said so, it just happened to evaluate first.  Making the
// viewer lazy (M-T8.15) removed that accident, and whether the editor came up
// became a race between two lazy chunks.  Every module that reaches
// `monaco-editor` now installs it itself; the function is idempotent.
installMonacoEnvironment();

const DEFAULT_ACTIVE_PATH = "/workspace/main.ddd";

/** Map a workspace path (e.g. `/workspace/main.ddd`) to a stable
 *  Monaco model URI.  Phase 2b1 of the multi-file work parameterises
 *  this so Phase 2b2 can swap models when the editor's active file
 *  changes.  The default-path branch preserves the legacy
 *  `inmemory:///main.ddd` URI string byte-for-byte — any tooling
 *  that already opened a model under that URI (LSP document
 *  tracking, the live model created on first mount) keeps matching
 *  the same model identity across re-renders. */
/** Map a workspace path to a deterministic Monaco URI. The LSP worker indexes
 *  documents by URI, so two callers (LoomEditor + workspace-lsp-sync) must
 *  agree on the same URI for the same file or they'd create duplicate
 *  documents in Langium's global scope and produce phantom ambiguity errors.
 *  The string form is therefore owned by ONE function — `modelUriFor` in
 *  `lsp/workspace-lsp-sync.ts` — and parsed here.
 *
 *  The scheme is `inmemory:///<workspace-relative>` for every `.ddd` source,
 *  so `/workspace/main.ddd` → `inmemory:///workspace/main.ddd` and
 *  `/workspace/shared/money.ddd` → `inmemory:///workspace/shared/money.ddd`.
 *  No special case for main — the previous `inmemory:///main.ddd` was a
 *  back-compat shim from before multi-file workspaces existed; collapsing
 *  it means cross-file imports (`import "./shared/money.ddd"`) resolve
 *  through the same URI scheme as the build-worker's `project-loader`. */
function monacoUriFor(activePath: string): monaco.Uri {
  return monaco.Uri.parse(modelUriFor(activePath));
}

/** After a workspace edit lands in the model (e.g. applying an "Unfold
 *  macro" code action), scroll the edited range into view if it's outside
 *  the viewport. A code action can splice new content anywhere in the
 *  document — `crudish`'s materialized operations always land just before
 *  the aggregate's closing `}`, which for a non-trivial aggregate is often
 *  many lines below the cursor the user invoked the action from — and
 *  nothing else in the editor pipeline reveals it, so applying the action
 *  looked like a no-op. `rangeOffset`/`rangeLength`/`text` are given against
 *  the pre-edit document for every change in one batch (Monaco's contract
 *  for `IModelContentChange`), so `delta` re-derives the target's *post*-edit
 *  offset by summing the length change of every other edit that landed
 *  before it. For ordinary typing (one change, no others) this resolves to
 *  the position the cursor is already at, which is already in view, so the
 *  reveal is a no-op there. */
function revealLatestEdit(
  editor: monaco.editor.IStandaloneCodeEditor,
  model: monaco.editor.ITextModel,
  changes: readonly monaco.editor.IModelContentChange[],
): void {
  if (changes.length === 0) return;
  const target = changes.reduce((a, b) => (b.rangeOffset > a.rangeOffset ? b : a));
  const delta = changes
    .filter((c) => c !== target)
    .reduce((sum, c) => sum + (c.text.length - c.rangeLength), 0);
  const newOffset = Math.min(target.rangeOffset + delta + target.text.length, model.getValueLength());
  const pos = model.getPositionAt(newOffset);
  editor.revealRangeInCenterIfOutsideViewport(
    new monaco.Range(pos.lineNumber, 1, pos.lineNumber, 1),
    monaco.editor.ScrollType.Smooth,
  );
}

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
    // Monaco carries the LSP `code` either bare or as `{ value, target }`
    // (when the server attached a codeDescription); the Problems rows key
    // their chip / docs link / Fix on the bare string.
    code: typeof m.code === "string" ? m.code : m.code?.value,
  }));
}

export interface LoomEditorProps {
  initialValue: string;
  handleRef?: MutableRefObject<EditorHandle | null>;
  /** LSP client owned by the parent; survives editor remounts. */
  client: LoomLspClient;
  isMobile?: boolean;
  onChange?: (value: string) => void;
  onDiagnosticsChange?: (items: Diagnostic[]) => void;
  /** The workspace path of the file currently being edited.  Drives
   *  the Monaco model URI so Phase 2b2 can swap files without
   *  tearing the editor down.  Defaults to `/workspace/main.ddd`
   *  (today's behaviour, byte-identical Monaco URI). */
  activePath?: string;
}

export function LoomEditor(props: LoomEditorProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // The seed the model is created with / reset to when Monaco finally comes
  // up.  Tracked, NOT frozen at first render: the model isn't created until
  // the language client is ready, which on a cold load is seconds after this
  // component first rendered.  Freezing meant a deferred mount reseeded the
  // model from a value the app had already moved past — the mount looked like
  // a WRITER that reverted the source.  Following the prop makes the seed
  // "whatever the active file's content is when the editor actually exists".
  const initialValueRef = useRef(props.initialValue);
  initialValueRef.current = props.initialValue;
  // Text pushed through `handleRef.setSource` while Monaco did not yet exist
  // (see the pre-mount handle below).  Wins over `initialValueRef` as the
  // mount seed: it is a real user edit, whereas the prop can still be the
  // pre-edit content when the write hasn't round-tripped the workspace store.
  const pendingSourceRef = useRef<string | null>(null);
  // A `revealRange` that arrived before Monaco existed (M-T8.18) — replayed
  // once the editor is created, so the reveal + focus is deferred, not lost.
  const pendingRevealRef = useRef<EditorRange | null>(null);
  const clientRef = useRef(props.client);
  clientRef.current = props.client;
  const onChangeRef = useRef(props.onChange);
  const onDiagnosticsRef = useRef(props.onDiagnosticsChange);
  onChangeRef.current = props.onChange;
  onDiagnosticsRef.current = props.onDiagnosticsChange;
  const handleRef = useRef(props.handleRef);
  handleRef.current = props.handleRef;
  const isMobileRef = useRef(props.isMobile ?? false);
  // Frozen-at-mount activePath — Phase 2b1 keeps it constant; Phase
  // 2b2 will lift this to a state-driven model swap.
  const activePathRef = useRef(props.activePath ?? DEFAULT_ACTIVE_PATH);
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
    if (status !== "ready" || !containerRef.current) {
      // Monaco isn't up yet — the editor is created only once the language
      // client is ready, which on a cold load lands SECONDS after first paint.
      // Until then `handleRef.current` was `null`, so every non-editor write
      // routed through it (a Builder / Requirements "Apply", an agent edit)
      // hit `editorHandleRef.current?.setSource(text)` and was silently
      // DROPPED — and the mount below then seeded the model with the pre-edit
      // text, so the edit was gone from the source for good even though the
      // rest of the app (`sourceRef`, the panes, the workspace store) had it.
      // A queueing stand-in makes the handle exist from the first render; the
      // real one replaces it below and consumes the queue as its seed.
      const holder = handleRef.current;
      if (!holder || holder.current) return;
      const placeholder: EditorHandle = {
        setSource: (text: string) => {
          pendingSourceRef.current = text;
        },
        // No model yet: apply against the queued / seed text so a fix that
        // lands before Monaco exists is not dropped either.
        applyEdits: (edits) => {
          pendingSourceRef.current = applyTextEdits(
            pendingSourceRef.current ?? initialValueRef.current,
            edits,
          );
        },
        // No editor yet — queue it.  The first-run card's *Write .ddd* door
        // fires before Monaco has finished loading (it is a 9.5 MB chunk),
        // and dropping the reveal there left the click doing nothing at all.
        revealRange: (range) => {
          pendingRevealRef.current = range;
        },
        // No model yet, so no stack: the chrome renders Undo / Redo disabled
        // rather than swallowing a click.
        undo: () => {},
        redo: () => {},
        canUndo: () => false,
        canRedo: () => false,
      };
      holder.current = placeholder;
      return () => {
        // Only retract our own stand-in — the real handle owns its teardown.
        if (holder.current === placeholder) holder.current = null;
      };
    }
    const isMobile = isMobileRef.current;

    // Reuse the model across remounts so the LSP document stays attached;
    // refresh its content to the (possibly new) example source.
    const modelUri = monacoUriFor(activePathRef.current);
    const seed = pendingSourceRef.current ?? initialValueRef.current;
    pendingSourceRef.current = null;
    const model =
      monaco.editor.getModel(modelUri) ?? monaco.editor.createModel(seed, "ddd", modelUri);
    if (model.getValue() !== seed) model.setValue(seed);

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
    const changeSub = model.onDidChangeContent((e) => {
      if (suppressDispatch) return;
      onChangeRef.current?.(model.getValue());
      revealLatestEdit(editor, model, e.changes);
    });

    const revealRange = (r: EditorRange): void => {
      const range = new monaco.Range(r.startLineNumber, r.startColumn, r.endLineNumber, r.endColumn);
      editor.setSelection(range);
      editor.revealRangeInCenter(range, monaco.editor.ScrollType.Smooth);
      editor.focus();
    };

    if (handleRef.current) {
      handleRef.current.current = {
        setSource: (text: string) => {
          if (model.getValue() === text) return;
          suppressDispatch = true;
          model.pushEditOperations(null, [{ range: model.getFullModelRange(), text }], () => null);
          suppressDispatch = false;
        },
        // One undoable batch, NOT suppressed: a Fix from the Problems panel
        // must reach the app like a keystroke (the LSP re-validates, the
        // error count drops) — the same path the lightbulb's edit takes.
        applyEdits: (edits) => {
          if (edits.length === 0) return;
          model.pushEditOperations(
            null,
            edits.map((e) => ({ range: e.range, text: e.text })),
            () => null,
          );
        },
        revealRange,
        // The model's own stack — `pushEditOperations` above already put every
        // pane write on it.  Undo/redo are NOT suppressed: the resulting
        // content change is dispatched like a keystroke, which is how the app
        // and the panes learn the source moved back (M-T8.17).
        undo: () => {
          void model.undo();
        },
        redo: () => {
          void model.redo();
        },
        canUndo: () => model.canUndo(),
        canRedo: () => model.canRedo(),
      };
    }

    // Replay a reveal that arrived while the stand-in handle was in place.
    if (pendingRevealRef.current) {
      const queued = pendingRevealRef.current;
      pendingRevealRef.current = null;
      revealRange(queued);
    }

    // Automation seam: lets e2e set/read the document text directly (set
    // dispatches onChange like a normal edit), without depending on clipboard,
    // paste, or the find widget.  Harmless in production.
    const automation = window as unknown as { __loomSetSource?: (t: string) => void; __loomGetSource?: () => string };
    automation.__loomSetSource = (text: string) => model.setValue(text);
    automation.__loomGetSource = () => model.getValue();

    const emitDiagnostics = (): void => {
      onDiagnosticsRef.current?.(
        markersToDiagnostics(monaco.editor.getModelMarkers({ resource: modelUri })),
      );
    };
    const markerSub = monaco.editor.onDidChangeMarkers((resources) => {
      if (resources.some((r) => r.toString() === modelUri.toString())) emitDiagnostics();
    });
    emitDiagnostics();

    // Quick-fix lightbulbs.  The playground showed the squiggle for a hinted
    // diagnostic and offered no fix: the toolkit has resolved every `fixHint`
    // (`src/language/fix-hints.ts`) into an applyable `CodeAction` all along
    // (`fixHintCodeActions`, `src/api/lsp.ts`) — nothing here ever asked.  This
    // is the generic seam, so a new fix-hint provider lights up in the editor
    // with no editor change; the Langium worker's own `DddCodeActionProvider`
    // stays as-is and keeps serving its two hardcoded codes (one of which,
    // `loom.bare-aggregate-in-type`, therefore appears twice in the menu — the
    // same edit under two titles, which is why nothing here special-cases it).
    // The only playground-specific logic is the LSP→Monaco position shift, in
    // `fix-hint-actions.ts` (0-based → 1-based), unit-tested there.
    const codeActionSub = monaco.languages.registerCodeActionProvider("ddd", {
      provideCodeActions: async (target, range, _context, token) => {
        const empty = { actions: [], dispose: () => {} };
        const fixes = await loomQuickFixes(target.getValue(), target.uri.toString());
        // The document may have moved on (or the request been superseded) while
        // we validated — applying a stale range would corrupt the source, so
        // drop the result rather than answer with positions from an old text.
        if (token.isCancellationRequested || target.isDisposed()) return empty;
        return {
          actions: quickFixesAt(fixes, range).map((fix) => ({
            title: fix.title,
            kind: "quickfix",
            // Never hardcoded: a `choose`-kind hint fans out one action per
            // option BECAUSE there is no single right answer, and a preferred
            // action is one the editor may apply on its own.
            isPreferred: fix.preferred,
            edit: {
              edits: fix.edits.map((e) => ({
                resource: target.uri,
                // Monaco applies `textEdit` verbatim: 1-based range + `text`
                // (LSP's `newText`).  `versionId: undefined` opts out of
                // Monaco's own staleness check — the guard above is ours.
                textEdit: { range: e.range, text: e.text },
                versionId: undefined,
              })),
            },
          })),
          dispose: () => {},
        };
      },
    });

    return () => {
      if (handleRef.current) handleRef.current.current = null;
      codeActionSub.dispose();
      delete (window as unknown as { __loomSetSource?: unknown }).__loomSetSource;
      delete (window as unknown as { __loomGetSource?: unknown }).__loomGetSource;
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
