// ---------------------------------------------------------------------------
// fs-backed `discoverBackends()` source (see docs/packaging-split.md).
//
// Node-only.  Walks the consuming project's `node_modules` shallowly
// for `package.json` entries whose `loom.kind === "backend"`, and
// emits one `DiscoveredBackend` per match.  This module is the
// counterpart of B3c's `NpmInstallBundleEngine`'s `node-resolve.ts`
// — same fs/node_modules shape, but for *backend-package
// discovery* rather than dep resolution.
//
// This is intentionally narrow: the discovered manifest is paired
// with the surface from the *in-tree* default set (looked up by
// family@version).  The byte-identical guarantee falls out: a
// workspace where `@loom/backend-hono-v4` is symlinked under
// `node_modules/@loom/backend-hono-v4` resolves `hono@v4` through
// the fs source to the *same* `honoPlatform` instance the in-tree
// source returns — so `===` identity holds and every
// downstream resolver is unaffected.  A later step would replace the
// in-tree lookup with `await import(pkg.main)`'s default export, at which
// point the workspace symlink becomes the true source of code, not
// just the source of the manifest.
//
// Composition with the in-tree default (in-tree fills any
// family@version the fs walk didn't find) is done in
// `installFsBackendSource` so callers don't have to re-implement
// the merge.  Importantly: the in-tree source is the LIVE seam, not
// a snapshot — `setBackendSource` swaps the seam wholesale, so the
// merged set must already include every in-tree backend the fs walk
// didn't pick up (otherwise resolving e.g. dotnet/phoenix would
// silently return undefined when only @loom/backend-hono-v4 is
// installed).
// ---------------------------------------------------------------------------

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { LoomBackendManifest } from "./manifest.js";
import type { DiscoveredBackend } from "./registry.js";
import { defaultBuiltInBackends, setBackendSource } from "./registry.js";

interface RawPackageJson {
  name?: string;
  loom?: unknown;
}

async function readPackageJsonSafe(dir: string): Promise<RawPackageJson | null> {
  try {
    const raw = await fs.readFile(path.join(dir, "package.json"), "utf8");
    return JSON.parse(raw) as RawPackageJson;
  } catch {
    return null;
  }
}

/** Coerce an arbitrary `loom` field into a typed manifest, or
 *  `null` if it doesn't look like a backend manifest.  Mirrors the
 *  shape of `LoomBackendManifest` from `manifest.ts` — keep the
 *  field set in lockstep with that interface. */
function asBackendManifest(loom: unknown): LoomBackendManifest | null {
  if (typeof loom !== "object" || loom === null) return null;
  const m = loom as Record<string, unknown>;
  if (m.kind !== "backend") return null;
  if (
    typeof m.family !== "string" ||
    typeof m.loomVersion !== "string" ||
    typeof m.core !== "string"
  ) {
    return null;
  }
  return {
    kind: "backend",
    family: m.family,
    loomVersion: m.loomVersion,
    core: m.core,
  };
}

/** Yield every installed package directory under
 *  `<root>/node_modules`, one level deep (unscoped) or two levels
 *  (scoped `@x/y`).  Hidden entries (`.bin`, `.package-lock.json`)
 *  are skipped.  Missing `node_modules` yields nothing (e.g. a
 *  fresh checkout before `npm install`). */
async function* walkInstalledPackages(nodeModules: string): AsyncGenerator<string> {
  let entries: string[];
  try {
    entries = await fs.readdir(nodeModules);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const full = path.join(nodeModules, entry);
    if (entry.startsWith("@")) {
      let scoped: string[];
      try {
        scoped = await fs.readdir(full);
      } catch {
        continue;
      }
      for (const s of scoped) {
        if (s.startsWith(".")) continue;
        yield path.join(full, s);
      }
    } else {
      yield full;
    }
  }
}

/** Read every installed package under `<rootDir>/node_modules` and
 *  emit a `DiscoveredBackend` for each one declaring
 *  `loom.kind === "backend"` in its `package.json`.  See module
 *  header for the surface-resolution policy. */
export async function discoverBackendsFs(rootDir: string): Promise<DiscoveredBackend[]> {
  const inTree = defaultBuiltInBackends();
  const out: DiscoveredBackend[] = [];
  const nm = path.join(rootDir, "node_modules");
  for await (const pkgDir of walkInstalledPackages(nm)) {
    const pkg = await readPackageJsonSafe(pkgDir);
    if (!pkg) continue;
    const manifest = asBackendManifest(pkg.loom);
    if (!manifest) continue;
    const match = inTree.find(
      (b) =>
        b.manifest.family === manifest.family && b.manifest.loomVersion === manifest.loomVersion,
    );
    if (!match) {
      // Discovered manifest with no matching in-tree code: silently
      // skip so unknown installed packages don't break resolution.
      // (A later step could resolve these via dynamic `import(pkg)`.)
      continue;
    }
    out.push({ manifest, surface: match.surface });
  }
  return out;
}

/** Walk fs and install a composed source: every fs-discovered
 *  backend, plus every in-tree backend the fs walk didn't pick up
 *  (so dotnet@v8 / phoenixLiveView@v1 — not yet packaged — still
 *  resolve).  Idempotent at the registry level; safe to call once
 *  at CLI startup. */
export async function installFsBackendSource(rootDir: string): Promise<void> {
  const fsBackends = await discoverBackendsFs(rootDir);
  const inTree = defaultBuiltInBackends();
  const merged: DiscoveredBackend[] = [...fsBackends];
  for (const it of inTree) {
    const alreadyFromFs = fsBackends.some(
      (b) =>
        b.manifest.family === it.manifest.family &&
        b.manifest.loomVersion === it.manifest.loomVersion,
    );
    if (!alreadyFromFs) merged.push(it);
  }
  setBackendSource(() => merged);
}
