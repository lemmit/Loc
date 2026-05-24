#!/usr/bin/env tsx
// One-shot audit script — informs the validator-suppression rethink
// by quantifying how many binary expressions in the example / fixture
// corpus silently typecheck as `unknown` today.
//
// What gets reported:
//   1. Arithmetic ops (`+ - * / %`) where `arithmeticResult` returns
//      unknown but BOTH operands have known types — these slip past
//      `checkDerived` / `checkAssignOrCall` because their
//      `actual.kind === "unknown"` suppression treats this as a
//      cascade case.  Examples: `string + int`, `bool + decimal`,
//      `enum + string`.
//   2. Comparison ops (`== != < <= > >=`) whose operand types aren't
//      pairwise comparable (different primitives outside the
//      numeric widening chain, enum-vs-VO, primitive-vs-entity etc.).
//      The type-system always returns bool for these, so the
//      validator never sees an unknown — they're silent regardless.
//
// Skipped cases (legitimate suppression, not part of the gap):
//   - Either operand types as `unknown` for upstream reasons
//     (unresolved ref, broken member).  The existing checkers already
//     report those; piling on here would double the noise.
//   - `string + string` (legal concat).
//
// Output is grouped by file so a real bug vs. a corpus-only-uses-it-
// in-tests pattern is distinguishable at a glance.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { AstUtils, URI } from "langium";
import { NodeFileSystem } from "langium/node";
import { createDddServices } from "../src/language/ddd-module.js";
import type { Expression, Model } from "../src/language/generated/ast.js";
import { isBinaryExpr } from "../src/language/generated/ast.js";
import { arithmeticResult, envForNode, type DddType, typeOf, typeToString } from "../src/language/type-system.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

const DDD_DIRS = ["examples", "test/fixtures", "web/src/examples"];

function findDdds(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".ddd")) out.push(full);
    }
  };
  for (const d of DDD_DIRS) walk(path.join(repoRoot, d));
  return out.sort();
}

const services = createDddServices(NodeFileSystem);
const documents = services.shared.workspace.LangiumDocuments;
const builder = services.shared.workspace.DocumentBuilder;

async function parseOne(file: string): Promise<Model | null> {
  const uri = URI.file(path.resolve(file));
  try {
    if (documents.hasDocument(uri)) await documents.deleteDocument(uri);
    const doc = await documents.getOrCreateDocument(uri);
    await builder.build([doc], { validation: false });
    return doc.parseResult.value as Model;
  } catch {
    return null;
  }
}

interface Finding {
  file: string;
  line: number;
  col: number;
  src: string;
  op: string;
  leftType: string;
  rightType: string;
  category: "arithmetic-rejected" | "comparison-incompatible";
}

function isNumeric(t: DddType): boolean {
  return t.kind === "primitive" && (t.name === "int" || t.name === "long" || t.name === "decimal");
}

function bothMoney(a: DddType, b: DddType): boolean {
  return a.kind === "primitive" && a.name === "money" && b.kind === "primitive" && b.name === "money";
}

function bothSamePrimitive(a: DddType, b: DddType): boolean {
  return (
    a.kind === "primitive" &&
    b.kind === "primitive" &&
    a.name === b.name
  );
}

function bothSameEnum(a: DddType, b: DddType): boolean {
  return a.kind === "enum" && b.kind === "enum" && a.ref === b.ref;
}

function bothSameId(a: DddType, b: DddType): boolean {
  return a.kind === "id" && b.kind === "id" && a.target === b.target;
}

function bothSameValueObject(a: DddType, b: DddType): boolean {
  return a.kind === "valueobject" && b.kind === "valueobject" && a.ref === b.ref;
}

// Comparable: same primitive, both numeric (int/long/decimal widening),
// both money, same enum, same id, same VO, or one side null literal
// against an optional.  Anything else is a silent mismatch.
function comparable(a: DddType, b: DddType): boolean {
  if (a.kind === "any" || b.kind === "any") return true;
  if (a.kind === "never" || b.kind === "never") return true; // null literal
  if (bothSamePrimitive(a, b)) return true;
  if (bothMoney(a, b)) return true;
  if (isNumeric(a) && isNumeric(b)) return true;
  if (bothSameEnum(a, b)) return true;
  if (bothSameId(a, b)) return true;
  if (bothSameValueObject(a, b)) return true;
  if (a.kind === "optional" && comparable(a.inner, b)) return true;
  if (b.kind === "optional" && comparable(a, b.inner)) return true;
  return false;
}

function scanModel(file: string, model: Model, findings: Finding[]): void {
  for (const node of AstUtils.streamAllContents(model)) {
    if (!isBinaryExpr(node)) continue;
    const env = envForNode(node);
    const lt = typeOf(node.left as Expression, env);
    const rt = typeOf(node.right as Expression, env);
    // Skip cascade — broken upstream already reports.
    if (lt.kind === "unknown" || rt.kind === "unknown") continue;
    const op = node.op;
    const cstNode = node.$cstNode;
    const line = cstNode ? cstNode.range.start.line + 1 : 0;
    const col = cstNode ? cstNode.range.start.character + 1 : 0;
    const src = cstNode ? cstNode.text.replace(/\s+/g, " ").slice(0, 80) : "(no cst)";

    if (op === "+" || op === "-" || op === "*" || op === "/" || op === "%") {
      // Special-case the universal string-concat exception.
      if (op === "+" && lt.kind === "primitive" && lt.name === "string" && rt.kind === "primitive" && rt.name === "string") continue;
      const result = arithmeticResult(lt, rt, op);
      if (result.kind === "unknown") {
        findings.push({
          file,
          line,
          col,
          src,
          op,
          leftType: typeToString(lt),
          rightType: typeToString(rt),
          category: "arithmetic-rejected",
        });
      }
      continue;
    }
    if (op === "==" || op === "!=" || op === "<" || op === "<=" || op === ">" || op === ">=") {
      if (!comparable(lt, rt)) {
        findings.push({
          file,
          line,
          col,
          src,
          op,
          leftType: typeToString(lt),
          rightType: typeToString(rt),
          category: "comparison-incompatible",
        });
      }
      continue;
    }
    // Logical (`&& ||`) — left+right must be bool.  Skip for now;
    // the type-system already always returns bool downstream so
    // the impact's similar to comparison but a separate rule.
  }
}

async function main(): Promise<void> {
  const files = findDdds();
  const findings: Finding[] = [];
  let parseFailed = 0;
  for (const file of files) {
    const model = await parseOne(file);
    if (!model) {
      parseFailed++;
      continue;
    }
    scanModel(path.relative(repoRoot, file), model, findings);
  }

  console.log(`Scanned ${files.length} .ddd files (${parseFailed} parse-failed).\n`);
  if (findings.length === 0) {
    console.log("No silent-invalid binary expressions found.");
    return;
  }
  const byFile = new Map<string, Finding[]>();
  for (const f of findings) {
    (byFile.get(f.file) ?? byFile.set(f.file, []).get(f.file)!).push(f);
  }
  for (const [file, group] of [...byFile.entries()].sort()) {
    console.log(`### ${file}  (${group.length})`);
    for (const f of group) {
      console.log(
        `  ${f.line}:${f.col}  [${f.category}]  ${f.leftType} ${f.op} ${f.rightType}`,
      );
      console.log(`     ${f.src}`);
    }
    console.log();
  }
  console.log(`TOTAL: ${findings.length} silent-invalid binary expressions.`);
}

await main();
