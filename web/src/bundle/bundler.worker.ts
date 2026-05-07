/// <reference lib="webworker" />
import * as esbuild from "esbuild-wasm";
// Vite serves the .wasm asset; `?url` returns a same-origin URL the
// worker can hand to esbuild.initialize.
import wasmURL from "esbuild-wasm/esbuild.wasm?url";
import type {
  BundleDiagnostic,
  BundleResult,
  BundleRpcRequest,
  BundleRpcResponse,
} from "./protocol.js";
import type { VirtualFile } from "../build/protocol.js";
import {
  harvestVersions,
  makeEntryStdin,
  makeLoomPlugin,
  resolveInFs,
  schemaPathFor,
  type VirtualFsContext,
} from "./plugin.js";

declare const self: DedicatedWorkerGlobalScope;

// esbuild-wasm needs a one-time init.  We do it lazily on the first
// bundle so the worker boots cheaply if the user never clicks Bundle.
let initPromise: Promise<void> | null = null;
async function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = esbuild.initialize({ wasmURL, worker: false });
  }
  return initPromise;
}

function buildVirtualFs(files: VirtualFile[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const f of files) map.set(f.path, f.content);
  return map;
}

function toDiagnostic(severity: "error" | "warning", m: esbuild.Message): BundleDiagnostic {
  return {
    severity,
    message: m.text,
    file: m.location?.file,
    line: m.location?.line,
    column: m.location?.column,
  };
}

async function handleBundle(req: {
  files: VirtualFile[];
  entryPath: string;
}): Promise<BundleResult> {
  await ensureInit();

  const fs = buildVirtualFs(req.files);
  const entryInFs = resolveInFs(fs, req.entryPath);
  if (!entryInFs) {
    return {
      ok: false,
      diagnostics: [
        {
          severity: "error",
          message: `Entry "${req.entryPath}" not in virtual fs.  Available paths: ${[...fs.keys()].slice(0, 6).join(", ")}…`,
        },
      ],
    };
  }

  const ctx: VirtualFsContext = {
    files: fs,
    fetchedUrls: new Set(),
    fetchCache: new Map(),
    versions: harvestVersions(fs),
  };

  const schemaPath = schemaPathFor(entryInFs);
  const schemaInFs = resolveInFs(fs, schemaPath);
  if (!schemaInFs) {
    return {
      ok: false,
      diagnostics: [
        {
          severity: "error",
          message: `Schema "${schemaPath}" not in virtual fs alongside entry "${entryInFs}".`,
        },
      ],
    };
  }

  const start = performance.now();
  let result: esbuild.BuildResult;
  try {
    result = await esbuild.build({
      stdin: {
        contents: makeEntryStdin(entryInFs, schemaInFs),
        resolveDir: "/",
        sourcefile: "__entry__.ts",
        loader: "ts",
      },
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      logLevel: "silent",
      write: false,
      sourcemap: false,
      // PGlite ships its WASM as a binary import — let esbuild
      // inline it as base64 + a Uint8Array so the bundle stays a
      // single self-contained ESM module.
      loader: { ".wasm": "binary" },
      plugins: [makeLoomPlugin(ctx)],
    });
  } catch (err) {
    const failure = err as esbuild.BuildFailure;
    if (failure.errors) {
      return {
        ok: false,
        diagnostics: [
          ...failure.errors.map((m) => toDiagnostic("error", m)),
          ...(failure.warnings ?? []).map((m) => toDiagnostic("warning", m)),
        ],
      };
    }
    return {
      ok: false,
      diagnostics: [
        {
          severity: "error",
          message: `esbuild crashed: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }
  const durationMs = Math.round(performance.now() - start);

  const out = result.outputFiles?.[0];
  if (!out) {
    return {
      ok: false,
      diagnostics: [
        { severity: "error", message: "esbuild produced no output files" },
      ],
    };
  }
  return {
    ok: true,
    code: out.text,
    size: out.contents.byteLength,
    durationMs,
    fetchedUrls: [...ctx.fetchedUrls].sort(),
    diagnostics: [
      ...result.errors.map((m) => toDiagnostic("error", m)),
      ...result.warnings.map((m) => toDiagnostic("warning", m)),
    ],
  };
}

self.onmessage = async (ev: MessageEvent<BundleRpcRequest>) => {
  const req = ev.data;
  const response: BundleRpcResponse = { id: req.id };
  try {
    if (req.method === "bundle") {
      response.result = await handleBundle(req.params);
    } else {
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
