// Shared bundler plugin logic.  Both the browser worker
// (`bundler.worker.ts` via `esbuild-wasm/lib/browser`) and any
// Node-side smoke (regular `esbuild`) instantiate the same plugin
// against the same set of virtual files.  esbuild's `Plugin` shape
// is identical between the two distributions so the import
// `type` here resolves correctly under either.

import type { Loader, Plugin, PluginBuild } from "esbuild-wasm";
import { VIRTUAL_SHIMS } from "./aliases.js";

const ENTRY_NAMESPACE = "virtual-fs";
const SHIM_NAMESPACE = "virtual-shim";
const HTTP_NAMESPACE = "http-url";

// esm.sh ESM service.  We pin to a major channel and let it serve
// the latest patch — the generated backend doesn't pin versions
// either, so this matches the shape of the real-world `npm install`
// the CLI workflow does.
export const ESM_HOST = "https://esm.sh";

// Versions for packages NOT in the generator's package.json but
// still pulled in by the runtime layer.  Pinning here keeps the
// bundle and the runtime worker's WASM URLs aligned — the worker
// fetches PGlite's WASM/data artifacts at this same version (see
// runtime/runtime.worker.ts).
export const RUNTIME_VERSIONS: Record<string, string> = {
  "@electric-sql/pglite": "0.4.5",
};

// PGlite ships three artifacts the runtime needs in addition to
// its JS: pglite.wasm, initdb.wasm, and pglite.data (the seed
// Postgres data dir).  esm.sh serves only JS+WASM, not raw .data
// files, so the runtime worker fetches these from jsdelivr's
// CDN — same package on disk, just a different mirror.
export function pgliteAssetUrl(file: "pglite.wasm" | "initdb.wasm" | "pglite.data"): string {
  const version = RUNTIME_VERSIONS["@electric-sql/pglite"];
  return `https://cdn.jsdelivr.net/npm/@electric-sql/pglite@${version}/dist/${file}`;
}

export interface VirtualFsContext {
  files: Map<string, string>;
  fetchedUrls: Set<string>;
  fetchCache: Map<string, string>;
  /** Pkg name → semver range, harvested from the virtual fs's
   *  package.json.  Lets esm.sh URLs pin to the same versions
   *  the generator declared, so we get e.g. drizzle-orm@^0.36.0
   *  instead of esm.sh's "latest" (which breaks at 0.45.2). */
  versions: Map<string, string>;
}

// Pull the `dependencies` map out of the first top-level
// package.json in the virtual fs.  System-mode emits one
// package.json per deployable folder (`<slug>/package.json`),
// legacy mode emits a single root package.json — both shapes
// resolve the same way: we take whichever is shallowest.
// The bundle entry stdin.  We re-export everything the runtime
// worker needs from a single bundle, so there's exactly one drizzle
// instance in play (a separate `import "drizzle-orm/pglite"` in the
// runtime would create a parallel instance and break `is(x, Table)`
// checks against tables built by the bundled generated code).
//
// `entryPath` and `schemaPath` are forward-slash paths relative to
// the virtual fs root (e.g. "http/index.ts", "db/schema.ts" for
// legacy mode; "<slug>/http/index.ts" / "<slug>/db/schema.ts" for
// system mode).
export function makeEntryStdin(entryPath: string, schemaPath: string): string {
  return [
    `export { createApp } from "./${entryPath}";`,
    `export * as schema from "./${schemaPath}";`,
    `export { drizzle } from "drizzle-orm/pglite";`,
    `export { PGlite } from "@electric-sql/pglite";`,
    `export { is, Table } from "drizzle-orm";`,
    `export { getTableConfig } from "drizzle-orm/pg-core";`,
    "",
  ].join("\n");
}

// Given the deployable's HTTP entry path, derive its sibling
// schema.ts path.  Replaces the last two segments
// (`http/index.ts`) with `db/schema.ts`.
export function schemaPathFor(entryPath: string): string {
  const segs = entryPath.split("/");
  return [...segs.slice(0, -2), "db", "schema.ts"].join("/");
}

export function harvestVersions(files: Map<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  let bestPath: string | null = null;
  for (const path of files.keys()) {
    if (!path.endsWith("package.json")) continue;
    if (bestPath === null || path.split("/").length < bestPath.split("/").length) {
      bestPath = path;
    }
  }
  if (!bestPath) return out;
  try {
    const pkg = JSON.parse(files.get(bestPath)!) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
      out.set(name, range);
    }
  } catch {
    // Malformed package.json — fall back to unversioned esm.sh URLs.
  }
  return out;
}

// Apply the harvested version to a bare-spec esm.sh URL.  Inputs
// are bare specifiers like `drizzle-orm`, `drizzle-orm/pg-core`,
// `@hono/zod-openapi`, `hono/cors`.  Pins to the package head;
// sub-paths inherit that version.  Falls back to RUNTIME_VERSIONS
// for packages we add at the runtime layer.
export function pinnedEsmShUrl(spec: string, versions: Map<string, string>): string {
  const head = spec.startsWith("@")
    ? spec.split("/").slice(0, 2).join("/")
    : spec.split("/")[0];
  const range = versions.get(head) ?? RUNTIME_VERSIONS[head];
  if (!range) return `${ESM_HOST}/${spec}`;
  // esm.sh accepts npm semver ranges directly: e.g. "^0.36.0".  The
  // service resolves it server-side to a specific version.
  const tail = spec.slice(head.length); // "" or "/pg-core"
  return `${ESM_HOST}/${head}@${range}${tail}`;
}

// Tiny semaphore — esbuild parallelises onLoad callbacks, but
// esm.sh starts returning 503s at high concurrency.  Capping at
// 6 in-flight requests is empirically fine for ~50-module
// bundles and keeps wall-clock close to the unrestricted case.
function makeSemaphore(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let inFlight = 0;
  const queue: Array<() => void> = [];
  const release = () => {
    inFlight--;
    const next = queue.shift();
    if (next) next();
  };
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (inFlight >= max) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    inFlight++;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

// Resolve a relative import against an importer path within the
// virtual filesystem.  Both paths are forward-slash; mirrors how
// Loom emits files.
export function resolveRelative(importer: string, spec: string): string {
  const base = importer.split("/").slice(0, -1);
  const parts = spec.split("/");
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") base.pop();
    else base.push(p);
  }
  return base.join("/");
}

// The generator emits TS files but writes import specifiers with
// .js extensions (Node16 module style).  Our virtual map keys are
// .ts, so we try both when resolving.
export function resolveInFs(fs: Map<string, string>, candidate: string): string | undefined {
  if (fs.has(candidate)) return candidate;
  if (candidate.endsWith(".js")) {
    const ts = candidate.slice(0, -3) + ".ts";
    if (fs.has(ts)) return ts;
  }
  if (fs.has(candidate + ".ts")) return candidate + ".ts";
  if (fs.has(candidate + "/index.ts")) return candidate + "/index.ts";
  return undefined;
}

const SHIMS_BY_SPEC = new Map(VIRTUAL_SHIMS.map((s) => [s.specifier, s]));

export function makeLoomPlugin(ctx: VirtualFsContext): Plugin {
  const httpGate = makeSemaphore(6);
  return {
    name: "loom-bundler",
    setup(build: PluginBuild) {
      // Entry resolution: a virtual entry placeholder lives at
      // `__entry__` in the virtual-fs namespace.  esbuild will call
      // onResolve for it first; we hand it back as-is.
      build.onResolve({ filter: /^__entry__$/ }, (args) => ({
        path: args.path,
        namespace: ENTRY_NAMESPACE,
      }));

      // Aliased shims always win — checked before the bare-import
      // fall-through below.
      build.onResolve({ filter: /.*/ }, (args) => {
        const shim = SHIMS_BY_SPEC.get(args.path);
        if (!shim) return undefined;
        return { path: args.path, namespace: SHIM_NAMESPACE };
      });

      // Relative imports within the virtual fs.  Fires for the
      // stdin entry (which has no namespace) and for transitive
      // virtual-fs files; http-namespace files have their own
      // resolver below.
      build.onResolve({ filter: /^\.\.?\// }, (args) => {
        if (args.namespace === HTTP_NAMESPACE) return undefined;
        // The stdin importer is a synthetic path like
        // `<stdin>` or the configured sourcefile.  We treat any
        // non-virtual-fs importer as the virtual root (empty
        // string), so an entry import `"./http/index.ts"`
        // resolves to the bare key `http/index.ts`.
        const importerInFs =
          args.namespace === ENTRY_NAMESPACE ? args.importer : "";
        const resolved = resolveRelative(importerInFs, args.path);
        const inFs = resolveInFs(ctx.files, resolved);
        if (!inFs) {
          return {
            errors: [
              {
                text: `Cannot resolve "${args.path}" from "${args.importer}" in virtual fs`,
              },
            ],
          };
        }
        return { path: inFs, namespace: ENTRY_NAMESPACE };
      });

      // Bare specifiers from user code → esm.sh, pinned to the
      // version range the generator declared in package.json.
      build.onResolve({ filter: /^[^./]/ }, (args) => {
        if (args.namespace === HTTP_NAMESPACE) return undefined;
        if (args.path.startsWith("node:")) {
          return {
            errors: [
              {
                text: `Refusing to bundle Node builtin "${args.path}". Add a shim if this is reachable in the browser runtime.`,
              },
            ],
          };
        }
        return {
          path: pinnedEsmShUrl(args.path, ctx.versions),
          namespace: HTTP_NAMESPACE,
        };
      });

      // Imports from inside an http-namespace file.  Could be a
      // relative path ("./foo.js") or another bare specifier.  esm.sh
      // returns ESM with absolute URLs for transitive deps in most
      // cases, but its bundle responses occasionally use relative
      // paths — handle both.
      build.onResolve({ filter: /.*/, namespace: HTTP_NAMESPACE }, (args) => {
        if (/^https?:\/\//.test(args.path)) {
          return { path: args.path, namespace: HTTP_NAMESPACE };
        }
        if (args.path.startsWith("/")) {
          return { path: `${ESM_HOST}${args.path}`, namespace: HTTP_NAMESPACE };
        }
        const resolved = new URL(args.path, args.importer).toString();
        return { path: resolved, namespace: HTTP_NAMESPACE };
      });

      build.onLoad({ filter: /.*/, namespace: ENTRY_NAMESPACE }, (args) => {
        const contents = ctx.files.get(args.path);
        if (contents === undefined) {
          return { errors: [{ text: `Virtual fs missing "${args.path}"` }] };
        }
        const loader: Loader = args.path.endsWith(".tsx")
          ? "tsx"
          : args.path.endsWith(".ts")
            ? "ts"
            : args.path.endsWith(".json")
              ? "json"
              : "js";
        return { contents, loader };
      });

      build.onLoad({ filter: /.*/, namespace: SHIM_NAMESPACE }, (args) => {
        const shim = SHIMS_BY_SPEC.get(args.path);
        if (!shim) {
          return { errors: [{ text: `No shim registered for "${args.path}"` }] };
        }
        return { contents: shim.source, loader: shim.loader };
      });

      build.onLoad({ filter: /.*/, namespace: HTTP_NAMESPACE }, async (args) => {
        const cached = ctx.fetchCache.get(args.path);
        if (cached !== undefined) return { contents: cached, loader: "js" };
        ctx.fetchedUrls.add(args.path);
        return httpGate(async () => {
          // Re-check cache inside the gate — a previous request for
          // the same URL may have completed while we were queued.
          const inner = ctx.fetchCache.get(args.path);
          if (inner !== undefined) return { contents: inner, loader: "js" };
          // esm.sh still occasionally 503s even with concurrency
          // limited; retry transient 5xx and network errors with
          // exponential backoff.
          const maxAttempts = 5;
          let lastErr = "";
          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
              const res = await fetch(args.path);
              if (res.ok) {
                const text = await res.text();
                ctx.fetchCache.set(args.path, text);
                return { contents: text, loader: "js" };
              }
              lastErr = `Fetch failed (${res.status})`;
              // 4xx is terminal; only retry 5xx + 408/429.
              if (res.status < 500 && res.status !== 408 && res.status !== 429) break;
            } catch (err) {
              lastErr = `Network error: ${err instanceof Error ? err.message : String(err)}`;
            }
            if (attempt < maxAttempts) {
              const backoff = 300 * 2 ** (attempt - 1);
              await new Promise((r) => setTimeout(r, backoff));
            }
          }
          return { errors: [{ text: `${lastErr} for ${args.path}` }] };
        });
      });
    },
  };
}
