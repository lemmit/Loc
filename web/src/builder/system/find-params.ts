import { AstUtils, GrammarUtils, type AstNode } from "langium";
import type {
  FindDecl,
  Model,
  NameRef,
  Parameter,
  Repository,
} from "../../../../src/language/generated/ast.js";
import { parseDdd } from "../parse";
import { applyEdits, type TextEdit } from "../edit-engine";
import { IDENTIFIER } from "./rename";
import { baseLabel, baseSpecOf, typeText, type BaseSpec, type TypeSpec } from "./fields";

// ---------------------------------------------------------------------------
// Repository `find` parameter editing — add / delete / retype / rename params
// and edit the return type, mirroring the field-editing path (parse → locate →
// narrow splice → re-parse).  A find's params are `name: TypeRef` pairs, so the
// type machinery is shared with `fields.ts`.
//
// Like the field ops, these used to reprint the WHOLE `repository` block and
// splice it back — which deleted every comment inside the repository (the
// structural printer has no comment handling) and re-canonicalised each find's
// `where` filter.  Each op now rewrites only the span it changes: one param's
// text, the gap between two params, the param's `TypeRef`, the return type, or
// the name token plus its filter usages.
//
// Param *rename* is safe to do here (unlike a field rename): a param's only
// usages are bare `NameRef`s inside the *same find's* `where` filter, where the
// param shadows any aggregate member of the same name — so we rewrite the param
// token and every matching `NameRef` in that one filter.
// ---------------------------------------------------------------------------

export interface ParamInfo {
  name: string;
  base: BaseSpec;
  baseLabel: string;
  array: boolean;
  optional: boolean;
}

function findRepo(ast: Model, name: string): Repository | null {
  for (const n of AstUtils.streamAst(ast)) {
    if (n.$type === "Repository" && (n as Repository).name === name) return n as Repository;
  }
  return null;
}

function paramInfo(p: Parameter): ParamInfo {
  const base = baseSpecOf(p.type);
  return { name: p.name, base, baseLabel: baseLabel(base), array: p.type.array, optional: p.type.optional };
}

// --- read helpers ----------------------------------------------------------

/** Find names declared on a repository (for the inspector's find picker). */
export function listFinds(node: AstNode): string[] {
  if (node.$type !== "Repository") return [];
  return (node as Repository).finds.map((f) => f.name);
}

export function listFindParams(ast: Model, repoName: string, findName: string): ParamInfo[] {
  const find = findRepo(ast, repoName)?.finds.find((f) => f.name === findName);
  return find ? find.params.map(paramInfo) : [];
}

export function findReturnSpec(ast: Model, repoName: string, findName: string): TypeSpec | null {
  const find = findRepo(ast, repoName)?.finds.find((f) => f.name === findName);
  if (!find) return null;
  return { base: baseSpecOf(find.returnType), array: find.returnType.array, optional: find.returnType.optional };
}

// --- mutating ops (parse → locate → narrow splice → re-parse) --------------

/** Validate by re-parsing: return `candidate` only if it still parses. */
function ifParses(candidate: string): string | null {
  return parseDdd(candidate).parserErrors.length === 0 ? candidate : null;
}

/** The shared prologue: re-parse and resolve the find.  Null on a
 *  syntactically invalid source or an unknown repository / find. */
function locate(source: string, repoName: string, findName: string): FindDecl | null {
  const fresh = parseDdd(source);
  if (fresh.parserErrors.length > 0) return null;
  return findRepo(fresh.ast, repoName)?.finds.find((f) => f.name === findName) ?? null;
}

export function addFindParam(source: string, repoName: string, findName: string, paramName: string, type: TypeSpec): string | null {
  const find = locate(source, repoName, findName);
  const cst = find?.$cstNode;
  if (!find || !cst) return null;
  const text = `${paramName}: ${typeText(type)}`;
  const last = find.params[find.params.length - 1]?.$cstNode;
  if (last) {
    return ifParses(applyEdits(source, [{ offset: last.end, end: last.end, newText: `, ${text}` }]));
  }
  // Empty param list — insert just inside the find's own `(`.
  const open = GrammarUtils.findNodeForKeyword(cst, "(");
  if (!open) return null;
  return ifParses(applyEdits(source, [{ offset: open.end, end: open.end, newText: text }]));
}

export function deleteFindParam(source: string, repoName: string, findName: string, index: number): string | null {
  const find = locate(source, repoName, findName);
  const cst = find?.params[index]?.$cstNode;
  if (!find || !cst) return null;
  // Take the separating comma with the param: the one before it when there is
  // a preceding param, otherwise the one after it.  A sole param leaves `()`.
  const prev = index > 0 ? find.params[index - 1].$cstNode : undefined;
  const next = index === 0 ? find.params[1]?.$cstNode : undefined;
  const offset = prev ? prev.end : cst.offset;
  const end = next ? next.offset : cst.end;
  return ifParses(applyEdits(source, [{ offset, end, newText: "" }]));
}

export function retypeFindParam(source: string, repoName: string, findName: string, index: number, type: TypeSpec): string | null {
  const cst = locate(source, repoName, findName)?.params[index]?.type.$cstNode;
  if (!cst) return null;
  return ifParses(applyEdits(source, [{ offset: cst.offset, end: cst.end, newText: typeText(type) }]));
}

export function renameFindParam(source: string, repoName: string, findName: string, index: number, newName: string): string | null {
  if (!IDENTIFIER.test(newName)) return null;
  const find = locate(source, repoName, findName);
  const param = find?.params[index];
  const nameNode = param?.$cstNode ? GrammarUtils.findNodeForProperty(param.$cstNode, "name") : undefined;
  if (!find || !param || !nameNode) return null;
  if (find.params.some((q, i) => i !== index && q.name === newName)) return null;
  const edits: TextEdit[] = [{ offset: nameNode.offset, end: nameNode.end, newText: newName }];
  // The param's only usages are bare NameRefs in this find's own filter,
  // where the param shadows any same-named member.
  if (find.filter) {
    for (const n of AstUtils.streamAst(find.filter)) {
      const cst = n.$cstNode;
      if (cst && n.$type === "NameRef" && (n as NameRef).name === param.name) {
        edits.push({ offset: cst.offset, end: cst.end, newText: newName });
      }
    }
  }
  return ifParses(applyEdits(source, edits));
}

export function setFindReturnType(source: string, repoName: string, findName: string, type: TypeSpec): string | null {
  const cst = locate(source, repoName, findName)?.returnType.$cstNode;
  if (!cst) return null;
  return ifParses(applyEdits(source, [{ offset: cst.offset, end: cst.end, newText: typeText(type) }]));
}

/** A param name not already used by the find. */
export function freshParamName(ast: Model, repoName: string, findName: string): string {
  const taken = new Set(listFindParams(ast, repoName, findName).map((p) => p.name));
  for (let i = 1; ; i++) {
    const candidate = `param${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}
