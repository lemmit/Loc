// Placement rules for the unit `test` block (test-placement.md).
//
// A `test` resolves its home subject — an aggregate (Phase 1) or a value object
// / domain service (Phase 2) — from the `for <Subject>` head if present, else
// from its enclosing declaration.  That yields exactly two structural rules,
// enforced here rather than in the grammar so a misplaced test surfaces a
// themed, actionable diagnostic instead of a parse error:
//
//   - HOISTED (declared at `context` or file-root scope — `$container` is not a
//     subject declaration) → `for` is REQUIRED: there is no enclosing subject to
//     infer from (`loom.test-needs-target`).
//   - NESTED (a member of an aggregate / value object / domain service) → `for`
//     is FORBIDDEN: containment already names the subject, and a restated `for`
//     is a second, redundant way to say the same thing (`loom.test-redundant-for`).
//
// The third proposed code, `loom.test-bad-target` (a `for` naming something that
// isn't a testable subject), needs no themed check: `target` is a typed
// `[TestSubject:ID]` cross-reference, so an unknown name or a non-subject target
// is already a linker error — the same stance `TenancyDecl`/`Repository` take on
// their aggregate refs.

import { AstUtils, type ValidationAcceptor } from "langium";
import {
  isAggregate,
  isDomainService,
  isTestBlock,
  isValueObject,
  type Model,
} from "../generated/ast.js";

export function checkTestPlacement(model: Model, accept: ValidationAcceptor): void {
  for (const node of AstUtils.streamAllContents(model)) {
    if (!isTestBlock(node)) continue;
    const c = node.$container;
    // NESTED = a member of its subject declaration (aggregate / value object /
    // domain service); anything else (context / file root) is HOISTED.
    const nested = isAggregate(c) || isValueObject(c) || isDomainService(c);
    if (nested && node.target) {
      accept(
        "error",
        `A nested 'test' already belongs to its enclosing subject — drop the ` +
          `'for ${node.target.$refText}' head (name a subject with 'for' only when ` +
          `the test is hoisted out of it).`,
        { node, property: "target", code: "loom.test-redundant-for" },
      );
    } else if (!nested && !node.target) {
      accept(
        "error",
        `A 'test' declared outside its subject must name it: ` +
          `\`test ${JSON.stringify(node.name)} for <Subject> { … }\`.`,
        { node, property: "name", code: "loom.test-needs-target" },
      );
    }
  }
}
