// ---------------------------------------------------------------------------
// Built-in pack seeder for the playground worker's VFS.
//
// In Node, the React generator reads `themes/<pack>/{pack.json,*.hbs}`
// off disk via `loader-fs.ts`.  In the playground we have no
// `node:fs`, so we use Vite's `import.meta.glob` to bundle every
// built-in theme's manifest + .hbs templates into the worker bundle
// at build time, then seed them into the worker-local VFS at
// startup.
//
// Phase 1 of the IDE refactor: this file used to *be* the loader
// (a shim that exposed `loadPack` / `resolvePackDir` to the
// generator).  Now it just hydrates the VFS and the loader
// (`loader-vfs.ts`) reads through the same surface as user-supplied
// packs.  Built-ins and user content land in the same Map, so the
// loader sees no difference.
// ---------------------------------------------------------------------------

import type { Vfs, VfsPath } from "../vfs/types.js";

// Eager glob of every theme manifest.  Vite parses these as JSON at
// bundle time and ships the resulting object directly.
const manifestModules = import.meta.glob<{ default: object }>(
  "../../../themes/*/pack.json",
  { eager: true },
);

// Eager raw glob of every theme template.  `query: '?raw'` +
// `import: 'default'` tells Vite to inline each .hbs file as a
// string at bundle time.
const templateSources = import.meta.glob<string>(
  "../../../themes/*/*.hbs",
  { eager: true, query: "?raw", import: "default" },
);

/** Strip the leading `../../../themes/` prefix and split off the
 *  pack name.  Returns null for paths that don't match — defensive
 *  against future glob-pattern changes. */
function parseThemePath(globPath: string): { pack: string; rest: string } | null {
  const m = globPath.match(/\/themes\/([^/]+)\/(.+)$/);
  if (!m) return null;
  return { pack: m[1], rest: m[2] };
}

/** Hydrate the given VFS with every built-in pack's manifest + .hbs
 *  templates under `/themes/<pack>/...`.  Idempotent: re-seeding
 *  with the same content is a no-op for downstream consumers
 *  because writes overwrite-in-place.  Called exactly once at
 *  worker boot from `build.worker.ts`.
 *
 *  Throws when the eager glob comes back empty — that means the
 *  file was moved relative to `themes/` and the relative glob no
 *  longer resolves; failing loud beats a silent "no built-ins"
 *  surface. */
export function seedBuiltinPacks(vfs: Vfs): void {
  if (Object.keys(manifestModules).length === 0) {
    throw new Error(
      "seedBuiltinPacks: empty manifest glob — `template-bundled.ts` was probably moved relative to `themes/`.  Update the `import.meta.glob` patterns.",
    );
  }
  const entries: Array<readonly [VfsPath, string]> = [];
  for (const [globPath, mod] of Object.entries(manifestModules)) {
    const parsed = parseThemePath(globPath);
    if (!parsed || parsed.rest !== "pack.json") continue;
    const manifest = (mod as { default?: object }).default ?? mod;
    entries.push([
      `/themes/${parsed.pack}/pack.json`,
      // Stringify so the VFS stays homogeneous (everything is
      // text — see `Vfs` interface comment).  The loader
      // JSON.parses on read.
      JSON.stringify(manifest),
    ]);
  }
  for (const [globPath, src] of Object.entries(templateSources)) {
    const parsed = parseThemePath(globPath);
    if (!parsed) continue;
    entries.push([`/themes/${parsed.pack}/${parsed.rest}`, src]);
  }
  vfs.hydrate(entries);
}
