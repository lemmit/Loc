// ---------------------------------------------------------------------------
// Browser-side replacement for `src/generator/react/templating/loader-fs.ts`.
//
// In Node, the React generator reads pack manifests + .hbs templates
// off disk.  In the playground we have no `node:fs`, so this module
// uses Vite's `import.meta.glob` to bundle every built-in theme's
// `pack.json` (eager, parsed) and `.hbs` template (eager, raw) at
// build time, then exposes the same `loadPack` / `resolvePackDir`
// API the generator imports.
//
// Wired up by a regex alias in `web/vite.config.ts` that maps any
// `templating/loader-fs.js` import to this file.  Custom user packs
// (`design: "./design/"`) are not supported in the playground —
// the playground only ever passes "mantine" or "shadcn".
// ---------------------------------------------------------------------------

import {
  compilePack,
  type LoadedPack,
  type PackManifest,
} from "../../../src/generator/react/templating/loader.js";

// Eager glob of every theme manifest.  Vite parses these as JSON at
// bundle time and ships the resulting object directly.
const manifestModules = import.meta.glob<{ default: PackManifest }>(
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
 *  pack name.  Returns null for paths that don't match. */
function parseThemePath(globPath: string): { pack: string; rest: string } | null {
  const m = globPath.match(/\/themes\/([^/]+)\/(.+)$/);
  if (!m) return null;
  return { pack: m[1], rest: m[2] };
}

/** Build per-pack source maps from the eager globs above.  Done
 *  once at module load — every subsequent `loadPack(name)` call is
 *  a hashmap lookup. */
const packs = new Map<string, { manifest: PackManifest; sources: Record<string, string> }>();

for (const [globPath, mod] of Object.entries(manifestModules)) {
  const parsed = parseThemePath(globPath);
  if (!parsed || parsed.rest !== "pack.json") continue;
  const manifest = (mod as { default?: PackManifest }).default ?? (mod as unknown as PackManifest);
  const sources: Record<string, string> = {};
  for (const [logicalName, fileName] of Object.entries(manifest.emits)) {
    const key = `../../../themes/${parsed.pack}/${fileName}`;
    const src = templateSources[key];
    if (src == null) {
      // Defer the error to compilePack so the message format matches
      // the Node loader's; happens here only if a manifest references
      // a file that's missing on disk at bundle time.
      continue;
    }
    sources[logicalName] = src;
  }
  packs.set(parsed.pack, { manifest, sources });
}

/** Resolve a pack identifier to an opaque key the bundled `loadPack`
 *  will recognise.  In Node this returns an absolute fs path; in the
 *  browser a custom path makes no sense, so we just echo the pack
 *  name and let `loadPack` reject anything we didn't pre-bundle. */
export function resolvePackDir(ui: string, _referenceDir?: string): string {
  return ui;
}

/** Load a pre-bundled pack by name (`"mantine"` or `"shadcn"`).
 *  Mirrors the Node `loadPack` contract from `loader-fs.ts`. */
export function loadPack(packId: string): LoadedPack {
  const entry = packs.get(packId);
  if (!entry) {
    throw new Error(
      `template-bundled: pack "${packId}" not bundled into the playground.  Built-ins: ${Array.from(packs.keys()).join(", ")}.  Custom packs aren't supported in the browser.`,
    );
  }
  return compilePack(
    packId,
    entry.manifest,
    entry.sources,
    (f) => `themes/${packId}/${f}`,
  );
}
