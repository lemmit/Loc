// Repository `find` checks (read-path-architecture.md, migration slice 6).
//
//   - loom.repository-find-deprecated — a wire-shaped LIST `find` on a
//     repository (a bespoke list query returning `T[]` or `T paged`) is
//     deprecated in favour of criterion-driven reads: pass a `criterion` to
//     `run` (`Repo.run(<Criterion>(args))`) or name a `retrieval`.  This
//     kills the "repository-with-40-finders" smell — every distinct list
//     query stops minting a `find byX` method.  A **unique-key
//     reconstitution** find (returning a single `T` / `T?` by identity) is
//     NOT a list query and stays legal (proposal Open Q4).  A WARNING, not an
//     error: existing `.ddd` keeps parsing.
//
// This is an AST-level check over author-declared `FindDecl` nodes, so the
// compiler-SYNTHESIZED finds (the auto-`findAll`, and scaffoldPaged's paged
// `findAllBy<Criterion>` — both minted in enrich, never in source) are
// naturally exempt: they don't exist at this layer.

import { AstUtils, type ValidationAcceptor } from "langium";
import { type FindDecl, isFindDecl, isProjection, type Model } from "../generated/ast.js";
import { envForNode, typeOf, typeToString } from "../type-system.js";

/** A read-path `requires <expr>` authorization gate must type to bool, exactly
 *  like the operation / workflow `requires` clause (`statements.ts` /
 *  `structural.ts`).  Without this a non-bool gate (`requires 42`) lowered to
 *  an always-truthy no-op that silently never fired.  Now that `currentUser`
 *  types precisely (`type-system.ts`), a bare
 *  `requires currentUser.permissions.contains(permissions.x)` gate passes. */
function checkGateIsBool(
  gate: FindDecl["gate"],
  node: FindDecl | import("../generated/ast.js").Projection,
  accept: ValidationAcceptor,
): void {
  if (!gate) return;
  const gt = typeOf(gate, envForNode(gate));
  if (gt.kind !== "primitive" || gt.name !== "bool") {
    accept("error", `'requires' must be of type 'bool', got '${typeToString(gt)}'.`, {
      node,
      property: "gate",
    });
  }
}

/** A find whose return type is a COLLECTION — an array (`T[]`) or the `paged`
 *  list carrier (`T paged`).  These are list queries; a single (`T`) or
 *  optional-single (`T?`) return is reconstitution, not a list. */
function returnsCollection(find: FindDecl): boolean {
  const rt = find.returnType;
  if (!rt) return false;
  return rt.array === true || rt.ctors.includes("paged");
}

export function checkRepositoryFinds(model: Model, accept: ValidationAcceptor): void {
  for (const node of AstUtils.streamAllContents(model)) {
    // Read-path `requires` gate bool check — the find and query-time projection
    // (the "view" successor) gates, the read-side twins of the operation gate.
    if (isProjection(node)) {
      checkGateIsBool(node.gate, node, accept);
      continue;
    }
    if (!isFindDecl(node)) continue;
    checkGateIsBool(node.gate, node, accept);
    if (!returnsCollection(node)) continue;
    accept(
      "warning",
      `repository find '${node.name}' is a wire-shaped list query — pass a criterion to ` +
        `'run' (Repo.run(<Criterion>(args))) or name a 'retrieval' instead of accreting a ` +
        `bespoke list finder on the repository. (A unique-key reconstitution find returning a ` +
        `single 'T' / 'T?' stays fine.)`,
      { node, property: "name", code: "loom.repository-find-deprecated" },
    );
  }
}
