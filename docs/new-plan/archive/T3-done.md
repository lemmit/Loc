# T3 — Security, tenancy & governance — completed missions

*Archived 2026-09-02 from [`../T3-security-governance.md`](../T3-security-governance.md). Every mission below is closed (`done` / `shipped` / `closed` / `concluded` / `withdrawn`); the bodies are moved verbatim (links re-based one level deeper) so the evidence trail stays readable. Nothing here is open work — the live track file lists what remains.*

## M-T3.3 — P4 `deny` carve-outs — `done` · **M** · P2
Everything the checkpoint listed ships: grammar `deny [write] on <Aggregate>` (the `effect` discriminator on `PolicyReadRule`), `PolicyDenyIR` + lowering into `BoundedContextIR.policyDenies`, enrichment composing `buildDenyFilter` onto the read `contextFilters` (deny read) or `writeScopeFilter` (deny write) with deny winning over a widening allow, all three diagnostics (`loom.policy-deny-{unknown-aggregate,duplicate,shadows-allow}`), and the always-false fragment on all five backends — Drizzle contradiction / EF `false` / SQLAlchemy contradiction / JPQL `1 = 0` + `@SQLRestriction("1 = 0")` / Ecto `fragment("false")` — pinned by `test/ir/policy-deny.test.ts` + `test/generator/policy-deny.test.ts`. The open fork on `loom.policy-deny-shadows-allow` severity resolved as a warning (a deny that shadows an allow is legal and intentional; the diagnostic exists to surface a rule the author may not realise is dead).

**The residual, closed here: the feature had no fixture.** Until `test/fixtures/corpus/policy-deny.ddd` no `.ddd` anywhere — corpus, `examples/`, or `web/src/examples/` — carried `deny`, so it was covered by unit + generator tests and never by a build: it never reached the five-backend corpus compile matrix and its emitted schema never reached `schema-load`. A fragment can render exactly right and still not compile in place (the Elixir deny-write command load must underscore its now-principal-free `_current_user` parameter or `--warnings-as-errors` rejects the module). The fixture declares both seams, a `crossTenant` aggregate denied with NO tenant filter (so the always-false term stands alone — the shape most likely to strand an unused parameter or import), a named `find` on the read-denied aggregate (the deny term must be AND-ed into the author's own `where`, not just the auto findAll), and an undenied control — so a backend that renders the term into the wrong query site, or into every site, shows up as a diff rather than as uniform silence. Registered in `E2E_LESS_CORPUS_FIXTURES`: `deny` now compiles everywhere but still has no runtime caller, which is M-T9.13's drain, not this mission's. **Drained 2026-08-11 (#2517):** the fixture's `test e2e` block drives all four stances over HTTP — read-denied (with a tenant floor and, `crossTenant`, without), write-denied (reads open, both mutations 404, value unmoved), undenied control — asserting `total` as well as `items` so a sentinel that reached only the rows query shows up as the count leak it is.

Verified on all five (`tsc --noEmit` / `ruff` + `mypy --strict` / `gradle testClasses bootJar` / `dotnet build /warnaserror` / `mix compile --warnings-as-errors`) plus `schema-load`; mutation-proven that the fixture reaches those gates (removing it drops schema-load 41 → 40 and reds `corpus-coverage`). The fixture earned its keep immediately: it exposed an unrelated python emitter bug — a column named `text` matched the schema emitter's `\btext\b` import scan, adding an import nothing invoked and failing `ruff` F401 for any model with such a field — fixed in the same PR.
One consequence was tracked elsewhere and is now closed: the fixture exposed that `policy { deny }` crashed codegen on `persistence: dapper` (with `deny write` unenforceable there) — **closed by #2492 (M-T6.29, `done`, merged 2026-08-11)**: both arms are emitted (`dapper.ts` `authz-filter` read arm + `writeScopeFilter`/`GetByIdForWriteAsync` write arm) and `DAPPER_COMPILE_SKIP` is back at 2 with no `policy-deny` entry. A `done` here means "ships on all five backends' PRIMARY adapters", not everywhere. Also: `policy-deny` sits in `E2E_LESS_CORPUS_FIXTURES` — the deny behaviour ("a denied read 404s / lists empty over HTTP") compiles everywhere and is runtime-proven nowhere; that drain is M-T9.13's.
Sources: [authorization-phase4-deny](../../old/plans/authorization-phase4-deny.md). Foundation for item 6 field masking.

## M-T3.4 — Versioned default-on + structural-409 mapper + idempotency — `done` · **L** · P1
Sources: [expressible-builtins](../../old/proposals/expressible-builtins.md) Phases 1–2, weak-spots §3, ddd-review S4.

## M-T3.5 — OIDC session depth — `done` · **M** · P1
Sources: `src/platform/hono/v*/auth-emit.ts`, [auth-providers-implementation](../../old/plans/auth-providers-implementation.md), weak-spots §3.

## M-T3.13 — Negative-authz runtime gate — `done` · **S/M** · P1 (security)
Sources: `docs/tenancy.md`, `docs/auth.md`, M-T9.9 (authz-filter exhaustiveness — the compile-time twin), weak-spots §security-defaults.

## M-T3.17 — The tenancy subtree read is correct but no longer index-usable — `done` · **M** · P2

**Context.** The `deep`/`global` descendant test used to be `data_key LIKE <anchor> || '.%'`, which rode the `text_pattern_ops` index the tenancy migration derives (`tenant-index.test.ts`). That spelling was a **cross-tenant read**: the anchor is a principal claim, so `_`/`%` inside it were LIKE wildcards, and an org named `acme_corp` matched `acmeXcorp.…`. #2562 fixed it by anchoring the test instead — `strpos(data_key, <anchor> || '.') = 1` — which has no pattern language and so needs no ESCAPE discipline. Correct, and **not sargable**: Postgres cannot use a btree/`text_pattern_ops` index for a function-of-column predicate, so every deep/global read became a sequential scan.

**Shipped (#2656) — option 1, but as a PREFILTER rather than a replacement.** The descendant test is now two terms, identical on every backend that renders the `scope` sentinel:

```
data_key LIKE <escaped-anchor> || '.%' ESCAPE '!'   -- sargable prefilter
  AND strpos(data_key, <anchor> || '.') = 1         -- unchanged from #2562; decides the row
```

Keeping the anchored test as a **conjunct** is what defuses option 1's stated risk ("an escaping bug reintroduces the leak silently"): a LIKE-escaping mistake can only make the prefilter *wider*, and the recheck then discards the extra rows, so the `orgXa.leak` trap is green by construction, not by trusting five escape helpers. Measured, not asserted: the planner rewrites the escaped LIKE to `data_key ~>=~ 'org_7.' AND data_key ~<~ 'org_7/'` and takes a Bitmap Index Scan on `accounts_data_key_idx` (cost 232) where the `strpos`-only form was a Seq Scan (cost 607).

No DDL or collation change was needed — the `text_pattern_ops` opclass P2.5 already derives is exactly the index a prefix LIKE rides under any collation. Option 3 (half-open range) was rejected for the reason the mission flagged: `data_key >= a || '.' AND data_key < a || '/'` is the descendant set only under the C collation, and every ORM's `>=` uses the column's collation, so it would have meant an `ALTER … COLLATE "C"` across two migration emitters with a silent false-negative failure mode. Option 2 (`^@`) needs a second index kind and is not expressible in JPQL/EF LINQ without raw SQL.

Escape character is `!`, not `\` — the pattern is spelled in five generated languages plus HQL, and backslash is the one character whose literal meaning differs between them. The five escape chains live together in `src/generator/_expr/subtree-like.ts`.

**Verification.** `test/e2e/tenancy-subtree-explain.test.ts` (`LOOM_TENANCY_E2E=1`) builds the schema from the emitted migration SQL, lifts the predicate verbatim out of a generated repository, seeds 20k rows, and asserts `Index Scan`/`Index Cond` on `accounts_data_key_idx` for both the MikroORM and Ecto spellings. `test/ir/tenancy-subtree-prefix.test.ts` pins the negative half per backend (no LIKE without an ESCAPE clause; no pattern built from a raw claim); `test/generator/policy-deep-scope.test.ts` pins prefilter-AND-recheck on all five. The `orgXa.leak` trap in `assertHierarchyIsolation` is unchanged and still green.

Sources: the leak and its fix are [#2562](https://github.com/lemmit/Loc/pull/2562); the sargability loss was flagged in the #2521 review; the fix is [#2656](https://github.com/lemmit/Loc/pull/2656).
