// Shared repo-read recognition — the IR-layer detector for a repository
// READ call (`Repo.find(<Criterion>)` / `Repo.findAll(<Criterion>, page?)` /
// `Repo.run(<Retrieval>(args), page?)` / `Repo.<namedFind>(args)`) over the
// raw `.ddd` AST.
//
// This is the single source of truth for "is this expression a repository
// read", consumed by BOTH the workflow lowerer (`lower-workflow.ts`, which
// lowers a recognised read to a `repo-run` / `repo-let` `WorkflowStmtIR`)
// AND the domain-service lowerer (`lower-domain-service.ts`, which lowers a
// recognised read to a resolved `repo-read` `ExprIR` Call so a service body
// can run read-only queries — domain-services.md rev. 4, the `reading` tier).
//
// It is a LEAF: it touches only the Langium AST + the `Repository` shape, and
// never imports `lower.ts` (the graph stays acyclic — the orchestrator and the
// two leaf lowerers import this).  Extracting it is a PURE refactor of the
// workflow path: the matchers below are byte-for-byte the ones that lived in
// `lower-workflow.ts`, so workflow lowering output is unchanged.
import type { Expression, LoadPath, Repository, SortItem } from "../../language/generated/ast.js";
import {
  isCallSuffix,
  isMemberSuffix,
  isNameRef,
  isObjectLit,
  isPostfixChain,
  isRetrievalLiteral,
} from "../../language/generated/ast.js";
import { isReadMethod } from "../util/repo-methods.js";

export interface RepoMatch {
  repo: Repository;
  method: string;
  args: Expression[];
}

/** Recognise `<Repo>.<method>(args)` — a generic named repository call (a
 *  declared `find`, or the built-in `getById`).  Exactly one `MemberSuffix`
 *  with a call payload whose head names a repository.  Repo finds are
 *  positional, so the CallArg wrappers are peeled to bare value expressions. */
export function matchRepoCall(
  expr: Expression | undefined,
  reposByName: Map<string, Repository>,
): RepoMatch | undefined {
  if (!expr || !isPostfixChain(expr)) return undefined;
  if (expr.suffixes.length !== 1) return undefined;
  const s = expr.suffixes[0]!;
  if (!isMemberSuffix(s) || !s.call) return undefined;
  const recv = expr.head;
  if (!isNameRef(recv)) return undefined;
  const repo = reposByName.get(recv.name);
  if (!repo) return undefined;
  return {
    repo,
    method: s.member,
    args: (s.args ?? []).map((a) => a.value),
  };
}

export interface FindMatch {
  repo: Repository;
  criterionName: string;
  criterionArgs: Expression[];
}

/** Recognise `<Repo>.find(<CriterionRef>)` — the single-result sibling of
 *  `findAll` (criterion.md, use site 3).  No `page:` (a single result isn't
 *  paginated); the only arg is a criterion reference (bare `Name` or
 *  `Name(args)`).  Declines (→ `undefined`) on any other shape. */
export function matchFindCall(
  expr: Expression | undefined,
  reposByName: Map<string, Repository>,
): FindMatch | undefined {
  if (!expr || !isPostfixChain(expr) || expr.suffixes.length !== 1) return undefined;
  const s = expr.suffixes[0]!;
  if (!isMemberSuffix(s) || !s.call || s.member !== "find") return undefined;
  const recv = expr.head;
  if (!isNameRef(recv)) return undefined;
  const repo = reposByName.get(recv.name);
  if (!repo) return undefined;
  const refArg = (s.args ?? []).find((a) => !a.name);
  if (!refArg) return undefined;
  const critRef = criterionRefFromExpr(refArg.value);
  if (!critRef) return undefined;
  return { repo, criterionName: critRef.name, criterionArgs: critRef.args };
}

export interface FindAllMatch {
  repo: Repository;
  /** The referenced criterion name. */
  criterionName: string;
  /** Lowered-later argument expressions of `Criterion(args)`. */
  criterionArgs: Expression[];
  pageOffset?: Expression;
  pageLimit?: Expression;
}

/** Recognise `<Repo>.findAll(<CriterionRef>, page?)` (criterion.md, use
 *  site 3).  The first positional arg is a criterion reference — a bare
 *  `Name` (parameterless) or `Name(args)` — and an optional named `page:`
 *  arg carries `{ offset?, limit? }`.  Structurally the mirror of
 *  `matchRetrievalRunCall`; only the method name (`findAll`) and the ref's
 *  meaning (criterion, not retrieval) differ. */
export function matchFindAllCall(
  expr: Expression | undefined,
  reposByName: Map<string, Repository>,
): FindAllMatch | undefined {
  if (!expr || !isPostfixChain(expr)) return undefined;
  if (expr.suffixes.length !== 1) return undefined;
  const s = expr.suffixes[0]!;
  if (!isMemberSuffix(s) || !s.call || s.member !== "findAll") return undefined;
  const recv = expr.head;
  if (!isNameRef(recv)) return undefined;
  const repo = reposByName.get(recv.name);
  if (!repo) return undefined;
  const callArgs = s.args ?? [];
  const refArg = callArgs.find((a) => !a.name);
  if (!refArg) return undefined;
  const ref = refArg.value;
  let criterionName: string;
  let criterionArgs: Expression[] = [];
  if (isNameRef(ref)) {
    criterionName = ref.name;
  } else if (isPostfixChain(ref) && isNameRef(ref.head) && ref.suffixes.length === 1) {
    const rs = ref.suffixes[0]!;
    if (!isCallSuffix(rs)) return undefined;
    criterionName = ref.head.name;
    criterionArgs = (rs.args ?? []).map((a) => a.value);
  } else {
    return undefined;
  }
  const pageArg = callArgs.find((a) => a.name === "page");
  let pageOffset: Expression | undefined;
  let pageLimit: Expression | undefined;
  if (pageArg && isObjectLit(pageArg.value)) {
    for (const f of pageArg.value.fields) {
      if (f.name === "offset") pageOffset = f.value;
      else if (f.name === "limit") pageLimit = f.value;
    }
  }
  return { repo, criterionName, criterionArgs, pageOffset, pageLimit };
}

export interface RetrievalRunMatch {
  repo: Repository;
  retrievalName: string;
  retrievalArgs: Expression[];
  /** Set when the run target was an anonymous retrieval literal
   *  (`retrieval { where: <Criterion> sort: … loads: … }`) rather than a named
   *  retrieval reference.  Lowers to a `synthCriterion` repo-run + shaping,
   *  riding the same enrich path as `findAll`. */
  anon?: {
    criterionName: string;
    criterionArgs: Expression[];
    sort: SortItem[];
    loads: LoadPath[];
  };
  /** The `page:` object-literal argument's fields, if supplied. */
  pageOffset?: Expression;
  pageLimit?: Expression;
}

/** Recognise `<Repo>.run(<RetrievalRef>(args), page?)`.  The first
 *  positional arg is itself a call (the retrieval reference); an optional
 *  named `page:` arg carries an object literal `{ offset?, limit? }`. */
export function matchRetrievalRunCall(
  expr: Expression | undefined,
  reposByName: Map<string, Repository>,
): RetrievalRunMatch | undefined {
  if (!expr || !isPostfixChain(expr)) return undefined;
  if (expr.suffixes.length !== 1) return undefined;
  const s = expr.suffixes[0]!;
  if (!isMemberSuffix(s) || !s.call || s.member !== "run") return undefined;
  const recv = expr.head;
  if (!isNameRef(recv)) return undefined;
  const repo = reposByName.get(recv.name);
  if (!repo) return undefined;
  const callArgs = s.args ?? [];
  // First positional arg = the retrieval reference `Name(args)`.
  const refArg = callArgs.find((a) => !a.name);
  if (!refArg) return undefined;
  const ref = refArg.value;
  // `page:` is shared by the named and anonymous forms.
  const readPage = (): { pageOffset?: Expression; pageLimit?: Expression } => {
    const pageArg = callArgs.find((a) => a.name === "page");
    const out: { pageOffset?: Expression; pageLimit?: Expression } = {};
    if (pageArg && isObjectLit(pageArg.value)) {
      for (const f of pageArg.value.fields) {
        if (f.name === "offset") out.pageOffset = f.value;
        else if (f.name === "limit") out.pageLimit = f.value;
      }
    }
    return out;
  };
  // Anonymous retrieval literal — `run(retrieval { where: <Criterion> sort: …
  // loads: … })`.  The `where` must be a criterion reference (this release);
  // a non-criterion `where` is rejected by the language validator, so a miss
  // here just declines the match.
  if (isRetrievalLiteral(ref)) {
    const critRef = criterionRefFromExpr(ref.where);
    if (!critRef) return undefined;
    return {
      repo,
      retrievalName: "",
      retrievalArgs: [],
      anon: {
        criterionName: critRef.name,
        criterionArgs: critRef.args,
        sort: ref.sort,
        loads: ref.loads,
      },
      ...readPage(),
    };
  }
  // Bare `Name` (parameterless retrieval) — still honours a sibling `page:`
  // arg (`Repo.run(Recent, page: { limit: 20 })`), like the anonymous and
  // `Name(args)` branches.
  if (isNameRef(ref)) {
    return { repo, retrievalName: ref.name, retrievalArgs: [], ...readPage() };
  }
  // `Name(args)` — a NameRef head + a single CallSuffix.
  if (!isPostfixChain(ref) || !isNameRef(ref.head) || ref.suffixes.length !== 1) {
    return undefined;
  }
  const rs = ref.suffixes[0]!;
  if (!isCallSuffix(rs)) return undefined;
  const retrievalName = ref.head.name;
  const retrievalArgs: Expression[] = (rs.args ?? []).map((a) => a.value);
  // Optional `page:` named arg — an object literal with offset / limit.
  const pageArg = callArgs.find((a) => a.name === "page");
  let pageOffset: Expression | undefined;
  let pageLimit: Expression | undefined;
  if (pageArg && isObjectLit(pageArg.value)) {
    for (const f of pageArg.value.fields) {
      if (f.name === "offset") pageOffset = f.value;
      else if (f.name === "limit") pageLimit = f.value;
    }
  }
  return { repo, retrievalName, retrievalArgs, pageOffset, pageLimit };
}

/** A criterion reference expression — a bare `Name` (parameterless) or
 *  `Name(args)`.  Shared by the `findAll` arg and the anonymous-retrieval
 *  `where:`. */
export function criterionRefFromExpr(
  ref: Expression,
): { name: string; args: Expression[] } | undefined {
  if (isNameRef(ref)) return { name: ref.name, args: [] };
  if (isPostfixChain(ref) && isNameRef(ref.head) && ref.suffixes.length === 1) {
    const rs = ref.suffixes[0]!;
    if (!isCallSuffix(rs)) return undefined;
    return { name: ref.head.name, args: (rs.args ?? []).map((a) => a.value) };
  }
  return undefined;
}

/** The kind of repository read recognised in a body — the discriminator the
 *  domain-service read lowerer stamps onto the resolved `repo-read` Call so a
 *  backend renders the right find-method without re-recognising the AST shape.
 *  `named` = a declared `find`/`getById`; `find`/`findAll` = a criterion read;
 *  `run` = a retrieval read. */
export type RepoReadKind = "named" | "find" | "findAll" | "run";

export interface RepoReadMatch {
  kind: RepoReadKind;
  repo: Repository;
  /** The find / retrieval / criterion method name to render against the repo. */
  method: string;
  /** Positional argument expressions (criterion / find args), lowered by the
   *  caller in its own scope. */
  args: Expression[];
  /** For `find`/`findAll` — the referenced criterion name.  The read FILTERS by
   *  this criterion; without carrying it the criterion is silently dropped and
   *  the read returns every row (data-exposure).  Drives the synthesis of the
   *  `findAllBy<Criterion>` retrieval the backend renders. */
  criterionName?: string;
  /** For `run` — the referenced (named) retrieval.  Empty for an anonymous
   *  retrieval literal, whose predicate rides `criterionName` instead. */
  retrievalName?: string;
}

/** Recognise ANY repository read in an expression position, collapsing the four
 *  read shapes to one `RepoReadMatch` for the domain-service `reading` tier.
 *  Tries the specific forms (`find` / `findAll` / `run`) before the generic
 *  named-find/`getById` form, mirroring the precedence the workflow let-lowerer
 *  uses (run → findAll → repo-call).  Returns `undefined` for a non-read (a
 *  WRITE like `save`/`insert` falls through here — it is NOT a read, so the
 *  validator's repo-WRITE gate rejects it). */
export function matchRepoRead(
  expr: Expression | undefined,
  reposByName: Map<string, Repository>,
): RepoReadMatch | undefined {
  const find = matchFindCall(expr, reposByName);
  if (find)
    return {
      kind: "find",
      repo: find.repo,
      method: "find",
      args: find.criterionArgs,
      criterionName: find.criterionName,
    };
  const findAll = matchFindAllCall(expr, reposByName);
  if (findAll)
    return {
      kind: "findAll",
      repo: findAll.repo,
      method: "findAll",
      args: findAll.criterionArgs,
      criterionName: findAll.criterionName,
    };
  const run = matchRetrievalRunCall(expr, reposByName);
  if (run)
    return {
      kind: "run",
      repo: run.repo,
      method: "run",
      args: run.anon ? run.anon.criterionArgs : run.retrievalArgs,
      ...(run.anon
        ? { criterionName: run.anon.criterionName }
        : { retrievalName: run.retrievalName }),
    };
  const repo = matchRepoCall(expr, reposByName);
  if (repo && isReadMethod(repo.method))
    return { kind: "named", repo: repo.repo, method: repo.method, args: repo.args };
  return undefined;
}

/** Repository WRITE method names — a call on a repository naming one of these
 *  is a persistence mutation, forbidden in a `reading` domain service.  A
 *  non-write, non-find named call is treated as a read (a declared `find`). */
