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
import { parseBuiltinDesignRef } from "../../util/builtin-formats.js";
import { compilePack, type LoadedPack, type PackFormat, type PackManifest } from "./loader.js";

/** Names of the repo-root template directories that supply
 *  pack-agnostic Handlebars sources, keyed by pack format.  TSX packs
 *  (mantine, shadcn) consume the React/Vite/Docker scaffolds; HEEx
 *  packs (ashPhoenix) consume their own future `phoenix/` shared
 *  layer (empty in v0 — the ashPhoenix pack ships its shell files
 *  directly).  Each directory is read flat — no nesting — and merged
 *  into a single shared-sources map keyed by logical name. */
const SHARED_SOURCE_DIRS_TSX = ["vite", "api", "docker"] as const;
const SHARED_SOURCE_DIRS_HEEX: readonly string[] = ["phoenix"];
// Svelte packs share the framework-neutral `docker/` scaffold (the
// dockerfile is a generic vite-build/vite-preview two-stage) plus a
// SvelteKit-specific shared layer.
const SHARED_SOURCE_DIRS_SVELTE: readonly string[] = ["sveltekit", "docker"];

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

/** Resolve a pack identifier to an absolute pack directory.
 *  `referenceDir` is the directory the .ddd source lives in — used
 *  to anchor relative custom-pack paths.
 *
 *  Built-in identifiers carry a `family@version` segment after Phase
 *  0 of the pack-versioning rollout: bareword `mantine` resolves to
 *  the toolchain default version via `BUILTIN_PACK_LATEST`; an
 *  explicit pin `mantine@v9` skips the default.  Either way the pack
 *  lives under `<repo>/designs/<family>/<version>/`.  Anything that
 *  isn't a registered family falls through to the custom-pack path
 *  resolution. */
export function resolvePackDir(ui: string, referenceDir?: string): string {
  const parsed = parseBuiltinDesignRef(ui);
  if (parsed) {
    return path.join(repoRoot(), "designs", parsed.family, parsed.version);
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
function readSharedSources(format: PackFormat): Record<string, string> {
  const root = repoRoot();
  const out: Record<string, string> = {};
  const dirs =
    format === "heex"
      ? SHARED_SOURCE_DIRS_HEEX
      : format === "svelte"
        ? SHARED_SOURCE_DIRS_SVELTE
        : SHARED_SOURCE_DIRS_TSX;
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
export function loadPack(
  packDir: string,
  options: { validateRequired?: boolean } = {},
): LoadedPack {
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
  // Pack-versioning cross-check: when a pack lives under the
  // built-in `designs/<family>/<vNN>/` tree, the parent dir name is
  // load-bearing — it's what `design: family@vNN` resolves to.  A
  // mismatch with `manifest.version` means a copy-paste fork left the
  // manifest pointing at the old version; that would silently shadow
  // sibling packs.  Bail loudly instead.  Only fires for paths that
  // match the built-in layout; arbitrary custom packs are exempt.
  const builtinSegments = path.relative(path.join(repoRoot(), "designs"), packDir).split(path.sep);
  if (
    builtinSegments.length === 2 &&
    !builtinSegments[0].startsWith("..") &&
    manifest.version !== builtinSegments[1]
  ) {
    throw new Error(
      `loader: pack at ${packDir} has version="${manifest.version}" but lives under directory "${builtinSegments[1]}".  The two must match (e.g. designs/mantine/v7/pack.json must declare "version": "v7").`,
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
  // Stack templates.  When the pack declares
  // `stack: "vN"`, pull every `.hbs` from `<repo>/stacks/<vN>/`
  // into the same shared-partials map so pack templates can
  // `{{> stack-package-deps}}` etc.  Stack files are siblings of
  // pack-shared partials — same registration order semantics.  Pack
  // templates still win when names collide (compilePack registers
  // shared first, then pack overwrites).
  if (manifest.stack) {
    const stackDir = path.join(repoRoot(), "stacks", manifest.stack);
    if (!fs.existsSync(stackDir) || !fs.statSync(stackDir).isDirectory()) {
      throw new Error(
        `loader: pack ${manifest.name}@${manifest.version} declares stack="${manifest.stack}" but no such directory exists at ${stackDir}.`,
      );
    }
    for (const file of fs.readdirSync(stackDir)) {
      if (!file.endsWith(".hbs")) continue;
      const logicalName = file.slice(0, -".hbs".length);
      if (sharedSources[logicalName] != null) {
        throw new Error(
          `loader: stack ${manifest.stack} partial '${logicalName}' clashes with an existing shared template name.  Rename one.`,
        );
      }
      sharedSources[logicalName] = fs.readFileSync(path.join(stackDir, file), "utf-8");
    }
  }
  return compilePack(
    packDir,
    manifest,
    sources,
    (f) => path.join(packDir, f),
    sharedSources,
    options,
  );
}
