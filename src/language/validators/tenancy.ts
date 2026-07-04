// Tenancy declaration checks (multi-tenancy Phase 1a, slice 1a.3 —
// docs/plans/multi-tenancy-implementation.md §1) — the system-level
// `tenancy by user.<claim> of <Registry>` line.
//
// This file owns the single-document AST rules (mirrors `auth.ts`):
//   - at most one `tenancy by` per system (`loom.tenancy-duplicate`)
//
// Since 1b.1 the claim / registry bindings are real Langium
// cross-references, so their existence checks are the LINKER's job — an
// unknown user field or aggregate is a parse-level "Could not resolve
// reference …" diagnostic, not a themed validator code (the former
// `loom.tenancy-unknown-claim` / `loom.tenancy-registry-unknown`).
//
// The per-aggregate stance lint needs the merged multi-file IR, so it
// lives in `src/ir/validate/checks/tenancy-checks.ts` (phase ⑦).

import type { ValidationAcceptor } from "langium";
import { isTenancyDecl, type System } from "../generated/ast.js";

export function checkTenancyDecls(system: System, accept: ValidationAcceptor): void {
  const decls = system.members.filter(isTenancyDecl);
  if (decls.length === 0) return;

  // At most one `tenancy by` per system — flag the extras, keep the first.
  for (const extra of decls.slice(1)) {
    accept(
      "error",
      `system '${system.name}' declares more than one 'tenancy by' line; keep just the first.`,
      { node: extra, code: "loom.tenancy-duplicate" },
    );
  }
}
