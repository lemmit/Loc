import { AstUtils, CstUtils, GrammarUtils, type AstNode } from "langium";
import type {
  Aggregate,
  FindDecl,
  LetStmt,
  Model,
  NameRef,
  Operation,
  Parameter,
  Repository,
  TypeRef,
} from "../../../../src/language/generated/ast.js";
import { applyEdits, type TextEdit } from "../edit-engine";
import { parseDdd } from "../parse";
import { baseLabel, baseSpecOf, typeText, type TypeSpec } from "./fields";
import type { ParamInfo } from "./find-params";
import { IDENTIFIER } from "./rename";

// ---------------------------------------------------------------------------
// Operation / find HEADER editing — the signature surface around a body:
// parameters, return type, the `requires` / `when` gates, the `private` /
// `extern` / `audited` modifiers, and a find's `requires` gate + `ignoring`
// clause.  `body.ts` owns everything INSIDE the braces; this module owns
// everything before them.
//
// Same discipline as `fields.ts` / `find-params.ts`: parse → locate → splice
// the SMALLEST span that expresses the change → re-parse to validate
// (`ifParses`), `null` on failure.  Nothing outside the spliced span moves, so
// comments, blank lines and hand-spacing survive byte-for-byte — in particular
// an operation's whole body is untouched when its header changes.
//
// The grammar order of the header is fixed:
//
//   [private] operation name(params) [extern] [audited] [: T] [requires e] [when e] { … }
//   find name(params): T [requires e] [where e] [ignoring * | A, B]
//
// so adding a clause is an insertion at the END of the last preceding element
// (never "somewhere after the parens"), and removing one deletes from that same
// anchor through the clause's end — which takes the separating space with it.
// ---------------------------------------------------------------------------

/** A type given either structurally (the pickers' `TypeSpec`) or as raw
 *  `.ddd` text (`"Order[]"`) — both spellings splice identically. */
export type TypeInput = TypeSpec | string;

const asTypeText = (type: TypeInput): string => (typeof type === "string" ? type.trim() : typeText(type));

/** Validate by re-parsing: return `candidate` only if it still parses. */
function ifParses(candidate: string): string | null {
  return parseDdd(candidate).parserErrors.length === 0 ? candidate : null;
}

function findAggregate(ast: Model, name: string): Aggregate | null {
  for (const n of AstUtils.streamAst(ast)) {
    if (n.$type === "Aggregate" && (n as Aggregate).name === name) return n as Aggregate;
  }
  return null;
}

function findRepo(ast: Model, name: string): Repository | null {
  for (const n of AstUtils.streamAst(ast)) {
    if (n.$type === "Repository" && (n as Repository).name === name) return n as Repository;
  }
  return null;
}

function operationOf(ast: Model, agg: string, op: string): Operation | null {
  const node = findAggregate(ast, agg);
  if (!node) return null;
  return (
    (node.members.find(
      (m): m is Operation => m.$type === "Operation" && (m as Operation).name === op,
    ) as Operation | undefined) ?? null
  );
}

function findDeclOf(ast: Model, repo: string, find: string): FindDecl | null {
  return findRepo(ast, repo)?.finds.find((f) => f.name === find) ?? null;
}

/** The shared prologue: re-parse and resolve.  Null on a syntactically invalid
 *  source (an edit on top of broken text would splice at offsets the recovery
 *  parser invented) or an unknown aggregate / operation. */
function locateOp(source: string, agg: string, op: string): Operation | null {
  const fresh = parseDdd(source);
  if (fresh.parserErrors.length > 0) return null;
  return operationOf(fresh.ast, agg, op);
}

function locateFind(source: string, repo: string, find: string): FindDecl | null {
  const fresh = parseDdd(source);
  if (fresh.parserErrors.length > 0) return null;
  return findDeclOf(fresh.ast, repo, find);
}

// --- own-token lookup ------------------------------------------------------

interface Token {
  text: string;
  offset: number;
  end: number;
}

/** Keyword / punctuation tokens the node's OWN rule contributes, in document
 *  order.  `astNode` identity is the test: a parameter's `:` belongs to the
 *  Parameter rule and a default value's parens to the expression, so only the
 *  operation's own `(` `)` `:` `extern` `requires` … come back. */
function ownTokens(node: AstNode): Token[] {
  const cst = node.$cstNode;
  if (!cst) return [];
  const out: Token[] = [];
  for (const n of CstUtils.streamCst(cst)) {
    if (n.astNode !== node) continue;
    // Only leaf tokens (a composite spans its children's text).
    if (!("tokenType" in n)) continue;
    out.push({ text: n.text, offset: n.offset, end: n.end });
  }
  return out;
}

const firstToken = (tokens: Token[], text: string): Token | undefined =>
  tokens.find((t) => t.text === text);

const lastToken = (tokens: Token[], text: string): Token | undefined =>
  [...tokens].reverse().find((t) => t.text === text);

// --- read surface ----------------------------------------------------------

const paramInfo = (p: Parameter): ParamInfo => {
  const base = baseSpecOf(p.type);
  return {
    name: p.name,
    base,
    baseLabel: baseLabel(base),
    array: p.type.array,
    optional: p.type.optional,
  };
};

const specOf = (type: TypeRef): TypeSpec => ({
  base: baseSpecOf(type),
  array: type.array,
  optional: type.optional,
});

/** Everything the inspector shows above an operation's body. */
export interface OpSurface {
  name: string;
  params: ParamInfo[];
  /** Null when the operation declares no `: TypeRef`. */
  returnType: TypeSpec | null;
  returnTypeText: string | null;
  /** Verbatim gate source, or null when the clause is absent. */
  requires: string | null;
  when: string | null;
  private: boolean;
  extern: boolean;
  audited: boolean;
}

export function opSurface(ast: Model, agg: string, op: string): OpSurface | null {
  const node = operationOf(ast, agg, op);
  if (!node) return null;
  return {
    name: node.name,
    params: node.params.map(paramInfo),
    returnType: node.returnType ? specOf(node.returnType) : null,
    returnTypeText: node.returnType?.$cstNode?.text.trim() ?? null,
    requires: node.gate?.$cstNode?.text.trim() ?? null,
    when: node.when?.$cstNode?.text.trim() ?? null,
    private: node.private === true,
    extern: node.extern === true,
    audited: node.audited === true,
  };
}

/** Everything the inspector shows on a repository `find` header. */
export interface FindSurface {
  name: string;
  params: ParamInfo[];
  returnType: TypeSpec;
  returnTypeText: string;
  requires: string | null;
  where: string | null;
  /** `"*"` for `ignoring *`, the capability names for `ignoring A, B`, null
   *  when the clause is absent. */
  ignoring: "*" | string[] | null;
}

export function findSurface(ast: Model, repo: string, find: string): FindSurface | null {
  const node = findDeclOf(ast, repo, find);
  if (!node) return null;
  return {
    name: node.name,
    params: node.params.map(paramInfo),
    returnType: specOf(node.returnType),
    returnTypeText: node.returnType.$cstNode?.text.trim() ?? "",
    requires: node.gate?.$cstNode?.text.trim() ?? null,
    where: node.filter?.$cstNode?.text.trim() ?? null,
    ignoring: node.bypassAll ? "*" : node.bypass.length > 0 ? [...node.bypass] : null,
  };
}

// --- operation parameters --------------------------------------------------

export function addOpParam(
  source: string,
  agg: string,
  op: string,
  paramName: string,
  type: TypeInput,
): string | null {
  const node = locateOp(source, agg, op);
  if (!node?.$cstNode) return null;
  const text = `${paramName}: ${asTypeText(type)}`;
  const last = node.params[node.params.length - 1]?.$cstNode;
  if (last) {
    return ifParses(applyEdits(source, [{ offset: last.end, end: last.end, newText: `, ${text}` }]));
  }
  // Empty param list — insert just inside the operation's own `(`.
  const open = firstToken(ownTokens(node), "(");
  if (!open) return null;
  return ifParses(applyEdits(source, [{ offset: open.end, end: open.end, newText: text }]));
}

export function deleteOpParam(source: string, agg: string, op: string, index: number): string | null {
  const node = locateOp(source, agg, op);
  const cst = node?.params[index]?.$cstNode;
  if (!node || !cst) return null;
  // Take the separating comma with the param: the one before it when there is
  // a preceding param, otherwise the one after it.  A sole param leaves `()`.
  const prev = index > 0 ? node.params[index - 1]?.$cstNode : undefined;
  const next = index === 0 ? node.params[1]?.$cstNode : undefined;
  const offset = prev ? prev.end : cst.offset;
  const end = next ? next.offset : cst.end;
  return ifParses(applyEdits(source, [{ offset, end, newText: "" }]));
}

export function retypeOpParam(
  source: string,
  agg: string,
  op: string,
  index: number,
  type: TypeInput,
): string | null {
  const cst = locateOp(source, agg, op)?.params[index]?.type.$cstNode;
  if (!cst) return null;
  return ifParses(applyEdits(source, [{ offset: cst.offset, end: cst.end, newText: asTypeText(type) }]));
}

/** Rename a parameter and every use of it inside the operation's own header
 *  gates and body — the multi-edit twin of `renameFindParam`.  A param's uses
 *  are bare `NameRef`s in that one operation, where the param shadows any
 *  same-named aggregate member.  A `let` bound to either the old name (it
 *  shadows the param back, so not every `NameRef` is the param's) or the new
 *  one (the rename would capture it) is refused rather than half-rewritten. */
export function renameOpParam(
  source: string,
  agg: string,
  op: string,
  index: number,
  newName: string,
): string | null {
  if (!IDENTIFIER.test(newName)) return null;
  const node = locateOp(source, agg, op);
  const param = node?.params[index];
  const nameNode = param?.$cstNode
    ? GrammarUtils.findNodeForProperty(param.$cstNode, "name")
    : undefined;
  if (!node || !param || !nameNode) return null;
  if (node.params.some((q, i) => i !== index && q.name === newName)) return null;
  const scopes: AstNode[] = [...node.body];
  if (node.gate) scopes.push(node.gate);
  if (node.when) scopes.push(node.when);
  const edits: TextEdit[] = [{ offset: nameNode.offset, end: nameNode.end, newText: newName }];
  for (const scope of scopes) {
    for (const n of AstUtils.streamAst(scope)) {
      // A `let` on either side of the rename rebinds the name — the rewrite
      // would change which binding a `NameRef` means.
      if (n.$type === "LetStmt") {
        const bound = (n as LetStmt).name;
        if (bound === param.name || bound === newName) return null;
      }
      const cst = n.$cstNode;
      if (cst && n.$type === "NameRef" && (n as NameRef).name === param.name) {
        edits.push({ offset: cst.offset, end: cst.end, newText: newName });
      }
    }
  }
  return ifParses(applyEdits(source, edits));
}

/** A param name not already used by the operation. */
export function freshOpParamName(ast: Model, agg: string, op: string): string {
  const taken = new Set(operationOf(ast, agg, op)?.params.map((p) => p.name) ?? []);
  for (let i = 1; ; i++) {
    const candidate = `param${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// --- return type / gates / modifiers ---------------------------------------

/** End offset of the last header element BEFORE `stop`, in grammar order —
 *  the anchor an inserted clause appends to, and the start of the span a
 *  removed clause deletes (so the separating space goes with it). */
function anchorBefore(op: Operation, stop: "returnType" | "requires" | "when"): number | null {
  const tokens = ownTokens(op);
  const close = lastToken(tokens, ")");
  if (!close) return null;
  let at = close.end;
  const extern = op.extern ? firstToken(tokens, "extern") : undefined;
  if (extern) at = extern.end;
  const audited = op.audited ? firstToken(tokens, "audited") : undefined;
  if (audited) at = audited.end;
  if (stop === "returnType") return at;
  if (op.returnType?.$cstNode) at = op.returnType.$cstNode.end;
  if (stop === "requires") return at;
  if (op.gate?.$cstNode) at = op.gate.$cstNode.end;
  return at;
}

/** Add / replace / remove an operation's `: TypeRef` return type. */
export function setOpReturnType(
  source: string,
  agg: string,
  op: string,
  type: TypeInput | null,
): string | null {
  const node = locateOp(source, agg, op);
  if (!node) return null;
  const existing = node.returnType?.$cstNode;
  if (type === null) {
    if (!existing) return source;
    const from = anchorBefore(node, "returnType");
    if (from === null) return null;
    return ifParses(applyEdits(source, [{ offset: from, end: existing.end, newText: "" }]));
  }
  const text = asTypeText(type);
  if (!text) return null;
  if (existing) {
    return ifParses(applyEdits(source, [{ offset: existing.offset, end: existing.end, newText: text }]));
  }
  const at = anchorBefore(node, "returnType");
  if (at === null) return null;
  return ifParses(applyEdits(source, [{ offset: at, end: at, newText: `: ${text}` }]));
}

export type OpGate = "requires" | "when";

/** Add / replace / remove an operation's `requires` (authz) or `when`
 *  (state) gate.  Both keep their grammar slot — `requires` before `when`,
 *  both after the return type — however many of them the source declares. */
export function setOpGate(
  source: string,
  agg: string,
  op: string,
  gate: OpGate,
  exprText: string | null,
): string | null {
  const node = locateOp(source, agg, op);
  if (!node) return null;
  const existing = (gate === "requires" ? node.gate : node.when)?.$cstNode;
  if (exprText === null) {
    if (!existing) return source;
    const from = anchorBefore(node, gate);
    if (from === null) return null;
    return ifParses(applyEdits(source, [{ offset: from, end: existing.end, newText: "" }]));
  }
  const text = exprText.trim();
  if (!text) return null;
  if (existing) {
    return ifParses(applyEdits(source, [{ offset: existing.offset, end: existing.end, newText: text }]));
  }
  const at = anchorBefore(node, gate);
  if (at === null) return null;
  return ifParses(applyEdits(source, [{ offset: at, end: at, newText: ` ${gate} ${text}` }]));
}

export type OpModifier = "private" | "extern" | "audited";

/** Toggle one keyword modifier in its grammar position — `private` before
 *  `operation`, `extern` then `audited` after the parameter list. */
export function setOpModifier(
  source: string,
  agg: string,
  op: string,
  modifier: OpModifier,
  on: boolean,
): string | null {
  const node = locateOp(source, agg, op);
  if (!node) return null;
  const tokens = ownTokens(node);
  const already =
    modifier === "private" ? node.private : modifier === "extern" ? node.extern : node.audited;
  if (already === on) return source;

  if (modifier === "private") {
    const keyword = firstToken(tokens, "operation");
    if (!keyword) return null;
    if (on) {
      return ifParses(
        applyEdits(source, [{ offset: keyword.offset, end: keyword.offset, newText: "private " }]),
      );
    }
    const tok = firstToken(tokens, "private");
    if (!tok) return null;
    // Take the space after it — `private operation` → `operation`.
    return ifParses(applyEdits(source, [{ offset: tok.offset, end: keyword.offset, newText: "" }]));
  }

  const close = lastToken(tokens, ")");
  if (!close) return null;
  if (!on) {
    const tok = firstToken(tokens, modifier);
    if (!tok) return null;
    // Delete from the end of the preceding element so the space goes too.
    const prevEnd =
      modifier === "audited" && node.extern ? (firstToken(tokens, "extern")?.end ?? close.end) : close.end;
    return ifParses(applyEdits(source, [{ offset: prevEnd, end: tok.end, newText: "" }]));
  }
  // `extern` goes right after the parens; `audited` after `extern` when present.
  const at =
    modifier === "extern"
      ? close.end
      : node.extern
        ? (firstToken(tokens, "extern")?.end ?? close.end)
        : close.end;
  return ifParses(applyEdits(source, [{ offset: at, end: at, newText: ` ${modifier}` }]));
}

// --- find header -----------------------------------------------------------

/** End offset of the last `find` header element before `stop`. */
function findAnchorBefore(find: FindDecl, stop: "requires" | "ignoring"): number | null {
  let at = find.returnType.$cstNode?.end;
  if (at === undefined) return null;
  if (stop === "requires") return at;
  if (find.gate?.$cstNode) at = find.gate.$cstNode.end;
  if (find.filter?.$cstNode) at = find.filter.$cstNode.end;
  return at;
}

/** Add / replace / remove a find's `requires` gate (it sits between the return
 *  type and the `where` filter, so an insertion never disturbs the filter). */
export function setFindGate(
  source: string,
  repo: string,
  find: string,
  exprText: string | null,
): string | null {
  const node = locateFind(source, repo, find);
  if (!node) return null;
  const existing = node.gate?.$cstNode;
  if (exprText === null) {
    if (!existing) return source;
    const from = findAnchorBefore(node, "requires");
    if (from === null) return null;
    return ifParses(applyEdits(source, [{ offset: from, end: existing.end, newText: "" }]));
  }
  const text = exprText.trim();
  if (!text) return null;
  if (existing) {
    return ifParses(applyEdits(source, [{ offset: existing.offset, end: existing.end, newText: text }]));
  }
  const at = findAnchorBefore(node, "requires");
  if (at === null) return null;
  return ifParses(applyEdits(source, [{ offset: at, end: at, newText: ` requires ${text}` }]));
}

/** Span of an existing `ignoring …` clause — the keyword through its last
 *  name / the `*`.  The names are plain `ID`s (capabilities are resolved by
 *  the expander's inventory, not by Langium scoping), so their CST nodes come
 *  from the property lookup rather than from a cross-reference. */
function ignoringRange(find: FindDecl): { offset: number; end: number } | null {
  const keyword = firstToken(ownTokens(find), "ignoring");
  if (!keyword) return null;
  let end = keyword.end;
  const cst = find.$cstNode;
  if (find.bypassAll) {
    const star = GrammarUtils.findNodeForProperty(cst, "bypassAll");
    if (star) end = Math.max(end, star.end);
  }
  for (const n of GrammarUtils.findNodesForProperty(cst, "bypass")) end = Math.max(end, n.end);
  return { offset: keyword.offset, end };
}

/** Add / replace / remove a find's `ignoring` clause: `"*"` bypasses every
 *  capability filter, a name list bypasses exactly those, `null` drops it. */
export function setFindIgnoring(
  source: string,
  repo: string,
  find: string,
  spec: "*" | readonly string[] | null,
): string | null {
  const node = locateFind(source, repo, find);
  if (!node) return null;
  const existing = ignoringRange(node);
  const names = spec === null || spec === "*" ? [] : spec.map((s) => s.trim()).filter(Boolean);
  // An empty name list is the same request as "drop the clause".
  const drop = spec === null || (spec !== "*" && names.length === 0);
  if (drop) {
    if (!existing) return source;
    const from = findAnchorBefore(node, "ignoring");
    if (from === null) return null;
    return ifParses(applyEdits(source, [{ offset: from, end: existing.end, newText: "" }]));
  }
  if (names.some((n) => !IDENTIFIER.test(n))) return null;
  const clause = `ignoring ${spec === "*" ? "*" : names.join(", ")}`;
  if (existing) {
    return ifParses(
      applyEdits(source, [{ offset: existing.offset, end: existing.end, newText: clause }]),
    );
  }
  const at = findAnchorBefore(node, "ignoring");
  if (at === null) return null;
  return ifParses(applyEdits(source, [{ offset: at, end: at, newText: ` ${clause}` }]));
}
