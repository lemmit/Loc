// ---------------------------------------------------------------------------
// Built-in design + shared-template seeder for the playground worker's VFS.
//
// In Node, the React generator reads `designs/<pack>/{pack.json,*.hbs}`
// off disk via `loader-fs.ts`, plus pack-agnostic templates from the
// repo-root `vite/`, `api/`, `docker/` directories.  In the playground
// we have no `node:fs`, so we use Vite's `import.meta.glob` to bundle
// every built-in design's manifest + .hbs templates AND the shared-
// template directories into the worker bundle at build time, then
// seed them into the worker-local VFS at startup.
//
// Phase 1 of the IDE refactor: this file used to *be* the loader
// (a shim that exposed `loadPack` / `resolvePackDir` to the
// generator).  Now it just hydrates the VFS and the loader
// (`loader-vfs.ts`) reads through the same surface as user-supplied
// packs.  Built-ins and user content land in the same Map, so the
// loader sees no difference.
// ---------------------------------------------------------------------------

import type { Vfs, VfsPath } from "../vfs/types.js";

// Eager glob of every design manifest.  Vite parses these as JSON at
// bundle time and ships the resulting object directly.  After Phase 0
// of the pack-versioning rollout, packs live under
// `designs/<family>/<version>/pack.json` — the extra `*` segment
// matches the version dir.
const manifestModules = import.meta.glob<{ default: object }>(
  "../../../designs/*/*/pack.json",
  { eager: true },
);

// Eager raw glob of every design template.  `query: '?raw'` +
// `import: 'default'` tells Vite to inline each .hbs file as a
// string at bundle time.
const templateSources = import.meta.glob<string>(
  "../../../designs/*/*/*.hbs",
  { eager: true, query: "?raw", import: "default" },
);

// Eager raw glob of every pack-agnostic shared-template source.
// One glob covers every shared-source sibling dir — the TSX set
// (vite/, api/, docker/), the SvelteKit set (sveltekit/), the Vue set
// (vue/, which rides the same api/+docker/ as TSX), and the Angular set
// (angular/, its own ng-build host layer).  The loader
// picks the active subset per pack `format`; seeding the union here is
// harmless (unused dirs just sit in the VFS).
const sharedSources = import.meta.glob<string>(
  [
    "../../../vite/*.hbs",
    "../../../api/*.hbs",
    "../../../docker/*.hbs",
    "../../../sveltekit/*.hbs",
    "../../../vue/*.hbs",
    "../../../angular/*.hbs",
  ],
  { eager: true, query: "?raw", import: "default" },
);

// Phase 0.5: stack templates.  When a pack's pack.json declares
// `stack: "vN"`, the VFS loader pulls extra partials from
// `/stacks/<vN>/`.  Bundle every stack's `.hbs` files so the
// browser-side worker can find them at the expected path.  Same
// `?raw` import pattern as the design templates.
const stackSources = import.meta.glob<string>(
  "../../../stacks/*/*.hbs",
  { eager: true, query: "?raw", import: "default" },
);

// Eager glob of every stack manifest (stack.json).  Not used by
// the pack loader today — the .hbs partials carry the only
// load-bearing info — but seeded into the VFS so future bundler
// hints can read it (Phase 0.5 PR B will).
const stackManifests = import.meta.glob<{ default: object }>(
  "../../../stacks/*/stack.json",
  { eager: true },
);

/** Strip the leading `../../../designs/` prefix and split off the
 *  pack family + version segments.  Returns null for paths that
 *  don't match — defensive against future glob-pattern changes.
 *  Phase 0 of pack versioning: every built-in pack now lives under
 *  `designs/<family>/<version>/`, so paths land in the VFS at
 *  `/designs/<family>/<version>/<rest>` — symmetric with what
 *  `resolvePackDir` looks up on read. */
function parseDesignPath(
  globPath: string,
): { family: string; version: string; rest: string } | null {
  const m = globPath.match(/\/designs\/([^/]+)\/([^/]+)\/(.+)$/);
  if (!m) return null;
  return { family: m[1], version: m[2], rest: m[3] };
}

/** Match a glob path like `../../../vite/index-html.hbs` and pull out
 *  the top-level dir name plus filename.  Used to project each
 *  shared template into the VFS at `/<dir>/<file>`. */
function parseSharedPath(globPath: string): { dir: string; file: string } | null {
  const m = globPath.match(/\/(vite|api|docker|sveltekit|vue|angular)\/([^/]+\.hbs)$/);
  if (!m) return null;
  return { dir: m[1], file: m[2] };
}

/** Strip the leading `../../../stacks/` prefix and split off the
 *  stack id + filename.  Used to project each stack template into
 *  the VFS at `/stacks/<id>/<file>` — symmetric with how the loader
 *  reads it back in `loader-vfs.ts`. */
function parseStackPath(
  globPath: string,
): { id: string; file: string } | null {
  const m = globPath.match(/\/stacks\/([^/]+)\/([^/]+\.(?:hbs|json))$/);
  if (!m) return null;
  return { id: m[1], file: m[2] };
}

/** Hydrate the given VFS with every built-in pack's manifest + .hbs
 *  templates under `/designs/<pack>/...`, plus the pack-agnostic
 *  shared templates under `/vite/...`, `/api/...`, `/docker/...`.
 *  Idempotent: re-seeding with the same content is a no-op for
 *  downstream consumers because writes overwrite-in-place.  Called
 *  exactly once at worker boot from `build.worker.ts`.
 *
 *  Throws when the eager design glob comes back empty — that means
 *  the file was moved relative to `designs/` and the relative glob
 *  no longer resolves; failing loud beats a silent "no built-ins"
 *  surface. */
export function seedBuiltinPacks(vfs: Vfs): void {
  if (Object.keys(manifestModules).length === 0) {
    throw new Error(
      "seedBuiltinPacks: empty manifest glob — `template-bundled.ts` was probably moved relative to `designs/`.  Update the `import.meta.glob` patterns.",
    );
  }
  const entries: Array<readonly [VfsPath, string]> = [];
  for (const [globPath, mod] of Object.entries(manifestModules)) {
    const parsed = parseDesignPath(globPath);
    if (!parsed || parsed.rest !== "pack.json") continue;
    const manifest = (mod as { default?: object }).default ?? mod;
    entries.push([
      `/designs/${parsed.family}/${parsed.version}/pack.json`,
      // Stringify so the VFS stays homogeneous (everything is
      // text — see `Vfs` interface comment).  The loader
      // JSON.parses on read.
      JSON.stringify(manifest),
    ]);
  }
  for (const [globPath, src] of Object.entries(templateSources)) {
    const parsed = parseDesignPath(globPath);
    if (!parsed) continue;
    entries.push([
      `/designs/${parsed.family}/${parsed.version}/${parsed.rest}`,
      src,
    ]);
  }
  for (const [globPath, src] of Object.entries(sharedSources)) {
    const parsed = parseSharedPath(globPath);
    if (!parsed) continue;
    entries.push([`/${parsed.dir}/${parsed.file}`, src]);
  }
  for (const [globPath, src] of Object.entries(stackSources)) {
    const parsed = parseStackPath(globPath);
    if (!parsed) continue;
    entries.push([`/stacks/${parsed.id}/${parsed.file}`, src]);
  }
  for (const [globPath, mod] of Object.entries(stackManifests)) {
    const parsed = parseStackPath(globPath);
    if (!parsed || parsed.file !== "stack.json") continue;
    const manifest = (mod as { default?: object }).default ?? mod;
    entries.push([`/stacks/${parsed.id}/stack.json`, JSON.stringify(manifest)]);
  }
  vfs.hydrate(entries);
}
