import { AstUtils, type AstNode } from "langium";
import type { Aggregate, Model, Operation, Statement, Workflow } from "../../../../src/language/generated/ast.js";
import { applyEdits } from "../edit-engine";
import { parseDdd } from "../parse";

// ---------------------------------------------------------------------------
// Shared statement-body editing for the Model builder, used by both operation
// bodies (aggregate members) and workflow bodies — both are `Statement[]`.
//
// Edits are pure text splices over a statement's CST range (or an insert before
// the body's closing brace), validated by re-parsing the whole document: an
// edit is committed only if the result still parses.  Statements are shown
// verbatim from source (their CST text), so an untouched body round-trips
// byte-for-byte.  Semantic errors (unresolved names, type mismatches) surface
// in the Problems panel after the edit lands — they don't block the splice,
// since most expression-level names resolve in IR lowering, not as Langium
// cross-references.
// ---------------------------------------------------------------------------

export type BodyLocator =
  | { kind: "workflow"; name: string }
  | { kind: "operation"; aggregate: string; op: string };

interface Body {
  owner: AstNode;
  statements: Statement[];
}

function findAggregate(ast: Model, name: string): Aggregate | null {
  for (const n of AstUtils.streamAst(ast)) {
    if (n.$type === "Aggregate" && (n as Aggregate).name === name) return n as Aggregate;
  }
  return null;
}

function resolveBody(ast: Model, loc: BodyLocator): Body | null {
  if (loc.kind === "workflow") {
    for (const n of AstUtils.streamAst(ast)) {
      if (n.$type === "Workflow" && (n as Workflow).name === loc.name) {
        return { owner: n, statements: (n as Workflow).body };
      }
    }
    return null;
  }
  const agg = findAggregate(ast, loc.aggregate);
  if (!agg) return null;
  const op = agg.members.find((m): m is Operation => m.$type === "Operation" && m.name === loc.op);
  return op ? { owner: op, statements: op.body } : null;
}

/** Operation names declared on an aggregate (for the inspector's op picker). */
export function listOperations(node: AstNode): string[] {
  if (node.$type !== "Aggregate") return [];
  return (node as Aggregate).members
    .filter((m): m is Operation => m.$type === "Operation")
    .map((o) => o.name);
}

/** Each statement's verbatim source text. */
export function listStatements(ast: Model, loc: BodyLocator): string[] | null {
  const body = resolveBody(ast, loc);
  if (!body) return null;
  return body.statements.map((s) => s.$cstNode?.text ?? "");
}

/** Leading whitespace of the line containing `offset`. */
function lineIndent(source: string, offset: number): string {
  let start = offset;
  while (start > 0 && source[start - 1] !== "\n") start--;
  let i = start;
  while (i < source.length && (source[i] === " " || source[i] === "\t")) i++;
  return source.slice(start, i);
}

/** Validate by re-parsing: return `candidate` only if it still parses. */
function ifParses(candidate: string): string | null {
  return parseDdd(candidate).parserErrors.length === 0 ? candidate : null;
}

export function editStatement(source: string, loc: BodyLocator, index: number, text: string): string | null {
  const body = resolveBody(parseDdd(source).ast, loc);
  const cst = body?.statements[index]?.$cstNode;
  if (!cst) return null;
  return ifParses(applyEdits(source, [{ offset: cst.offset, end: cst.end, newText: text.trim() }]));
}

export function deleteStatement(source: string, loc: BodyLocator, index: number): string | null {
  const body = resolveBody(parseDdd(source).ast, loc);
  const cst = body?.statements[index]?.$cstNode;
  if (!cst) return null;
  // Swallow the preceding line break + indentation so no blank line is left.
  let start = cst.offset;
  while (start > 0 && (source[start - 1] === " " || source[start - 1] === "\t")) start--;
  if (start > 0 && source[start - 1] === "\n") start--;
  return ifParses(applyEdits(source, [{ offset: start, end: cst.end, newText: "" }]));
}

export function addStatement(source: string, loc: BodyLocator, text: string): string | null {
  const parsed = parseDdd(source);
  const body = resolveBody(parsed.ast, loc);
  if (!body) return null;
  const stmt = text.trim();
  if (!stmt) return null;
  const last = body.statements[body.statements.length - 1]?.$cstNode;
  if (last) {
    // Append after the last statement, matching its indentation.
    const indent = lineIndent(source, last.offset);
    return ifParses(applyEdits(source, [{ offset: last.end, end: last.end, newText: `\n${indent}${stmt}` }]));
  }
  // Empty body: insert before the owner's closing brace.
  const ownerCst = body.owner.$cstNode;
  if (!ownerCst) return null;
  const ownerIndent = lineIndent(source, ownerCst.offset);
  const at = ownerCst.end - 1;
  return ifParses(
    applyEdits(source, [{ offset: at, end: at, newText: `\n${ownerIndent}  ${stmt}\n${ownerIndent}` }]),
  );
}
