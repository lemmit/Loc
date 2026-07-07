// Named policy-function declaration + use-site checks (authorization Phase 3.2).
//
// A function-form `policy` declaration —
//   policy CanApprove(cap: money): bool = <expr>
//   policy IsManager(): bool { <expr> }
// — is a named, parameterised, AMBIENT boolean authorization predicate
// (currentUser + its own params), referenced from a `requires PolicyName(args)`
// gate and INLINED there (like a `criterion … of bool`).  It shares the
// `policy` head with the P3.1 read-ladder block; the function form is the one
// carrying a `returnType`.  These checks keep the construct honest before
// lowering ever inlines it:
//
//   - loom.policy-fn-return-type — the return type annotation is not `bool`.
//   - loom.policy-fn-arity       — a `PolicyName(args)` call supplies the
//     wrong number of arguments.
//   - loom.policy-fn-cycle       — `policy A(): bool = B()` / `policy B(): bool
//     = A()` (transitive self-reference).

import { type AstNode, AstUtils, type ValidationAcceptor } from "langium";
import {
  isAggregate,
  isBoundedContext,
  isCallSuffix,
  isEnumDecl,
  isNameRef,
  isPolicyDecl,
  isPostfixChain,
  isPrimitiveType,
  type Model,
  type NameRef,
  type PolicyDecl,
} from "../generated/ast.js";

/** A function-form policy declaration is the one with a `returnType`; a
 *  block-form `policy {}` (read ladder) has none. */
function isPolicyFn(node: unknown): node is PolicyDecl {
  return isPolicyDecl(node) && (node as PolicyDecl).returnType !== undefined;
}

/** Whether the declaration's return annotation is the primitive `bool`
 *  (non-array, non-optional). */
function returnsBool(fn: PolicyDecl): boolean {
  const t = fn.returnType;
  if (!t || t.array || t.optional) return false;
  return isPrimitiveType(t.base) && t.base.name === "bool";
}

export function checkPolicyFns(model: Model, accept: ValidationAcceptor): void {
  for (const node of AstUtils.streamAllContents(model)) {
    if (!isPolicyFn(node)) continue;
    checkOnePolicyFn(node, accept);
  }
  checkPolicyFnUseSites(model, accept);
}

function checkOnePolicyFn(fn: PolicyDecl, accept: ValidationAcceptor): void {
  // --- return type ----------------------------------------------------
  if (!returnsBool(fn)) {
    accept(
      "error",
      `policy function '${fn.name}' must return 'bool' — an authorization predicate is a boolean point gate.`,
      { node: fn, property: "returnType", code: "loom.policy-fn-return-type" },
    );
  }

  // --- reference cycle ------------------------------------------------
  const ctx = AstUtils.getContainerOfType(fn, isBoundedContext);
  if (ctx) {
    const byName = new Map<string, PolicyDecl>();
    for (const m of ctx.members) if (isPolicyFn(m)) byName.set(m.name as string, m);
    if (participatesInCycle(fn, byName)) {
      accept(
        "error",
        `policy function '${fn.name}' is part of a reference cycle. A policy function may not (transitively) reference itself.`,
        { node: fn, property: "name", code: "loom.policy-fn-cycle" },
      );
    }
  }
}

/** Names of the policy functions referenced (by bare name or call) within a
 *  policy-function body, restricted to policy functions declared in the same
 *  context. */
function referencedPolicyFns(fn: PolicyDecl, byName: Map<string, PolicyDecl>): string[] {
  const out: string[] = [];
  if (!fn.body) return out;
  for (const n of AstUtils.streamAst(fn.body)) {
    if (isNameRef(n) && byName.has(n.name)) out.push(n.name);
  }
  return out;
}

/** DFS from `start` over the policy-function reference graph; true iff
 *  `start` is reachable from itself. */
function participatesInCycle(start: PolicyDecl, byName: Map<string, PolicyDecl>): boolean {
  const stack: string[] = [start.name as string];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const name = stack.pop() as string;
    const node = byName.get(name);
    if (!node) continue;
    for (const ref of referencedPolicyFns(node, byName)) {
      if (ref === start.name) return true;
      if (!seen.has(ref)) {
        seen.add(ref);
        stack.push(ref);
      }
    }
  }
  return false;
}

/** Use-site arity checks on policy-function references.  The unambiguous call
 *  form (`X(args)`) is always checked; a bare name is checked only when it
 *  resolves to a policy function (a parameterised one referenced bare is an
 *  arity error — it must be called). */
function checkPolicyFnUseSites(model: Model, accept: ValidationAcceptor): void {
  for (const node of AstUtils.streamAllContents(model)) {
    // Call form: `X(args)` — head NameRef + leading CallSuffix.
    if (isPostfixChain(node)) {
      const head = node.head;
      const first = node.suffixes[0];
      if (isNameRef(head) && first && isCallSuffix(first) && node.suffixes.length === 1) {
        checkPolicyFnReference(head, first.args.length, accept);
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
      checkPolicyFnReference(node, undefined, accept);
    }
  }
}

/** Whether a bare `name` at `node` is shadowed by an enclosing aggregate's
 *  field / member or a context enum value — in which case it is not a
 *  policy-function reference. */
function shadowsPolicyFnName(node: AstNode, name: string): boolean {
  const agg = AstUtils.getContainerOfType(node, isAggregate);
  if (agg?.members.some((m) => "name" in m && (m as { name?: string }).name === name)) return true;
  const ctx = AstUtils.getContainerOfType(node, isBoundedContext);
  if (ctx) {
    for (const m of ctx.members) {
      if (isEnumDecl(m) && m.values.some((v) => v.name === name)) return true;
    }
  }
  return false;
}

/** Validate one policy-function reference.  `argc` is the supplied argument
 *  count for the call form, or `undefined` for a bare reference. */
function checkPolicyFnReference(
  ref: NameRef,
  argc: number | undefined,
  accept: ValidationAcceptor,
): void {
  const ctx = AstUtils.getContainerOfType(ref, isBoundedContext);
  if (!ctx) return;
  const fn = ctx.members.find((m) => isPolicyFn(m) && m.name === ref.name) as
    | PolicyDecl
    | undefined;
  if (!fn) return;

  // A bare name shadowed by an enclosing aggregate field or a context enum
  // value is that name, not a policy-function reference — leave it alone
  // (mirrors the criterion use-site shadow guard).
  if (argc === undefined && shadowsPolicyFnName(ref, ref.name)) return;

  const want = fn.params.length;
  const got = argc ?? 0;
  if (got !== want) {
    accept(
      "error",
      argc === undefined && want > 0
        ? `policy function '${fn.name}' expects ${want} argument${want === 1 ? "" : "s"}; reference it as '${fn.name}(…)'.`
        : `policy function '${fn.name}' expects ${want} argument${want === 1 ? "" : "s"}, but ${got} ${got === 1 ? "was" : "were"} supplied.`,
      { node: ref, code: "loom.policy-fn-arity" },
    );
  }
}
