/// <reference lib="webworker" />
import * as esbuild from "esbuild-wasm";
// Vite serves the .wasm asset; `?url` returns a same-origin URL the
// worker can hand to esbuild.initialize.
import wasmURL from "esbuild-wasm/esbuild.wasm?url";
import type {
  BundleDiagnostic,
  BundleRequest,
  BundleResult,
  BundleRpcRequest,
  BundleRpcResponse,
} from "./protocol.js";
import type { VirtualFile } from "../build/protocol.js";
import {
  harvestTsconfigPaths,
  harvestVersions,
  makeEntryStdin,
  makeLoomPlugin,
  resolveInFs,
  postProcessBundle,
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

// Persistent fetch cache, scoped to the worker's lifetime.
//
// The interactive playground hits the bundler many times in a
// session (every Generate → Bundle click; auto-bundle on edit
// once that lands).  Each Bundle pulls ~140 esm.sh modules; if the
// cache were per-call, we'd re-fetch all of them on every click.
// Keying on the full URL is safe — different version pins produce
// different URLs, so a source edit that bumps a dep hits a fresh
// cache entry.  Old entries linger but aren't expensive: at ~10 KB
// average, the upper bound is single-digit MB even for a session
// that touches every example.
//
// `fetchedUrls` stays per-bundle (drives the "X deps fetched"
// counter in the footer); a warm bundle reports 0 fetched, which
// is exactly the signal we want.
const persistentFetchCache = new Map<string, string>();

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

async function handleBundle(req: BundleRequest): Promise<BundleResult> {
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
    // Module-level cache so repeated Bundle clicks don't re-fetch
    // the ~140 esm.sh modules each call needs.
    fetchCache: persistentFetchCache,
    // Pick the package.json closest to the entry so we get the
    // backend's Hono/Drizzle pins for kind=hono and the
    // frontend's React/Mantine pins for kind=react.
    versions: harvestVersions(fs, entryInFs),
    // Read the entry's nearest tsconfig.json for any `@/*`-style
    // path aliases.  Empty when no tsconfig is present (legacy mode,
    // Hono-only bundles).
    tsconfigPaths: harvestTsconfigPaths(fs, entryInFs),
  };

  // Hono kind: stdin re-exports the runtime surface (createApp,
  // schema, drizzle, PGlite, …) so the runtime worker imports a
  // single self-contained ESM module.
  // React kind: stdin is a side-effecting `import` of the
  // generator's main.tsx, which mounts the React tree on
  // document.getElementById("root") at evaluation time.
  let stdinContents: string;
  let stdinLoader: "ts" | "tsx";
  if (req.kind === "hono") {
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
    stdinContents = makeEntryStdin(entryInFs, schemaInFs);
    stdinLoader = "ts";
  } else {
    stdinContents = `import "./${entryInFs}";\n`;
    stdinLoader = "tsx";
  }

  const externalReactRuntime = req.kind === "react";

  const start = performance.now();
  let result: esbuild.BuildResult;
  try {
    result = await esbuild.build({
      stdin: {
        contents: stdinContents,
        resolveDir: "/",
        sourcefile: req.kind === "react" ? "__entry__.tsx" : "__entry__.ts",
        loader: stdinLoader,
      },
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      logLevel: "silent",
      write: false,
      sourcemap: false,
      jsx: "automatic",
      // outdir is required when bundling JS that imports CSS so
      // esbuild can name the CSS companion; with write:false the
      // path is purely virtual — we read both outputs from
      // result.outputFiles.
      outdir: "/__loom_bundle__",
      // - .wasm "binary": PGlite ships WASM as a binary-import; we
      //   inline as a Uint8Array so the bundle stays self-contained.
      // - .css "css": React-platform code does
      //   `import "@mantine/core/styles.css"`.  esbuild handles the
      //   import as a side-effecting CSS file and emits a separate
      //   .css output we then ship to the iframe via a <style> tag.
      loader: { ".wasm": "binary", ".css": "css" },
      plugins: [makeLoomPlugin(ctx, { externalReactRuntime })],
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

  const jsOut = result.outputFiles?.find((f) => f.path.endsWith(".js"));
  const cssOut = result.outputFiles?.find((f) => f.path.endsWith(".css"));
  if (!jsOut) {
    return {
      ok: false,
      diagnostics: [
        { severity: "error", message: "esbuild produced no JS output file" },
      ],
    };
  }

  // Post-process is hono-specific: the rewrites only matter for
  // PGlite's URL-construction sites.  React bundles get the raw
  // esbuild output.
  const code = req.kind === "hono" ? postProcessBundle(jsOut.text) : jsOut.text;
  const css = cssOut?.text;

  // Forward the harvested package.json versions on react bundles
  // so the iframe importmap can pin React/React-DOM to the same
  // esm.sh version the bundle's external imports point at.
  const versions =
    req.kind === "react"
      ? Object.fromEntries(ctx.versions)
      : undefined;

  return {
    ok: true,
    kind: req.kind,
    code,
    css,
    size: code.length,
    durationMs,
    fetchedUrls: [...ctx.fetchedUrls].sort(),
    versions,
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
