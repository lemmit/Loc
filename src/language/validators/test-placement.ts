// Placement rules for the unit / integration `test` block (test-placement.md).
//
// A `test` resolves its home subject — an aggregate, a value object /
// domain service, or a bounded context (Phase 3, the integration rung)
// — from the `for <Subject>` head if present, else from its enclosing
// declaration.  The structural rules, enforced here so a misplaced test surfaces
// a themed diagnostic instead of a parse error:
//
//   - Nested in a SUBJECT decl (aggregate / value object / domain service):
//     containment fixes the subject, so any `for` is redundant
//     (`loom.test-redundant-for`).
//   - Nested in a `context`: no `for` → a context integration test (subject = the
//     enclosing context); `for <Agg|VO|Service>` → a legit hoisted subject test;
//     `for <that same context>` → redundant (`loom.test-redundant-for`).
//   - At file root (no enclosing subject): `for` is REQUIRED
//     (`loom.test-needs-target`).
//
// A `for` naming a non-testable / unknown target is already a linker error (the
// typed `[TestSubject:ID]` cross-reference), so there is no themed `bad-target`.
//
// Context integration tests are not yet emitted by any backend, so a
// `loom.context-test-unsupported` WARNING is raised until the Phase-3a
// integration renderer lands (removed / made backend-conditional then).

import { AstUtils, type ValidationAcceptor } from "langium";
import { diagMessage } from "../../diagnostics/messages.js";
import {
  type BoundedContext,
  isAggregate,
  isBoundedContext,
  isDeployable,
  isDomainService,
  isTestBlock,
  isValueObject,
  type Model,
} from "../generated/ast.js";

// Backends whose integration renderer has landed (test-placement.md Phase 3a/3b)
// — a context hosted by any of these emits a runnable integration test, so the
// `loom.context-test-unsupported` warning is suppressed.  Grows as each backend
// lands; a context hosted ONLY on a not-yet-shipped backend still warns.
const INTEGRATION_BACKENDS = new Set(["node", "python", "dotnet", "java", "elixir"]);

/** True when a deployable running an integration-capable backend hosts this
 *  context. */
function integrationBackendHostsContext(model: Model, ctx: BoundedContext): boolean {
  for (const node of AstUtils.streamAllContents(model)) {
    if (isDeployable(node) && INTEGRATION_BACKENDS.has(node.platform)) {
      if (node.contextRefs.some((r) => r.ref === ctx)) return true;
    }
  }
  return false;
}

export function checkTestPlacement(model: Model, accept: ValidationAcceptor): void {
  for (const node of AstUtils.streamAllContents(model)) {
    if (!isTestBlock(node)) continue;
    const c = node.$container;
    const inSubjectDecl = isAggregate(c) || isValueObject(c) || isDomainService(c);
    const inContext = isBoundedContext(c);
    const target = node.target?.ref;

    if (inSubjectDecl && node.target) {
      accept(
        "error",
        diagMessage("loom.test-redundant-for#a-nested-test-already-belongs", {
          $refText: node.target.$refText,
        }),
        { node, property: "target", code: "loom.test-redundant-for" },
      );
    } else if (inContext && target === c) {
      accept(
        "error",
        diagMessage("loom.test-redundant-for#a-test-nested-in-context", {
          name: c.name,
          $refText: node.target?.$refText,
        }),
        { node, property: "target", code: "loom.test-redundant-for" },
      );
    } else if (!inSubjectDecl && !inContext && !node.target) {
      accept("error", diagMessage("loom.test-needs-target", { name: JSON.stringify(node.name) }), {
        node,
        property: "name",
        code: "loom.test-needs-target",
      });
    }

    // Honest gate: a context integration test emits ONLY on the node backend so
    // far. Warn when the target context is not hosted by a node
    // deployable — the other backends' integration renderers are still pending.
    // A context test targets a context: `for <Ctx>`, or nested in a context with
    // no `for` (or `for` restating that context).  A context-nested `for <Agg>`
    // is a hoisted AGGREGATE test, not a context test.
    const ctxNode: BoundedContext | undefined =
      target != null && isBoundedContext(target)
        ? target // `for <Ctx>` (a `for <that ctx>` restatement lands here too)
        : inContext && !target
          ? (c as BoundedContext) // nested in a context with no `for`
          : undefined;
    if (ctxNode && !integrationBackendHostsContext(model, ctxNode)) {
      accept("warning", diagMessage("loom.context-test-unsupported", { name: ctxNode.name }), {
        node,
        property: "name",
        code: "loom.context-test-unsupported",
      });
    }
  }
}
