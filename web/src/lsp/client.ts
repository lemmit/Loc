import { MonacoLanguageClient } from "monaco-languageclient";
import { BrowserMessageReader, BrowserMessageWriter } from "vscode-languageserver-protocol/browser.js";
import { CloseAction, ErrorAction } from "vscode-languageclient/browser.js";
import { initLoomServices } from "../editor/loom-services";

// Owns the playground's language session: boots the vscode-api services,
// spins up the Langium LSP server in a worker, and connects a
// MonacoLanguageClient to it.  Every LSP capability registered in
// `src/language/ddd-module.ts` flows over this connection — the editor only
// has to create a `ddd` model.  Lifetime is parent-owned (App), so the
// worker survives editor remounts on example switches.
export class LoomLspClient {
  private worker?: Worker;
  private client?: MonacoLanguageClient;
  private readonly startup: Promise<void>;

  constructor() {
    this.startup = this.boot();
  }

  /** Resolves once services + client are ready; editors await this. */
  ready(): Promise<void> {
    return this.startup;
  }

  private async boot(): Promise<void> {
    await initLoomServices();
    this.worker = new Worker(new URL("./ddd-server.worker.ts", import.meta.url), {
      type: "module",
      name: "loom-lsp",
    });
    const reader = new BrowserMessageReader(this.worker);
    const writer = new BrowserMessageWriter(this.worker);
    this.client = new MonacoLanguageClient({
      name: "Loom Language Server",
      clientOptions: {
        documentSelector: ["ddd"],
        errorHandler: {
          error: () => ({ action: ErrorAction.Continue }),
          closed: () => ({ action: CloseAction.DoNotRestart }),
        },
      },
      messageTransports: { reader, writer },
    });
    await this.client.start();
  }

  dispose(): void {
    void this.client?.dispose();
    this.worker?.terminate();
  }
}
