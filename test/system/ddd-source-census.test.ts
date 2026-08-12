// Every tracked `.ddd` in the repo parses — and every standalone one validates.
//
// The repo has ~340 `.ddd` files and, until this gate, no check that asked all
// of them anything.  What existed were hand-maintained ALLOWLISTS — the playground
// picker's three suites name their files one by one, the corpus manifest names
// its features, the behavioral corpus names its systems.  A list is exactly as
// good as someone's memory to append to it: a fixture nobody lists is a fixture
// nobody checks, and it rots silently until a contributor opens it.
//
// That is not hypothetical.  This gate's first run found `examples/sales-ui.ddd`
// — a file the top-level README advertises in its examples table — failing with
// six syntax errors.  (It turns out to say so itself, in its own header; see the
// pin below.  The README does not.)
//
// TWO gates, because they answer different questions:
//
//  1. PARSE — every tracked file, no exception beyond the pinned set, must reach
//     ZERO `parserErrors`.  This is the syntax-rot net: a grammar change that
//     invalidates an old fixture fails here, in the fast suite, instead of at
//     whatever slow matrix happens to touch that file.  It also closes the
//     error-RECOVERY hole (`experience_gathered.md` §59, #2302): Langium recovers
//     from a syntax error and hands back a partial AST, so a test that only looks
//     at the AST sees a smaller model rather than a failure.  `parserErrors` is
//     the only place that recovery is visible.
//
//  2. VALIDATE — every file that is a self-contained document must reach zero
//     AST-validation errors.  Members of a MULTI-FILE project are excluded, and
//     the exclusion is DERIVED, not listed: a file is a member iff some other
//     tracked `.ddd` imports it (the `import "./x.ddd"` graph).  Standalone, a
//     member reports its siblings' declarations as unresolved — an artifact of
//     reading it alone, not a defect — and its ENTRY is validated through the
//     project loader by the playground suites.  Deriving membership means a new
//     fragment classifies itself instead of failing until someone edits a list.
//
// Both ratchet on an EXACT set: a pin that stops matching (the file was fixed,
// renamed or deleted) fails as stale, so the fix deletes its pin in the same PR.

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, normalize, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseRawResult, parseString } from "../_helpers/parse.js";

const REPO = resolve(import.meta.dirname, "..", "..");

/** Every `.ddd` git tracks — the whole population, by construction. */
function trackedDddFiles(): string[] {
  return execSync("git ls-files '*.ddd'", { cwd: REPO, encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean)
    .sort();
}

/** `__PLATFORM__`-tokenized corpus fixtures are templates, not sources — the
 *  runners substitute a backend before parsing, and so does this census. */
function sourceOf(file: string): string {
  return readFileSync(resolve(REPO, file), "utf8").replaceAll("__PLATFORM__", "node");
}

/** Every participant in a multi-file project — BOTH directions of the import
 *  edge, because a single-document parse resolves neither:
 *
 *    • a file that IS imported reports its entry's declarations as unresolved;
 *    • the ENTRY that does the importing reports its members' declarations as
 *      unresolved, since `parseString` does not follow the import statements
 *      (that is `loadProject`'s job, and what the playground suites use).
 *
 *  Derived from the `import "…"` statements themselves, so a new fragment — or a
 *  new entry — classifies itself instead of failing until someone edits a list. */
function projectMembers(files: readonly string[]): Set<string> {
  const members = new Set<string>();
  for (const f of files) {
    const dir = dirname(resolve(REPO, f));
    const matches = [...sourceOf(f).matchAll(/^\s*import\s+"([^"]+)"/gm)];
    if (matches.length === 0) continue;
    members.add(normalize(f)); // the entry
    for (const m of matches) {
      members.add(normalize(relative(REPO, resolve(dir, m[1])))); // its members
    }
  }
  return members;
}

// ---------------------------------------------------------------------------
// The pins.  Each is a file that CANNOT satisfy the gate, with the reason —
// never a file that merely happens to fail.
// ---------------------------------------------------------------------------

/** Does not PARSE, and says so in its own first paragraph: "This file does NOT
 *  parse with the current Langium grammar; it is the target syntax driving the
 *  discussion.  It is a HISTORICAL prototype".  It is a design document that
 *  happens to carry a `.ddd` extension — `Dashboard(items: [...])`, `Stat { api
 *  Sales.Order.all }` and `MasterDetail` were proposed and never shipped (or
 *  were retired), which its header also records.
 *
 *  Kept rather than deleted: it is the page-metamodel discussion's record, and
 *  `docs/new-plan/missions/M-T1.3-charts-and-dashboards-scope.md` cites it as
 *  prior art.  Pinned rather than silently skipped, because "a tracked .ddd that
 *  does not parse" is worth one line of explanation — and because the README
 *  advertises it beside files that DO parse, which is a docs-truth gap this pin
 *  is the evidence for. */
const UNPARSEABLE = ["examples/sales-ui.ddd"] as const;

/** Parses, but is INVALID ON PURPOSE — the subject of a negative test. Its own
 *  name says so; `test/cli/*` asserts the diagnostics it produces. */
const DELIBERATELY_INVALID = ["test/cli/fixtures/bad-model.ddd"] as const;

/** Entry files of a multi-file project whose SIBLINGS are imported but which
 *  are not themselves imported by anything — so the derived rule cannot see
 *  them, yet they still only validate through the project loader.
 *
 *  `web/src/examples/erp/finance.ddd` is a bare `subdomain` file that composes
 *  into `erp/main.ddd`'s system; read alone it trips the "a top-level
 *  'subdomain' composes into the project's single 'system'" check. It IS
 *  validated, through `main.ddd`, by `playground-feature-examples.test.ts`. */
const PROJECT_MEMBER_NOT_IMPORTED = ["web/src/examples/erp/finance.ddd"] as const;

describe("`.ddd` source census — every tracked file, not a hand-kept list", () => {
  const files = trackedDddFiles();

  it("finds the whole population (the census must not silently shrink)", () => {
    // Guards the scanner itself: a broken `git ls-files` or glob would make
    // every assertion below pass vacuously.
    expect(files.length).toBeGreaterThan(300);
    expect(files).toContain("test/fixtures/corpus/core-domain.ddd");
    expect(files).toContain("examples/acme.ddd");
  });

  it("parses every tracked `.ddd` with zero parser errors", () => {
    const failed: string[] = [];
    for (const f of files) {
      if ((UNPARSEABLE as readonly string[]).includes(f)) continue;
      const result = parseRawResult(sourceOf(f));
      if (result.parserErrors.length > 0) {
        failed.push(`${f}: ${result.parserErrors[0]?.message ?? "parser error"}`);
      }
    }
    expect(
      failed,
      "a tracked `.ddd` no longer parses. Langium RECOVERS from a syntax error and " +
        "returns a partial AST, so nothing else in the suite would notice — fix the " +
        "source, or pin it in UNPARSEABLE with the reason it cannot parse.",
    ).toEqual([]);
    // Explicit budget, not the suite default: this walks EVERY tracked `.ddd`,
    // so its cost grows with the repo, and CI runs it under 4-way shard
    // contention with coverage instrumentation attached — where the ~3s local
    // parse sweep is nowhere near the ~30s default, but the validate sweep
    // below was, and timed out at 30s on its first CI run.
  }, 300_000);

  it("pins no file that parses fine (a stale pin is a lie)", () => {
    const stale = (UNPARSEABLE as readonly string[]).filter(
      (f) => parseRawResult(sourceOf(f)).parserErrors.length === 0,
    );
    expect(stale, "these are pinned as unparseable but parse clean — delete the pin").toEqual([]);
  });

  it("validates every self-contained `.ddd` with zero AST errors", async () => {
    const inProject = projectMembers(files);
    const excluded = new Set<string>([
      ...UNPARSEABLE,
      ...DELIBERATELY_INVALID,
      ...PROJECT_MEMBER_NOT_IMPORTED,
    ]);
    const failed: string[] = [];
    for (const f of files) {
      if (excluded.has(f) || inProject.has(f)) continue;
      const result = await parseString(sourceOf(f), { validate: true });
      if (result.errors.length > 0) failed.push(`${f}: ${result.errors[0]}`);
    }
    expect(
      failed,
      "a tracked standalone `.ddd` fails AST validation. If it is a member of a " +
        "multi-file project, it should be reached by an `import` from its entry " +
        "(membership is derived from the import graph, not listed here).",
    ).toEqual([]);
    // ~15s locally for 339 files; the budget is the same one the parse sweep
    // carries, for the same reason.
  }, 300_000);

  it("still rejects the deliberately-invalid fixture", async () => {
    // The negative control. Without it, a validator that stopped reporting
    // anything at all would pass every assertion above.
    for (const f of DELIBERATELY_INVALID) {
      const result = await parseString(sourceOf(f), { validate: true });
      expect(result.errors.length, `${f} is pinned as invalid but validates clean`).toBeGreaterThan(
        0,
      );
    }
  });
});
