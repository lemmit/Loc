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
// Virtual module standing in for `react-dom/client`.  esm.sh's
// repackaging just forwards to react-dom's createRoot accessor,
// which trips React's "you should import from react-dom/client"
// dev warning.  Our shim sets the internal usingClientEntryPoint
// flag the way react-dom/client.js does in the real package, so
// the warning stays quiet.
const RDC_SHIM_NAMESPACE = "virtual-rdc-shim";

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

// PGlite computes asset URLs as `new URL("./pglite.wasm", import.meta.url)`
// and friends.  When the runtime worker loads our bundle from a
// `blob:` URL, `import.meta.url` resolves to that blob URL — and
// the URL constructor throws "Invalid URL" because blob: URLs
// can't serve as a base for relative resolution.  PGlite also
// computes one of those URLs unconditionally, before checking the
// asset-injection options, so the throw can't be avoided just by
// passing pre-compiled modules.
//
// Fix: post-process the bundle output to replace every
// `import.meta.url` with a real http URL pointing at PGlite's
// dist directory on jsdelivr.  Three things now align:
//   1. Relative resolution succeeds (jsdelivr is a normal http URL).
//   2. The resulting URLs (`./pglite.wasm`, `./initdb.wasm`,
//      `./pglite.data` against that base) point at real files,
//      so even if the asset-injection short-circuits don't fire,
//      PGlite's fallback fetch finds something.
//   3. The runtime worker's pre-fetched assets continue to
//      short-circuit those fetches, so we still avoid one round-trip.
//
// All `import.meta.url` references in the bundle are inside
// PGlite — the Loom-generated code, hono, drizzle, and zod don't
// use it — so the blanket replace is safe.
export function pgliteImportMetaUrl(): string {
  const version = RUNTIME_VERSIONS["@electric-sql/pglite"];
  return `https://cdn.jsdelivr.net/npm/@electric-sql/pglite@${version}/dist/index.mjs`;
}

// Force PGlite's browser code path.  Three Emscripten init sites
// contain the same Node-vs-browser detection (`typeof A7.versions.node
// == "string"` on PGlite's process polyfill).  In a real browser
// worker the polyfill doesn't set `versions.node`, so the detection
// already returns false; flattening it explicitly is cheap and makes
// the bundle behave identically across hosts (incl. our Node smoke).
//
// Both substitutions below are textual, hand-tuned to the exact
// shape of the current PGlite + esbuild output.  When that shape
// drifts (PGlite version bump, esbuild minifier change), the
// regex/replace silently no-ops and the bundle ships with the
// detection still in — leading to a cryptic Node-API runtime error.
// Validate that each substitution actually hit at least once and
// throw a clear error otherwise.  Catches the failure at bundle
// time, not after Boot.
const PGLITE_NODE_DETECTION =
  /typeof A7 == "object" && typeof A7\.versions == "object" && typeof A7\.versions\.node == "string"/g;

export function postProcessBundle(code: string): string {
  const nodeMatches = (code.match(PGLITE_NODE_DETECTION) ?? []).length;
  const importMetaMatches = (code.match(/import\.meta\.url/g) ?? []).length;

  if (nodeMatches === 0) {
    throw new Error(
      "postProcessBundle: PGlite Node-detection regex didn't match any site — " +
        "Emscripten output likely changed.  Inspect the bundle's `typeof process.versions.node` " +
        "neighbourhood and update PGLITE_NODE_DETECTION in web/src/bundle/plugin.ts.",
    );
  }
  if (importMetaMatches === 0) {
    throw new Error(
      "postProcessBundle: no `import.meta.url` references in the bundle — " +
        "PGlite's URL-relative asset loading may have moved to a different mechanism.  " +
        "Re-verify the WASM/data injection path in runtime/runtime.worker.ts.",
    );
  }

  let out = code;
  out = out.replace(PGLITE_NODE_DETECTION, "false");
  out = out.replaceAll("import.meta.url", JSON.stringify(pgliteImportMetaUrl()));
  return out;
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
  /** TypeScript path-alias mappings (e.g. `@/*` → `<slug>/src/*`)
   *  harvested from the entry's nearest `tsconfig.json`.  Optional:
   *  callers that don't need alias resolution (Node-side smoke
   *  scripts, legacy single-context bundles) can omit it; the
   *  plugin treats `undefined` as "no aliases".  Each alias key
   *  keeps the trailing `*` if present so the resolver can
   *  substitute the matched suffix; static aliases (no `*`) are
   *  stored verbatim. */
  tsconfigPaths?: TsconfigAliasEntry[];
}

/** One alias mapping derived from a tsconfig `compilerOptions.paths`
 *  entry.  Patterns are anchored at the start of the import
 *  specifier; `prefix` is what comes before the optional `*`, and
 *  `targets` are the substitution candidates (also `prefix + *` form).
 *  All paths are virtual-fs absolute (no leading `/`, forward slashes). */
export interface TsconfigAliasEntry {
  /** Text before the `*` in the pattern, or the whole pattern when
   *  it's a static (non-wildcard) alias.  e.g. `@/` for `@/*`,
   *  `@app/foo` for `@app/foo`. */
  prefix: string;
  /** True iff the original pattern had a `*` wildcard. */
  wildcard: boolean;
  /** Substitution candidates, each pre-resolved against the
   *  tsconfig's base directory.  For wildcard aliases each target
   *  keeps a trailing `*` placeholder. */
  targets: string[];
}

// Specifiers we hand off to an importmap in the iframe instead of
// inlining their code into the bundle.
//
// Critical observation: esm.sh canonicalises each package's
// "external" set down to only the specifiers that package actually
// uses, encoding the set in an `X-...` path segment.  So
// `?external=react,react-dom` and `?external=react,react-dom,react-dom/client`
// produce DIFFERENT URLs for `@mantine/core` only if Mantine
// actually uses `react-dom/client` directly.  It doesn't —
// Mantine uses just `react,react-dom`.
//
// If we externalise more than that at the top level, our import
// goes to one shard while transitive Mantine imports (from
// `@mantine/notifications`, `@mantine/modals`, …) propagate the
// shorter set and end up at a different shard.  Two shards = two
// `@mantine/core` modules in the bundle = two MantineProvider
// contexts = the runtime "MantineProvider was not found" crash.
//
// Fix: keep the external list to the minimum the bundle's user
// code needs to share an instance.  `react` and `react-dom` are
// shared by everyone; `react/jsx-runtime`, `react/jsx-dev-runtime`,
// and `react-dom/client` get bundled inline by esbuild, but their
// own `import "react"` / `import "react-dom"` calls remain
// external — so there's still one React/React-DOM at runtime.
export const REACT_RUNTIME_EXTERNALS = ["react", "react-dom"];

const REACT_EXTERNAL_SET = new Set(REACT_RUNTIME_EXTERNALS);

// Query string we tack on every esm.sh package URL when bundling
// for React.  esm.sh propagates this through transitive shard URLs
// (encoded as the `X-...` path segment), so packages that import
// `react` internally — Mantine, react-router-dom, etc. — also keep
// `react` as a bare external in their bundled output.  Single React
// instance in the importmap == single React instance at runtime.
//
// Slashes inside list items have to be URL-encoded — esm.sh's
// query parser treats `react/jsx-runtime` as starting a new path
// segment otherwise and 404s the request.
const ESM_REACT_EXTERNAL_QS = `external=${REACT_RUNTIME_EXTERNALS.map(encodeURIComponent).join(",")}`;

export interface PluginOptions {
  /** When true, mark React runtime modules external (for the
   *  iframe importmap to satisfy at load time) and append
   *  `?external=react,...` to esm.sh package URLs so transitive
   *  deps share the same React instance. */
  externalReactRuntime?: boolean;
}

// Pull the `dependencies` map out of the package.json that's
// closest to the bundle entry.  System-mode emits one
// package.json per deployable folder (`<slug>/package.json`) —
// the Hono backend's package.json has Hono+Drizzle deps, the
// React frontend's has Mantine+React+react-router-dom etc.
// Picking the wrong one means we miss version pins and esm.sh
// happily serves "latest" — which for Mantine v9.x targets React
// 19 and breaks under React 18.x.  Caller threads the entry
// path so we can walk upward; legacy mode falls back to the
// shallowest package.json in the tree.
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

export function harvestVersions(
  files: Map<string, string>,
  /** Entry path inside the virtual fs (e.g. "web_app/src/main.tsx").
   *  Used to pick the nearest package.json by walking upward.
   *  Falls back to the shallowest package.json when omitted or
   *  when no ancestor package.json exists. */
  entryPath?: string,
): Map<string, string> {
  const out = new Map<string, string>();
  const allPkgPaths = [...files.keys()].filter((p) => p.endsWith("package.json"));
  if (allPkgPaths.length === 0) return out;

  let chosen: string | null = null;
  if (entryPath) {
    // Walk up from the entry directory.  For "web_app/src/main.tsx"
    // we try "web_app/src/package.json", then "web_app/package.json",
    // then "package.json" — first match wins.
    const segs = entryPath.split("/");
    for (let i = segs.length - 1; i >= 0; i--) {
      const candidate = [...segs.slice(0, i), "package.json"].join("/");
      if (files.has(candidate)) {
        chosen = candidate;
        break;
      }
    }
  }
  if (!chosen) {
    chosen = allPkgPaths.reduce((a, b) =>
      a.split("/").length <= b.split("/").length ? a : b,
    );
  }

  try {
    const pkg = JSON.parse(files.get(chosen)!) as {
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

// Read the entry's nearest `tsconfig.json` and extract any
// `compilerOptions.paths` mappings as alias entries ready for the
// resolver.  The shadcn pack (and any future pack that uses the
// `@/*` convention) ships a tsconfig with `"@/*": ["./src/*"]`,
// pointing imports like `@/components/ui/button` at the file
// `<slug>/src/components/ui/button.tsx` in the virtual fs.  Without
// reading this, the bundler treats `@/components` as a bare package
// and tries to fetch it from esm.sh — which is what produced the
// "package not declared" errors on the shadcn example.
//
// Walks upward from the entry's directory, picks the first
// `tsconfig.json` it finds, and resolves every `paths` target
// against the tsconfig's directory + optional `baseUrl`.  Strips
// any leading `./` so the substituted paths match the keys we
// store in the virtual fs (relative, forward-slash).
//
// Comments inside the tsconfig are silently tolerated: many starter
// templates emit `// auto-generated`-style banners that JSON.parse
// would otherwise choke on.
export function harvestTsconfigPaths(
  files: Map<string, string>,
  entryPath: string,
): TsconfigAliasEntry[] {
  const segs = entryPath.split("/");
  let chosen: string | null = null;
  let chosenDir = "";
  for (let i = segs.length - 1; i >= 0; i--) {
    const candidate = [...segs.slice(0, i), "tsconfig.json"].join("/");
    if (files.has(candidate)) {
      chosen = candidate;
      chosenDir = segs.slice(0, i).join("/");
      break;
    }
  }
  if (!chosen) return [];

  const raw = files.get(chosen)!;
  // Strip `// line` comments so JSON.parse accepts the VS-Code-
  // flavoured tsconfigs many starter templates ship.  Block
  // `/* ... */` comments are NOT stripped — doing so naïvely would
  // misfire on `/*` substrings inside JSON strings (e.g. the
  // `"@/*": ["./src/*"]` paths every shadcn-style project has).
  // The `[^:]` lookbehind keeps `://` substrings (URLs) intact.
  const stripped = raw.replace(/(^|[^:])\/\/.*$/gm, "$1");
  let parsed: { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return [];
  }
  const co = parsed.compilerOptions;
  if (!co || !co.paths) return [];

  // baseUrl resolves against the tsconfig's directory.  Most packs
  // ship `"baseUrl": "."`; some omit it.  Either way we collapse to
  // a virtual-fs-style forward-slash path with no leading `/`.
  const baseUrl = (co.baseUrl ?? ".").replace(/^\.\/?/, "");
  const baseDir = baseUrl
    ? joinVfsPath(chosenDir, baseUrl)
    : chosenDir;

  const out: TsconfigAliasEntry[] = [];
  for (const [pattern, rawTargets] of Object.entries(co.paths)) {
    const wildcardIdx = pattern.indexOf("*");
    const wildcard = wildcardIdx !== -1;
    // Reject patterns with a `*` mid-string (`foo*bar`) — neither
    // tsc nor any of our packs use them; matching them right would
    // need a regex and adds risk we don't want here.
    if (wildcard && wildcardIdx !== pattern.length - 1) continue;
    const prefix = wildcard ? pattern.slice(0, -1) : pattern;
    const targets: string[] = [];
    for (const target of rawTargets) {
      const trimmed = target.replace(/^\.\/?/, "");
      const targetWildcardIdx = trimmed.indexOf("*");
      // Skip targets whose wildcard placement disagrees with the
      // pattern's — same defensive reasoning as above.
      if (wildcard) {
        if (targetWildcardIdx !== trimmed.length - 1) continue;
        targets.push(joinVfsPath(baseDir, trimmed.slice(0, -1)) + "*");
      } else {
        if (targetWildcardIdx !== -1) continue;
        targets.push(joinVfsPath(baseDir, trimmed));
      }
    }
    if (targets.length > 0) out.push({ prefix, wildcard, targets });
  }
  // Longer prefixes match first — same tsc semantics, so a more
  // specific alias (`@app/api/*`) wins over a catch-all (`@app/*`).
  out.sort((a, b) => b.prefix.length - a.prefix.length);
  return out;
}

function joinVfsPath(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return `${a}/${b}`;
}

/** Try every alias against `spec`; return the rewritten virtual-fs
 *  path (the first target that successfully resolves into `files`),
 *  or `null` when no alias matches or no target hits a file.  Walks
 *  candidates in tsc's listed order — same as how `tsc` itself
 *  resolves alias collisions. */
export function applyTsconfigAlias(
  spec: string,
  aliases: TsconfigAliasEntry[],
  files: Map<string, string>,
): string | null {
  for (const entry of aliases) {
    if (entry.wildcard) {
      if (!spec.startsWith(entry.prefix)) continue;
      const tail = spec.slice(entry.prefix.length);
      for (const target of entry.targets) {
        const candidate = target.endsWith("*")
          ? target.slice(0, -1) + tail
          : target;
        const resolved = resolveInFs(files, candidate);
        if (resolved) return resolved;
      }
    } else {
      if (spec !== entry.prefix) continue;
      for (const target of entry.targets) {
        const resolved = resolveInFs(files, target);
        if (resolved) return resolved;
      }
    }
  }
  return null;
}

// Apply the harvested version to a bare-spec esm.sh URL.  Inputs
// are bare specifiers like `drizzle-orm`, `drizzle-orm/pg-core`,
// `@hono/zod-openapi`, `hono/cors`.  Pins to the package head;
// sub-paths inherit that version.  Falls back to RUNTIME_VERSIONS
// for packages we add at the runtime layer.
//
// `unpinned` controls behaviour when neither `versions` nor
// RUNTIME_VERSIONS knows about the package head.
//   - `"strict"` (top-level user imports): throw a loud,
//     actionable error.  This is the case the post-mortem flagged
//     — silent fallthrough to esm.sh "latest" gave us the Mantine
//     v9 leak under React 18.
//   - `"lenient"` (transitive bare imports inside esm.sh-fetched
//     responses): fall back to the unversioned URL.  esm.sh's own
//     transitive resolution still pins via its `?deps=...`
//     propagation, and we have no clean way to enumerate every
//     possible bare import esm.sh might emit (clsx, get-nonce,
//     tabbable, etc. — they're peer deps of our pinned packages
//     and aren't in the user's package.json).
export function pinnedEsmShUrl(
  spec: string,
  versions: Map<string, string>,
  opts?: PluginOptions,
  unpinned: "strict" | "lenient" = "strict",
): string {
  const head = spec.startsWith("@")
    ? spec.split("/").slice(0, 2).join("/")
    : spec.split("/")[0];
  const range = versions.get(head) ?? RUNTIME_VERSIONS[head];
  const tail = spec.slice(head.length); // "" or "/pg-core"
  const externalsQs = opts?.externalReactRuntime
    ? `?${ESM_REACT_EXTERNAL_QS}`
    : "";

  if (range) {
    return `${ESM_HOST}/${head}@${range}${tail}${externalsQs}`;
  }
  if (unpinned === "strict") {
    throw new Error(
      `pinnedEsmShUrl: top-level import of "${spec}" — package "${head}" is not declared in the ` +
        `entry's nearest package.json (and isn't in RUNTIME_VERSIONS either).  esm.sh would resolve ` +
        `to "latest", which has bitten us before (Mantine v9 leaked into a React 18 build).  ` +
        `Add "${head}": "<semver>" to the relevant package.json, or to RUNTIME_VERSIONS in ` +
        `web/src/bundle/plugin.ts if it's a runtime-layer dep.`,
    );
  }
  return `${ESM_HOST}/${spec}${externalsQs}`;
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

// The generator emits TS / TSX files but writes import specifiers
// with .js extensions (Node16 module style).  Our virtual map keys
// are .ts / .tsx, so we try both when resolving.
export function resolveInFs(fs: Map<string, string>, candidate: string): string | undefined {
  if (fs.has(candidate)) return candidate;
  if (candidate.endsWith(".js")) {
    const ts = candidate.slice(0, -3) + ".ts";
    if (fs.has(ts)) return ts;
    const tsx = candidate.slice(0, -3) + ".tsx";
    if (fs.has(tsx)) return tsx;
  }
  if (fs.has(candidate + ".ts")) return candidate + ".ts";
  if (fs.has(candidate + ".tsx")) return candidate + ".tsx";
  if (fs.has(candidate + "/index.ts")) return candidate + "/index.ts";
  if (fs.has(candidate + "/index.tsx")) return candidate + "/index.tsx";
  return undefined;
}

const SHIMS_BY_SPEC = new Map(VIRTUAL_SHIMS.map((s) => [s.specifier, s]));

export function makeLoomPlugin(ctx: VirtualFsContext, opts?: PluginOptions): Plugin {
  const httpGate = makeSemaphore(6);
  const externalReactRuntime = !!opts?.externalReactRuntime;
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

      // React runtime externals always win — kept as bare imports
      // in the output so the iframe importmap can satisfy them.
      // Must fire before any other resolver, including the shim
      // table and the http resolver, so it catches both top-level
      // user imports AND `import "react"` inside esm.sh-fetched
      // transitive deps.
      if (externalReactRuntime) {
        build.onResolve({ filter: /.*/ }, (args) => {
          if (REACT_EXTERNAL_SET.has(args.path)) {
            return { path: args.path, external: true };
          }
          return undefined;
        });

        // `react-dom/client` shim.  esm.sh's
        // react-dom/client just forwards `react-dom`'s createRoot
        // accessor without setting the internal `usingClientEntryPoint`
        // flag, so React logs a deprecation warning ("you should
        // import createRoot from react-dom/client").  We re-implement
        // the wrapper exactly like the real react-dom/client.js does:
        // toggle the secret-internals flag around each call so the
        // warning's runtime check sees `usingClientEntryPoint=true`.
        build.onResolve({ filter: /^react-dom\/client$/ }, (args) => {
          if (args.namespace === HTTP_NAMESPACE) return undefined;
          return {
            path: "loom-rdc-shim",
            namespace: RDC_SHIM_NAMESPACE,
          };
        });
        build.onLoad({ filter: /.*/, namespace: RDC_SHIM_NAMESPACE }, () => ({
          contents: [
            `import * as ReactDOM from "react-dom";`,
            "",
            "const internals =",
            "  ReactDOM.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;",
            "",
            "export function createRoot(container, options) {",
            "  if (internals) internals.usingClientEntryPoint = true;",
            "  try { return ReactDOM.createRoot(container, options); }",
            "  finally { if (internals) internals.usingClientEntryPoint = false; }",
            "}",
            "",
            "export function hydrateRoot(container, initialChildren, options) {",
            "  if (internals) internals.usingClientEntryPoint = true;",
            "  try { return ReactDOM.hydrateRoot(container, initialChildren, options); }",
            "  finally { if (internals) internals.usingClientEntryPoint = false; }",
            "}",
            "",
            "// `import ReactDOM from \"react-dom/client\"` (default-import",
            "// form, what the generator emits in main.tsx) needs a default",
            "// export shaped like a namespace.",
            "export default { createRoot, hydrateRoot };",
            "",
          ].join("\n"),
          loader: "js",
        }));
      }

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

      // TypeScript `compilerOptions.paths` aliases (e.g. shadcn's
      // `@/components/ui/button` → `<slug>/src/components/ui/button.tsx`).
      // Has to win over the bare-specifier resolver below, otherwise
      // `@/foo` gets shipped off to esm.sh as a "package not declared"
      // failure.  Skipped when the entry has no tsconfig or the
      // alias's targets don't resolve — those cases keep falling
      // through to the bare-specifier handler (which is the right
      // behaviour for unaliased imports like `@radix-ui/react-slot`).
      const tsconfigPaths = ctx.tsconfigPaths ?? [];
      if (tsconfigPaths.length > 0) {
        build.onResolve({ filter: /^[^./]/ }, (args) => {
          if (args.namespace === HTTP_NAMESPACE) return undefined;
          const aliased = applyTsconfigAlias(args.path, tsconfigPaths, ctx.files);
          if (!aliased) return undefined;
          return { path: aliased, namespace: ENTRY_NAMESPACE };
        });
      }

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
          path: pinnedEsmShUrl(args.path, ctx.versions, opts),
          namespace: HTTP_NAMESPACE,
        };
      });

      // Imports from inside an http-namespace file.  Three flavours:
      //   - absolute URL (`https://…`) — keep as-is.
      //   - host-absolute (`/foo`) — resolve against esm.sh.
      //   - bare specifier (`react/jsx-runtime`, `clsx`) — esm.sh's
      //     responses sometimes leave bare imports for externalised
      //     deps and for sub-paths esm.sh chose not to inline.  Pin
      //     these through the same `pinnedEsmShUrl` machinery so they
      //     come back as bare-package URLs (not paths relative to
      //     the importer URL, which 404s).
      //   - everything else is treated as a relative URL against the
      //     importer.
      build.onResolve({ filter: /.*/, namespace: HTTP_NAMESPACE }, (args) => {
        if (/^https?:\/\//.test(args.path)) {
          return { path: args.path, namespace: HTTP_NAMESPACE };
        }
        if (args.path.startsWith("/")) {
          return { path: `${ESM_HOST}${args.path}`, namespace: HTTP_NAMESPACE };
        }
        if (!args.path.startsWith(".")) {
          // Bare specifier inside an esm.sh-fetched response
          // (peer-dep imports like `clsx`, `get-nonce`, etc.).  Use
          // lenient mode: these aren't in the user's package.json
          // and esm.sh's own resolution still pins versions via
          // its `?deps=...` propagation.
          return {
            path: pinnedEsmShUrl(args.path, ctx.versions, opts, "lenient"),
            namespace: HTTP_NAMESPACE,
          };
        }
        const resolved = new URL(args.path, args.importer).toString();
        return { path: resolved, namespace: HTTP_NAMESPACE };
      });

      build.onLoad({ filter: /.*/, namespace: ENTRY_NAMESPACE }, (args) => {
        const contents = ctx.files.get(args.path);
        if (contents === undefined) {
          return { errors: [{ text: `Virtual fs missing "${args.path}"` }] };
        }
        // `.css` files (e.g. the shadcn pack's globals.css) need the
        // CSS loader so esbuild treats them as side-effecting
        // stylesheets and pipes them into the bundle's .css output.
        // Without this, the default `js` loader parses Tailwind
        // `@tailwind base;` directives as decorators and crashes.
        const loader: Loader = args.path.endsWith(".tsx")
          ? "tsx"
          : args.path.endsWith(".ts")
            ? "ts"
            : args.path.endsWith(".json")
              ? "json"
              : args.path.endsWith(".css")
                ? "css"
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
        // CSS responses (Mantine stylesheets fetched via esm.sh)
        // need the CSS loader so esbuild treats the import as a
        // side-effecting stylesheet and pipes it into the .css
        // output file.  Detect via the URL — esm.sh serves CSS
        // under /<pkg>/<file>.css with text/css content-type, but
        // checking the path is cheaper than a HEAD round-trip.
        const isCss = /\.css(\?|$)/.test(args.path);
        const loader: "js" | "css" = isCss ? "css" : "js";
        const cached = ctx.fetchCache.get(args.path);
        if (cached !== undefined) return { contents: cached, loader };
        ctx.fetchedUrls.add(args.path);
        return httpGate(async () => {
          // Re-check cache inside the gate — a previous request for
          // the same URL may have completed while we were queued.
          const inner = ctx.fetchCache.get(args.path);
          if (inner !== undefined) return { contents: inner, loader };
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
                return { contents: text, loader };
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
