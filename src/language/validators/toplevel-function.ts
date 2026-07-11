// Top-level (ambient) helper `function` checks (stdlib Phase B).
//
// A top-level function — declared at file root or inside a `system { }`,
// visible workspace-wide — INLINES its expression body at every call site
// during lowering (`inlineTopLevelFn`).  Two gates follow from that:
//
//   loom.function-toplevel-block — only the expression form (`= <expr>`) is
//       inlinable; a block-form (`{ … }`) top-level function has no emission
//       home yet (deferred), so it is rejected.
//   loom.function-recursive — inlining must terminate, so a top-level
//       function must not call itself directly or through a mutual cycle.
//
// (Recursion is legal for LOCAL aggregate/VO/workflow functions — those emit
// as real methods — so this gate scopes strictly to top-level functions.)

import { AstUtils, type ValidationAcceptor } from "langium";
import {
  type FunctionDecl,
  isFunctionDecl,
  isNameRef,
  isSystem,
  type Model,
} from "../generated/ast.js";
import { envForNode, isAssignable, resolveTypeRef, typeOf, typeToString } from "../type-system.js";
import { canPromoteLiteralTo } from "./_shared.js";

/** Top-level (file-root or system-level) FunctionDecls, name → decl.  First
 *  declaration wins on a name collision (the duplicate is a separate check). */
function topLevelFunctions(model: Model): Map<string, FunctionDecl> {
  const out = new Map<string, FunctionDecl>();
  const add = (m: { $type: string; name?: string }): void => {
    if (isFunctionDecl(m) && !out.has(m.name)) out.set(m.name, m);
  };
  for (const m of model.members) {
    add(m);
    if (isSystem(m)) for (const sm of m.members) add(sm);
  }
  return out;
}

export function checkTopLevelFunctions(model: Model, accept: ValidationAcceptor): void {
  const fns = topLevelFunctions(model);
  if (fns.size === 0) return;

  // (1) Block-form top-level functions have no emission home — reject.
  //     Expression-form: check the body types to the declared return (the
  //     `checkFunction` member check isn't dispatched at top level, and the
  //     call site trusts the DECLARED type, so a lying body must be caught here).
  for (const fn of fns.values()) {
    if (!fn.body) {
      accept(
        "error",
        `A top-level 'function' must be expression-form ('function ${fn.name}(…): T = <expr>'). ` +
          `Block-form top-level functions (a '{ … }' body) aren't supported yet — express it as a ` +
          `single expression, or make it a member of an aggregate / value object.`,
        { node: fn, property: "name", code: "loom.function-toplevel-block" },
      );
      continue;
    }
    const declared = resolveTypeRef(fn.returnType);
    const actual = typeOf(fn.body, envForNode(fn.body));
    if (
      declared.kind !== "unknown" &&
      actual.kind !== "unknown" &&
      !isAssignable(actual, declared) &&
      !canPromoteLiteralTo(fn.body, declared)
    ) {
      accept(
        "error",
        `Function '${fn.name}' returns '${typeToString(actual)}' but is declared to return '${typeToString(declared)}'.`,
        { node: fn, property: "body" },
      );
    }
  }

  // (2) Recursion (direct or mutual) makes inlining non-terminating — reject.
  // Build the call graph over top-level function names (self-calls included).
  const edges = new Map<string, Set<string>>();
  for (const [name, fn] of fns) {
    const callees = new Set<string>();
    if (fn.body) {
      for (const n of AstUtils.streamAllContents(fn.body)) {
        if (isNameRef(n) && fns.has(n.name)) callees.add(n.name);
      }
    }
    edges.set(name, callees);
  }
  const reaches = (from: string, target: string, seen: Set<string>): boolean => {
    for (const c of edges.get(from) ?? []) {
      if (c === target) return true;
      if (!seen.has(c)) {
        seen.add(c);
        if (reaches(c, target, seen)) return true;
      }
    }
    return false;
  };
  for (const [name, fn] of fns) {
    if (reaches(name, name, new Set())) {
      accept(
        "error",
        `Top-level 'function ${name}' is part of a recursion cycle. Expression-form functions ` +
          `inline at their call sites, so they must not call themselves — directly or through ` +
          `another top-level function that calls back.`,
        { node: fn, property: "name", code: "loom.function-recursive" },
      );
    }
  }
}
