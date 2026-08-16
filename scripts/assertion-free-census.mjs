#!/usr/bin/env node
// Assertion-free test census (M-T9.8 item (e)).
//
// Reports every `it(...)` / `test(...)` case whose body contains no
// `expect` / `assert` / `expectTypeOf` call.  A case that asserts nothing
// passes unconditionally — it is a test-shaped no-op, and the hollow-work
// audit has carried this sweep as a recurring MANUAL task.
//
// AST-based on purpose.  The obvious regex version (match `it(`, brace-count
// to the closing `}`) reports 525 candidates against this suite's real 35 —
// a 15x false-positive rate, because template literals, nested object
// literals and regex bodies all break naive brace counting.  A sweep that
// cries wolf 15 times out of 16 does not get run.
//
// Usage:  node scripts/assertion-free-census.mjs [dir=test]
//
// Note that a case delegating to a helper which asserts internally (the
// opt-in e2e tiers do this — `runMigrationEvolutionGate`, `waitFor`) is
// reported here and is NOT a defect; so is a type-level test where `tsc` is
// the assertion.  Read the output, do not pipe it into a threshold.

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const root = process.argv[2] ?? "test";

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "fixtures") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".test.ts")) files.push(p);
  }
})(root);

const ASSERTION = /^(expect|assert|expectTypeOf)/;
let cases = 0;
const bare = [];

for (const file of files) {
  const sf = ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
  );

  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const head = node.expression.getText(sf);
      const base = head.split(".")[0];
      const isCase =
        (base === "it" || base === "test") && !head.includes("todo") && !head.includes("skip");
      if (isCase) {
        const body = node.arguments.find(
          (a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a),
        )?.body;
        if (body) {
          cases++;
          let asserts = false;
          const scan = (n) => {
            if (asserts) return;
            if (ts.isCallExpression(n)) {
              const callee = n.expression.getText(sf);
              if (ASSERTION.test(callee.split(".")[0]) || /\bexpect\b/.test(callee)) asserts = true;
            }
            if (!asserts) ts.forEachChild(n, scan);
          };
          scan(body);
          if (!asserts) {
            const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
            bare.push(`${file}:${line + 1}`);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

console.log(`files=${files.length} cases=${cases} assertion-free=${bare.length}`);
for (const b of bare) console.log(`  ${b}`);
