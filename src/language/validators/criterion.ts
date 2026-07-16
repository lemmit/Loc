// Criterion declaration + use-site checks.
//
// A `criterion` is a named, parameterised, pure boolean predicate over a
// candidate type — the Specification Pattern (see docs/criterion.md).  It
// is inlined wherever it is referenced from a boolean-expression position
// (`view ... where`, repository `find ... where`, an `invariant`, an
// operation guard), so these checks keep the construct honest before
// lowering ever inlines it:
//
//   - loom.criterion-unsupported-target — v1 supports `of <Aggregate>`
//     and `of bool` only; other candidate types are reserved for the
//     forthcoming `from <Criterion>(args)` parameter-binding surface.
//   - loom.criterion-impure — the body calls a mutating operation.  (The
//     expression grammar already excludes `:=` / `+=` / `emit`, so an
//     operation call is the only way impurity can sneak in.)
//   - loom.criterion-cycle — `criterion A = B` / `criterion B = A`.
//   - loom.criterion-arity — a criterion call supplies the wrong number
//     of arguments.

import { type AstNode, AstUtils, type ValidationAcceptor } from "langium";
import {
  type Aggregate,
  type Criterion,
  isAggregate,
  isBoundedContext,
  isCallSuffix,
  isCriterion,
  isEnumDecl,
  isFindDecl,
  isMemberSuffix,
  isNamedType,
  isNameRef,
  isPostfixChain,
  isPrimitiveType,
  isRepository,
  isView,
  type Model,
  type NameRef,
} from "../generated/ast.js";
import { findOperation } from "../type-system.js";

/** Resolve the candidate aggregate of a criterion's `of <T>`, or
 *  `undefined` when the candidate is not a (non-array, non-optional)
 *  aggregate. */
function candidateAggregate(c: Criterion): Aggregate | undefined {
  const t = c.target;
  if (!t || t.array || t.optional) return undefined;
  const base = t.base;
  if (isNamedType(base)) {
    const ref = base.target?.ref;
    if (ref && isAggregate(ref)) return ref;
  }
  return undefined;
}

/** Whether the criterion's `of <T>` is the pure-ambient `bool` candidate. */
function isBoolTarget(c: Criterion): boolean {
  const t = c.target;
  if (!t || t.array || t.optional) return false;
  return isPrimitiveType(t.base) && t.base.name === "bool";
}

export function checkCriteria(model: Model, accept: ValidationAcceptor): void {
  for (const node of AstUtils.streamAllContents(model)) {
    if (!isCriterion(node)) continue;
    checkOneCriterion(node, accept);
  }
  checkCriterionUseSites(model, accept);
}

function checkOneCriterion(c: Criterion, accept: ValidationAcceptor): void {
  const candidate = candidateAggregate(c);
  // --- alias collision: `of T as o` where `o` is also a parameter name is
  // ambiguous (does `o` mean the candidate or the param?).  Reject it.
  if (c.alias && c.params.some((p) => p.name === c.alias)) {
    accept(
      "error",
      `criterion '${c.name}' binds the candidate alias '${c.alias}', but a parameter of the same name already exists — rename one so a bare '${c.alias}' is unambiguous.`,
      { node: c, property: "alias", code: "loom.criterion-alias-collision" },
    );
  }
  // --- target kind ----------------------------------------------------
  if (!candidate && !isBoolTarget(c)) {
    accept(
      "error",
      `criterion '${c.name}' has an unsupported candidate type. v1 supports 'of <Aggregate>' (a predicate over that aggregate) or 'of bool' (a pure ambient predicate); predicates over primitives / value objects / enums are reserved for the forthcoming 'from <Criterion>(args)' parameter-binding surface.`,
      { node: c, property: "target", code: "loom.criterion-unsupported-target" },
    );
  }

  // --- purity: no mutating operation calls ----------------------------
  // `streamAst` includes the body root itself — a bare `close()` body is
  // the PostfixChain, which `streamAllContents` would skip.
  if (candidate) {
    for (const n of AstUtils.streamAst(c.body)) {
      // `this.cancel()` / `x.cancel()` — a member call whose name is an
      // operation on the candidate aggregate.
      if (isMemberSuffix(n) && n.call && findOperation(candidate, n.member)) {
        accept(
          "error",
          `criterion '${c.name}' is impure: it calls the operation '${n.member}'. Criteria are pure predicates — call a 'function' (pure) instead of an 'operation' (mutating).`,
          { node: n, code: "loom.criterion-impure" },
        );
      }
      // `cancel()` — a free call resolving to a (private) operation on the
      // candidate aggregate.
      if (isPostfixChain(n)) {
        const head = n.head;
        const first = n.suffixes[0];
        if (
          isNameRef(head) &&
          first &&
          isCallSuffix(first) &&
          findOperation(candidate, head.name)
        ) {
          accept(
            "error",
            `criterion '${c.name}' is impure: it calls the operation '${head.name}'. Criteria are pure predicates — call a 'function' (pure) instead of an 'operation' (mutating).`,
            { node: head, code: "loom.criterion-impure" },
          );
        }
      }
    }
  }

  // --- reference cycle ------------------------------------------------
  const ctx = AstUtils.getContainerOfType(c, isBoundedContext);
  if (ctx) {
    const byName = new Map<string, Criterion>();
    for (const m of ctx.members) if (isCriterion(m)) byName.set(m.name, m);
    if (participatesInCycle(c, byName)) {
      accept(
        "error",
        `criterion '${c.name}' is part of a reference cycle. A criterion may not (transitively) reference itself.`,
        { node: c, property: "name", code: "loom.criterion-cycle" },
      );
    }
  }
}

/** Names of the criteria referenced (by bare name or call) within a
 *  criterion body, restricted to criteria declared in the same context. */
function referencedCriteria(c: Criterion, byName: Map<string, Criterion>): string[] {
  const out: string[] = [];
  for (const n of AstUtils.streamAst(c.body)) {
    if (isNameRef(n) && byName.has(n.name)) out.push(n.name);
  }
  return out;
}

/** DFS from `start` over the criterion reference graph; true iff `start`
 *  is reachable from itself. */
function participatesInCycle(start: Criterion, byName: Map<string, Criterion>): boolean {
  const stack: string[] = [start.name];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const name = stack.pop() as string;
    const node = byName.get(name);
    if (!node) continue;
    for (const ref of referencedCriteria(node, byName)) {
      if (ref === start.name) return true;
      if (!seen.has(ref)) {
        seen.add(ref);
        stack.push(ref);
      }
    }
  }
  return false;
}

/** The candidate aggregate of the *use site* enclosing `node`: a
 *  repository find's aggregate, a view's source, or the enclosing
 *  aggregate (invariant / operation / derived / function body).  Used to
 *  check criterion candidate compatibility. */
function hostAggregate(node: AstNode): Aggregate | undefined {
  const find = AstUtils.getContainerOfType(node, isFindDecl);
  if (find) {
    const repo = AstUtils.getContainerOfType(find, isRepository);
    const agg = repo?.aggregate?.ref;
    if (agg && isAggregate(agg)) return agg;
  }
  const view = AstUtils.getContainerOfType(node, isView);
  if (view) {
    const agg = view.source?.ref;
    if (agg && isAggregate(agg)) return agg;
  }
  return AstUtils.getContainerOfType(node, isAggregate);
}

/** Whether `name` is shadowed at `node` by a field / member of the host
 *  aggregate or an enum value in the context — in which case a bare
 *  reference is that name, not a criterion reference, and is left alone. */
function shadowsCriterionName(
  name: string,
  host: Aggregate | undefined,
  ctx: { members: readonly AstNode[] },
): boolean {
  if (host?.members.some((m) => "name" in m && (m as { name?: string }).name === name)) return true;
  for (const m of ctx.members) {
    if (isEnumDecl(m) && m.values.some((v) => v.name === name)) return true;
  }
  return false;
}

/** Use-site checks on criterion references:
 *   - loom.criterion-arity — wrong argument count.
 *   - loom.criterion-target-mismatch — an aggregate-candidate criterion
 *     used where the host candidate is a different aggregate (its body
 *     would reference fields the host does not have).
 *  The unambiguous call form (`X(args)`) is always checked; a bare name
 *  is checked only when it is not shadowed by a field / enum value. */
function checkCriterionUseSites(model: Model, accept: ValidationAcceptor): void {
  for (const node of AstUtils.streamAllContents(model)) {
    // Call form: `X(args)` — head NameRef + leading CallSuffix.
    if (isPostfixChain(node)) {
      const head = node.head;
      const first = node.suffixes[0];
      if (isNameRef(head) && first && isCallSuffix(first)) {
        checkCriterionReference(head, first.args.length, accept);
      }
      continue;
    }
    // Bare form: a NameRef that is not the head of a call chain.
    if (isNameRef(node)) {
      const parent = node.$container;
      const isCallHead =
        parent &&
        isPostfixChain(parent) &&
        parent.head === node &&
        isCallSuffix(parent.suffixes[0]!);
      if (isCallHead) continue;
      checkCriterionReference(node, undefined, accept);
    }
  }
}

/** Validate one criterion reference.  `argc` is the supplied argument
 *  count for the call form, or `undefined` for a bare reference. */
function checkCriterionReference(
  ref: NameRef,
  argc: number | undefined,
  accept: ValidationAcceptor,
): void {
  const ctx = AstUtils.getContainerOfType(ref, isBoundedContext);
  if (!ctx) return;
  const crit = ctx.members.find((m) => isCriterion(m) && m.name === ref.name) as
    | Criterion
    | undefined;
  if (!crit) return;
  const host = hostAggregate(ref);
  // A bare name shadowed by a field / enum value is not a criterion ref.
  if (argc === undefined && shadowsCriterionName(ref.name, host, ctx)) return;

  // Arity.
  const want = crit.params.length;
  const got = argc ?? 0;
  if (got !== want) {
    accept(
      "error",
      argc === undefined && want > 0
        ? `criterion '${crit.name}' expects ${want} argument${want === 1 ? "" : "s"}; reference it as '${crit.name}(…)'.`
        : `criterion '${crit.name}' expects ${want} argument${want === 1 ? "" : "s"}, but ${got} ${got === 1 ? "was" : "were"} supplied.`,
      { node: ref, code: "loom.criterion-arity" },
    );
    return;
  }

  // Candidate compatibility — aggregate-candidate criteria only.
  const critCandidate = candidateAggregate(crit);
  if (critCandidate && host && critCandidate !== host) {
    accept(
      "error",
      `criterion '${crit.name}' is over '${critCandidate.name}', but it is used here against '${host.name}'. A criterion can only filter the aggregate it is declared 'of'.`,
      { node: ref, code: "loom.criterion-target-mismatch" },
    );
  }
}
