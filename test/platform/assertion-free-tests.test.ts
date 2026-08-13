import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Assertion-free test ratchet (M-T9.8 item (e), graduated).
//
// A case that asserts nothing passes unconditionally — a test-shaped no-op that
// counts toward the suite's size while measuring nothing.  The hollow-work
// audit has carried this as a RECURRING MANUAL sweep since 2026-07-13.
//
// The 2026-08-13 census ran it properly and found the class already drained:
// 35 cases in 16,584, every one benign on inspection (3 type-level contract
// tests where `tsc` IS the assertion; 22 opt-in e2e cases delegating to a
// helper that asserts or throws — `runMigrationEvolutionGate`, `waitFor`).
// There is nothing to fix, so the sweep should stop being a task somebody
// remembers to run and start being this: a pinned set that cannot grow.
//
// AST-BASED, NOT REGEX, and that is not a style preference.  The obvious
// version (match `it(`, brace-count to the closing `}`) reports 525 against
// this suite's real 35 — a 15x false-positive rate, because template literals,
// nested object literals and regex bodies all break naive brace counting.  A
// sweep that cries wolf 15 times out of 16 does not get run, which is a fair
// description of how this one went for a month.
//
// The pins are an EXACT set, not a count: a new assertion-free case fails, and
// so does a pin that stops being assertion-free (it gained an assertion, or the
// case moved) — so the fix deletes its pin in the same PR.  Line numbers are
// deliberately NOT pinned; they churn for unrelated reasons.  A file may hold
// several pinned cases, so the pin is `<file> :: <count>`.
// ---------------------------------------------------------------------------

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const testRoot = path.join(repoRoot, "test");

/**
 * Assertion-free cases per file — the reviewed set as of 2026-08-13.
 *
 * Three shapes, all legitimate:
 *   TYPE-LEVEL   — the body inhabits a contract with an explicit lambda per
 *                  method so a signature mismatch fails `tsc`.  The compiler is
 *                  the assertion; an `expect` would add nothing.
 *   DELEGATING   — the body calls a shared harness that asserts or throws
 *                  internally (the opt-in runtime tiers do this throughout).
 *   NARROW-SCOPE — a case whose subject is that a call does not throw.
 */
const PINNED: Record<string, number> = {
  // TYPE-LEVEL — one per adapter contract (persistence / style / layout).
  "test/adapters/contract-shape.test.ts": 3,
  // NARROW-SCOPE — walker/IR shape probes whose subject is "this does not throw".
  "test/generator/_walker/builder-page-model.test.ts": 1,
  "test/ir/util/walk.test.ts": 3,
  "test/language/print/field-access-soft-keyword.test.ts": 3,
  "test/language/type-system/money-type-system.test.ts": 2,
  "test/playground/system-builder/expr-model-forms.test.ts": 1,
  // DELEGATING — opt-in e2e tiers; the harness asserts (or `waitFor` throws).
  "test/e2e/channels-e2e-kafka.test.ts": 1,
  "test/e2e/channels-e2e-kafka-dotnet.test.ts": 1,
  "test/e2e/channels-e2e-kafka-elixir.test.ts": 1,
  "test/e2e/channels-e2e-kafka-java.test.ts": 1,
  "test/e2e/channels-e2e-kafka-python.test.ts": 1,
  "test/e2e/channels-e2e-rabbit.test.ts": 1,
  "test/e2e/channels-e2e-rabbit-dotnet.test.ts": 1,
  "test/e2e/channels-e2e-rabbit-elixir.test.ts": 1,
  "test/e2e/channels-e2e-rabbit-java.test.ts": 1,
  "test/e2e/channels-e2e-rabbit-python.test.ts": 1,
  "test/e2e/e2e.test.ts": 1,
  "test/e2e/generated-angular-build.test.ts": 1,
  "test/e2e/generated-dotnet-format.test.ts": 1,
  "test/e2e/generated-java-build.test.ts": 2,
  "test/e2e/generated-vue-build.test.ts": 1,
  "test/e2e/k8s-validate.test.ts": 1,
  "test/e2e/migration-evolution.test.ts": 1,
  "test/e2e/migration-evolution-dotnet.test.ts": 1,
  "test/e2e/migration-evolution-elixir.test.ts": 1,
  "test/e2e/migration-evolution-java.test.ts": 1,
  "test/e2e/migration-evolution-python.test.ts": 1,
};

function testFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "fixtures") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) testFiles(full, out);
    else if (entry.isFile() && full.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

const ASSERTION_HEAD = /^(expect|assert|expectTypeOf)/;

/** Cases with no assertion anywhere in their body, per file, plus the total
 *  number of cases scanned (the vacuous-pass guard). */
function census(): { byFile: Record<string, number>; cases: number } {
  const byFile: Record<string, number> = {};
  let cases = 0;

  for (const file of testFiles(testRoot)) {
    const sf = ts.createSourceFile(
      file,
      fs.readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
    );
    const rel = path.relative(repoRoot, file);

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const head = node.expression.getText(sf);
        const base = head.split(".")[0];
        // `it.skip` / `it.todo` declare no body worth measuring.
        if (
          (base === "it" || base === "test") &&
          !head.includes("todo") &&
          !head.includes("skip")
        ) {
          const body = node.arguments.find(
            (a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a),
          )?.body;
          if (body) {
            cases++;
            let asserts = false;
            const scan = (n: ts.Node): void => {
              if (asserts) return;
              if (ts.isCallExpression(n)) {
                const callee = n.expression.getText(sf);
                if (ASSERTION_HEAD.test(callee.split(".")[0] ?? "") || /\bexpect\b/.test(callee)) {
                  asserts = true;
                }
              }
              if (!asserts) ts.forEachChild(n, scan);
            };
            scan(body);
            if (!asserts) byFile[rel] = (byFile[rel] ?? 0) + 1;
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { byFile, cases };
}

describe("assertion-free tests (M-T9.8 (e))", () => {
  const { byFile, cases } = census();

  it("scans the whole suite (guard against a vacuous pass)", () => {
    // If the walker silently stopped finding cases, every assertion below
    // would pass on an empty set.  ~11k `it()` sites at the 08-13 census.
    expect(cases).toBeGreaterThan(9_000);
  });

  it("no NEW assertion-free case", () => {
    const added = Object.entries(byFile)
      .filter(([file, n]) => n > (PINNED[file] ?? 0))
      .map(([file, n]) => `${file} — ${n} assertion-free, ${PINNED[file] ?? 0} pinned`);
    expect(
      added,
      "Assertion-free test case(s) — the body calls no expect/assert, so it " +
        "passes whatever the code does.  Assert something, or (if the subject " +
        "really is 'this does not throw' or a helper asserts internally) pin it " +
        "above with which shape it is:\n" +
        added.join("\n"),
    ).toEqual([]);
  });

  it("no STALE pin", () => {
    const stale = Object.entries(PINNED)
      .filter(([file, n]) => (byFile[file] ?? 0) < n)
      .map(([file, n]) => `${file} — pinned ${n}, now ${byFile[file] ?? 0}`);
    expect(
      stale,
      "Pinned case(s) now assert (or moved).  Lower or delete the pin in the " +
        "same PR — a ratchet with slack in it stops ratcheting:\n" +
        stale.join("\n"),
    ).toEqual([]);
  });
});
