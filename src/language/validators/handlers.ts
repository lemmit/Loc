// Application-layer handler checks — the `extern` ↔ body pairing on
// `commandHandler` / `queryHandler` context members
// (unfoldable-api-derivation.md, Layer 3; extern-handler Phase 1).
//
// The grammar admits BOTH a braced body (`{ … }`) and a bodyless `;` for either
// prefix, so the validator enforces the pairing (mirror of the `extern`
// component gate in `ui.ts`, `loom.extern-component-has-body`):
//
//   loom.extern-handler-has-body — an `extern` handler is bodyless by
//       definition (its impl is a scaffold-once user file the generated
//       dispatch calls), so a `{ body }` is a contradiction — write `;`.
//   loom.handler-missing-body — a non-extern handler runs a DSL body, so a
//       bodyless `;` has nothing to emit — write `{ … }`, or mark it `extern`.
//
// (The layering contracts — a queryHandler must not save, a commandHandler
// touches one aggregate — need the resolved IR and live in the phase-⑦
// `api-checks.ts`; these two are purely structural and gate at the AST side.)

import { AstUtils, type ValidationAcceptor } from "langium";
import {
  type CommandHandler,
  isCommandHandler,
  isQueryHandler,
  type Model,
  type QueryHandler,
} from "../generated/ast.js";

/** True when a handler carries a braced `{ … }` body (vs. the bodyless `;`).  A
 *  non-empty `body` is unambiguously braced; for an EMPTY body — `{ }` and `;`
 *  both leave `body` empty — the discriminator is the node's trailing CST
 *  terminal (`}` vs `;`), the only place the two forms differ. */
function hasBracedBody(node: CommandHandler | QueryHandler): boolean {
  if (node.body.length > 0) return true;
  const text = (node.$cstNode?.text ?? "").trimEnd();
  return text.endsWith("}");
}

/** Enforce the `extern` ↔ body pairing on every `commandHandler` /
 *  `queryHandler` in the model (both context-member kinds share the rule). */
export function checkHandlerBodies(model: Model, accept: ValidationAcceptor): void {
  for (const node of AstUtils.streamAllContents(model)) {
    if (!isCommandHandler(node) && !isQueryHandler(node)) continue;
    const kind = isCommandHandler(node) ? "commandHandler" : "queryHandler";
    const braced = hasBracedBody(node);
    if (node.extern && braced) {
      accept(
        "error",
        `extern ${kind} '${node.name}' must be bodyless — its implementation is a ` +
          `scaffold-once, user-owned file the generated dispatch calls, not a DSL body. ` +
          `End the declaration with ';', or drop 'extern' to make it a normal handler.`,
        { node, property: "name", code: "loom.extern-handler-has-body" },
      );
    } else if (!node.extern && !braced) {
      accept(
        "error",
        `${kind} '${node.name}' requires a '{ … }' body. Mark it 'extern' (and end with ';') ` +
          `to hand the implementation to a scaffold-once user-owned file.`,
        { node, property: "name", code: "loom.handler-missing-body" },
      );
    }
  }
}
