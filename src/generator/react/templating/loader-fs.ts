// ---------------------------------------------------------------------------
// Filesystem-backed pack loader (Node-only).
//
// The pure compilation core lives in `loader.ts` and is browser-safe;
// this module is the Node bridge that reads `pack.json` + .hbs files
// off disk and feeds them into `compilePack`.  Built-in packs live
// under `<repo>/themes/<name>/`; custom packs are user-supplied
// directories referenced by absolute or .ddd-relative path.
//
// The playground swaps this module for `web/src/build/template-bundled.ts`
// at bundle time (see `web/vite.config.ts`) — that variant pre-loads
// every theme via `import.meta.glob` so generation runs entirely in
// the browser worker with no fs.
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { compilePack, type LoadedPack, type PackManifest } from "./loader.js";

/** Resolve the directory of the `themes/` root for built-in packs.
 *  Built-ins live under `<repo>/themes/<name>/`; this finds the repo
 *  root by walking up from this file's location. */
function builtinThemesDir(): string {
  // import.meta.url points at the compiled .js or the source .ts
  // depending on how the consumer is run.  Walk up from there until
  // we find a `themes/` sibling.  In repo layout the file lives at
  // `out/generator/react/templating/loader-fs.js` (after build) or
  // `src/generator/react/templating/loader-fs.ts` (source).  Both
  // have `themes/` four directories up.
  const here = path.dirname(fileURLToPath(import.meta.url));
  let dir = here;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "themes");
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
    dir = path.dirname(dir);
  }
  throw new Error(
    `loader: could not locate built-in themes/ directory walking up from ${here}`,
  );
}

/** Resolve a pack identifier ("mantine" / "shadcn" / "./design/")
 *  to an absolute pack directory.  `referenceDir` is the directory
 *  the .ddd source lives in — used to anchor relative custom-pack
 *  paths.  Built-in names resolve under `<repo>/themes/<name>`. */
export function resolvePackDir(ui: string, referenceDir?: string): string {
  if (ui === "mantine" || ui === "shadcn") {
    return path.join(builtinThemesDir(), ui);
  }
  // Treat anything else as a path.  Absolute paths used as-is;
  // relative paths anchored against the .ddd file's dir when
  // available, otherwise the current working directory.
  if (path.isAbsolute(ui)) return ui;
  return path.resolve(referenceDir ?? process.cwd(), ui);
}

/** Read every `.hbs` file in `<themes-root>/_shared/` (if the
 *  directory exists) and return them keyed by logical name (the
 *  filename minus `.hbs`).  Shared templates are pack-agnostic:
 *  they compose pack primitives via `{{> primitive-X}}` and apply
 *  to whichever pack is loaded.  Returns `{}` when no `_shared/`
 *  directory exists, keeping packs without it backward-compatible. */
function readSharedSources(): Record<string, string> {
  const sharedDir = path.join(builtinThemesDir(), "_shared");
  if (!fs.existsSync(sharedDir) || !fs.statSync(sharedDir).isDirectory()) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const file of fs.readdirSync(sharedDir)) {
    if (!file.endsWith(".hbs")) continue;
    const logicalName = file.slice(0, -".hbs".length);
    out[logicalName] = fs.readFileSync(path.join(sharedDir, file), "utf-8");
  }
  return out;
}

/** Load a pack from disk.  Reads pack.json, resolves every template
 *  named in `emits`, compiles each with Handlebars, and returns a
 *  ready-to-use LoadedPack.  Also pulls in `themes/_shared/*.hbs`
 *  as shared partials available to every loaded pack. */
export function loadPack(packDir: string): LoadedPack {
  const manifestPath = path.join(packDir, "pack.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `loader: pack manifest not found at ${manifestPath}.  A pack must contain a pack.json file.`,
    );
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as PackManifest;
  if (!manifest.emits || typeof manifest.emits !== "object") {
    throw new Error(
      `loader: pack at ${packDir} has no \`emits\` map in pack.json.  Add { emits: { "page-list": "page-list.hbs", ... } }.`,
    );
  }
  const sources: Record<string, string> = {};
  for (const [logicalName, fileName] of Object.entries(manifest.emits)) {
    const filePath = path.join(packDir, fileName);
    if (!fs.existsSync(filePath)) {
      throw new Error(
        `loader: pack ${manifest.name}: template "${logicalName}" → "${fileName}" not found at ${filePath}.`,
      );
    }
    sources[logicalName] = fs.readFileSync(filePath, "utf-8");
  }
  const sharedSources = readSharedSources();
  return compilePack(
    packDir,
    manifest,
    sources,
    (f) => path.join(packDir, f),
    sharedSources,
  );
}
