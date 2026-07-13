import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Pipeline layering invariant (see CLAUDE.md "Architecture — the
// one-directional pipeline" and docs/technical.md).
//
//   .ddd → parse → language/ → ir/ → generator/ → system/
//
// Edges point one way.  A downstream layer never imports a VALUE
// (runtime symbol) from a layer further down the pipeline:
//
//   - language/         must not value-import from ir/, generator/, system/
//   - ir/               must not value-import from generator/ or system/
//   - generator/        must not value-import from system/ (the terminal
//                       composition layer); nor a sibling platform dir
//
// TYPE-only imports are deliberately exempt: the IR types
// (`loom-ir.ts`) are the shared vocabulary every layer speaks, and a
// `import type { … }` carries no runtime dependency — it disappears at
// emit.  The invariant we enforce is the *value* (runtime) dependency
// direction, which is what the "no target-backend IR / backends consume
// LoomModel directly" architecture actually rests on.
//
// ENFORCED, NOT ASPIRATIONAL.  CLAUDE.md calls the pipeline "strictly
// one-directional and enforced by file structure", but until this test
// the phase boundaries (unlike the generator→platform edge, guarded by
// backend-packages-layering.test.ts) were convention-only.  Auditing
// the tree surfaced two pre-existing value backward-edges (language
// validators reaching into `ir/` runtime helpers); they are pinned in
// ALLOWED below with their rationale so the surface is frozen and
// catalogued (each entry is a cleanup worklist item) rather than
// silently growing.  A new backward value-edge fails here.
// ---------------------------------------------------------------------------

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const srcDir = path.join(repoRoot, "src");

/** Pre-existing value backward-edges, pinned so the surface can't grow.
 *  Keyed by the importing file (repo-relative); the value is the set of
 *  downstream module specifiers it is permitted to value-import, each
 *  with the reason it exists / how it should eventually be removed.
 *
 *  EMPTY — there are no permitted backward value-edges.  The pipeline's
 *  value-dependency graph is acyclic.  The historical exceptions were
 *  all resolved by relocating the shared, mislocated code to the layer
 *  its consumers actually live at:
 *    - `generator/_packs/builtin-formats.ts` → `util/builtin-formats.ts`
 *    - the `application:`/`shape(…)` platform-axes lookups in
 *      `ir/types/loom-ir.ts`     → `util/platform-axes.ts`
 *    - `ir/source-types.ts`      → `util/source-types.ts`
 *    - `system/sql-pg.ts`        → `generator/sql-pg.ts` (the Postgres
 *      SQL renderer is consumed only by the generator backends, never by
 *      system composition, so it was an upstream generator→system edge)
 *  A new backward value-edge fails the assertions below; only add a pin
 *  here if inverting the dependency is genuinely impossible (it has not
 *  been so far). */
const ALLOWED: Record<string, { spec: string; why: string }[]> = {};

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(full));
    else if (entry.isFile() && full.endsWith(".ts") && !full.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

interface Import {
  /** The raw module specifier, e.g. `../../ir/source-types.js`. */
  spec: string;
  /** True when the statement is `import type` / `export type`, or every
   *  named member is `type`-prefixed — i.e. no runtime dependency. */
  typeOnly: boolean;
}

// `import [type] (… ) from "x"` and re-exporting `export [type] … from "x"`.
const IMPORT_RE = /(?:import|export)\s+(type\s+)?([^"';]*?)\s*from\s*["']([^"']+)["']/g;
// Side-effect import: `import "x";` — no bindings, so it's a runtime edge.
const SIDE_EFFECT_RE = /(?:^|[;\n])\s*import\s+["']([^"']+)["']/g;
// Runtime dynamic import: `import("x")`.  The negative lookahead for a
// trailing `.` excludes TypeScript's inline import-TYPE annotations
// (`import("./ast.js").Foo`), which are pervasive here and carry no runtime
// edge — only a genuine `await import("x")` / promise use is flagged.
const DYNAMIC_RE = /\bimport\(\s*["']([^"']+)["']\s*\)(?!\s*\.)/g;

function importsOf(src: string): Import[] {
  const out: Import[] = [];
  for (const m of src.matchAll(IMPORT_RE)) {
    const typeKw = !!m[1];
    const clause = m[2] ?? "";
    const spec = m[3]!;
    const brace = clause.match(/\{([^}]*)\}/);
    let typeOnly = typeKw;
    if (!typeOnly && brace) {
      const members = brace[1]!
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      typeOnly = members.length > 0 && members.every((x) => x.startsWith("type "));
    }
    out.push({ spec, typeOnly });
  }
  // Side-effect + dynamic imports are always runtime (value) edges.
  for (const m of src.matchAll(SIDE_EFFECT_RE)) out.push({ spec: m[1]!, typeOnly: false });
  for (const m of src.matchAll(DYNAMIC_RE)) out.push({ spec: m[1]!, typeOnly: false });
  return out;
}

/** A normalised "module key" for a specifier, dropping the `.js`
 *  extension and any leading `../`, so `../../ir/source-types.js`
 *  → `ir/source-types`.  Used to match against ALLOWED. */
function moduleKey(spec: string, layer: string): string {
  const after = spec.slice(spec.indexOf(`${layer}/`));
  return after.replace(/\.js$/, "");
}

function hits(spec: string, layer: string): boolean {
  return new RegExp(`(^|/)${layer}/`).test(spec);
}

/** Collect value backward-edges from `files` into any of `bannedLayers`,
 *  minus the ALLOWED pins.  Returns repo-relative `file -> spec` strings. */
function offenders(files: string[], bannedLayers: string[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    const rel = path.relative(repoRoot, f);
    const allowed = ALLOWED[rel] ?? [];
    for (const imp of importsOf(fs.readFileSync(f, "utf-8"))) {
      if (imp.typeOnly) continue; // type imports carry no runtime edge
      const layer = bannedLayers.find((b) => hits(imp.spec, b));
      if (!layer) continue;
      const key = moduleKey(imp.spec, layer);
      if (allowed.some((a) => a.spec === key)) continue;
      out.push(`${rel} -> ${key}`);
    }
  }
  return out;
}

describe("pipeline layering — value imports point one way", () => {
  const languageFiles = tsFiles(path.join(srcDir, "language"));
  const irFiles = tsFiles(path.join(srcDir, "ir"));
  const generatorFiles = tsFiles(path.join(srcDir, "generator"));
  const macroFiles = tsFiles(path.join(srcDir, "macros"));
  const platformFiles = tsFiles(path.join(srcDir, "platform"));

  it("scans a non-trivial number of files (guard against vacuous pass)", () => {
    expect(languageFiles.length).toBeGreaterThan(15);
    expect(irFiles.length).toBeGreaterThan(15);
    expect(generatorFiles.length).toBeGreaterThan(15);
    expect(macroFiles.length).toBeGreaterThan(5);
    expect(platformFiles.length).toBeGreaterThan(5);
  });

  it("language/ does not value-import from ir/, generator/ or system/ (beyond pinned edges)", () => {
    expect(
      offenders(languageFiles, ["ir", "generator", "system"]),
      "New value backward-edge from language/. Type-only imports are fine; " +
        "for a runtime symbol, move the shared code upstream or thread it in. " +
        "Known pins live in ALLOWED.",
    ).toEqual([]);
  });

  it("ir/ does not value-import from generator/ or system/ (beyond pinned edges)", () => {
    expect(
      offenders(irFiles, ["generator", "system"]),
      "New value backward-edge from ir/ → generator/ or system/. Known pins live in ALLOWED.",
    ).toEqual([]);
  });

  it("generator/ does not value-import from system/ (the terminal composition layer)", () => {
    expect(
      offenders(generatorFiles, ["system"]),
      "New value backward-edge from generator/ → system/. system/ composes generator " +
        "outputs — a shared helper consumed by generators belongs in generator/ (or util/), " +
        "not system/. Known pins live in ALLOWED.",
    ).toEqual([]);
  });

  it("generator/ does not value-import from language/ (the compiler front-end)", () => {
    // The shared IR vocabulary (`language/generated/ast.js`) is imported
    // type-only by generators and is exempt; a RUNTIME symbol from `language/`
    // in a generator is a backward edge (the audit found `walker-core.ts` →
    // `walker-stdlib.js`, since relocated to `util/walker-primitive-names.ts`).
    expect(
      offenders(generatorFiles, ["language"]),
      "New value backward-edge from generator/ → language/. A shared name set / helper " +
        "consumed by both the validator and a generator belongs in util/, not language/. " +
        "Type-only imports of the AST vocabulary are exempt.",
    ).toEqual([]);
  });

  it("macros/ (phase ②) does not value-import from ir/, generator/ or system/", () => {
    // The macro layer runs AST→AST at phase ②, upstream of lowering.  It may
    // read `language/` (the AST it rewrites) but nothing downstream — a macro
    // reaching into `ir/`/`generator/`/`system/` would invert the pipeline.
    expect(
      offenders(macroFiles, ["ir", "generator", "system"]),
      "New value backward-edge from macros/. Macros run at phase ② (AST→AST) and may only " +
        "depend on language/ + util/; downstream layers must not be imported upward.",
    ).toEqual([]);
  });

  it("platform/ does not value-import from system/ (the terminal composition layer)", () => {
    // Direction: platform surfaces delegate DOWN into generator/ (intended —
    // `platform/dotnet.ts` → `generator/dotnet/…`), and are read from the
    // front half only through the client-safe metadata leaves (guarded by
    // metadata-boundary.test.ts).  What they must NOT do is reach UP into
    // system/, which composes the surfaces — that would be a cycle.
    expect(
      offenders(platformFiles, ["system"]),
      "New value backward-edge from platform/ → system/. system/ composes the platform " +
        "surfaces; a surface must not import the composer.",
    ).toEqual([]);
  });

  it("no generator/<platform>/ imports a sibling platform directory", () => {
    // Derived from the tree, not hardcoded: every non-underscore subdir
    // of `src/generator/` is a per-platform generator (`dotnet`, `vue`,
    // …); the `_`-prefixed dirs (`_walker`, `_expr`, `_frontend`, …) are
    // the SHARED seams every platform may legitimately import.  Deriving
    // the set means a newly-added platform (java/python/vue were all
    // missed by the old hardcoded `["typescript","dotnet","elixir","react"]`
    // list) is guarded automatically, with no edit here.
    const platformDirs = fs
      .readdirSync(path.join(srcDir, "generator"), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
      .map((e) => e.name);
    expect(
      platformDirs.length,
      "Expected to discover the per-platform generator dirs; did the layout change?",
    ).toBeGreaterThanOrEqual(5);
    // Pinned sibling edges (frozen, not license to grow):
    //   - dotnet/elixir/java → react/svelte/vue index: the fullstack-host embed —
    //     a backend hosting a frontend SPA calls that frontend's
    //     generator to emit the embedded project (ClientApp/, priv/spa).
    //     This is deliberate composition, not a layering accident.
    //   - elixir/theme-emit & vue → react/...: framework-neutral frontend
    //     helpers (the theme VM preparer, the money-schema constant, the
    //     id-target form helper) that are still homed in react/; Vue reuses
    //     them rather than re-deriving. Relocation into _frontend/ is a
    //     follow-up — these are frozen, not a licence to grow new edges.
    const pinnedSibling = new Set([
      "src/generator/angular/index.ts -> generator/react/",
      "src/generator/dotnet/index.ts -> generator/react/",
      "src/generator/dotnet/index.ts -> generator/svelte/",
      "src/generator/dotnet/index.ts -> generator/vue/",
      "src/generator/elixir/vanilla/index.ts -> generator/react/",
      "src/generator/elixir/vanilla/index.ts -> generator/svelte/",
      "src/generator/elixir/vanilla/index.ts -> generator/vue/",
      "src/generator/java/index.ts -> generator/react/",
      "src/generator/java/index.ts -> generator/svelte/",
      "src/generator/java/index.ts -> generator/vue/",
      "src/generator/python/index.ts -> generator/react/",
      "src/generator/vue/index.ts -> generator/react/",
      "src/generator/vue/walker/page-shell.ts -> generator/react/",
    ]);
    const out: string[] = [];
    for (const plat of platformDirs) {
      const dir = path.join(srcDir, "generator", plat);
      for (const f of tsFiles(dir)) {
        for (const imp of importsOf(fs.readFileSync(f, "utf-8"))) {
          if (imp.typeOnly) continue; // type imports carry no runtime edge
          // Relative specifiers never contain "generator/" — resolve them
          // against the importing file so `../../react/foo.js` from
          // svelte/walker/ is seen as generator/react/.
          const resolved = imp.spec.startsWith(".")
            ? path.resolve(path.dirname(f), imp.spec)
            : imp.spec;
          const sibling = platformDirs.find(
            (p) => p !== plat && new RegExp(`(^|/)generator/${p}/`).test(resolved),
          );
          if (!sibling) continue;
          const edge = `${path.relative(repoRoot, f)} -> generator/${sibling}/`;
          if (!pinnedSibling.has(edge)) out.push(edge);
        }
      }
    }
    expect(out, "A platform generator must not import a sibling platform.").toEqual([]);
  });

  it("shared walker/frontend layers (_walker/, _frontend/) do not value-import a platform directory", () => {
    // The shared core's premise is that platform specifics flow in
    // through the WalkerTarget contract / pack templates — a runtime
    // import from _walker/ or _frontend/ into a platform dir reverses
    // that.  Pinned exception: _walker/registry.ts's HEEx renderer
    // table predates the WalkerTarget extraction (the heex walker is a
    // parallel sibling); it is frozen here, not license to grow.
    const platformDirs = ["typescript", "dotnet", "elixir", "react", "svelte", "java", "python"];
    const pinned = new Set(["src/generator/_walker/registry.ts -> generator/elixir/"]);
    const out: string[] = [];
    for (const shared of ["_walker", "_frontend"]) {
      for (const f of tsFiles(path.join(srcDir, "generator", shared))) {
        for (const imp of importsOf(fs.readFileSync(f, "utf-8"))) {
          if (imp.typeOnly) continue;
          const resolved = imp.spec.startsWith(".")
            ? path.resolve(path.dirname(f), imp.spec)
            : imp.spec;
          const plat = platformDirs.find((p) => new RegExp(`(^|/)generator/${p}/`).test(resolved));
          if (!plat) continue;
          const edge = `${path.relative(repoRoot, f)} -> generator/${plat}/`;
          if (!pinned.has(edge)) out.push(edge);
        }
      }
    }
    expect(
      out,
      "Shared _walker//_frontend/ code must not runtime-import a platform generator — " +
        "move the helper into the shared layer (leave a platform-side re-export shim).",
    ).toEqual([]);
  });
});
