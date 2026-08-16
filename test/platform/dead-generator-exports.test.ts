import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Dead-export gate (M-T9.8, hollow-work audit, graduated CI check #1).
//
// A recurring hollow-work smell: an emitter function is written, exported, and
// then never wired into the orchestrator — dead code that still type-checks, so
// no gate notices.  The 2026-07-13 audit found `renderSpaController` this way
// (a whole `elixir/shell/web.ts` bundle of `render*` helpers superseded by the
// `renderVanilla*` emitters in `vanilla/shell-emit.ts`, left behind with a
// stale "re-exported for the orchestrator" comment).
//
// This gate fails on any `export`ed `render*` / `emit* `/ `build*` function,
// const, or class in `src/generator/` or `src/platform/` that no OTHER file in
// `src/` or `test/` references.  It is deliberately regex-based (no knip /
// ts-prune dependency) — the same lightweight, self-contained approach as
// `pipeline-layering.test.ts`, so it rides the fast per-PR suite.
//
// Two ways to clear a hit, both better than the status quo:
//   - DELETE it if it is genuinely dead (the elixir case);
//   - drop `export` if it is only used inside its own file (over-exported).
// If a symbol is exported for a consumer that legitimately can't be
// name-referenced (dynamic dispatch), pin it in ALLOW with the reason.
//
// Heuristic bounds (conservative — it under-reports rather than false-flags):
//   - "referenced" = the identifier appears as a token in some other file.  A
//     comment mention or a same-named export in a second backend counts as a
//     reference, so the gate won't flag those; that's the safe direction.
// ---------------------------------------------------------------------------

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const srcDir = path.join(repoRoot, "src");
const testDir = path.join(repoRoot, "test");

/** Exports that are legitimately unreferenced by name (e.g. dynamic dispatch).
 *  EMPTY — the tree has no dead generator exports.  An entry here is a
 *  documented, reviewed exception; keyed by "<repo-rel-file> :: <name>". */
const ALLOW = new Set<string>([]);

/** Re-export shims that may stay with no in-repo importer.  Keyed by
 *  repo-relative path.  The 16 the 2026-08-13 import-graph census found were
 *  deleted rather than pinned; what remains is the one case the rule cannot
 *  distinguish — a PUBLISHED barrel, whose consumers are outside this repo. */
const ALLOW_SHIMS = new Set<string>([
  // The MCP server core's public surface, re-exported by the publish wrapper
  // `packages/ddd-mcp/` (which resolves the built `out/mcp/`, not this path).
  // A package entry point is unreferenced in-tree BY DESIGN.
  "src/mcp/index.ts",
]);

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(full));
    else if (entry.isFile() && full.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Every `.ts`/`.tsx` under `dir` — the shim check's importer population, which
 *  spans the playground too (it imports the toolchain straight from `../src`). */
function allSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...allSourceFiles(full));
    else if (entry.isFile() && (full.endsWith(".ts") || full.endsWith(".tsx"))) out.push(full);
  }
  return out;
}

/** `export [async] function|const|class renderX` / `emitX` / `buildX`. */
const EXPORT_RE =
  /\bexport\s+(?:async\s+)?(?:function|const|class)\s+((?:render|emit|build)[A-Za-z0-9_]*)/g;

/** Every identifier-like token in a source, as a Set (for O(1) membership). */
function identifiers(src: string): Set<string> {
  const out = new Set<string>();
  for (const m of src.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) out.add(m[0]);
  return out;
}

describe("dead generator exports (M-T9.8)", () => {
  const targetFiles = [path.join(srcDir, "generator"), path.join(srcDir, "platform")]
    .flatMap(tsFiles)
    .filter((f) => !f.endsWith(".test.ts"));

  // Identifier index over every src + test file, so "referenced anywhere else"
  // is a set membership check rather than a re-scan per name.
  const allFiles = [...tsFiles(srcDir), ...tsFiles(testDir)];
  const identsByFile = new Map(allFiles.map((f) => [f, identifiers(fs.readFileSync(f, "utf8"))]));

  it("scans a non-trivial number of generator/platform files", () => {
    expect(targetFiles.length).toBeGreaterThan(100);
  });

  it("finds render*/emit*/build* exports to check (guard against vacuous pass)", () => {
    const total = targetFiles.reduce((n, f) => {
      const src = fs.readFileSync(f, "utf8");
      return n + [...src.matchAll(EXPORT_RE)].length;
    }, 0);
    expect(total).toBeGreaterThan(50);
  });

  it("every exported render*/emit*/build* is referenced outside its own file", () => {
    const dead: string[] = [];
    for (const f of targetFiles) {
      const src = fs.readFileSync(f, "utf8");
      const names = new Set<string>();
      for (const m of src.matchAll(EXPORT_RE)) names.add(m[1]!);
      for (const name of names) {
        const rel = path.relative(repoRoot, f);
        if (ALLOW.has(`${rel} :: ${name}`)) continue;
        let referenced = false;
        for (const [other, idents] of identsByFile) {
          if (other === f) continue;
          if (idents.has(name)) {
            referenced = true;
            break;
          }
        }
        if (!referenced) dead.push(`${rel} :: ${name}`);
      }
    }
    expect(
      dead,
      "Dead generator export(s) — exported but referenced by no other file. " +
        "Delete it if unused, or drop `export` if it is only used in-file. " +
        "See M-T9.8.\n" +
        dead.join("\n"),
    ).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // The blind spot the check above structurally has: it matches export NAMES,
  // and a bare `export * from "…"` re-export shim declares none.  Moving a
  // module into `_walker/` / `_frontend/` and leaving a shim behind "so the old
  // import path keeps working" is the repo's normal migration step — and when
  // the last importer is migrated too, the shim becomes a file whose entire
  // content is a forward to somewhere else, referenced by nobody, invisible to
  // every gate.  The 2026-08-13 import-graph census found SIXTEEN of them
  // (`scripts/unimported-census.mjs`); they are deleted, and this keeps the
  // count at zero.
  //
  // A shim is: a file whose every non-comment line is an `export * from`/
  // `export { … } from`.  Dead is: no file under src/, test/ or web/src/
  // imports it.  Specifiers must be RESOLVED, not suffix-matched: a sibling
  // imports `"./heex-walker.js"`, which contains none of its own directory, so
  // a substring test reports live shims as dead.  (It did, on the first run
  // here — nine false positives, caught only because the shims it named were
  // hand-checked against `grep`.  Left as a comment rather than a lesson
  // learned twice.)
  // -------------------------------------------------------------------------
  it("no re-export shim survives its last importer", () => {
    const importerRoots = [srcDir, testDir, path.join(repoRoot, "web", "src")].filter((d) =>
      fs.existsSync(d),
    );

    /** Every module path imported anywhere, resolved to an absolute `.ts`. */
    const imported = new Set<string>();
    for (const importer of importerRoots.flatMap(allSourceFiles)) {
      const src = fs.readFileSync(importer, "utf8");
      for (const m of src.matchAll(/\bfrom\s+["'](\.[^"']+)["']/g)) {
        const resolved = path
          .resolve(path.dirname(importer), m[1]!)
          .replace(/\.js$/, ".ts")
          .replace(/\.jsx$/, ".tsx");
        imported.add(resolved);
        // A directory import resolves to that directory's index module.
        imported.add(path.join(resolved.replace(/\.tsx?$/, ""), "index.ts"));
      }
    }

    const dead: string[] = [];
    for (const f of tsFiles(srcDir)) {
      const rel = path.relative(repoRoot, f);
      if (ALLOW_SHIMS.has(rel)) continue;
      const body = fs
        .readFileSync(f, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("//") && !l.startsWith("*") && !l.startsWith("/*"));
      if (body.length === 0 || !body.every((l) => /^export\s+(\*|\{)/.test(l))) continue;
      if (!imported.has(f)) dead.push(rel);
    }

    expect(
      dead,
      "Re-export shim(s) with no importer left — the module moved, every caller " +
        "followed it, and only the forwarding stub remains.  Delete them (that is " +
        "what the move was for), or pin in ALLOW_SHIMS with the reason:\n" +
        dead.join("\n"),
    ).toEqual([]);
  });
});
