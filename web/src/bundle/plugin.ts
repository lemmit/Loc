// Shared bundler helpers used by the npm-in-browser engine: package
// version harvesting, tsconfig-alias harvesting, the synthetic bundle
// entry, and PGlite asset/URL pinning.  The actual esbuild resolver
// lives in `engine/npm/esbuild-vfs-plugin.ts` (real in-VFS
// node_modules, no CDN); this module is just the platform-neutral
// helpers it and the engine consume.

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
// Postgres data dir).  The runtime worker fetches these from
// jsdelivr's CDN — same package as the installed tarball, just a
// mirror that serves the raw .data file.
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
// dist directory on jsdelivr (see engine/npm/postprocess.ts).
export function pgliteImportMetaUrl(): string {
  const version = RUNTIME_VERSIONS["@electric-sql/pglite"];
  return `https://cdn.jsdelivr.net/npm/@electric-sql/pglite@${version}/dist/index.mjs`;
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

// Read the entry's nearest `tsconfig.json` and extract any
// `compilerOptions.paths` mappings as alias entries ready for the
// resolver.  The shadcn pack (and any future pack that uses the
// `@/*` convention) ships a tsconfig with `"@/*": ["./src/*"]`,
// pointing imports like `@/components/ui/button` at the file
// `<slug>/src/components/ui/button.tsx` in the virtual fs.
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

// The generator emits TS / TSX files but writes import specifiers
// with .js extensions (Node16 module style).  Virtual-fs keys are
// .ts / .tsx, so try both when resolving.  Used by the Node-side
// smoke to confirm the entry + schema exist before bundling.
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
