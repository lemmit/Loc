# Optional & partial update — `Optional<T>`

> Status: proposal. Not in `ddd.langium`. The most tangential of the
> aspects (it surfaced inside a DDD/.NET transport tangent), but it is a
> genuine language addition and it is the trigger mechanism for
> field-level write policies — included for completeness.

## Problem

In a partial update (PATCH-style command), three states must be
distinguished:

- the field **was not supplied** (leave it unchanged),
- the field **was supplied as `null`** (clear it),
- the field **was supplied with a value** (set it).

Loom's `T?` only captures "value or null"; it cannot express "absent".
Without the distinction, every partial update has to invent an ad-hoc
convention.

## Surface

A generic `Optional<T>` carrying an explicit "was it set" flag,
distinct from `T?`'s "is it null":

```ddd
// A command whose fields may each be absent, null, or set.
operation updateProfile(
  firstName: Optional<string>,    // absent | "Ann"
  phone:     Optional<string?>,   // absent | null (clear) | "+48…"
  pesel:     Optional<string?>
) {
  // `isSet` gates whether the field participates at all
  if firstName.isSet then this.firstName := firstName.value
  if phone.isSet     then this.phone := phone.value
}
```

`Optional<T>` is shaped as:

```
Optional<T> { isSet: bool; value: T? }
```

- `Optional<string>` — absent, or a string.
- `Optional<string?>` — absent, or null, or a string (the nested `?`
  carries the "explicitly cleared" case).

## Language additions

This is the largest single addition in the proposal set because Loom
currently has **no generics and no standalone `type` declaration**:

| Addition | Form | Cost |
|---|---|---|
| `Optional<T>` built-in | a parameterised type usable in `TypeRef` positions | requires a (minimal, single-parameter) generic type ref in the grammar + IR |
| `.isSet` / `.value` accessors | reserved members on an `Optional` value | small |

Two ways to land it:

1. **Built-in only** — `Optional<T>` is a compiler-known type ref (no
   general user generics). Smallest surface; recommended for v1.
2. **General `type Name<T> { … }`** — opens user-defined generics.
   Much larger lift; out of scope for this proposal.

## Lowering & generation

- **Wire / OpenAPI**: `Optional<T>` flattens to `T` in the schema via a
  schema filter; "absent" is represented by the field's omission from
  the JSON payload, "null" by an explicit JSON null. Backends decode
  presence into `isSet`.
- **Validation**: rules guard on `isSet` (`when(x.isSet, …)`), so a
  rule only fires for fields that were actually supplied.
- **Domain**: change DTOs may use `Optional<…>` like any other type;
  the aggregate operation reads `isSet` to decide which fields to
  apply.

## Why it matters to policy

`Optional.isSet` is the trigger for **field-level write-policy checks**:
a handler enforces a field's write policy only for fields that were
actually supplied —

```
if cmd.pesel.isSet then ensureWritable(pesel)   // check only when changing it
```

This is the seam to the authorization model and is covered in
[`policies-supplementary-note.md`](./policies-supplementary-note.md).

## Open questions

- Built-in `Optional<T>` vs general user generics.
- Whether `Optional<T?>` (the absent/null/value tri-state) is worth the
  nested-`?` complexity, or whether two flags read better.
- Final accessor spelling (`isSet`/`value` vs `present`/`get`).
