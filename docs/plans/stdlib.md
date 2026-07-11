# Stdlib plan — table-driven intrinsics + a self-hosted `std/` prelude

Follow-up to [`docs/audits/completeness-audit-2026-07.md`](../audits/completeness-audit-2026-07.md),
which identified the near-empty computation stdlib as the single largest expressiveness
gap (strings: `.length`/`.matches` only; math: bare operators; dates: `now()` +
comparison; collections: a closed set of 8 ops).

## The architecture decision

Two layers, split by an invariant Loom cannot escape:

**Loom expressions have dual semantics.** The same expression must render both as
in-memory host code (operation bodies, invariants, derived props) *and* as a queryable
predicate (find `where`, views, criteria, capability filters — the
`firstNonQueryableNode` machinery). A stdlib function implemented *in Loom* as a block
body can never push down to SQL. Therefore:

- **Layer 0 — intrinsics** live in the compiler, per-backend. Irreducible (you cannot
  write `trim` without character operations) and required for query pushdown. The fix
  here is not moving them out of the compiler but making them **data instead of code**:
  today one new op touches `type-system.ts`, `lower-expr.ts`, and five `render-expr.ts`
  files; after this plan it is one registry row.
- **Layer 1 — the `std/` prelude** is written in `.ddd` on top of Layer 0, using
  **expression-form functions**, which are already SQL-inlinable by design
  (`ddd.langium` `FunctionDecl`: "`= Expression` — SQL-inlinable like a `criterion`").
  Inlining at lowering time means backends and the query path see only Layer-0 ops —
  zero per-backend work per stdlib function, and the stdlib is testable with Loom's own
  `test` blocks across all five backends.

The missing language feature that makes Layer 1 possible is small: a **top-level,
importable `function`** (today `function` exists only as an aggregate/VO/entity member,
and `domainService` operations only as context members).

A sixth backend after this plan implements ~40 intrinsic leaves and inherits the entire
Layer-1 stdlib for free.

---

## Phase A — the intrinsic registry (Layer 0)

### A1 — registry infrastructure + pilot op (`trim`)

Extend the `src/util/collection-ops.ts` pattern into a full catalogue,
`src/util/intrinsics.ts` (pure data, importable from every layer without back-edges):

```ts
export interface IntrinsicSignature {
  receiver: "string" | "int" | "long" | "decimal" | "money" | "datetime" | "collection" | "none";
  name: string;                       // "trim"
  params: IntrinsicParamType[];       // [] | ["string"] | ["int", "int?"] | ["lambda"]
  returns: IntrinsicReturn;           // "string" | "int" | … | "element" | "sameCollection"
  queryable: boolean;                 // may appear left of firstNonQueryableNode
}
```

Wiring (one-time; after this, ops are rows):

- `type-system.ts` — `membersOfType` / member typing reads the catalogue instead of the
  hardcoded `length`/`matches`/collection-op arms (completion items come free).
- `lower-expr.ts` — lower to the existing `method-call` ExprIR with a
  `callKind: "intrinsic"` (or reuse the current method-call path + catalogue membership,
  whichever keeps `loom-ir.ts` unchanged — decide in-slice; prefer no new `ExprIR.kind`).
- `_expr/target.ts` — one new leaf method `intrinsic(e, recv, args)` on `ExprTarget`;
  each backend's table is a `Record<string, (recv, args) => string>` — a *snippet map*,
  not code paths. Unknown key = compile error via an exhaustiveness test that pins every
  catalogue row against every backend map (the `walker-stdlib-completeness` pattern).
- Queryable path: each backend's find-predicate renderer (Drizzle / EF / JPQL /
  SQLAlchemy / Ecto fragment) gets the same snippet-map treatment for `queryable: true`
  rows; `firstNonQueryableNode` consults the catalogue's `queryable` flag.
- Validator: honest gate `loom.intrinsic-not-queryable` when a non-queryable intrinsic
  appears in a `where` position.

Pilot lands `trim` end-to-end on all 5 backends + 5 query paths + walker/Zod wire layer,
with per-backend arm tests. Acceptance: adding the *second* op is a data-only diff.

```ddd
invariant email.trim().length > 0
find byName(q: string): Customer[] where name.trim() == q
```

```ts
// hono, in-memory            // hono, where-position (Drizzle)
this.email.trim().length > 0  sql`trim(${schema.customers.name}) = ${q}`
```

### A2 — string batch

`trim, toUpper, toLower, substring(start, len?), startsWith, endsWith, contains,
replace(find, repl), split(sep) → string[], indexOf → int, padStart/padEnd(n, s)`.
All queryable except `split` (collection-producing; DB-dialect-dependent — mark
non-queryable in v1).

### A3 — math batch

`abs, round(places?), floor, ceil, min(a,b), max(a,b)` on `int/long/decimal/money`
(money keeps closed-arithmetic rules: `round` on money returns money). All queryable.

### A4 — collection batch

`map(λ) → U[]`, `sortBy(λ[, desc])`, `distinct`, `min(λ)/max(λ)/avg(λ)`, `take(n)/skip(n)`,
`join(sep)` (string collections). In-memory on all backends; queryable only where the
existing collection-predicate pushdown already reaches (containment JSONB/child-table
paths) — default `queryable: false`, honest validator gate, revisit per-op.

### A5 — temporal types + arithmetic (the type-system slice)

The one part that is *not* just registry rows — new vocabulary:

- `duration` primitive + constructors `days(n), hours(n), minutes(n)` — an
  **ABSOLUTE** span only (fixed millisecond width per unit), which is what keeps it
  uniformly translatable across every backend (JS ms-numbers, .NET `TimeSpan`, Java
  `Duration`, Python `timedelta`, Elixir ms-integers) with no calendar arithmetic and
  no new dependency.
- `arithmeticResult` arms: `datetime ± duration → datetime`, `datetime - datetime →
  duration`, `duration ± duration`, `duration * int`.
- Queryable: `interval` arithmetic exists on Postgres for all five ORMs.
- Optional sub-slice: `date` primitive (calendar date). Defer `time`/timezones — the
  audit's timezone story is a separate proposal.

```ddd
derived isOverdue: bool = now() > dueDate + days(30)
```

```sql
-- where-position, all backends
now() > due_date + interval '30 days'
```

**Implementation notes (recon 2026-07-06, corrects the sketch above):**

- **`months` was cut, deliberately (post-ship refinement).** A5 originally shipped a
  fourth constructor `months(n)`, but a calendar month has no fixed width — it could
  not share the absolute-duration runtime representation, it forced the *only* new
  dependency (`python-dateutil`), it needed a positional validator gate
  (`loom.duration-months-position`, restricting it to direct `datetime ± months(n)`),
  and it diverged into five per-backend calendar paths (`setMonth` / `AddMonths` /
  `plusMonths` / `relativedelta` / hand-rolled Elixir shift). That conflated two
  concepts — absolute duration vs calendar offset (cf. java.time `Duration` vs
  `Period`) — and broke the "natively translatable" principle. `duration` is now
  absolute-only; a calendar/`period` type (`months`, `years`) is a possible future
  slice if real demand appears. This removed the dep, the gate, and the divergence.
- **No backend ships a date library** — the `date-fns`-on-TS note above is wrong
  (only the frontend stacks carry `dayjs`). Java `Duration`, .NET `TimeSpan`, Elixir
  `DateTime`, TS native `Date`, and Python `timedelta` arithmetic are all
  dependency-free (with `months` gone, nothing pulls `python-dateutil`).
- **Constructors follow the `now()` pattern** — a dedicated grammar node (like
  `NowExpr`, ddd.langium:2387) lowered to a dedicated IR form, NOT
  `callKind: "free"` (free calls type to `unknown`). `arithmeticResult` gains a
  `durationArithmetic` helper mirroring `moneyArithmetic`; `comparable` needs
  nothing (self-compare via `typesEqual`).
- **`duration` is EXPRESSION-ONLY in this slice** — a validator gate rejects it
  in field position. The plan's example needs no storable duration; keeping it
  out of field position removes 5 DB-column + 5 wire/DTO arms. Storable
  Postgres `interval` columns are a clean follow-on slice.
- **The hard arm is `datetime ± duration` in where-position** — Java's criteria
  renderer only handles comparison/logical ops today, and Java persists
  aggregates as one jsonb blob, so the `interval` translation needs explicit
  per-backend find-predicate work; datetime *comparison* already works
  everywhere.

### A6 (optional, independent) — string interpolation — **SHIPPED**

Backtick template with `{expr}` holes; lowers to plain string concatenation of the
literal segments and the `string()`-converted holes — no new IR kind, **zero backend
emitters** (rides the existing `+` / `convert` paths).

```ddd
derived label: string = `Order #{quantity} for {customerName}`
```

```typescript
// generated TS (Hono) — existing concat / String() path, no interp emitter
get label(): string { return "Order #" + String(this._quantity) + " for " + this._customerName; }
```

**Delimiter — backtick, not `"…"`.** Loom `.ddd` files already carry literal `{`/`}`
inside double-quoted strings (DDL snippets), so `"…{hole}…"` would be a breaking
change; a distinct backtick delimiter is a pure addition. Holes are full expressions
(arithmetic, calls, ternaries, nested templates) EXCEPT ones carrying a literal `{ }`
block (object / `match` / builder literals) — the two-mode lexer (`DddTokenBuilder`)
drops `{`/`}` inside a hole. A literal brace/backtick in text is escaped `\{` / `\}` /
`` \` ``. A hole must be string-typed or implicitly stringifiable (number / bool / enum
/ `X id` / aggregate-with-`display`); a `datetime` / collection hole is rejected by
`loom.interp-hole-type`. Non-queryable in `where` position (it desugars to `+`/`convert`,
already rejected by the queryable gate). See `docs/language.md` → String interpolation.

## Phase B — top-level `function` (the Layer-1 enabler)

- **B1 — grammar + scope: SHIPPED.** `FunctionDecl` is admitted as a
  `ModelMember`/`SystemMember` (file top level / inside `system {}`), exported
  workspace-wide via `ddd-scope.ts` like a root value object / enum. The
  `print-structural.ts` arm already existed (local functions); `langium:generate`
  output committed.
- **B2 — lowering = inlining (expression-form): SHIPPED.** An expression-form
  top-level function INLINES at each call site during lowering
  (`inlineTopLevelFn`, mirroring `inlinePolicyFn` — ambient env, arg
  substitution, cycle guard, paren-wrapped for precedence), gated on
  `resolveCallKind === "free"` so local members shadow it and it shadows the A5
  duration builtins. ExprIR downstream is unchanged → **zero backend work**, and
  a call in a `where:` stays queryable through the existing gate. Call-site
  return typing goes through `lookupTopLevelFunction` in the type system.
- **Block-form top-level functions: DEFERRED.** A `{ … }` body has no
  module-scope emission home yet (it would need a new seam on all 5 domain-logic
  backends), so a block-form top-level function is rejected —
  `loom.function-toplevel-block`. (Block-form stays legal as an aggregate / VO /
  workflow member, where it emits as a real method.)
- Validator: `loom.function-recursive` rejects direct **and mutual** recursion
  among expression-form top-level functions (inlining must terminate). Recursion
  stays legal for local member functions (they emit as real methods).

```ddd
function isBlank(s: string): bool = s.trim().length == 0

context Sales {
  aggregate Customer {
    name: string
    invariant !isBlank(name)
  }
}
```

```csharp
// .NET, inlined — no Function class is emitted
if (!(!(Name.Trim().Length > 0))) throw new DomainInvariantException(...);
```

## Phase C — the `std/` prelude in `.ddd`

- **C1 — distribution:** ship `std/*.ddd` inside the toolchain package; resolve
  `import "loom:std/strings"` (a `loom:` scheme arm in the project loader next to the
  file-relative path). Auto-import the prelude set the way `src/macros/prelude.ts`
  registers capabilities, with the same "user declaration wins" shadowing rule.
- **C2 — content:** `std/strings.ddd`, `std/math.ddd`, `std/temporal.ddd` — curated
  expression-form functions composed from Layer 0 (`isBlank`, `initials`, `clamp`,
  `percentOf`, `isOverdue`, `age`, …), each with `test` blocks. Wire the files into the
  behavioral corpus + conformance suite so the stdlib doubles as a permanent
  cross-backend conformance fixture.
- **C3 — docs:** `docs/stdlib.md` reference (intrinsics table generated from the
  registry — single source of truth), language.md cross-links.

## Sequencing & gates

A1 → A2/A3 (parallel) → A4; A5 independent after A1; A6 anytime after A2.
B1→B2 independent of Phase A (but Layer 1 is only *useful* once A2+A3 exist).
C after A2/A3 + B2.

Every Phase A slice: `npm test` + per-backend arm tests + the catalogue-completeness
pin + at least one heavy compile gate per touched backend (`LOOM_TS_BUILD`, dotnet
container build, gradle, uv/mypy, `LOOM_HEX_MIRROR=1` mix). Phase B: parsing +
negative-validator + print-roundtrip + one generator test per backend. Phase C:
behavioral corpus green.

## Explicitly out of scope

- User-supplied per-backend intrinsic snippets (an `extern`-style pressure valve for
  Layer 0) — parity/queryability risk; revisit only if `std/` demand shows a pattern.
- Timezones, business-day calendars (need their own proposal).
- Higher-order user functions / generics (audit Tier 2; unchanged by this plan).
