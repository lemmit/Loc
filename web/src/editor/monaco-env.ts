// Monaco needs a worker for the core editor (tokenization, diff,
// etc.).  We register only the editor worker — no JSON / TS / CSS
// language workers are loaded, since the only language we serve is
// `loom-ddd`, and its language smarts live in our own LSP worker.
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

export function installMonacoEnvironment(): void {
  if (typeof window === "undefined") return;
  if (window.MonacoEnvironment) return;
  window.MonacoEnvironment = {
    getWorker(_workerId: string, _label: string) {
      return new EditorWorker();
    },
  };
}
