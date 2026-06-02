import type { ExprIR } from "../types/loom-ir.js";

// ---------------------------------------------------------------------------
// Pure ExprIR query shared by the backends that lower a
// `this.<refColl>.contains(x)` membership predicate to a join-table
// subquery (Hono/Drizzle, .NET/EF, Phoenix/Ash).
//
// Returns the field name behind a `this`-rooted single member access
// (the reference-collection field whose AssociationIR the caller then
// resolves), or null when the receiver isn't a bare `this.<field>` /
// `this-prop` ref.  Each backend keeps its own association lookup and
// emission; only this structural receiver-shape check is shared, since
// it was byte-identical in all three.
// ---------------------------------------------------------------------------

/** Field name behind a `this.<field>` receiver, or null if the receiver
 *  isn't a `this`-rooted single member access. */
export function refCollectionFieldName(e: ExprIR): string | null {
  if (e.kind === "paren") return refCollectionFieldName(e.inner);
  if (e.kind === "member" && e.receiver.kind === "this") return e.member;
  if (e.kind === "ref" && e.refKind === "this-prop") return e.name;
  return null;
}
