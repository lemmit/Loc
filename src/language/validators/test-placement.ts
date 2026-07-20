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
  isAggregate,
  isBoundedContext,
  isDomainService,
  isTestBlock,
  isValueObject,
  type Model,
} from "../generated/ast.js";

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

    // Honest gate: a context integration test (nested in a context with no `for`,
    // or `for <Context>`) has no backend emitter yet.
    const isContextTest =
      (inContext && (!target || target === c)) || (target != null && isBoundedContext(target));
    if (isContextTest) {
      accept(
        "warning",
        `Context integration tests (test-placement.md Phase 3) are not yet emitted ` +
          `by any backend — this 'test' parses and validates but produces no runnable ` +
          `test until the integration renderer lands.`,
        { node, property: "name", code: "loom.context-test-unsupported" },
      );
    }
  }
}
