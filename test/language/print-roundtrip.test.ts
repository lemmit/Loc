import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { type AstNode, AstUtils } from "langium";
import { describe, expect, it } from "vitest";
import type { Expression } from "../../src/language/generated/ast.js";
import { printExpr } from "../../src/language/print/index.js";
import { parseRawResult } from "../_helpers/index.js";

// ---------------------------------------------------------------------------
// Round-trip safety net for the `.ddd` expression printer (Builders).
//
// For every expression in the example corpus: print it, splice the printed
// text back over its own CST range, re-parse the whole document, and assert
// the AST is structurally identical.  This is the CI gate that the printer
// stays faithful as the grammar evolves — a drifted printer fails here before
// it can corrupt a user's source.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

const EXPR_TYPES = new Set<string>([
  "MatchExpr",
  "TernaryExpr",
  "BinaryExpr",
  "UnaryExpr",
  "MemberAccess",
  "CallExpr",
  "Lambda",
  "NewExpr",
  "ObjectLit",
  "ParenExpr",
  "StringLit",
  "IntLit",
  "DecLit",
  "BoolLit",
  "NullLit",
  "NowExpr",
  "ThisRef",
  "IdRef",
  "NameRef",
]);
const isExpr = (n: AstNode): n is Expression => EXPR_TYPES.has(n.$type);

function hasExprAncestor(n: AstNode): boolean {
  let c: AstNode | undefined = n.$container;
  while (c) {
    if (isExpr(c)) return true;
    c = c.$container;
  }
  return false;
}

// Comparable projection of an AST: keep `$type`, own non-`$` fields, and
// references as `{ $ref }`; drop positions / containers / documents.
function norm(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.$refText === "string") return { $ref: o.$refText };
    if (typeof o.$type === "string") {
      const out: Record<string, unknown> = { $type: o.$type };
      for (const k of Object.keys(o)) if (!k.startsWith("$")) out[k] = norm(o[k]);
      return out;
    }
  }
  return v;
}

function collectDddFiles(): string[] {
  const dirs = [path.join(repoRoot, "examples"), path.join(repoRoot, "web/src/examples")];
  const out: string[] = [];
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) if (f.endsWith(".ddd")) out.push(path.join(d, f));
  }
  return out.sort();
}

describe("print-expr round-trip", () => {
  for (const file of collectDddFiles()) {
    const rel = path.relative(repoRoot, file);
    const text = fs.readFileSync(file, "utf8");
    const original = parseRawResult(text);

    // Some examples are doc fragments (e.g. a bare top-level `ui` block) that
    // aren't complete `Model`s; they aren't valid pipeline input, so skip
    // them visibly rather than fail.
    if (original.parserErrors.length > 0) {
      it.skip(`round-trips every expression in ${rel} (fragment — not a complete model)`, () => {});
      continue;
    }

    it(`round-trips every expression in ${rel}`, () => {
      const normOrig = norm(original.value);

      const outer: Expression[] = [];
      for (const node of AstUtils.streamAst(original.value)) {
        if (isExpr(node) && !hasExprAncestor(node)) outer.push(node);
      }

      for (const expr of outer) {
        const cst = expr.$cstNode;
        if (!cst) continue;
        const printed = printExpr(expr);
        const spliced = text.slice(0, cst.offset) + printed + text.slice(cst.end);
        const re = parseRawResult(spliced);
        expect(re.parserErrors, `printed expression must parse:\n${printed}`).toEqual([]);
        expect(norm(re.value), `printed expression must round-trip:\n${printed}`).toEqual(normOrig);
      }
    });
  }
});
