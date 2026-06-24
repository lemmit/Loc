# Partial-update pattern — `command` + `option`-typed fields

> Status: pattern (not a new type). **Supersedes**
> `optional-and-partial-update.md` which proposed a separate
> `Optional<T>` named type. With
> [`payload-transport-layer.md`](./payload-transport-layer.md)'s
> `option` carrier (ML-postfix sugar for `T or none`) and
> position-driven wire encoding, `Optional<T>` is fully subsumed —
> no new type is needed.

## Problem

In a partial update (PATCH-style command), three states must be
distinguished:

- the field **was not supplied** (leave it unchanged),
- the field **was supplied as `null`** (clear it),
- the field **was supplied with a value** (set it).

Loom's `T?` (nullable suffix) only captures "value or null"; it
cannot express "absent". Authors today invent ad-hoc conventions
(sentinel values, sibling boolean flags) per command.

## Solution — `option` in command fields

The `command` keyword + `option`-typed fields give the three states
natively, with the right wire encoding picked from context.

Two-state field (absent / value):

```
command UpdateProfile {
  firstName: string option            # absent | "Ann"
  lastName:  string option
}
```

Three-state field (absent / cleared / value), using `string?
option` — an option whose inner type allows null:

```
command UpdateProfile {
  phone: string? option               # absent | null (clear) | "+48…"
  pesel: string? option
}
```

In the domain handler, pattern-match (or check `is some` / `is
none`):

```
operation updateProfile(cmd: UpdateProfile) {
  match cmd.firstName {
    some -> this.firstName := cmd.firstName.value
    none -> # leave unchanged
  }
  match cmd.phone {
    some -> this.phone := cmd.phone.value   # value may be null (cleared)
    none -> # leave unchanged
  }
}
```

Or with a shorter form when the body is trivial:

```
if cmd.firstName is some then this.firstName := cmd.firstName.value
```

## Wire encoding — driven by the `command` keyword

The `command` keyword carries PATCH-style semantics. When an
`option`-typed field appears in a `command`, the wire encoding uses
**field omission** for `none`:

| Author's type | Wire encoding (inside a `command`) |
|---|---|
| `string option` | omit field = `none`; present = `some(value)` |
| `string? option` | omit field = `none`; present with `null` = `some(null)`; present with value = `some(value)` |
| `int option` | omit field = `none`; present = `some(value)` |

Example HTTP bodies for the `UpdateProfile` command above:

```json
// Body 1 — nothing supplied
{}
// firstName = none, lastName = none, phone = none, pesel = none

// Body 2 — only firstName supplied
{ "firstName": "Ann" }
// firstName = some("Ann"), the rest = none

// Body 3 — phone explicitly cleared, firstName updated
{ "firstName": "Ann", "phone": null }
// firstName = some("Ann"), phone = some(null), lastName = none, pesel = none
```

This is the exact JSON pattern every PATCH API in the world uses;
nothing here is Loom-specific on the wire.

## Comparison to other position contexts

The same `string option` type encodes differently in different
contexts (the wire-encoding rule is position-driven; see upstream
proposal §"Relationship to `T?`"):

| Where `string option` appears | Wire encoding for `none` | Wire encoding for `some(v)` |
|---|---|---|
| Field in `command` (this doc) | field omitted | field present with value |
| Field in `event` / `response` / `query` / regular `payload` | field present with `null` | field present with value |
| Operation / find return type | HTTP 404 (status carries it) | HTTP 200 + body |
| Variant inside a queue message / non-HTTP payload | tagged: `{"kind": "none"}` | tagged: `{"kind": "some", "value": ...}` |

The author writes the same `string option` everywhere. The
toolchain picks the encoding from the AST position. No
annotations, no `@flat` / `@partial`, no second type.

## Field-level write policies

`option`-typed command fields are the trigger for field-level write
authorisation:

```
operation updateProfile(cmd: UpdateProfile) {
  if cmd.pesel is some then ensureWritable(pesel)   # only check when changing it
  if cmd.firstName is some then this.firstName := cmd.firstName.value
  if cmd.pesel is some then this.pesel := cmd.pesel.value
}
```

The `is some` check carries the "was this field actually supplied"
signal that today's `Optional<T>` proposal exposed via `.isSet`.
Same semantics, different surface — the carrier's variant tag
replaces the explicit flag.

See [`policies-supplementary-note.md`](./policies-supplementary-note.md)
for how field-level write policies hook into the authorisation
model.

## Validation gating

Validators (upstream Phase 5, see
[`exception-less.md`](./exception-less.md) §"Validators") naturally
gate on `is some`:

```
validate for UpdateProfile {
  when(cmd.phone is some) phone.value matches /\+[0-9]+/
}
```

A validation rule only fires for fields the client actually
supplied; "the field is absent" isn't a validation failure for a
PATCH-style command.

## Lowering / generation

- **OpenAPI**: `option` in command fields generates a schema with
  the field marked as optional (omitted = absent). For three-state
  `T? option`, the schema marks the field optional AND allows
  `null` as a value.
- **TS / Hono backend**: deserialiser reads the parsed JSON; any
  missing key becomes `{"kind": "none"}` in the IR-level
  representation; present keys become `{"kind": "some", "value":
  ...}`. The domain code sees the carrier.
- **.NET backend**: System.Text.Json with `DefaultIgnoreCondition =
  WhenWritingNull` or a custom converter for the variant
  representation. The deserialised command record carries the
  per-field discriminated record (`some(T)` / `none` in DSL terms;
  emitted as PascalCase sealed records per .NET convention).
- **Phoenix**: Phoenix params are a plain `map`; absent keys
  are absent in the map (no nil-vs-missing ambiguity per Elixir
  semantics). The action coerces to `{:some, value}` / `:none`
  before passing to the command handler. The `command` keyword's "omitted →
  none" rule applies the same way regardless of the runtime nil/option
  representation. **(Superseded 2026: the Ash foundation was removed; `platform:
  elixir` is plain Ecto/Phoenix only and `foundation: ash` is now a validation
  error — the original Ash-command-handler detail no longer reflects emitted output.)**

## Migration from `Optional<T>`

If the v0 `Optional<T>` proposal was ever implemented (it wasn't —
the proposal was unmerged), the migration would be:

| Old | New |
|---|---|
| `Optional<string>` | `string option` |
| `Optional<string?>` | `string? option` |
| `cmd.firstName.isSet` | `cmd.firstName is some` |
| `cmd.firstName.value` | `cmd.firstName.value` (same accessor) |
| `if !cmd.firstName.isSet then …` | `if cmd.firstName is none then …` |

Net effect: no new type, no `isSet` / `value` API to learn (the
carrier's `is some` / `.value` is the only surface). The
`Optional<T>` proposal converts to a pattern doc — this one.

## Why this works

- Single `option` carrier across all positions.
- Wire encoding driven by the enclosing keyword (`command` =
  PATCH-style field omission; other payload kinds = explicit null).
- No annotation noise. The author thinks "this command's fields are
  individually optional" and writes `option`; the toolchain handles
  the rest.
- Two-state and three-state collapse to `T option` vs `T? option`
  — the nullable suffix carries the third state cleanly.

## Open questions

- **Should `option` ever desugar differently in a `command` field
  vs an `event` field?** Pinned: same desugar (`T or none`), same
  domain-code accessors. Only wire encoding differs by context.
- **Should the `command` keyword optionally allow "this field is
  required, no `option`" semantics?** Yes — a non-`option`-typed
  field in a `command` means "must be supplied"; absent → 422
  validation error. This is the default behaviour; `option` opts in
  to PATCH semantics on a per-field basis.

## Cross-references

- [`payload-transport-layer.md`](./payload-transport-layer.md) —
  upstream; defines `option`, `or`, the carrier bound, and the
  position-driven wire encoding rule.
- [`exception-less.md`](./exception-less.md) — the broader
  exception-less proposal; `validate for X` (which gates naturally
  on `is some`) is defined there.
- [`policies-supplementary-note.md`](./policies-supplementary-note.md)
  — field-level write authorisation; `is some` is the trigger.
- [`implementation-plan.md`](./implementation-plan.md) — overall
  delivery plan; this doc lands as the partial-update pattern after
  upstream Phase 3+4 + exception-less A1 ship.
