// Repository save builder — write-side methods (saveMethod / saveTxBody)
// plus the project family (domain → row).
//
// Cleanly separated from find: per the dependency audit, project* is
// only ever called from save paths.  This file owns the save half;
// findById / findManyByIds / findQueryMethod live in
// repository-find-builder.ts.

import type {
  BoundedContextIR,
  EnrichedAggregateIR,
  EntityPartIR,
  FieldIR,
  TypeIR,
} from "../../ir/types/loom-ir.js";
import { discriminatorValue, tableOwnerName } from "../../ir/util/inheritance.js";
import { isValueCollectionType, valueCollectionsFor } from "../../ir/util/value-collections.js";
import { lines } from "../../util/code-builder.js";
import { lowerFirst, plural, upperFirst } from "../../util/naming.js";
import { renderHonoStoreLogCall } from "../_obs/render-hono.js";
import { aggregateIsAudited } from "./emit/audit-stamp.js";
import { joinColumnName, joinTableConstName } from "./emit.js";
import { associationsOf, isRefCollection } from "./repository-associations-builder.js";

/** Inner body of the save db.transaction callback at 6-space indent.
 *  Extracted so the trace-on variant can re-indent and wrap it with the
 *  outer try/catch + tx_* logs.  Also the seam where `child_synced`
 *  trace lines (--trace) are injected per child upsert. */
function saveTxBody(agg: EnrichedAggregateIR, ctx: BoundedContextIR, emitTrace: boolean): string[] {
  // Under TPH the upsert targets the shared base table; non-TPH aggregates
  // resolve to their own table (byte-identical output).
  const tableName = lowerFirst(plural(tableOwnerName(agg, ctx.aggregates)));
  const containBlocks = agg.contains.flatMap((c): string[] => {
    if (!c.collection) return [];
    const part = agg.parts.find((p) => p.name === c.partName);
    if (!part) return [];
    const childTable = lowerFirst(plural(part.name));
    const cap = upperFirst(c.name);
    return [
      "",
      `      const existing${cap} = await tx.select({ id: schema.${childTable}.id }).from(schema.${childTable}).where(eq(schema.${childTable}.parentId, aggregate.id));`,
      `      const existingIds${cap} = new Set(existing${cap}.map((r) => r.id));`,
      `      const currentIds${cap} = new Set(aggregate.${c.name}.map((e) => e.id as string));`,
      `      const toDelete${cap} = [...existingIds${cap}].filter((id) => !currentIds${cap}.has(id));`,
      `      if (toDelete${cap}.length > 0) {`,
      `        await tx.delete(schema.${childTable}).where(and(eq(schema.${childTable}.parentId, aggregate.id), inArray(schema.${childTable}.id, toDelete${cap})));`,
      `      }`,
      `      for (const child of aggregate.${c.name}) {`,
      `        const childRow = ${entityProjection(part, "child", ctx)};`,
      `        await tx.insert(schema.${childTable}).values(childRow).onConflictDoUpdate({ target: schema.${childTable}.id, set: childRow });`,
      // Classify against existingIds BEFORE the upsert tells us insert vs
      // update with no second DB round-trip; ordering matters for the
      // semantic (current existingIds reflects what was on disk, the
      // upsert is happening now).
      ...(emitTrace
        ? [
            `        const childAction = existingIds${cap}.has(child.id as string) ? "update" : "insert";`,
            `        ${renderHonoStoreLogCall("childSynced", `parent: "${agg.name}", part: "${part.name}", id: child.id as string, action: childAction`)}`,
          ]
        : []),
      `      }`,
    ];
  });
  // Diff-sync each reference collection's join table: delete pairs the
  // aggregate no longer holds, insert the new ones (idempotent via the
  // composite PK).  Set semantics — the wire contract for `Id<T>[]`
  // doesn't promise order — but we still write the ordinal column from
  // the field's index so it's something deterministic per backend.
  const assocBlocks = associationsOf(agg).flatMap((assoc) => {
    const joinConst = joinTableConstName(assoc);
    const ownerCol = joinColumnName(assoc.ownerFk);
    const targetCol = joinColumnName(assoc.targetFk);
    const cap = upperFirst(assoc.fieldName);
    return [
      "",
      `      const existing${cap} = await tx.select({ t: schema.${joinConst}.${targetCol} }).from(schema.${joinConst}).where(eq(schema.${joinConst}.${ownerCol}, aggregate.id));`,
      `      const existingIds${cap} = new Set(existing${cap}.map((r) => r.t));`,
      `      const current${cap} = aggregate.${assoc.fieldName}.map((x) => x as string);`,
      `      const currentIds${cap} = new Set(current${cap});`,
      `      const toDelete${cap} = [...existingIds${cap}].filter((t) => !currentIds${cap}.has(t));`,
      `      if (toDelete${cap}.length > 0) {`,
      `        await tx.delete(schema.${joinConst}).where(and(eq(schema.${joinConst}.${ownerCol}, aggregate.id), inArray(schema.${joinConst}.${targetCol}, toDelete${cap})));`,
      `      }`,
      `      for (let i = 0; i < current${cap}.length; i++) {`,
      `        const row = { ${ownerCol}: aggregate.id as string, ${targetCol}: current${cap}[i]!, ordinal: i };`,
      `        await tx.insert(schema.${joinConst}).values(row).onConflictDoUpdate({ target: [schema.${joinConst}.${ownerCol}, schema.${joinConst}.${targetCol}], set: { ordinal: i } });`,
      `      }`,
    ];
  });
  // Replace each value-object collection wholesale: the elements are
  // identity-less, so there is nothing to diff on.  Delete every child row
  // for this owner, then re-insert the current list with its ordinals.
  const valueCollectionBlocks = valueCollectionsFor(agg).flatMap((vc) => {
    const vo = ctx.valueObjects.find((v) => v.name === vc.voName);
    const voEntries = (vo?.fields ?? []).flatMap((vf) =>
      projectValueEntries(vf.name, vf.type, `e.${vf.name}`, ctx, vf.optional),
    );
    const rowFields = [
      `parentId: aggregate.id as string`,
      `ordinal: i`,
      ...voEntries.map((en) => `${en.fieldName}: ${en.expr}`),
    ].join(", ");
    return [
      "",
      `      await tx.delete(schema.${vc.tableConst}).where(eq(schema.${vc.tableConst}.parentId, aggregate.id));`,
      `      const ${vc.fieldName}List = aggregate.${vc.fieldName} ?? [];`,
      `      for (let i = 0; i < ${vc.fieldName}List.length; i++) {`,
      `        const e = ${vc.fieldName}List[i]!;`,
      `        await tx.insert(schema.${vc.tableConst}).values({ ${rowFields} });`,
      `      }`,
    ];
  });
  // Persist-time audit stamping (node-persist-time-auditing): an audited
  // aggregate's root upsert stamps createdAt/createdBy/updatedAt/updatedBy from
  // the ambient request principal at the save choke point — `stampInsert` on
  // the insert branch (all four), `stampUpdate` on the conflict branch (mutable
  // fields only, createdAt/createdBy preserved).  Domain + handler carry no
  // stamping.  A non-audited aggregate's upsert is byte-identical to before.
  const audited = aggregateIsAudited(agg);
  const insertValues = audited ? "stampInsert(rootRow)" : "rootRow";
  const updateSet = audited ? "stampUpdate(rootRow)" : "rootRow";
  return [
    `      const rootRow = ${rootProjection(agg, "aggregate", ctx)};`,
    `      await tx.insert(schema.${tableName}).values(${insertValues}).onConflictDoUpdate({ target: schema.${tableName}.id, set: ${updateSet} });`,
    ...containBlocks,
    ...assocBlocks,
    ...valueCollectionBlocks,
  ];
}

export function saveMethod(
  agg: EnrichedAggregateIR,
  ctx: BoundedContextIR,
  emitTrace = false,
): string {
  // Inner body of the save transaction at 6-space indent.  Built into a
  // local array so the trace-on variant can wrap it with try/catch +
  // tx_* logs without duplicating the body.
  const body = saveTxBody(agg, ctx, emitTrace);
  return lines(
    `  async save(aggregate: ${agg.name}): Promise<void> {`,
    emitTrace
      ? [
          `    ${renderHonoStoreLogCall("txBegin", `aggregate: "${agg.name}", id: aggregate.id as string`)}`,
          `    try {`,
          `      await this.db.transaction(async (tx) => {`,
          ...body.map((l) => `  ${l}`),
          `      });`,
          `      ${renderHonoStoreLogCall("txCommit", `aggregate: "${agg.name}", id: aggregate.id as string`)}`,
          `    } catch (txErr) {`,
          `      ${renderHonoStoreLogCall("txRollback", `aggregate: "${agg.name}", id: aggregate.id as string, error: txErr instanceof Error ? txErr.message : String(txErr)`)}`,
          `      throw txErr;`,
          `    }`,
        ]
      : [`    await this.db.transaction(async (tx) => {`, ...body, `    });`],
    `    ${renderHonoStoreLogCall("repositorySave", `aggregate: "${agg.name}", id: aggregate.id as string`)}`,
    "",
    `    for (const event of aggregate.pullEvents()) {`,
    // `(event as object).constructor.name` is the emitted DomainEvent
    // subclass name — reliable in TypeScript without depending on a
    // per-event `type` discriminator field.  The `as object` cast
    // handles the corner case where the aggregate declares no events:
    // pullEvents returns `DomainEvent[]` typed as `never[]`, so
    // `event.constructor` would fail tsc.  Field name is `event_type`
    // (not `event`) so it doesn't collide with the envelope's `event` key.
    `      ${renderHonoStoreLogCall("eventDispatched", `event_type: (event as object).constructor.name, aggregate: "${agg.name}", id: aggregate.id as string`)}`,
    `      await this.events.dispatch(event);`,
    `    }`,
    `  }`,
  );
}

function rootProjection(agg: EnrichedAggregateIR, varExpr: string, ctx: BoundedContextIR): string {
  // TPH: stamp the `kind` discriminator so the shared-table row records which
  // concrete it is (null for non-TPH aggregates → entry omitted).
  const kind = discriminatorValue(agg, ctx.aggregates);
  return projectionObject(varExpr, [
    { fieldName: "id", expr: `${varExpr}.id as string` },
    ...(kind ? [{ fieldName: "kind", expr: JSON.stringify(kind) }] : []),
    // Reference collections live in join tables, not on the root row.
    ...agg.fields
      .filter((f) => !isRefCollection(f.type) && !isValueCollectionType(f.type))
      .flatMap((f) => projectFieldEntries(f, varExpr, ctx)),
    ...provColumnEntries(agg.fields, varExpr),
  ]);
}

function entityProjection(part: EntityPartIR, varExpr: string, ctx: BoundedContextIR): string {
  return projectionObject(varExpr, [
    { fieldName: "id", expr: `${varExpr}.id as string` },
    { fieldName: "parentId", expr: `${varExpr}.parentId as string` },
    ...part.fields.flatMap((f) => projectFieldEntries(f, varExpr, ctx)),
    ...provColumnEntries(part.fields, varExpr),
  ]);
}

function provColumnEntries(
  fields: FieldIR[],
  varExpr: string,
): { fieldName: string; expr: string }[] {
  return fields
    .filter((f) => f.provenanced)
    .map((f) => ({ fieldName: `${f.name}_provenance`, expr: `${varExpr}.${f.name}_provenance` }));
}

export function projectFieldEntries(
  f: FieldIR,
  varExpr: string,
  ctx: BoundedContextIR,
): { fieldName: string; expr: string }[] {
  return projectValueEntries(f.name, f.type, `${varExpr}.${f.name}`, ctx, f.optional);
}

function projectValueEntries(
  fieldName: string,
  t: TypeIR,
  valueExpr: string,
  ctx: BoundedContextIR,
  optional: boolean,
): { fieldName: string; expr: string }[] {
  if (t.kind === "optional") {
    return projectValueEntries(fieldName, t.inner, valueExpr, ctx, true);
  }
  if (t.kind === "primitive") {
    if (t.name === "decimal") {
      return [{ fieldName, expr: `String(${valueExpr})` }];
    }
    if (t.name === "money") {
      // Persist as a precise-decimal string — decimal.js's `.toString()`
      // returns the canonical form `numeric(19, 4)` accepts.
      return [{ fieldName, expr: `${valueExpr}.toString()` }];
    }
    return [{ fieldName, expr: valueExpr }];
  }
  if (t.kind === "id") {
    return [{ fieldName, expr: `${valueExpr} as string` }];
  }
  if (t.kind === "enum") {
    return [{ fieldName, expr: valueExpr }];
  }
  if (t.kind === "valueobject") {
    const vo = ctx.valueObjects.find((v) => v.name === t.name);
    if (!vo) return [{ fieldName, expr: valueExpr }];
    return vo.fields.flatMap((vf) => {
      const sub = `${valueExpr}.${vf.name}`;
      return projectValueEntries(`${fieldName}_${vf.name}`, vf.type, sub, ctx, optional);
    });
  }
  return [{ fieldName, expr: valueExpr }];
}

export function projectionObject(
  _varExpr: string,
  entries: { fieldName: string; expr: string }[],
): string {
  return `{ ${entries.map((e) => `${e.fieldName}: ${e.expr}`).join(", ")} }`;
}
