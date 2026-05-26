// Sync every workspace `.ddd` source into the LSP worker as a Monaco
// document. `MonacoLanguageClient` (`documentSelector: ["ddd"]`) automatically
// sends `textDocument/didOpen` for every model with language="ddd" and
// `textDocument/didChange` on content edits — so creating a model is enough
// to give the Langium server a complete view of the workspace. Without this,
// the LSP only knew about the currently-edited file and any
// `import "./shared/x.ddd"` failed to resolve, surfacing as
// "Could not resolve reference to NamedDecl named 'X'" the moment the
// playground opened a multi-file example.
//
// The sync is one-way (workspace → models). The editor's own model (the
// active file) is owned by `LoomEditor` and writes back to the workspace
// through `onSourceChange`; this layer skips it so we don't double-set
// content or fight over edits. For inactive files there's no editor wired,
// so we just keep the model content in lock-step with the VFS snapshot.

import * as monaco from "monaco-editor";
import type { WorkspaceSourcesController } from "../workspace/workspace-sources";

/** Stable URI for a workspace `.ddd` path. MUST agree with `LoomEditor`'s
 *  internal `modelUriFor` so the two callers don't create distinct Langium
 *  documents for the same file. */
function modelUriFor(workspacePath: string): monaco.Uri {
  return monaco.Uri.parse(`inmemory:///${workspacePath.replace(/^\/+/, "")}`);
}

export interface WorkspaceLspSyncOptions {
  /** Returns the currently-active editor path. Models for the active path
   *  are managed by `LoomEditor`, not by this sync — we skip them to avoid
   *  duplicate `setValue` calls. */
  getActivePath: () => string;
}

/** Start syncing. Returns a disposer that tears down subscriptions and
 *  disposes every model this sync created (active-file model is left
 *  alone — it belongs to the editor). */
export function syncWorkspaceToLsp(
  controller: WorkspaceSourcesController,
  opts: WorkspaceLspSyncOptions,
): () => void {
  // path → model we created (so we know which to dispose; we don't touch
  // models we didn't create, even if they happen to match a workspace path).
  const owned = new Map<string, monaco.editor.ITextModel>();

  const apply = (): void => {
    const snapshot = controller.snapshot();
    const activePath = opts.getActivePath();
    const livePaths = new Set<string>();

    for (const [path, content] of snapshot.files) {
      livePaths.add(path);
      if (path === activePath) continue; // editor owns this one
      const uri = modelUriFor(path);
      let model = owned.get(path) ?? monaco.editor.getModel(uri);
      if (!model) {
        model = monaco.editor.createModel(content, "ddd", uri);
        owned.set(path, model);
      } else if (model.getValue() !== content) {
        // VFS changed under us (another tab, an example switch, …) — push
        // the new content into the model so the LSP re-validates.
        model.setValue(content);
      }
    }

    // Dispose models for files removed from the workspace (file delete, or
    // an example switch that dropped them). Only touch models we created.
    for (const [path, model] of [...owned]) {
      if (!livePaths.has(path)) {
        model.dispose();
        owned.delete(path);
      }
    }
  };

  apply(); // seed before subscribing
  const unsubscribe = controller.subscribe(apply);

  return () => {
    unsubscribe();
    for (const model of owned.values()) model.dispose();
    owned.clear();
  };
}
