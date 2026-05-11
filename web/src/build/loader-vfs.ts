// ---------------------------------------------------------------------------
// VFS-backed pack loader (browser-only).
//
// Mirrors `src/generator/react/templating/loader-fs.ts` (the Node
// fs adapter) but reads from a worker-local in-memory VFS instead
// of the disk.  The pure compile core lives in
// `src/generator/react/templating/loader.ts` (`compilePack`) and is
// shared by both adapters — only the IO seam differs.
//
// Vite's `loomLoaderShim` plugin (`web/vite.config.ts`) rewrites
// `import "./templating/loader-fs.js"` to this file in browser
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
} from "../../../src/generator/react/templating/loader.js";
import type { VfsPath } from "../vfs/types.js";
import { getWorkerVfs } from "./worker-vfs.js";

/** Built-in pack names — reserved.  `resolvePackDir` matches these
 *  before treating `ui` as a user-supplied path, so a workspace pack
 *  cannot shadow them.  Mantine and shadcn ship in the playground
 *  bundle via `seedBuiltinPacks`. */
const BUILTIN_PACKS = new Set(["mantine", "shadcn"]);

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
 *  `resolvePackDir` contract: built-in names → `/designs/<name>`;
 *  absolute paths used as-is; relative paths anchored against
 *  `referenceDir` (defaults to `/workspace`, the playground root). */
export function resolvePackDir(ui: string, referenceDir?: VfsPath): VfsPath {
  if (BUILTIN_PACKS.has(ui)) {
    return `/designs/${ui}`;
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
  return compilePack(
    packDir,
    manifest,
    sources,
    (f) => joinPosix(packDir, f),
    sharedSources,
  );
}
