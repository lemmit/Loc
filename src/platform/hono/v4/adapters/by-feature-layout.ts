// ---------------------------------------------------------------------------
// byFeature — a real LayoutAdapter for the hono (node) platform
// (D-REALIZATION-AXES Phase 5b).  The sibling of `byLayer`: same artifacts,
// different on-disk arrangement.  Where `byLayer` groups by RESPONSIBILITY
// (`domain/<agg>.ts`, `db/repositories/<agg>-repository.ts`,
// `http/<agg>.routes.ts`), `byFeature` colocates everything for ONE aggregate
// under a single `features/<agg>/` folder — the "vertical slice" arrangement.
//
// SCOPE: every PER-AGGREGATE artifact rehomes under `features/<agg>/`: the
// aggregate domain module, its drizzle repository, its HTTP routes, the
// optional extern-handler + test files, and the TPH/TPC base union + reader.
// CROSS-CUTTING artifacts stay layered (delegated to `byLayer`): the pooled
// domain files (ids, value-objects, events, errors, provenance), `db/schema.ts`,
// `http/index.ts`, per-context workflows, obs / auth / lib, and the
// project root.
//
// RELATIVE IMPORTS: unlike .NET, relocating TS files breaks their relative
// `import … from "…"` specifiers.  The orchestrator runs `rewriteRelativeImports`
// (`src/generator/typescript/layout-imports.ts`) as a post-emit pass to fix every
// affected specifier from this adapter's old→new mapping, so the relocated
// project compiles.  Filename parity (byFeature reuses byLayer's basename) keeps
// the file *names* byte-identical; only folders + imports change.
// ---------------------------------------------------------------------------

import type {
  EmitCtx,
  EmittedArtifact,
  LayoutAdapter,
} from "../../../../generator/_adapters/index.js";
import { lowerFirst } from "../../../../util/naming.js";
import { byLayerLayoutAdapter, type HonoArtifact } from "./by-layer-layout.js";

/** Per-aggregate categories byFeature rehomes under `features/<agg>/`.
 *  Everything else delegates to byLayer (shared / cross-cutting). */
const FEATURE_CATEGORIES: ReadonlySet<HonoArtifact["category"]> = new Set([
  "domain-aggregate",
  "domain-aggregate-base",
  "domain-test",
  "drizzle-repository",
  "http-routes",
]);

export const byFeatureLayoutAdapter: LayoutAdapter = {
  name: "byFeature",

  pathFor(artifact: EmittedArtifact, ctx: EmitCtx): string {
    const a = artifact as HonoArtifact;
    if (!a.category) {
      throw new Error(
        `byFeature.pathFor: artifact '${artifact.name}' is missing a category (HonoArtifactCategory).  ` +
          `Every hono emit site must tag its artifact with the right category before dispatching through the layout adapter.`,
      );
    }
    // Cross-cutting / shared artifacts keep their layered placement.
    if (!FEATURE_CATEGORIES.has(a.category)) {
      return byLayerLayoutAdapter.pathFor(artifact, ctx);
    }
    if (!a.aggregateName) {
      throw new Error(
        `byFeature.pathFor: '${a.category}' artifact missing aggregateName (${artifact.name})`,
      );
    }
    // Reuse byLayer's basename (so the file name stays byte-identical) and
    // rehome it under the feature folder.
    const layered = byLayerLayoutAdapter.pathFor(artifact, ctx);
    const base = layered.slice(layered.lastIndexOf("/") + 1);
    return `features/${lowerFirst(a.aggregateName)}/${base}`;
  },
};
