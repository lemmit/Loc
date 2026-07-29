// ---------------------------------------------------------------------------
// Source-catalog extraction for the `ddd i18n` CLI (M-T1.11, i18n.md Phase 3).
//
// Runs pipeline phases ①–⑥ over a `.ddd` project (parse → lower → enrich) and
// returns the flat `{ key: message }` source catalog — the THEIRS input to the
// three-way merge, and what `ddd i18n extract` writes to
// `<out>/.loom/messages.en.json`.  It stops short of per-backend codegen: the
// catalog is derived purely from the enriched IR (via `buildMessageCatalog`,
// the same builder phase ⑨ uses), so extraction is fast and backend-agnostic.
//
// Lives under `src/cli/i18n/` (imported BY `main.ts`, never the reverse) so the
// layering stays one-directional; it re-derives the small parse-project spine
// rather than reaching back into `main.ts`.
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";
import { URI } from "langium";
import { NodeFileSystem } from "langium/node";
import type { Catalog } from "../../i18n/merge.js";
import { enrichLoomModel } from "../../ir/enrich/enrichments.js";
import { lowerProject } from "../../ir/lower/lower.js";
import { createDddServices } from "../../language/ddd-module.js";
import type { Model } from "../../language/generated/ast.js";
import { loadProject } from "../../language/project-loader.js";
import { buildMessageCatalog } from "../../system/i18n-catalog.js";

/** Parse + lower + enrich the project rooted at `entryFile`, then merge every
 *  system's message catalog into one flat, key-sorted `{ key: message }`. */
export async function extractCatalog(entryFile: string): Promise<Catalog> {
  const services = createDddServices(NodeFileSystem);
  const absolute = path.resolve(entryFile);
  if (!fs.existsSync(absolute)) {
    throw new Error(`File not found: ${absolute}`);
  }
  const { all } = await loadProject(URI.file(absolute), services.shared);
  const loom = enrichLoomModel(lowerProject(all.map((doc) => doc.parseResult.value as Model)));

  const merged: Catalog = {};
  for (const sys of loom.systems) {
    for (const [key, message] of Object.entries(buildMessageCatalog(sys))) {
      merged[key] = message;
    }
  }
  const out: Catalog = {};
  for (const key of Object.keys(merged).sort()) out[key] = merged[key];
  return out;
}
