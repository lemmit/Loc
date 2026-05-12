// ---------------------------------------------------------------------------
// VFS-backed pack loader (browser-only).
//
// Mirrors `src/generator/_packs/loader-fs.ts` (the Node fs
// adapter) but reads from a worker-local in-memory VFS instead of
// the disk.  The pure compile core lives in
// `src/generator/_packs/loader.ts` (`compilePack`) and is shared
// by both adapters — only the IO seam differs.
//
// Vite's `loomLoaderShim` plugin (`web/vite.config.ts`) rewrites
// `import "./_packs/loader-fs.js"` to this file in browser
// builds, so the React generator's import line stays as-is and the
// Node CLI continues to use the real fs adapter.
//
// HARD CONSTRAINT: every read here is sync.  The generator's render
// path is sync end-to-end; making the loader async would propagate
// through every preparer + page renderer and break the Node
// adapter's contract.  Pre-population of the VFS happens at worker
// init via `seedBuiltinPacks` + the Phase 2 mutate-RPC; by the time
// generation runs, every required path is already resident.
// ---------------------------------------------------------------------------

import {
  compilePack,
  type LoadedPack,
  type PackManifest,
} from "../../../src/generator/_packs/loader.js";
import { parseBuiltinDesignRef } from "../../../src/generator/_packs/builtin-formats.js";
import type { VfsPath } from "../vfs/types.js";
import { getWorkerVfs } from "./worker-vfs.js";

/** Top-level VFS dirs that hold pack-agnostic Handlebars sources
 *  (Vite scaffold, API integration, Docker artifacts).  Mirrors the
 *  on-disk repo-root layout — see `loader-fs.ts`. */
const SHARED_SOURCE_DIRS = ["/vite/", "/api/", "/docker/"] as const;

/** POSIX-style path join — duplicating the relevant slice of
 *  `node:path/posix` rather than importing it so this module stays
 *  free of any node:* dependency.  Only handles the cases the
 *  loader needs: absolute roots, single-segment appends, and
 *  `..`/`.` collapse via the VFS's own `normalize` (re-applied here
 *  because we don't want to feed a half-resolved path to `vfs.read`). */
function joinPosix(...parts: string[]): VfsPath {
  if (parts.length === 0) return "/";
  let result = parts[0];
  for (let i = 1; i < parts.length; i++) {
    if (result.endsWith("/")) result = result + parts[i];
    else result = result + "/" + parts[i];
  }
  // Collapse `..` / `.` segments (Node's `path.posix.resolve` does
  // this; the VFS rejects unresolved `..` at read time so doing it
  // here keeps error messages anchored to the loader call site).
  const segs: string[] = [];
  for (const seg of result.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (segs.length === 0) {
        throw new Error(`loader-vfs: path escapes root: "${result}"`);
      }
      segs.pop();
      continue;
    }
    segs.push(seg);
  }
  return "/" + segs.join("/");
}

/** Resolve a `design:` slot value to a VFS path.  Mirrors the Node
 *  `resolvePackDir` contract: built-in `family@version` refs →
 *  `/designs/<family>/<version>`; absolute paths used as-is;
 *  relative paths anchored against `referenceDir` (defaults to
 *  `/workspace`, the playground root).  Bareword built-ins (no
 *  `@version`) resolve through the shared `parseBuiltinDesignRef`
 *  helper so the family→default-version map (`BUILTIN_PACK_LATEST`)
 *  is the single source of truth across both loaders. */
export function resolvePackDir(ui: string, referenceDir?: VfsPath): VfsPath {
  const parsed = parseBuiltinDesignRef(ui);
  if (parsed) {
    return `/designs/${parsed.family}/${parsed.version}`;
  }
  if (ui.startsWith("/")) return ui;
  return joinPosix(referenceDir ?? "/workspace", ui);
}

/** Load a pack from the worker's VFS.  Reads `<packDir>/pack.json`,
 *  walks every entry in the manifest's `emits`, pulls the .hbs
 *  source from the VFS, and hands the lot to `compilePack`. */
export function loadPack(packDir: VfsPath): LoadedPack {
  const vfs = getWorkerVfs();
  const manifestPath = joinPosix(packDir, "pack.json");
  const manifestSource = vfs.read(manifestPath);
  if (manifestSource == null) {
    throw new Error(
      `loader-vfs: pack manifest not found at ${manifestPath}.  A pack must contain a pack.json file.`,
    );
  }
  const manifest = JSON.parse(manifestSource) as PackManifest;
  if (!manifest.emits || typeof manifest.emits !== "object") {
    throw new Error(
      `loader-vfs: pack at ${packDir} has no \`emits\` map in pack.json.  Add { emits: { "page-list": "page-list.hbs", ... } }.`,
    );
  }
  // Phase 0 pack-versioning cross-check.  Built-in packs land at
  // `/designs/<family>/<version>/`; the version segment is
  // load-bearing for resolution, so a mismatch with manifest.version
  // means a copy-paste fork left the manifest stale.  Bail loudly
  // instead of silently shadowing sibling packs.  Only fires for
  // paths that match the built-in layout.
  const m = packDir.match(/^\/designs\/([^/]+)\/([^/]+)$/);
  if (m && manifest.version !== m[2]) {
    throw new Error(
      `loader-vfs: pack at ${packDir} has version="${manifest.version}" but lives under directory "${m[2]}".  The two must match (e.g. /designs/mantine/v7/pack.json must declare "version": "v7").`,
    );
  }
  const sources: Record<string, string> = {};
  for (const [logicalName, fileName] of Object.entries(manifest.emits)) {
    const filePath = joinPosix(packDir, fileName);
    const src = vfs.read(filePath);
    if (src == null) {
      throw new Error(
        `loader-vfs: pack ${manifest.name}: template "${logicalName}" → "${fileName}" not found at ${filePath}.`,
      );
    }
    sources[logicalName] = src;
  }
  // Pull shared templates from the top-level shared dirs (vite/, api/,
  // docker/ in the on-disk layout; mirrored to /vite/, /api/, /docker/
  // in the VFS by the seeder) and pass them to compilePack so they
  // register as pack-agnostic partials.
  const sharedSources: Record<string, string> = {};
  for (const dir of SHARED_SOURCE_DIRS) {
    for (const p of vfs.list(dir)) {
      if (!p.endsWith(".hbs")) continue;
      const slash = p.lastIndexOf("/");
      const logicalName = p.slice(slash + 1, -".hbs".length);
      if (sharedSources[logicalName] != null) {
        throw new Error(
          `loader-vfs: duplicate shared template "${logicalName}" — defined under multiple shared dirs.  Logical names must be unique across ${SHARED_SOURCE_DIRS.join(", ")}.`,
        );
      }
      const src = vfs.read(p);
      if (src != null) sharedSources[logicalName] = src;
    }
  }
  // Phase 0.5: stack partials.  Same mechanism as the per-pack
  // sharedSources above — when the manifest declares a stack, every
  // `.hbs` in `/stacks/<id>/` is registered alongside the shared
  // templates.  See `loader-fs.ts` for the on-disk mirror; the VFS
  // seeder (`template-bundled.ts`) pre-loads the stack directories
  // exactly like it does for designs/.
  if (manifest.stack) {
    const stackDir = `/stacks/${manifest.stack}`;
    const stackPaths = vfs.list(stackDir);
    if (stackPaths.length === 0) {
      throw new Error(
        `loader-vfs: pack ${manifest.name}@${manifest.version} declares stack="${manifest.stack}" but no templates found at ${stackDir}.`,
      );
    }
    for (const p of stackPaths) {
      if (!p.endsWith(".hbs")) continue;
      const slash = p.lastIndexOf("/");
      const logicalName = p.slice(slash + 1, -".hbs".length);
      if (sharedSources[logicalName] != null) {
        throw new Error(
          `loader-vfs: stack ${manifest.stack} partial '${logicalName}' clashes with an existing shared template name.  Rename one.`,
        );
      }
      const src = vfs.read(p);
      if (src != null) sharedSources[logicalName] = src;
    }
  }
  return compilePack(
    packDir,
    manifest,
    sources,
    (f) => joinPosix(packDir, f),
    sharedSources,
  );
}
