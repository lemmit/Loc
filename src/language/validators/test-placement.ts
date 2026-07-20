// Placement rules for the unit `test` block (test-placement.md, Phase 1).
//
// A `test` resolves its home subject from the `for <Aggregate>` head if present,
// else from its enclosing declaration.  That yields exactly two structural
// rules, enforced here rather than in the grammar so a misplaced test surfaces
// a themed, actionable diagnostic instead of a parse error:
//
//   - HOISTED (declared at `context` or file-root scope — `$container` is not an
//     aggregate) → `for` is REQUIRED: there is no enclosing subject to infer
//     from (`loom.test-needs-target`).
//   - NESTED (an aggregate member) → `for` is FORBIDDEN: containment already
//     names the subject, and a restated `for` is a second, redundant way to say
//     the same thing (`loom.test-redundant-for`).
//
// The third proposed code, `loom.test-bad-target` (a `for` naming something that
// isn't a testable aggregate), needs no themed check: `target` is a typed
// `[Aggregate:ID]` cross-reference, so an unknown name or a non-aggregate target
// is already a linker error — the same stance `TenancyDecl`/`Repository` take on
// their aggregate refs.

import { AstUtils, type ValidationAcceptor } from "langium";
import { isAggregate, isTestBlock, type Model } from "../generated/ast.js";

export function checkTestPlacement(model: Model, accept: ValidationAcceptor): void {
  for (const node of AstUtils.streamAllContents(model)) {
    if (!isTestBlock(node)) continue;
    const nested = isAggregate(node.$container);
    if (nested && node.target) {
      accept(
        "error",
        `A nested 'test' already belongs to its enclosing aggregate — drop the ` +
          `'for ${node.target.$refText}' head (name a subject with 'for' only when ` +
          `the test is hoisted out of the aggregate).`,
        { node, property: "target", code: "loom.test-redundant-for" },
      );
    } else if (!nested && !node.target) {
      accept(
        "error",
        `A 'test' declared outside an aggregate must name its subject: ` +
          `\`test ${JSON.stringify(node.name)} for <Aggregate> { … }\`.`,
        { node, property: "name", code: "loom.test-needs-target" },
      );
    }
  }
}
