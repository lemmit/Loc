import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// The IP / bundle boundary, enforced at TRANSITIVE depth.
//
// `platform/registry.ts` (the GENERATION registry) statically imports every
// backend surface, each of which imports its generator under `src/generator/`.
// So a module graph that reaches `registry.ts` — DIRECTLY OR THROUGH ANY CHAIN
// of value imports — drags ALL backend generators (.NET / Java / Phoenix /
// Python) into that bundle.
//
// The front half of the toolchain — language services (validators) + the IR
// passes (lower / enrich / validate) — must read platform facts ONLY from the
// client-safe leaves (`platform/metadata.ts`, `platform/adapter-metadata.ts`),
// which import no surfaces.  Then a client build whose entry stays within
// `language/` + `ir/` tree-shakes the premium generators out by construction.
//
// The OLD version of this test matched a literal `from ".../platform/registry"`
// import ONE HOP deep, so a transitive leak slipped through: `platform-rules.ts`
// → `resolve-adapters.ts` → `registry.ts` pulled all five generators into any
// client bundle that touched the validator (audit finding — the "bundle-split
// defeat").  This version walks the whole value-import closure from every
// language/ + ir/ file and fails if `registry.ts` is reachable by ANY path.
// Type-only imports are skipped — they carry no runtime edge (erased at emit),
// so they cannot drag a generator into the bundle.
// ---------------------------------------------------------------------------

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const srcDir = path.join(repoRoot, "src");
const registryFile = path.join(srcDir, "platform", "registry.ts");

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...tsFiles(p));
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

// Static `import [type] … from "x"` / re-exporting `export [type] … from "x"`.
const FROM_RE = /(?:import|export)\s+(type\s+)?([^"';]*?)\s*from\s*["']([^"']+)["']/g;
// Side-effect import: `import "x";` (no bindings → a runtime edge).
const SIDE_EFFECT_RE = /(?:^|[;\n])\s*import\s+["']([^"']+)["']/g;
// Runtime dynamic import: `import("x")`.  The negative lookahead for a
// trailing `.` excludes TypeScript's inline import-TYPE annotations
// (`import("./ast.js").Foo`) — those are erased at emit and carry no runtime
// edge, so they must not count toward reachability.
const DYNAMIC_RE = /\bimport\(\s*["']([^"']+)["']\s*\)(?!\s*\.)/g;

/** The VALUE (runtime) import specifiers of a source file — type-only static
 *  imports are dropped (no runtime edge), side-effect + dynamic imports are
 *  included. */
function valueSpecs(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(FROM_RE)) {
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
    if (!typeOnly) out.push(spec);
  }
  for (const m of src.matchAll(SIDE_EFFECT_RE)) out.push(m[1]!);
  for (const m of src.matchAll(DYNAMIC_RE)) out.push(m[1]!);
  return out;
}

/** Resolve a relative specifier to an on-disk `.ts` file under `src/`, or
 *  `undefined` for a bare/external specifier (packages, `langium`, …). */
function resolveSpec(fromFile: string, spec: string): string | undefined {
  if (!spec.startsWith(".")) return undefined;
  const base = path.resolve(path.dirname(fromFile), spec.replace(/\.js$/, ""));
  for (const cand of [`${base}.ts`, path.join(base, "index.ts")]) {
    if (fs.existsSync(cand)) return cand;
  }
  return undefined;
}

// Build the value-import adjacency over all of src/ once.
const allFiles = tsFiles(srcDir);
const edges = new Map<string, string[]>();
for (const f of allFiles) {
  const targets: string[] = [];
  for (const spec of valueSpecs(fs.readFileSync(f, "utf8"))) {
    const resolved = resolveSpec(f, spec);
    if (resolved) targets.push(resolved);
  }
  edges.set(f, targets);
}

/** True when `start` can reach `registry.ts` through any chain of value imports. */
function reachesRegistry(start: string): boolean {
  const seen = new Set<string>([start]);
  const stack = [start];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const next of edges.get(cur) ?? []) {
      if (next === registryFile) return true;
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return false;
}

describe("front half never transitively reaches the generation registry", () => {
  it("registry.ts is discoverable (guard against a vacuous pass)", () => {
    expect(fs.existsSync(registryFile)).toBe(true);
    expect(edges.size).toBeGreaterThan(100);
  });

  it.each([
    "language",
    "ir",
  ])("no file under src/%s reaches platform/registry via any value-import chain", (rel) => {
    const offenders = tsFiles(path.join(srcDir, rel))
      .filter(reachesRegistry)
      .map((f) => path.relative(repoRoot, f));
    expect(
      offenders,
      "A front-half module transitively pulls platform/registry (and thus every backend " +
        "generator) into the client bundle. Read platform facts from platform/metadata.ts / " +
        "platform/adapter-metadata.ts instead, or thread the datum in.",
    ).toEqual([]);
  });
});
