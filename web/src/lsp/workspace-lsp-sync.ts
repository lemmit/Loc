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
// The sync is one-way (workspace → models).
//
// # Ownership
//
// Two components create models at the same URIs: `LoomEditor` creates one for
// the file it is showing (and deliberately keeps it alive across its own
// remounts), and this sync creates one for every other `.ddd` file. The split
// is by CONCERN, not by creator:
//
//   * CONTENT of the active file is the editor's — it writes back to the
//     workspace through `onSourceChange`, so this sync never `setValue`s it
//     (we'd fight over edits).
//   * LIFETIME of every model at a workspace `.ddd` URI is this sync's,
//     however that model came to exist. A model found via `getModel` is
//     ADOPTED into `tracked` rather than merely updated.
//
// Adoption is the whole point: before it, a model the editor had created
// while its file was active was never in the owned set, so the delete pass
// never disposed it. The Langium server kept the deleted file's declarations
// forever; re-adding the same declarations under a new filename produced
// duplicate-symbol errors, and any error count suppresses the playground's
// auto-generate — "delete a file and re-add it" blocked generation until a
// page reload.
//
// The one thing adoption must not do is yank a model out from under the live
// editor: Monaco reacts to `model.dispose()` on an attached model with
// `setModel(null)`, i.e. a blank editor. So a model whose file just vanished
// while it is STILL the active path is parked in `pendingDispose` and
// disposed on a later pass, once the active path has moved off it. Both real
// delete paths move it: `WorkspaceSourcesController.delete` re-points
// `activePath` to the fallback and emits a second time, and a rename is
// `write(new)` + `delete(old)`. The one case that never drains — deleting the
// only remaining file, where the fallback path is the deleted path itself —
// is exactly the case where the editor is still showing that document, so
// keeping the model is the correct outcome, not a leak.

import type { WorkspaceSourcesController } from "../workspace/workspace-sources";
import type { LspModelHost, SyncedModel } from "./model-host";

/** Stable URI for a workspace `.ddd` path. MUST agree with `LoomEditor`'s
 *  internal `modelUriFor` so the two callers don't create distinct Langium
 *  documents for the same file. */
export function modelUriFor(workspacePath: string): string {
  return `inmemory:///${workspacePath.replace(/^\/+/, "")}`;
}

export interface WorkspaceLspSyncOptions {
  /** Returns the currently-active editor path. The model at this path is the
   *  one the editor is displaying: this sync adopts it (so a delete can
   *  eventually dispose it) but never writes its content and never disposes
   *  it while it is still active. */
  getActivePath: () => string;
  /** Monaco model registry seam — `monacoModelHost` in the app, a fake in
   *  tests. */
  host: LspModelHost;
}

/** Start syncing. Returns a disposer that tears down subscriptions and
 *  disposes every model this sync is tracking (the active file's model is
 *  left alone — the editor is still attached to it). */
export function syncWorkspaceToLsp(
  controller: WorkspaceSourcesController,
  opts: WorkspaceLspSyncOptions,
): () => void {
  const host = opts.host;
  // path → the model whose lifetime this sync owns. Populated both by
  // models we create and by pre-existing models we adopt.
  const tracked = new Map<string, SyncedModel>();
  // path → a model whose file is gone but which the editor is still
  // showing. Disposed on the first pass where it is no longer active.
  const pendingDispose = new Map<string, SyncedModel>();

  const apply = (): void => {
    const snapshot = controller.snapshot();
    const activePath = opts.getActivePath();
    const livePaths = new Set<string>();

    for (const [path, content] of snapshot.files) {
      livePaths.add(path);
      // The file came back (re-add, or a rename back to this name) before we
      // got to dispose its parked model — un-park it and keep using it.
      const parked = pendingDispose.get(path);
      if (parked) {
        pendingDispose.delete(path);
        tracked.set(path, parked);
      }
      const uri = modelUriFor(path);
      // Adopt: a model we didn't create (the editor's, from when this file
      // was the active one) still becomes ours to dispose.
      let model = tracked.get(path) ?? host.getModel(uri);
      if (!model) {
        // Nothing exists yet. For the active path, let `LoomEditor` create it
        // with its own seed content; we'll adopt it on a later pass.
        if (path === activePath) continue;
        model = host.createModel(content, uri);
      }
      tracked.set(path, model);
      if (path === activePath) continue; // editor owns this one's content
      if (model.getValue() !== content) {
        // VFS changed under us (another tab, an example switch, …) — push
        // the new content into the model so the LSP re-validates.
        model.setValue(content);
      }
    }

    // Dispose models for files removed from the workspace (file delete, or
    // an example switch that dropped them).
    for (const [path, model] of [...tracked]) {
      if (livePaths.has(path)) continue;
      tracked.delete(path);
      if (path === activePath) pendingDispose.set(path, model);
      else model.dispose();
    }

    // Drain models parked on an earlier pass, now that the editor has moved
    // off them.
    for (const [path, model] of [...pendingDispose]) {
      if (path === activePath || livePaths.has(path)) continue;
      model.dispose();
      pendingDispose.delete(path);
    }
  };

  apply(); // seed before subscribing
  const unsubscribe = controller.subscribe(apply);

  return () => {
    unsubscribe();
    const activePath = opts.getActivePath();
    for (const [path, model] of [...tracked, ...pendingDispose]) {
      if (path === activePath) continue; // still on screen — the editor's
      model.dispose();
    }
    tracked.clear();
    pendingDispose.clear();
  };
}
