// -------------------------------------------------------------------------
// System-wide auth shape + `currentUser` scope, and `permissions {}`
// registration checks.  Split out of system-checks.ts by packet 2.6
// (wave-2) — mechanical move, no logic change.
// -------------------------------------------------------------------------

import { diagMessage } from "../../../diagnostics/messages.js";
import type { SystemIR } from "../../types/loom-ir.js";
import type { LoomDiagnostic } from "./diagnostic.js";

// ---------------------------------------------------------------------------
// Auth validation.
//
// Two responsibilities:
//
//   1. System-wide shape: a deployable opting in via `auth: required`
//      needs the system to declare a `user { ... }` block (otherwise
//      there's no shape for the verifier hook to decode tokens into).
//      Duplicate user-field names rejected here too, defensively —
//      the parser doesn't structurally enforce uniqueness.
//
//   2. `currentUser` scope: the magic identifier resolves to a typed
//      ref via `lower-expr.ts:resolveNameRef` whenever the system
//      declares a user block.  Bodies may USE `currentUser` in
//      operations / workflows / aggregate test bodies,
//      plus repository find where filters; everywhere else
//      (invariants, derived properties, function bodies) the reference
//      is rejected with a friendly message pointing at where it is
//      allowed.
// ---------------------------------------------------------------------------

export function validateAuth(sys: SystemIR, diags: LoomDiagnostic[]): void {
  // (1) Duplicate user-field names — Property doesn't structurally
  // enforce uniqueness, so a hand-rolled `user { id: string, id: int }`
  // would silently lower to two fields with the same name.
  if (sys.user) {
    const seen = new Set<string>();
    for (const f of sys.user.fields) {
      if (seen.has(f.name)) {
        diags.push({
          severity: "error",
          code: "loom.user-duplicate-field",
          message: diagMessage("loom.user-duplicate-field", { name: sys.name, fName: f.name }),
          source: `${sys.name}/user`,
        });
      }
      seen.add(f.name);
    }
  }
  // (2) `auth: required` deployables MUST have a user block.  Without
  // one, the verifier hook has no shape to populate, and `currentUser`
  // references in any body would resolve to an unknown ref.
  for (const d of sys.deployables) {
    if (d.auth?.required && !sys.user) {
      diags.push({
        severity: "error",
        code: "loom.auth-no-user-block",
        message: diagMessage("loom.auth-no-user-block", { name: d.name, sysName: sys.name }),
        source: `${sys.name}/${d.name}`,
      });
    }
  }
}

export function validatePermissions(sys: SystemIR, diags: LoomDiagnostic[]): void {
  for (const mod of sys.subdomains) {
    if (mod.permissions.length === 0) continue;
    const seen = new Set<string>();
    for (const p of mod.permissions) {
      if (seen.has(p.name)) {
        diags.push({
          severity: "error",
          code: "loom.duplicate-permission",
          message: diagMessage("loom.duplicate-permission", { name: mod.name, pName: p.name }),
          source: `${sys.name}/${mod.name}/permissions.${p.name}`,
        });
      }
      seen.add(p.name);
    }
  }
}
