import type {
  CompletionItem,
  DefinitionLocation,
  Diagnostic,
  HoverResult,
  Position,
  RpcNotification,
  RpcRequest,
  RpcResponse,
} from "./protocol.js";

type DiagnosticsListener = (version: number, items: Diagnostic[]) => void;

export class LoomLspClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private diagnosticsListeners: DiagnosticsListener[] = [];

  constructor() {
    this.worker = new Worker(new URL("./lsp.worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.onmessage = (ev: MessageEvent<RpcResponse | RpcNotification>) => {
      const msg = ev.data;
      if ("id" in msg) {
        const slot = this.pending.get(msg.id);
        if (!slot) return;
        this.pending.delete(msg.id);
        if (msg.error) slot.reject(new Error(msg.error.message));
        else slot.resolve(msg.result);
        return;
      }
      if (msg.method === "diagnostics") {
        for (const fn of this.diagnosticsListeners) {
          fn(msg.params.version, msg.params.items);
        }
      }
    };
  }

  onDiagnostics(fn: DiagnosticsListener): () => void {
    this.diagnosticsListeners.push(fn);
    return () => {
      this.diagnosticsListeners = this.diagnosticsListeners.filter((x) => x !== fn);
    };
  }

  private request<T>(method: RpcRequest["method"], params: RpcRequest["params"]): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
      });
      this.worker.postMessage({ id, method, params } satisfies RpcRequest);
    });
  }

  update(text: string, version: number): Promise<void> {
    return this.request<void>("update", { text, version });
  }

  hover(position: Position): Promise<HoverResult> {
    return this.request<HoverResult>("hover", { position });
  }

  completion(position: Position): Promise<{ items: CompletionItem[] }> {
    return this.request<{ items: CompletionItem[] }>("completion", { position });
  }

  definition(position: Position): Promise<DefinitionLocation[]> {
    return this.request<DefinitionLocation[]>("definition", { position });
  }

  dispose(): void {
    this.worker.terminate();
    for (const slot of this.pending.values()) {
      slot.reject(new Error("LSP client disposed"));
    }
    this.pending.clear();
  }
}
