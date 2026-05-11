// ---------------------------------------------------------------------------
// Filesystem-backed pack loader (Node-only).
//
// The pure compilation core lives in `loader.ts` and is browser-safe;
// this module is the Node bridge that reads `pack.json` + .hbs files
// off disk and feeds them into `compilePack`.  Built-in packs live
// under `<repo>/designs/<name>/`; custom packs are user-supplied
// directories referenced by absolute or .ddd-relative path.
//
// The playground swaps this module for `web/src/build/template-bundled.ts`
// at bundle time (see `web/vite.config.ts`) — that variant pre-loads
// every design via `import.meta.glob` so generation runs entirely in
// the browser worker with no fs.
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { compilePack, type LoadedPack, type PackManifest } from "./loader.js";

/** Names of the repo-root template directories that supply
 *  pack-agnostic Handlebars sources (Vite scaffold, API integration,
 *  Docker artifacts).  Each is read flat — no nesting — and merged
 *  into a single shared-sources map keyed by logical name. */
const SHARED_SOURCE_DIRS = ["vite", "api", "docker"] as const;

/** Resolve the repo-root directory by walking up from this file
 *  until a `designs/` sibling is found.  Used to anchor both the
 *  built-in pack lookup and the shared-source directories. */
function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  let dir = here;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "designs");
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  throw new Error(
    `loader: could not locate repo root (looked for a sibling \`designs/\` directory) walking up from ${here}`,
  );
}

/** Resolve a pack identifier ("mantine" / "shadcn" / "./design/")
 *  to an absolute pack directory.  `referenceDir` is the directory
 *  the .ddd source lives in — used to anchor relative custom-pack
 *  paths.  Built-in names resolve under `<repo>/designs/<name>`. */
export function resolvePackDir(ui: string, referenceDir?: string): string {
  if (ui === "mantine" || ui === "shadcn" || ui === "mui") {
    return path.join(repoRoot(), "designs", ui);
  }
  // Treat anything else as a path.  Absolute paths used as-is;
  // relative paths anchored against the .ddd file's dir when
  // available, otherwise the current working directory.
  if (path.isAbsolute(ui)) return ui;
  return path.resolve(referenceDir ?? process.cwd(), ui);
}

/** Read every `.hbs` file in each of the repo-root shared-source
 *  directories (`vite/`, `api/`, `docker/`) and return them keyed by
 *  logical name (the filename minus `.hbs`).  Shared templates are
 *  pack-agnostic: the React generator's preparers refer to them by
 *  logical name (e.g. `dockerfile`, `index-html`) and they emit
 *  identically regardless of which design pack is active.  Missing
 *  directories are silently skipped — keeps the contract opt-in. */
function readSharedSources(): Record<string, string> {
  const root = repoRoot();
  const out: Record<string, string> = {};
  for (const dirName of SHARED_SOURCE_DIRS) {
    const dir = path.join(root, dirName);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".hbs")) continue;
      const logicalName = file.slice(0, -".hbs".length);
      if (out[logicalName] != null) {
        throw new Error(
          `loader: duplicate shared template "${logicalName}" — defined under both \`${dirName}/\` and a sibling shared dir.  Logical names must be unique across vite/, api/, docker/.`,
        );
      }
      out[logicalName] = fs.readFileSync(path.join(dir, file), "utf-8");
    }
  }
  return out;
}

/** Load a pack from disk.  Reads pack.json, resolves every template
 *  named in `emits`, compiles each with Handlebars, and returns a
 *  ready-to-use LoadedPack.  Also pulls in the repo-root shared
 *  directories (`vite/`, `api/`, `docker/`) as pack-agnostic
 *  partials available to every loaded pack. */
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
