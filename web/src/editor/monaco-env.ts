// Monaco needs a worker for the core editor (tokenization, diff,
// etc.).  We return our editor worker only for the editor label —
// for other labels (`typescript`, `json`, `css`, `html`, …) we
// return a tiny no-op worker.  This is necessary because
// `monaco-editor`'s default entry pulls in every built-in language
// mode, each of which tries to spawn its own language worker via
// `loadForeignModule`.  Returning the editor worker for those
// throws "Cannot read properties of undefined (reading 'toUrl')";
// returning a no-op worker silences the spawn without breaking
// syntax highlighting (Monarch tokenizers run on the main thread).
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

const EDITOR_LABELS = new Set(["", "editorWorkerService"]);

function makeNoopWorker(): Worker {
  // A blank module worker.  It registers no message handler, so
  // Monaco's foreign-module load just times out / hangs without
  // crashing.  We don't need its semantic features (intellisense,
  // formatting) for read-only file viewing.
  const blob = new Blob(
    ["// no-op language worker\nself.onmessage = () => {};"],
    { type: "application/javascript" },
  );
  return new Worker(URL.createObjectURL(blob), { type: "module" });
}

export function installMonacoEnvironment(): void {
  if (typeof window === "undefined") return;
  if (window.MonacoEnvironment) return;
  window.MonacoEnvironment = {
    getWorker(_workerId: string, label: string) {
      if (EDITOR_LABELS.has(label)) return new EditorWorker();
      return makeNoopWorker();
    },
  };
}
