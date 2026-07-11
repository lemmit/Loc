# Narrowing a nullable `T?` field — the missing bridge to `option`

**Status:** backlog / not scheduled. Latent ergonomics gap, no live breakage.
**Discovered:** multi-tenancy Phase 3 (PR #1739), the registry `dataKey` stamp.
**Owner:** unclaimed.

## The gap in one line

Loom can *produce* optionals and unions and now *consume* tagged unions
(variant-`match` shipped), but it still has **no way to narrow a nullable
`T?` field** to `T` in an expression — no `??`, and `match` doesn't reach it.

## Why it exists (it's the `optional` vs `option` split)

Loom deliberately separates two "might be absent" concepts
([`docs/payloads.md`](../payloads.md) §"`option` — the third blessed postfix carrier"):

| | `T?` / `optional` | `T option` |
|---|---|---|
| Meaning | a **nullable field** (record slot may be empty) | a **tagged result** (`union[T, none]`) |
| Position | field / property / param | find / operation **return** |
| Wire | bare `null` (untagged), OpenAPI `nullable: true` | tagged `union[T, none]`, `none` → 404 |
| IR kind | `{ kind: "optional", inner }` | `{ kind: "union" }` |
| Consume | **nothing** (this gap) | variant-`match`, `or`-compose, 404 map |

The split is intentional — a nullable column must erase to plain `null`
(tagging every nullable field would be absurd storage/wire overhead), while a
result must be tagged so it can be discriminated and mapped to a status code.
The one place they overlap is a find return, where `find f(): Order?` and
`find f(): Order option` are wire-identical.

Because the consumption machinery (variant-`match`) lives on the **tagged**
side and `T?` is deliberately **untagged**, a `T?` field has no variant set to
match on. `match parent.dataKey { … }` on a `string?` resolves no arms.

## How it bites

The docs-canonical registry stamp is:

```ddd
dataKey := parent.dataKey + "." + seg   // parent.dataKey : string?
```

`string? + string` is a real type error under `mypy --strict` (Python is the
only backend gate strict enough to reject it; see below). The DSL has no
construct to narrow `parent.dataKey` to non-null, so there is no clean way to
write this. PR #1739 worked around it by deriving the child path from
`loaded.name` (non-nullable). The runtime is safe on every backend (paths are
seeded non-null), so this is a compile-time ergonomics wall, not a runtime bug.

### Why only Python's gate catches it

The nullable-string-concat assumption is latent in **all five** backends; only
the strictness of each compile gate differs:

| Backend | Gate | `nullableString + string` | Why |
|---|---|---|---|
| Python | `mypy --strict` | ❌ error | sound null-tracking; rejects `Optional[str] + str` |
| node/TS | `tsc --strict` | ✅ passes | permits `+` on a `string \| null` operand (no deref) |
| .NET | `dotnet build /warnaserror` | ✅ passes | NRT flags null *deref* (CS8602), not string `+` with a null operand |
| Java | `gradle bootJar` | ✅ passes | no null-tracking; `String + null` compiles (yields `"null."`) |
| Elixir | `mix compile --warnings-as-errors` | ✅ passes | no static type-check; `nil <> "."` fails only at runtime |

The others aren't *correct* here — they're *unchecked* (Java/TS/.NET would
concatenate `"null"` into the path; Elixir would crash at runtime). So the fix
belongs at the language level, not in a Python-specific patch.

## Two ways to close it

**Fork A — `??` null-coalescing operator.** A new `ExprIR` kind + one arm in
`renderExprWith` (`src/generator/_expr/target.ts`) + the `ExprTarget` interface
method, so all five backends light up at once; grammar rule, print arm,
parse/validator/lowering/per-backend tests. Standalone; doesn't touch the union
side.

**Fork B — fold `optional` into the matchable-union resolution (recommended).**
Teach the variant-`match` subject-type resolver to treat `{ kind: "optional",
inner: T }` as `union[T, none]` **at the point of match**, so the already-shipped
`none`-arm narrowing works on a nullable field:

```ddd
match parent.dataKey {
  string p => dataKey := p + "." + seg   // p narrowed to non-null string
  none     => dataKey := seg              // root org: no parent path
}
```

No new IR node, no new backend renderers — it reuses the entire variant-`match`
machinery that already ships (grammar `MatchStmt`/`VariantStmtArm`, lowering to
the `variant-match` IR, per-backend narrowing). It's the *smaller* change than
Fork A because the `none`/union/narrowing plumbing already exists; it also gives
the untagged-field world a consumption story that mirrors the tagged side,
instead of bolting on a second mechanism.

**Viability caveat to confirm before building Fork B:** the union-emission gate
(`containsUnion`, `src/ir/validate/checks/structural-checks.ts`) hard-errors on
any `union` reachable from a **type position** until per-backend union emission
lands (P4b–d). Fork B synthesizes the `union[T, none]` variant set *for
consumption only* — `parent.dataKey` stays typed `optional` at rest, and a plain
`string?` is not itself a union (`containsUnion` descends `optional`→`string`→
false), so it should not trip the type-position gate. Confirm this holds for a
variant-`match` inside an **operation body** (where the registry stamp runs)
before committing to the approach.

## When to pick this up

Not now. Build it when either:

1. someone hits the nullable-concat wall in a **real** `.ddd` model (not a
   fixture), or
2. the union-emission / variant-`match` extension work is already in flight —
   Fork B is then a cheap rider on it.

## Related notes

- [`docs/payloads.md`](../payloads.md) — the `optional` vs `option` distinction.
- [`docs/proposals/failure-taxonomy.md`](../proposals/failure-taxonomy.md) §3
  (variant-`match`, now **shipped**) and §5 ("`option` erasure corners").
- [`docs/plans/authorization-phase3.md`](authorization-phase3.md) — the
  registry stamp that surfaced this.
