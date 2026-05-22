import { AstUtils, type AstNode } from "langium";
import type {
  FindDecl,
  Model,
  NameRef,
  Parameter,
  Repository,
  TypeRef,
} from "../../../../src/language/generated/ast.js";
import { printStructural } from "../../../../src/language/print/index.js";
import { parseDdd } from "../parse";
import { spliceNode } from "../edit-engine";
import { IDENTIFIER } from "./rename";
import { baseLabel, baseSpecOf, buildTypeRef, type BaseSpec, type TypeSpec } from "./fields";

// ---------------------------------------------------------------------------
// Repository `find` parameter editing — add / delete / retype / rename params
// and edit the return type, mirroring the field-editing path (parse → mutate →
// reprint the Repository → splice).  A find's params are `name: TypeRef` pairs,
// so the type machinery is shared with `fields.ts`.
//
// Param *rename* is safe to do here (unlike a field rename): a param's only
// usages are bare `NameRef`s inside the *same find's* `where` filter, where the
// param shadows any aggregate member of the same name — so we rename the param
// token and every matching `NameRef` in that one filter, then reprint.
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

// --- mutating ops ----------------------------------------------------------

function commit(source: string, repoName: string, findName: string, mutate: (find: FindDecl, repo: Repository) => boolean): string | null {
  const fresh = parseDdd(source);
  if (fresh.parserErrors.length > 0) return null;
  const repo = findRepo(fresh.ast, repoName);
  const find = repo?.finds.find((f) => f.name === findName);
  if (!repo || !find) return null;
  if (!mutate(find, repo)) return null;
  return spliceNode(source, repo, printStructural(repo));
}

function buildParam(name: string, spec: TypeSpec): Parameter {
  return { $type: "Parameter", name, type: buildTypeRef(spec) } as unknown as Parameter;
}

export function addFindParam(source: string, repoName: string, findName: string, paramName: string, type: TypeSpec): string | null {
  return commit(source, repoName, findName, (find) => {
    find.params.push(buildParam(paramName, type));
    return true;
  });
}

export function deleteFindParam(source: string, repoName: string, findName: string, index: number): string | null {
  return commit(source, repoName, findName, (find) => {
    if (!find.params[index]) return false;
    find.params.splice(index, 1);
    return true;
  });
}

export function retypeFindParam(source: string, repoName: string, findName: string, index: number, type: TypeSpec): string | null {
  return commit(source, repoName, findName, (find) => {
    const p = find.params[index];
    if (!p) return false;
    p.type = buildTypeRef(type);
    return true;
  });
}

export function renameFindParam(source: string, repoName: string, findName: string, index: number, newName: string): string | null {
  if (!IDENTIFIER.test(newName)) return null;
  return commit(source, repoName, findName, (find) => {
    const p = find.params[index];
    if (!p || find.params.some((q, i) => i !== index && q.name === newName)) return false;
    const old = p.name;
    p.name = newName;
    // The param's only usages are bare NameRefs in this find's own filter,
    // where the param shadows any same-named member.
    if (find.filter) {
      for (const n of AstUtils.streamAst(find.filter)) {
        if (n.$type === "NameRef" && (n as NameRef).name === old) (n as NameRef).name = newName;
      }
    }
    return true;
  });
}

export function setFindReturnType(source: string, repoName: string, findName: string, type: TypeSpec): string | null {
  return commit(source, repoName, findName, (find) => {
    find.returnType = buildTypeRef(type);
    return true;
  });
}

/** A param name not already used by the find. */
export function freshParamName(ast: Model, repoName: string, findName: string): string {
  const taken = new Set(listFindParams(ast, repoName, findName).map((p) => p.name));
  for (let i = 1; ; i++) {
    const candidate = `param${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}
