// ---------------------------------------------------------------------------
// Dependency model — the input that decides which npm packages a
// prepared build may resolve, and *how* each one is resolved.
//
// This is P0 scaffolding for the playground refactor: pure types +
// a resolver seam.  Nothing consumes it yet.  P6 threads a real
// `DependencySet` through `RuntimeEngine.prepare`; the resolution
// strategies below are the staged answer to "let users add packages":
//
//   - verified        curated, version-pinned, known-good (one-click).
//   - custom-public    arbitrary public npm; resolved via the engine's
//                       public resolver (today: esm.sh) with peer-dep
//                       singletons auto-externalised.
//   - custom-vendored  user-supplied source/tarball written straight
//                       into the VFS — private packages with ZERO
//                       backend.  Available as soon as P6 lands.
//   - custom-private   resolved by an injected `RegistryResolver`
//                       (a future, optional, credentialed proxy).
//                       The seam is declared now so adding it later is
//                       plug-in work behind the engine, not a refactor.
// ---------------------------------------------------------------------------

import type { VirtualFile } from "../build/protocol.js";

export type DependencyResolution =
  | "verified"
  | "custom-public"
  | "custom-vendored"
  | "custom-private";

/** A package the prepared build is allowed to import. */
export interface DependencySpec {
  /** Bare package name, e.g. `lucide-react` or `@scope/pkg`. */
  name: string;
  /** Semver range, honoured by the install/resolution. */
  range: string;
  resolution: DependencyResolution;
}

/** Source for a `custom-vendored` package: the package's own files,
 *  rooted as if under `node_modules/<name>/`.  The engine writes
 *  these into its VFS so the bundler/runtime resolves them locally —
 *  no registry, no credentials, no proxy. */
export interface VendoredPackage {
  name: string;
  files: VirtualFile[];
}

export interface DependencySet {
  specs: DependencySpec[];
  /** Present only when `specs` contains `custom-vendored` entries. */
  vendored?: VendoredPackage[];
}

export function emptyDependencySet(): DependencySet {
  return { specs: [] };
}

// ---------------------------------------------------------------------------
// RegistryResolver — the future seam for `custom-private`.
//
// Deliberately NOT implemented in this cycle.  A hosted, credentialed
// proxy is a backend/product decision with its own trust surface;
// declaring the interface now keeps the door open without committing
// to the backend.  An engine that supports private packages accepts
// an optional resolver; one that doesn't simply rejects
// `custom-private` specs with a clear message.
// ---------------------------------------------------------------------------

export interface ResolvedTarball {
  name: string;
  version: string;
  /** Extracted package files, rooted as `node_modules/<name>/…`. */
  files: VirtualFile[];
}

export interface RegistryResolver {
  /** Resolve one `custom-private` spec to its extracted files.
   *  Implementations carry their own (server-side) credentials;
   *  callers never see them. */
  resolve(spec: DependencySpec): Promise<ResolvedTarball>;
}
