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

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(full));
    else if (entry.isFile() && full.endsWith(".ts")) out.push(full);
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
});
