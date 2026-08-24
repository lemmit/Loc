// The DOMAIN-side naming rule for a provenanced field's lineage sibling on the
// Hono/TS backend.
//
// In memory and in storage the pair stays SPLIT — a typed value property plus a
// `<field>_provenance` jsonb column / `ProvLineage | null` getter (see
// `emit/aggregate.ts`, `emit/schema.ts`).  Only the WIRE folds them into the
// `Provenanced<T>` carrier, and the serializer that does the folding
// (`repository-wire-builder.ts`) has to name the sibling the declarer named it.
// One rule, one file, so the getter and its reader cannot drift.

/** `total` → `total_provenance`.  Works on a bare field name and on a member
 *  expression alike (`o.total` → `o.total_provenance`). */
export function tsProvSibling(valueNameOrExpr: string): string {
  return `${valueNameOrExpr}_provenance`;
}
