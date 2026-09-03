/// <reference lib="webworker" />
import { EmptyFileSystem, URI } from "langium";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";
import { lowerModel, lowerProject, mergeLoomModels } from "../../../src/ir/lower/lower.js";
import { enrichLoomModel } from "../../../src/ir/enrich/enrichments.js";
import { allContexts } from "../../../src/ir/types/loom-ir.js";
import type { EnrichedLoomModel, LoomModel } from "../../../src/ir/types/loom-ir.js";
// The api's operation set as IR DATA — the single derivation all five backend
// route builders render from (`src/ir/util/api-surface.ts`).  Reading it here
// is what lets the playground's API view describe the generated backend's HTTP
// surface without parsing generated source or booting anything, and keeps the
// view correct for a .NET / Java / Phoenix / Python deployable too.
import { deriveContextOperations } from "../../../src/ir/util/api-surface.js";
import { validateLoomModel } from "../../../src/ir/validate/validate.js";
// `system/index` (multi-backend system generation) is NOT imported statically:
// it pulls the generation registry → every backend generator (.NET / Java /
// Phoenix / Python).  The "system" mode loads it via a dynamic `import()` so
// those generators land in a SEPARATE chunk, out of the main worker bundle.
// `web-bundle-boundary.test.ts` pins this.  (The Hono "ts" path below stays a
// static import — it runs in-browser with no chunk fetch.)
import { captureSnapshots } from "../../../src/system/loomsnap.js";
// The evolution-diff core (migration + wire-contract delta) lives in its own
// pure, headless-testable module — the worker just serialises it over
// postMessage.  It pulls the schema-migration deriver / SQL renderer / wire-
// spec differ (all browser-safe siblings of `system/index`, so the bundle-
// boundary test stays green).
import { runEvolution } from "./evolution.js";
// P2a moved the TS orchestrator into the hono@v4 package; the
// playground legacy single-context build targets the default Hono
// backend and supplies that package's pins (B2.1).
import { generateTypeScript } from "../../../src/platform/hono/v4/emit.js";
import { BACKEND_PINS as HONO_V4_PINS } from "../../../src/platform/hono/v4/pins.js";
import { fnv1a32 } from "../util/hash.js";
import { MemoryVfs } from "../vfs/memory-vfs.js";
import { loadProjectFromVfs } from "./project-loader.js";
import { seedBuiltinPacks } from "./template-bundled.js";
import { setWorkerVfs } from "./worker-vfs.js";
import type {
  ApiOperationView,
  ApiSurfaceView,
  BuildDiagnostic,
  BuildRpcRequest,
  BuildRpcResponse,
  ChannelView,
  GenerateResult,
  LoomSourceMap,
  SnapshotResult,
  VirtualFile,
} from "./protocol.js";

/** The one artifact the always-on recorder adds to the emission.  Stripped
 *  back out unless the caller passed `sourcemap: true` — see
 *  `systemOptions`. */
const SOURCEMAP_ARTIFACT = ".loom/sourcemap.json";

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

function collectDiagnostics(docs: { uri: { toString(): string }; diagnostics?: { severity?: number; message: string | { value: string }; range?: { start: { line: number; character: number } }; source?: string; code?: string | number }[] }[]): BuildDiagnostic[] {
  const out: BuildDiagnostic[] = [];
  for (const doc of docs) {
    for (const d of doc.diagnostics ?? []) {
      out.push({
        severity: d.severity === 1 ? "error" : "warning",
        message: typeof d.message === "string" ? d.message : d.message.value,
        line: d.range ? d.range.start.line + 1 : undefined,
        column: d.range ? d.range.start.character + 1 : undefined,
        source: typeof d.source === "string" ? d.source : "loom",
        // The `loom.*` code rides along so mobile's Problems rows (fed from
        // generate, not an LSP) get the same chip / docs link as desktop.
        code: typeof d.code === "string" ? d.code : undefined,
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
      // FNV-1a, the playground's existing non-cryptographic hash: the diff
      // only has to answer "did these bytes change", for ~100 files on every
      // keystroke-driven regenerate — which rules out `crypto.subtle` (async,
      // so the whole response would have to await it).
      hash: fnv1a32(content),
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
      systemEmission(
        generateSystems(input.model, systemOptions(input)).files,
        loom,
        input.sourcemap === true,
      ),
    );
  }
  if (loom.contexts.length > 0) {
    return wrapGenerate("ts", input.diagnostics, irDiags, () => ({
      files: generateTypeScript(input.model, HONO_V4_PINS),
    }));
  }
  return emptyResult(input.diagnostics, irDiags);
}

/** `GenerateSystemOptions` for a worker generate.
 *
 *  `sourcemap` is now unconditionally ON: the correspondence view
 *  (M-T8.20 slice 3) needs the construct→file map on EVERY generate, not
 *  only on the `--sourcemap` pass that feeds the boot bundle.  Recording
 *  it costs one extra `Map` of regions and — crucially — adds exactly ONE
 *  file to the emission (`.loom/sourcemap.json`), which `systemEmission`
 *  strips back out unless the caller asked for it.
 *
 *  `sourceTexts` stays gated on the caller's flag, and that gate is what
 *  makes the strip sufficient: without it `src/system/index.ts` skips the
 *  Source Map v3 / JSR-45 sidecar loops entirely, so no `.ts.map` is
 *  emitted and no `.ts` gains a trailing `sourceMappingURL` directive.
 *  Every other emitted byte is identical with the recorder on or off. */
function systemOptions(input: { sourcemap?: boolean; sourceTexts?: Map<string, string> }): {
  sourcemap: true;
  sourceTexts?: ReadonlyMap<string, string>;
} {
  return {
    sourcemap: true,
    sourceTexts: input.sourcemap ? input.sourceTexts : undefined,
  };
}

/** Split a system emission into the files the caller sees, the parsed
 *  sourcemap it always gets back, and the API surface the API view renders. */
function systemEmission(
  files: Map<string, string>,
  loom: EnrichedLoomModel,
  keepArtifact: boolean,
): EmissionParts {
  const raw = files.get(SOURCEMAP_ARTIFACT);
  if (!keepArtifact) files.delete(SOURCEMAP_ARTIFACT);
  let sourcemap: LoomSourceMap | undefined;
  if (raw !== undefined) {
    try {
      sourcemap = JSON.parse(raw) as LoomSourceMap;
    } catch {
      // A map we can't parse is a map we don't ship — the generate itself
      // is unaffected, and the correspondence view degrades to "no
      // correspondence recorded" rather than throwing on hover.
      sourcemap = undefined;
    }
  }
  return { files, sourcemap, api: deriveApiSurface(loom) };
}

/** Platform-neutral operation + channel inventory for the API view.
 *  Reads `deriveContextOperations` — the derivation all five backend route
 *  builders render from — so this describes what the generated backend
 *  actually serves regardless of which platform emitted it. */
function deriveApiSurface(loom: EnrichedLoomModel): ApiSurfaceView {
  const operations: ApiOperationView[] = [];
  const channels: ChannelView[] = [];
  for (const ctx of allContexts(loom)) {
    for (const op of deriveContextOperations(ctx)) {
      operations.push({
        context: ctx.name,
        aggregate: op.aggregate,
        method: op.method.toUpperCase(),
        path: op.path,
        id: op.id,
        kind: op.kind,
      });
    }
    for (const ch of ctx.channels ?? []) {
      channels.push({
        context: ctx.name,
        name: ch.name,
        carries: [...ch.carries],
        delivery: ch.delivery,
        retention: ch.retention,
        ...(ch.key ? { key: ch.key } : {}),
      });
    }
  }
  return { operations, channels };
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
      systemEmission(
        generateSystemsFromLoom(loom, systemOptions(input)).files,
        loom,
        input.sourcemap === true,
      ),
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
    code: typeof d.code === "string" ? d.code : undefined,
  }));
}

function hasError(diags: BuildDiagnostic[]): boolean {
  return diags.some((d) => d.severity === "error");
}

/** What one generate produced: the file map plus the two derived views the
 *  playground reads back beside it (never as files — see
 *  `GenerateOk.sourcemap`). */
interface EmissionParts {
  files: Map<string, string>;
  sourcemap?: LoomSourceMap;
  api?: ApiSurfaceView;
}

function wrapGenerate(
  mode: "system" | "ts",
  parseDiags: BuildDiagnostic[],
  irDiags: BuildDiagnostic[],
  emit: () => EmissionParts,
): GenerateResult {
  try {
    const parts = emit();
    return {
      ok: true,
      mode,
      files: filesFromMap(parts.files),
      diagnostics: [...parseDiags, ...irDiags],
      ...(parts.sourcemap ? { sourcemap: parts.sourcemap } : {}),
      ...(parts.api ? { api: parts.api } : {}),
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
        response.result = await runEvolution(req.params);
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
