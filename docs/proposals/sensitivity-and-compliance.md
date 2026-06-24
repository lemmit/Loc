# Sensitivity tagging — `sensitive` as a type-system property

> Status: phases 1 and 2-lite are implemented in `ddd.langium`, the
> IR, and the validator. Phase 2 (`authorized` declassification),
> phase 3 (backend masking + DTO emitters + `mask:` strategies), and
> phase 4 (sink call kinds) remain proposals. Touches the
> authorization model at the seams — see
> [`policies-supplementary-note.md`](./policies-supplementary-note.md).
>
> Supersedes an earlier metadata-only draft; the strengthened design
> lives below.
>
> **2-lite decision.** Rather than ship `authorized(...)` immediately,
> the first enforcement step is *visibility-only*: implicit conversion
> across a sensitivity boundary is permitted at the type level so
> existing code keeps working, and the validator emits a warning at
> each narrowing site. When `authorized(...)` lands, the same warning
> sites can graduate to errors with `authorized(...)` as the escape
> hatch — no source rewrite required.

## Problem

PII / PHI / credentials leak via three predictable channels:

1. **Logs** — someone `log.info(user)`s a DTO whose `email` is in plaintext.
2. **Wire / UI** — a list endpoint returns more than it should, or a
   page renders a field that wasn't supposed to surface there.
3. **Derived values** — `greeting = "Hello " + user.email` launders
   PII into an apparently non-sensitive string.

A *metadata bit* on the field doesn't fix any of these on its own.
We want the compiler to enforce:

- The default rendering of a sensitive value is masked.
- The plaintext is only available inside a construct that explicitly
  declares itself authorized for the tag.
- Logs, errors, traces, and metrics **never** receive plaintext, even
  inside an authorized construct.
- Sensitivity propagates through concatenation, calls, ternaries —
  you can't strip it by reshaping the expression.

The first three are sink-side or boundary-side checks. The fourth
requires sensitivity to be **part of the type**, not metadata attached
to a field. That is the central design choice this proposal makes.

## Surface

### `sensitive(<tag>)` — field-level declaration

A trailing property modifier, in the slot between `provenanced` and
`check`:

```ddd
aggregate Patient {
  id:        Patient id
  firstName: string sensitive(pii)
  lastName:  string sensitive(pii)
  pesel:     string sensitive(pii)
  diagnosis: string sensitive(phi)
  status:    PatientStatus           // not sensitive
}
```

`sensitive(<tag>)` takes a single bare identifier or one or more bare
identifiers (`sensitive(pii, audited)`). Tags are an open set: the
compiler treats them as opaque strings. The policy layer (future) is
what gives each tag operational meaning.

Multi-tag values arise naturally from expression composition (see
propagation below) but can also be declared directly when a field
straddles categories.

### `authorized(<tag>, …)` — declassification (Phase 2)

A construct modifier on `operation`, `find`, `view`, and `api`
endpoint declarations:

```ddd
view CustomerSupportDirectory authorized(pii) {
  from users
  select { id, name, email, phone }
}

operation revealAuditTrail() authorized(pii, phi) {
  // reads inside here see plaintext for both tags
}
```

Within the scope of an `authorized(t1, t2)` modifier, the type checker
strips `t1` and `t2` from the sensitivity tag set of every value
flowing through that scope. Tags not listed remain attached; a value
that still carries sensitivity after declassification is still
masked at its sink.

`authorized` is **orthogonal to** the existing `requires <expr>`
authorization gate. `requires` is a runtime boolean precondition that
maps to HTTP 403; `authorized` is a static tag assertion that maps
(eventually) to a policy decision. They can co-exist on the same
construct.

### `mask: <strategy>` (Phase 3)

Per-field override for how the masked form is rendered:

```ddd
email: string sensitive(pii) mask: emailLocal      // "****@acme.com"
ssn:   string sensitive(pii) mask: tail(4)         // "***-**-1234"
card:  string sensitive(pci) mask: full            // "••••••••"  (default)
```

Strategies are a closed library: `full` (default), `tail(n)`,
`head(n)`, `emailLocal`, `none`. `mask: none` means "no transformation
at the wire boundary"; **it does not lift the sink restrictions** —
logs/errors/traces still see `[REDACTED]`.

## Lowering & type-system semantics

### Sensitivity is a type-system property

Every `DddType` (and the corresponding `TypeIR`) carries an optional
sensitivity tag set:

```
string                   →  DddType.primitive "string"      sensitivity {}
string sensitive(pii)    →  DddType.primitive "string"      sensitivity {"pii"}
```

The tag set lives **on the type of the value**, not on the field
declaration alone. A `Property` declaration's `sensitive(...)`
attaches tags to the type returned by the property's member lookup.
From there, propagation is purely a type-system rule.

### Propagation rules

| Construct | Result sensitivity |
|---|---|
| Literal (`"x"`, `42`, `true`, …) | ∅ |
| Variable / member access | the looked-up type's tag set |
| Binary `+`, `-`, etc. | union of operand tag sets |
| Comparison `==`, `<`, … | ∅ (returns `bool`) |
| Logical `&&`, `\|\|`, `!` | ∅ |
| Ternary `a ? b : c` | union of `b` and `c` tag sets |
| `paren(x)`, `unary(x)` | passes through |
| Member access `r.x` | `x`'s declared tag set (receiver-level taint is not modelled in Phase 1) |
| Function / operation call | return type's declared tag set (Phase 1); union with arg tags is left to a later refinement |
| Collection ops (`xs.first`, etc.) | element type's tag set |

### Subtyping / assignability

`String!{}` is assignable to `String!{pii}` (broadening — fine).
`String!{pii}` is **not** assignable to `String!{}` (narrowing — type
error). Implemented in `isAssignable` as: target.sensitivity must be a
superset of value.sensitivity.

This is what catches "logging a sensitive value": the log built-in's
argument type is `String!{}`, so passing `String!{pii}` fails the
assignability check at compile time. Logs/errors/traces/metrics are
classified as **sink call kinds** in Phase 4; the validator rule then
becomes a special case of ordinary type checking.

### Declassification

Inside an `authorized(t1, t2)` scope, the type checker post-processes
each looked-up type by subtracting `{t1, t2}` from its sensitivity set
before returning. Tags not listed remain. After the scope ends the
unaltered types are visible again to outer code (declassification does
not escape its lexical extent).

### Aggregate-internal implicit access

Inside an aggregate's own functions, operations, invariants, and
derived expressions, the type checker treats every sensitive field of
that aggregate (and its parts / value objects) as implicitly
declassified. Rationale: the aggregate is the DDD consistency and
trust boundary; forcing `authorized` on every internal method is pure
noise. Sink restrictions still apply, so internal access does not
license `log(this.email)`.

## Wire shape

Per-aggregate `wireShape` (built by `src/ir/enrichments.ts`) reads
sensitivity directly from each field's `TypeIR.sensitivity`. No
separate metadata flag. The artifact at `<outdir>/.loom/wire-spec.json`
therefore diffs naturally when a field gains, loses, or changes its
sensitivity tags.

## Relationship to the existing markers

- **`audited`** (already in grammar / IR) and **`logged`** (separate
  [proposal](./audit-and-logging.md)) are *action-side* markers —
  who did what, what got emitted. `sensitive` is a *field-side*
  property — what the value is. They compose: an `audited` operation
  that reads a `sensitive` field automatically records a "PII access"
  audit record (Phase 4).
- **`provenanced`** ([proposal](./provenance.md)) is about *where the
  value came from*. Sensitivity rides through provenance like any
  other type-level attribute.
- **`requires <expr>`** is the runtime authorization gate; `authorized`
  is the static tag assertion. They co-exist on the same operation /
  view / api endpoint.

## Phasing (what's actually being built)

| Phase | Adds | Status |
|---|---|---|
| **1** | `sensitive(<tag>)` grammar slot on `Property`; sensitivity component on `DddType` and `TypeIR`; propagation in `typeOf` (concat / ternary / member access); `FieldIR` carries declared tags. No backend changes. | ✅ implemented |
| **2-lite** | `isAssignable` stays tag-agnostic (implicit conversion permitted). `sensitivityNarrows(value, target)` predicate detects dropped tags. Validator emits warnings at five flow boundaries: assignment statements (`:=`, `+=`, `-=`), derived properties, function returns, and emit field values. | ✅ implemented |
| **2** | `authorized(<tag>, …)` modifier on `operation` / `find` / `view` / `api`. Declassification in type checker. Warnings at the same sites graduate to errors. Sensitive field in URL/path/query parameter blocked. | proposed |
| **3** | `mask: <strategy>` field modifier. DTO emitters (TS/Hono, .NET) emit two forms; React walker emits `<Masked>`; Phoenix redacts the field in its Ecto schema / context mapping (the original draft mapped this to Ash `sensitive? true`, but the Ash foundation was removed in 2026 — `platform: elixir` is plain Ecto/Phoenix only). Wire-spec carries the sensitivity bit through to `.loom/wire-spec.json`. | proposed |
| **4** | Sink call-kind classification (`log` / `error` / `trace` / `metric`) in lowering and `render-expr.ts`. Audit-on-declassification event emission via the existing `audited` infrastructure. | proposed |

## Open questions

- Whether `sensitive(secret)` / `sensitive(cred)` should default to a
  stricter rendering (always `[REDACTED]`, never `mask: tail(n)`).
- Whether call-return sensitivity should additionally union argument
  sensitivities (taint-through-call) — conservative and theoretically
  correct, but noisy in practice. Left for a later refinement.
- Receiver-level taint (`if User is sensitive, every member access on
  user is tainted`) — explicitly out of scope; sensitivity is per
  field, not per aggregate.
- See [`encrypted-at-rest.md`](./encrypted-at-rest.md) — a sibling
  feature that is deliberately *not* part of this proposal.
