/// <reference lib="webworker" />
import { EmptyFileSystem, URI } from "langium";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";
import { lowerModel, lowerProject, mergeLoomModels } from "../../../src/ir/lower/lower.js";
import { enrichLoomModel } from "../../../src/ir/enrich/enrichments.js";
import type { EnrichedLoomModel, LoomModel } from "../../../src/ir/types/loom-ir.js";
import { validateLoomModel } from "../../../src/ir/validate/validate.js";
// `system/index` (multi-backend system generation) is NOT imported statically:
// it pulls the generation registry → every backend generator (.NET / Java /
// Phoenix / Python).  The "system" mode loads it via a dynamic `import()` so
// those generators land in a SEPARATE chunk, out of the main worker bundle.
// `web-bundle-boundary.test.ts` pins this.  (The Hono "ts" path below stays a
// static import — it runs in-browser with no chunk fetch.)
import { captureSnapshots } from "../../../src/system/loomsnap.js";
// Evolution-diff cores — all pure/browser-safe siblings of `system/index`
// (NOT `system/index` itself, so the bundle-boundary test stays green):
// the schema-migration deriver, its Postgres-SQL renderer, the wire-spec
// builder, and the new semantic wire-contract differ.  They let the
// playground surface the migration + contract delta a source change
// implies — the "previous version" the stateless regen otherwise loses.
import {
  buildMigrations,
  MigrationDestructiveError,
} from "../../../src/system/migrations-builder.js";
// NB: `memorySnapshotStore` is NOT imported from `system/snapshot.js` — that
// module pulls `node:fs` (for `fsSnapshotStore`), which would drag it into the
// MAIN worker bundle's static graph.  The in-memory store is trivial, so we
// inline it here (`SnapshotStore` is a type-only import → no runtime edge) and
// keep the main bundle fs-free, same discipline as the `system/index` split.
import type { SnapshotStore } from "../../../src/system/snapshot.js";
import type { SchemaSnapshot } from "../../../src/ir/types/migrations-ir.js";
import { renderPgStep } from "../../../src/generator/sql-pg.js";
import { buildWireSpec } from "../../../src/system/wire-spec.js";
import { diffWireSpec } from "../../../src/system/wire-spec-diff.js";
// P2a moved the TS orchestrator into the hono@v4 package; the
// playground legacy single-context build targets the default Hono
// backend and supplies that package's pins (B2.1).
import { generateTypeScript } from "../../../src/platform/hono/v4/emit.js";
import { BACKEND_PINS as HONO_V4_PINS } from "../../../src/platform/hono/v4/pins.js";
import { MemoryVfs } from "../vfs/memory-vfs.js";
import { loadProjectFromVfs } from "./project-loader.js";
import { seedBuiltinPacks } from "./template-bundled.js";
import { setWorkerVfs } from "./worker-vfs.js";
import type {
  BuildDiagnostic,
  BuildRpcRequest,
  BuildRpcResponse,
  EvolutionResult,
  GenerateResult,
  MigrationView,
  SnapshotResult,
  VirtualFile,
  WireChangeView,
} from "./protocol.js";

declare const self: DedicatedWorkerGlobalScope;

// Worker-local VFS: seeded with the bundled built-in design packs at
// startup so the generator's `loadPack` calls hit the in-memory store
// rather than a no-longer-existent fs/glob seam.  Phase 2 will extend
// the build worker's RPC with `vfs.write/delete/list` so user-supplied
// packs and workspace files can stream in from the main thread.
const workerVfs = new MemoryVfs();
seedBuiltinPacks(workerVfs);
setWorkerVfs(workerVfs);

const DOC_URI = URI.parse("inmemory:///main.ddd");
const services = createDddServices(EmptyFileSystem);
const documents = services.shared.workspace.LangiumDocuments;
const builder = services.shared.workspace.DocumentBuilder;

async function parse(
  text: string,
): Promise<{ model?: Model; diagnostics: BuildDiagnostic[]; sourceTexts: Map<string, string> }> {
  const existing = documents.all.find((d) => d.uri.toString() === DOC_URI.toString());
  if (existing) documents.deleteDocument(existing.uri);
  const doc = documents.createDocument(DOC_URI, text);
  await builder.build([doc], { validation: true });
  const diagnostics = collectDiagnostics([doc]);
  // Keyed the same way the CLI keys it (`doc.uri.path`) — this is what
  // `GenerateSystemOptions.sourceTexts` matches an `OriginRef`'s
  // `SourceRef.path` against to render Source Map v3 `sourcesContent`.
  // Cheap to always compute; only consumed when a caller opts into
  // `sourcemap: true`.
  const sourceTexts = new Map([[doc.uri.path, text]]);
  const errorCount = diagnostics.filter((d) => d.severity === "error").length;
  if (errorCount > 0) return { diagnostics, sourceTexts };
  return { model: doc.parseResult?.value as Model, diagnostics, sourceTexts };
}

/** Project-loader path — used when generate is called with an
 *  `entryPath` instead of inline text.  Walks transitive `import`s
 *  through the worker's VFS, registers every reachable document, and
 *  returns a single merged `LoomModel` ready for the rest of the
 *  pipeline.  Lowering happens here (per-document then
 *  `mergeLoomModels`) so we don't double-lower in `handleGenerate`. */
async function parseProject(
  entryPath: string,
): Promise<{
  loom?: LoomModel;
  diagnostics: BuildDiagnostic[];
  sourceTexts: Map<string, string>;
}> {
  try {
    const { all } = await loadProjectFromVfs(entryPath, services.shared, workerVfs);
    const diagnostics = collectDiagnostics(all);
    // Every reachable document, keyed by `doc.uri.path` — the multi-file
    // sibling of `parse()`'s single-entry map (mirrors the CLI's
    // `parseProject` in `src/cli/main.ts`).
    const sourceTexts = new Map<string, string>();
    for (const doc of all) sourceTexts.set(doc.uri.path, doc.textDocument.getText());
    if (diagnostics.some((d) => d.severity === "error")) {
      return { diagnostics, sourceTexts };
    }
    // Compose the whole import graph as one project (top-level subdomains
    // fold into the lone system) — see implicit-system-composition.md.
    const merged = lowerProject(all.map((d) => d.parseResult?.value as Model));
    return { loom: merged, diagnostics, sourceTexts };
  } catch (err) {
    return {
      diagnostics: [
        {
          severity: "error",
          message: err instanceof Error ? err.message : String(err),
          source: "loom-project",
        },
      ],
      sourceTexts: new Map(),
    };
  }
}

function collectDiagnostics(docs: { uri: { toString(): string }; diagnostics?: { severity?: number; message: string | { value: string }; range?: { start: { line: number; character: number } }; source?: string }[] }[]): BuildDiagnostic[] {
  const out: BuildDiagnostic[] = [];
  for (const doc of docs) {
    for (const d of doc.diagnostics ?? []) {
      out.push({
        severity: d.severity === 1 ? "error" : "warning",
        message: typeof d.message === "string" ? d.message : d.message.value,
        line: d.range ? d.range.start.line + 1 : undefined,
        column: d.range ? d.range.start.character + 1 : undefined,
        source: typeof d.source === "string" ? d.source : "loom",
      });
    }
  }
  return out;
}

function filesFromMap(map: Map<string, string>): VirtualFile[] {
  const out: VirtualFile[] = [];
  for (const [path, content] of map) {
    out.push({
      path,
      content,
      size: content.length,
    });
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

async function handleGenerateFromText(
  text: string,
  sourcemap?: boolean,
): Promise<GenerateResult> {
  const parsed = await parse(text);
  if (!parsed.model) return { ok: false, diagnostics: parsed.diagnostics };
  return generateFromAst({
    model: parsed.model,
    diagnostics: parsed.diagnostics,
    sourcemap,
    sourceTexts: parsed.sourceTexts,
  });
}

async function handleGenerateFromPath(
  entryPath: string,
  sourcemap?: boolean,
): Promise<GenerateResult> {
  const parsed = await parseProject(entryPath);
  if (!parsed.loom) return { ok: false, diagnostics: parsed.diagnostics };
  return generateFromLoom({
    loom: parsed.loom,
    diagnostics: parsed.diagnostics,
    sourcemap,
    sourceTexts: parsed.sourceTexts,
  });
}

/** Single-document generation path.  Keeps the legacy single-file
 *  shape — `generateSystems(model)` does its own lower+enrich
 *  internally, matching pre-multi-file behaviour exactly.
 *
 *  `sourcemap`/`sourceTexts` are opt-in (both undefined by default) —
 *  threading them into `generateSystems`'s `GenerateSystemOptions` is a
 *  no-op unless a caller explicitly requests `sourcemap: true`, so the
 *  default "generated code" view / download output is unaffected. */
async function generateFromAst(input: {
  model: Model;
  diagnostics: BuildDiagnostic[];
  sourcemap?: boolean;
  sourceTexts?: Map<string, string>;
}): Promise<GenerateResult> {
  let loom: EnrichedLoomModel;
  try {
    loom = enrichLoomModel(lowerModel(input.model));
  } catch (err) {
    return loweringError(input.diagnostics, err);
  }
  const irDiags = irValidate(loom);
  if (hasError(irDiags)) return { ok: false, diagnostics: [...input.diagnostics, ...irDiags] };

  if (loom.systems.length > 0) {
    // Code-split: keep the backend generators out of the main bundle (see the
    // import-header note + the dynamic-import seam for future server-side gen).
    const { generateSystems } = await import("../../../src/system/index.js");
    return wrapGenerate("system", input.diagnostics, irDiags, () =>
      generateSystems(input.model, {
        sourcemap: input.sourcemap,
        sourceTexts: input.sourceTexts,
      }).files,
    );
  }
  if (loom.contexts.length > 0) {
    return wrapGenerate("ts", input.diagnostics, irDiags, () =>
      generateTypeScript(input.model, HONO_V4_PINS),
    );
  }
  return emptyResult(input.diagnostics, irDiags);
}

/** Multi-file generation path.  The merged `LoomModel` is already
 *  built by `parseProject`; we only need enrichment + the
 *  system-mode generator.  Legacy single-context `generate ts` /
 *  `generate dotnet` aren't reachable here — those callers stay on
 *  the text path because they don't compose multi-file output
 *  anyway (mirrors the CLI's split). */
async function generateFromLoom(input: {
  loom: LoomModel;
  diagnostics: BuildDiagnostic[];
  sourcemap?: boolean;
  sourceTexts?: Map<string, string>;
}): Promise<GenerateResult> {
  let loom: EnrichedLoomModel;
  try {
    loom = enrichLoomModel(input.loom);
  } catch (err) {
    return loweringError(input.diagnostics, err);
  }
  const irDiags = irValidate(loom);
  if (hasError(irDiags)) return { ok: false, diagnostics: [...input.diagnostics, ...irDiags] };

  if (loom.systems.length > 0) {
    const { generateSystemsFromLoom } = await import("../../../src/system/index.js");
    return wrapGenerate("system", input.diagnostics, irDiags, () =>
      generateSystemsFromLoom(loom, {
        sourcemap: input.sourcemap,
        sourceTexts: input.sourceTexts,
      }).files,
    );
  }
  // Multi-file project with only loose contexts (no `system` block)
  // isn't a thing the CLI's `generate system` supports either — it's
  // exclusively a single-file legacy mode.  Fall through to the
  // empty result so the user gets the same diagnostic they'd see in
  // the CLI.
  return emptyResult(input.diagnostics, irDiags);
}

function loweringError(prior: BuildDiagnostic[], err: unknown): GenerateResult {
  return {
    ok: false,
    diagnostics: [
      ...prior,
      {
        severity: "error",
        message: `Lowering failed: ${err instanceof Error ? err.message : String(err)}`,
        source: "loom-ir",
      },
    ],
  };
}

function irValidate(loom: EnrichedLoomModel): BuildDiagnostic[] {
  return validateLoomModel(loom).map((d) => ({
    severity: d.severity === "error" ? ("error" as const) : ("warning" as const),
    message: d.message,
    source: typeof d.source === "string" ? d.source : "loom-ir",
  }));
}

function hasError(diags: BuildDiagnostic[]): boolean {
  return diags.some((d) => d.severity === "error");
}

function wrapGenerate(
  mode: "system" | "ts",
  parseDiags: BuildDiagnostic[],
  irDiags: BuildDiagnostic[],
  emit: () => Map<string, string>,
): GenerateResult {
  try {
    return {
      ok: true,
      mode,
      files: filesFromMap(emit()),
      diagnostics: [...parseDiags, ...irDiags],
    };
  } catch (err) {
    return {
      ok: false,
      diagnostics: [
        ...parseDiags,
        ...irDiags,
        {
          severity: "error",
          message: `${mode === "system" ? "generateSystems" : "generateTypeScript"} failed: ${err instanceof Error ? err.message : String(err)}`,
          source: "loom-gen",
        },
      ],
    };
  }
}

function emptyResult(parseDiags: BuildDiagnostic[], irDiags: BuildDiagnostic[]): GenerateResult {
  return {
    ok: true,
    mode: "none",
    files: [],
    diagnostics: [
      ...parseDiags,
      ...irDiags,
      {
        severity: "warning",
        message: "Source has no contexts or systems — nothing to generate.",
        source: "loom-gen",
      },
    ],
  };
}

/** Provenance-snapshot capture — the playground's equivalent of the CLI
 *  `ddd snapshot` prebuild step.  Returns the immutable timestamped+GUID
 *  snapshot files; empty `files` when no written `provenanced` field. */
async function handleSnapshotFromText(text: string): Promise<SnapshotResult> {
  const parsed = await parse(text);
  if (!parsed.model) return { ok: false, diagnostics: parsed.diagnostics };
  return snapshotFromLoom(lowerModel(parsed.model), parsed.diagnostics);
}

async function handleSnapshotFromPath(entryPath: string): Promise<SnapshotResult> {
  const parsed = await parseProject(entryPath);
  if (!parsed.loom) return { ok: false, diagnostics: parsed.diagnostics };
  return snapshotFromLoom(parsed.loom, parsed.diagnostics);
}

function snapshotFromLoom(
  rawLoom: LoomModel,
  parseDiags: BuildDiagnostic[],
): SnapshotResult {
  let loom: LoomModel;
  try {
    loom = enrichLoomModel(rawLoom);
  } catch (err) {
    return {
      ok: false,
      diagnostics: [
        ...parseDiags,
        {
          severity: "error",
          message: `Lowering failed: ${err instanceof Error ? err.message : String(err)}`,
          source: "loom-ir",
        },
      ],
    };
  }
  return {
    ok: true,
    files: filesFromMap(captureSnapshots(loom)),
    diagnostics: parseDiags,
  };
}

// ---------------------------------------------------------------------------
// Evolution diff — the migration + wire-contract delta between a pinned
// baseline source and the live edit.  Both sources are lowered here (the
// worker is where the compiler lives); every diff rides a shipped PURE core,
// so this is faithful to what `ddd generate system` would derive on disk.
// v1 is single-entry text only — a multi-file/import baseline would need
// both trees seeded into the worker VFS (tracked in M-T8.11).
// ---------------------------------------------------------------------------

const BUCKET_LABEL: Record<string, string> = {
  aggregates: "aggregate",
  parts: "part",
  valueObjects: "value object",
};

/** In-memory snapshot store — the browser twin of `fsSnapshotStore`,
 *  inlined to keep `node:fs` out of the main worker bundle (see the import
 *  note above).  Matches `memorySnapshotStore`'s contract exactly. */
function memStore(initial: Record<string, SchemaSnapshot> = {}): SnapshotStore {
  return { read: (module: string) => initial[module] ?? null };
}

async function handleEvolution(
  baselineText: string,
  currentText: string,
): Promise<EvolutionResult> {
  // Parse the CURRENT source first — its diagnostics are what the user acts
  // on.  A broken current source can't be diffed; a broken/empty baseline is
  // just "no previous version" (everything reads Initial).
  const cur = await parse(currentText);
  if (!cur.model) return { ok: false, diagnostics: cur.diagnostics };
  let curLoom: EnrichedLoomModel;
  try {
    curLoom = enrichLoomModel(lowerModel(cur.model));
  } catch (err) {
    return { ok: false, diagnostics: [loweringDiag(err)] };
  }
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

  const base = await parse(baselineText);
  let baseSystemsByName = new Map<string, EnrichedLoomModel["systems"][number]>();
  if (base.model) {
    try {
      const baseLoom = enrichLoomModel(lowerModel(base.model));
      baseSystemsByName = new Map(baseLoom.systems.map((s) => [s.name, s]));
    } catch {
      // A baseline that no longer lowers (e.g. a since-removed feature) is
      // treated as absent rather than failing the whole diff.
      baseSystemsByName = new Map();
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
        return { ok: false, diagnostics: [...cur.diagnostics, migrationDiag(err)] };
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
    diagnostics: cur.diagnostics,
  };
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

/** Disambiguate `generate` / `snapshot` callers' two input forms.
 *  Exactly one of `text` or `entryPath` must be set.  Returning the
 *  shape lets the worker dispatch to the multi-file project loader
 *  (entryPath) or the legacy single-doc parse (text) without an
 *  intermediate "read entry to a string and forget the path" step,
 *  which would have prevented import-walking. */
function classifySource(
  params: { text?: string; entryPath?: string },
): { kind: "text"; text: string } | { kind: "path"; entryPath: string } {
  const hasText = typeof params.text === "string";
  const hasPath = typeof params.entryPath === "string";
  if (hasText && hasPath) {
    throw new Error("build.generate: pass either `text` or `entryPath`, not both.");
  }
  if (hasText) return { kind: "text", text: params.text! };
  if (hasPath) return { kind: "path", entryPath: params.entryPath! };
  throw new Error("build.generate: missing `text` or `entryPath`.");
}

self.onmessage = async (ev: MessageEvent<BuildRpcRequest>) => {
  const req = ev.data;
  const response: BuildRpcResponse = { id: req.id };
  try {
    switch (req.method) {
      case "generate": {
        const src = classifySource(req.params);
        response.result =
          src.kind === "text"
            ? await handleGenerateFromText(src.text, req.params.sourcemap)
            : await handleGenerateFromPath(src.entryPath, req.params.sourcemap);
        break;
      }
      case "snapshot": {
        const src = classifySource(req.params);
        response.result =
          src.kind === "text"
            ? await handleSnapshotFromText(src.text)
            : await handleSnapshotFromPath(src.entryPath);
        break;
      }
      case "evolution": {
        response.result = await handleEvolution(
          req.params.baselineText,
          req.params.currentText,
        );
        break;
      }
      case "vfs.write": {
        // Hydrate batches the listener fan-out into a single
        // notification, which is the right shape for a multi-file
        // workspace push (e.g. dropping a custom pack folder in
        // Phase 4).  Single-file writes go through the same path —
        // hydrate's notification batch is a no-op when there's only
        // one path.  Entries are tagged (`VfsEntry`) — mixed file
        // and directory entries land in the same call so an empty
        // folder created on the main thread surfaces in the
        // worker's VFS on respawn.
        workerVfs.hydrate(req.params.entries);
        response.result = {
          ok: true,
          paths: req.params.entries.map((e) => e.path).sort(),
        };
        break;
      }
      case "vfs.delete": {
        const removed: string[] = [];
        for (const path of req.params.paths) {
          if (workerVfs.exists(path)) {
            workerVfs.delete(path);
            removed.push(path);
          }
        }
        removed.sort();
        response.result = { ok: true, paths: removed };
        break;
      }
      default:
        response.error = {
          message: `Unknown method: ${(req as { method: string }).method}`,
        };
    }
  } catch (err) {
    response.error = {
      message: err instanceof Error ? err.message : String(err),
    };
  }
  self.postMessage(response);
};
