# `Provenanced<T>` — fold value + lineage into one uniform wire carrier

> **Status:** PROPOSED. No grammar change — the `provenanced` field
> modifier is unchanged surface syntax (see [`../provenance.md`](../provenance.md),
> shipped on TS/Hono, .NET, elixir-vanilla). This proposal changes the
> **internal + wire representation** of a provenanced field from two
> co-located siblings (value field + separate `<field>_provenance`
> column/DTO key) into a single generic carrier `Provenanced<T> =
> { value: T, lineage: ProvLineage | null }` that lives in `wireShape`,
> so **all nine targets agree on the shape** instead of three runtime
> backends bolting on an extra key.
>
> **Premise (code-verified, 2026-06-21 audit against `origin/main`):**
> provenance is **not** in `wireShape` today — it is a per-backend
> bolt-on, so the wire for a provenanced field already *diverges*
> across backends. Folding it into the carrier is therefore a parity
> **fix**, not a parity risk.
>
> **(Superseded 2026: the Ash foundation was removed; `platform: elixir` is plain
> Ecto/Phoenix only; `foundation: ash` is now a validation error.)** Mentions of
> "ash-Elixir" below as a non-capturing backend are stale — elixir is now
> vanilla-only, and elixir-vanilla already emits the real lineage runtime. Read
> those references as historical; the only remaining null-lineage targets are
> Python and Java.
>
> **Single biggest risk:** the read-site unwrap (§6). A provenanced
> field's value is currently *the field itself*; behind `.value` it
> needs unwrapping at every read. The fix is architecturally clean (one
> seam) but is the only genuinely invasive part. Read §6 before
> scheduling.

## 1. Problem

`provenanced` (e.g. `total: int provenanced`) records the lineage of
every value a field holds. Today the value and its lineage are **two
co-located siblings**:

- the value is a plain typed column / field (`Total`, `_total`,
  `total`);
- the lineage is a *separate* `<field>_provenance` jsonb column plus,
  on the runtime backends, a *separate* trailing DTO key
  (`TotalProvenance` on `<Agg>Response`).

Three consequences, all verified against the code:

1. **The wire diverges across backends.** `WireField`
   (`src/ir/types/loom-ir.ts:379`) has
   `source: "id" | "property" | "containment" | "derived"` — **no
   provenance source** — and `wireFieldsForAggregate`
   (`src/ir/enrich/enrichments.ts:1169`) emits the value as a normal
   `source: "property"` field and never adds lineage. Each runtime
   backend appends the lineage key *out of band* (Hono
   `repository-wire-builder.ts:78`, .NET `dto-mapping.ts:456`). So a
   node/.NET response carries an extra `*Provenance` key; Python, Java,
   ash-Elixir, and **every frontend** carry nothing. The wire contract
   for a provenanced field is backend-dependent.

2. **`wire-spec.json` can't see lineage.** `src/system/wire-spec.ts`
   (`objectSchemaFromWireShape`, lines 82–93) builds the contract
   artifact *purely* from `wireShape`. The lineage column is invisible
   to it and to every `_frontend/zod-schemas.ts` consumer — so the one
   artifact meant to detect wire-contract drift is blind to provenance.

3. **Frontends can't reach lineage.** A React/Vue/Svelte/Angular page
   renders `order.total` as a bare number with no path to its "why".
   The natural product feature — *click the figure → provenance
   popover* — needs a second fetch or a hand-written escape hatch,
   because the value and its lineage never travel together. This is the
   developer instinct the current split actively fights.

## 2. Proposed surface — none

No `.ddd` change. The author still writes:

```ddd
aggregate Order {
  quantity: int
  unitPrice: int
  discount: int

  total: int provenanced

  operation reprice(qty: int, price: int) {
    total := qty * price - discount
  }
}
```

Everything below is representation: how the compiler shapes the value +
lineage internally, on the wire, and in generated source.

## 3. The carrier — mirror the `paged`/`envelope` mechanism

Loom already monomorphizes single-argument generic carriers into named
DTOs that **every backend and frontend renders identically**: `paged`
and `envelope`, defined in `GENERIC_SHAPES`
(`src/ir/stdlib/generics.ts:49`) and expanded by
`monomorphizeGenericInstances` (`enrichments.ts:718`). This is the
closest shipped analog and the template to reuse.

Add a third carrier:

```ts
// src/ir/stdlib/generics.ts — GENERIC_SHAPES
provenanced: {
  ctor: "provenanced",
  fields: (arg) => [
    { name: "value",   type: arg,            optional: false, ... },
    { name: "lineage", type: PROV_LINEAGE,   optional: true,  ... }, // nullable
  ],
},
```

- `GenericCtorName` (`loom-ir.ts`) gains `"provenanced"` — the
  exhaustive switches over it become compile errors until every arm is
  filled (the intended forcing function: TS/.NET/Java/Python/Elixir wire
  emitters + the frontend zod walk).
- `genericInstanceName("provenanced", int)` → `IntProvenanced`;
  `Money provenanced` → `MoneyProvenanced` — one monomorphized DTO per
  carried type, emitted by the existing carrier path.
- `ProvLineage` is the already-shipped lineage type (Hono
  `domain/provenance.ts`, .NET `Domain/Common/ProvLineage.cs`,
  `<App>.Provenance.Json`). Its JSON shape is unchanged.

Unlike `paged`/`envelope` (written explicitly in `.ddd` as `customer
page`), the `provenanced` instantiation is **implicit**: the
`wireShape` derivation wraps a provenanced property's type. That is the
only mechanism delta — the *emission* path is reused verbatim.

## 4. Wire shape — uniform across all nine targets

```jsonc
// GET /orders/:id  — Order with `total: int provenanced`
{
  "id": "…",
  "quantity": 8,
  "unitPrice": 16,
  "discount": 0,
  "total": {                          // ← the carrier, not a bare 128
    "value": 128,
    "lineage": {                      // null on non-runtime backends
      "snapshotId": "13d60464",
      "target": { "type": "Order", "field": "total" },
      "inputs": [ { "path": "qty", "value": 8 }, { "path": "price", "value": 16 } ],
      "computedValue": 128
    }
  }
}
```

Non-runtime backends (Python, Java, ash-Elixir) emit the identical
shape with `"lineage": null` — so the **wire is uniform whether or not
the backend captures lineage**, which is the parity win. `create`
inputs omit `total` entirely (it's framework-computed, never authored),
exactly as today; the carrier appears only on the read/response side.

## 5. Generated output per target (the two-examples convention)

**TS / Hono** (`src/generator/typescript/emit/schema.ts`,
`_frontend/zod-schemas.ts`):

```ts
export interface Provenanced<T> { value: T; lineage: ProvLineage | null }

// zod, frontend api types:
const IntProvenanced = z.object({ value: z.number().int(), lineage: ProvLineage.nullable() });
```

**.NET** (`src/generator/dotnet/cqrs/dtos.ts`, `dto-mapping.ts`):

```csharp
public readonly record struct Provenanced<T>(T Value, ProvLineage? Lineage);
// OrderResponse: ... Provenanced<int> Total ...
```

**Java** (`src/generator/java/emit/*` — new emit):

```java
public record Provenanced<T>(T value, ProvLineage lineage) {}
// non-runtime: lineage is always null
```

**Python** (`src/generator/python/emit/aggregate.ts` — new emit):

```python
class Provenanced(BaseModel, Generic[T]):
    value: T
    lineage: ProvLineage | None = None
```

**Elixir vanilla** (no static generics → a plain struct;
`src/generator/elixir/vanilla/*`):

```elixir
defmodule MyApp.Provenanced do
  defstruct [:value, :lineage]   # @type t(v) :: %__MODULE__{value: v, lineage: ProvLineage.t() | nil}
end
```

**React / Vue / Svelte / Angular** consume the TS `Provenanced<T>` api
type — a page reads `order.total.value` for the figure and
`order.total.lineage` for the popover. This is the feature §1.3 wants,
delivered for free once the carrier is on the wire.

## 6. The read-site unwrap — the one invasive change

Today a provenanced field's value **is** the field: a `ref` with
`refKind: "this-prop"` renders to `this._total` (a scalar `T`),
identical to any other field (`render-expr.ts`). Move the value behind
`.value` and **every domain expression that reads a provenanced field
must unwrap** it.

The obstacle: the IR `ref` node (`loom-ir.ts` `RefExpr`) carries
`name`, `refKind`, `type` — but **no `provenanced` flag**, and the
`FieldIR.provenanced` flag is not reachable from the ref at render time
(`renderRef` has the field name, not the `AggregateIR.fields` list).

**Recommended fix (the clean seam):** lowering already resolves the
field for each `this-prop` ref (`lower-expr.ts`, IR invariant #3 "fully
resolved"), so stamp `provenanced: true` onto the ref when it points at
a provenanced field. Then add **one** unwrap leaf to the shared
`ExprTarget` (`src/generator/_expr/target.ts` `ref` dispatch) →
`t.refProvenanced(x)` returning `${x}.value` / `.Value` / `.value` per
backend. Every domain-logic backend (TS, .NET, Java, Python, Elixir)
inherits it from one place — the same payoff the `ExprTarget`
unification (`render-expr-target-unification.md`) was built for.

Scope of the invasiveness (bounded, but real):

- **Read sites** — the one-leaf seam covers ordinary reads.
- **Write sites** — `:=` builds the carrier (`{ value, lineage }`);
  `+=` / `-=` and self-referential `x := x + n` must
  *unwrap-then-rewrap* (`render-stmt.ts` `withTrace` /
  `withProvCapture`). The capture logic that snapshots leaf inputs
  *before* the write already exists; it now reads `.value`.
- **In-memory plumbing** — ctor/hydrate/`drainProv` and the synthesized
  `inspect` (`enrichments.ts:945`, builds raw `this-prop` refs) must
  agree on the carrier vs scalar boundary.

This is mechanical-but-cross-cutting across the five domain-logic
backends. It is the gating cost estimate for the whole proposal and the
reason to prototype TS end-to-end first (§9).

## 7. Persistence / migrations — unchanged

Storage stays **two columns** (typed value + jsonb lineage) regardless
of in-memory shape. `src/system/migrations-builder.ts` has *no*
provenance handling today — each backend emits the jsonb lineage column
in its own migration (.NET `Migrations/<late>_ProvenanceAudit.cs`,
vanilla `…_create_provenance.exs`, Hono Drizzle `emit/schema.ts:629`).
Those can stay **byte-identical**. The pair is a **serialization / DTO
change only**: the carrier splits into the two existing columns on the
way down and re-assembles on the way up.

`wire-spec.json` **does** change — provenanced aggregates' contract
gains the carrier. That is the *point* (§1.2), but it is a one-time
baseline/snapshot churn for every provenance system.

## 8. Scope — all nine targets, right-sized

| Target | Change |
|---|---|
| TS/Hono, .NET, elixir-vanilla | Refactor existing lineage sibling → carrier; read-site unwrap |
| Python, Java, ash-Elixir | **New** — emit `{ value, lineage: null }` carrier (no capture) |
| React, Vue, Svelte, Angular | **New** — `Provenanced<T>` api type + zod; pages read `.value` |
| Shared | `GenericCtorName` + `GENERIC_SHAPES` entry; `wireFieldsForAggregate`/`-Part` wrap; ref `provenanced` stamp in lowering; one `ExprTarget.refProvenanced` leaf; `wire-spec.ts` carries it |

The write-time capture machinery (`StmtIR.prov`, `prov-id.ts`,
`provenance_records` history) is **untouched** except for the `.value`
read in `withTrace`/`withProvCapture`.

## 9. Phasing

1. **Carrier + wireShape (shared, no backend).** Add the
   `provenanced` `GenericCtorName` + `GENERIC_SHAPES` entry; wrap in
   `wireFieldsForAggregate`/`-Part`; stamp `provenanced` on the ref in
   lowering. Gate: IR/enrich tests + `wire-spec.json` snapshot update.
2. **TS/Hono end-to-end (the prototype that sizes §6).** Carrier DTO +
   zod + the read-site unwrap leaf + write-site rewrap + hydrate.
   Gate: `LOOM_TS_BUILD`, the behavioral corpus, a new Hono provenance
   emit test (none exists today — a gap to close).
3. **.NET + elixir-vanilla** refactor to the carrier (port the TS seam).
4. **Python + Java + ash-Elixir** null-lineage emit (additive, cheap).
5. **Frontends** — `Provenanced<T>` api type; opt-in `.lineage` popover
   left to the page author. Gate: `LOOM_REACT/VUE/SVELTE_BUILD`.
6. **Conformance** — a new `provenanced-wire-parity` test beside
   `paged-wire-parity.test.ts` asserting all backends emit the identical
   carrier shape.

## 10. Test plan / gates that fire

- **IR:** `test/ir/provenance.test.ts`,
  `test/ir/capabilities/provenanced-storage-support.test.ts`,
  `test/ir/wire/*` snapshots.
- **Backend emit:** `test/generator/dotnet/dotnet-provenance-audit.test.ts`,
  `test/generator/elixir/vanilla-provenance.test.ts`, **new**
  Hono/Python/Java carrier tests.
- **Parity:** new `test/conformance/provenanced-wire-parity.test.ts`
  (`conformance-parity.yml`, per-PR).
- **Compile:** `LOOM_TS_BUILD`, `LOOM_DOTNET_BUILD`, `LOOM_PYTHON_BUILD`,
  `LOOM_JAVA_BUILD`, `LOOM_PHOENIX_BUILD` (vanilla),
  `LOOM_REACT/VUE/SVELTE_BUILD`.
- **Completeness:** adding the `GenericCtorName` makes every `TypeIR` /
  `GenericCtorName` switch a compile error until filled — the intended
  forcing function. `pipeline-layering.test.ts` unaffected (the seam
  stays in `_expr`).

## 11. Open questions

1. **Carrier vs flag on `WireField`.** Two encodings reach the same
   wire: (a) a `genericInstance { ctor: "provenanced", arg: T }` type
   (reuses the monomorphization path wholesale, ripples through every
   `TypeIR` switch); (b) a `provenanced: true` boolean on `WireField`
   that each emitter expands locally (smaller IR blast radius, but
   re-implements the carrier shape per backend). **Recommendation: (a)**
   — it reuses the shipped `paged`/`envelope` emission and the existing
   parity harness, and keeps one definition of the shape. Decide before
   Phase 1.
2. **Read-site `.value` everywhere, or only across operation
   boundaries?** Within a single write expression the unwrap is
   unavoidable; the question is whether a *derived* member or a
   *criterion* that references a provenanced field also unwraps (it
   must, for type-correctness) — confirm no queryable-subset surprise
   when a provenanced field appears in a `where`.
3. **Should the value column casing/name change?** Keeping the storage
   column named `total` (not `total_value`) keeps migrations
   byte-identical (§7); the carrier is purely a DTO/in-memory concern.
   Recommend: **no storage rename.**
4. **ash-Elixir and the validator gate.** Today
   `loom.provenanced-backend-unsupported`
   (`system-checks.ts:1814+`) *rejects* hosting a provenanced aggregate
   on ash/Python/Java. With null-lineage emit those backends can now
   *carry* the shape without *capturing* — do we relax the gate to a
   warning (the field is expressible, lineage just stays null), or keep
   rejecting and only emit the carrier for frontends/wire parity?
   **Recommendation:** relax to a warning — the whole point is a uniform
   wire; a hard reject re-introduces the divergence this proposal
   removes.

## 12. Cross-references

- [`../provenance.md`](../provenance.md) — the shipped feature this
  re-shapes.
- [`payload-transport-layer.md`](./payload-transport-layer.md) P3b —
  the `Paged<T>` carrier mechanism this mirrors.
- [`render-expr-target-unification.md`](./render-expr-target-unification.md)
  — the `ExprTarget` seam the read-site unwrap rides.
- `src/ir/stdlib/generics.ts` (`GENERIC_SHAPES`),
  `src/ir/enrich/enrichments.ts` (`monomorphizeGenericInstances`,
  `wireFieldsForAggregate`), `src/system/wire-spec.ts`.
