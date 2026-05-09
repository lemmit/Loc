/// <reference lib="webworker" />
import { EmptyFileSystem, URI } from "langium";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";
import { lowerModel } from "../../../src/ir/lower.js";
import { enrichLoomModel } from "../../../src/ir/enrichments.js";
import { validateLoomModel } from "../../../src/ir/validate.js";
import { generateSystems } from "../../../src/system/index.js";
import { generateTypeScript } from "../../../src/generator/typescript/index.js";
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
      const out = generateTypeScript(parsed.model);
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

self.onmessage = async (ev: MessageEvent<BuildRpcRequest>) => {
  const req = ev.data;
  const response: BuildRpcResponse = { id: req.id };
  try {
    if (req.method === "generate") {
      response.result = await handleGenerate(req.params.text);
    } else {
      response.error = { message: `Unknown method: ${(req as { method: string }).method}` };
    }
  } catch (err) {
    response.error = {
      message: err instanceof Error ? err.message : String(err),
    };
  }
  self.postMessage(response);
};
