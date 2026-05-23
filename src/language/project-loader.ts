import * as fs from "node:fs";
import * as path from "node:path";
import type { LangiumDocument } from "langium";
import { URI } from "langium";
import type { LangiumSharedServices } from "langium/lsp";
import { isModel, type Model } from "./generated/ast.js";

/**
 * Loads a multi-file Loom project starting from `entryUri` and
 * walking transitive `import` statements.
 *
 * Each `import "<path>"` resolves relative to the importing file.
 * Reaching the same URI through two paths is fine (deduplicated by
 * the workspace's URI string); a cycle (file A → B → A) throws with
 * a chain trace so the user can untangle it.  Missing import targets
 * throw with the resolved absolute path so the error points at the
 * actual filesystem location the loader tried.
 *
 * Returns the entry document plus every reachable document, all
 * registered with the shared `LangiumDocuments` index and run
 * through one `DocumentBuilder.build(...)` call so cross-document
 * references resolve through Langium's standard machinery.  Caller
 * picks the entry's `Model` for the system-level orchestration and
 * lowers every document independently (see `mergeLoomModels`).
 *
 * Single-file callers can still use `getOrCreateDocument` directly
 * — this helper is purely additive.
 */
export async function loadProject(
  entryUri: URI,
  shared: LangiumSharedServices,
): Promise<{ entry: LangiumDocument<Model>; all: LangiumDocument<Model>[] }> {
  const docs = shared.workspace.LangiumDocuments;
  const visited = new Map<string, LangiumDocument<Model>>();
  const inProgress = new Set<string>();

  async function walk(uri: URI, chain: string[]): Promise<LangiumDocument<Model>> {
    const key = uri.toString();
    const existing = visited.get(key);
    if (existing) return existing;
    if (inProgress.has(key)) {
      throw new Error(
        `circular .ddd import detected: ${[...chain, key].map(uriToDisplay).join(" → ")}`,
      );
    }
    inProgress.add(key);

    const doc = (await docs.getOrCreateDocument(uri)) as LangiumDocument<Model>;
    const model = doc.parseResult?.value;
    if (!model || !isModel(model)) {
      // Parse failed — keep going so callers can surface the parse
      // diagnostics, but don't try to recurse into imports we can't
      // read.
      visited.set(key, doc);
      inProgress.delete(key);
      return doc;
    }

    for (const imp of model.imports ?? []) {
      const rawPath = imp.path;
      if (!rawPath) continue;
      const importerDir = path.dirname(uri.fsPath);
      const importedAbs = path.resolve(importerDir, rawPath);
      if (!fs.existsSync(importedAbs)) {
        throw new Error(
          `.ddd import not found: "${rawPath}" (resolved to ${importedAbs}) imported by ${uri.fsPath}`,
        );
      }
      const importedUri = URI.file(importedAbs);
      await walk(importedUri, [...chain, key]);
    }

    visited.set(key, doc);
    inProgress.delete(key);
    return doc;
  }

  const entry = await walk(entryUri, []);
  const all = [...visited.values()];
  await shared.workspace.DocumentBuilder.build(all, { validation: true });
  return { entry, all };
}

function uriToDisplay(uriStr: string): string {
  try {
    return URI.parse(uriStr).fsPath;
  } catch {
    return uriStr;
  }
}
