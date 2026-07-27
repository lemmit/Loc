// Permission catalogue checks — the `implies` transitive-grant edges
// (authorization.md §6, M-T3.2 item 7).
//
//   - loom.permission-implies-unknown — an `implies` target names no permission
//     declared in the same subdomain's catalogue.  Implied targets are bare
//     `ID`s resolved BY NAME (like the `policy` target precedent), so an
//     unknown name is a controlled `loom.*` diagnostic here rather than a
//     Langium linker error.
//   - loom.permission-implies-self — a permission may not imply itself (a no-op
//     that reads as a mistake).
//
// A *cycle* across distinct permissions (`a implies b`, `b implies a`) is NOT
// rejected: it simply means the two grant each other, and the closure
// computation (`src/ir/util/permission-closure.ts`) is cycle-safe.

import { AstUtils, type ValidationAcceptor } from "langium";
import { isSubdomain, type Model } from "../generated/ast.js";

export function checkPermissionImplies(model: Model, accept: ValidationAcceptor): void {
  for (const sub of AstUtils.streamAllContents(model)) {
    if (!isSubdomain(sub)) continue;
    // The subdomain's full permission catalogue (across all its blocks).
    const declared = new Set<string>();
    for (const blk of sub.permissions ?? []) {
      for (const d of blk.decls) declared.add(d.name);
    }
    for (const blk of sub.permissions ?? []) {
      for (const d of blk.decls) {
        d.implies.forEach((target, i) => {
          if (target === d.name) {
            accept("error", `permission '${d.name}' cannot 'implies' itself.`, {
              node: d,
              property: "implies",
              index: i,
              code: "loom.permission-implies-self",
            });
            return;
          }
          if (!declared.has(target)) {
            accept(
              "error",
              `permission '${d.name}' implies '${target}', which is not a permission declared ` +
                `in subdomain '${sub.name}'. Declare it in a 'permissions { … }' block, or fix the name.`,
              { node: d, property: "implies", index: i, code: "loom.permission-implies-unknown" },
            );
          }
        });
      }
    }
  }
}
