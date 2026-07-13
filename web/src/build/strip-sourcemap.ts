// Playground DevTools `.ddd` debugging — the byte-identical safety core.
//
// GOAL: the in-browser boot bundle carries an inline Source Map v3
// chaining back to `.ddd` (so DevTools can breakpoint the running
// backend in source), WHILE the Files pane and the git-backed
// workspace store stay byte-identical to today's `sourcemap`-off
// output.
//
// MECHANISM: `App.tsx`'s `runGenerateStep` issues the SAME `generate`
// RPC it always has, with the flag OFF, for the view + the
// "scaffold then own" persist — that call is architecturally
// untouched, so byte-identical is a tautology there, not an invariant
// that has to be independently re-verified against every backend's
// future codegen change.  It then issues a SECOND, separate generate
// with `{ sourcemap: true }` used ONLY to feed the bundler.
//
// Why not "generate once with maps, then strip the artifacts back
// off" (the naive single-generate design)?  Investigated and
// rejected: on fresh `main`, `--sourcemap` no longer adds just
// sidecar files.  `src/generator/typescript/debug-imports.ts` (M18)
// rewrites EVERY relative import specifier in EVERY generated `.ts`
// file of a `node` deployable, `package.json` gains a `debug` script,
// `tsconfig.json` gains `allowImportingTsExtensions`, and the .NET
// backend's M26 debug wiring inlines `#line (r,c)-(r,c) "<path>.ddd"` /
// `#line default` directives INSIDE every generated method body. That
// delta is backend-specific, uneven, and open-ended — a future
// backend's own debug-wiring addition would silently break a
// single-argument "reverse the mutation" strip with no test able to
// catch it ahead of time. A DIFF between the two actual generates
// (this file's `overlaySourcemapArtifacts`) never needs to know what
// shape a backend's debug wiring takes; it just asks "did this path's
// content change under the flag", which stays correct no matter what
// future backends add. See `test/playground/strip-sourcemap.test.ts`.
//
// `stripSourcemapArtifacts` is kept as a narrow, defensive filter
// (drop the well-known NEW top-level artifact paths + the trailing
// `sourceMappingURL` directive) — a cheap no-op belt-and-suspenders
// on data that should already be maps-free by construction, not the
// mechanism the byte-identical guarantee actually rests on.
import type { VirtualFile } from "./protocol.js";

const MAP_SIDECAR_RE = /\.(map|smap)$/;
const SOURCEMAP_MANIFEST_PATH = ".loom/sourcemap.json";
const VSCODE_LAUNCH_PATH = ".vscode/launch.json";
const SOURCE_MAPPING_URL_RE = /\/\/# sourceMappingURL=\S+\n$/;
// A trailing `//# sourceMappingURL=<relative>.map` directive whose target is a
// sidecar file (not already an inline `data:` URI).  Captures the URL so the
// sidecar can be resolved + inlined for the browser bundler.
const SIDECAR_DIRECTIVE_RE = /\/\/# sourceMappingURL=(?!data:)(\S+?\.map)\s*$/;

/** UTF-8-safe base64 (the `.ddd` `sourcesContent` in the map is UTF-8; plain
 *  `btoa` throws on code points > 0xFF). Browser-only (this module is `web/`). */
function toBase64Utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Directory prefix of a VFS path (`a/b/c.ts` → `a/b/`, `c.ts` → ``). */
function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i + 1);
}

/**
 * Rewrite each generated `.ts`/`.tsx` whose trailing `//# sourceMappingURL`
 * points at a sidecar `.map` file into an INLINE `data:` source map, and drop
 * the now-redundant sidecar files.
 *
 * WHY (the load-bearing reason — see `web/e2e/devtools-sourcemap.spec.ts`):
 * the in-browser bundler is esbuild-**wasm**, which has no filesystem, so it
 * CANNOT read a `.ts.map` sidecar referenced by a `//# sourceMappingURL`
 * comment — it silently skips the chain, and the boot bundle's map then stops
 * at the generated `.ts` (`vfs:/…`) instead of reaching `.ddd`.  node esbuild
 * reads the sidecar from disk and composes fine; esbuild-wasm does not.
 * Inlining the `.ts → .ddd` map into the `.ts` itself (which esbuild-wasm CAN
 * read, it's in the file content) restores the chain so the bundle's own map
 * reaches `.ddd`.  Applied ONLY to the map-carrying generate that feeds the
 * bundler — never to the flag-off view/persist tree.
 */
export function inlineSourcemapArtifacts(files: readonly VirtualFile[]): VirtualFile[] {
  const byPath = new Map(files.map((f) => [f.path, f] as const));
  const inlinedSidecars = new Set<string>();
  const out: VirtualFile[] = [];
  for (const f of files) {
    const m = SIDECAR_DIRECTIVE_RE.exec(f.content);
    if (!m) {
      out.push(f);
      continue;
    }
    const sidecarPath = dirOf(f.path) + m[1];
    const sidecar = byPath.get(sidecarPath);
    if (!sidecar) {
      // Directive with no sidecar in the set — leave the file untouched
      // (esbuild-wasm just won't chain it; harmless).
      out.push(f);
      continue;
    }
    const dataUri = `data:application/json;base64,${toBase64Utf8(sidecar.content)}`;
    const content = f.content.replace(SIDECAR_DIRECTIVE_RE, `//# sourceMappingURL=${dataUri}`);
    out.push({ path: f.path, content, size: content.length });
    inlinedSidecars.add(sidecarPath);
  }
  // Drop the sidecars we folded inline (they're now redundant; keeping them
  // would just be dead VFS entries the bundler never reads).
  return out.filter((f) => !inlinedSidecars.has(f.path));
}

function isMapArtifactPath(path: string): boolean {
  return (
    path === SOURCEMAP_MANIFEST_PATH ||
    path === VSCODE_LAUNCH_PATH ||
    MAP_SIDECAR_RE.test(path)
  );
}

/** Defensive filter: drop the well-known sourcemap-only artifact paths
 *  and the trailing `sourceMappingURL` directive.  A no-op on data that
 *  never carried maps to begin with (the normal case — see the module
 *  doc: view/persist run the flag-OFF generate directly and never see
 *  a map-carrying result in the first place).  Does NOT attempt to
 *  reverse backend-specific debug-wiring content mutations (import
 *  extensions, `#line` directives, `package.json`/`tsconfig.json`
 *  changes) — `overlaySourcemapArtifacts` below is what actually
 *  reconciles those, via a diff against a real flag-off generate
 *  rather than a guessed reversal. */
export function stripSourcemapArtifacts(files: readonly VirtualFile[]): VirtualFile[] {
  const out: VirtualFile[] = [];
  for (const f of files) {
    if (isMapArtifactPath(f.path)) continue;
    if (!SOURCE_MAPPING_URL_RE.test(f.content)) {
      out.push(f);
      continue;
    }
    const content = f.content.replace(SOURCE_MAPPING_URL_RE, "");
    out.push({ path: f.path, content, size: content.length });
  }
  return out;
}

/** Re-attach every sourcemap-mutated file onto a `merged` tree (the
 *  "scaffold then own" 3-way-merge result, built from the flag-OFF
 *  generate `off`) — IN MEMORY ONLY, so the bundler can still chain
 *  the boot bundle to `.ddd`.  The set of files to re-attach is computed
 *  as a straight diff between the flag-off and flag-on generate of the
 *  SAME source:
 *  any path that's new, or whose content differs, under `on` — no
 *  backend-specific knowledge required, so a future backend's own
 *  debug-wiring addition is picked up automatically instead of
 *  silently missed.
 *
 *  Limitation, documented not solved: for any file the flag mutates,
 *  the overlay takes the `on` (map-carrying) content verbatim,
 *  discarding any hand edit to that specific file for the purposes of
 *  THIS boot bundle — a hand-edited file has no `.ddd` origin to map
 *  to anyway, so the freshly-generated mapped version is what
 *  DevTools can actually chain back to source.  Files the flag never
 *  touches (hand-added files, non-domain code, other backends' output
 *  the flag doesn't wire debug support for) are left exactly as
 *  `merged` has them. */
export function overlaySourcemapArtifacts(
  merged: readonly VirtualFile[],
  off: readonly VirtualFile[],
  on: readonly VirtualFile[],
): VirtualFile[] {
  const offByPath = new Map(off.map((f) => [f.path, f] as const));
  const byPath = new Map(merged.map((f) => [f.path, f] as const));
  for (const f of on) {
    const offFile = offByPath.get(f.path);
    if (offFile === undefined || offFile.content !== f.content) {
      byPath.set(f.path, f);
    }
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}
