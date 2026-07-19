// ---------------------------------------------------------------------------
// Evolution diff core — the migration + wire-contract delta between a pinned
// baseline and the live edit.  Extracted from the build worker so it's a pure,
// headless-testable function (the worker just serialises `runEvolution` over
// postMessage).  Both sides are whole `.ddd` source TREES, lowered through the
// project loader (`loadProjectFromVfs` → `lowerProject`) so multi-file / import
// baselines resolve exactly as `ddd generate system` would on disk (M-T8.11).
// A single-file source is just the one-entry case.  Every diff rides a shipped
// PURE core (`buildMigrations` / `diffWireSpec` / `renderPgStep`).
//
// CRUCIAL: each side loads on a FRESH, isolated `createDddServices` + VFS.  If
// an evolution tree were loaded into a workspace that ALSO held the generate
// flow's resident `/workspace/*` docs, a cross-aggregate `X id` reference would
// bind to the WRONG document's `X` (same name, different AST node), producing a
// spurious "expects 'Product id' but got 'Product id'" type-mismatch that fails
// the whole diff.  Per-tree isolation (mirroring `src/api/parseSource`) is the
// fix — no shared index, no cross-document contamination, and the two sides
// can't pollute each other either.  Regression-gated by `evolution-diff.test.ts`.
// ---------------------------------------------------------------------------

import { EmptyFileSystem } from "langium";
import { enrichLoomModel } from "../../../src/ir/enrich/enrichments.js";
import { lowerProject } from "../../../src/ir/lower/lower.js";
import type { EnrichedLoomModel } from "../../../src/ir/types/loom-ir.js";
import type { SchemaSnapshot } from "../../../src/ir/types/migrations-ir.js";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";
import { renderPgStep } from "../../../src/generator/sql-pg.js";
import {
  buildMigrations,
  MigrationDestructiveError,
} from "../../../src/system/migrations-builder.js";
import type { SnapshotStore } from "../../../src/system/snapshot.js";
import { buildWireSpec } from "../../../src/system/wire-spec.js";
import { diffWireSpec } from "../../../src/system/wire-spec-diff.js";
import { MemoryVfs } from "../vfs/memory-vfs.js";
import { loadProjectFromVfs } from "./project-loader.js";
import type {
  BuildDiagnostic,
  EvolutionParams,
  EvolutionResult,
  EvolutionTree,
  MigrationView,
  WireChangeView,
} from "./protocol.js";

const BUCKET_LABEL: Record<string, string> = {
  aggregates: "aggregate",
  parts: "part",
  valueObjects: "value object",
};

/** In-memory snapshot store — the browser twin of `fsSnapshotStore`, inlined
 *  to keep `node:fs` out of the worker bundle (`SnapshotStore` is a type-only
 *  import → no runtime edge).  Matches `memorySnapshotStore`'s contract. */
function memStore(initial: Record<string, SchemaSnapshot> = {}): SnapshotStore {
  return { read: (module: string) => initial[module] ?? null };
}

/** Minimal Langium-diagnostic → `BuildDiagnostic` projection (the slice the
 *  evolution flow needs; the worker's generate path has its own copy). */
function collectDiagnostics(
  docs: {
    diagnostics?: { severity?: number; message: string | { value: string }; source?: string }[];
  }[],
): BuildDiagnostic[] {
  const out: BuildDiagnostic[] = [];
  for (const doc of docs) {
    for (const d of doc.diagnostics ?? []) {
      out.push({
        severity: d.severity === 1 ? "error" : "warning",
        message: typeof d.message === "string" ? d.message : d.message.value,
        source: typeof d.source === "string" ? d.source : "loom",
      });
    }
  }
  return out;
}

function loweringDiag(err: unknown): BuildDiagnostic {
  return {
    severity: "error",
    message: `Lowering failed: ${err instanceof Error ? err.message : String(err)}`,
    source: "loom-ir",
  };
}

function migrationDiag(err: unknown): BuildDiagnostic {
  return {
    severity: "error",
    message: `Migration derivation failed: ${err instanceof Error ? err.message : String(err)}`,
    source: "loom-evolve",
  };
}

/** Load one diff side on its OWN isolated Langium services + VFS and lower it
 *  to an enriched IR.  Returns either the lowered model or the parse/import/
 *  lowering diagnostics that stopped it — never throws.  Isolation is the
 *  whole point (see the module header): the fresh services' workspace holds
 *  only this tree's docs, so name resolution can't reach a resident
 *  `/workspace/*` doc (or the other diff side). */
async function loadEvolutionTree(
  tree: EvolutionTree,
): Promise<
  { loom: EnrichedLoomModel; diagnostics: BuildDiagnostic[] } | { error: BuildDiagnostic[] }
> {
  const svc = createDddServices(EmptyFileSystem);
  const vfs = new MemoryVfs();
  vfs.hydrate(tree.files);
  try {
    const { all } = await loadProjectFromVfs(tree.entryPath, svc.shared, vfs);
    const diagnostics = collectDiagnostics(all);
    if (diagnostics.some((d) => d.severity === "error")) return { error: diagnostics };
    const loom = enrichLoomModel(lowerProject(all.map((d) => d.parseResult?.value as Model)));
    return { loom, diagnostics };
  } catch (err) {
    // Missing import / cycle (from the loader) or a lowering throw.
    return { error: [loweringDiag(err)] };
  }
}

/** Derive the migration + wire-contract delta a source change implies, between
 *  a pinned baseline tree and the live edit tree.  Pure (no worker globals) so
 *  it's directly unit-testable. */
export async function runEvolution(params: EvolutionParams): Promise<EvolutionResult> {
  // Load the CURRENT tree — its diagnostics are what the user acts on, and a
  // broken current source can't be diffed.  Each side is fully isolated (own
  // services + VFS), so ordering / disposal between sides is moot.
  const curLoaded = await loadEvolutionTree(params.current);
  if ("error" in curLoaded) return { ok: false, diagnostics: curLoaded.error };
  const curLoom = curLoaded.loom;
  const curDiags = curLoaded.diagnostics;
  if (curLoom.systems.length === 0) {
    return {
      ok: true,
      hasBaseline: false,
      migrations: [],
      wireChanges: [],
      breaking: false,
      diagnostics: [
        {
          severity: "warning",
          message:
            "Source has no `system` block — schema migrations and the wire contract are derived per system, so there is nothing to evolve yet.",
          source: "loom-evolve",
        },
      ],
    };
  }

  let baseSystemsByName = new Map<string, EnrichedLoomModel["systems"][number]>();
  if (params.baseline && params.baseline.files.length > 0) {
    const baseLoaded = await loadEvolutionTree(params.baseline);
    // A baseline that no longer loads/lowers (a since-removed feature, a
    // missing import at that ref) is treated as absent rather than failing
    // the whole diff — everything then reads Initial.
    if (!("error" in baseLoaded)) {
      baseSystemsByName = new Map(baseLoaded.loom.systems.map((s) => [s.name, s]));
    }
  }
  const hasBaseline = baseSystemsByName.size > 0;

  const migrations: MigrationView[] = [];
  const wireChanges: WireChangeView[] = [];
  let breaking = false;

  for (const curSys of curLoom.systems) {
    const baseSys = baseSystemsByName.get(curSys.name) ?? null;

    // -- schema migration ---------------------------------------------------
    // Seed a memory snapshot store from the baseline's stamped `.next`
    // snapshots (an empty store ⇒ the baseline itself would be "Initial"),
    // then derive the current source against it: the steps that come back
    // ARE the pending migration.
    const seed: Record<string, SchemaSnapshot> = {};
    if (baseSys) {
      for (const bm of buildMigrations(baseSys, memStore())) {
        seed[bm.module] = bm.next;
      }
    }
    const store = memStore(seed);
    const destructiveByModule = new Map<string, string>();
    let migs: ReturnType<typeof buildMigrations>;
    try {
      migs = buildMigrations(curSys, store);
    } catch (err) {
      if (err instanceof MigrationDestructiveError) {
        destructiveByModule.set(err.module, err.message);
        breaking = true;
        // Re-derive with the gate OFF so the user still sees the (safe-
        // sequence) steps the change implies, not just the refusal.
        migs = buildMigrations(curSys, store, { allowDestructive: true });
      } else {
        return { ok: false, diagnostics: [...curDiags, migrationDiag(err)] };
      }
    }
    for (const mig of migs) {
      if (mig.steps.length === 0) continue; // clean regen ⇒ no-op, don't list
      const isDestructive = destructiveByModule.has(mig.module);
      migrations.push({
        module: mig.module,
        name: mig.name,
        version: mig.version,
        steps: mig.steps.map((s) => ({ op: s.op, sql: renderPgStep(s) })),
        destructive: isDestructive,
        destructiveMessage: destructiveByModule.get(mig.module),
      });
    }

    // -- wire contract ------------------------------------------------------
    // Only meaningful against a real baseline; with none, every shape is
    // "new" and the contract diff would be noise.
    if (baseSys) {
      const diff = diffWireSpec(buildWireSpec(baseSys), buildWireSpec(curSys));
      if (diff.breaking) breaking = true;
      for (const c of diff.changes) {
        wireChanges.push({
          entity: `${BUCKET_LABEL[c.bucket] ?? c.bucket} ${c.entity}`,
          field: c.field,
          kind: c.kind,
          breaking: c.breaking,
          detail: c.detail,
        });
      }
    }
  }

  return {
    ok: true,
    hasBaseline,
    migrations,
    wireChanges,
    breaking,
    diagnostics: curDiags,
  };
}
