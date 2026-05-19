/// <reference lib="webworker" />
import { EmptyFileSystem, URI } from "langium";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";
import { lowerModel } from "../../../src/ir/lower.js";
import { enrichLoomModel } from "../../../src/ir/enrichments.js";
import { validateLoomModel } from "../../../src/ir/validate.js";
import { generateSystems } from "../../../src/system/index.js";
import { generateTypeScript } from "../../../src/generator/typescript/index.js";
// Playground legacy single-context build targets the default Hono
// backend; like the CLI entrypoint it supplies that package's pins
// to the version-agnostic shared emitter (B2.1).
import { BACKEND_PINS as HONO_V4_PINS } from "../../../src/platform/hono/v4/pins.js";
import { MemoryVfs } from "../vfs/memory-vfs.js";
import { seedBuiltinPacks } from "./template-bundled.js";
import { setWorkerVfs } from "./worker-vfs.js";
import type {
  BuildDiagnostic,
  BuildRpcRequest,
  BuildRpcResponse,
  GenerateResult,
  VirtualFile,
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

async function parse(text: string): Promise<{ model?: Model; diagnostics: BuildDiagnostic[] }> {
  const existing = documents.all.find((d) => d.uri.toString() === DOC_URI.toString());
  if (existing) documents.deleteDocument(existing.uri);
  const doc = documents.createDocument(DOC_URI, text);
  await builder.build([doc], { validation: true });
  const diagnostics: BuildDiagnostic[] = (doc.diagnostics ?? []).map((d) => ({
    severity: d.severity === 1 ? "error" : "warning",
    message: d.message,
    line: d.range.start.line + 1,
    column: d.range.start.character + 1,
    source: typeof d.source === "string" ? d.source : "loom",
  }));
  const errorCount = diagnostics.filter((d) => d.severity === "error").length;
  if (errorCount > 0) return { diagnostics };
  return { model: doc.parseResult?.value as Model, diagnostics };
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

async function handleGenerate(text: string): Promise<GenerateResult> {
  const parsed = await parse(text);
  if (!parsed.model) return { ok: false, diagnostics: parsed.diagnostics };

  // IR-level validation: catches issues that survive Langium's
  // checks (e.g. `api.<unknown>.<verb>` references in `test e2e`
  // bodies).  See `src/ir/validate.ts`.
  let loom;
  try {
    loom = enrichLoomModel(lowerModel(parsed.model));
  } catch (err) {
    return {
      ok: false,
      diagnostics: [
        ...parsed.diagnostics,
        {
          severity: "error",
          message: `Lowering failed: ${err instanceof Error ? err.message : String(err)}`,
          source: "loom-ir",
        },
      ],
    };
  }
  const irDiags = validateLoomModel(loom).map((d) => ({
    severity: d.severity === "error" ? ("error" as const) : ("warning" as const),
    message: d.message,
    source: typeof d.source === "string" ? d.source : "loom-ir",
  }));
  const irErrors = irDiags.filter((d) => d.severity === "error");
  if (irErrors.length > 0) {
    return { ok: false, diagnostics: [...parsed.diagnostics, ...irDiags] };
  }

  // System mode wins when the source declares any `system { ... }`
  // block; otherwise fall back to the legacy single-Hono-project
  // generator so bare-context examples still produce something useful.
  if (loom.systems.length > 0) {
    try {
      const out = generateSystems(parsed.model).files;
      return {
        ok: true,
        mode: "system",
        files: filesFromMap(out),
        diagnostics: [...parsed.diagnostics, ...irDiags],
      };
    } catch (err) {
      return {
        ok: false,
        diagnostics: [
          ...parsed.diagnostics,
          ...irDiags,
          {
            severity: "error",
            message: `generateSystems failed: ${err instanceof Error ? err.message : String(err)}`,
            source: "loom-gen",
          },
        ],
      };
    }
  }
  if (loom.contexts.length > 0) {
    try {
      const out = generateTypeScript(parsed.model, HONO_V4_PINS);
      return {
        ok: true,
        mode: "ts",
        files: filesFromMap(out),
        diagnostics: [...parsed.diagnostics, ...irDiags],
      };
    } catch (err) {
      return {
        ok: false,
        diagnostics: [
          ...parsed.diagnostics,
          ...irDiags,
          {
            severity: "error",
            message: `generateTypeScript failed: ${err instanceof Error ? err.message : String(err)}`,
            source: "loom-gen",
          },
        ],
      };
    }
  }
  return {
    ok: true,
    mode: "none",
    files: [],
    diagnostics: [
      ...parsed.diagnostics,
      ...irDiags,
      {
        severity: "warning",
        message: "Source has no contexts or systems — nothing to generate.",
        source: "loom-gen",
      },
    ],
  };
}

/** Resolve `generate`'s source: inline `text` (legacy) or VFS-read
 *  via `entryPath` (Phase 2+).  Exactly one form must be set. */
function resolveGenerateSource(params: { text?: string; entryPath?: string }): string {
  const hasText = typeof params.text === "string";
  const hasPath = typeof params.entryPath === "string";
  if (hasText && hasPath) {
    throw new Error(
      "build.generate: pass either `text` or `entryPath`, not both.",
    );
  }
  if (hasText) return params.text!;
  if (hasPath) {
    const src = workerVfs.read(params.entryPath!);
    if (src == null) {
      throw new Error(
        `build.generate: entryPath "${params.entryPath}" not found in VFS.`,
      );
    }
    return src;
  }
  throw new Error("build.generate: missing `text` or `entryPath`.");
}

self.onmessage = async (ev: MessageEvent<BuildRpcRequest>) => {
  const req = ev.data;
  const response: BuildRpcResponse = { id: req.id };
  try {
    switch (req.method) {
      case "generate": {
        const text = resolveGenerateSource(req.params);
        response.result = await handleGenerate(text);
        break;
      }
      case "vfs.write": {
        // Hydrate batches the listener fan-out into a single
        // notification, which is the right shape for a multi-file
        // workspace push (e.g. dropping a custom pack folder in
        // Phase 4).  Single-file writes go through the same path —
        // hydrate's notification batch is a no-op when there's only
        // one path.
        workerVfs.hydrate(req.params.entries.map((e) => [e.path, e.content]));
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
      case "vfs.list": {
        response.result = {
          ok: true,
          paths: [...workerVfs.list(req.params.prefix)],
        };
        break;
      }
      case "vfs.snapshot": {
        const snap = workerVfs.snapshot();
        const entries = Array.from(snap.entries(), ([path, content]) => ({
          path,
          content,
        }));
        entries.sort((a, b) => a.path.localeCompare(b.path));
        response.result = { ok: true, entries };
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
