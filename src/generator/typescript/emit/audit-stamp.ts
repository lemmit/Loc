// ---------------------------------------------------------------------------
// Persist-time audit stamping (node / Hono · drizzle).
//
// Stamping (createdAt/createdBy/updatedAt/updatedBy) lives in the persistence
// layer, not the domain method or the route handler.  The generated Drizzle
// `save()` is an UPSERT, so ONE stamped save covers both lifecycles:
//   - insert branch  (`.values(stampInsert(row))`)        → stamp all create+update fields
//   - conflict branch (`set: stampUpdate(row)`)            → stamp only the update fields,
//                                                            createdAt/createdBy preserved (immutable)
//
// The principal comes from the ambient request context (`requestContext().actorId`,
// AsyncLocalStorage in obs/als) — no `currentUser` threading.  A non-request save
// (seed / system) has no context, so the helper returns the row unstamped.
//
// Emitted once per project as `db/audit-stamp.ts`, tailored to the audited
// aggregates' actual `stamp onCreate`/`onUpdate` field set (the `auditable`
// capability declares all four, but a hand-written `stamp` may declare a
// subset, e.g. timestamps only).
// ---------------------------------------------------------------------------

import type { ContextStampIR, EnrichedAggregateIR } from "../../../ir/types/loom-ir.js";
import { exprUsesCurrentUser } from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { renderTsExpr } from "../render-expr.js";

/** A single stamp field and the save-site expression that fills it. */
interface StampEntry {
  field: string;
  /** `requestContext().actorId` for a `currentUser` value, else the rendered
   *  expression (e.g. `now()` → `new Date()`). */
  valueExpr: string;
}

/** True when the aggregate carries lifecycle stamps (`stamp onCreate`/`onUpdate`,
 *  incl. the `auditable` macro) — the signal that its `save()` stamps. */
export function aggregateIsAudited(agg: EnrichedAggregateIR): boolean {
  return (agg.contextStamps?.length ?? 0) > 0;
}

function entriesFor(
  stamps: ContextStampIR[] | undefined,
  event: "create" | "update",
): StampEntry[] {
  return (stamps ?? [])
    .filter((s) => s.event === event)
    .flatMap((s) => s.assignments)
    .map((a) => ({
      field: a.field,
      // A `currentUser` value reads the ambient principal at save time; the
      // request-scope guard (helper-level) keeps a system/seed save unstamped.
      valueExpr: exprUsesCurrentUser(a.value) ? "ctx.actorId" : renderTsExpr(a.value),
    }));
}

/** The insert-branch field set: every create-event field plus every
 *  update-event field (a fresh row is both created and current).  Deduped by
 *  field name, update entries winning ties (irrelevant for `auditable`, where
 *  the sets are disjoint). */
export function insertStampEntries(agg: EnrichedAggregateIR): StampEntry[] {
  const byField = new Map<string, StampEntry>();
  for (const e of entriesFor(agg.contextStamps, "create")) byField.set(e.field, e);
  for (const e of entriesFor(agg.contextStamps, "update")) byField.set(e.field, e);
  return [...byField.values()];
}

/** The conflict-branch field set: only the update-event fields.  The
 *  create-only fields (createdAt/createdBy) are deliberately omitted so the
 *  upsert's `set` leaves them at their on-disk values — the drizzle analog of
 *  `@Column(updatable = false)` / EF's create-only switch arm. */
export function updateStampEntries(agg: EnrichedAggregateIR): StampEntry[] {
  return entriesFor(agg.contextStamps, "update");
}

/** The `db/audit-stamp.ts` helper module, tailored to the project's audited
 *  aggregates.  `stampInsert` fills the full create+update field set on a fresh
 *  row; `stampUpdate` overlays only the update fields (dropping the create-only
 *  ones so they stay immutable).  Both no-op outside a request scope. */
export function renderAuditStampHelper(audited: EnrichedAggregateIR[]): string {
  // Union the field→value mappings across every audited aggregate; the
  // `auditable` macro makes these uniform, so the merged helper is shared.
  const insert = new Map<string, string>();
  for (const agg of audited)
    for (const e of insertStampEntries(agg)) insert.set(e.field, e.valueExpr);
  const update = new Map<string, string>();
  for (const agg of audited)
    for (const e of updateStampEntries(agg)) update.set(e.field, e.valueExpr);
  // The create-only fields stampUpdate must strip so the `set` leaves them on
  // their on-disk values.
  const createOnly = [...insert.keys()].filter((f) => !update.has(f));

  // Each as a leading `, <field>: <value>` fragment so an empty set leaves the
  // spread (`{ ...row }`) clean — no dangling comma.
  const insertAssigns = [...insert.entries()].map(([f, v]) => `, ${f}: ${v}`).join("");
  const updateAssigns = [...update.entries()].map(([f, v]) => `, ${f}: ${v}`).join("");
  const stripBinding =
    createOnly.length > 0
      ? `const { ${createOnly.map((f) => `${f}: _${f}`).join(", ")}, ...rest } = row;`
      : `const rest = row;`;

  return lines(
    "// Auto-generated.  Do not edit by hand.",
    `import { requestContext } from "../obs/als";`,
    "",
    "// Stamp a freshly-inserted row's audit columns from the ambient request",
    "// principal.  A non-request save (seed / system) has no context, so the row",
    "// is returned unstamped.",
    "export function stampInsert<T extends Record<string, unknown>>(row: T): T {",
    "  const ctx = requestContext();",
    "  if (!ctx) return row;",
    `  return { ...row${insertAssigns} };`,
    "}",
    "",
    "// Stamp an updated row's mutable audit columns; the create-only columns are",
    "// dropped from the result so the upsert's `set` leaves them immutable.",
    "export function stampUpdate<T extends Record<string, unknown>>(row: T): Partial<T> {",
    "  const ctx = requestContext();",
    "  if (!ctx) return row;",
    `  ${stripBinding}`,
    `  return { ...rest${updateAssigns} } as unknown as Partial<T>;`,
    "}",
    "",
  );
}
