// Macro-expansion diagnostic surfacing.  Two sources feed this check:
//
//   1. The one-shot expander side channel (unknown macro, bad arg shapes,
//      composition collisions) — recorded during the pre-link IndexedContent
//      pass and drained here.
//   2. A fresh, workspace-aware re-resolution of every `ref` / `refList`
//      argument (`collectUnresolvedMacroRefs`).  The expander stays silent
//      about unresolved refs because at expansion time sibling files may not
//      have loaded yet; re-checking here — on every (re)validation, against
//      the settled workspace — makes a cross-file `with scaffold(subdomains:
//      [...])` clear once its target file is indexed, while a genuinely
//      unknown ref keeps erroring.  Paired with the `isAffected` override in
//      `ddd-module.ts`, which re-validates macro-host docs on workspace change.

import { type AstNode, AstUtils, type ValidationAcceptor } from "langium";
import { collectUnresolvedMacroRefs, drainMacroDiagnostics } from "../../macros/expander.js";
import type { DddServices } from "../ddd-module.js";
import type { Model } from "../generated/ast.js";

export function checkMacroExpansion(
  model: Model,
  accept: ValidationAcceptor,
  services?: DddServices,
): void {
  const doc = AstUtils.getDocument(model);
  for (const d of drainMacroDiagnostics(doc)) {
    accept(d.severity, d.message, { node: d.node as AstNode, property: d.property });
  }
  collectUnresolvedMacroRefs(model, services?.shared, (d) => {
    accept(d.severity, d.message, { node: d.node as AstNode, property: d.property });
  });
}
