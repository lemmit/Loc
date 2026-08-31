// ---------------------------------------------------------------------------
// Which repository-`find` PARAM types the scaffolded list filter bar can
// render an input for (M-T1.15).
//
// Homed in `src/util/` because two layers read it and neither may import the
// other: the scaffold macro (`src/macros/stdlib/scaffold/_body-builders.ts`)
// decides which finds get a filter input, and the IR check
// `loom.scaffold-filter-param-unsupported`
// (`src/ir/validate/checks/ui-checks.ts`) reports the ones that do not — so
// the drop is announced instead of silent.  The two work on different
// representations (AST `TypeRef` vs IR `TypeIR`), which is why this module
// carries the NAME set rather than a type predicate; the two halves are pinned
// against each other behaviourally by
// `test/ir/scaffold-filter-param-unsupported.test.ts`, which scaffolds one
// find per param type and asserts each is EITHER wired into the bar OR
// reported — never both, never neither.
// ---------------------------------------------------------------------------

/** Primitive param types the filter bar renders an input for — the exact set
 *  `filterParamKind` (`_body-builders.ts`) returns a non-null kind for.
 *
 *  `string`/`guid`/`datetime` bind a `Field` (all three are `z.string()` on the
 *  wire and `string` in every frontend's state emitter); `int`/`long` bind a
 *  `NumberField` whose "unset" sentinel is the literal `0`; `bool` binds a
 *  three-state `SelectField` (""/"true"/"false").  Two are held back, and for
 *  reasons that live outside the macro:
 *
 *    decimal / money  — the `0` sentinel does not type-check on Feliz
 *                       (`decimal <> 0` is `decimal <> int`, FS0001), and
 *                       `money` binds a `Decimal` state `NumberField` does not
 *                       accept at all.
 *    enum             — every frontend types an enum-valued `state {}` field as
 *                       bare `string` (`stateTypeAsTsString` and its React /
 *                       Vue / Angular twins), while the generated query param
 *                       is the zod enum union — so the call would be TS2322.
 *
 *  An `X id` param IS renderable (a plain text input over the id string), so
 *  it is not a primitive-name question and is handled by each consumer. */
export const RENDERABLE_FILTER_PRIMITIVES: ReadonlySet<string> = new Set([
  "string",
  "guid",
  "datetime",
  "int",
  "long",
  "bool",
]);
