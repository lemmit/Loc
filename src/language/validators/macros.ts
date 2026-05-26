// Macro-expansion diagnostic surfacing.  The expander records its
// diagnostics into a per-document side channel during the pre-link
// pass; we drain them here so unknown macros, bad args, and
// composition collisions show up alongside other validator
// diagnostics rather than in a separate diagnostic pipeline.

import { type AstNode, AstUtils, type ValidationAcceptor } from "langium";
import { drainMacroDiagnostics } from "../ddd-macro-expander.js";
import type { Model } from "../generated/ast.js";

export function checkMacroExpansion(model: Model, accept: ValidationAcceptor): void {
  const doc = AstUtils.getDocument(model);
  const diagnostics = drainMacroDiagnostics(doc);
  for (const d of diagnostics) {
    accept(d.severity, d.message, { node: d.node as AstNode, property: d.property });
  }
}
