# Authorization Phase 4 — the `deny` policy rule (deny-wins carve-out)

Status: **proposed** (Checkpoint-1 design; awaiting sign-off).
Source: `docs/proposals/authorization.md` §278-293 (the rule-row grammar, "`deny`
wins over `allow`").

## What ships in this slice

The **aggregate-level deny-wins carve-out primitive** — the foundational
negative rule the later field-masking / `data {}` row-clause slices reuse. Out of
scope (separate, larger follow-ups): field-level `mask`/`deny read`, `data {}`
row-attribute clauses, per-operation/point gates.

## Surface syntax

Deny is added to the existing `policy {}` read-ladder block, mirroring the shipped
`allow` form so it needs **no new keyword except `deny`**:

```ddd
policy {
  allow deep on Invoice        // existing: widen read scope
  deny on Invoice              // NEW: total read carve-out — Invoice is invisible
  deny write on Order          // NEW: read-only carve-out — Order can't be mutated
}
```

- `deny on X` — deny **read** (bare = read, exactly like the bare `allow` form).
- `deny write on X` — deny **write** (reuses the already-shipped `write` verb
  keyword; no new common-identifier keyword like `read`).

**Deny is all-or-nothing at the aggregate — there is deliberately no level word.**
`allow`'s `local|deep|global` is a *widening* ladder (how far reachability
reaches); a partial deny (deny only descendants, deny only some rows) is exactly
the `data {}` row-clause / field-mask territory this slice keeps out. An
aggregate-granularity carve-out is binary: the aggregate is denied or it isn't.

### The two accesses form a clean carve-out ladder

Because every backend's **write command-load reuses the read filter** (documented
invariant, `AggregateIR.writeScopeFilter` doc-comment), the two forms nest:

| Rule            | Read | Write | Meaning                        |
|-----------------|------|-------|--------------------------------|
| `deny on X`     | ✗    | ✗     | X is invisible (read carve-out also kills the write load) |
| `deny write on X` | ✓  | ✗     | X is read-only (reads fine, mutations blocked) |

## Semantics

**Deny-wins is a compile-time flattening rule.** Today the policy blocks (named /
role-scoped `policy Name {}` and anonymous `policy {}`) all flatten into
context-level arrays at lowering (`ctx.policyReadLevels` / `policyWriteLevels`);
there is no per-role runtime block evaluation yet. So deny-wins is applied in
**enrichment, after** `applyPolicyReadLevels` / `applyPolicyWriteLevels`: when an
aggregate is denied, the deny predicate overrides any allow-derived widening for
that access.

Runtime behaviour per backend — **fail-closed, reusing the existing conventions**:

- **denied read** → the read filter is an always-false predicate ⇒ `findAll`
  returns `[]`, `findById` misses ⇒ **404** (same as a tenant-scope miss today).
- **denied write** → the write-scope command load is always-false ⇒ the mutation
  can't load its row ⇒ **404** (same as the existing `writeScopeFilter` miss —
  `GetByIdForWrite` returning nothing).

Fail-closed default is unchanged: deny only *removes* access; an aggregate with no
policy is unaffected.

## Enforcement seam — a recognized sentinel, no new render architecture

Deny composes as a **negated (always-false) predicate through the existing
filter/write-scope seam**, mirroring the shipped `deep`-scope sentinel exactly
(`src/ir/util/tenant-stance.ts` `buildDeepScopeFilter` / `isDeepScopeFilter`,
special-cased by each backend's filter translator):

- **`buildDenyFilter(agg)`** → a marker `method-call` ExprIR
  (`member = DENY_SCOPE_MEMBER` on `this`, **no `currentUser`** ⇒
  `exprUsesCurrentUser` is false ⇒ routed to each backend's *static*,
  no-principal-param filter path — so deny-read adds **no** repo-method
  parameters and cannot trip an unused-param warning).
- **`isDenyFilter(e)`** → each backend's filter translator gates on this and emits
  its native always-false fragment (Drizzle ``sql`false` `` / EF `false` / JPQL
  `1 = 0` / SQLAlchemy `false()` / Ecto `fragment("false")`). ~1-3 lines per
  backend, exactly like the deep-scope special-case already there. A bare bool
  *literal* is **not** a valid predicate in Drizzle/Ecto/SQLAlchemy, which is
  precisely why deny is a recognized sentinel and not a `literal:bool` node.

Enrichment wiring:
- **deny read** → append `buildDenyFilter(agg)` to `agg.contextFilters` (the read
  filter list every backend ANDs into every read) **and** drop that aggregate's
  read-level widening (deny wins).
- **deny write** → set `agg.writeScopeFilter = buildDenyFilter(agg)` (overriding
  any allow-write narrowing). All 5 backends already consume `writeScopeFilter`
  → the `GetByIdForWrite` load becomes always-false.

**Unused-param watch-point (the one real trap):** the existing `writeScopeFilter`
is *always* a `currentUser`-using predicate, so a backend may emit the
`GetByIdForWrite` principal param unconditionally on `writeScopeFilter` presence.
A deny write-scope uses **no** `currentUser`, so that param would go unused →
`warnaserror`/`--strict`/`--warnings-as-errors` failure on .NET/Java/Python/Elixir.
The slice gates each backend's `GetByIdForWrite` principal param on
`exprUsesCurrentUser(writeScopeFilter)`, not mere presence. (This is the exact
"function emitted unconditionally whose body only uses a param under some configs"
trap.)

## Validation (`loom.policy-deny-*`, phase ⑦, `tenancy-checks.ts`)

- **`loom.policy-deny-unknown-aggregate`** — the deny target names no aggregate in
  the enclosing context (reuses the shared target-resolution the allow checks use).
- **`loom.policy-deny-duplicate`** — the same `(aggregate, access)` is denied by
  two rules in one context (copy-paste mistake).
- **`loom.policy-deny-shadows-allow`** — an `allow` targets the same
  `(aggregate, access)` that a `deny` covers in the same context: the allow is
  dead because deny wins. Emitted as a **warning** if IR-validate supports warning
  severity, else an error (the cross-role "role A allows, role B denies" scenario
  the proposal motivates is not yet expressible — blocks flatten into one
  namespace — so flagging the shadowed allow is honest; revisit when per-role
  runtime evaluation lands).

**Deliberately NOT added:** a "deny-without-any-allow" diagnostic. In Loom's model
an aggregate is readable by default (allow only *widens* tenant scope, it does not
*grant* base access), so `deny on X` with no `allow X` is meaningful and correct,
not redundant.

Deny is **not** restricted to tenant-owned aggregates (unlike the allow ladder,
which is inherently tenant-scoped): `contextFilters` and `writeScopeFilter` exist
and are consumed on *every* aggregate, so the sentinel works on any aggregate. The
target check only requires the name to resolve.

## Slice boundary — layers touched

| Layer | Change |
|---|---|
| Grammar (`ddd.langium`) | add `effect='allow'\|'deny'` discriminator to `PolicyReadRule`; deny alt omits `level`. Regenerate + commit `src/language/generated/`. |
| IR types (`loom-ir.ts`) | `PolicyDenyIR { aggregate; access: "read"\|"write"; source }`; `policyDenies?` on `BoundedContextIR`. |
| Lower (`lower.ts`) | policy loop collects deny rules into `policyDenies`. |
| Sentinel (`tenant-stance.ts`) | `DENY_SCOPE_MEMBER`, `buildDenyFilter`, `isDenyFilter`. |
| Enrich (`enrichments.ts`) | `applyPolicyDenies` (runs after read/write-level passes; deny-wins). |
| IR validate (`tenancy-checks.ts`) | the three `loom.policy-deny-*` codes. |
| Backends ×5 | filter translator special-cases `isDenyFilter` → native always-false fragment; gate `GetByIdForWrite` principal param on `exprUsesCurrentUser`. |
| Printer (`print-structural.ts`) | deny arm of the `PolicyReadRule` printer (print-completeness gate). |
| Frontends ×4 | **none** — deny is pure backend enforcement; `wireShape` is unchanged. |
| Docs | `docs/auth.md`, `docs/language.md`. |

## Tests

Parsing (deny read + deny write) · negative validator (one per new `loom.*` code)
· IR lowering (deny rules → `policyDenies` → deny filter/write-scope after enrich)
· per-backend generator pin ×5 (always-false fragment in the read filter /
write-scope load) · at least `LOOM_TS_BUILD` + one compiled backend per
touched target as gates.

## Genuinely user-owned fork

**`loom.policy-deny-shadows-allow` severity + whether allow+deny coexistence is an
error or a silent deny-wins.** Because policy blocks flatten (no per-role runtime
eval yet), an `allow` and `deny` on the same target in one context is
indistinguishable from the proposal's motivating "role A allows, role B denies"
scenario. Default proposed: implement deny-wins silently + emit a *warning* on the
shadowed allow. Flagging for sign-off in case you'd rather it be a hard error (or
silent, no diagnostic).
