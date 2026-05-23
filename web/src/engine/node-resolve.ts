// ---------------------------------------------------------------------------
// Node module resolution over a flat in-VFS node_modules — the core
// of the npm-in-browser engine.
//
// Real Node resolution against each package's *own published files*:
// we read drizzle-orm's real `pg-core/index.js` (which re-exports the
// real `utils.js` that exports `extractUsedTable`), so the whole
// CDN-split-shard bug class can't occur.
//
// Pure: parameterised over a `FileSource` so it runs against the
// playground VFS, an in-memory Map, or anything else.
//
// Scope: the subset real generated projects + their deps need —
//   - bare + subpath specifiers, `@scope/name`
//   - package.json `exports`: string / nested condition objects /
//     subpath maps / `*` patterns / fallback arrays
//   - fallback `module` → `main` → `index.*`
//   - extension + /index probing
// Condition priority is ESM-bundle order; `types` is always skipped.
// ---------------------------------------------------------------------------

export interface FileSource {
  /** UTF-8 text at an absolute POSIX path, or undefined when absent. */
  read(path: string): string | undefined;
  exists(path: string): boolean;
}

/** Conditions tried, in priority order, when walking an `exports`
 *  conditions object.  ESM bundle for a server (Hono) target — no
 *  `browser`/`node` split needed for the backend; `default` always
 *  closes the list.  A frontend engine variant can prepend
 *  `"browser"`. */
export const ESM_CONDITIONS = ["import", "module", "default"] as const;

const EXTS = [".js", ".mjs", ".cjs", ".json"];
const INDEX = ["index.js", "index.mjs", "index.cjs"];

function joinPosix(...parts: string[]): string {
  const segs: string[] = [];
  for (const part of parts.join("/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") segs.pop();
    else segs.push(part);
  }
  return "/" + segs.join("/");
}

/** `lodash` → {name:"lodash", sub:"."}; `@scope/p/x` →
 *  {name:"@scope/p", sub:"./x"}. */
export function parseSpecifier(spec: string): { name: string; sub: string } {
  const parts = spec.split("/");
  const name = spec.startsWith("@")
    ? parts.slice(0, 2).join("/")
    : parts[0];
  const rest = spec.slice(name.length).replace(/^\//, "");
  return { name, sub: rest === "" ? "." : `./${rest}` };
}

/** Resolve a conditions node (string | array | {cond: node}) to a
 *  relative target string, honouring priority order.  `types` is
 *  skipped (never a runtime entry). */
function resolveConditions(
  node: unknown,
  conditions: readonly string[],
): string | null {
  if (typeof node === "string") return node;
  if (node === null) return null; // explicit "blocked" subpath
  if (Array.isArray(node)) {
    for (const c of node) {
      const r = resolveConditions(c, conditions);
      if (r) return r;
    }
    return null;
  }
  if (typeof node === "object") {
    const obj = node as Record<string, unknown>;
    for (const cond of conditions) {
      if (cond in obj) {
        const r = resolveConditions(obj[cond], conditions);
        if (r) return r;
      }
    }
    if ("default" in obj) return resolveConditions(obj.default, conditions);
  }
  return null;
}

/** Apply a package.json `exports` field for `sub` ("." | "./x").
 *  Handles: bare string/conditions for ".", explicit subpath maps,
 *  and `*` patterns (longest-prefix wins, per Node). */
export function resolveExports(
  exportsField: unknown,
  sub: string,
  conditions: readonly string[],
): string | null {
  if (exportsField == null) return null;

  // `exports` is a string or a conditions object describing "."
  // (no key starts with ".").
  const isSubpathMap =
    typeof exportsField === "object" &&
    !Array.isArray(exportsField) &&
    Object.keys(exportsField as object).every((k) => k === "." || k.startsWith("./"));

  if (!isSubpathMap) {
    return sub === "."
      ? resolveConditions(exportsField, conditions)
      : null;
  }

  const map = exportsField as Record<string, unknown>;
  if (sub in map) return resolveConditions(map[sub], conditions);

  // `*` patterns: pick the longest matching prefix.
  let best: { target: unknown; star: string } | null = null;
  for (const key of Object.keys(map)) {
    const star = key.indexOf("*");
    if (star === -1) continue;
    const pre = key.slice(0, star);
    const post = key.slice(star + 1);
    if (sub.startsWith(pre) && sub.endsWith(post) && sub.length >= pre.length + post.length) {
      const matched = sub.slice(pre.length, sub.length - post.length);
      if (!best || pre.length > best.star.length) best = { target: map[key], star: matched };
    }
  }
  if (best) {
    const t = resolveConditions(best.target, conditions);
    return t ? t.replace("*", best.star) : null;
  }
  return null;
}

/** Probe a path the way Node does: exact, then +ext, then /index.*. */
function probeFile(base: string, src: FileSource): string | null {
  if (src.exists(base) && !base.endsWith("/")) return base;
  for (const e of EXTS) if (src.exists(base + e)) return base + e;
  for (const i of INDEX) {
    const p = joinPosix(base, i);
    if (src.exists(p)) return p;
  }
  return null;
}

/** Resolve a bare/subpath specifier against a flat node_modules.
 *  `nmRoot` is the absolute node_modules dir (flat install — every
 *  package at `<nmRoot>/<name>`; B3 layers nesting/dedupe on top).
 *  Returns the resolved absolute file path, or null. */
export function resolveBare(
  spec: string,
  src: FileSource,
  nmRoot = "/node_modules",
  conditions: readonly string[] = ESM_CONDITIONS,
): string | null {
  const { name, sub } = parseSpecifier(spec);
  const pkgDir = joinPosix(nmRoot, name);
  const pkgJsonPath = joinPosix(pkgDir, "package.json");
  const pkgRaw = src.read(pkgJsonPath);
  if (pkgRaw === undefined) return null;

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(pkgRaw) as Record<string, unknown>;
  } catch {
    return null;
  }

  // 1. exports map (the modern, authoritative path — drizzle).
  if ("exports" in pkg) {
    const target = resolveExports(pkg.exports, sub, conditions);
    if (target) {
      const resolved = probeFile(joinPosix(pkgDir, target), src);
      if (resolved) return resolved;
    }
    // A package WITH exports that doesn't map `sub` is a hard miss
    // (Node forbids reaching into unexported paths) — don't fall
    // through to legacy fields for an unexported subpath.
    if (sub !== ".") return null;
  }

  // 2. legacy (no exports): "." → module/main; subpath → file under
  // the package.  When `browser` is in the conditions list AND the
  // package declares a top-level `browser: "./x.js"` (pino, ws,
  // node-fetch, …), prefer that — bypasses Node-only dependency trees
  // (sonic-boom for pino, http/https for node-fetch) the browser
  // build is explicitly designed to avoid.  The object-form
  // `browser: { ... }` field (per-file overrides) is out of scope —
  // most packages that ship it also ship `exports`, which already
  // resolved above.
  if (sub === ".") {
    const browserPreferred = conditions.includes("browser");
    const fields = browserPreferred ? ["browser", "module", "main"] : ["module", "main"];
    for (const field of fields) {
      const v = pkg[field];
      if (typeof v === "string") {
        const r = probeFile(joinPosix(pkgDir, v), src);
        if (r) return r;
      }
    }
    return probeFile(joinPosix(pkgDir, "index"), src);
  }
  // Direct: `<pkg>/<sub>` at the package root.
  const direct = probeFile(joinPosix(pkgDir, sub), src);
  if (direct) return direct;
  // Rollup-era packages (no `exports`) ship all code — incl. the
  // subpath modules consumers import bare — under the `module`/`main`
  // directory (e.g. react-remove-scroll-bar `dist/es2015/index.js`
  // → `react-remove-scroll-bar/constants` is `dist/es2015/
  // constants.js`; dom-helpers `esm/index.js` → `dom-helpers/
  // addClass` is `esm/addClass.js`).  Node's classic resolver
  // wouldn't find these, but every real bundler resolves them this
  // way and the whole Mantine/react-transition-group tree depends on
  // it.  Only reached when the direct path missed.
  for (const field of ["module", "main"]) {
    const v = pkg[field];
    if (typeof v !== "string") continue;
    const baseDir = v.slice(0, v.lastIndexOf("/"));
    if (!baseDir) continue;
    const r = probeFile(joinPosix(pkgDir, baseDir, sub), src);
    if (r) return r;
  }
  return null;
}
