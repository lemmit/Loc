# Non-guid aggregate ids — removed

**Status: resolved by removal.** `aggregate X ids int|long|string` is no longer
valid syntax; `guid` is the only aggregate id kind. `ids guid` remains a legal
(no-op) explicit spelling of the default.

## Why removed

The `ids int|long|string` surface was **non-functional on every backend**, not
just some. Generating an `ids int` aggregate and reading the output showed:

- The **create path had no id-generation strategy**. On .NET the constructor
  minted `new TicketId(0)`; the migration PK was a plain `INTEGER NOT NULL`
  (no `SERIAL` / `GENERATED … AS IDENTITY`), and `create` takes no external id.
  So the *first* insert got id `0` and the *second* collided on the primary key.
  guid is the only kind the create path can actually mint (`randomUUID()` /
  `Guid.NewGuid()` / `Ecto.UUID` — a fresh unique value each time).
- Type consistency was only partial anyway: .NET / Java / Elixir emitted a
  matching PK-column / DTO / param type, but **Hono** kept a `string` id brand
  (minting a uuid into an integer column), a `z.string()` Response id, and a
  `z.string().uuid()` param (422ing `GET /tickets/42`); **Python** emitted a
  `Uuid` PK column regardless of the declared kind.

Nothing in the conformance corpus used a non-guid id, so CI never caught any of
this. Making it actually work would have meant a real feature — identity /
serial PK columns plus an `INSERT … RETURNING id` create path wired back to the
wire response across all five backends, and a separate natural-key create
surface for `ids string` (client-supplied ids — a language change). Rather than
carry a broken-and-gated feature, the surface was removed.

## What changed

- **Grammar** (`ddd.langium`): `IdKind` narrowed from `'guid' | 'int' | 'long'
  | 'string'` to `'guid'`. The `('ids' idKind=IdKind)?` clause stays, so
  `ids guid` still parses; `ids int|long|string` is now a parse error
  (`Expecting token of type 'guid'`). Regenerated parser/AST committed.
- The `IdValueType` IR type and the `valueType` field on the `id` `TypeIR`
  **remain** (always `"guid"`). They are the branded-id backbone read across
  migrations, wire-spec, and every backend's id emission; excising the type
  parameter entirely would be a large mechanical change with no behavioural
  effect, so the infrastructure stays, collapsed to its single inhabitant.
- The interim `loom.non-guid-aggregate-id-unsupported` validator (which had
  gated node/python) was removed — the grammar now rejects the input outright,
  so the gate is unreachable.

## If non-guid ids are wanted later

This is a fresh feature, not a bug fix: widen `IdKind` again, then implement
identity/serial PK columns + `RETURNING`-based create across the five backends
(and decide the `ids string` natural-key create surface). The `IdValueType`
plumbing that still threads `valueType` through the pipeline is the scaffold it
would build on.
