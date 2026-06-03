import type { AggregateMember, TypeRef } from "../../language/generated/ast.js";
import {
  assignStmt,
  create,
  defineMacro,
  destroy,
  idRef,
  namedType,
  nameRef,
  operation,
  param,
  primType,
  writableCreateFields,
  writableUpdateFields,
} from "../api/index.js";

/** Adds standardised CRUD-style lifecycle actions to an aggregate,
 * built from the host's user-declared fields.  This is the macro the
 * design discussion centred on as the "hard case": it has to
 * inspect the host's structure (field list) to generate action
 * parameters and bodies, not just splice fixed declarations.
 *
 * Emits three actions:
 *   - `update(<writable fields>)` — a mutate operation assigning each
 *     writable update field (see `writableUpdateFields`).
 *   - canonical `create(<writable create fields>)` — the unnamed
 *     factory that lowers to `POST /collection`.  Uses
 *     `writableCreateFields` (which keeps `immutable` fields — settable
 *     once, at creation — unlike the update surface).
 *   - canonical `destroy { }` — the unnamed hard-delete terminator
 *     (`DELETE /collection/{id}`); empty body, the backend wires the
 *     actual removal.
 *
 * The two `writable*Fields` helpers AND together two filters (see
 * `src/macros/api/factories.ts`):
 *   1. Excludes fields contributed by another macro (origin-tag
 *      check) — catches `createdAt` from `auditable`, `isDeleted`
 *      from `softDeletable`, etc., regardless of access modifier.
 *   2. Excludes fields whose `access` modifier puts them outside the
 *      payload (`managed`, `token`, `internal`; update additionally
 *      drops `immutable`).  `secret` stays on both — write-only fields
 *      belong IN create/update inputs.
 *
 * Composition with `softDeletable`: both want to own deletion.  Pass
 * `updateOnly: true` to suppress the canonical `create`/`destroy` and
 * emit only `update`, so `with crudish(updateOnly: true), softDeletable`
 * leaves the soft-delete macro's terminator uncontested. */
export default defineMacro({
  name: "crudish",
  target: "aggregate",
  apiVersion: 1,
  params: {
    /** When true, emit only the `update` operation — no canonical
     * `create`/`destroy`.  For composing with a macro that owns the
     * create/delete lifecycle (e.g. `softDeletable`). */
    updateOnly: { kind: "bool", default: false },
  },
  description:
    "Adds update(...) plus a canonical create(...) and destroy {} built from the " +
    "host's user-declared fields.  Field-list iteration on the host validates that " +
    "the macro mechanism supports compile-time AST inspection of the target.",
  expand({ target, args }) {
    // Error-recovery ASTs can leave a malformed field (e.g. `count = 0`, a
    // property written without its `: type`) with no `type` node.  Skip such
    // fields so the macro surfaces the real syntax error instead of throwing
    // a cryptic "Cannot read properties of undefined (reading 'array')" from
    // `cloneType` on top of it.
    const hasType = (f: { type?: unknown }): boolean => f.type != null;
    const updateFields = writableUpdateFields(target).filter(hasType);
    // Per-field positional parameters; once input-type synthesis
    // lands this collapses to a single `input: <Name>Input` param.
    const updateParams = updateFields.map((f) => param(f.name, cloneType(f.type)));
    // Per-field assignment statements: `<field> := <field>`.  The
    // bare lvalue resolves to the aggregate's field; the RHS is a
    // bare name reference resolving to the parameter of the same
    // name (Loom's name resolution prefers params over fields when
    // shadowed, which is the right semantics here — without the
    // shadow, both sides would refer to the field).  When input-
    // type synthesis lands, the RHS becomes `input.<field>`.
    const assignBody = (fields: readonly { name: string }[]) =>
      fields.map((f) => assignStmt(f.name, nameRef(f.name)));
    const members: AggregateMember[] = [
      operation("update", updateParams, assignBody(updateFields)),
    ];
    if (!args.updateOnly) {
      // Canonical create: the create surface keeps `immutable` fields
      // (settable at creation), so it uses writableCreateFields — a
      // superset of the update params for any aggregate with immutables.
      const createFields = writableCreateFields(target).filter(hasType);
      const createParams = createFields.map((f) => param(f.name, cloneType(f.type)));
      members.push(create(createParams, assignBody(createFields)));
      // Canonical hard delete — no params, empty body.
      members.push(destroy());
    }
    return members;
  },
});

/** Rebuild a field's TypeRef as a fresh, macro-tagged param type.
 *
 * Uses the blessed `primType` / `idRef` / `namedType` factories rather
 * than hand-rolling `mk*` nodes: the factories origin-tag the node and
 * build a reference the expander re-links after splicing, so a `Money`
 * value-object / `OrderStatus` enum / `X id` field keeps its resolved
 * type on the synthesised param.  Hand-rolled `mkNamedType` references
 * never re-linked, so such params silently lowered to `string` — the
 * bug this replaces (only ever exercised by primitive fields before).
 *
 * Array / optional flags carry across; the factories own `$container`
 * wiring + origin tagging.  (Generic carriers never reach here — the
 * position rule keeps them off stored aggregate fields.) */
function cloneType(t: TypeRef): TypeRef {
  const opts = { array: !!t.array, optional: !!t.optional };
  const b = t.base;
  if (b.$type === "PrimitiveType") {
    // `primType`'s name union omits `json` (a valid primitive); the
    // factory passes the name straight to `mkPrimitiveType`, so the cast
    // is sound at runtime.
    return primType(b.name as Parameters<typeof primType>[0], opts);
  }
  if (b.$type === "IdType") {
    return idRef(b.target.$refText, opts);
  }
  // NamedType — value object or enum.
  return namedType((b as { target: { $refText: string } }).target.$refText, opts);
}
