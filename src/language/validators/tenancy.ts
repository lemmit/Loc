// Tenancy declaration checks (multi-tenancy Phase 1a, slice 1a.3 —
// docs/plans/multi-tenancy-implementation.md §1) — the system-level
// `tenancy by user.<claim> of <Registry>` line.
//
// This file owns the single-document AST rules (mirrors `auth.ts`):
//   - at most one `tenancy by` per system (`loom.tenancy-duplicate`)
//   - the `user.<claim>` field must exist on the system's `user { … }`
//     block (`loom.tenancy-unknown-claim` — the tenancy twin of
//     `loom.auth-unknown-claim-field`; a missing user block gets the
//     same code, since the fix is the same: declare the claim field)
//
// Registry existence and the per-aggregate stance lint need the merged
// multi-file IR, so they live in
// `src/ir/validate/checks/tenancy-checks.ts` (phase ⑦).

import type { ValidationAcceptor } from "langium";
import { isTenancyDecl, isUserBlock, type System } from "../generated/ast.js";

export function checkTenancyDecls(system: System, accept: ValidationAcceptor): void {
  const decls = system.members.filter(isTenancyDecl);
  if (decls.length === 0) return;

  // 1. At most one `tenancy by` per system — flag the extras, keep the first.
  for (const extra of decls.slice(1)) {
    accept(
      "error",
      `system '${system.name}' declares more than one 'tenancy by' line; keep just the first.`,
      { node: extra, code: "loom.tenancy-duplicate" },
    );
  }

  // 2. The claim must be a declared `user { … }` field — the tenancy filter
  //    scopes reads by this claim on the request principal, so without it
  //    there is nothing to partition by.
  const userBlock = system.members.find(isUserBlock);
  const userFields = new Set(userBlock?.fields.map((f) => f.name) ?? []);
  for (const decl of decls) {
    // A parse-errored declaration (e.g. the claim slot failed to lex) leaves
    // `claim` unset — the parser already reported it; don't cascade a
    // confusing "unknown user field 'undefined'" on top.
    if (!decl.claim) continue;
    if (!userBlock) {
      accept(
        "error",
        `'tenancy by user.${decl.claim}' requires a \`user { … }\` block declaring field '${decl.claim}'.`,
        { node: decl, property: "claim", code: "loom.tenancy-unknown-claim" },
      );
    } else if (!userFields.has(decl.claim)) {
      accept(
        "error",
        `tenancy claim targets unknown user field '${decl.claim}'.  Declare it in the \`user { … }\` block.`,
        { node: decl, property: "claim", code: "loom.tenancy-unknown-claim" },
      );
    }
  }
}
