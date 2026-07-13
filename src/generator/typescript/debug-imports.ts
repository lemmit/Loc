// ---------------------------------------------------------------------------
// Node debug-mode import rewriting (`--sourcemap`, M18 phase 8 slice 1 —
// Node debug wiring; see docs/old/plans/dap-node-debug.md).
//
// The generated node/Hono project's relative imports are extensionless
// (`moduleResolution: "Bundler"` style — `from "./ids"`), which the `tsx`
// dev loader and `tsup`/esbuild build both resolve happily by probing
// candidate extensions.  Plain Node's own ESM loader does NOT: unlike
// CommonJS `require`, it never probes an extension for a relative
// specifier, so `node --experimental-strip-types` (or Node 23.6+/24's
// unflagged type-stripping) fails immediately with ERR_MODULE_NOT_FOUND on
// the project's very first relative import — independent of, and prior to,
// any question about type-stripping itself. Confirmed empirically: see
// docs/old/plans/dap-node-debug.md "Phase A — the spike" for the reproduction.
//
// This pass appends the resolved module's real extension (`.ts`/`.tsx`) to
// every relative import specifier that resolves to an emitted file — a
// content change, so it only runs when `--sourcemap` requests the debug
// affordance (see the `sourcemap` gate at the call site in
// `src/platform/hono/v4/emit.ts`); the flag-off project keeps today's
// extensionless imports byte-identical.  `tsconfig.json`'s
// `allowImportingTsExtensions` (set alongside this — same file) is required
// for `tsc --noEmit` to accept the now-explicit `.ts` specifiers (TS5097
// otherwise); esbuild (tsx/tsup) has always accepted them unconditionally,
// so `npm run dev` / `npm run build` stay unaffected either way.
// ---------------------------------------------------------------------------

/** Matches the specifier in `from "x"`, `import "x"`, `export … from "x"`,
 *  and DYNAMIC `import("x")` whose path is RELATIVE (starts with `.`).
 *  Mirrors `layout-imports.ts`'s `RELATIVE_IMPORT_RE` (same shape, same
 *  precedent) — kept as an independent copy here rather than a shared
 *  export so this debug-only pass has no edge into the layout-relocation
 *  module's own surface. */
const RELATIVE_IMPORT_RE = /\b(?:from|import)\s*\(?\s*(['"])(\.[^'"]*)\1/g;

const dirParts = (file: string): string[] => {
  const slash = file.lastIndexOf("/");
  return slash === -1 ? [] : file.slice(0, slash).split("/").filter(Boolean);
};

/** Resolve a relative import specifier against the FILE it appears in,
 *  returning the target module path WITHOUT extension. */
function resolveSpec(fromFile: string, spec: string): string {
  const acc = dirParts(fromFile);
  for (const part of spec.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") acc.pop();
    else acc.push(part);
  }
  return acc.join("/");
}

/** Append the real extension to every relative import specifier that
 *  resolves to an emitted `.ts`/`.tsx` module in `out`.  A specifier that
 *  resolves to nothing in the map (already extensioned, or genuinely
 *  unresolvable) is left untouched — an honest skip, not a guess,
 *  matching this codebase's `SourceMapRecorder` anchoring discipline. */
export function addTsExtensionsForNodeDebug(out: Map<string, string>): void {
  for (const [path, content] of out) {
    if (!path.endsWith(".ts") && !path.endsWith(".tsx")) continue;
    const rewritten = content.replace(RELATIVE_IMPORT_RE, (full, quote: string, spec: string) => {
      const resolved = resolveSpec(path, spec);
      for (const ext of [".ts", ".tsx"]) {
        if (out.has(`${resolved}${ext}`)) {
          return full.replace(`${quote}${spec}${quote}`, `${quote}${spec}${ext}${quote}`);
        }
      }
      return full;
    });
    if (rewritten !== content) out.set(path, rewritten);
  }
}
