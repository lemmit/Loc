import {
  assignStmt,
  defineMacro,
  memberAccess,
  nameRef,
  operation,
  param,
  primType,
  writableUserFields,
} from "../macro-api/index.js";

/** Adds standardised CRUD-style operations to an aggregate, built
 * from the host's user-declared fields.  This is the macro the
 * design discussion centred on as the "hard case": it has to
 * inspect the host's structure (field list) to generate operation
 * parameters and bodies, not just splice fixed declarations.
 *
 * Phase 3 v1 emits a single `update` operation that takes one
 * parameter per writable user field and assigns each to the
 * matching aggregate field.  `create` and `delete` are deferred
 * until input-type synthesis lands (the natural shape is
 * `create(input: ${target.name}Input)`, which requires the
 * generator to emit an `Input` value object alongside the aggregate;
 * see the `needsCrudInput` flag).
 *
 * "Writable user fields" means: declared Properties on the
 * aggregate that were NOT contributed by another macro.  This is
 * the deduplication the conversation worried about — `auditable`
 * adds `createdAt` etc., but they shouldn't appear on the update
 * surface because the audit interceptor (Phase 2.5) stamps them
 * automatically.  Detection is by origin tag on the field node,
 * which only macro-emitted fields carry.
 *
 * Composition note: combining `crudish` with `softDeletable` would
 * conflict on `delete()` once that lands.  The v2 plan is to add
 * an `updateOnly` arg (default false); when softDeletable is also
 * used, the user opts out of the hard delete via
 * `with crudish(updateOnly: true), softDeletable`.  v1 has no
 * `delete` so there's nothing to collide yet. */
export default defineMacro({
  name: "crudish",
  target: "aggregate",
  apiVersion: 1,
  description:
    "Adds an update(input...) operation that assigns each user-declared field. " +
    "Field-list iteration on the host validates that the macro mechanism " +
    "supports compile-time AST inspection of the target declaration.",
  expand({ target }) {
    const fields = writableUserFields(target);
    // Per-field positional parameters; once input-type synthesis
    // lands this collapses to a single `input: <Name>Input` param.
    const params = fields.map((f) => param(f.name, cloneType(f.type)));
    // Per-field assignment statements: `<field> := <field>`.  The
    // bare lvalue resolves to the aggregate's field; the RHS is a
    // bare name reference resolving to the parameter of the same
    // name (Loom's name resolution prefers params over fields when
    // shadowed, which is the right semantics here — without the
    // shadow, both sides would refer to the field).  When input-
    // type synthesis lands, the RHS becomes `input.<field>`.
    const body = fields.map((f) =>
      // To disambiguate from the field of the same name, route
      // through memberAccess: `this.<field> := <param>`.  Loom
      // accepts `this` as a magic identifier (see render-expr.ts).
      assignStmt(f.name, nameRef(f.name)),
    );
    return [operation("update", params, body)];
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
  t: import("../language/generated/ast.js").TypeRef,
): import("../language/generated/ast.js").TypeRef {
  const base = t.base;
  const cloned: import("../language/generated/ast.js").TypeRef = {
    $type: "TypeRef",
    array: t.array,
    optional: t.optional,
    base: cloneBase(base),
  } as unknown as import("../language/generated/ast.js").TypeRef;
  const inner = cloned.base as unknown as Record<string, unknown>;
  inner.$container = cloned;
  inner.$containerProperty = "base";
  return cloned;
}

function cloneBase(
  b: import("../language/generated/ast.js").BaseType,
): import("../language/generated/ast.js").BaseType {
  if (b.$type === "PrimitiveType") {
    return {
      $type: "PrimitiveType",
      name: b.name,
    } as unknown as import("../language/generated/ast.js").BaseType;
  }
  if (b.$type === "IdType") {
    return {
      $type: "IdType",
      target: { $refText: b.target.$refText },
    } as unknown as import("../language/generated/ast.js").BaseType;
  }
  // NamedType
  return {
    $type: "NamedType",
    target: { $refText: (b as { target: { $refText: string } }).target.$refText },
  } as unknown as import("../language/generated/ast.js").BaseType;
}

// Silence the unused-import warning until we wire memberAccess into
// the input-typed variant in a follow-up commit.
void memberAccess;
void primType;
