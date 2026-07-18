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
import { aggregateIsVersioned } from "../../ir/util/versioned-capability.js";
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
  // Diff-sync one containment level and RECURSE into each part's own nested
  // containments.  `ownerExpr`/`ownerIdExpr` are the domain object holding this
  // collection and its id — child rows are reconciled against the DB rows whose
  // direct-parent FK (the Drizzle `.parentId`, mapped to `<direct-parent>_id`)
  // equals it.  A SINGLE containment is treated as a 0-or-1 list (was dropped
  // entirely before).  Depth-0 collection output is byte-identical: `ownerExpr`
  // = `aggregate`, `itemsRef` = `aggregate.<name>`, loop var `child`, 6-space
  // indent; nested levels uniquify the loop/row vars and indent inward.
  const syncContain = (
    c: (typeof agg.contains)[number],
    ownerExpr: string,
    ownerIdExpr: string,
    indent: string,
    depth: number,
  ): string[] => {
    const part = agg.parts.find((p) => p.name === c.partName);
    if (!part) return [];
    const childTable = lowerFirst(plural(part.name));
    const cap = upperFirst(c.name);
    const loopVar = depth === 0 ? "child" : `child${depth}`;
    const rowVar = depth === 0 ? "childRow" : `childRow${depth}`;
    // A collection is already an array; a single containment becomes a 0-or-1
    // list so the same diff-sync (insert new / update existing / delete removed)
    // applies uniformly.
    const itemsRef = c.collection
      ? `${ownerExpr}.${c.name}`
      : `(${ownerExpr}.${c.name} ? [${ownerExpr}.${c.name}] : [])`;
    const body = `${indent}  `;
    return [
      "",
      `${indent}const existing${cap} = await tx.select({ id: schema.${childTable}.id }).from(schema.${childTable}).where(eq(schema.${childTable}.parentId, ${ownerIdExpr}));`,
      `${indent}const existingIds${cap} = new Set(existing${cap}.map((r) => r.id));`,
      `${indent}const currentIds${cap} = new Set(${itemsRef}.map((e) => e.id as string));`,
      `${indent}const toDelete${cap} = [...existingIds${cap}].filter((id) => !currentIds${cap}.has(id));`,
      `${indent}if (toDelete${cap}.length > 0) {`,
      `${indent}  await tx.delete(schema.${childTable}).where(and(eq(schema.${childTable}.parentId, ${ownerIdExpr}), inArray(schema.${childTable}.id, toDelete${cap})));`,
      `${indent}}`,
      `${indent}for (const ${loopVar} of ${itemsRef}) {`,
      `${body}const ${rowVar} = ${entityProjection(part, loopVar, ctx, depth > 0 ? ownerIdExpr : undefined)};`,
      `${body}await tx.insert(schema.${childTable}).values(${rowVar}).onConflictDoUpdate({ target: schema.${childTable}.id, set: ${rowVar} });`,
      // Classify against existingIds BEFORE the upsert tells us insert vs
      // update with no second DB round-trip; ordering matters for the
      // semantic (current existingIds reflects what was on disk, the
      // upsert is happening now).
      ...(emitTrace
        ? [
            `${body}const childAction = existingIds${cap}.has(${loopVar}.id as string) ? "update" : "insert";`,
            `${body}${renderHonoStoreLogCall("childSynced", `parent: "${agg.name}", part: "${part.name}", id: ${loopVar}.id as string, action: childAction`)}`,
          ]
        : []),
      // Recurse: this part's OWN nested containments, keyed by this child's id.
      ...part.contains.flatMap((nested) =>
        syncContain(nested, loopVar, `${loopVar}.id`, body, depth + 1),
      ),
      `${indent}}`,
    ];
  };
  const containBlocks = agg.contains.flatMap((c) =>
    syncContain(c, "aggregate", "aggregate.id", "      ", 0),
  );
  // Diff-sync each reference collection's join table: delete pairs the
  // aggregate no longer holds, insert the new ones (idempotent via the
  // composite PK).  Set semantics — the wire contract for `Id<T>[]` is a
  // set (membership only, no order), so the join row carries no payload:
  // the composite PK is the whole row.  Deterministic read-back order is a
  // read-time projection (ORDER BY the target FK id), not a stored column.
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
      `      for (const t of current${cap}) {`,
      `        const row = { ${ownerCol}: aggregate.id as string, ${targetCol}: t };`,
      `        await tx.insert(schema.${joinConst}).values(row).onConflictDoNothing({ target: [schema.${joinConst}.${ownerCol}, schema.${joinConst}.${targetCol}] });`,
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

  // Optimistic concurrency (`versioned` capability, versioned-capability.ts):
  // the unconditional `insert...onConflictDoUpdate` upsert becomes a guarded
  // write.  No existing row → plain insert seeding `version: 1` (a fresh
  // aggregate can't conflict).  An existing row → an UPDATE conditioned on
  // the *expected* version — the caller's `expectedVersion` argument (the
  // route thread it from an `If-Match` header on the versioned `update` op;
  // see routes-builder) falling back to the just-loaded `aggregate.version`
  // (write-time CAS) when the caller doesn't pass one, so every mutate path
  // stays a coherent guarded write, not just `update`.  Zero rows affected
  // means another request won the race in between — `ConcurrencyError`,
  // mapped to 409 by the shared `onError` arm.
  if (aggregateIsVersioned(agg)) {
    const baseEntries = rootEntries(agg, "aggregate", ctx, new Set(["version"]));
    const insertRow = projectionObject("aggregate", [
      ...baseEntries,
      { fieldName: "version", expr: "1" },
    ]);
    const updateRow = projectionObject("aggregate", [
      ...baseEntries,
      { fieldName: "version", expr: "expected + 1" },
    ]);
    const insertValues = audited ? `stampInsert(${insertRow})` : insertRow;
    const updateSet = audited ? `stampUpdate(${updateRow})` : updateRow;
    return [
      `      const expected = expectedVersion ?? aggregate.version;`,
      `      const existingRow = await tx.select({ id: schema.${tableName}.id }).from(schema.${tableName}).where(eq(schema.${tableName}.id, aggregate.id));`,
      `      if (existingRow.length === 0) {`,
      `        await tx.insert(schema.${tableName}).values(${insertValues});`,
      `      } else {`,
      `        const updated = await tx.update(schema.${tableName}).set(${updateSet}).where(and(eq(schema.${tableName}.id, aggregate.id), eq(schema.${tableName}.version, expected))).returning({ id: schema.${tableName}.id });`,
      `        if (updated.length === 0) throw new ConcurrencyError("${agg.name}", aggregate.id as string);`,
      `      }`,
      ...containBlocks,
      ...assocBlocks,
      ...valueCollectionBlocks,
    ];
  }

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
  // A versioned aggregate's save accepts the client's expected version
  // (threaded from the route's `If-Match` header) as an optional second
  // arg — optional so every other mutate route, which only ever loaded
  // and mutated `aggregate` itself, can keep calling `repo.save(aggregate)`
  // and still get a guarded write (the tx body falls back to
  // `aggregate.version`).  A non-versioned aggregate's signature is
  // byte-identical to before.
  const saveSig = aggregateIsVersioned(agg)
    ? `  async save(aggregate: ${agg.name}, expectedVersion?: number): Promise<void> {`
    : `  async save(aggregate: ${agg.name}): Promise<void> {`;
  return lines(
    saveSig,
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

/** The root row's projection entries — factored out of {@link rootProjection}
 *  so the `versioned` guarded write (above) can build INSERT/UPDATE variants
 *  that omit the synthetic `version` field and supply it explicitly per
 *  branch, while sharing every other field's projection logic verbatim. */
function rootEntries(
  agg: EnrichedAggregateIR,
  varExpr: string,
  ctx: BoundedContextIR,
  omit: ReadonlySet<string> = new Set(),
): { fieldName: string; expr: string }[] {
  // TPH: stamp the `kind` discriminator so the shared-table row records which
  // concrete it is (null for non-TPH aggregates → entry omitted).
  const kind = discriminatorValue(agg, ctx.aggregates);
  return [
    { fieldName: "id", expr: `${varExpr}.id as string` },
    ...(kind ? [{ fieldName: "kind", expr: JSON.stringify(kind) }] : []),
    // Reference collections live in join tables, not on the root row.
    ...agg.fields
      .filter(
        (f) => !isRefCollection(f.type) && !isValueCollectionType(f.type) && !omit.has(f.name),
      )
      .flatMap((f) => projectFieldEntries(f, varExpr, ctx)),
    ...provColumnEntries(agg.fields, varExpr),
  ];
}

function rootProjection(agg: EnrichedAggregateIR, varExpr: string, ctx: BoundedContextIR): string {
  return projectionObject(varExpr, rootEntries(agg, varExpr, ctx));
}

function entityProjection(
  part: EntityPartIR,
  varExpr: string,
  ctx: BoundedContextIR,
  /** FK value for the part row.  Defaults to the part's own `parentId` (a
   *  root-level part carries its correct root parent).  A NESTED part is stamped
   *  from TREE POSITION instead — the enclosing parent's id in scope — because a
   *  nested part's construction-time parentId isn't reliable (a `new Label`
   *  inside `new Shipment` has no shipment id yet). */
  parentIdExpr?: string,
): string {
  return projectionObject(varExpr, [
    { fieldName: "id", expr: `${varExpr}.id as string` },
    { fieldName: "parentId", expr: parentIdExpr ?? `${varExpr}.parentId as string` },
    ...part.fields.flatMap((f) => projectFieldEntries(f, varExpr, ctx)),
    ...provColumnEntries(part.fields, varExpr),
  ]);
}

export function provColumnEntries(
  fields: readonly FieldIR[],
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
      // An optional decimal is `number | null` on the domain object —
      // `String(null)` would persist the literal string "null".
      return [
        {
          fieldName,
          expr: optional
            ? `${valueExpr} === null ? null : String(${valueExpr})`
            : `String(${valueExpr})`,
        },
      ];
    }
    if (t.name === "money") {
      // Persist as a precise-decimal string — decimal.js's `.toString()`
      // returns the canonical form `numeric(19, 4)` accepts.  An optional
      // money is `Decimal | null`, so guard the deref (tsc-strict).
      return [
        {
          fieldName,
          expr: optional
            ? `${valueExpr} === null ? null : ${valueExpr}.toString()`
            : `${valueExpr}.toString()`,
        },
      ];
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
