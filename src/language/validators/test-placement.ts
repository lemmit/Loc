// Placement rules for the unit / integration `test` block (test-placement.md).
//
// A `test` resolves its home subject — an aggregate (Phase 1), a value object /
// domain service (Phase 2), or a bounded context (Phase 3, the integration rung)
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

/** True when a `platform: node` deployable in the model hosts this context — the
 *  node backend emits a runnable integration test for it (Phase 3a), so the
 *  `loom.context-test-unsupported` warning is suppressed.  Other backends don't
 *  emit yet, so a context hosted only on them still warns. */
function nodeHostsContext(model: Model, ctx: BoundedContext): boolean {
  for (const node of AstUtils.streamAllContents(model)) {
    if (isDeployable(node) && node.platform === "node") {
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
        `A nested 'test' already belongs to its enclosing subject — drop the ` +
          `'for ${node.target.$refText}' head (name a subject with 'for' only when ` +
          `the test is hoisted out of it).`,
        { node, property: "target", code: "loom.test-redundant-for" },
      );
    } else if (inContext && target === c) {
      accept(
        "error",
        `A 'test' nested in context '${c.name}' already targets it — drop the ` +
          `'for ${node.target?.$refText}' head.`,
        { node, property: "target", code: "loom.test-redundant-for" },
      );
    } else if (!inSubjectDecl && !inContext && !node.target) {
      accept(
        "error",
        `A 'test' declared outside its subject must name it: ` +
          `\`test ${JSON.stringify(node.name)} for <Subject> { … }\`.`,
        { node, property: "name", code: "loom.test-needs-target" },
      );
    }

    // Honest gate: a context integration test emits ONLY on the node backend so
    // far (Phase 3a). Warn when the target context is not hosted by a node
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
    if (ctxNode && !nodeHostsContext(model, ctxNode)) {
      accept(
        "warning",
        `Context integration tests currently emit on the node backend only ` +
          `(test-placement.md Phase 3a). Context '${ctxNode.name}' is not hosted by a ` +
          `'platform: node' deployable, so this 'test' produces no runnable test yet.`,
        { node, property: "name", code: "loom.context-test-unsupported" },
      );
    }
  }
}
