import type { AggregateMember } from "../../language/generated/ast.js";
import {
  assignStmt,
  create,
  defineMacro,
  destroy,
  memberAccess,
  mkIdType,
  mkNamedType,
  mkPrimitiveType,
  mkTypeRef,
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
    const updateFields = writableUpdateFields(target);
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
      const createFields = writableCreateFields(target);
      const createParams = createFields.map((f) => param(f.name, cloneType(f.type)));
      members.push(create(createParams, assignBody(createFields)));
      // Canonical hard delete — no params, empty body.
      members.push(destroy());
    }
    return members;
  },
});

/** Deep-clone a TypeRef so the macro-built parameter doesn't
 * share AST identity with the aggregate's field.  Without the
 * clone, Langium's `$container` invariant would break: a single
 * TypeRef node would have two parents (the original field and
 * the synthesised parameter).
 *
 * Implementation note: structuredClone would also copy
 * `$container` / `$cstNode` references which are not safe to
 * duplicate.  We instead rebuild the small TypeRef tree manually.
 * This is intentionally limited to the shapes the stdlib emits;
 * extend when a new shape is needed. */
function cloneType(
  t: import("../../language/generated/ast.js").TypeRef,
): import("../../language/generated/ast.js").TypeRef {
  const cloned = mkTypeRef({
    $type: "TypeRef",
    array: t.array,
    optional: t.optional,
    base: cloneBase(t.base),
  });
  // Re-parent the base node: $container metadata is required by
  // Langium's AST invariants but not in the AstLiteral input contract,
  // so we set it on the freshly-built node post-construction.
  const inner = cloned.base as { $container?: unknown; $containerProperty?: unknown };
  inner.$container = cloned;
  inner.$containerProperty = "base";
  return cloned;
}

function cloneBase(
  b: import("../../language/generated/ast.js").BaseType,
): import("../../language/generated/ast.js").BaseType {
  if (b.$type === "PrimitiveType") {
    return mkPrimitiveType({ $type: "PrimitiveType", name: b.name });
  }
  if (b.$type === "IdType") {
    return mkIdType({
      $type: "IdType",
      target: { $refText: b.target.$refText } as import("langium").Reference<
        import("../../language/generated/ast.js").Aggregate
      >,
    });
  }
  // NamedType
  return mkNamedType({
    $type: "NamedType",
    target: {
      $refText: (b as { target: { $refText: string } }).target.$refText,
    } as import("langium").Reference<import("../../language/generated/ast.js").NamedDecl>,
  });
}

// Imports are kept available for the input-typed variant; the void
// references silence the unused-import warning.
void memberAccess;
void primType;
