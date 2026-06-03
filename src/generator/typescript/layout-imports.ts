// ---------------------------------------------------------------------------
// Layout-aware relative-import rewriting for the TypeScript backend.
//
// Unlike .NET (`using <Namespace>` is independent of file paths), generated TS
// modules import each other by RELATIVE PATH.  So when a layout adapter
// relocates files (e.g. `directoryLayout: byFeature` moves
// `db/repositories/<agg>-repository.ts` → `features/<agg>/<agg>-repository.ts`),
// every cross-file `import … from "<spec>"` whose source OR target moved must be
// recomputed, or the project fails to compile.
//
// This keeps the shared emitters (`src/generator/typescript/*`) layout-agnostic:
// they always emit byLayer-relative specifiers; this pass fixes them up
// afterwards from the layout adapter's old→new path mapping.  When nothing
// moved (`moved` is empty) the pass is a NO-OP — the byLayer default is never
// touched, so it stays byte-identical.
// ---------------------------------------------------------------------------

/** Matches the specifier in `from "x"`, `import "x"`, `export … from "x"`, and
 *  DYNAMIC `import("x")` whose path is RELATIVE (starts with `.`).  The optional
 *  `(` covers the dynamic form (generated routes lazy-load `import("../obs/log")`).
 *  Bare specifiers (`drizzle-orm`, `zod`, …) are left alone. */
const RELATIVE_IMPORT_RE = /\b(?:from|import)\s*\(?\s*(['"])(\.[^'"]*)\1/g;

const dirParts = (file: string): string[] => {
  const slash = file.lastIndexOf("/");
  return slash === -1 ? [] : file.slice(0, slash).split("/").filter(Boolean);
};

/** Resolve a relative import specifier against the FILE it appears in,
 *  returning the target module path WITHOUT extension (e.g.
 *  `db/repositories/x.ts` + `../schema` → `db/schema`). */
function resolveSpec(fromFile: string, spec: string): string {
  const acc = dirParts(fromFile);
  for (const part of spec.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") acc.pop();
    else acc.push(part);
  }
  return acc.join("/");
}

/** Compute the relative specifier (extensionless, `./`-prefixed) from
 *  `fromFile` to `targetFile`. */
function relSpec(fromFile: string, targetFile: string): string {
  const from = dirParts(fromFile);
  const to = targetFile.replace(/\.ts$/, "").split("/").filter(Boolean);
  let i = 0;
  while (i < from.length && i < to.length && from[i] === to[i]) i++;
  const up = from.slice(i).map(() => "..");
  const down = to.slice(i);
  const rel = [...up, ...down].join("/");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

/**
 * Rewrite relative imports across an emitted TS project after a layout
 * relocation.
 *
 * @param out    The emitted file map (path → content), keyed by FINAL paths
 *               (post-relocation).  Mutated in place.
 * @param moved  `byLayerPath → finalPath` for every file the layout adapter
 *               relocated.  Empty ⇒ no-op.
 */
export function rewriteRelativeImports(out: Map<string, string>, moved: Map<string, string>): void {
  if (moved.size === 0) return;
  // Each emitted file's ORIGINAL (byLayer) path — needed to resolve the
  // specifiers it was authored with.  Identity for files that stayed put;
  // the reverse of `moved` for relocated ones.
  const byLayerOf = new Map<string, string>();
  for (const key of out.keys()) byLayerOf.set(key, key);
  for (const [oldPath, newPath] of moved) byLayerOf.set(newPath, oldPath);

  for (const currentPath of [...out.keys()]) {
    if (!currentPath.endsWith(".ts")) continue;
    const content = out.get(currentPath)!;
    const sourceByLayer = byLayerOf.get(currentPath) ?? currentPath;
    const rewritten = content.replace(RELATIVE_IMPORT_RE, (full, quote: string, spec: string) => {
      // Resolve against the ORIGINAL location the specifier was written for.
      const targetByLayer = `${resolveSpec(sourceByLayer, spec)}.ts`;
      const targetFinal = moved.get(targetByLayer);
      // Only touch specifiers that point at a relocated emitted module.
      // A target that stayed put (or isn't an emitted file) is left as-is,
      // EXCEPT when this source file itself moved — then even a stayed
      // target needs the specifier recomputed from the new source dir.
      const stayed = out.has(targetByLayer) || targetByLayer === currentPath;
      if (targetFinal === undefined && !(stayed && sourceByLayer !== currentPath)) {
        return full;
      }
      const newSpec = relSpec(currentPath, targetFinal ?? targetByLayer);
      return full.replace(`${quote}${spec}${quote}`, `${quote}${newSpec}${quote}`);
    });
    if (rewritten !== content) out.set(currentPath, rewritten);
  }
}
