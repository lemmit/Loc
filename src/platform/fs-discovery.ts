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
// source returns — so `===` identity holds and every downstream
// resolver is unaffected.  Only the manifest is honoured from the
// symlinked package; the surface still comes from the in-tree default
// set (paired by family@version).
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
import {
  coreRangeSatisfies,
  type LoomBackendManifest,
  PLATFORM_SURFACE_CONTRACT,
} from "./manifest.js";
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

/** One-line discovery warning on stderr.  A malformed manifest, an unknown
 *  family/version, or a core-version mismatch is a package-author mistake the
 *  adopter must see — never a silent skip (which is how a mis-pinned backend
 *  used to vanish with no explanation). */
function warnDiscovery(pkg: string, message: string): void {
  console.warn(`loom: backend discovery skipped '${pkg}' — ${message}`);
}

/** Classification of a package's `loom` field:
 *   - `notLoom`   — no `loom` block, or one not describing a backend (a
 *                   `core` / `mcp-server` / future design-pack block): skip
 *                   quietly, it isn't ours to warn about.
 *   - `malformed` — a `kind: "backend"` block missing required string
 *                   fields: warn, it's a broken backend manifest.
 *   - `backend`   — a well-formed backend manifest. */
type ManifestClass =
  | { kind: "notLoom" }
  | { kind: "malformed"; reason: string }
  | { kind: "backend"; manifest: LoomBackendManifest };

/** Classify an arbitrary `loom` field.  Mirrors the shape of
 *  `LoomBackendManifest` from `manifest.ts` — keep the field set in lockstep
 *  with that interface. */
function classifyManifest(loom: unknown): ManifestClass {
  if (typeof loom !== "object" || loom === null) return { kind: "notLoom" };
  const m = loom as Record<string, unknown>;
  if (m.kind !== "backend") return { kind: "notLoom" };
  const missing = (["family", "loomVersion", "core"] as const).filter(
    (k) => typeof m[k] !== "string",
  );
  if (missing.length > 0) {
    return {
      kind: "malformed",
      reason: `backend manifest missing/invalid field(s): ${missing.join(", ")}`,
    };
  }
  return {
    kind: "backend",
    manifest: {
      kind: "backend",
      family: m.family as string,
      loomVersion: m.loomVersion as string,
      core: m.core as string,
    },
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
    const pkgName = pkg.name ?? path.basename(pkgDir);
    const cls = classifyManifest(pkg.loom);
    if (cls.kind === "notLoom") continue;
    if (cls.kind === "malformed") {
      warnDiscovery(pkgName, cls.reason);
      continue;
    }
    const { manifest } = cls;
    // Core-contract gate: the manifest's `core` semver range must admit the
    // running `PlatformSurface` contract version, else this package was built
    // against a different ABI — refuse it loudly instead of pairing it with a
    // possibly-incompatible in-tree surface.
    if (!coreRangeSatisfies(manifest.core, PLATFORM_SURFACE_CONTRACT)) {
      warnDiscovery(
        pkgName,
        `its loom.core range '${manifest.core}' does not satisfy the running core contract ${PLATFORM_SURFACE_CONTRACT}`,
      );
      continue;
    }
    const match = inTree.find(
      (b) =>
        b.manifest.family === manifest.family && b.manifest.loomVersion === manifest.loomVersion,
    );
    if (!match) {
      // Discovered a well-formed backend manifest with no matching in-tree
      // code (unknown family / version) — warn rather than vanish, so a typo
      // or an unpackaged family surfaces to the adopter.
      warnDiscovery(
        pkgName,
        `unknown backend family/version '${manifest.family}@${manifest.loomVersion}' — no in-tree surface pairs with it`,
      );
      continue;
    }
    out.push({ manifest, surface: match.surface });
  }
  return out;
}

/** Walk fs and install a composed source: every fs-discovered
 *  backend, plus every in-tree backend the fs walk didn't pick up
 *  (so dotnet@v10 / phoenixLiveView@v1 — not yet packaged — still
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
