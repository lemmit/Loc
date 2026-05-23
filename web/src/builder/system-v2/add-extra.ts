// v2-only construct adders that v1's `add.ts` doesn't expose: inserting a new
// bounded context into an existing module, and a new operation into an
// existing aggregate. Same shape as `addConstructSource` / `addModuleSource`:
// pure, parse-guarded splice; returns null on lookup failure / parse failure.

import { AstUtils, type AstNode } from "langium";
import type {
  Aggregate,
  Model,
  Module,
  System,
} from "../../../../src/language/generated/ast.js";
import { applyEdits } from "../edit-engine";
import { parseDdd } from "../parse";

function freshName(ast: Model, base: string): string {
  const taken = new Set<string>();
  for (const n of AstUtils.streamAst(ast)) {
    const name = (n as { name?: unknown }).name;
    if (typeof name === "string") taken.add(name);
  }
  for (let i = 1; ; i++) {
    const candidate = `${base}${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function insertIntoBlock(source: string, block: AstNode, text: string): string {
  const cst = block.$cstNode;
  if (!cst) throw new Error("insertIntoBlock: node has no CST");
  const at = cst.end - 1; // just before the closing `}`
  return applyEdits(source, [{ offset: at, end: at, newText: text }]);
}

function ifParses(candidate: string): string | null {
  return parseDdd(candidate).parserErrors.length === 0 ? candidate : null;
}

/** Add a new (empty) bounded context to an existing module, returning the new
 *  source or null when the module isn't found / the result wouldn't parse. */
export function addContextSource(source: string, moduleName: string): string | null {
  const ast = parseDdd(source).ast;
  let mod: Module | undefined;
  for (const m of ast.members) {
    if (m.$type === "System") {
      for (const sm of (m as System).members) {
        if (sm.$type === "Module" && (sm as Module).name === moduleName) mod = sm as Module;
      }
    }
  }
  if (!mod) return null;
  const name = freshName(ast, "Context");
  const text = `\n    context ${name} {\n    }\n`;
  return ifParses(insertIntoBlock(source, mod, text));
}

/** Add a new no-arg operation to an existing aggregate. */
export function addOperationSource(source: string, aggregateName: string): string | null {
  const ast = parseDdd(source).ast;
  let agg: Aggregate | undefined;
  for (const n of AstUtils.streamAst(ast)) {
    if (n.$type === "Aggregate" && (n as Aggregate).name === aggregateName) {
      agg = n as Aggregate;
      break;
    }
  }
  if (!agg) return null;
  const name = freshName(ast, "op");
  const text = `\n      operation ${name}() {\n      }\n`;
  return ifParses(insertIntoBlock(source, agg, text));
}
