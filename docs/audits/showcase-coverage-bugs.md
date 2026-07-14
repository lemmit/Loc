# Showcase coverage campaign — bug report

> **Status: COMPLETE.** `examples/showcase.ddd` now exercises **all 161
> instantiable AST kinds + all 48 walker primitives**; the completeness guard
> runs with `HARD_GATE = true`. Three kinds are allowlisted as unreachable from
> a `.ddd` fixture (`MacroArgString`, `MacroArgInt` — no stdlib macro declares
> string/int params; `ImportStmt` — single-file fixture, covered by
> `multifile-*.ddd`). Bugs below are surfaced-not-fixed per campaign policy.
> **Product bugs: BUG-003 OPEN** (scalar-return op HTTP divergence — an earlier
> gate was **reverted** because it broke the shipped op-self-call feature; see
> below). **BUG-005 FIXED** (union find → success-variant-directly at 200 across
> all 5 backends). **BUG-004 FIXED** (M-T5.18 Track C — keyword
> fields readable via postfix `.`). BUG-006 in flight as #1622; BUG-001/002 were test-infra
> and fixed here.


Running list of bugs surfaced while driving `examples/showcase.ddd` to 100%
language-feature coverage (see PR #1623 / branch `claude/showcase-parity-ci-0qtvxc`).

**Policy for this campaign:** when extending the showcase surfaces a bug
(a backend that crashes, throws, `# TODO`s, or diverges on valid `.ddd`),
we **record it here and keep going** — we do *not* fix it in this branch.
Each entry is a separate follow-up. Bugs are confirmed by either the local
`generate system` / lower+IR-validate gate, or by the `conformance-full`
behavioural leg (triggered via the `run-conformance` label).

Severity legend: **S1** crash/codegen-throw on valid input · **S2** silent
cross-backend divergence (parity break) · **S3** honest gap (validator
rejects a feature on some target) · **S4** test-infra / measurement.

---

## Confirmed

### BUG-001 — walker-primitive coverage detector measured the wrong AST field — **S4 (fixed in this PR)**

`test/conformance/showcase-completeness.test.ts → invokedNames()` collected
`node.name`, but a UI primitive invocation (`Avatar { "P" }`) parses as a
`BuilderCall` whose name lives on **`type`**, not `name`. So every primitive
was reported uncovered even when used: the guard showed **20/48** covered when
the true figure was **36/48**. Without this fix "100% primitive coverage" is
unmeasurable. Fixed here (the detector now reads `BuilderCall.type`) because
it's the measurement the campaign depends on; logged for the record.

### BUG-002 — coverage guard's union-exclusion list was incomplete → HARD_GATE unreachable — **S4 (fixed in this PR)**

`UNION_SUPERTYPES` (the set of abstract grammar unions excluded from the
"every kind appears" check) was hand-maintained and had rotted: it was missing
**11** real abstract unions — `ConfigValue, ConnectionSource, AuthConfigValue,
MacroArgValue, StoreDecl, AreaMember, CapabilityMember, WorkflowMember,
LayoutSlot, ViewSource, PostfixSuffix`. These can never appear as a concrete
`$type`, so they were permanently "uncovered" — meaning `HARD_GATE = true`
could **never** pass no matter how complete the showcase got. Fixed by deriving
the abstract set from `reflection.getAllSubTypes` (auto-catches future unions)
plus a 2-entry residual (`LValue`, `NamedType`). The honest target is now
**64/164** instantiable AST kinds uncovered (was reported 75/175).

---

### BUG-003 — scalar return-typed operation diverges 3 ways across backends — **S2**

Slice S3. Added `operation describe(): string { return name + " #" + string(sequence) }`
to `Catalog.Project`. `generate system` succeeds on all 5 backends, but the
emitted HTTP contract for a **scalar** (non-union) return-typed operation splits:

| Backend | Status | Returns the value? | OpenAPI response |
|---|---|---|---|
| Hono (node) | **200** | yes (`c.json(result)`) | **mistyped as `ProjectResponse`** — it returns a bare `string` |
| Phoenix (elixir) | **200** | yes (`json(conn, success)`) | success schema |
| .NET | **204** | no — `await _mediator.Send(cmd); return NoContent();` | 204 |
| Python | **204** | no — `found.describe()` result discarded | 204 |
| Java | **204** | no — `void describeProject(...)`, `@ResponseStatus(NO_CONTENT)` | 204 |

Two defects in one: (a) **3-way parity divergence** — only 2/5 honor a scalar
operation return (200+body) while 3/5 discard it (204); the strict
`conformance-parity` gate will fail on this op. (b) **Hono mistypes** its 200
response schema as the aggregate's `ProjectResponse` when the value is a
`string`. (.NET's exception-less-returns work, `operation-return-dotnet.ddd`,
only covers the *union* return form `X or NotFound` → 200; the scalar-return
form was apparently never reconciled across backends.)

**OPEN — an attempted gate was REVERTED.** The first fix assumed scalar-return
aggregate operations "aren't part of any shipped design" and added an IR-validate
gate (`loom.operation-return-scalar-unsupported`) rejecting non-`or`-union
operation returns. **That premise was wrong.** `test/e2e/fixtures/elixir-vanilla-build/vanilla-op-self-call.ddd`
is a build fixture whose whole point is scalar-return aggregate operations
(`operation reserve(): string`, `summarize`, `viaHelper`) that compile and
self-call across backends — the gate rejected all four and turned the
`elixir-vanilla-build` leg red. Scalar returns are a shipped, tested feature; the
divergence is the *HTTP wire contract* (200-with-body vs 204-discard), not the
feature's existence. The gate was removed (`structural-checks.ts` now only runs
the `or`-union backend-support check); `test/ir/operation-returns.test.ts` now
guards that scalar returns stay valid. The showcase's synthetic `describe()` had
been removed with the gate and stays removed — it added nothing beyond the
`domainService` op's `ReturnStmt` coverage, and re-adding it would re-trip
`conformance-parity` on the still-open divergence. **BUG-003 remains open**: the
real fix is to converge the scalar-return HTTP contract across all five backends
(all-200-with-body or all-204), which is additive feature work, not a gate.

### BUG-004 — union-find absence error mandates field `resource`, which is a reserved keyword → unreadable — **FIXED (M-T5.18 Track C)**

> **FIXED.** The second remedy proposed below ("keyword field names must be
> accessible via postfix") shipped: `CommonSoftKeywords` (which includes
> `resource`) is now composed into `MemberName`, so `e.resource` /
> `this.resource` parse. This closed the whole declarable-but-unreadable class,
> not just `resource`. Regression: `test/language/parsing/keyword-field-member-access.test.ts`
> + the coverage snapshot in `keyword-identifier-completeness.test.ts`.

Slice S4. A union-returning find (`find locate(name): Project or ProjectNotFound`)
**requires** its error payload to carry exactly `resource: string` (validator:
"an absence-mapped error may only carry `resource: string`"). But `resource` is
a reserved keyword (the `resource <name> { for:… }` datasource decl), so a
postfix access `e.resource` inside a `match` arm fails to **parse**
(`Expecting one of [by, handle, id, …]`). Net effect: the mandated field is
*write-only* — the framework fills it, but domain code (a `VariantArm` match)
can never read it. Either the mandated field should be renamable, or keyword
field names must be accessible via postfix (LooseName in member position).
Worked around in the showcase by not binding the field (`ProjectNotFound =>
"not found"`).

### BUG-005 — union-returning find: OpenAPI response typed only on .NET + Hono — **S2**

Slice S4. `find locate(...): Project or ProjectNotFound` generates on all 5
backends (no crash), but the success response is typed inconsistently:

| Backend | `/projects/locate` 200 response |
|---|---|
| .NET | `ProducesResponseType(typeof(ProjectOrProjectNotFound), 200)` ✓ |
| Hono | `200 … schema: ProjectOrProjectNotFound` ✓ |
| Python | `@router.get(..., response_model=None)` — **untyped**, no union schema |
| Java | `Route("get", ".../locate", null, {500}, null)` — **no 200 success schema**, only 500 |
| Phoenix | route + controller emitted; spec response TBD |

The discriminated-union wire shape is a .NET/Hono feature
(`union-dotnet.ddd`); Python and Java emit the route but drop the typed union
response → the strict `conformance-parity` response/schema diff fails. Kept as
the union-find / TypeAtom coverage vehicle.

**Deeper finding (investigation for the fix):** it is NOT a 2-backend
catch-up. The union-find `200` response has **four different shapes** across the
five backends — the discriminated-union wire contract was never defined
cross-backend (unions had never been in the parity fixture, so the five never
had to agree):

| Backend | `/projects/locate` 200 schema |
|---|---|
| Hono | `ProjectOrProjectNotFound` — one `oneOf` component (discriminator `type`) |
| .NET | `ProjectOrProjectNotFound` — via **3** Swashbuckle components (`+_Project`, `+_ProjectNotFound`) |
| Elixir | `ProjectResponse` — success variant only, no union component |
| Python | `response_model=None` — untyped |
| Java | null schema |

`schemaNames` set-equality + `responseBodyDiffs` are both strict-asserted, so
even .NET-vs-Hono diverges (Swashbuckle's 3 named components vs zod's 1).
Converging all five needs a **design decision on the union-find `200`
contract** — either (1) a tagged `oneOf` union component (normalize .NET's
Swashbuckle derived-type naming + emit on Python/Java/Elixir), or (2)
success-variant-only at 200 with the error at its mapped status (Elixir's
shape; semantically cleanest, drops the tag — a runtime change on Hono/.NET).
This is a maintainer-owned contract decision + a real implementation, not a
mechanical fix.

**RESOLVED — chose option (2), the design-correct contract (exception-less.md
§4: "success bodies carry the variant data directly with HTTP 200").** The
correct rule is a partition: error/`none` variants → each at its own status
(never in the 200 schema — the actual defect); the success set → 200 (one
success → returned directly; 2+ → a `oneOf` of the successes, which IR
validation currently rejects for finds). So a single-success union find is
wire-identical to `<Agg>?` / `<Agg> option`: **200 = `<Agg>Response`, error →
its status, no tagged component.** Implemented across all five backends + the
react/vue/svelte client — Hono, .NET, Python, and Java dropped the tagged
component; **Elixir dropped its `Map.put(serialize(record), :type, …)` success
tag** (it had been tagging the success body, the fifth divergent shape). Every
backend now emits the same `200: <Agg>Response` + error-status shape as a plain
single find, so the union find parity-matches by construction. A new always-on
cross-backend gate (`test/conformance/union-wire-parity.test.ts`) pins the
convergence across all five; per-backend generator tests rewritten; full fast
suite + build + lint green. Shipped-behaviour docs updated
(`docs/payloads.md` §3/§5, `docs/generators.md`).

> **Verification note:** the fix is unit-verified on every backend and
> parity-correct by construction (identical `200` `$ref` + no union component
> across all five — exactly the dimensions `diffSpecs` compares). The full
> docker conformance-parity *boot* could not be run to completion in this
> environment — the image/package registries repeatedly failed (Docker Hub 429
> on base images; then `dotnet restore` / NuGet failing inside the .NET image
> build) — so the stack never came up. The generated union-find output now
> mirrors the known-compiling optional-find path on each backend.

---

## Verified via `conformance-full` (run #71, commit c8900c6)

That run (the behavioural-backfill state) boots all 5 backends. Results:

- ✅ **all 5 backends build + boot + serve `/health`**.
- ✅ **5-way OpenAPI parity passes** ("all five backends agree across all ten
  pairs: ops / cardinality / schemas / fields / required").
- ✅ Playwright UI suite passes; ✅ runtime-403 authz passes.
- ❌ behavioural DSL e2e: **7 failures, all on `phoenix_api` only** — every
  one a `422 "is invalid"` on an **enum** field (`POST /api/projects` →
  `/visibility`, `POST /api/builds` → `/buildState`).

### BUG-006 (pre-existing, already in flight as PR #1622) — Phoenix rejects declared-case enum values — **S2**

This is **not a campaign regression** — it's the known vanilla-Phoenix enum
casing bug: `Ecto.Enum` snake-cases its values so the wire value `"Public"` /
`"Passed"` can't `cast`, returning 422. PR **#1622** ("fix(elixir): emit enum
values in declared casing so wire values cast") fixes exactly these two
pointers. My behavioural backfill (and the pre-existing happy-path creates,
which conformance-full replays against *every* backend) just hit the same
broken path on Phoenix. No action here — tracked by #1622.

> Note: this run predates the S3–S9 features. The **current** milestone
> additionally fails `conformance-parity` on BUG-003 (scalar return op) and
> BUG-005 (union-find response typing) — both deliberate coverage vehicles.

## Pending verification

- A fresh `conformance-full` on the S3–S9 milestone would re-confirm the above
  plus BUG-003/005 (parity) — i.e. only known issues. Worth re-running after
  those are fixed, not before.
