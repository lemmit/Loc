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
 *  pack-agnostic Handlebars sources, keyed by pack format.  TSX packs
 *  (mantine, shadcn) consume the React/Vite/Docker scaffolds; HEEx
 *  packs (ashPhoenix) consume their own future `phoenix/` shared
 *  layer (empty in v0 — the ashPhoenix pack ships its shell files
 *  directly).  Each directory is read flat — no nesting — and merged
 *  into a single shared-sources map keyed by logical name. */
const SHARED_SOURCE_DIRS_TSX = ["vite", "api", "docker"] as const;
const SHARED_SOURCE_DIRS_HEEX: readonly string[] = ["phoenix"];

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

/** Built-in pack names — resolve under `<repo>/designs/<name>/`. */
const BUILTIN_PACKS = new Set(["mantine", "shadcn", "mui", "chakra", "ashPhoenix"]);

/** Resolve a pack identifier ("mantine" / "shadcn" / "mui" /
 *  "ashPhoenix" / "./design/") to an absolute pack directory.
 *  `referenceDir` is the directory the .ddd source lives in — used
 *  to anchor relative custom-pack paths.  Built-in names resolve
 *  under `<repo>/designs/<name>`. */
export function resolvePackDir(ui: string, referenceDir?: string): string {
  if (BUILTIN_PACKS.has(ui)) {
    return path.join(repoRoot(), "designs", ui);
  }
  // Treat anything else as a path.  Absolute paths used as-is;
  // relative paths anchored against the .ddd file's dir when
  // available, otherwise the current working directory.
  if (path.isAbsolute(ui)) return ui;
  return path.resolve(referenceDir ?? process.cwd(), ui);
}

/** Read every `.hbs` file in each of the repo-root shared-source
 *  directories that match the pack's `format` (TSX packs read
 *  `vite/`+`api/`+`docker/`; HEEx packs read `phoenix/`) and return
 *  them keyed by logical name (the filename minus `.hbs`).  Shared
 *  templates are pack-agnostic within their format: preparers refer
 *  to them by logical name and they emit identically regardless of
 *  which design pack of that format is active.  Missing directories
 *  are silently skipped — keeps the contract opt-in. */
function readSharedSources(format: "tsx" | "heex"): Record<string, string> {
  const root = repoRoot();
  const out: Record<string, string> = {};
  const dirs = format === "heex" ? SHARED_SOURCE_DIRS_HEEX : SHARED_SOURCE_DIRS_TSX;
  for (const dirName of dirs) {
    const dir = path.join(root, dirName);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".hbs")) continue;
      const logicalName = file.slice(0, -".hbs".length);
      if (out[logicalName] != null) {
        throw new Error(
          `loader: duplicate shared template "${logicalName}" — defined under multiple shared dirs.  Logical names must be unique across the active format's shared directories.`,
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
  const sharedSources = readSharedSources(manifest.format ?? "tsx");
  return compilePack(
    packDir,
    manifest,
    sources,
    (f) => path.join(packDir, f),
    sharedSources,
  );
}
