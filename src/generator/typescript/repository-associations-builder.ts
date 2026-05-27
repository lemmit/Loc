// Repository association (T id[]) helpers — the one piece both the
// find and save code paths legitimately share.
//
// `T id[]` reference collections persist as many-to-many join tables;
// the find path reads them via `<field>ByOwner` maps keyed by the
// owner id, the save path diff-syncs the same rows.  These three
// pure helpers describe the shared join-table shape.

import type { AssociationIR, EnrichedAggregateIR, TypeIR } from "../../ir/types/loom-ir.js";
import { joinColumnName, joinTableConstName } from "./emit.js";

/** Associations (`T id[]` reference collections) declared on an
 * aggregate, persisted as many-to-many join tables.  Empty when none. */
export function associationsOf(agg: EnrichedAggregateIR): AssociationIR[] {
  return agg.associations;
}

/** True for a field type that is a collection of references
 * (`T id[]`) — persisted via a join table, not a column. */
export function isRefCollection(t: TypeIR): boolean {
  return t.kind === "array" && t.element.kind === "id";
}

/** Bulk-load lines for every association into `<field>ByOwner`
 * maps keyed by the owner id.  Assumes a `rootIds: string[]` of owner
 * ids is in scope.  Used by the array-returning load paths
 * (`findManyByIds`, array `find`s); `findById` loads singular lists
 * inline instead. */
export function associationMapLines(
  agg: EnrichedAggregateIR,
  dbExpr: string,
  indent: string,
): string[] {
  return associationsOf(agg).flatMap((assoc) => {
    const joinConst = joinTableConstName(assoc);
    const ownerCol = joinColumnName(assoc.ownerFk);
    const targetCol = joinColumnName(assoc.targetFk);
    const rows = `${assoc.fieldName}JoinRows`;
    const map = `${assoc.fieldName}ByOwner`;
    return [
      `${indent}const ${rows} = await ${dbExpr}.select({ o: schema.${joinConst}.${ownerCol}, t: schema.${joinConst}.${targetCol} }).from(schema.${joinConst}).where(inArray(schema.${joinConst}.${ownerCol}, rootIds)).orderBy(schema.${joinConst}.${ownerCol}, schema.${joinConst}.ordinal);`,
      `${indent}const ${map} = new Map<string, Ids.${assoc.targetAgg}Id[]>();`,
      `${indent}for (const r of ${rows}) {`,
      `${indent}  const list = ${map}.get(r.o) ?? [];`,
      `${indent}  list.push(Ids.${assoc.targetAgg}Id(r.t));`,
      `${indent}  ${map}.set(r.o, list);`,
      `${indent}}`,
    ];
  });
}
