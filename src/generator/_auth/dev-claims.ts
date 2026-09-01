// Which `user { … }` fields the dev-stub `x-loom-dev-claims` header can carry —
// the ONE classifier all five backends' stub verifiers read.
//
// WHY THIS EXISTS.  It used to be four independent copies of
// `f.type.kind === "primitive" && f.type.name === "string"`, one per backend
// (dotnet, python, java, elixir), each deciding for itself what the header may
// carry.  Hono had no such filter and spread the decoded JSON wholesale.  So a
// `permissions: string[]` claim rode the header on node and was silently
// discarded on the other four, leaving the field at its built-in EMPTY LIST —
// which made every `requires currentUser.permissions.contains(…)` gate fail
// closed there no matter what the caller sent, with no diagnostic and no test
// reaching it.  `docs/auth.md` meanwhile promised the header "drives every
// generated backend identically".
//
// One predicate with five readers cannot drift that way; five predicates did.
// (`experience_gathered.md` §89 — two halves of one contract computed
// independently — one layer up: N halves of one contract.)
//
// NOT the OIDC path.  A verified token carries real JSON, and every backend
// already maps `string[]` there (`ClaimStringList` / `claimStringList` /
// `_claim(...) or []` / `get_claim(...) || []`).  This governs the dev stub
// only.

import type { FieldIR, TypeIR } from "../../ir/types/loom-ir.js";

/** How a backend must decode one dev-claim from the header's JSON. */
export type DevClaimKind =
  /** A JSON string onto a `string` field. */
  | "string"
  /** A JSON array of strings onto a `string[]` field. */
  | "stringList";

// NOTE ON OPTIONALS — deliberately NOT carried.
//
// Every backend already excluded them: dotnet by an explicit `!f.optional`,
// the other three because `f.type.kind === "primitive"` is false once the type
// is wrapped as `{kind:"optional"}`.  Admitting them here would be a silent
// behaviour change on five backends riding along with an array fix, so this
// classifier reproduces the existing string rule EXACTLY and adds one shape.
// Carrying `string?` is a real question; it is just not this change's question.

/**
 * The claim kind a field can be carried as, or `undefined` when the dev stub
 * cannot represent it and the field must keep its built-in stub value.
 *
 * Deliberately narrow: `string` and `string[]` are the shapes an author can
 * actually gate on (`requires currentUser.role == …`,
 * `currentUser.permissions.contains(…)`), and they map onto every target
 * without a per-backend parse. Numbers, bools, enums and datetimes are NOT
 * carried — adding one means teaching all five decoders, so it stays an
 * explicit decision rather than a silent per-backend accident.
 */
export function devClaimKind(field: FieldIR): DevClaimKind | undefined {
  const t: TypeIR = field.type;
  if (field.optional) return undefined;
  if (t.kind === "primitive" && t.name === "string") return "string";
  if (t.kind === "array" && t.element.kind === "primitive" && t.element.name === "string") {
    return "stringList";
  }
  return undefined;
}

/** The carryable fields, in declaration order. Empty ⇒ emit no merge at all. */
export function devClaimFields(
  fields: readonly FieldIR[] | undefined,
): { field: FieldIR; kind: DevClaimKind }[] {
  return (fields ?? []).flatMap((field) => {
    const kind = devClaimKind(field);
    return kind ? [{ field, kind }] : [];
  });
}
