#!/usr/bin/env node
// Print the current set of test files importing the system orchestrator
// directly, formatted as the `PINNED` array body of
// `test/system/direct-generate-systems-ratchet.test.ts`.
//
// The ratchet's allowlist is a snapshot of a set that MOVES — roughly two new
// direct importers land on `main` per day — so a pin list minted days before it
// merges is stale on arrival.  Regenerate immediately before merging:
//
//     node scripts/direct-caller-census.mjs
//
// and paste the output over the `PINNED` array.  Every added line is a file
// someone wrote against the ungated orchestrator; the ratchet only stops the
// set GROWING silently, it does not bless the entries.
import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import ts from "typescript";

const repoRoot = path.resolve(import.meta.dirname, "..");
const testRoot = path.join(repoRoot, "test");
const GATED = new Set(["generateSystems", "generateSystemsFromLoom"]);
const isOrch = (s) => /(^|\/)src\/system\/index\.js$/.test(s);

function* walk(dir) {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "fixtures") continue;
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(test\.)?[cm]?ts$/.test(e)) yield p;
  }
}

const hits = [];
for (const file of walk(testRoot)) {
  const text = readFileSync(file, "utf8");
  if (!text.includes("src/system/index.js")) continue;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const rel = path.relative(repoRoot, file);
  let hit = false;
  const named = (b) =>
    b !== undefined &&
    ts.isNamedImports(b) &&
    b.elements.some((e) => GATED.has((e.propertyName ?? e.name).text));
  const visit = (n) => {
    if (hit) return;
    if (
      ts.isImportDeclaration(n) &&
      ts.isStringLiteral(n.moduleSpecifier) &&
      isOrch(n.moduleSpecifier.text) &&
      named(n.importClause?.namedBindings)
    ) {
      hit = true;
      return;
    }
    // `const { generateSystems } = await import(".../src/system/index.js")` —
    // the ratchet's own census matches this form too, and a script that missed
    // it would hand back a pin list that does not satisfy the test.
    if (
      ts.isCallExpression(n) &&
      n.expression.kind === ts.SyntaxKind.ImportKeyword &&
      n.arguments.length > 0 &&
      ts.isStringLiteral(n.arguments[0]) &&
      isOrch(n.arguments[0].text)
    ) {
      let owner = n.parent;
      while (owner && !ts.isVariableDeclaration(owner) && !ts.isSourceFile(owner)) {
        owner = owner.parent;
      }
      if (
        owner &&
        ts.isVariableDeclaration(owner) &&
        ts.isObjectBindingPattern(owner.name) &&
        owner.name.elements.some((e) => GATED.has((e.propertyName ?? e.name).text ?? ""))
      ) {
        hit = true;
        return;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (hit && rel !== "test/_helpers/generate.ts") hits.push(rel);
}
for (const h of hits.sort()) console.log(`  ${JSON.stringify(h)},`);
console.error(`\n${hits.length} direct importers`);
