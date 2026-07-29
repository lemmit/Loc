// The Monaco half of the workspace→LSP model sync, split out so the sync
// logic itself (`workspace-lsp-sync.ts`) stays free of the `monaco-editor`
// import.  Monaco is a DOM-only module — importing it pulls a browser
// runtime that the node-side vitest suite cannot load — so the sync talks to
// this narrow interface and the tests pass a fake.
//
// Only the four operations the sync actually performs are exposed:
// look up a model by URI, create one, read/write its text, dispose it.

import * as monaco from "monaco-editor";

/** The slice of `monaco.editor.ITextModel` the workspace sync uses. */
export interface SyncedModel {
  getValue(): string;
  setValue(value: string): void;
  dispose(): void;
}

/** The slice of the `monaco.editor` model registry the workspace sync uses.
 *  URIs are passed as strings — `workspace-lsp-sync.ts` owns the URI scheme
 *  (and must keep agreeing with `LoomEditor`'s `modelUriFor`), the host only
 *  parses them. */
export interface LspModelHost {
  /** The existing model at `uri`, or `null` when nothing has created it. */
  getModel(uri: string): SyncedModel | null;
  /** Create a `ddd`-language model at `uri`. */
  createModel(content: string, uri: string): SyncedModel;
}

/** The production host — the real Monaco model registry. */
export const monacoModelHost: LspModelHost = {
  getModel: (uri) => monaco.editor.getModel(monaco.Uri.parse(uri)),
  createModel: (content, uri) => monaco.editor.createModel(content, "ddd", monaco.Uri.parse(uri)),
};
