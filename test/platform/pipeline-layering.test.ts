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

  it("scans a non-trivial number of files (guard against vacuous pass)", () => {
    expect(languageFiles.length).toBeGreaterThan(15);
    expect(irFiles.length).toBeGreaterThan(15);
    expect(generatorFiles.length).toBeGreaterThan(15);
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

  it("no generator/<platform>/ imports a sibling platform directory", () => {
    const platformDirs = ["typescript", "dotnet", "phoenix-live-view", "react"];
    const out: string[] = [];
    for (const plat of platformDirs) {
      const dir = path.join(srcDir, "generator", plat);
      if (!fs.existsSync(dir)) continue;
      for (const f of tsFiles(dir)) {
        for (const imp of importsOf(fs.readFileSync(f, "utf-8"))) {
          const sibling = platformDirs.find(
            (p) => p !== plat && new RegExp(`/generator/${p}/`).test(imp.spec),
          );
          if (sibling) out.push(`${path.relative(repoRoot, f)} -> generator/${sibling}/`);
        }
      }
    }
    expect(out, "A platform generator must not import a sibling platform.").toEqual([]);
  });
});
