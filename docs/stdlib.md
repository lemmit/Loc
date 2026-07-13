# Standard library

<!-- GENERATED FILE — do not edit by hand.  Regenerate with `npm run docs:stdlib`
     (source of truth: src/util/intrinsics.ts, src/util/collection-ops.ts,
     src/language/stdlib-source.ts). -->

Loom ships a small standard library in two layers.  **Layer 0** is the set of
built-in *intrinsics* — irreducible operations on scalar and collection
receivers that the compiler renders natively on every backend (and, where
marked queryable, pushes down to SQL).  **Layer 1** is the *ambient prelude* —
ordinary expression-form top-level functions written in Loom on top of Layer 0,
callable with nothing imported and inlined at each call site.

This page is generated from the registries; see `docs/language.md` for the
surrounding expression-language reference and `docs/plans/stdlib.md` for the
roadmap.

## Layer 0 — scalar intrinsics

Built-in operations on a scalar receiver.  A `queryable` op may appear in a
`find … where` predicate (and view / criterion / capability filters); a
non-queryable one in that position is rejected with `loom.intrinsic-not-queryable`
rather than silently degrading.

#### `string`

| op | signature | queryable |
| --- | --- | --- |
| `trim` | `(): string` | yes |
| `toUpper` | `(): string` | yes |
| `toLower` | `(): string` | yes |
| `substring` | `(start: int, len?: int): string` | no |
| `startsWith` | `(s: string): bool` | no |
| `endsWith` | `(s: string): bool` | no |
| `contains` | `(s: string): bool` | no |
| `replace` | `(find: string, repl: string): string` | no |
| `split` | `(sep: string): string[]` | no |

#### `int`

| op | signature | queryable |
| --- | --- | --- |
| `abs` | `(): int` | yes |
| `min` | `(other: int): int` | yes |
| `max` | `(other: int): int` | yes |

#### `long`

| op | signature | queryable |
| --- | --- | --- |
| `abs` | `(): long` | yes |
| `min` | `(other: long): long` | yes |
| `max` | `(other: long): long` | yes |

#### `decimal`

| op | signature | queryable |
| --- | --- | --- |
| `abs` | `(): decimal` | yes |
| `min` | `(other: decimal): decimal` | yes |
| `max` | `(other: decimal): decimal` | yes |
| `round` | `(places?: int): decimal` | yes |
| `floor` | `(): decimal` | yes |
| `ceil` | `(): decimal` | yes |

#### `money`

| op | signature | queryable |
| --- | --- | --- |
| `abs` | `(): money` | yes |
| `min` | `(other: money): money` | yes |
| `max` | `(other: money): money` | yes |
| `round` | `(places?: int): money` | yes |
| `floor` | `(): money` | yes |
| `ceil` | `(): money` | yes |

## Collection operations

Operations on a collection receiver `T[]`.  These render in-memory on every
backend that executes domain logic; they are non-queryable (a reference-
collection `contains` is the one exception — it pushes down to an `EXISTS`
subquery).  `λ` is a lambda whose parameter is bound to the element type.

| op | signature |
| --- | --- |
| `count` | `int` |
| `sum` | `(λ): decimal` |
| `all` | `(λ): bool` |
| `any` | `(λ): bool` |
| `where` | `(λ): T[]` |
| `first` | `T` |
| `firstOrNull` | `T?` |
| `contains` | `bool` |
| `map` | `(λ): U[]` |
| `sortBy` | `(λ, desc?: bool): T[]` |
| `distinct` | `T[]` |
| `take` | `(n: int): T[]` |
| `skip` | `(n: int): T[]` |
| `join` | `(sep: string): string` |

## Layer 1 — the ambient prelude

Auto-injected top-level functions, callable in any `.ddd` with nothing
imported.  Each is expression-form, so a call inlines and an uncalled
function emits nothing; a user-declared top-level function of the same name
shadows the prelude.

### `strings`

String predicates and shaping.

```ddd
// Loom stdlib — strings.
function isBlank(s: string): bool = s.trim().length == 0
function isPresent(s: string): bool = s.trim().length > 0
function truncate(s: string, n: int): string = s.substring(0, n)
```

### `math`

Numeric clamping, ratios, and rounding.

```ddd
// Loom stdlib — math.
function clamp(n: int, lo: int, hi: int): int = n.max(lo).min(hi)
function percentOf(part: decimal, whole: decimal): decimal = part / whole * 100
function roundTo(n: decimal, places: int): decimal = n.round(places)
```

### `temporal`

Datetime comparisons against `now()`.

```ddd
// Loom stdlib — temporal.
function isOverdue(due: datetime): bool = now() > due
function isFuture(t: datetime): bool = t > now()
function isPast(t: datetime): bool = t < now()
```
