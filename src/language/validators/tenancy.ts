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

import { AstUtils, type ValidationAcceptor } from "langium";
import { PRINCIPAL_ORG_PATH, PRINCIPAL_ROOT_ORG } from "../../util/principal.js";
import {
  isMemberSuffix,
  isNameRef,
  isPostfixChain,
  isTenancyDecl,
  type Model,
  type System,
} from "../generated/ast.js";

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

// ---------------------------------------------------------------------------
// `currentUser.orgPath` / `currentUser.rootOrg` require a tenancy declaration
// (multi-tenancy Phase 2, plans P2.1 / P2.5).  Both are derived materialized-
// path members — `orgPath` is resolved per-request from the tenant registry
// keyed by the tenancy claim, and `rootOrg` is its first segment — so without a
// `tenancy by user.<claim> of <Registry>` line there is no claim to resolve
// them from and nothing for the backend accessor to compute.  Referencing them
// there is fail-closed: a hard error (`loom.orgpath-without-tenancy`) rather
// than a silent principal member that resolves to nothing at runtime.
//
// The check is model-wide: a `tenancy by` line is a system member, and
// top-level deployment members fold into the single system, so "the model
// declares tenancy anywhere" is the correct gate for the single-system case
// (the only shape a `tenancy by` supports today) and stays fail-closed when
// tenancy is absent.
// ---------------------------------------------------------------------------

export function checkOrgPathReferences(model: Model, accept: ValidationAcceptor): void {
  let hasTenancy = false;
  for (const node of AstUtils.streamAllContents(model)) {
    if (isTenancyDecl(node)) {
      hasTenancy = true;
      break;
    }
  }
  if (hasTenancy) return;

  for (const node of AstUtils.streamAllContents(model)) {
    if (!isPostfixChain(node)) continue;
    const head = node.head;
    if (!isNameRef(head) || head.name !== "currentUser") continue;
    const first = node.suffixes[0];
    if (!first || !isMemberSuffix(first)) continue;
    if (first.member !== PRINCIPAL_ORG_PATH && first.member !== PRINCIPAL_ROOT_ORG) continue;
    accept(
      "error",
      `'currentUser.${first.member}' requires a 'tenancy by user.<claim> of <Registry>' ` +
        `declaration — it is derived from the caller's tenant materialized path, resolved from ` +
        `the tenancy claim and registry.  Add the tenancy line, or drop the '${first.member}' reference.`,
      { node: first, code: "loom.orgpath-without-tenancy" },
    );
  }
}
